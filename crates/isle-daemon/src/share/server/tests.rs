// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The server end to end on 127.0.0.1, with a shelf in memory.

use std::net::{Ipv4Addr, SocketAddr};
use std::time::Instant;

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::net::TcpSocket;

use super::*;
use crate::share::net::Lan;
use crate::share::session::{Limits, PER_ADDRESS};

#[derive(Clone)]
struct Fake {
    items: Arc<Mutex<Vec<ShelfItem>>>,
    changes: Arc<watch::Sender<u64>>,
    received: Arc<Mutex<Vec<String>>>,
    changed: Arc<AtomicUsize>,
}

impl Host for Fake {
    async fn items(&self) -> Vec<ShelfItem> {
        self.items.lock().unwrap().clone()
    }

    async fn shelve(&self, path: PathBuf) -> bool {
        let mut items = self.items.lock().unwrap();
        if items.len() >= CAPACITY {
            return false;
        }
        items.insert(
            0,
            ShelfItem {
                uri: crate::uri::from_path(&path),
                name: path.file_name().unwrap().to_string_lossy().into_owned(),
                added_at_ms: 0,
            },
        );
        self.changes.send_modify(|count| *count += 1);
        true
    }

    async fn shelf_changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    fn changed(&self) {
        self.changed.fetch_add(1, Ordering::SeqCst);
    }

    fn received(&self, name: String) {
        self.received.lock().unwrap().push(name);
    }
}

/// A server on 127.0.0.1 with a fresh folder; the shelf holds `files` (name, bytes) from another folder.
struct Rig {
    session: Arc<Session>,
    host: Fake,
    dir: PathBuf,
    shared: PathBuf,
}

impl Rig {
    async fn new(limits: Limits, files: &[(&str, &[u8])]) -> Self {
        Self::with_own(limits, files, Vec::new()).await
    }

    /// As `new`, with `own` as this computer's addresses.
    async fn with_own(limits: Limits, files: &[(&str, &[u8])], own: Vec<IpAddr>) -> Self {
        static COUNT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "isle-share-{}-{}",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::SeqCst)
        ));
        let (dir, shared) = (root.join("shelf"), root.join("files"));
        std::fs::create_dir_all(&shared).unwrap();
        let mut items = Vec::new();
        for (name, bytes) in files {
            let path = shared.join(name);
            std::fs::write(&path, bytes).unwrap();
            items.push(ShelfItem {
                uri: crate::uri::from_path(&path),
                name: (*name).into(),
                added_at_ms: 0,
            });
        }
        let host = Fake {
            items: Arc::new(Mutex::new(items)),
            changes: Arc::new(watch::Sender::new(0)),
            received: Arc::default(),
            changed: Arc::default(),
        };
        let config = Config {
            lan: Lan {
                ip: Ipv4Addr::LOCALHOST,
                prefix: 8,
                interface: "lo".into(),
            },
            own,
            ports: (0, 0),
            dir: dir.clone(),
            previews: root.join("previews"),
            limits,
        };
        let session = start(config, host.clone()).await.unwrap();
        Self {
            session,
            host,
            dir,
            shared,
        }
    }

    fn addr(&self) -> SocketAddr {
        self.session.addr
    }

    /// Sends `method path` with `cookie` and `body`: the status, the head and the body of the answer.
    async fn ask(
        &self,
        method: &str,
        path: &str,
        cookie: &str,
        body: &[u8],
    ) -> (u16, String, Vec<u8>) {
        self.ask_from(LOCAL, method, path, cookie, body).await
    }

    /// As `ask`, from the address `from` (any of 127/8 is this computer's loopback).
    async fn ask_from(
        &self,
        from: Ipv4Addr,
        method: &str,
        path: &str,
        cookie: &str,
        body: &[u8],
    ) -> (u16, String, Vec<u8>) {
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nCookie: isle={cookie}\r\nContent-Length: {}\r\n\
             User-Agent: Mozilla/5.0 (Linux; Android 14; K) Chrome/140.0 Mobile Safari/537.36\r\n\r\n",
            self.addr(),
            body.len()
        );
        raw_from(from, self.addr(), &[head.as_bytes(), body].concat()).await
    }

    /// Says hello from `from`: the cookie and the answer.
    async fn hello_from(&self, from: Ipv4Addr) -> (String, serde_json::Value) {
        let (status, head, body) = self
            .ask_from(from, "POST", &self.at("api/hello"), "", b"")
            .await;
        assert_eq!(status, 200);
        (cookie_of(&head), serde_json::from_slice(&body).unwrap())
    }

    /// The island's id of the phone with this cookie.
    fn id_of(&self, cookie: &str) -> String {
        [Status::Asking, Status::Allowed]
            .into_iter()
            .flat_map(|status| self.session.phones(status))
            .find(|phone| phone.secret == cookie)
            .unwrap()
            .id
    }

    /// Says hello and is allowed on the island: the cookie.
    async fn allowed(&self) -> String {
        let (cookie, _) = self.hello_from(LOCAL).await;
        assert!(self.session.answer(&self.id_of(&cookie), true));
        cookie
    }

    fn at(&self, rest: &str) -> String {
        format!("/{}/{rest}", self.session.token)
    }

    async fn state(&self, cookie: &str) -> serde_json::Value {
        let (status, _, body) = self.ask("GET", &self.at("api/state"), cookie, b"").await;
        assert_eq!(status, 200);
        serde_json::from_slice(&body).unwrap()
    }

    fn files_in_dir(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.shared.parent().unwrap());
    }
}

/// Sends `bytes` and reads the answer to the end.
async fn raw(addr: SocketAddr, bytes: &[u8]) -> (u16, String, Vec<u8>) {
    raw_from(LOCAL, addr, bytes).await
}

const LOCAL: Ipv4Addr = Ipv4Addr::LOCALHOST;

/// The `isle` cookie an answer sets.
fn cookie_of(head: &str) -> String {
    head.lines()
        .find_map(|line| line.strip_prefix("Set-Cookie: isle="))
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

/// A connection from `from` to `addr`.
async fn connect_from(from: Ipv4Addr, addr: SocketAddr) -> TcpStream {
    let socket = TcpSocket::new_v4().unwrap();
    socket.bind(SocketAddr::from((from, 0))).unwrap();
    socket.connect(addr).await.unwrap()
}

/// As `raw`, from the address `from`.
async fn raw_from(from: Ipv4Addr, addr: SocketAddr, bytes: &[u8]) -> (u16, String, Vec<u8>) {
    let socket = TcpSocket::new_v4().unwrap();
    socket.bind(SocketAddr::from((from, 0))).unwrap();
    // Refused (sharing stopped): no answer at all.
    let Ok(mut stream) = socket.connect(addr).await else {
        return (0, String::new(), Vec::new());
    };
    stream.write_all(bytes).await.unwrap();
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer).await;
    let split = answer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap_or(answer.len());
    let head = String::from_utf8_lossy(&answer[..split]).into_owned();
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    (
        status,
        head,
        answer.get(split + 4..).unwrap_or_default().to_vec(),
    )
}

#[tokio::test]
async fn without_the_token_there_is_nothing() {
    let rig = Rig::new(Limits::default(), &[("a.txt", b"secret")]).await;
    let cookie = rig.allowed().await;
    let id = rig.state(&cookie).await["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let wrong = "A".repeat(22);
    for path in [
        "/".to_owned(),
        "/favicon.ico".to_owned(),
        format!("/{wrong}"),
        format!("/{wrong}/api/state"),
        format!("/{wrong}/f/{id}"),
        format!("/{}", &rig.session.token[..21]),
    ] {
        let (status, _, body) = rig.ask("GET", &path, &cookie, b"").await;
        assert_eq!(
            (status, body.as_slice()),
            (404, b"Not found".as_slice()),
            "{path}"
        );
    }
}

#[tokio::test]
async fn paths_never_reach_the_disk() {
    let rig = Rig::new(Limits::default(), &[("a.txt", b"shared")]).await;
    let cookie = rig.allowed().await;
    for rest in [
        "f/../../../../etc/passwd",
        "f/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        "f/..%2f..%2fa.txt",
        "f//etc/passwd",
        "f/",
        "t/../a.txt",
        "../shelf",
        "f/a.txt",
    ] {
        let (status, _, body) = rig.ask("GET", &rig.at(rest), &cookie, b"").await;
        assert_eq!(status, 404, "{rest}");
        assert!(
            !body.windows(6).any(|w| w == b"shared" || w == b"root:x"),
            "{rest}"
        );
    }
}

#[tokio::test]
async fn another_host_name_is_turned_away() {
    let rig = Rig::new(Limits::default(), &[]).await;
    let head = format!(
        "GET /{} HTTP/1.1\r\nHost: evil.example:80\r\n\r\n",
        rig.session.token
    );
    assert_eq!(raw(rig.addr(), head.as_bytes()).await.0, 404);
}

#[tokio::test]
async fn a_phone_waits_for_the_island() {
    let rig = Rig::new(Limits::default(), &[("a.txt", b"shared")]).await;
    let (status, head, _) = rig.ask("POST", &rig.at("api/hello"), "", b"").await;
    assert_eq!(status, 200);
    assert!(head.contains("HttpOnly; SameSite=Strict"));
    let cookie = cookie_of(&head);
    assert_eq!(rig.state(&cookie).await["status"], "asking");
    let asking = rig.session.phones(Status::Asking);
    assert_eq!(asking[0].device, "Android phone · Chrome");
    // Nothing of the shelf until allowed.
    assert!(rig.state(&cookie).await.get("items").is_none());
    let (status, _, _) = rig
        .ask("PUT", &rig.at("api/upload?name=x"), &cookie, b"x")
        .await;
    assert_eq!(status, 403);
    // The cookie is no handle on the island: answering needs the island's own id.
    assert!(!rig.session.answer(&cookie, true));
    assert!(rig.session.answer(&rig.id_of(&cookie), true));
    assert_eq!(rig.state(&cookie).await["status"], "allowed");
}

#[tokio::test]
async fn shelf_files_come_down_by_id() {
    let rig = Rig::new(
        Limits::default(),
        &[("Report \"Q3\".pdf", b"%PDF-1.7 hello")],
    )
    .await;
    let cookie = rig.allowed().await;
    let state = rig.state(&cookie).await;
    let item = &state["items"][0];
    assert_eq!(item["name"], "Report \"Q3\".pdf");
    assert_eq!(item["size"], 14);
    assert_eq!(item["kind"], "pdf");
    let (status, head, body) = rig
        .ask(
            "GET",
            &rig.at(&format!("f/{}", item["id"].as_str().unwrap())),
            &cookie,
            b"",
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(body, b"%PDF-1.7 hello");
    assert!(head.contains("Content-Type: application/pdf"));
    assert!(head.contains("Content-Disposition: attachment; filename=\"Report _Q3_.pdf\""));
    assert!(head.contains("X-Content-Type-Options: nosniff"));
    assert!(head.contains("Content-Security-Policy: sandbox"));
}

#[tokio::test]
async fn uploads_land_on_the_shelf_under_a_safe_name() {
    let rig = Rig::new(Limits::default(), &[]).await;
    let cookie = rig.allowed().await;
    let (status, _, body) = rig
        .ask(
            "PUT",
            &rig.at("api/upload?name=..%2F..%2F.bashrc"),
            &cookie,
            b"photo bytes",
        )
        .await;
    assert_eq!(status, 201, "{}", String::from_utf8_lossy(&body));
    assert_eq!(rig.files_in_dir(), ["bashrc"]);
    assert_eq!(
        std::fs::read(rig.dir.join("bashrc")).unwrap(),
        b"photo bytes"
    );
    // A second of the same name is numbered, never written over.
    let (status, _, _) = rig
        .ask("PUT", &rig.at("api/upload?name=bashrc"), &cookie, b"two")
        .await;
    assert_eq!(status, 201);
    assert_eq!(rig.files_in_dir(), ["bashrc", "bashrc 2"]);
    assert_eq!(*rig.host.received.lock().unwrap(), ["bashrc", "bashrc 2"]);
    assert_eq!(rig.host.items.lock().unwrap().len(), 2);
    let mode = std::os::unix::fs::PermissionsExt::mode(
        &std::fs::metadata(rig.dir.join("bashrc"))
            .unwrap()
            .permissions(),
    );
    assert_eq!(mode & 0o777, 0o600);
}

#[tokio::test]
async fn uploads_keep_to_their_caps() {
    let rig = Rig::new(
        Limits {
            max_file: 10,
            max_session: 15,
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    let upload = |name: &'static str, body: &'static [u8]| {
        let path = rig.at(&format!("api/upload?name={name}"));
        let cookie = cookie.clone();
        let rig = &rig;
        async move { rig.ask("PUT", &path, &cookie, body).await.0 }
    };
    assert_eq!(upload("big", b"01234567890").await, 413);
    assert_eq!(upload("a", b"0123456789").await, 201);
    assert_eq!(upload("b", b"0123456789").await, 413);
    assert_eq!(upload("c", b"01234").await, 201);
    assert_eq!(rig.files_in_dir(), ["a", "c"]);
}

#[tokio::test]
async fn a_full_shelf_takes_nothing() {
    let files: Vec<(String, Vec<u8>)> = (0..CAPACITY)
        .map(|n| (format!("{n}.txt"), vec![b'x']))
        .collect();
    let files: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    let rig = Rig::new(Limits::default(), &files).await;
    let cookie = rig.allowed().await;
    assert_eq!(rig.state(&cookie).await["room"], 0);
    let (status, _, body) = rig
        .ask("PUT", &rig.at("api/upload?name=x"), &cookie, b"x")
        .await;
    assert_eq!(status, 409);
    assert_eq!(body, br#"{"error":"shelf-full"}"#);
    assert!(rig.files_in_dir().is_empty());
}

#[tokio::test]
async fn a_cut_upload_leaves_nothing_behind() {
    let rig = Rig::new(
        Limits {
            stall: Duration::from_millis(200),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    let head = format!(
        "PUT {} HTTP/1.1\r\nHost: {}\r\nCookie: isle={cookie}\r\nContent-Length: 1000\r\n\r\nonly part",
        rig.at("api/upload?name=x.jpg"),
        rig.addr()
    );
    let mut stream = TcpStream::connect(rig.addr()).await.unwrap();
    stream.write_all(head.as_bytes()).await.unwrap();
    // The phone goes quiet, then away.
    tokio::time::sleep(Duration::from_millis(500)).await;
    drop(stream);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(rig.files_in_dir().is_empty(), "{:?}", rig.files_in_dir());
    assert!(rig.host.items.lock().unwrap().is_empty());
    assert_eq!(rig.session.room_left(), Limits::default().max_session);
}

#[tokio::test]
async fn guessing_gets_an_address_shut_out() {
    let rig = Rig::new(Limits::default(), &[]).await;
    // A browser asking for its icon now and then is no guess.
    for _ in 0..30 {
        rig.ask("GET", "/favicon.ico", "", b"").await;
    }
    assert_eq!(rig.ask("GET", &rig.at(""), "", b"").await.0, 200);
    for _ in 0..20 {
        rig.ask("GET", "/AAAAAAAAAAAAAAAAAAAAAA", "", b"").await;
    }
    // Now even the right token gets a closed connection.
    let (status, _, _) = rig.ask("GET", &rig.at(""), "", b"").await;
    assert_eq!(status, 0);
}

#[tokio::test]
async fn the_page_runs_only_its_own_script() {
    let rig = Rig::new(Limits::default(), &[]).await;
    let (status, head, body) = rig.ask("GET", &rig.at(""), "", b"").await;
    assert_eq!(status, 200);
    let csp = head
        .lines()
        .find_map(|line| line.strip_prefix("Content-Security-Policy: "))
        .unwrap();
    let nonce = csp
        .split("'nonce-")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap();
    assert_eq!(nonce.len(), 32);
    assert!(csp.starts_with("default-src 'none'"));
    // The SVG namespace names no place to load from.
    let page = String::from_utf8(body)
        .unwrap()
        .replace("http://www.w3.org/2000/svg", "");
    assert!(page.contains(&format!("<script nonce=\"{nonce}\">")));
    assert!(!page.contains("{{NONCE}}"));
    // Nothing from elsewhere: no address the page could load from.
    assert!(!page.contains("https://") && !page.contains("http://"));
}

#[tokio::test]
async fn sharing_stops_once_idle_and_tells_the_page() {
    let rig = Rig::new(
        Limits {
            idle: Duration::from_millis(400),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    let v = rig.state(&cookie).await["v"].as_u64().unwrap();
    // A page waiting for changes keeps nothing alive, and hears of the end.
    let (status, _, body) = rig
        .ask("GET", &rig.at(&format!("api/state?v={v}")), &cookie, b"")
        .await;
    assert_eq!(status, 200);
    let state: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(state["status"], "stopped");
    assert_eq!(rig.session.ended(), Some(Ended::Idle));
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The port is closed.
    assert!(TcpStream::connect(rig.addr()).await.is_err());
}

#[tokio::test]
async fn unanswered_asks_expire() {
    let rig = Rig::new(
        Limits {
            ask_for: Duration::from_millis(200),
            ..Limits::default()
        },
        &[],
    )
    .await;
    rig.hello_from(LOCAL).await;
    assert_eq!(rig.session.phones(Status::Asking).len(), 1);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(rig.session.phones(Status::Asking).is_empty());
    assert!(rig.host.changed.load(Ordering::SeqCst) >= 2);
}

#[test]
fn browsers_are_named_in_fixed_words() {
    // Trimmed to the parts read.
    let iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile/15E148 Safari/604.1";
    assert_eq!(device_name(iphone), "iPhone · Safari");
    let chrome_ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) CriOS/140.0 Mobile Safari/604.1";
    assert_eq!(device_name(chrome_ios), "iPhone · Chrome");
    let samsung =
        "Mozilla/5.0 (Linux; Android 14; K) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36";
    assert_eq!(device_name(samsung), "Android phone · Samsung Internet");
    assert_eq!(device_name("<script>alert(1)</script>"), "A browser");
}

#[tokio::test]
async fn the_phone_and_the_island_show_the_same_code() {
    let rig = Rig::new(Limits::default(), &[]).await;
    let (cookie, hello) = rig.hello_from(LOCAL).await;
    let code = hello["code"].as_str().unwrap().to_owned();
    assert_eq!(code.len(), 4);
    assert_eq!(rig.state(&cookie).await["code"], code.as_str());
    let asking = rig.session.phones(Status::Asking);
    assert_eq!(
        (asking[0].code.as_str(), asking[0].address.as_str()),
        (code.as_str(), "127.0.0.1")
    );
    // Once allowed, the code is no longer said.
    rig.session.answer(&asking[0].id, true);
    assert!(rig.state(&cookie).await["code"].is_null());
}

#[tokio::test]
async fn allow_lets_in_only_the_phone_it_names() {
    let rig = Rig::new(Limits::default(), &[("a.txt", b"shared")]).await;
    let (a, b) = (Ipv4Addr::new(127, 0, 0, 2), Ipv4Addr::new(127, 0, 0, 3));
    let (honest, honest_hello) = rig.hello_from(a).await;
    // Another browser, claiming to be the same kind of phone, asks just after.
    let (other, other_hello) = rig.hello_from(b).await;
    assert_ne!(honest_hello["code"], other_hello["code"]);
    assert!(rig.session.answer(&rig.id_of(&honest), true));
    let state = |from, cookie: String| {
        let rig = &rig;
        async move {
            let (_, _, body) = rig
                .ask_from(from, "GET", &rig.at("api/state"), &cookie, b"")
                .await;
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["status"].clone()
        }
    };
    assert_eq!(state(a, honest).await, "allowed");
    assert_eq!(state(b, other).await, "asking");
}

#[tokio::test]
async fn a_phone_taken_off_sees_nothing_more() {
    let rig = Rig::new(Limits::default(), &[("a.txt", b"shared")]).await;
    let cookie = rig.allowed().await;
    let id = rig.state(&cookie).await["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(rig.session.remove(&rig.id_of(&cookie)));
    assert_eq!(rig.state(&cookie).await["status"], "removed");
    assert_eq!(
        rig.ask("GET", &rig.at(&format!("f/{id}")), &cookie, b"")
            .await
            .0,
        403
    );
    // Saying hello again doesn't make it ask again.
    let (status, _, body) = rig.ask("POST", &rig.at("api/hello"), &cookie, b"").await;
    assert_eq!(status, 200);
    assert!(String::from_utf8_lossy(&body).contains("\"removed\""));
    assert!(rig.session.phones(Status::Asking).is_empty());
}

#[tokio::test]
async fn at_most_three_phones() {
    let rig = Rig::new(Limits::default(), &[]).await;
    for n in 2..5 {
        rig.hello_from(Ipv4Addr::new(127, 0, 0, n)).await;
    }
    let from = Ipv4Addr::new(127, 0, 0, 9);
    let (status, _, body) = rig
        .ask_from(from, "POST", &rig.at("api/hello"), "", b"")
        .await;
    assert_eq!(
        (status, body.as_slice()),
        (403, br#"{"status":"busy"}"#.as_slice())
    );
}

#[tokio::test]
async fn one_address_cant_take_every_connection() {
    let rig = Rig::new(Limits::default(), &[]).await;
    let from = Ipv4Addr::new(127, 0, 0, 7);
    // Six connections that say nothing hold their places for a moment...
    let mut idle = Vec::new();
    for _ in 0..PER_ADDRESS {
        idle.push(connect_from(from, rig.addr()).await);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    // ...a seventh is closed at once, while another address is served.
    let mut seventh = connect_from(from, rig.addr()).await;
    let mut byte = [0u8; 1];
    let read = tokio::time::timeout(Duration::from_secs(1), seventh.read(&mut byte)).await;
    assert!(matches!(read, Ok(Ok(0)) | Ok(Err(_))), "{read:?}");
    let other = Ipv4Addr::new(127, 0, 0, 8);
    assert_eq!(
        rig.ask_from(other, "GET", &rig.at(""), "", b"").await.0,
        200
    );
    // Silent ones give their places back soon.
    let started = Instant::now();
    let read = idle[0].read(&mut byte).await;
    assert!(matches!(read, Ok(0) | Err(_)));
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{:?}",
        started.elapsed()
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(rig.ask_from(from, "GET", &rig.at(""), "", b"").await.0, 200);
}

#[tokio::test]
async fn this_computer_cant_connect() {
    let rig = Rig::with_own(Limits::default(), &[], vec![IpAddr::V4(LOCAL)]).await;
    assert_eq!(rig.ask("GET", &rig.at(""), "", b"").await.0, 0);
}

#[tokio::test]
async fn only_an_allowed_phone_keeps_sharing_going() {
    let rig = Rig::new(
        Limits {
            idle: Duration::from_millis(500),
            ..Limits::default()
        },
        &[],
    )
    .await;
    // The token alone: pages and hellos, over and over, keep nothing alive.
    for _ in 0..12 {
        rig.ask("GET", &rig.at(""), "", b"").await;
        rig.ask("POST", &rig.at("api/hello"), "", b"").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(rig.session.ended(), Some(Ended::Idle));
}

#[tokio::test]
async fn a_trickle_is_cut() {
    let rig = Rig::new(
        Limits {
            min_rate: 10_000,
            grace: Duration::from_millis(300),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    let head = format!(
        "PUT {} HTTP/1.1\r\nHost: {}\r\nCookie: isle={cookie}\r\nContent-Length: 100000\r\n\r\n",
        rig.at("api/upload?name=slow.bin"),
        rig.addr()
    );
    let stream = TcpStream::connect(rig.addr()).await.unwrap();
    let (mut reader, mut writer) = stream.into_split();
    writer.write_all(head.as_bytes()).await.unwrap();
    let started = Instant::now();
    // A few bytes now and then, never giving up.
    let trickle = tokio::spawn(async move {
        while writer.write_all(b"xx").await.is_ok() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
    let mut answer = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), reader.read_to_end(&mut answer)).await;
    trickle.abort();
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{:?}",
        started.elapsed()
    );
    assert!(String::from_utf8_lossy(&answer).contains("incomplete"));
    assert!(rig.files_in_dir().is_empty(), "{:?}", rig.files_in_dir());
    assert_eq!(rig.session.uploading(), 0);
}

#[tokio::test]
async fn a_refused_upload_is_answered_not_reset() {
    let rig = Rig::new(
        Limits {
            max_file: 1000,
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    let length = 8 * 1024 * 1024;
    let head = format!(
        "PUT {} HTTP/1.1\r\nHost: {}\r\nCookie: isle={cookie}\r\nContent-Length: {length}\r\n\r\n",
        rig.at("api/upload?name=big.bin"),
        rig.addr()
    );
    let stream = TcpStream::connect(rig.addr()).await.unwrap();
    let (mut reader, mut writer) = stream.into_split();
    writer.write_all(head.as_bytes()).await.unwrap();
    // The phone keeps sending its body while the answer comes.
    let sending = tokio::spawn(async move {
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..(length / chunk.len()) {
            if writer.write_all(&chunk).await.is_err() {
                break;
            }
        }
    });
    let mut answer = Vec::new();
    reader.read_to_end(&mut answer).await.unwrap();
    let answer = String::from_utf8_lossy(&answer);
    assert!(answer.starts_with("HTTP/1.1 413"), "{answer}");
    assert!(answer.ends_with(r#"{"error":"too-big"}"#), "{answer}");
    sending.abort();
}

#[tokio::test]
async fn the_disk_counts_what_uploads_under_way_will_bring() {
    let rig = Rig::new(Limits::default(), &[]).await;
    let free = Some(Limits::default().keep_free + 1000);
    let first = rig.session.reserve(600, 0, CAPACITY, free).unwrap();
    // Free space for one of the two: the second is turned down before it starts.
    assert_eq!(
        rig.session.reserve(600, 0, CAPACITY, free).err(),
        Some(Refusal::Disk)
    );
    drop(first);
    assert!(rig.session.reserve(600, 0, CAPACITY, free).is_ok());
}

#[tokio::test]
async fn a_file_that_never_opens_is_left_out() {
    let rig = Rig::new(Limits::default(), &[("a.txt", b"shared")]).await;
    // A pipe on the shelf: opening it to read would wait for a writer for ever.
    let pipe = rig.shared.join("pipe");
    let path = std::ffi::CString::new(pipe.to_str().unwrap()).unwrap();
    // SAFETY: a valid C string.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let uri = crate::uri::from_path(&pipe);
    rig.host.items.lock().unwrap().push(ShelfItem {
        uri: uri.clone(),
        name: "pipe".into(),
        added_at_ms: 0,
    });
    let cookie = rig.allowed().await;
    assert_eq!(
        rig.state(&cookie).await["items"].as_array().unwrap().len(),
        1
    );
    let id = session::item_id(&rig.session.token, &uri);
    let started = Instant::now();
    assert_eq!(
        rig.ask("GET", &rig.at(&format!("f/{id}")), &cookie, b"")
            .await
            .0,
        404
    );
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn a_long_name_in_any_script_lands() {
    let rig = Rig::new(Limits::default(), &[]).await;
    let cookie = rig.allowed().await;
    let name = format!("{}.png", "写".repeat(114));
    let path = rig.at(&format!("api/upload?name={}", http::percent_encode(&name)));
    let (status, _, body) = rig.ask("PUT", &path, &cookie, b"picture").await;
    assert_eq!(status, 201, "{}", String::from_utf8_lossy(&body));
    assert!(rig.files_in_dir()[0].len() <= 200);
}

#[tokio::test]
async fn all_ports_taken_is_an_error() {
    let taken = TcpListener::bind((LOCAL, 0)).await.unwrap();
    let port = taken.local_addr().unwrap().port();
    let config = Config {
        lan: Lan {
            ip: LOCAL,
            prefix: 8,
            interface: "lo".into(),
        },
        own: Vec::new(),
        ports: (port, port),
        dir: std::env::temp_dir(),
        previews: std::env::temp_dir(),
        limits: Limits::default(),
    };
    let host = Fake {
        items: Arc::default(),
        changes: Arc::new(watch::Sender::new(0)),
        received: Arc::default(),
        changed: Arc::default(),
    };
    let err = start(config, host).await.err().unwrap();
    assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
}

#[tokio::test]
async fn a_phone_that_goes_quiet_is_away_and_comes_back_without_a_new_allow() {
    let rig = Rig::new(
        Limits {
            presence: Duration::from_millis(400),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    assert_eq!(rig.session.phones(Status::Allowed).len(), 1);
    // Its page closed, the phone locked: nothing heard for a while, it is away.
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(allowed(&rig), [("127.0.0.1".to_owned(), false)]);
    // The same phone again: in at once, here again.
    assert_eq!(rig.state(&cookie).await["status"], "allowed");
    assert_eq!(allowed(&rig), [("127.0.0.1".to_owned(), true)]);
    assert!(rig.session.phones(Status::Asking).is_empty());
}

#[tokio::test]
async fn a_page_that_says_goodbye_leaves_soon_unless_it_comes_back() {
    let rig = Rig::new(
        Limits {
            presence: Duration::from_secs(30),
            bye_grace: Duration::from_millis(300),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    rig.ask("POST", &rig.at("api/bye"), &cookie, b"").await;
    // A reload: back within the grace, it stays.
    tokio::time::sleep(Duration::from_millis(100)).await;
    rig.state(&cookie).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(allowed(&rig), [("127.0.0.1".to_owned(), true)]);
    // Closed for good: away.
    rig.ask("POST", &rig.at("api/bye"), &cookie, b"").await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(allowed(&rig), [("127.0.0.1".to_owned(), false)]);
}

#[tokio::test]
async fn an_ask_whose_page_closed_ends() {
    let rig = Rig::new(
        Limits {
            bye_grace: Duration::from_millis(200),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let (cookie, _) = rig.hello_from(LOCAL).await;
    rig.ask("POST", &rig.at("api/bye"), &cookie, b"").await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(rig.session.phones(Status::Asking).is_empty());
    assert_eq!(rig.state(&cookie).await["status"], "expired");
}

#[tokio::test]
async fn taking_a_phone_off_cuts_its_transfers() {
    let big = vec![b'x'; 32 * 1024 * 1024];
    let rig = Rig::new(Limits::default(), &[("big.bin", &big)]).await;
    let cookie = rig.allowed().await;
    let id = rig.state(&cookie).await["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // A download read slowly, and an upload half sent.
    let mut download = TcpStream::connect(rig.addr()).await.unwrap();
    let head = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nCookie: isle={cookie}\r\n\r\n",
        rig.at(&format!("f/{id}")),
        rig.addr()
    );
    download.write_all(head.as_bytes()).await.unwrap();
    let mut got = vec![0u8; 64 * 1024];
    download.read_exact(&mut got).await.unwrap();
    let mut upload = TcpStream::connect(rig.addr()).await.unwrap();
    let head = format!(
        "PUT {} HTTP/1.1\r\nHost: {}\r\nCookie: isle={cookie}\r\nContent-Length: 1000000\r\n\r\n",
        rig.at("api/upload?name=half.jpg"),
        rig.addr()
    );
    upload.write_all(head.as_bytes()).await.unwrap();
    upload.write_all(&[b'y'; 300_000]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(rig.session.remove(&rig.id_of(&cookie)));
    // More body makes the upload notice; the download stops short of 32 MB.
    let _ = upload.write_all(&[b'y'; 300_000]).await;
    let mut rest = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), download.read_to_end(&mut rest)).await;
    assert!(rest.len() + got.len() < big.len(), "{}", rest.len());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(rig.files_in_dir().is_empty(), "{:?}", rig.files_in_dir());
    assert_eq!(rig.session.uploading(), 0);
}

/// Allowed phones of the session, here or away, by address.
fn allowed(rig: &Rig) -> Vec<(String, bool)> {
    rig.session
        .phones(Status::Allowed)
        .into_iter()
        .map(|phone| (phone.address, phone.here))
        .collect()
}

#[tokio::test]
async fn a_phone_that_comes_back_never_makes_a_fourth() {
    let rig = Rig::new(
        Limits {
            presence: Duration::from_millis(300),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let mut cookies = Vec::new();
    for n in 2..5 {
        let (cookie, _) = rig.hello_from(Ipv4Addr::new(127, 0, 0, n)).await;
        assert!(rig.session.answer(&rig.id_of(&cookie), true));
        cookies.push(cookie);
    }
    // The first goes quiet: still in (it can come back), so a fourth can't ask.
    tokio::time::sleep(Duration::from_millis(700)).await;
    let from = Ipv4Addr::new(127, 0, 0, 5);
    let (status, _, _) = rig
        .ask_from(from, "POST", &rig.at("api/hello"), "", b"")
        .await;
    assert_eq!(status, 403);
    let first = Ipv4Addr::new(127, 0, 0, 2);
    rig.ask_from(first, "GET", &rig.at("api/state"), &cookies[0], b"")
        .await;
    assert_eq!(allowed(&rig).len(), 3, "{:?}", allowed(&rig));
}

#[tokio::test]
async fn an_allowed_phone_away_is_listed_away_not_hidden() {
    let rig = Rig::new(
        Limits {
            presence: Duration::from_millis(300),
            ..Limits::default()
        },
        &[],
    )
    .await;
    rig.allowed().await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(allowed(&rig), [("127.0.0.1".to_owned(), false)]);
}

#[tokio::test]
async fn a_goodbye_before_the_poll_closes_still_goes_soon() {
    let rig = Rig::new(
        Limits {
            presence: Duration::from_secs(30),
            bye_grace: Duration::from_millis(300),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    let v = rig.state(&cookie).await["v"].as_u64().unwrap();
    // The page's poll, held open, closes only after its goodbye is in.
    let mut poll = TcpStream::connect(rig.addr()).await.unwrap();
    let head = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nCookie: isle={cookie}\r\n\r\n",
        rig.at(&format!("api/state?v={v}")),
        rig.addr()
    );
    poll.write_all(head.as_bytes()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    rig.ask("POST", &rig.at("api/bye"), &cookie, b"").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(poll);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(allowed(&rig), [("127.0.0.1".to_owned(), false)]);
}

#[tokio::test]
async fn a_goodbye_from_a_phone_gone_doesnt_bring_it_back() {
    let rig = Rig::new(
        Limits {
            presence: Duration::from_millis(300),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    let told = rig.host.changed.load(Ordering::SeqCst);
    rig.ask("POST", &rig.at("api/bye"), &cookie, b"").await;
    assert_eq!(allowed(&rig), [("127.0.0.1".to_owned(), false)]);
    assert_eq!(rig.host.changed.load(Ordering::SeqCst), told);
}

#[tokio::test]
async fn an_ask_lives_its_full_time_though_its_phone_looks_away() {
    let rig = Rig::new(
        Limits {
            presence: Duration::from_millis(200),
            ..Limits::default()
        },
        &[],
    )
    .await;
    rig.hello_from(LOCAL).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(rig.session.phones(Status::Asking).len(), 1);
}

#[tokio::test]
async fn one_address_makes_one_new_phone_in_two_minutes() {
    let rig = Rig::new(
        Limits {
            ask_for: Duration::from_millis(100),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let (cookie, _) = rig.hello_from(LOCAL).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Without its cookie: a new phone, too soon.
    let (status, _, _) = rig.ask("POST", &rig.at("api/hello"), "", b"").await;
    assert_eq!(status, 403);
    // With it: the same phone asks again.
    let (status, _, body) = rig.ask("POST", &rig.at("api/hello"), &cookie, b"").await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("asking"));
}

#[tokio::test]
async fn ended_asks_are_pruned() {
    let rig = Rig::new(
        Limits {
            ask_for: Duration::from_millis(50),
            ..Limits::default()
        },
        &[],
    )
    .await;
    for n in 10..90u8 {
        rig.hello_from(Ipv4Addr::new(127, 0, 1, n)).await;
        if n % 3 == 0 {
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    rig.hello_from(Ipv4Addr::new(127, 0, 2, 1)).await;
    assert!(rig.session.records() <= 3 + 16, "{}", rig.session.records());
}

#[tokio::test]
async fn a_phone_choosing_files_stays() {
    let rig = Rig::new(
        Limits {
            presence: Duration::from_millis(300),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    // The page hidden behind the phone's picker: it said so first.
    rig.ask("POST", &rig.at("api/picking"), &cookie, b"").await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(allowed(&rig), [("127.0.0.1".to_owned(), true)]);
}

#[tokio::test]
async fn a_page_left_open_doesnt_keep_sharing_going() {
    let rig = Rig::new(
        Limits {
            idle: Duration::from_millis(600),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    // The page polls on and on, says hello, picks nothing: no activity.
    for _ in 0..20 {
        if rig.session.ended().is_some() {
            break;
        }
        rig.ask("GET", &rig.at("api/state"), &cookie, b"").await;
        rig.ask("POST", &rig.at("api/hello"), &cookie, b"").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(rig.session.ended(), Some(Ended::Idle));
}

#[tokio::test]
async fn too_soon_for_a_new_phone_says_so() {
    let rig = Rig::new(Limits::default(), &[]).await;
    rig.allowed().await;
    // Another browser on the same phone (no cookie): not "three phones", but "a moment".
    let (status, _, body) = rig.ask("POST", &rig.at("api/hello"), "x", b"").await;
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (status, body["status"].as_str()),
        (403, Some("later")),
        "{body}"
    );
    assert!(
        (1..=120).contains(&body["wait"].as_u64().unwrap()),
        "{body}"
    );
}

#[tokio::test]
async fn back_from_the_picker_it_can_go_away_again() {
    let rig = Rig::new(
        Limits {
            presence: Duration::from_millis(300),
            ..Limits::default()
        },
        &[],
    )
    .await;
    let cookie = rig.allowed().await;
    rig.ask("POST", &rig.at("api/picking"), &cookie, b"").await;
    // Back from the picker (a poll), then the phone locks.
    rig.state(&cookie).await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(allowed(&rig), [("127.0.0.1".to_owned(), false)]);
}
