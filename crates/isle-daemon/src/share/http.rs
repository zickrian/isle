// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Just enough HTTP/1.1 for phone sharing: one request per connection, read with `httparse`, bodies only
//! by `Content-Length` (no chunks), and every answer with the same strict headers.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// A request's head may be this big; a phone's is under 1 KiB.
const MAX_HEAD: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
/// A file is sent in pieces this big.
const CHUNK: usize = 64 * 1024;

/// What phone sharing reads of a request.
#[derive(Debug, Default)]
pub struct Head {
    pub method: String,
    /// The path, before any `?`; never decoded.
    pub path: String,
    pub query: String,
    pub host: String,
    pub content_length: Option<u64>,
    pub cookie: String,
    pub user_agent: String,
    pub expects_continue: bool,
}

/// Why a request was not read.
#[derive(Debug, PartialEq, Eq)]
pub enum Unread {
    /// The connection closed or failed first.
    Closed,
    /// Too big, malformed, or chunked.
    Bad,
}

/// Reads a request's head into `buf`; what follows it there is the start of its body.
pub async fn read_head<R: AsyncRead + Unpin>(
    stream: &mut R,
    buf: &mut Vec<u8>,
) -> Result<(Head, usize), Unread> {
    let mut chunk = [0u8; 2048];
    loop {
        let read = stream.read(&mut chunk).await.map_err(|_| Unread::Closed)?;
        if read == 0 {
            return Err(Unread::Closed);
        }
        buf.extend_from_slice(&chunk[..read]);
        let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
        let mut request = httparse::Request::new(&mut headers);
        match request.parse(buf) {
            Ok(httparse::Status::Complete(length)) => return Ok((head(&request)?, length)),
            Ok(httparse::Status::Partial) if buf.len() < MAX_HEAD => continue,
            _ => return Err(Unread::Bad),
        }
    }
}

/// The parts of a parsed request phone sharing uses; chunked bodies and doubled lengths are refused.
fn head(request: &httparse::Request<'_, '_>) -> Result<Head, Unread> {
    let target = request.path.ok_or(Unread::Bad)?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut head = Head {
        method: request.method.ok_or(Unread::Bad)?.to_owned(),
        path: path.to_owned(),
        query: query.to_owned(),
        ..Head::default()
    };
    for header in request.headers.iter() {
        let value = String::from_utf8_lossy(header.value).trim().to_owned();
        match header.name.to_ascii_lowercase().as_str() {
            // One of each: two could be read differently by two readers.
            "host" if !head.host.is_empty() => return Err(Unread::Bad),
            "host" => head.host = value,
            "content-length" => {
                // Digits only: Rust would take "+5".
                if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(Unread::Bad);
                }
                let length = value.parse().map_err(|_| Unread::Bad)?;
                if head.content_length.replace(length).is_some() {
                    return Err(Unread::Bad);
                }
            }
            "transfer-encoding" => return Err(Unread::Bad),
            "cookie" => head.cookie = value,
            "user-agent" => head.user_agent = value,
            "expect" => head.expects_continue = value.eq_ignore_ascii_case("100-continue"),
            _ => {}
        }
    }
    Ok(head)
}

/// A query parameter, decoded.
pub fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (name == key).then(|| percent_decode(value))
    })
}

/// A cookie's value, from a `Cookie` header.
pub fn cookie<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').find_map(|pair| {
        let (key, value) = pair.trim().split_once('=')?;
        (key == name).then_some(value)
    })
}

/// `%XX` decoded (a `+` stays a `+`); invalid UTF-8 replaced.
pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push((high * 16 + low) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Everything but unreserved characters as `%XX` (RFC 3986), for `filename*`.
pub fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// An answer's body.
pub enum Body {
    Bytes(Vec<u8>),
    /// A file streamed from disk, its length known.
    File(tokio::fs::File, u64),
}

/// An answer: status, the headers of this request, a body. Strict headers are added to all of them.
pub struct Response {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Body,
}

impl Response {
    /// A small answer in `content_type`.
    pub fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            headers: vec![("Content-Type", content_type.to_owned())],
            body: Body::Bytes(body),
        }
    }

    /// A JSON answer.
    pub fn json(status: u16, value: &serde_json::Value) -> Self {
        Self::bytes(status, "application/json", value.to_string().into_bytes())
    }

    /// Nothing here: the same for a wrong token, a wrong path and a file that is gone.
    pub fn not_found() -> Self {
        Self::bytes(404, "text/plain; charset=utf-8", b"Not found".to_vec())
    }

    /// Adds a header.
    pub fn with(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

/// The reason phrase of each status phone sharing sends.
fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        408 => "Request Timeout",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Content Too Large",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        507 => "Insufficient Storage",
        _ => "Error",
    }
}

/// How fast a transfer must go: each piece within `stall`, and on average `min_rate` bytes a second
/// once `grace` has passed, so a trickle can't hold a connection (and sharing) for hours; and not at all
/// once `cut` is set (its phone was taken off).
#[derive(Clone)]
pub struct Pace {
    pub stall: Duration,
    pub min_rate: u64,
    pub grace: Duration,
    pub started: tokio::time::Instant,
    pub cut: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl Pace {
    /// Whether `done` bytes by now keep up.
    pub fn keeps_up(&self, done: u64) -> bool {
        let elapsed = self.started.elapsed();
        elapsed <= self.grace || done as f64 >= elapsed.as_secs_f64() * self.min_rate as f64
    }

    /// An error once it falls behind, or is cut.
    pub fn check(&self, done: u64) -> std::io::Result<()> {
        if self
            .cut
            .as_ref()
            .is_some_and(|cut| cut.load(std::sync::atomic::Ordering::Acquire))
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "taken off",
            ));
        }
        if self.keeps_up(done) {
            Ok(())
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "too slow",
            ))
        }
    }
}

/// Sends `response` and its body; a file goes in pieces, as fast as `pace` asks.
pub async fn send<W: AsyncWrite + Unpin>(
    stream: &mut W,
    response: Response,
    pace: Pace,
) -> std::io::Result<()> {
    let stall = pace.stall;
    let length = match &response.body {
        Body::Bytes(bytes) => bytes.len() as u64,
        Body::File(_, length) => *length,
    };
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {length}\r\nConnection: close\r\nCache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n\
         Cross-Origin-Resource-Policy: same-origin\r\n",
        response.status,
        reason(response.status)
    );
    for (name, value) in &response.headers {
        // Values are ours; a stray line break would still split the head, so none gets through.
        let value: String = value.chars().filter(|c| !c.is_control()).collect();
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    within(stall, stream.write_all(head.as_bytes())).await?;
    match response.body {
        Body::Bytes(bytes) => within(stall, stream.write_all(&bytes)).await?,
        Body::File(mut file, length) => {
            let mut left = length;
            let mut chunk = vec![0u8; CHUNK];
            while left > 0 {
                let want = chunk.len().min(usize::try_from(left).unwrap_or(CHUNK));
                let read = file.read(&mut chunk[..want]).await?;
                if read == 0 {
                    // Shorter than it said: the connection ends, so the phone sees a failed download.
                    return Err(std::io::ErrorKind::UnexpectedEof.into());
                }
                within(stall, stream.write_all(&chunk[..read])).await?;
                left -= read as u64;
                pace.check(length - left)?;
            }
        }
    }
    within(stall, stream.flush()).await
}

/// `work`, or a timeout once `limit` passes.
async fn within<T>(
    limit: Duration,
    work: impl Future<Output = std::io::Result<T>>,
) -> std::io::Result<T> {
    tokio::time::timeout(limit, work)
        .await
        .unwrap_or_else(|_| Err(std::io::ErrorKind::TimedOut.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn parse(raw: &[u8]) -> Result<Head, Unread> {
        let mut buf = Vec::new();
        let mut stream = raw;
        read_head(&mut stream, &mut buf).await.map(|(head, _)| head)
    }

    #[tokio::test]
    async fn reads_what_it_needs() {
        let head = parse(
            b"PUT /tok/api/upload?name=a%20b.jpg HTTP/1.1\r\nHost: 10.0.0.2:47830\r\n\
              Content-Length: 12\r\nCookie: x=1; isle=abc\r\n\r\nbody",
        )
        .await
        .unwrap();
        assert_eq!(head.method, "PUT");
        assert_eq!(head.path, "/tok/api/upload");
        assert_eq!(query_param(&head.query, "name").as_deref(), Some("a b.jpg"));
        assert_eq!(head.content_length, Some(12));
        assert_eq!(cookie(&head.cookie, "isle"), Some("abc"));
    }

    #[tokio::test]
    async fn refuses_what_it_does_not_do() {
        let chunked = b"PUT / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert_eq!(parse(chunked).await.unwrap_err(), Unread::Bad);
        let doubled = b"PUT / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 9\r\n\r\n";
        assert_eq!(parse(doubled).await.unwrap_err(), Unread::Bad);
        let plus = b"PUT / HTTP/1.1\r\nContent-Length: +5\r\n\r\n";
        assert_eq!(parse(plus).await.unwrap_err(), Unread::Bad);
        let two_hosts = b"GET / HTTP/1.1\r\nHost: 10.0.0.2:47830\r\nHost: evil\r\n\r\n";
        assert_eq!(parse(two_hosts).await.unwrap_err(), Unread::Bad);
        let huge = [b"GET / HTTP/1.1\r\nX: ".as_slice(), &[b'a'; 10_000]].concat();
        assert_eq!(parse(&huge).await.unwrap_err(), Unread::Bad);
        assert_eq!(parse(b"GET / HT").await.unwrap_err(), Unread::Closed);
    }

    fn pace() -> Pace {
        Pace {
            stall: Duration::from_secs(1),
            min_rate: 1000,
            grace: Duration::from_secs(5),
            started: tokio::time::Instant::now(),
            cut: None,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_trickle_falls_behind() {
        let pace = pace();
        tokio::time::advance(Duration::from_secs(4)).await;
        assert!(pace.keeps_up(0));
        tokio::time::advance(Duration::from_secs(6)).await;
        assert!(!pace.keeps_up(9_000));
        assert!(pace.keeps_up(10_000));
    }

    #[test]
    fn percent_codes_round_trip() {
        assert_eq!(percent_decode("%2e%2E%2Fx%zz%"), "../x%zz%");
        assert_eq!(percent_decode("caf%C3%A9"), "café");
        assert_eq!(percent_encode("café 1.jpg"), "caf%C3%A9%201.jpg");
    }

    #[tokio::test]
    async fn headers_cannot_be_split() {
        let mut out = Vec::new();
        let response = Response::not_found().with("X-Test", "a\r\nSet-Cookie: evil=1");
        send(&mut out, response, pace()).await.unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("X-Test: aSet-Cookie: evil=1\r\n"));
        assert!(text.contains("X-Content-Type-Options: nosniff"));
    }
}
