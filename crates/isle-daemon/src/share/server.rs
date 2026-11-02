// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Phone sharing's web server, only while sharing: the page, the shelf's files by id, and files sent in.
//! Everything under `/<token>/`; anything else, a wrong token included, is a plain 404.

use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use isle_core::shelf::{CAPACITY, ShelfItem};
use log::{debug, info};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use super::files;
use super::http::{self, Body, Pace, Response, Unread};
use super::session::{
    self, Busy, Config, Ended, Open, Phone, Refusal, Reservation, Session, Status, Turned,
};
use crate::uri;

/// The page, with `{{NONCE}}` for its script and style.
const PAGE: &str = include_str!("page.html");
const COOKIE: &str = "isle";
/// A connection must start its request within this, and send all its head within `HEAD_WITHIN`.
const FIRST_BYTE_WITHIN: Duration = Duration::from_secs(3);
const HEAD_WITHIN: Duration = Duration::from_secs(10);
/// Once sharing ends, answers under way get this long to finish (a page told it stopped).
const GRACE: Duration = Duration::from_millis(500);
/// A file on the shelf must open, or say what it is, within this (a network mount gone away hangs).
const FILE_WITHIN: Duration = Duration::from_secs(2);
/// A body refused before it was read is read and dropped for this long (or this much), so the phone
/// gets the answer instead of a reset connection.
const DRAIN_FOR: Duration = Duration::from_secs(2);
const DRAIN_BYTES: u64 = 16 * 1024 * 1024;
/// While a file comes in, the disk's free space is looked at again after each this many bytes.
const FREE_CHECK_EVERY: u64 = 32 * 1024 * 1024;

/// What the server needs of the rest of isled: the shelf, and the island to tell.
pub trait Host: Clone + Send + Sync + 'static {
    /// The shelf's items, newest first, without those whose check hangs (a network mount gone away).
    fn items(&self) -> impl Future<Output = Vec<ShelfItem>> + Send;
    /// Puts a received file on the shelf; false when it is full.
    fn shelve(&self, path: PathBuf) -> impl Future<Output = bool> + Send;
    /// Changes whenever the shelf does.
    fn shelf_changes(&self) -> impl Future<Output = watch::Receiver<u64>> + Send;
    /// The session changed in a way the island shows (a phone asks, gets through).
    fn changed(&self);
    /// A file arrived from a phone, under this name.
    fn received(&self, name: String);
}

/// Starts listening on the session's network; the session runs until it ends (see `Session::end`).
pub async fn start<H: Host>(config: Config, host: H) -> io::Result<Arc<Session>> {
    let listener = bind(&config).await?;
    let session = Arc::new(Session::new(config, listener.local_addr()?));
    info!("sharing with phones on {}", session.addr);
    tokio::spawn(serve(session.clone(), listener, host.clone()));
    tokio::spawn(keep_time(session.clone(), host.clone()));
    tokio::spawn(follow_shelf(session.clone(), host));
    Ok(session)
}

/// A port in `config.ports`, from a random one on (the system's pick for `(0, 0)`, in tests). All of them
/// taken is an error: a port outside the range would be one the firewall hint doesn't cover.
async fn bind(config: &Config) -> io::Result<TcpListener> {
    let (first, last) = config.ports;
    let ip = config.lan.ip;
    if first == 0 {
        return TcpListener::bind((ip, 0)).await;
    }
    let count = u32::from(last.saturating_sub(first)) + 1;
    let start = u32::from_ne_bytes(session::random::<4>()) % count;
    for n in 0..count {
        let port = first + ((start + n) % count) as u16;
        if let Ok(listener) = TcpListener::bind((ip, port)).await {
            return Ok(listener);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AddrInUse,
        format!("ports {first}–{last} are all in use"),
    ))
}

/// Takes connections from the session's network until the session ends.
async fn serve<H: Host>(session: Arc<Session>, listener: TcpListener, host: H) {
    let mut version = session.version();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(err) => {
                        // Out of file descriptors, say: a moment, rather than spinning.
                        debug!("could not take a connection: {err}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let ip = peer.ip().to_canonical();
                // Not on this network, this computer, shut out, or too many: closed without a word.
                let Some(open) = session.connect(ip) else {
                    continue;
                };
                let (session, host) = (session.clone(), host.clone());
                tokio::spawn(connection(session, host, stream, ip, open));
            }
            changed = version.changed() => {
                if changed.is_err() || session.ended().is_some() {
                    break;
                }
            }
        }
    }
    info!("stopped sharing with phones");
}

/// One request; cut short a moment after the session ends.
async fn connection<H: Host>(
    session: Arc<Session>,
    host: H,
    mut stream: TcpStream,
    ip: IpAddr,
    _open: Open,
) {
    let mut version = session.version();
    let ended = async {
        while session.ended().is_none() {
            if version.changed().await.is_err() {
                break;
            }
        }
        tokio::time::sleep(GRACE).await;
    };
    tokio::select! {
        () = handle(&session, &host, &mut stream, ip) => {}
        () = ended => {}
    }
}

/// How fast this session's transfers must go.
fn pace(session: &Session) -> Pace {
    let limits = &session.config.limits;
    Pace {
        stall: limits.stall,
        min_rate: limits.min_rate,
        grace: limits.grace,
        started: tokio::time::Instant::now(),
        cut: None,
    }
}

async fn handle<H: Host>(session: &Arc<Session>, host: &H, stream: &mut TcpStream, ip: IpAddr) {
    // A connection that says nothing gives its place back soon.
    match tokio::time::timeout(FIRST_BYTE_WITHIN, stream.peek(&mut [0u8; 1])).await {
        Ok(Ok(read)) if read > 0 => {}
        _ => return,
    }
    let mut buf = Vec::new();
    let (head, length) = match tokio::time::timeout(HEAD_WITHIN, http::read_head(stream, &mut buf))
        .await
    {
        Ok(Ok(read)) => read,
        Ok(Err(Unread::Bad)) => {
            let bad = Response::bytes(400, "text/plain; charset=utf-8", b"Bad request".to_vec());
            let _ = http::send(stream, bad, pace(session)).await;
            return;
        }
        _ => return,
    };
    let answer = if session.allow_request(ip) {
        route(session, host, &head, &buf[length..], stream, ip).await
    } else {
        Answer::new(Response::json(429, &json!({"error": "slow-down"})))
    };
    // A file for a phone stops being sent once the phone is taken off.
    let mut sending = pace(session);
    sending.cut = answer.cut.clone();
    // What it holds busy (a download) stays held while it is sent.
    let Answer {
        response,
        busy: _busy,
        held: _held,
        unread_body,
        ..
    } = answer;
    // A body not read (a refused upload, or one sent where none is wanted) is drained after.
    let sent_more = head
        .content_length
        .is_some_and(|body| body > (buf.len() - length) as u64);
    let unread = sent_more && (unread_body || head.method != "PUT");
    if let Err(err) = http::send(stream, response, sending).await {
        debug!("could not answer {ip}: {err}");
        return;
    }
    if unread {
        drain(stream).await;
    }
}

/// Reads and drops what the phone still sends of a body that was refused, then closes: closed with
/// unread data, the connection would be reset and the phone never see the answer.
async fn drain(stream: &mut TcpStream) {
    let _ = stream.shutdown().await;
    let mut chunk = vec![0u8; 64 * 1024];
    let mut dropped = 0u64;
    let _ = tokio::time::timeout(DRAIN_FOR, async {
        while dropped < DRAIN_BYTES {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => dropped += read as u64,
            }
        }
    })
    .await;
}

/// The answer to one request, what it holds busy while it is sent, and whether a body went unread.
struct Answer {
    response: Response,
    busy: Option<Busy>,
    unread_body: bool,
    /// The phone's cut flag, for a file sent to it, and its presence while that goes.
    cut: Option<Arc<std::sync::atomic::AtomicBool>>,
    held: Option<session::Held>,
}

impl Answer {
    fn new(response: Response) -> Self {
        Self {
            response,
            busy: None,
            unread_body: false,
            cut: None,
            held: None,
        }
    }

    /// A refusal sent before the body was read.
    fn refused(status: u16, error: &str) -> Self {
        Self {
            unread_body: true,
            ..Self::new(Response::json(status, &json!({ "error": error })))
        }
    }
}

async fn route<H: Host>(
    session: &Arc<Session>,
    host: &H,
    head: &http::Head,
    body_start: &[u8],
    stream: &mut TcpStream,
    ip: IpAddr,
) -> Answer {
    // Only this address and port: a page elsewhere can't reach it by another name (DNS rebinding).
    if !head.host.eq_ignore_ascii_case(&session.addr.to_string()) {
        return Answer::new(Response::not_found());
    }
    let path = head.path.strip_prefix('/').unwrap_or_default();
    let (token, rest) = path.split_once('/').unwrap_or((path, ""));
    if !session.token_matches(token) {
        // A guess counts; a browser's own asks (`/favicon.ico`) don't.
        if token.len() == session.token.len() {
            session.missed(ip);
        }
        return Answer::new(Response::not_found());
    }
    if session.reached() {
        host.changed();
    }
    let cookie = http::cookie(&head.cookie, COOKIE);
    // Any request but a goodbye is a sign of life: a phone that was away is listed as here again.
    if rest != "api/bye" && cookie.is_some_and(|secret| session.saw(secret, ip)) {
        host.changed();
    }
    let phone = session
        .phone(cookie, ip)
        .filter(|phone| phone.status == Status::Allowed);
    match (head.method.as_str(), rest) {
        ("GET", "") => Answer::new(page()),
        ("POST", "api/hello") => Answer::new(hello(session, host, head, cookie, ip)),
        ("GET", "api/state") => Answer::new(state(session, host, head, cookie, ip, stream).await),
        ("POST", "api/bye") => {
            if let Some(secret) = cookie {
                session.bye(secret, ip);
            }
            Answer::new(Response::json(200, &json!({})))
        }
        ("POST", "api/picking") => {
            if let Some(secret) = cookie {
                session.choosing(secret, ip);
            }
            Answer::new(Response::json(200, &json!({})))
        }
        (_, _) if phone.is_none() => Answer::refused(403, "not-allowed"),
        ("PUT", "api/upload") => match phone {
            // A phone sending a file is there all along, however long it takes.
            Some(phone) => {
                let _held = session.hold(&phone.secret, ip);
                upload(session, host, head, body_start, stream, phone).await
            }
            None => Answer::refused(403, "not-allowed"),
        },
        ("GET", rest) if rest.starts_with("f/") => Answer {
            cut: phone.map(|phone| phone.cut),
            held: cookie.and_then(|secret| session.hold(secret, ip)),
            ..download(session, host, head, &rest[2..]).await
        },
        ("GET", rest) if rest.starts_with("t/") => preview(session, host, &rest[2..]).await,
        _ => Answer::new(Response::not_found()),
    }
}

/// The phone page, its script and style allowed by a fresh nonce and nothing else.
fn page() -> Response {
    let nonce = session::hex(&session::random::<16>());
    let csp = format!(
        "default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; img-src 'self'; \
         connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    Response::bytes(
        200,
        "text/html; charset=utf-8",
        PAGE.replace("{{NONCE}}", &nonce).into_bytes(),
    )
    .with("Content-Security-Policy", csp)
}

/// What a page is told of where its phone stands.
fn status_word(phone: &Phone) -> &'static str {
    match phone.status {
        Status::Asking => "asking",
        Status::Allowed => "allowed",
        Status::Denied => "denied",
        Status::Expired => "expired",
        Status::Removed => "removed",
    }
}

/// A browser asks to connect, or says it is still there: it gets its cookie, where it stands and,
/// while it asks, the code the island asks with.
fn hello<H: Host>(
    session: &Session,
    host: &H,
    head: &http::Head,
    cookie: Option<&str>,
    ip: IpAddr,
) -> Response {
    let (phone, new) = match session.hello(cookie, ip, device_name(&head.user_agent)) {
        Ok(hello) => hello,
        Err(Turned::Refused) => return Response::json(403, &json!({ "status": "denied" })),
        Err(Turned::Full) => return Response::json(403, &json!({ "status": "busy" })),
        // Asked a moment ago from here (another browser on the phone, cookies cleared): wait a little.
        Err(Turned::Soon(wait)) => {
            return Response::json(
                403,
                &json!({ "status": "later", "wait": wait.as_secs().max(1) }),
            );
        }
    };
    if new {
        host.changed();
    }
    let status = status_word(&phone);
    let code = (phone.status == Status::Asking).then_some(phone.code.as_str());
    Response::json(200, &json!({ "status": status, "code": code })).with(
        "Set-Cookie",
        format!(
            "{COOKIE}={}; Path=/{}; HttpOnly; SameSite=Strict; Max-Age=86400",
            phone.secret, session.token
        ),
    )
}

/// Where the page stands, and the shelf once allowed; with `v`, waits until that version changes or
/// the page goes away.
async fn state<H: Host>(
    session: &Arc<Session>,
    host: &H,
    head: &http::Head,
    cookie: Option<&str>,
    ip: IpAddr,
    stream: &mut TcpStream,
) -> Response {
    let since = http::query_param(&head.query, "v").and_then(|v| v.parse::<u64>().ok());
    // While it waits here, the phone is there.
    let _held = cookie.and_then(|secret| session.hold(secret, ip));
    let mut version = session.version();
    if since == Some(*version.borrow_and_update()) && session.ended().is_none() {
        tokio::select! {
            _ = tokio::time::timeout(session.config.limits.poll_for, version.changed()) => {}
            // A page closed or reloaded gives its connection back at once, not after the wait.
            () = closed(stream) => {}
        }
    }
    let v = *version.borrow();
    let phone = session.phone(cookie, ip);
    let status = match (session.ended(), &phone) {
        (Some(_), _) => "stopped",
        (None, Some(phone)) => status_word(phone),
        (None, None) => "unknown",
    };
    if status != "allowed" {
        let code = phone
            .filter(|phone| phone.status == Status::Asking)
            .map(|phone| phone.code);
        return Response::json(200, &json!({ "v": v, "status": status, "code": code }));
    }
    let items = host.items().await;
    let mut listed = Vec::new();
    for item in &items {
        let Some(path) = uri::to_path(&item.uri) else {
            continue;
        };
        // Files only, and only those that answer: a folder isn't sent, a hung mount is left out.
        let Ok(Ok(meta)) = tokio::time::timeout(FILE_WITHIN, tokio::fs::metadata(&path)).await
        else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let kind = files::kind(&item.name);
        let thumb =
            kind == "image" && session::preview(&session.config.previews, &item.uri).is_file();
        listed.push(json!({
            "id": session::item_id(&session.token, &item.uri),
            "name": item.name,
            "size": meta.len(),
            "kind": kind,
            "thumb": thumb,
            "view": files::shows_inline(&item.name),
        }));
    }
    let room = CAPACITY.saturating_sub(items.len() + session.uploading());
    Response::json(
        200,
        &json!({
            "v": v,
            "status": status,
            "items": listed,
            "room": room,
            "capacity": CAPACITY,
            "max_file": session.config.limits.max_file,
            "left": session.room_left(),
        }),
    )
}

/// Resolves once the peer closes its side (or the connection fails); what it sends meanwhile is dropped.
async fn closed(stream: &mut TcpStream) {
    let mut chunk = [0u8; 512];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

/// A file on the shelf, by its id; never by a path the phone names.
async fn download<H: Host>(
    session: &Arc<Session>,
    host: &H,
    head: &http::Head,
    id: &str,
) -> Answer {
    let items = host.items().await;
    let Some(item) = session::find(&session.token, &items, id) else {
        return Answer::new(Response::not_found());
    };
    let Some((file, length)) = open_file(uri::to_path(&item.uri)).await else {
        return Answer::new(Response::not_found());
    };
    let view = http::query_param(&head.query, "view").as_deref() == Some("1");
    let inline = view && files::shows_inline(&item.name);
    let response = Response {
        status: 200,
        headers: vec![
            ("Content-Type", files::content_type(&item.name).to_owned()),
            (
                "Content-Disposition",
                files::disposition(&item.name, inline),
            ),
            ("Content-Security-Policy", SANDBOX.to_owned()),
        ],
        body: Body::File(file, length),
    };
    Answer {
        busy: Some(session.busy()),
        ..Answer::new(response)
    }
}

/// What a file sent to the phone may do once opened there: nothing.
const SANDBOX: &str = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";

/// A picture's square preview, as the island shows it, if the extension made one.
async fn preview<H: Host>(session: &Session, host: &H, id: &str) -> Answer {
    let items = host.items().await;
    let Some(item) = session::find(&session.token, &items, id) else {
        return Answer::new(Response::not_found());
    };
    if files::kind(&item.name) != "image" {
        return Answer::new(Response::not_found());
    }
    let path = session::preview(&session.config.previews, &item.uri);
    let Some((file, length)) = open_file(Some(path)).await else {
        return Answer::new(Response::not_found());
    };
    Answer::new(Response {
        status: 200,
        headers: vec![
            ("Content-Type", "image/png".to_owned()),
            ("Content-Security-Policy", SANDBOX.to_owned()),
        ],
        body: Body::File(file, length),
    })
}

/// A regular file, open, and its length. Opened without waiting (a pipe answers at once, and is then
/// no regular file), and given up on if the disk doesn't answer.
async fn open_file(path: Option<PathBuf>) -> Option<(tokio::fs::File, u64)> {
    let path = path?;
    let open = async {
        let file = tokio::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)
            .await
            .ok()?;
        let meta = file.metadata().await.ok()?;
        meta.is_file().then_some((file, meta.len()))
    };
    tokio::time::timeout(FILE_WITHIN, open).await.ok().flatten()
}

/// A file from the phone: streamed to disk as it comes, then put on the shelf under a safe name.
async fn upload<H: Host>(
    session: &Arc<Session>,
    host: &H,
    head: &http::Head,
    body_start: &[u8],
    stream: &mut TcpStream,
    phone: Phone,
) -> Answer {
    let Some(length) = head.content_length else {
        return Answer::refused(411, "length");
    };
    let name = files::sanitize(&http::query_param(&head.query, "name").unwrap_or_default());
    let dir = &session.config.dir;
    if let Err(err) = crate::store::create_private_dir(dir) {
        debug!("could not make {}: {err}", dir.display());
        return Answer::refused(507, "disk");
    }
    let shelved = host.items().await.len();
    let reservation = match session.reserve(length, shelved, CAPACITY, free_space(dir)) {
        Ok(reservation) => reservation,
        Err(Refusal::TooBig) => return Answer::refused(413, "too-big"),
        Err(Refusal::SessionFull) => return Answer::refused(413, "session-full"),
        Err(Refusal::ShelfFull) => return Answer::refused(409, "shelf-full"),
        Err(Refusal::Disk) => return Answer::refused(507, "disk"),
    };
    let busy = session.busy();
    if head.expects_continue
        && stream
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .await
            .is_err()
    {
        return Answer::refused(400, "closed");
    }
    let (part, mut file) = match Part::create(dir).await {
        Ok(created) => created,
        Err(err) => {
            debug!("could not start a file in {}: {err}", dir.display());
            return Answer::refused(507, "disk");
        }
    };
    let keep = session.config.limits.keep_free / 2;
    let mut pace = pace(session);
    pace.cut = Some(phone.cut.clone());
    if let Err(cut) = receive(&mut file, length, body_start, stream, pace, dir, keep).await {
        return match cut {
            Cut::Disk => Answer::refused(507, "disk"),
            Cut::Short(err) => {
                debug!("an upload stopped part way: {err}");
                Answer::refused(400, "incomplete")
            }
        };
    }
    drop(file);
    // Whole now: it lands (or goes) even if the connection or the session ends meanwhile, so nothing
    // is ever left half done in the shelf's folder.
    let landing = Landing {
        session: session.clone(),
        secret: phone.secret,
        ip: phone.ip,
        part,
        name,
        reservation,
        _busy: busy,
    };
    match tokio::spawn(land(host.clone(), landing)).await {
        Ok(Ok(saved)) => Answer::new(Response::json(201, &json!({ "name": saved }))),
        Ok(Err((status, error))) => Answer::new(Response::json(status, &json!({ "error": error }))),
        Err(_) => Answer::new(Response::json(507, &json!({ "error": "disk" }))),
    }
}

/// An upload that arrived whole, on its way to the shelf.
struct Landing {
    session: Arc<Session>,
    secret: String,
    ip: IpAddr,
    part: Part,
    name: String,
    reservation: Reservation,
    _busy: Busy,
}

/// Names the file and puts it on the shelf; a phone taken off meanwhile has it dropped.
async fn land<H: Host>(host: H, landing: Landing) -> Result<String, (u16, &'static str)> {
    let Landing {
        session,
        secret,
        ip,
        part,
        name,
        reservation,
        _busy,
    } = landing;
    let allowed = session
        .phone(Some(&secret), ip)
        .is_some_and(|phone| phone.status == Status::Allowed);
    if !allowed {
        return Err((403, "not-allowed"));
    }
    let (temp, dir) = (part.path.clone(), session.config.dir.clone());
    let published = tokio::task::spawn_blocking(move || files::publish(&temp, &dir, &name)).await;
    let Ok(Ok(path)) = published else {
        return Err((507, "disk"));
    };
    part.disarm();
    if !host.shelve(path.clone()).await {
        let _ = tokio::fs::remove_file(&path).await;
        return Err((409, "shelf-full"));
    }
    reservation.done();
    let saved = path
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
    host.received(saved.clone());
    Ok(saved)
}

/// Why an upload stopped part way.
enum Cut {
    /// The disk ran low as it came.
    Disk,
    /// The phone went quiet, too slow, or away.
    Short(io::Error),
}

/// Reads exactly `length` bytes of body into `file`: first what came with the head, then the rest, as
/// fast as `pace` asks, stopping if `dir`'s disk falls under `keep` bytes free.
async fn receive(
    file: &mut tokio::fs::File,
    length: u64,
    body_start: &[u8],
    stream: &mut TcpStream,
    pace: Pace,
    dir: &Path,
    keep: u64,
) -> Result<(), Cut> {
    if body_start.len() as u64 > length {
        return Err(Cut::Short(io::ErrorKind::InvalidData.into()));
    }
    file.write_all(body_start).await.map_err(Cut::Short)?;
    let mut done = body_start.len() as u64;
    let mut checked = 0u64;
    let mut chunk = vec![0u8; 64 * 1024];
    while done < length {
        let want = chunk
            .len()
            .min(usize::try_from(length - done).unwrap_or(chunk.len()));
        let read = tokio::time::timeout(pace.stall, stream.read(&mut chunk[..want]))
            .await
            .map_err(|_| Cut::Short(io::ErrorKind::TimedOut.into()))?
            .map_err(Cut::Short)?;
        if read == 0 {
            return Err(Cut::Short(io::ErrorKind::UnexpectedEof.into()));
        }
        file.write_all(&chunk[..read]).await.map_err(Cut::Short)?;
        done += read as u64;
        pace.check(done).map_err(Cut::Short)?;
        if done - checked >= FREE_CHECK_EVERY {
            checked = done;
            if free_space(dir).is_some_and(|free| free < keep) {
                return Err(Cut::Disk);
            }
        }
    }
    file.sync_all().await.map_err(Cut::Short)
}

/// A file on its way in, deleted unless it arrives whole (`disarm`).
struct Part {
    path: PathBuf,
    armed: bool,
}

impl Part {
    /// A new, empty, private file in `dir`, never one already there, and the open file to write.
    async fn create(dir: &Path) -> io::Result<(Self, tokio::fs::File)> {
        let path = dir.join(format!(
            ".phone-{}.part",
            session::hex(&session::random::<8>())
        ));
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .await?;
        Ok((Self { path, armed: true }, file))
    }

    /// It arrived and was moved to its name: nothing to delete.
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for Part {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Bytes free for the user on the disk holding `dir`.
fn free_space(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs is plain data, all zeros a valid value; filled by the call below.
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: a valid C string and a statvfs to fill.
    if unsafe { libc::statvfs(path.as_ptr(), &mut stats) } != 0 {
        return None;
    }
    Some(stats.f_bavail as u64 * stats.f_frsize as u64)
}

/// Ends asks nobody answered, and sharing once idle.
async fn keep_time<H: Host>(session: Arc<Session>, host: H) {
    let mut version = session.version();
    while session.ended().is_none() {
        let deadline = session.next_deadline();
        tokio::select! {
            () = tokio::time::sleep_until(deadline) => {
                // Asks unanswered, and phones gone (page closed, phone locked or away), end.
                if session.expire_asks() | session.sweep() {
                    host.changed();
                }
                if session.idle() {
                    session.end(Ended::Idle);
                }
            }
            changed = version.changed() => {
                if changed.is_err() {
                    return;
                }
            }
            () = session.clock.notified() => {}
        }
    }
}

/// Pages waiting for a change hear of the shelf's.
async fn follow_shelf<H: Host>(session: Arc<Session>, host: H) {
    let mut changes = host.shelf_changes().await;
    let mut version = session.version();
    while session.ended().is_none() {
        tokio::select! {
            changed = changes.changed() => {
                if changed.is_err() {
                    return;
                }
                session.bump();
            }
            changed = version.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
    }
}

/// "iPhone · Safari", "Android phone · Chrome": what the island names a browser by. Only these fixed
/// words reach the island, never the browser's own text.
pub fn device_name(agent: &str) -> String {
    let device = [
        ("iPhone", "iPhone"),
        ("iPad", "iPad"),
        (
            "Android",
            if agent.contains("Mobile") {
                "Android phone"
            } else {
                "Android tablet"
            },
        ),
        ("CrOS", "Chromebook"),
        ("Windows", "Windows PC"),
        ("Linux", "Linux PC"),
    ]
    .into_iter()
    .find_map(|(mark, name)| agent.contains(mark).then_some(name));
    let browser = [
        ("EdgiOS", "Edge"),
        ("EdgA/", "Edge"),
        ("Edg/", "Edge"),
        ("SamsungBrowser", "Samsung Internet"),
        ("OPR/", "Opera"),
        ("OPT/", "Opera"),
        ("FxiOS", "Firefox"),
        ("Firefox/", "Firefox"),
        ("CriOS", "Chrome"),
        ("Chrome/", "Chrome"),
        ("Safari/", "Safari"),
    ]
    .into_iter()
    .find_map(|(mark, name)| agent.contains(mark).then_some(name));
    match (device, browser) {
        (Some(device), Some(browser)) => format!("{device} · {browser}"),
        (Some(name), None) | (None, Some(name)) => name.to_owned(),
        (None, None) => "A browser".to_owned(),
    }
}

#[cfg(test)]
mod tests;
