// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! One sharing session: its secret token, the phones that asked and the answers they got, what was
//! received, and when it ends. The server (server.rs) asks it everything; the island sees it as JSON.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use isle_core::shelf::ShelfItem;
use serde::Serialize;
use subtle::ConstantTimeEq;
use tokio::sync::watch;
use tokio::time::Instant;

use super::net::Lan;

/// The limits a session keeps; see SECURITY.md.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Sharing stops after this long without a page, download or upload (polls don't count).
    pub idle: Duration,
    /// The biggest file a phone may send.
    pub max_file: u64,
    /// All a session may receive.
    pub max_session: u64,
    /// Uploads are refused when they would leave less free space than this.
    pub keep_free: u64,
    /// A phone's ask goes unanswered after this.
    pub ask_for: Duration,
    /// A page's poll for changes is answered after this at the latest.
    pub poll_for: Duration,
    /// A connection that sends or takes nothing for this long is closed.
    pub stall: Duration,
    /// A transfer slower than this on average (bytes a second), once `grace` has passed, is cut.
    pub min_rate: u64,
    pub grace: Duration,
    /// A phone not heard from for this long (its page closed, the phone locked or gone) has left; its page
    /// polls well within it. One that says it is going gets `bye_grace` to come back (a reload).
    pub presence: Duration,
    pub bye_grace: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        // As file managers count, so the page says "4 GB".
        const GB: u64 = 1_000_000_000;
        Self {
            idle: Duration::from_secs(10 * 60),
            max_file: 4 * GB,
            max_session: 8 * GB,
            keep_free: GB,
            ask_for: Duration::from_secs(2 * 60),
            poll_for: Duration::from_secs(25),
            stall: Duration::from_secs(30),
            min_rate: 16 * 1024,
            grace: Duration::from_secs(30),
            presence: Duration::from_secs(90),
            bye_grace: Duration::from_secs(4),
        }
    }
}

/// What a session is started with.
#[derive(Debug, Clone)]
pub struct Config {
    /// The network listened on: its address, and which phones may connect.
    pub lan: Lan,
    /// This computer's own addresses: nothing on it may connect (its programs could read the token).
    pub own: Vec<IpAddr>,
    /// Ports tried, at random, before one the system picks.
    pub ports: (u16, u16),
    /// Where received files land (the shelf's own folder).
    pub dir: PathBuf,
    /// The extension's shelf previews (`<md5 of uri>.png`).
    pub previews: PathBuf,
    pub limits: Limits,
}

/// Why a session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Ended {
    /// Stop was pressed, or Isle was turned off.
    Stopped,
    /// Nothing happened for `Limits::idle`.
    Idle,
    Locked,
    Asleep,
    /// GNOME Shell, which started it, left the bus.
    Gone,
    /// The address it listened on went (another network, Wi-Fi off).
    Network,
}

/// A phone's standing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Asking,
    Allowed,
    Denied,
    /// Its ask went unanswered.
    Expired,
    /// Allowed, then taken off on the island.
    Removed,
}

/// A browser that asked to connect. The island knows it by `id`; only the phone has `secret`, its cookie.
#[derive(Debug, Clone, Serialize)]
pub struct Phone {
    pub id: String,
    #[serde(skip)]
    pub secret: String,
    #[serde(skip)]
    pub ip: IpAddr,
    pub address: String,
    pub device: String,
    /// Four digits the phone shows and the island asks with, so the right one is allowed.
    pub code: String,
    #[serde(skip)]
    pub status: Status,
    #[serde(skip)]
    asked: Instant,
    /// When it last asked anything, how many of its polls are held now, and whether the island shows it.
    #[serde(skip)]
    seen: Instant,
    #[serde(skip)]
    held: usize,
    /// Listed as here (else away, dim on the island).
    pub here: bool,
    /// Its page said goodbye: nothing but a new request makes it seem there again.
    #[serde(skip)]
    leaving: bool,
    /// Its page is behind the phone's file picker until then: it stays here meanwhile.
    #[serde(skip)]
    choosing: Option<Instant>,
    /// Set when it is taken off: its transfers under way stop at their next piece.
    #[serde(skip)]
    pub cut: Arc<AtomicBool>,
}

impl Phone {
    /// Asking, or allowed (here or away: it can still come back): what counts against `MAX_PHONES`.
    fn present(&self) -> bool {
        matches!(self.status, Status::Asking | Status::Allowed)
    }

    /// Gone quiet long enough to be away: `presence` (a goodbye shortens it), never while it polls or picks.
    fn gone_quiet(&self, presence: Duration) -> bool {
        self.here
            && self.held == 0
            && self.choosing.is_none_or(|until| Instant::now() >= until)
            && self.seen.elapsed() >= presence
    }
}

/// Why a browser may not ask to connect now.
#[derive(Debug, PartialEq, Eq)]
pub enum Turned {
    /// Its address was turned down or taken off on the island.
    Refused,
    /// Three phones are asking or in already.
    Full,
    /// Its address made a new phone a moment ago: this long until the next.
    Soon(Duration),
}

/// Why an upload can't start.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    TooBig,
    SessionFull,
    ShelfFull,
    /// It would leave the disk with less than `Limits::keep_free`.
    Disk,
}

/// A request's rate allowance per address: a burst of `BURST`, then `PER_SECOND`.
const BURST: f64 = 60.0;
const PER_SECOND: f64 = 20.0;
/// Requests with a wrong token an address may make before it is shut out for the session.
const MISSES: u32 = 20;
/// Phones asking and allowed at once.
pub const MAX_PHONES: usize = 3;
/// One new phone per address in this long; records of phones gone past this many are dropped.
const NEW_PHONE_EVERY: Duration = Duration::from_secs(120);
const KEPT_ENDED: usize = 16;
/// How long a page may stay behind the phone's file picker and still count as there.
const CHOOSING_FOR: Duration = Duration::from_secs(5 * 60);

/// Connections one address may have open at once (a browser opens six to a server), and all of them.
pub const PER_ADDRESS: usize = 6;
pub const MAX_CONNECTIONS: usize = 32;

struct Inner {
    phones: Vec<Phone>,
    /// Addresses shut out for guessing: their connections are closed at once.
    blocked: HashSet<IpAddr>,
    /// Addresses turned down or taken off on the island: they may not ask again, and are told so.
    refused: HashSet<IpAddr>,
    misses: HashMap<IpAddr, u32>,
    allowance: HashMap<IpAddr, (f64, Instant)>,
    last_active: Instant,
    /// Downloads and uploads under way; sharing never stops for being idle during one.
    busy: usize,
    /// Uploads under way, each holding a place on the shelf, and the bytes they may still bring.
    uploading: usize,
    reserved: u64,
    received: u64,
    /// Some phone got through (with the token): the firewall hint can go.
    reached: bool,
    ended: Option<Ended>,
    /// Connections open, by address.
    open: HashMap<IpAddr, usize>,
    /// When each address last made a new phone (see `NEW_PHONE_EVERY`).
    made: HashMap<IpAddr, Instant>,
}

/// A running session; shared by the server's tasks and the D-Bus service.
pub struct Session {
    pub token: String,
    pub addr: SocketAddr,
    pub url: String,
    pub config: Config,
    inner: Mutex<Inner>,
    /// Bumped on every change a page or the island shows: phones, the shelf, the end.
    version: watch::Sender<u64>,
    /// Wakes the session's clock to look at its deadlines again (see `server::keep_time`).
    pub clock: tokio::sync::Notify,
}

impl Session {
    /// A session listening at `addr`, with a fresh token.
    pub fn new(config: Config, addr: SocketAddr) -> Self {
        let token = base64url(&random::<16>());
        Self {
            url: format!("http://{addr}/{token}"),
            token,
            addr,
            config,
            inner: Mutex::new(Inner {
                phones: Vec::new(),
                blocked: HashSet::new(),
                refused: HashSet::new(),
                misses: HashMap::new(),
                allowance: HashMap::new(),
                last_active: Instant::now(),
                busy: 0,
                uploading: 0,
                reserved: 0,
                received: 0,
                reached: false,
                ended: None,
                open: HashMap::new(),
                made: HashMap::new(),
            }),
            version: watch::Sender::new(0),
            clock: tokio::sync::Notify::new(),
        }
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Wakes pages waiting for a change, and the session's own clock.
    pub fn bump(&self) {
        self.version.send_modify(|version| *version += 1);
    }

    pub fn version(&self) -> watch::Receiver<u64> {
        self.version.subscribe()
    }

    /// Whether `candidate` is the token, compared in constant time.
    pub fn token_matches(&self, candidate: &str) -> bool {
        self.token.as_bytes().ct_eq(candidate.as_bytes()).into()
    }

    /// Ends the session (the first reason counts); false if it had already ended.
    pub fn end(&self, why: Ended) -> bool {
        let ended = {
            let mut inner = self.inner();
            let first = inner.ended.is_none();
            if first {
                inner.ended = Some(why);
            }
            first
        };
        if ended {
            self.bump();
        }
        ended
    }

    pub fn ended(&self) -> Option<Ended> {
        self.inner().ended
    }

    /// Something happened that keeps sharing going.
    pub fn touch(&self) {
        self.inner().last_active = Instant::now();
    }

    /// Whether `ip` is shut out.
    #[cfg(test)]
    pub fn blocked(&self, ip: IpAddr) -> bool {
        self.inner().blocked.contains(&ip)
    }

    /// Whether `ip` was turned down or taken off on the island.
    #[cfg(test)]
    pub fn refused(&self, ip: IpAddr) -> bool {
        self.inner().refused.contains(&ip)
    }

    /// A connection from `ip`, counted until the guard goes; None when it may not have one: shut
    /// out, this computer itself, off the network, or too many open (from it, or at all).
    pub fn connect(self: &Arc<Self>, ip: IpAddr) -> Option<Open> {
        if !self.config.lan.contains(ip) || self.config.own.contains(&ip) {
            return None;
        }
        let mut inner = self.inner();
        let total: usize = inner.open.values().sum();
        if inner.blocked.contains(&ip) || total >= MAX_CONNECTIONS {
            return None;
        }
        let open = inner.open.entry(ip).or_default();
        if *open >= PER_ADDRESS {
            return None;
        }
        *open += 1;
        Some(Open(self.clone(), ip))
    }

    /// Takes one request from `ip`'s allowance; false when it has run out.
    pub fn allow_request(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut inner = self.inner();
        let (tokens, at) = inner.allowance.entry(ip).or_insert((BURST, now));
        *tokens = (*tokens + now.duration_since(*at).as_secs_f64() * PER_SECOND).min(BURST);
        *at = now;
        if *tokens < 1.0 {
            return false;
        }
        *tokens -= 1.0;
        true
    }

    /// `ip` used a wrong token; one that keeps guessing is shut out.
    pub fn missed(&self, ip: IpAddr) {
        let mut inner = self.inner();
        let misses = inner.misses.entry(ip).or_default();
        *misses += 1;
        if *misses >= MISSES {
            inner.blocked.insert(ip);
        }
    }

    /// A browser with the token reached the server; true the first time (the island drops its firewall hint).
    pub fn reached(&self) -> bool {
        !std::mem::replace(&mut self.inner().reached, true)
    }

    pub fn has_been_reached(&self) -> bool {
        self.inner().reached
    }

    /// A browser says hello: the phone it is (by its cookie and address), or a new one asking to connect.
    /// Returns the phone and whether the island has a new ask to show, or why it may not ask.
    pub fn hello(
        &self,
        cookie: Option<&str>,
        ip: IpAddr,
        device: String,
    ) -> Result<(Phone, bool), Turned> {
        let mut inner = self.inner();
        let ask_for = self.config.limits.ask_for;
        let refused = inner.refused.contains(&ip);
        let others = |inner: &Inner, me: &str| {
            inner
                .phones
                .iter()
                .filter(|phone| phone.present() && phone.id != me)
                .count()
        };
        let known = inner.phones.iter().position(|phone| {
            phone.ip == ip
                && (cookie.is_some_and(|secret| ct_eq(&phone.secret, secret))
                    || phone.status == Status::Asking)
        });
        if let Some(index) = known {
            let id = inner.phones[index].id.clone();
            let room = others(&inner, &id) < MAX_PHONES;
            let phone = &mut inner.phones[index];
            // Asked too long ago: it asks again, unless its address was turned down meanwhile, or no
            // room is left (then it is busy).
            let wants = !refused
                && (phone.status == Status::Expired
                    || (phone.status == Status::Asking && phone.asked.elapsed() >= ask_for));
            if wants && !room {
                return Err(Turned::Full);
            }
            if wants {
                phone.status = Status::Asking;
                phone.asked = Instant::now();
            }
            // Back (a reload, the same phone again): seen, and listed as here again if it was away.
            phone.seen = Instant::now();
            phone.leaving = false;
            let back = !phone.here;
            phone.here = true;
            let phone = phone.clone();
            drop(inner);
            if wants || back {
                self.bump();
            }
            return Ok((phone, wants || back));
        }
        if refused {
            return Err(Turned::Refused);
        }
        let present = |phone: &&Phone| phone.present();
        if inner.phones.iter().filter(present).count() >= MAX_PHONES {
            return Err(Turned::Full);
        }
        // One new phone per address a while: a page can't make asks (and records) without end.
        if let Some(made) = inner.made.get(&ip)
            && made.elapsed() < NEW_PHONE_EVERY
        {
            return Err(Turned::Soon(NEW_PHONE_EVERY - made.elapsed()));
        }
        inner.made.insert(ip, Instant::now());
        // Phones gone (turned down, unanswered, taken off) are kept only so many.
        let ended: Vec<usize> = (0..inner.phones.len())
            .filter(|&i| !inner.phones[i].present())
            .collect();
        if ended.len() >= KEPT_ENDED {
            let drop_first = ended.len() + 1 - KEPT_ENDED;
            let gone: HashSet<usize> = ended.into_iter().take(drop_first).collect();
            let mut i = 0;
            inner.phones.retain(|_| {
                i += 1;
                !gone.contains(&(i - 1))
            });
        }
        // A code no other phone present shows.
        let code = loop {
            let code = format!("{:04}", u16::from_ne_bytes(random::<2>()) % 10_000);
            if !inner
                .phones
                .iter()
                .filter(present)
                .any(|phone| phone.code == code)
            {
                break code;
            }
        };
        let phone = Phone {
            id: hex(&random::<8>()),
            secret: hex(&random::<16>()),
            ip,
            address: ip.to_canonical().to_string(),
            device,
            code,
            status: Status::Asking,
            asked: Instant::now(),
            seen: Instant::now(),
            held: 0,
            here: true,
            leaving: false,
            choosing: None,
            cut: Arc::new(AtomicBool::new(false)),
        };
        inner.phones.push(phone.clone());
        drop(inner);
        self.bump();
        Ok((phone, true))
    }

    /// The phone with this cookie, from this address.
    pub fn phone(&self, cookie: Option<&str>, ip: IpAddr) -> Option<Phone> {
        let cookie = cookie?;
        self.inner()
            .phones
            .iter()
            .find(|phone| phone.ip == ip && ct_eq(&phone.secret, cookie))
            .cloned()
    }

    /// Takes an allowed phone off; like one turned down, it can't ask again this session.
    pub fn remove(&self, id: &str) -> bool {
        let mut inner = self.inner();
        let Some(phone) = inner
            .phones
            .iter_mut()
            .find(|phone| phone.id == id && phone.status == Status::Allowed)
        else {
            return false;
        };
        phone.status = Status::Removed;
        phone.cut.store(true, Ordering::Release);
        let ip = phone.ip;
        inner.refused.insert(ip);
        drop(inner);
        self.bump();
        true
    }

    /// The island's answer to phone `id`; a phone turned down can't ask again this session.
    pub fn answer(&self, id: &str, allow: bool) -> bool {
        let mut inner = self.inner();
        let Some(phone) = inner
            .phones
            .iter_mut()
            .find(|phone| phone.id == id && phone.status == Status::Asking)
        else {
            return false;
        };
        phone.status = if allow {
            Status::Allowed
        } else {
            Status::Denied
        };
        let ip = phone.ip;
        if !allow {
            inner.refused.insert(ip);
        }
        inner.last_active = Instant::now();
        drop(inner);
        self.bump();
        true
    }

    /// Asks that went unanswered too long; true if any did.
    pub fn expire_asks(&self) -> bool {
        let ask_for = self.config.limits.ask_for;
        let mut expired = false;
        for phone in &mut self.inner().phones {
            if phone.status == Status::Asking && phone.asked.elapsed() >= ask_for {
                phone.status = Status::Expired;
                expired = true;
            }
        }
        if expired {
            self.bump();
        }
        expired
    }

    /// When the session next has something to do on its own: an ask to expire, or the idle stop.
    pub fn next_deadline(&self) -> Instant {
        let inner = self.inner();
        let limits = &self.config.limits;
        // While something is under way, looked at again an idle stretch on (its end counts as activity).
        let idle = if inner.busy > 0 {
            Instant::now() + limits.idle
        } else {
            inner.last_active + limits.idle
        };
        let asks = inner
            .phones
            .iter()
            .filter(|phone| phone.status == Status::Asking)
            .map(|phone| phone.asked + limits.ask_for);
        // And when a phone not polling now will have been gone long enough.
        let gone = inner
            .phones
            .iter()
            .filter(|phone| phone.present() && phone.here && phone.held == 0)
            .map(|phone| (phone.seen + limits.presence).max(phone.choosing.unwrap_or(phone.seen)));
        asks.chain(gone).fold(idle, Instant::min)
    }

    /// A request from the phone with this cookie: it is there. True if it had been away (listed as here again).
    pub fn saw(&self, secret: &str, ip: IpAddr) -> bool {
        let mut inner = self.inner();
        let Some(phone) = inner
            .phones
            .iter_mut()
            .find(|phone| phone.ip == ip && ct_eq(&phone.secret, secret))
        else {
            return false;
        };
        phone.seen = Instant::now();
        phone.leaving = false;
        // Back from the phone's file picker (or never went): it may go away again as any other.
        phone.choosing = None;
        let back = !phone.here && phone.present();
        phone.here = true;
        drop(inner);
        if back {
            self.bump();
        }
        back
    }

    /// A poll the phone with this cookie holds open: it is there for as long as the guard lives.
    pub fn hold(self: &Arc<Self>, secret: &str, ip: IpAddr) -> Option<Held> {
        let mut inner = self.inner();
        let phone = inner
            .phones
            .iter_mut()
            .find(|phone| phone.ip == ip && ct_eq(&phone.secret, secret))?;
        phone.held += 1;
        Some(Held(self.clone(), phone.id.clone()))
    }

    /// The page says it is going (closed, reloaded, the phone locked): away unless it is back within
    /// `Limits::bye_grace`; its polls closing after this don't make it seem there.
    pub fn bye(&self, secret: &str, ip: IpAddr) {
        let mut inner = self.inner();
        if let Some(phone) = inner
            .phones
            .iter_mut()
            .find(|phone| phone.ip == ip && ct_eq(&phone.secret, secret))
        {
            let limits = &self.config.limits;
            phone.leaving = true;
            phone.choosing = None;
            phone.seen = Instant::now()
                .checked_sub(limits.presence.saturating_sub(limits.bye_grace))
                .unwrap_or(phone.seen);
        }
        drop(inner);
        self.clock.notify_one();
    }

    /// The page goes behind the phone's file picker: it stays here meanwhile (up to `CHOOSING_FOR`).
    pub fn choosing(&self, secret: &str, ip: IpAddr) {
        let mut inner = self.inner();
        if let Some(phone) = inner
            .phones
            .iter_mut()
            .find(|phone| phone.ip == ip && ct_eq(&phone.secret, secret))
        {
            phone.choosing = Some(Instant::now() + CHOOSING_FOR);
            // Picking files to send is something done: sharing goes on.
            inner.last_active = Instant::now();
        }
    }

    /// Phones not heard from for `Limits::presence` are away: an allowed one is still in (listed dim, with
    /// its ×) and back with its cookie without a new Allow; an ask whose page said goodbye ends, any other
    /// lives its full time. True if any changed.
    pub fn sweep(&self) -> bool {
        let presence = self.config.limits.presence;
        let mut changed = false;
        for phone in &mut self.inner().phones {
            if phone.present() && phone.gone_quiet(presence) {
                phone.here = false;
                if phone.status == Status::Asking && phone.leaving {
                    phone.status = Status::Expired;
                }
                changed = true;
            }
        }
        if changed {
            self.bump();
        }
        changed
    }

    /// Whether sharing has been idle long enough to stop: nothing under way, nothing for `Limits::idle`.
    pub fn idle(&self) -> bool {
        let inner = self.inner();
        inner.busy == 0 && inner.last_active.elapsed() >= self.config.limits.idle
    }

    /// How many phones the session keeps a record of.
    #[cfg(test)]
    pub fn records(&self) -> usize {
        self.inner().phones.len()
    }

    /// Phones asking, or allowed (here or away), for the island.
    pub fn phones(&self, status: Status) -> Vec<Phone> {
        self.inner()
            .phones
            .iter()
            .filter(|phone| phone.status == status)
            .cloned()
            .collect()
    }

    /// A download or upload under way, until the guard goes.
    pub fn busy(self: &Arc<Self>) -> Busy {
        let mut inner = self.inner();
        inner.busy += 1;
        inner.last_active = Instant::now();
        Busy(self.clone())
    }

    /// Bytes this session may still receive.
    pub fn room_left(&self) -> u64 {
        let inner = self.inner();
        self.config
            .limits
            .max_session
            .saturating_sub(inner.received + inner.reserved)
    }

    /// Uploads under way, each holding a place on the shelf.
    pub fn uploading(&self) -> usize {
        self.inner().uploading
    }

    /// Holds a place on the shelf (which holds `shelved` of `capacity`) and `length` bytes for an upload;
    /// `free`, the disk's free bytes, must also cover what uploads under way may still bring.
    pub fn reserve(
        self: &Arc<Self>,
        length: u64,
        shelved: usize,
        capacity: usize,
        free: Option<u64>,
    ) -> Result<Reservation, Refusal> {
        let limits = &self.config.limits;
        let mut inner = self.inner();
        if length > limits.max_file {
            return Err(Refusal::TooBig);
        }
        if inner.received + inner.reserved + length > limits.max_session {
            return Err(Refusal::SessionFull);
        }
        if shelved + inner.uploading >= capacity {
            return Err(Refusal::ShelfFull);
        }
        if free.is_some_and(|free| free < inner.reserved + length + limits.keep_free) {
            return Err(Refusal::Disk);
        }
        inner.uploading += 1;
        inner.reserved += length;
        Ok(Reservation {
            session: self.clone(),
            length,
            done: false,
        })
    }
}

/// A poll held open by a phone; see `Session::hold`.
pub struct Held(Arc<Session>, String);

impl Drop for Held {
    fn drop(&mut self) {
        let mut inner = self.0.inner();
        if let Some(phone) = inner.phones.iter_mut().find(|phone| phone.id == self.1) {
            phone.held -= 1;
            // A poll closing after a goodbye is no sign of life.
            if !phone.leaving {
                phone.seen = Instant::now();
            }
        }
        drop(inner);
        // Its presence deadline starts now: the clock looks again (pages aren't woken: they'd ping-pong).
        self.0.clock.notify_one();
    }
}

/// A connection counted against its address; see `Session::connect`.
pub struct Open(Arc<Session>, IpAddr);

impl Drop for Open {
    fn drop(&mut self) {
        let mut inner = self.0.inner();
        if let Some(open) = inner.open.get_mut(&self.1) {
            *open -= 1;
            if *open == 0 {
                inner.open.remove(&self.1);
            }
        }
    }
}

/// A download or upload under way; see `Session::busy`.
pub struct Busy(Arc<Session>);

impl Drop for Busy {
    fn drop(&mut self) {
        let mut inner = self.0.inner();
        inner.busy -= 1;
        inner.last_active = Instant::now();
    }
}

/// An upload's place on the shelf and its bytes; given back when it goes, counted once `done`.
pub struct Reservation {
    session: Arc<Session>,
    length: u64,
    done: bool,
}

impl Reservation {
    /// The file arrived: its bytes count against the session.
    pub fn done(mut self) {
        self.done = true;
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut inner = self.session.inner();
        inner.uploading -= 1;
        inner.reserved -= self.length;
        if self.done {
            inner.received += self.length;
        }
    }
}

/// The id a shelf item has in this session: not guessable without the token, and never a path.
pub fn item_id(token: &str, uri: &str) -> String {
    format!("{:x}", md5::compute(format!("{token}\n{uri}")))[..20].to_owned()
}

/// Where the extension keeps the shelf preview of `uri` (see thumbnails.js).
pub fn preview(dir: &Path, uri: &str) -> PathBuf {
    dir.join(format!("{:x}.png", md5::compute(uri)))
}

/// The shelf item with id `id`.
pub fn find<'a>(token: &str, items: &'a [ShelfItem], id: &str) -> Option<&'a ShelfItem> {
    items
        .iter()
        .find(|item| ct_eq(&item_id(token, &item.uri), id))
}

fn ct_eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// `N` bytes from the kernel's random source.
pub fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    let mut filled = 0;
    while filled < N {
        // SAFETY: writes at most the `N - filled` bytes left in `bytes`.
        let got = unsafe { libc::getrandom(bytes[filled..].as_mut_ptr().cast(), N - filled, 0) };
        if got > 0 {
            filled += got as usize;
        } else if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            // Never a guessable token: better no sharing at all.
            panic!("no random numbers: {}", std::io::Error::last_os_error());
        }
    }
    bytes
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Unpadded URL-safe base64 (RFC 4648 §5): 16 bytes make 22 characters.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, byte)| n | u32::from(*byte) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn session(limits: Limits) -> Arc<Session> {
        let config = Config {
            lan: Lan {
                ip: Ipv4Addr::LOCALHOST,
                prefix: 8,
                interface: "lo".into(),
            },
            own: Vec::new(),
            ports: (0, 0),
            dir: std::env::temp_dir(),
            previews: std::env::temp_dir(),
            limits,
        };
        Arc::new(Session::new(config, "127.0.0.1:1".parse().unwrap()))
    }

    #[test]
    fn tokens_are_long_and_fresh() {
        let (a, b) = (session(Limits::default()), session(Limits::default()));
        assert_eq!(a.token.len(), 22);
        assert_ne!(a.token, b.token);
        assert!(a.token_matches(&a.token.clone()));
        assert!(!a.token_matches(&b.token));
        assert!(!a.token_matches(&a.token[..21]));
        assert!(!a.token_matches(""));
        assert_eq!(base64url(b"\xfb\xff\xbf"), "-_-_");
        assert_eq!(base64url(b"hi"), "aGk");
    }

    #[test]
    fn a_phone_asks_once_and_is_answered() {
        let session = session(Limits::default());
        let ip: IpAddr = "127.0.0.9".parse().unwrap();
        let (phone, new) = session.hello(None, ip, "Android · Chrome".into()).unwrap();
        assert!(new);
        // A reload without its cookie yet is the same ask, not a second one.
        let (again, new) = session.hello(None, ip, "Android · Chrome".into()).unwrap();
        assert_eq!((again.id.as_str(), new), (phone.id.as_str(), false));
        assert!(session.answer(&phone.id, true));
        assert_eq!(
            session.phone(Some(&phone.secret), ip).unwrap().status,
            Status::Allowed
        );
        // The island's id is not a cookie, and the cookie from another address is no one.
        assert_ne!(phone.id, phone.secret);
        assert!(session.phone(Some(&phone.id), ip).is_none());
        assert!(
            session
                .phone(Some(&phone.secret), "127.0.0.10".parse().unwrap())
                .is_none()
        );
    }

    #[test]
    fn a_phone_turned_down_is_shut_out() {
        let session = session(Limits::default());
        let ip: IpAddr = "127.0.0.9".parse().unwrap();
        let (phone, _) = session.hello(None, ip, "x".into()).unwrap();
        assert!(session.answer(&phone.id, false));
        assert!(session.refused(ip));
        // Told so, never asking again: with its cookie or without.
        let (again, new) = session.hello(Some(&phone.secret), ip, "x".into()).unwrap();
        assert_eq!((again.status, new), (Status::Denied, false));
        assert_eq!(
            session.hello(None, ip, "x".into()).err(),
            Some(Turned::Refused)
        );
        // Answered once only.
        assert!(!session.answer(&phone.id, true));
    }

    #[test]
    fn only_a_few_phones_at_once() {
        let session = session(Limits::default());
        for n in 0..MAX_PHONES {
            let ip = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 10 + n as u8));
            assert!(session.hello(None, ip, "x".into()).is_ok());
        }
        assert!(
            session
                .hello(None, "127.0.0.99".parse().unwrap(), "x".into())
                .is_err()
        );
    }

    #[test]
    fn guessing_shuts_an_address_out() {
        let session = session(Limits::default());
        let ip: IpAddr = "127.0.0.9".parse().unwrap();
        for _ in 0..MISSES - 1 {
            session.missed(ip);
        }
        assert!(!session.blocked(ip));
        session.missed(ip);
        assert!(session.blocked(ip));
    }

    #[test]
    fn requests_are_rate_limited() {
        let session = session(Limits::default());
        let ip: IpAddr = "127.0.0.9".parse().unwrap();
        let allowed = (0..200).filter(|_| session.allow_request(ip)).count();
        assert!((60..70).contains(&allowed), "{allowed}");
    }

    #[test]
    fn uploads_keep_to_their_limits() {
        let session = session(Limits {
            max_file: 100,
            max_session: 150,
            ..Limits::default()
        });
        assert_eq!(
            session.reserve(101, 0, 6, None).err(),
            Some(Refusal::TooBig)
        );
        let first = session.reserve(100, 0, 6, None).unwrap();
        // Promised bytes count before they arrive.
        assert_eq!(
            session.reserve(60, 0, 6, None).err(),
            Some(Refusal::SessionFull)
        );
        // Each upload under way holds a place on the shelf.
        assert_eq!(
            session.reserve(10, 5, 6, None).err(),
            Some(Refusal::ShelfFull)
        );
        first.done();
        assert_eq!(session.room_left(), 50);
        assert_eq!(session.uploading(), 0);
        // One that failed gives its bytes back.
        drop(session.reserve(50, 0, 6, None).unwrap());
        assert_eq!(session.room_left(), 50);
    }

    #[test]
    fn ids_are_not_paths() {
        let id = item_id("token", "file:///home/a/x.pdf");
        assert_eq!(id.len(), 20);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(id, item_id("other", "file:///home/a/x.pdf"));
        // As the extension names its previews: GLib's MD5 of the URI.
        assert_eq!(
            preview(Path::new("/c"), "file:///a"),
            Path::new(&format!("/c/{:x}.png", md5::compute("file:///a")))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn idleness_is_measured_from_the_last_thing_done() {
        let session = session(Limits {
            idle: Duration::from_secs(600),
            ..Limits::default()
        });
        tokio::time::advance(Duration::from_secs(599)).await;
        assert!(!session.idle());
        let busy = session.busy();
        tokio::time::advance(Duration::from_secs(700)).await;
        // Never while something is under way.
        assert!(!session.idle());
        drop(busy);
        assert!(!session.idle());
        tokio::time::advance(Duration::from_secs(600)).await;
        assert!(session.idle());
    }
}
