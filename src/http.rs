//! Minimal HTTP/1.1 client plumbing shared by the Docker client (unix socket
//! or TCP) and the agent client (mutual TLS over TCP).

use anyhow::{Context, Result};
use bytes::{Bytes, BytesMut};
use futures_util::Stream;
use http_body_util::{BodyExt, Empty};
use hyper::body::Incoming;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite};

/// Sends one request on a fresh connection. The connection is closed once the
/// response body is fully read or dropped, which is what tears down long-lived
/// log streams when a viewer goes away.
pub async fn send<S>(io: S, req: Request<Empty<Bytes>>) -> Result<Response<Incoming>>
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(io))
        .await
        .context("http handshake")?;
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            tracing::debug!("connection closed: {e}");
        }
    });
    sender.send_request(req).await.context("send request")
}

pub fn get(path: &str, host: &str) -> Result<Request<Empty<Bytes>>> {
    Ok(Request::get(path)
        .header(hyper::header::HOST, host)
        .header(
            hyper::header::USER_AGENT,
            concat!("driftwatch/", env!("CARGO_PKG_VERSION")),
        )
        .body(Empty::new())?)
}

/// Reads the whole body, failing with the body text on a non-2xx status.
pub async fn read_ok(res: Response<Incoming>) -> Result<Bytes> {
    let status = res.status();
    let body = res
        .into_body()
        .collect()
        .await
        .context("read body")?
        .to_bytes();
    if !status.is_success() {
        let text = String::from_utf8_lossy(&body);
        anyhow::bail!("HTTP {status}: {}", text.trim());
    }
    Ok(body)
}

/// Splits a streaming body into newline-terminated lines (without the newline).
pub fn lines(body: Incoming) -> impl Stream<Item = Result<Bytes>> {
    async_stream::try_stream! {
        let mut body = body;
        let mut buf = BytesMut::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.context("read stream")?;
            let Ok(data) = frame.into_data() else { continue };
            buf.extend_from_slice(&data);
            while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                let line = buf.split_to(pos + 1).freeze().slice(..pos);
                yield line;
            }
        }
        if !buf.is_empty() {
            yield buf.freeze();
        }
    }
}
