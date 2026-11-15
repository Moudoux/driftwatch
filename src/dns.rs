//! Host name resolution for agent addresses.
//!
//! The Driftwatch container shares the Tailscale sidecar's network namespace
//! but not its /etc/resolv.conf, so MagicDNS names may not resolve through
//! the system resolver. When `DRIFTWATCH_DNS` is set (normally to
//! 100.100.100.100) names are first looked up with a tiny DNS client against
//! that server, then via the system resolver.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::net::UdpSocket;

pub async fn resolve(host: &str, port: u16, server: Option<IpAddr>) -> Result<SocketAddr> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }
    if let Some(server) = server {
        match query_a(host, server).await {
            Ok(ip) => return Ok(SocketAddr::new(IpAddr::V4(ip), port)),
            Err(e) => tracing::debug!("DNS lookup of {host} via {server} failed: {e:#}"),
        }
    }
    tokio::net::lookup_host((host, port))
        .await
        .with_context(|| format!("resolve {host}"))?
        .next()
        .with_context(|| format!("{host} has no addresses"))
}

async fn query_a(host: &str, server: IpAddr) -> Result<Ipv4Addr> {
    let id: u16 = rand::random();
    let mut q = Vec::with_capacity(64);
    q.extend_from_slice(&id.to_be_bytes());
    q.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]); // RD, 1 question
    for label in host.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            bail!("invalid host name");
        }
        q.push(label.len() as u8);
        q.extend_from_slice(label.as_bytes());
    }
    q.extend_from_slice(&[0, 0, 1, 0, 1]); // root, type A, class IN

    let sock = UdpSocket::bind(if server.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    })
    .await?;
    sock.connect(SocketAddr::new(server, 53)).await?;
    let mut buf = [0u8; 1500];
    for _ in 0..3 {
        sock.send(&q).await?;
        let Ok(res) = tokio::time::timeout(Duration::from_millis(800), sock.recv(&mut buf)).await
        else {
            continue;
        };
        let n = res?;
        return parse_a(&buf[..n], id);
    }
    bail!("DNS query timed out")
}

fn parse_a(r: &[u8], id: u16) -> Result<Ipv4Addr> {
    let get = |i: usize| r.get(i).copied().context("truncated DNS response");
    if r.len() < 12 || u16::from_be_bytes([r[0], r[1]]) != id {
        bail!("bad DNS response");
    }
    if r[3] & 0x0f != 0 {
        bail!("DNS error code {}", r[3] & 0x0f);
    }
    let qd = u16::from_be_bytes([r[4], r[5]]);
    let an = u16::from_be_bytes([r[6], r[7]]);
    let mut i = 12;
    let skip_name = |mut i: usize| -> Result<usize> {
        loop {
            let len = get(i)?;
            if len & 0xc0 == 0xc0 {
                return Ok(i + 2);
            }
            if len == 0 {
                return Ok(i + 1);
            }
            i += 1 + len as usize;
        }
    };
    for _ in 0..qd {
        i = skip_name(i)? + 4;
    }
    for _ in 0..an {
        i = skip_name(i)?;
        let rtype = u16::from_be_bytes([get(i)?, get(i + 1)?]);
        let rdlen = u16::from_be_bytes([get(i + 8)?, get(i + 9)?]) as usize;
        i += 10;
        if rtype == 1 && rdlen == 4 {
            return Ok(Ipv4Addr::new(
                get(i)?,
                get(i + 1)?,
                get(i + 2)?,
                get(i + 3)?,
            ));
        }
        i += rdlen;
    }
    bail!("no A record")
}
