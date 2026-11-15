//! The control server runs a private CA. It issues:
//! - one server certificate per agent (SAN `<id>.agent.driftwatch`, EKU serverAuth)
//! - a client certificate for itself (SAN `control.driftwatch`, EKU clientAuth)
//!
//! Agents accept only client certificates signed by that CA *and* carrying
//! the control SAN, so a stolen agent certificate cannot be used to talk to
//! other agents. The control server additionally pins each agent's
//! certificate fingerprint, so reissuing a certificate revokes the old one.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType, SerialNumber,
};
use rustls::RootCertStore;
use rustls::server::WebPkiClientVerifier;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};

pub const CONTROL_SAN: &str = "control.driftwatch";

pub fn agent_san(id: &str) -> String {
    format!("{id}.agent.driftwatch")
}

pub struct Issued {
    pub cert_pem: String,
    pub key_pem: String,
    pub fingerprint: String,
}

pub struct Ca {
    pub cert_pem: String,
    issuer: Issuer<'static, KeyPair>,
}

fn serial() -> SerialNumber {
    let mut b = [0u8; 16];
    rand::fill(&mut b);
    b[0] &= 0x7f;
    SerialNumber::from_slice(&b)
}

impl Ca {
    /// Creates a new CA, returning `(cert_pem, key_pem)`.
    pub fn generate() -> Result<(String, String)> {
        let key = KeyPair::generate()?;
        let mut p = CertificateParams::default();
        p.distinguished_name
            .push(DnType::CommonName, "Driftwatch CA");
        p.distinguished_name
            .push(DnType::OrganizationName, "Driftwatch");
        p.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        p.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::CrlSign,
            KeyUsagePurpose::DigitalSignature,
        ];
        p.not_before = OffsetDateTime::now_utc() - Duration::hours(1);
        p.not_after = OffsetDateTime::now_utc() + Duration::days(365 * 30);
        p.serial_number = Some(serial());
        let cert = p.self_signed(&key)?;
        Ok((cert.pem(), key.serialize_pem()))
    }

    pub fn load(cert_pem: &str, key_pem: &str) -> Result<Self> {
        let key = KeyPair::from_pem(key_pem).context("parse CA key")?;
        let issuer = Issuer::from_ca_cert_pem(cert_pem, key).context("parse CA certificate")?;
        Ok(Ca {
            cert_pem: cert_pem.to_string(),
            issuer,
        })
    }

    pub fn fingerprint(&self) -> Result<String> {
        Ok(fingerprint(first_cert(&self.cert_pem)?.as_ref()))
    }

    fn issue(
        &self,
        cn: &str,
        san: &str,
        eku: ExtendedKeyUsagePurpose,
        days: i64,
    ) -> Result<Issued> {
        let key = KeyPair::generate()?;
        let mut p = CertificateParams::default();
        p.distinguished_name.push(DnType::CommonName, cn);
        p.subject_alt_names = vec![SanType::DnsName(san.try_into()?)];
        p.is_ca = IsCa::ExplicitNoCa;
        p.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        p.extended_key_usages = vec![eku];
        p.use_authority_key_identifier_extension = true;
        p.not_before = OffsetDateTime::now_utc() - Duration::hours(1);
        p.not_after = OffsetDateTime::now_utc() + Duration::days(days);
        p.serial_number = Some(serial());
        let cert = p.signed_by(&key, &self.issuer)?;
        Ok(Issued {
            fingerprint: fingerprint(cert.der()),
            cert_pem: cert.pem(),
            key_pem: key.serialize_pem(),
        })
    }

    pub fn issue_agent(&self, id: &str) -> Result<Issued> {
        self.issue(
            &format!("driftwatch-agent-{id}"),
            &agent_san(id),
            ExtendedKeyUsagePurpose::ServerAuth,
            365 * 10,
        )
    }

    pub fn issue_control(&self) -> Result<Issued> {
        self.issue(
            "driftwatch-control",
            CONTROL_SAN,
            ExtendedKeyUsagePurpose::ClientAuth,
            365 * 5,
        )
    }
}

pub fn fingerprint(der: &[u8]) -> String {
    hex(&Sha256::digest(der))
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn certs(pem: &str) -> Result<Vec<CertificateDer<'static>>> {
    let certs = CertificateDer::pem_slice_iter(pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .context("parse certificate PEM")?;
    if certs.is_empty() {
        bail!("no certificate found in PEM");
    }
    Ok(certs)
}

fn first_cert(pem: &str) -> Result<CertificateDer<'static>> {
    Ok(certs(pem)?.remove(0))
}

fn key(pem: &str) -> Result<PrivateKeyDer<'static>> {
    PrivateKeyDer::from_pem_slice(pem.as_bytes()).context("parse private key PEM")
}

fn roots(ca_pem: &str) -> Result<RootCertStore> {
    let mut roots = RootCertStore::empty();
    for c in certs(ca_pem)? {
        roots.add(c).context("add CA certificate")?;
    }
    Ok(roots)
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// TLS config the control server uses to connect to agents.
pub fn client_config(
    ca_pem: &str,
    cert_pem: &str,
    key_pem: &str,
) -> Result<Arc<rustls::ClientConfig>> {
    let cfg = rustls::ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_root_certificates(roots(ca_pem)?)
        .with_client_auth_cert(certs(cert_pem)?, key(key_pem)?)?;
    Ok(Arc::new(cfg))
}

/// TLS config of an agent: requires a client certificate signed by the CA.
pub fn server_config(
    ca_pem: &str,
    cert_pem: &str,
    key_pem: &str,
) -> Result<Arc<rustls::ServerConfig>> {
    let verifier =
        WebPkiClientVerifier::builder_with_provider(Arc::new(roots(ca_pem)?), provider())
            .build()?;
    let mut cfg = rustls::ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_client_cert_verifier(verifier)
        .with_single_cert(certs(cert_pem)?, key(key_pem)?)?;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(cfg))
}

/// DNS names in a certificate's subjectAltName extension.
pub fn dns_sans(der: &[u8]) -> Result<Vec<String>> {
    let (_, cert) = x509_parser::parse_x509_certificate(der).context("parse certificate")?;
    let mut out = Vec::new();
    if let Ok(Some(san)) = cert.subject_alternative_name() {
        for name in &san.value.general_names {
            if let x509_parser::extensions::GeneralName::DNSName(d) = name {
                out.push(d.to_string());
            }
        }
    }
    Ok(out)
}

/// The agent id encoded in an agent certificate (from its SAN).
pub fn agent_id_from_cert(cert_pem: &str) -> Result<String> {
    let der = first_cert(cert_pem)?;
    dns_sans(der.as_ref())?
        .into_iter()
        .find_map(|s| s.strip_suffix(".agent.driftwatch").map(str::to_string))
        .context("certificate is not a Driftwatch agent certificate")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_and_handshake_configs() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (ca_cert, ca_key) = Ca::generate().unwrap();
        let ca = Ca::load(&ca_cert, &ca_key).unwrap();
        let agent = ca.issue_agent("nas").unwrap();
        let control = ca.issue_control().unwrap();
        assert_eq!(agent_id_from_cert(&agent.cert_pem).unwrap(), "nas");
        server_config(&ca_cert, &agent.cert_pem, &agent.key_pem).unwrap();
        client_config(&ca_cert, &control.cert_pem, &control.key_pem).unwrap();
        let der = first_cert(&control.cert_pem).unwrap();
        assert_eq!(
            dns_sans(der.as_ref()).unwrap(),
            vec![CONTROL_SAN.to_string()]
        );
    }
}
