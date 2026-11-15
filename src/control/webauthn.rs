//! A focused WebAuthn relying-party implementation for discoverable
//! credentials (passkeys) with user verification.
//!
//! Registration requests `attestation: "none"`: the authenticator's public key
//! is taken from the (rpIdHash-checked, user-verified) authenticator data and
//! the attestation statement is not evaluated. Supported algorithms: ES256,
//! EdDSA (Ed25519) and RS256, which covers every mainstream passkey provider.

use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ciborium::Value;
use serde::Deserialize;
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};

const ES256: i64 = -7;
const EDDSA: i64 = -8;
const RS256: i64 = -257;

const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_AT: u8 = 0x40;

pub struct RelyingParty {
    pub id: String,
    pub origin: String,
    pub name: String,
}

pub fn b64(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

pub fn unb64(s: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('=').as_bytes())
        .context("invalid base64url")
}

impl RelyingParty {
    pub fn creation_options(
        &self,
        challenge: &[u8],
        user_handle: &[u8],
        exclude: &[Vec<u8>],
    ) -> Json {
        json!({
            "challenge": b64(challenge),
            "rp": { "id": self.id, "name": self.name },
            "user": {
                "id": b64(user_handle),
                "name": "driftwatch",
                "displayName": format!("{} admin", self.name),
            },
            "pubKeyCredParams": [
                { "type": "public-key", "alg": ES256 },
                { "type": "public-key", "alg": EDDSA },
                { "type": "public-key", "alg": RS256 },
            ],
            "authenticatorSelection": {
                "residentKey": "required",
                "requireResidentKey": true,
                "userVerification": "required",
            },
            "attestation": "none",
            "excludeCredentials": exclude.iter().map(|id| json!({ "type": "public-key", "id": b64(id) })).collect::<Vec<_>>(),
            "timeout": 300000,
        })
    }

    pub fn request_options(&self, challenge: &[u8]) -> Json {
        json!({
            "challenge": b64(challenge),
            "rpId": self.id,
            "userVerification": "required",
            "allowCredentials": [],
            "timeout": 300000,
        })
    }

    fn check_client_data(&self, raw: &[u8], kind: &str, challenge: &[u8]) -> Result<()> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ClientData {
            #[serde(rename = "type")]
            kind: String,
            challenge: String,
            origin: String,
            #[serde(default)]
            cross_origin: bool,
        }
        let cd: ClientData = serde_json::from_slice(raw).context("parse clientDataJSON")?;
        ensure!(cd.kind == kind, "unexpected ceremony type {}", cd.kind);
        ensure!(unb64(&cd.challenge)? == challenge, "challenge mismatch");
        ensure!(
            cd.origin == self.origin,
            "origin mismatch: browser is on {} but DRIFTWATCH_PUBLIC_URL is {}",
            cd.origin,
            self.origin
        );
        ensure!(!cd.cross_origin, "cross-origin requests are not allowed");
        Ok(())
    }

    fn check_auth_data<'a>(&self, a: &'a [u8]) -> Result<(u8, u32, &'a [u8])> {
        ensure!(a.len() >= 37, "authenticator data too short");
        ensure!(
            a[..32] == Sha256::digest(self.id.as_bytes())[..],
            "RP id hash mismatch"
        );
        let flags = a[32];
        ensure!(flags & FLAG_UP != 0, "user presence flag not set");
        ensure!(flags & FLAG_UV != 0, "user verification flag not set");
        let count = u32::from_be_bytes([a[33], a[34], a[35], a[36]]);
        Ok((flags, count, &a[37..]))
    }

    pub fn verify_registration(
        &self,
        challenge: &[u8],
        cred: &RegistrationCredential,
    ) -> Result<NewCredential> {
        ensure!(cred.kind == "public-key", "unexpected credential type");
        let client_data = unb64(&cred.response.client_data_json)?;
        self.check_client_data(&client_data, "webauthn.create", challenge)?;

        let att: Value =
            ciborium::from_reader(unb64(&cred.response.attestation_object)?.as_slice())
                .context("parse attestationObject")?;
        let auth_data = map_get_text(&att, "authData")
            .and_then(Value::as_bytes)
            .context("attestationObject has no authData")?;
        let (flags, sign_count, rest) = self.check_auth_data(auth_data)?;
        ensure!(flags & FLAG_AT != 0, "no attested credential data");
        ensure!(rest.len() >= 18, "attested credential data too short");
        let id_len = u16::from_be_bytes([rest[16], rest[17]]) as usize;
        ensure!(rest.len() >= 18 + id_len, "credential id truncated");
        let id = rest[18..18 + id_len].to_vec();
        ensure!(id == unb64(&cred.raw_id)?, "credential id mismatch");

        let mut key_bytes = &rest[18 + id_len..];
        let before = key_bytes.len();
        let key: Value =
            ciborium::from_reader(&mut key_bytes).context("parse credential public key")?;
        let public_key = rest[18 + id_len..18 + id_len + (before - key_bytes.len())].to_vec();
        // Make sure we can use the key before storing it.
        PublicKey::from_cose(&key)?;
        Ok(NewCredential {
            id,
            public_key,
            sign_count,
        })
    }

    /// Verifies an assertion against a stored COSE public key. Returns the new
    /// signature counter.
    pub fn verify_assertion(
        &self,
        challenge: &[u8],
        cred: &AssertionCredential,
        cose_key: &[u8],
        stored_count: u32,
    ) -> Result<u32> {
        ensure!(cred.kind == "public-key", "unexpected credential type");
        let client_data = unb64(&cred.response.client_data_json)?;
        self.check_client_data(&client_data, "webauthn.get", challenge)?;
        let auth_data = unb64(&cred.response.authenticator_data)?;
        let (_, count, _) = self.check_auth_data(&auth_data)?;

        let mut msg = auth_data.clone();
        msg.extend_from_slice(&Sha256::digest(&client_data));
        let key: Value = ciborium::from_reader(cose_key).context("parse stored key")?;
        PublicKey::from_cose(&key)?.verify(&msg, &unb64(&cred.response.signature)?)?;

        // Counters are optional (many passkeys always report 0), but if one is
        // used it must increase; otherwise the credential may have been cloned.
        if (count != 0 || stored_count != 0) && count <= stored_count {
            bail!("signature counter did not increase; the passkey may be cloned");
        }
        Ok(count)
    }
}

pub struct NewCredential {
    pub id: Vec<u8>,
    pub public_key: Vec<u8>,
    pub sign_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationCredential {
    #[serde(rename = "rawId")]
    pub raw_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub response: RegistrationResponse,
}

#[derive(Deserialize)]
pub struct RegistrationResponse {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    #[serde(rename = "attestationObject")]
    pub attestation_object: String,
}

#[derive(Deserialize)]
pub struct AssertionCredential {
    #[serde(rename = "rawId")]
    pub raw_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub response: AssertionResponse,
}

#[derive(Deserialize)]
pub struct AssertionResponse {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    #[serde(rename = "authenticatorData")]
    pub authenticator_data: String,
    pub signature: String,
}

fn map_get_text<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_map()?
        .iter()
        .find(|(k, _)| k.as_text() == Some(key))
        .map(|(_, v)| v)
}

fn map_get_int(v: &Value, key: i64) -> Option<&Value> {
    v.as_map()?
        .iter()
        .find(|(k, _)| k.as_integer().map(i128::from) == Some(key as i128))
        .map(|(_, v)| v)
}

fn int(v: Option<&Value>) -> Option<i64> {
    v?.as_integer()
        .and_then(|i| i64::try_from(i128::from(i)).ok())
}

enum PublicKey {
    Es256(p256::ecdsa::VerifyingKey),
    Ed25519(ed25519_dalek::VerifyingKey),
    Rs256(rsa::PublicKey),
}

impl PublicKey {
    fn from_cose(k: &Value) -> Result<Self> {
        let kty = int(map_get_int(k, 1)).context("COSE key has no kty")?;
        let alg = int(map_get_int(k, 3)).context("COSE key has no alg")?;
        let bytes = |label: i64| -> Result<&[u8]> {
            map_get_int(k, label)
                .and_then(Value::as_bytes)
                .map(Vec::as_slice)
                .with_context(|| format!("COSE key parameter {label} missing"))
        };
        match (kty, alg) {
            (2, ES256) => {
                ensure!(
                    int(map_get_int(k, -1)) == Some(1),
                    "only P-256 is supported for ES256"
                );
                let (x, y) = (bytes(-2)?, bytes(-3)?);
                ensure!(x.len() == 32 && y.len() == 32, "bad P-256 coordinates");
                let mut sec1 = vec![0x04];
                sec1.extend_from_slice(x);
                sec1.extend_from_slice(y);
                Ok(PublicKey::Es256(
                    p256::ecdsa::VerifyingKey::from_sec1_bytes(&sec1)
                        .context("invalid P-256 key")?,
                ))
            }
            (1, EDDSA) => {
                ensure!(
                    int(map_get_int(k, -1)) == Some(6),
                    "only Ed25519 is supported for EdDSA"
                );
                let x: [u8; 32] = bytes(-2)?.try_into().context("bad Ed25519 key length")?;
                Ok(PublicKey::Ed25519(
                    ed25519_dalek::VerifyingKey::from_bytes(&x).context("invalid Ed25519 key")?,
                ))
            }
            (3, RS256) => {
                let n = rsa::BoxedUint::from_be_slice_vartime(bytes(-1)?);
                let e = rsa::BoxedUint::from_be_slice_vartime(bytes(-2)?);
                Ok(PublicKey::Rs256(
                    rsa::PublicKey::new(n, e).context("invalid RSA key")?,
                ))
            }
            _ => bail!("unsupported key type {kty} / algorithm {alg}"),
        }
    }

    fn verify(&self, msg: &[u8], sig: &[u8]) -> Result<()> {
        match self {
            PublicKey::Es256(k) => {
                use p256::ecdsa::signature::Verifier;
                let sig = p256::ecdsa::Signature::from_der(sig)
                    .context("bad ECDSA signature encoding")?;
                k.verify(msg, &sig)
                    .map_err(|_| anyhow::anyhow!("invalid signature"))
            }
            PublicKey::Ed25519(k) => {
                let sig =
                    ed25519_dalek::Signature::from_slice(sig).context("bad Ed25519 signature")?;
                k.verify_strict(msg, &sig)
                    .map_err(|_| anyhow::anyhow!("invalid signature"))
            }
            PublicKey::Rs256(k) => {
                use rsa::signature::Verifier;
                let vk = rsa::pkcs1v15::VerifyingKey::<sha2::Sha256>::new(k.clone());
                let sig = rsa::pkcs1v15::Signature::try_from(sig).context("bad RSA signature")?;
                vk.verify(msg, &sig)
                    .map_err(|_| anyhow::anyhow!("invalid signature"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer;

    fn rp() -> RelyingParty {
        RelyingParty {
            id: "localhost".into(),
            origin: "http://localhost:8080".into(),
            name: "Driftwatch".into(),
        }
    }

    fn auth_data(rp_id: &str, flags: u8, count: u32, attested: Option<(&[u8], &[u8])>) -> Vec<u8> {
        let mut a = Sha256::digest(rp_id.as_bytes()).to_vec();
        a.push(flags);
        a.extend_from_slice(&count.to_be_bytes());
        if let Some((id, key)) = attested {
            a.extend_from_slice(&[0u8; 16]);
            a.extend_from_slice(&(id.len() as u16).to_be_bytes());
            a.extend_from_slice(id);
            a.extend_from_slice(key);
        }
        a
    }

    fn client_data(kind: &str, challenge: &[u8]) -> Vec<u8> {
        serde_json::to_vec(
            &json!({"type": kind, "challenge": b64(challenge), "origin": "http://localhost:8080"}),
        )
        .unwrap()
    }

    /// Full software round trip: register an ES256 key, then sign in with it.
    #[test]
    fn es256_register_and_assert() {
        let rp = rp();
        let mut secret = [0u8; 32];
        secret[31] = 7;
        let sk = p256::ecdsa::SigningKey::from_slice(&secret).unwrap();
        let point = sk.verifying_key().to_sec1_point(false);
        let bytes = point.as_bytes();
        let cose = Value::Map(vec![
            (Value::from(1), Value::from(2)),
            (Value::from(3), Value::from(-7)),
            (Value::from(-1), Value::from(1)),
            (Value::from(-2), Value::Bytes(bytes[1..33].to_vec())),
            (Value::from(-3), Value::Bytes(bytes[33..65].to_vec())),
        ]);
        let mut cose_bytes = Vec::new();
        ciborium::into_writer(&cose, &mut cose_bytes).unwrap();
        let cred_id = b"credential-1";
        let ad = auth_data(
            "localhost",
            FLAG_UP | FLAG_UV | FLAG_AT,
            0,
            Some((cred_id, &cose_bytes)),
        );
        let att = Value::Map(vec![
            (Value::from("fmt"), Value::from("none")),
            (Value::from("attStmt"), Value::Map(vec![])),
            (Value::from("authData"), Value::Bytes(ad)),
        ]);
        let mut att_bytes = Vec::new();
        ciborium::into_writer(&att, &mut att_bytes).unwrap();

        let challenge = b"register-challenge";
        let reg = RegistrationCredential {
            raw_id: b64(cred_id),
            kind: "public-key".into(),
            response: RegistrationResponse {
                client_data_json: b64(&client_data("webauthn.create", challenge)),
                attestation_object: b64(&att_bytes),
            },
        };
        let new = rp.verify_registration(challenge, &reg).unwrap();
        assert_eq!(new.id, cred_id);
        assert_eq!(new.public_key, cose_bytes);

        let challenge = b"login-challenge";
        let ad = auth_data("localhost", FLAG_UP | FLAG_UV, 5, None);
        let cd = client_data("webauthn.get", challenge);
        let mut msg = ad.clone();
        msg.extend_from_slice(&Sha256::digest(&cd));
        let sig: p256::ecdsa::Signature = sk.sign(&msg);
        let mut assertion = AssertionCredential {
            raw_id: b64(cred_id),
            kind: "public-key".into(),
            response: AssertionResponse {
                client_data_json: b64(&cd),
                authenticator_data: b64(&ad),
                signature: b64(&sig.to_der().to_bytes()),
            },
        };
        assert_eq!(
            rp.verify_assertion(challenge, &assertion, &new.public_key, 0)
                .unwrap(),
            5
        );
        // Replayed counter is rejected.
        assert!(
            rp.verify_assertion(challenge, &assertion, &new.public_key, 5)
                .is_err()
        );
        // Wrong challenge is rejected.
        assert!(
            rp.verify_assertion(b"other", &assertion, &new.public_key, 0)
                .is_err()
        );
        // Tampered signature is rejected.
        assertion.response.authenticator_data =
            b64(&auth_data("localhost", FLAG_UP | FLAG_UV, 6, None));
        assert!(
            rp.verify_assertion(challenge, &assertion, &new.public_key, 0)
                .is_err()
        );
    }
}
