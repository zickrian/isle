// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Watches every MPRIS player on the session bus and publishes the active one.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::StreamExt;
use log::{debug, warn};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio::time::Instant;
use zbus::fdo::{DBusProxy, PropertiesProxy};
use zbus::names::{BusName, InterfaceName, OwnedBusName, OwnedUniqueName};
use zbus::object_server::InterfaceRef;
use zbus::proxy::CacheProperties;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, MatchRule, MessageStream, proxy};

use super::gap::GapBridge;
use super::lyrics::{self, Lyrics, LyricsStatus, TrackQuery};
use super::{MediaService, NowPlaying, PlayerChoice, Wish, Wishes, art};
use crate::clock::now_ms;

const NAME_PREFIX: &str = "org.mpris.MediaPlayer2.";
/// playerctld re-exports other players; listening to it would duplicate them.
const IGNORED: &[&str] = &["org.mpris.MediaPlayer2.playerctld"];
const OBJECT_PATH: &str = "/org/mpris/MediaPlayer2";
/// A player sets its properties one by one when a song changes: those coming this close together are read
/// once.
const BURST: Duration = Duration::from_millis(40);
const APP_INTERFACE: &str = "org.mpris.MediaPlayer2";
const PLAYER_INTERFACE: &str = "org.mpris.MediaPlayer2.Player";
/// The bus connection has no method timeout, and a hung player would
/// otherwise stall whatever awaits it for good.
const PLAYER_TIMEOUT: Duration = Duration::from_secs(5);
/// How long cover art that failed to download is left alone. Without this,
/// every update would try the dead link (offline, 404, oversized) again.
const ART_RETRY: Duration = Duration::from_secs(5 * 60);
/// First wait before looking up lyrics again after a failed lookup; it
/// doubles with every failure for the same track, up to [`LYRICS_RETRY_MAX`].
const LYRICS_RETRY: Duration = Duration::from_secs(30);
const LYRICS_RETRY_MAX: Duration = Duration::from_secs(10 * 60);
/// While the island shows the position, the playing player is read this often: MPRIS signals no progress.
const POLL: Duration = Duration::from_secs(1);
/// Sooner, to confirm a read that fell behind (see [`reconcile`]), or to see a stall end.
const POLL_CONFIRM: Duration = Duration::from_millis(350);
/// Sooner while a new speed is measured, each step long enough to tell it ([`PACE_MIN_STEP_MS`]).
const POLL_MEASURE: Duration = Duration::from_millis(500);
/// After a read that failed, so a hung player doesn't hold the watcher up every second.
const POLL_FAILED: Duration = Duration::from_secs(10);
/// Polls in a row at 0 after which a player is taken to answer polls with 0: read every [`POLL`] again.
const ZERO_POLLS: u8 = 3;

/// The MPRIS player controls Isle uses.
#[proxy(
    interface = "org.mpris.MediaPlayer2.Player",
    default_path = "/org/mpris/MediaPlayer2",
    gen_blocking = false
)]
pub trait Player {
    /// Toggles playback.
    fn play_pause(&self) -> zbus::Result<()>;
    /// Skips to the next track.
    fn next(&self) -> zbus::Result<()>;
    /// Back to the previous track.
    fn previous(&self) -> zbus::Result<()>;
    /// Moves by `offset` microseconds from where it is.
    fn seek(&self, offset: i64) -> zbus::Result<()>;
    /// Jumps to `position` microseconds, if `track_id` is still the track playing.
    fn set_position(&self, track_id: &ObjectPath<'_>, position: i64) -> zbus::Result<()>;
    /// Where playback is now, in microseconds.
    #[zbus(property)]
    fn position(&self) -> zbus::Result<i64>;
    /// Sent when the position jumps rather than moving on with time.
    #[zbus(signal)]
    fn seeked(&self, position: i64) -> zbus::Result<()>;
}

/// The player's app, to bring its window forward.
#[proxy(
    interface = "org.mpris.MediaPlayer2",
    default_path = "/org/mpris/MediaPlayer2",
    gen_blocking = false
)]
pub trait App {
    /// Shows the player's window.
    fn raise(&self) -> zbus::Result<()>;
}

/// What the watch loop is woken for, besides bus names and wishes from the extension.
enum Event {
    /// A player's properties changed. `seeked` is the position from a `Seeked` in that same burst.
    Player {
        name: OwnedBusName,
        seeked: Option<i64>,
    },
    /// `mpris:length` was still missing; read the player again.
    LengthRetry(OwnedBusName),
    /// A cover art download finished, successfully or not.
    ArtDone { url: String, ok: bool },
    /// The result of lyrics lookup number `lookup`.
    Lyrics { lookup: u64, lyrics: Lyrics },
    /// Time to retry lyrics lookup number `lookup`, which failed.
    RetryLyrics { lookup: u64 },
    /// A gap between songs may be over; see [`GapBridge`].
    GapOver,
    /// What the island's poll of player `name` read (see `Watcher::poll`).
    Polled {
        name: OwnedBusName,
        read: Result<Box<Snapshot>, String>,
    },
    /// Whoever turned watching on left the bus.
    WatcherGone(OwnedUniqueName),
}

/// Everything read from one player's `GetAll`.
#[derive(Debug, Clone, Default, PartialEq)]
struct Snapshot {
    status: String,
    title: String,
    artist: String,
    album: String,
    art_url: String,
    track_id: Option<OwnedObjectPath>,
    length_us: i64,
    position_us: i64,
    sampled_at_ms: i64,
    rate: f64,
    can_go_next: bool,
    can_go_previous: bool,
    can_play_pause: bool,
    can_seek: bool,
    /// `Position` was in the read. Absent is not the same as a reported 0.
    position_known: bool,
    /// A read that fell behind, passed over until the next confirms it: (position_us, sampled_at_ms).
    doubt: Option<(i64, i64)>,
    /// The speed the reads move at, when it is not the `Rate` reported.
    pace: Pace,
    /// Reads in a row on a whole second; from [`COARSE_AFTER`] on, the player reads only whole seconds.
    whole: u8,
    /// Polls in a row that read 0 and were passed over; from [`ZERO_POLLS`] on, no sooner poll confirms them.
    zeros: u8,
}

/// One player being watched.
struct Entry {
    player: PlayerProxy<'static>,
    properties: PropertiesProxy<'static>,
    identity: String,
    desktop_entry: String,
    /// A web browser, whose reads are stale at times (see [`reconcile`]).
    browser: bool,
    snapshot: Snapshot,
    /// Order in which players last started playing; the latest one wins.
    started_playing: u64,
    listener: AbortHandle,
    /// Re-reads while the track's length is still unknown, at most two.
    length_tries: u8,
    /// A length re-read is already waiting.
    length_waiting: bool,
}

impl Drop for Entry {
    /// Stops listening to a player that left the bus.
    fn drop(&mut self) {
        self.listener.abort();
    }
}

/// All the watching state, owned by the loop in [`watch`].
struct Watcher {
    conn: Connection,
    iface: InterfaceRef<MediaService>,
    players: HashMap<OwnedBusName, Entry>,
    play_counter: u64,
    events: mpsc::UnboundedSender<Event>,
    /// Remote art currently downloading, to avoid starting it twice.
    downloading_art: Option<String>,
    /// Remote art that could not be downloaded, and when; it is not tried
    /// again until [`ART_RETRY`] has passed and the player next updates.
    failed_art: HashMap<String, Instant>,
    /// The last art URL found on disk and its path, so publishing again needs no file lookup.
    art_found: Option<(String, String)>,
    /// The track whose lyrics are loaded or loading.
    lyrics_query: Option<TrackQuery>,
    /// Numbers each lyrics lookup, so late results and retry timers that
    /// belong to an earlier one are recognised and dropped.
    lyrics_lookup: u64,
    /// Failed lookups in a row for the current track, for the retry backoff.
    lyrics_failures: u32,
    gap: GapBridge<Option<(PlayerProxy<'static>, Option<OwnedObjectPath>)>>,
    /// When a `GapOver` is due, so only one waits at a time.
    gap_check: Option<Instant>,
    /// The player the user picked; it stays until another starts playing.
    chosen: Option<OwnedBusName>,
    /// Whether lyrics are looked up online (Settings); `None` until the extension says.
    lyrics_online: Option<bool>,
    /// The current track's lyrics wait to be looked up (see [`lyrics_step`]).
    lyrics_waiting: bool,
    /// The island shows the position: the active player is read every [`POLL`] while it plays.
    watching: bool,
    /// When the active player was last read for that; `None` reads it at once.
    polled_at: Option<Instant>,
    /// The last of those reads failed.
    poll_failed: bool,
    /// The player one of those reads is under way for, off the loop: a hung player holds up nothing else.
    polling: Option<OwnedBusName>,
    /// Who turned watching on (GNOME Shell), and the task that waits for it to leave the bus.
    watched_by: Option<(OwnedUniqueName, AbortHandle)>,
}

/// Runs forever, keeping `iface` in sync with the active player and acting on its `wished`.
pub async fn watch(
    conn: Connection,
    iface: InterfaceRef<MediaService>,
    mut wished: Wishes,
) -> anyhow::Result<()> {
    let dbus = DBusProxy::new(&conn).await?;
    // Subscribe before listing, so no player can slip in between; only players' names, not every app's.
    let owners_rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.freedesktop.DBus")?
        .interface("org.freedesktop.DBus")?
        .member("NameOwnerChanged")?
        .arg0ns(NAME_PREFIX.trim_end_matches('.'))?
        .build();
    let mut owners = MessageStream::for_match_rule(owners_rule, &conn, None).await?;
    let (events, mut received) = mpsc::unbounded_channel();
    let mut watcher = Watcher {
        conn,
        iface,
        players: HashMap::new(),
        play_counter: 0,
        events,
        downloading_art: None,
        failed_art: HashMap::new(),
        art_found: None,
        lyrics_query: None,
        lyrics_lookup: 0,
        lyrics_failures: 0,
        gap: GapBridge::default(),
        gap_check: None,
        chosen: None,
        lyrics_online: None,
        lyrics_waiting: false,
        watching: false,
        polled_at: None,
        poll_failed: false,
        polling: None,
        watched_by: None,
    };

    for name in dbus.list_names().await? {
        if is_player(name.as_str()) {
            watcher.add(name).await;
        }
    }
    watcher.publish().await;

    loop {
        // No timer at all unless the island shows a playing song.
        let poll = watcher.next_poll();
        tokio::select! {
            () = tokio::time::sleep_until(poll.unwrap_or_else(Instant::now)), if poll.is_some() => {
                // Nothing to publish until it is read.
                watcher.poll();
                continue;
            }
            Some(Ok(signal)) = owners.next() => {
                let Ok((name, _old, new)) = signal.body().deserialize::<(String, String, String)>()
                else {
                    continue;
                };
                if !is_player(&name) {
                    continue;
                }
                let Ok(name) = OwnedBusName::try_from(name) else { continue };
                watcher.players.remove(&name);
                if !new.is_empty() {
                    watcher.add(name).await;
                }
            }
            Some(wish) = wished.recv() => watcher.wish(wish),
            Some(event) = received.recv() => match event {
                Event::Player { name, seeked } => watcher.refresh(&name, seeked).await,
                Event::LengthRetry(name) => {
                    if let Some(entry) = watcher.players.get_mut(&name) {
                        entry.length_waiting = false;
                    }
                    watcher.refresh(&name, None).await;
                }
                Event::ArtDone { url, ok } => watcher.art_done(url, ok),
                Event::Lyrics { lookup, lyrics } => {
                    watcher.lyrics_done(lookup, lyrics).await;
                    continue;
                }
                Event::RetryLyrics { lookup } => {
                    watcher.retry_lyrics(lookup);
                    continue;
                }
                Event::GapOver => watcher.gap_check = None,
                Event::Polled { name, read } => watcher.polled(&name, read),
                Event::WatcherGone(name) => watcher.watcher_gone(&name),
            },
            else => return Ok(()),
        }
        watcher.publish().await;
    }
}

/// The player to show: the one picked by hand while it has something to show, else one with a track
/// (playing first), else the one playing, else the one that played last (each with when it started).
fn pick<'a, N: PartialEq + 'a>(
    players: impl Iterator<Item = (&'a N, &'a Snapshot, u64)> + Clone,
    chosen: Option<&N>,
) -> Option<&'a N> {
    if let Some((name, ..)) = players
        .clone()
        .find(|&(name, snapshot, _)| Some(name) == chosen && shows(snapshot))
    {
        return Some(name);
    }
    // A player stopped with nothing in it never hides a paused song.
    players
        .max_by_key(|&(_, s, started)| {
            let track = s.status != "Stopped" && shows(s);
            (track, s.status == "Playing", started)
        })
        .map(|(name, ..)| name)
}

/// Whether the island has anything to show for a player: with no title, it says "Nothing playing".
fn shows(snapshot: &Snapshot) -> bool {
    !snapshot.title.is_empty()
}

/// An MPRIS name, but not playerctld's copies of other players.
fn is_player(name: &str) -> bool {
    name.starts_with(NAME_PREFIX) && !IGNORED.contains(&name)
}

/// Awaits a call to a player, giving up after [`PLAYER_TIMEOUT`].
pub(super) async fn bounded<T, E: From<zbus::Error>>(
    call: impl Future<Output = Result<T, E>>,
) -> Result<T, E> {
    tokio::time::timeout(PLAYER_TIMEOUT, call)
        .await
        .unwrap_or_else(|_| {
            let err = zbus::Error::Failure("the media player did not answer in time".into());
            Err(err.into())
        })
}

/// Tells the watcher once `name` (a unique name, never owned again) has left the bus.
async fn left_bus(conn: Connection, name: OwnedUniqueName, events: mpsc::UnboundedSender<Event>) {
    let Ok(dbus) = DBusProxy::new(&conn).await else {
        return;
    };
    let Ok(mut changes) = dbus
        .receive_name_owner_changed_with_args(&[(0, name.as_str())])
        .await
    else {
        return;
    };
    // Subscribed first: it can't slip away between the two.
    let there = dbus.name_has_owner(BusName::from(name.as_ref())).await;
    if there.unwrap_or(true) {
        while let Some(change) = changes.next().await {
            if change.args().is_ok_and(|args| args.new_owner().is_none()) {
                break;
            }
        }
    }
    let _ = events.send(Event::WatcherGone(name));
}

impl Watcher {
    /// Starts watching a player that appeared, and reads it once.
    async fn add(&mut self, name: OwnedBusName) {
        match self.connect(name.clone()).await {
            Ok(entry) => {
                debug!("found media player {name}");
                self.players.insert(name.clone(), entry);
                self.refresh(&name, None).await;
            }
            Err(err) => warn!("could not watch media player {name}: {err}"),
        }
    }

    /// Reads the player's name and app, and listens for its changes in bursts.
    async fn connect(&self, name: OwnedBusName) -> zbus::Result<Entry> {
        let player = PlayerProxy::builder(&self.conn)
            .destination(name.clone())?
            .cache_properties(CacheProperties::No)
            .build()
            .await?;
        let properties = PropertiesProxy::builder(&self.conn)
            .destination(name.clone())?
            .path(OBJECT_PATH)?
            .cache_properties(CacheProperties::No)
            .build()
            .await?;

        let app =
            bounded(properties.get_all(InterfaceName::from_static_str_unchecked(APP_INTERFACE)))
                .await
                .unwrap_or_default();
        let identity = app
            .get("Identity")
            .and_then(|v| string(v))
            .unwrap_or_default();
        let desktop_entry = app
            .get("DesktopEntry")
            .and_then(|v| string(v))
            .unwrap_or_default();
        let browser = is_browser(&[name.as_str(), &identity, &desktop_entry]);

        // Only the player's own properties: Identity and the like are read once, above.
        let mut changed = properties
            .receive_properties_changed_with_args(&[(0, PLAYER_INTERFACE)])
            .await?;
        let mut seeked = player.receive_seeked().await?;
        let events = self.events.clone();
        let listener = tokio::spawn(async move {
            // Firefox reports Position as 0 after a seek, but the Seeked signal carries the real one.
            let mut seek_to: Option<i64> = None;
            loop {
                tokio::select! {
                    Some(_) = changed.next() => {}
                    Some(signal) = seeked.next() => {
                        if let Ok(args) = signal.args() {
                            seek_to = Some(args.position);
                        }
                    }
                    else => break,
                }
                // The rest of a burst comes with it, and the player is read once.
                let quiet = tokio::time::sleep(BURST);
                tokio::pin!(quiet);
                loop {
                    tokio::select! {
                        () = &mut quiet => break,
                        Some(_) = changed.next() => {}
                        Some(signal) = seeked.next() => {
                            if let Ok(args) = signal.args() {
                                seek_to = Some(args.position);
                            }
                        }
                    }
                }
                let seeked_us = seek_to.take();
                if events
                    .send(Event::Player {
                        name: name.clone(),
                        seeked: seeked_us,
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .abort_handle();

        Ok(Entry {
            player,
            properties,
            identity,
            desktop_entry,
            browser,
            snapshot: Snapshot::default(),
            started_playing: 0,
            listener,
            length_tries: 0,
            length_waiting: false,
        })
    }

    /// Reads a player again; one that just started playing takes over from a hand-picked one.
    /// `seeked` is the position from a `Seeked` in this burst, which wins over the property read.
    async fn refresh(&mut self, name: &OwnedBusName, seeked: Option<i64>) {
        self.read(name, seeked, false).await;
    }

    /// When the active player is next read for the island, if it is (see `MediaService::set_watching`).
    fn next_poll(&self) -> Option<Instant> {
        // One read at a time for it; another player taking over is read at once.
        if self.polling.is_some() && self.polling.as_ref() == self.active_name() {
            return None;
        }
        let active = self.active().map(|entry| &entry.snapshot);
        poll_due(self.watching, active, self.polled_at, self.poll_failed)
    }

    /// Reads the active player for the island in a task of its own; `polled` takes what it read.
    fn poll(&mut self) {
        let Some(name) = self.active_name().cloned() else {
            return;
        };
        let Some(entry) = self.players.get(&name) else {
            return;
        };
        let properties = entry.properties.clone();
        let events = self.events.clone();
        self.polling = Some(name.clone());
        tokio::spawn(async move {
            let interface = InterfaceName::from_static_str_unchecked(PLAYER_INTERFACE);
            let read = bounded(properties.get_all(interface)).await;
            let read = read
                .map(|all| Box::new(snapshot(&all)))
                .map_err(|err| err.to_string());
            let _ = events.send(Event::Polled { name, read });
        });
    }

    /// Takes a poll's read; one that failed waits [`POLL_FAILED`] for the next.
    fn polled(&mut self, name: &OwnedBusName, read: Result<Box<Snapshot>, String>) {
        if self.polling.as_ref() == Some(name) {
            self.polling = None;
        }
        let failed = match read {
            Ok(read) => !self.take(name, *read, None, true),
            Err(err) => {
                debug!("could not read {name}: {err}");
                true
            }
        };
        // Timed by the player shown: another may have taken over while this one hung.
        if self.active_name() == Some(name) {
            self.polled_at = Some(Instant::now());
            self.poll_failed = failed;
        }
    }

    /// Turns watching on or off for `by`, and stops it once `by` leaves the bus.
    fn set_watching(&mut self, watching: bool, by: Option<OwnedUniqueName>) {
        self.watching = watching;
        self.polled_at = None;
        let by = by.filter(|_| watching);
        if self.watched_by.as_ref().map(|(name, _)| name) == by.as_ref() {
            return;
        }
        if let Some((_, task)) = self.watched_by.take() {
            task.abort();
        }
        if let Some(name) = by {
            let task = tokio::spawn(left_bus(
                self.conn.clone(),
                name.clone(),
                self.events.clone(),
            ));
            self.watched_by = Some((name, task.abort_handle()));
        }
    }

    /// `name` left the bus: watching stops, unless someone else turned it on since.
    fn watcher_gone(&mut self, name: &OwnedUniqueName) {
        if self.watched_by.as_ref().is_some_and(|(by, _)| by == name) {
            debug!("{name} left while watching: polls stop");
            self.watched_by = None;
            self.watching = false;
        }
    }

    /// As `refresh`; `polled` for a read nothing announced, and whether the player answered.
    async fn read(&mut self, name: &OwnedBusName, seeked: Option<i64>, polled: bool) -> bool {
        let Some(entry) = self.players.get_mut(name) else {
            return false;
        };
        let all = bounded(
            entry
                .properties
                .get_all(InterfaceName::from_static_str_unchecked(PLAYER_INTERFACE)),
        )
        .await;
        match all {
            Ok(all) => self.take(name, snapshot(&all), seeked, polled),
            Err(err) => {
                debug!("could not read {name}: {err}");
                false
            }
        }
    }

    /// Folds what was `read` of player `name` into what it is believed to be doing; false if it left.
    fn take(
        &mut self,
        name: &OwnedBusName,
        read: Snapshot,
        seeked: Option<i64>,
        polled: bool,
    ) -> bool {
        let Some(entry) = self.players.get_mut(name) else {
            return false;
        };
        let previous = entry.snapshot.clone();
        let same = same_track(&previous, &read);
        let snapshot = reconcile(&previous, read, same, seeked, entry.browser, polled);
        if snapshot.status == "Playing" && previous.status != "Playing" {
            self.play_counter += 1;
            entry.started_playing = self.play_counter;
            // Another player started: the one picked by hand gives way.
            if self.chosen.as_ref().is_some_and(|chosen| chosen != name) {
                self.chosen = None;
            }
        }
        if !same {
            entry.length_tries = 0;
            entry.length_waiting = false;
        }
        let needs_length = snapshot.status == "Playing" && snapshot.length_us <= 0;
        if !needs_length {
            entry.length_tries = 0;
        }
        entry.snapshot = snapshot;
        if needs_length {
            self.schedule_length_retry(name);
        }
        true
    }

    /// Reads the player again soon when it is playing and still has no length.
    /// Firefox often sends the duration a moment after playback starts, without another signal worth trusting.
    fn schedule_length_retry(&mut self, name: &OwnedBusName) {
        let Some(entry) = self.players.get_mut(name) else {
            return;
        };
        if entry.length_waiting || entry.length_tries >= 2 {
            return;
        }
        entry.length_waiting = true;
        entry.length_tries += 1;
        let delay = Duration::from_secs(if entry.length_tries == 1 { 1 } else { 3 });
        let events = self.events.clone();
        let name = name.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = events.send(Event::LengthRetry(name));
        });
    }

    /// The player picked by hand, else the one that is playing, else the one that played most recently.
    fn active(&self) -> Option<&Entry> {
        self.active_name().and_then(|name| self.players.get(name))
    }

    /// The bus name of the player to show (see `pick`).
    fn active_name(&self) -> Option<&OwnedBusName> {
        let players = self
            .players
            .iter()
            .map(|(name, entry)| (name, &entry.snapshot, entry.started_playing));
        pick(players, self.chosen.as_ref())
    }

    /// What the user asked for in the island: a player picked, or lyrics turned on or off.
    fn wish(&mut self, wish: Wish) {
        match wish {
            Wish::Player(name) => {
                self.chosen = OwnedBusName::try_from(name)
                    .ok()
                    .filter(|name| self.players.contains_key(name));
            }
            Wish::Lyrics(online) if Some(online) != self.lyrics_online => {
                self.lyrics_online = Some(online);
                // The next publish looks them up at once (or puts them away) for the current track.
                self.lyrics_query = None;
                self.lyrics_lookup += 1;
            }
            Wish::Lyrics(_) => {}
            Wish::Watching(watching, by) => self.set_watching(watching, by),
        }
    }

    /// The players with something to show, for picking one; empty with fewer than two.
    /// An idle one (Rhythmbox stopped, `mpv --idle`) would show "Nothing playing" and no way back.
    fn choices(&self) -> Vec<PlayerChoice> {
        let active = self.active_name();
        let mut choices: Vec<PlayerChoice> = self
            .players
            .iter()
            .filter(|(_, entry)| shows(&entry.snapshot))
            .map(|(name, entry)| PlayerChoice {
                name: name.to_string(),
                identity: entry.identity.clone(),
                desktop_entry: entry.desktop_entry.clone(),
                playing: entry.snapshot.status == "Playing",
                active: Some(name) == active,
            })
            .collect();
        if choices.len() < 2 {
            return Vec::new();
        }
        choices.sort_by(|a, b| a.identity.cmp(&b.identity).then(a.name.cmp(&b.name)));
        choices
    }

    /// Sends the active player, the player list and lyrics to the extension, when they changed.
    async fn publish(&mut self) {
        let (art_url, length_coming) = match self.active() {
            Some(entry) => (Some(entry.snapshot.art_url.clone()), entry.length_waiting),
            None => (None, false),
        };
        let art_path = art_url.map(|url| self.art_path(url)).unwrap_or_default();
        let (now_playing, active) = match self.active() {
            Some(entry) => {
                let s = &entry.snapshot;
                let now_playing = NowPlaying {
                    available: true,
                    identity: entry.identity.clone(),
                    desktop_entry: entry.desktop_entry.clone(),
                    status: s.status.clone(),
                    title: s.title.clone(),
                    artist: s.artist.clone(),
                    album: s.album.clone(),
                    art_path,
                    length_us: s.length_us,
                    position_us: s.position_us,
                    sampled_at_ms: s.sampled_at_ms,
                    rate: s.rate,
                    can_go_next: s.can_go_next,
                    can_go_previous: s.can_go_previous,
                    can_play_pause: s.can_play_pause,
                    can_seek: s.can_seek,
                };
                let art_url = s.art_url.clone();
                let active = (entry.player.clone(), s.track_id.clone());
                if now_playing.art_path.is_empty() && art::is_remote(&art_url) {
                    self.download_art(art_url);
                }
                (now_playing, Some(active))
            }
            None => (NowPlaying::default(), None),
        };
        let (now_playing, active, gap_ends) = self.gap.show(now_playing, active, Instant::now());
        if let Some(at) = gap_ends {
            self.check_gap_at(at);
        }

        let query = (!now_playing.title.is_empty()).then(|| TrackQuery {
            title: now_playing.title.clone(),
            artist: now_playing.artist.clone(),
            album: now_playing.album.clone(),
            length_s: now_playing.length_us as f64 / 1e6,
        });
        self.load_lyrics(query, length_coming).await;

        let choices = self.choices();
        let mut service = self.iface.get_mut().await;
        service.active = active;
        if service.players != choices {
            service.players = choices;
            if let Err(err) = service.players_changed(self.iface.signal_emitter()).await {
                warn!("could not publish the players: {err}");
            }
        }
        if !service.now_playing.continues_as(&now_playing) {
            service.now_playing = now_playing;
            if let Err(err) = service
                .now_playing_changed(self.iface.signal_emitter())
                .await
            {
                warn!("could not publish now playing: {err}");
            }
        }
    }

    /// Where the art at `url` is on disk, or empty while it is not (yet).
    fn art_path(&mut self, url: String) -> String {
        if let Some((found, path)) = &self.art_found
            && *found == url
        {
            return path.clone();
        }
        let Some(path) = art::local_path(&url) else {
            return String::new();
        };
        self.art_found = Some((url, path.clone()));
        path
    }

    /// Publishes again at `at`, when a gap between songs stops being bridged.
    fn check_gap_at(&mut self, at: Instant) {
        if self.gap_check == Some(at) {
            return;
        }
        self.gap_check = Some(at);
        let events = self.events.clone();
        tokio::spawn(async move {
            tokio::time::sleep_until(at).await;
            let _ = events.send(Event::GapOver);
        });
    }

    /// Downloads remote cover art in the background, once at a time and not again soon after a failure.
    fn download_art(&mut self, url: String) {
        if self.downloading_art.as_ref() == Some(&url)
            || self
                .failed_art
                .get(&url)
                .is_some_and(|failed| failed.elapsed() < ART_RETRY)
        {
            return;
        }
        self.downloading_art = Some(url.clone());
        let events = self.events.clone();
        tokio::task::spawn_blocking(move || {
            let result = art::download(&url);
            if let Err(err) = &result {
                debug!("could not download cover art {url}: {err}");
            }
            let ok = result.is_ok();
            let _ = events.send(Event::ArtDone { url, ok });
        });
    }

    /// Notes how a download went, so a dead link waits [`ART_RETRY`].
    fn art_done(&mut self, url: String, ok: bool) {
        if self.downloading_art.as_ref() == Some(&url) {
            self.downloading_art = None;
        }
        // Expired entries go here, which keeps the map from growing.
        self.failed_art
            .retain(|_, failed| failed.elapsed() < ART_RETRY);
        if ok {
            self.failed_art.remove(&url);
        } else {
            self.failed_art.insert(url, Instant::now());
        }
    }

    /// Starts loading lyrics when the track changes, or once what they wait on is in (see [`lyrics_step`]).
    async fn load_lyrics(&mut self, query: Option<TrackQuery>, length_coming: bool) {
        let key = query.as_ref().map(TrackQuery::key);
        if key == self.lyrics_query.as_ref().map(TrackQuery::key) && !self.lyrics_waiting {
            return;
        }
        self.lyrics_query = query.clone();
        self.lyrics_failures = 0;
        self.lyrics_waiting = false;
        let Some(query) = query else {
            // Forget any lookup still running for the previous track.
            self.lyrics_lookup += 1;
            self.set_lyrics(Lyrics::default()).await;
            return;
        };
        match lyrics_step(self.lyrics_online, &query, length_coming) {
            LyricsStep::Off => {
                self.lyrics_lookup += 1;
                self.set_lyrics(query.status(LyricsStatus::Off)).await;
            }
            LyricsStep::Wait => {
                self.lyrics_lookup += 1;
                self.lyrics_waiting = true;
                self.set_lyrics(query.status(LyricsStatus::Loading)).await;
            }
            LyricsStep::Fetch => {
                self.set_lyrics(query.status(LyricsStatus::Loading)).await;
                self.fetch_lyrics(query);
            }
        }
    }

    /// Looks lyrics up off the async threads, under a new lookup number.
    fn fetch_lyrics(&mut self, query: TrackQuery) {
        self.lyrics_lookup += 1;
        let lookup = self.lyrics_lookup;
        let events = self.events.clone();
        tokio::task::spawn_blocking(move || {
            let lyrics = lyrics::fetch(&query);
            let _ = events.send(Event::Lyrics { lookup, lyrics });
        });
    }

    /// Shows a lookup's result and schedules a retry if it failed (offline, LRCLIB busy).
    /// A track that simply has no lyrics is not retried until it next starts.
    async fn lyrics_done(&mut self, lookup: u64, lyrics: Lyrics) {
        if lookup != self.lyrics_lookup {
            return;
        }
        if lyrics.status.is_failure() {
            let delay = LYRICS_RETRY
                .saturating_mul(1 << self.lyrics_failures.min(8))
                .min(LYRICS_RETRY_MAX);
            self.lyrics_failures += 1;
            let events = self.events.clone();
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                let _ = events.send(Event::RetryLyrics { lookup });
            });
        }
        self.set_lyrics(lyrics).await;
    }

    /// Looks the lyrics up again, unless the track has changed since.
    fn retry_lyrics(&mut self, lookup: u64) {
        if lookup != self.lyrics_lookup {
            return;
        }
        if let Some(query) = self.lyrics_query.clone() {
            // The failed state stays on screen until the new result is in.
            self.fetch_lyrics(query);
        }
    }

    /// Publishes lyrics that still belong to the current track.
    async fn set_lyrics(&self, lyrics: Lyrics) {
        // Drop results for a track that is no longer playing.
        if lyrics.status != LyricsStatus::None
            && self.lyrics_query.as_ref().map(TrackQuery::key).as_ref() != Some(&lyrics.track)
        {
            return;
        }
        let mut service = self.iface.get_mut().await;
        if service.lyrics != lyrics {
            service.lyrics = lyrics;
            if let Err(err) = service.lyrics_changed(self.iface.signal_emitter()).await {
                warn!("could not publish lyrics: {err}");
            }
        }
    }
}

/// When to read the `active` player for the island: at once when watching starts (even paused, for a seek
/// made meanwhile), then every [`POLL`] while it plays; never while not `watching`.
fn poll_due(
    watching: bool,
    active: Option<&Snapshot>,
    polled_at: Option<Instant>,
    failed: bool,
) -> Option<Instant> {
    let active = active.filter(|_| watching)?;
    let Some(polled_at) = polled_at else {
        return Some(Instant::now());
    };
    if active.status != "Playing" {
        return None;
    }
    let wait = if failed {
        POLL_FAILED
    } else if (active.doubt.is_some() && active.zeros < ZERO_POLLS) || active.pace.still {
        POLL_CONFIRM
    } else if active.pace.changing {
        POLL_MEASURE
    } else {
        POLL
    };
    Some(polled_at + wait)
}

/// What a track's lyrics do next.
#[derive(Debug, PartialEq)]
enum LyricsStep {
    /// Turned off in Settings: the lyrics say so.
    Off,
    /// Not told yet whether to look, or the length is still coming: shown as looking.
    Wait,
    Fetch,
}

/// The step for `query`. `online` is `None` until the extension says; `length_coming` while its player
/// is read again for it: Firefox sends it late, and a lookup without it would run twice.
fn lyrics_step(online: Option<bool>, query: &TrackQuery, length_coming: bool) -> LyricsStep {
    match online {
        Some(false) => LyricsStep::Off,
        Some(true) if !length_coming || query.length_s > 0.0 => LyricsStep::Fetch,
        _ => LyricsStep::Wait,
    }
}

/// Reads what Isle shows from a player's `GetAll` reply, with safe defaults for what is missing.
fn snapshot(all: &HashMap<String, OwnedValue>) -> Snapshot {
    let get = |key: &str| all.get(key).map(|value| &**value);
    let flag = |key: &str| get(key).and_then(boolean).unwrap_or(false);

    let metadata: HashMap<String, &Value> = match get("Metadata") {
        Some(Value::Dict(dict)) => dict
            .iter()
            .filter_map(|(key, value)| Some((string(key)?, unwrap_variant(value))))
            .collect(),
        _ => HashMap::new(),
    };
    let meta = |key: &str| metadata.get(key).copied();
    let position = get("Position").and_then(integer);

    Snapshot {
        status: get("PlaybackStatus")
            .and_then(string)
            .unwrap_or_else(|| "Stopped".into()),
        // A file with no title tag (a video in VLC) goes by its name, as the player shows it.
        title: meta("xesam:title")
            .and_then(string)
            .filter(|title| !title.trim().is_empty())
            .or_else(|| {
                meta("xesam:url")
                    .and_then(string)
                    .and_then(|url| file_title(&url))
            })
            .unwrap_or_default(),
        artist: meta("xesam:artist")
            .map(strings)
            .unwrap_or_default()
            .join(", "),
        album: meta("xesam:album").and_then(string).unwrap_or_default(),
        art_url: meta("mpris:artUrl").and_then(string).unwrap_or_default(),
        track_id: meta("mpris:trackid").and_then(|value| match value {
            Value::ObjectPath(path) => Some(path.clone().into()),
            // Some players send the id as a plain string.
            other => string(other).and_then(|s| OwnedObjectPath::try_from(s).ok()),
        }),
        length_us: meta("mpris:length").and_then(integer).unwrap_or(0),
        position_us: position.unwrap_or(0),
        position_known: position.is_some(),
        sampled_at_ms: now_ms(),
        rate: get("Rate").and_then(float).unwrap_or(1.0),
        can_go_next: flag("CanGoNext"),
        can_go_previous: flag("CanGoPrevious"),
        can_play_pause: flag("CanPause") || flag("CanPlay"),
        can_seek: flag("CanSeek"),
        doubt: None,
        pace: Pace::default(),
        whole: 0,
        zeros: 0,
    }
}

/// The value inside any number of nested variants.
fn unwrap_variant<'a>(value: &'a Value<'a>) -> &'a Value<'a> {
    match value {
        Value::Value(inner) => unwrap_variant(inner),
        other => other,
    }
}

/// "Holiday clip" for `file:///…/Holiday%20clip.mp4`; `None` for a stream or a page.
fn file_title(url: &str) -> Option<String> {
    let path = crate::uri::to_path(url)?;
    let stem = path.file_stem()?.to_string_lossy().into_owned();
    (!stem.trim().is_empty()).then_some(stem)
}

/// A string or object path, as players send either.
fn string(value: &Value<'_>) -> Option<String> {
    match unwrap_variant(value) {
        Value::Str(s) => Some(s.to_string()),
        Value::ObjectPath(path) => Some(path.to_string()),
        _ => None,
    }
}

/// A list of strings; a lone string counts as a list of one.
fn strings(value: &Value<'_>) -> Vec<String> {
    match unwrap_variant(value) {
        Value::Array(array) => array.iter().filter_map(string).collect(),
        other => string(other).into_iter().collect(),
    }
}

/// Any integer type a player might use, or a float cut down.
fn integer(value: &Value<'_>) -> Option<i64> {
    match unwrap_variant(value) {
        Value::I64(n) => Some(*n),
        Value::U64(n) => i64::try_from(*n).ok(),
        Value::I32(n) => Some(i64::from(*n)),
        Value::U32(n) => Some(i64::from(*n)),
        Value::F64(n) => Some(*n as i64),
        // Firefox has sent the length as a string of digits.
        Value::Str(text) => text
            .parse::<i64>()
            .ok()
            .or_else(|| text.parse::<f64>().ok().map(|n| n as i64)),
        _ => None,
    }
}

/// A reported position this far behind the one already tracked may be a stale read rather than a seek.
const STALE_BEHIND_US: f64 = 1_500_000.0;

/// Browsers, whose media reads are stale at times; other players' reads are taken as they come.
const BROWSERS: &[&str] = &[
    "firefox",
    "zen",
    "chrom",
    "brave",
    "edge",
    "vivaldi",
    "opera",
    "epiphany",
    "librewolf",
    "floorp",
    "waterfox",
    "mullvad",
    "icecat",
];

/// Whether a player is a web browser, by its bus name, identity or desktop entry.
fn is_browser(names: &[&str]) -> bool {
    names.iter().any(|name| {
        let name = name.to_lowercase();
        BROWSERS.iter().any(|browser| name.contains(browser))
    })
}

/// The same media: the track id when both have one, and the title and artist. Firefox gives every
/// video one track id, and Chromium "NoTrack" when a page sets none: the title tells them apart.
fn same_track(previous: &Snapshot, next: &Snapshot) -> bool {
    let titled = |snapshot: &Snapshot| !snapshot.title.is_empty();
    let same_title = previous.title == next.title && previous.artist == next.artist;
    match (&previous.track_id, &next.track_id) {
        (Some(before), Some(after)) => {
            before == after && (!titled(previous) || !titled(next) || same_title)
        }
        _ => titled(previous) && same_title,
    }
}

/// Folds a fresh read (of the `same` track or not) into the trusted sample. `Seeked` always wins; going back
/// is a restart, but a `browser`'s 0 is passed over, and its lag or a `polled` 0 waits for the next read.
fn reconcile(
    previous: &Snapshot,
    mut next: Snapshot,
    same: bool,
    seeked_us: Option<i64>,
    browser: bool,
    polled: bool,
) -> Snapshot {
    let whole = next.position_known && next.position_us > 0 && next.position_us % SECOND_US == 0;
    // A 0 or no read says nothing about how finely the player reads.
    next.whole = if whole {
        previous.whole.saturating_add(1)
    } else if next.position_known && next.position_us > 0 {
        0
    } else {
        previous.whole
    };
    // Zen and Firefox drop `mpris:length` after a seek.
    if next.length_us <= 0 && previous.length_us > 0 && same {
        next.length_us = previous.length_us;
    }
    // Chromium says 0 while it buffers, which stands; on resume it may still say a pause's 0 for a moment.
    let buffering = next.rate == 0.0 && same && previous.status == "Playing";
    if next.status == "Playing" && next.rate <= 0.0 && !buffering {
        next.rate = if previous.rate > 0.0 {
            previous.rate
        } else {
            1.0
        };
    }
    if let Some(position) = seeked_us {
        next.position_us = position.max(0);
        next.sampled_at_ms = now_ms();
        next.position_known = true;
        let read = (next.position_us, next.sampled_at_ms);
        let pace = Pace::start(read, next.rate);
        return paced(next, pace);
    }
    let running = |s: &Snapshot| s.status == "Playing" || s.status == "Paused";
    if !same || !running(previous) || !running(&next) {
        let pace = start_pace(&next);
        return paced(next, pace);
    }
    let read = (next.position_us, next.sampled_at_ms);
    // Rate 0 again, but moved on from the read before (at Rate 0 too) as playback does: it plays,
    // whatever it says, at the speed it moved (one near 1 taken as 1). A stall stays at 0.
    let at_rate_0 = previous.pace.from.is_some() && previous.pace.reported == 0.0;
    if buffering && at_rate_0 && previous.position_known && next.position_known {
        let from = (previous.position_us, previous.sampled_at_ms);
        let step = speed(from, read);
        if read.1 - from.1 >= CONFIRM_MIN_MS && PACE_RANGE.contains(&step) {
            next.rate = if (step - 1.0).abs() <= PACE_OFF {
                1.0
            } else {
                (step * 100.0).round() / 100.0
            };
            return paced(next, Pace::start(read, 0.0));
        }
    }
    // Where it is believed to be at this read; it moves only while playing.
    let elapsed_ms = if previous.status == "Playing" {
        (next.sampled_at_ms - previous.sampled_at_ms).max(0) as f64
    } else {
        0.0
    };
    let predicted = previous.position_us as f64 + elapsed_ms * previous.rate.max(0.0) * 1000.0;
    // Firefox reads whole seconds, cut down: playback is somewhere in the second after it.
    let coarse = whole && previous.whole >= COARSE_AFTER;
    let second = next.position_us as f64 - COARSE_SLACK_US
        ..=(next.position_us + SECOND_US) as f64 + COARSE_SLACK_US;
    if coarse && second.contains(&predicted) {
        // Where it was believed to be fits: kept, finer than the read.
        next.position_us = predicted as i64;
        let pace = carried(previous, &next);
        return paced(next, pace);
    }
    // A player that answers polls with 0 would otherwise restart the song every second.
    let doubtful = browser || (polled && next.position_us <= 0);
    let lagging = doubtful
        && next.position_known
        && previous.status == "Playing"
        && next.status == "Playing"
        && predicted - next.position_us as f64 > STALE_BEHIND_US;
    // A stall, or a seek nothing announced, if the read before fell behind as well and this one moved on
    // from it at a speed a player plays at. A browser's stale read stays put or jumps.
    let confirmed = lagging
        && previous
            .doubt
            .is_some_and(|doubt| plausible(doubt, read, coarse));
    // Unknown is no read. Zen and Firefox report 0 while playing and on pause or resume, and lag at times.
    let zero = browser && next.position_us <= 0;
    let stale = !next.position_known || zero || (lagging && !confirmed);
    // Past its end, the track has started over (on repeat): the read is right.
    let over = previous.length_us > 0 && predicted >= previous.length_us as f64;
    if stale && !over {
        let polled_zero = polled && next.position_known && next.position_us <= 0;
        next.zeros = if polled_zero {
            previous.zeros.saturating_add(1)
        } else {
            0
        };
        if lagging && !zero {
            // Too close to the last doubt to tell a speed from, it waits for a later read instead.
            let close = previous
                .doubt
                .is_some_and(|(_, at)| read.1 - at < CONFIRM_MIN_MS);
            next.doubt = if close { previous.doubt } else { Some(read) };
        }
        // Taken at this read's time, so a new rate counts only from now on.
        next.position_us = predicted as i64;
        next.position_known = previous.position_known;
        let pace = carried(previous, &next);
        return paced(next, pace);
    }
    if coarse {
        // Moved elsewhere (a seek nothing announced): the middle of its second. Too coarse to measure a speed.
        next.position_us += SECOND_US / 2;
        let pace = carried(previous, &next);
        return paced(next, pace);
    }
    let mut pace = if previous.status == "Playing" && next.status == "Playing" && !confirmed {
        previous.pace.step(read, next.rate)
    } else {
        start_pace(&next)
    };
    // Not where it was believed to be (a stall, a new speed): read again soon to see which.
    if previous.status == "Playing" && (next.position_us as f64 - predicted).abs() > OFF_US {
        pace.changing = true;
    }
    paced(next, pace)
}

/// The pace a read that is not measured from keeps: the one so far, unless the reported `Rate` changed.
fn carried(previous: &Snapshot, next: &Snapshot) -> Pace {
    if next.rate == previous.pace.reported {
        previous.pace.clone()
    } else {
        Pace::default()
    }
}

const SECOND_US: i64 = 1_000_000;
/// Whole-second reads in a row that tell a player reading only whole seconds (one in a million otherwise).
const COARSE_AFTER: u8 = 3;
/// Room around a whole-second read for the time the read itself took.
const COARSE_SLACK_US: f64 = 150_000.0;

/// A read this far from where playback was believed to be means it changed.
const OFF_US: f64 = 250_000.0;

/// Reads closer together than this say too little about the speed between them.
const PACE_MIN_STEP_MS: i64 = 400;
/// The speeds a player plays at; a read outside them from the one before stalled or jumped.
const PACE_RANGE: std::ops::RangeInclusive<f64> = 0.2..=4.5;
/// A step this far from the run's speed starts a new run.
const PACE_AGREE: f64 = 0.15;
/// Steps that must agree before their speed is used.
const PACE_STEPS: u32 = 2;
/// A measured speed this far from the reported `Rate` is used instead; closer, the `Rate` is.
const PACE_OFF: f64 = 0.08;
/// The speeds a measure is held to.
const PACE_CLAMP: (f64, f64) = (0.25, 4.0);
/// Slower than this between two reads, playback stands still (buffering) though the player says it plays.
const PACE_STILL: f64 = 0.05;

/// The speed a player's reads move at, for players whose `Rate` stays 1 while they play faster.
#[derive(Debug, Clone, Default, PartialEq)]
struct Pace {
    /// The run's first read and its latest, each as (position_us, sampled_at_ms).
    from: Option<(i64, i64)>,
    last: Option<(i64, i64)>,
    /// Steps since `from` that agree with the run's speed.
    steps: u32,
    /// The `Rate` reported during the run; another one starts over.
    reported: f64,
    /// The speed measured, while it differs from `reported`.
    measured: Option<f64>,
    /// The last two reads were at the same place: it plays at 0 until a read moves on.
    still: bool,
    /// The speed changed (or a read was off): it is read sooner, until measured again.
    changing: bool,
    /// The run starts at a speed change, and its first step may straddle it: measured from after it.
    turned: bool,
}

impl Pace {
    /// A run starting at `read`, with `reported` as the player's `Rate`.
    fn start(read: (i64, i64), reported: f64) -> Self {
        Self {
            from: Some(read),
            last: Some(read),
            reported,
            ..Self::default()
        }
    }

    /// The pace after one more real read while playing on. A stall or jump starts a new run, keeping
    /// what was measured: neither changes the speed.
    fn step(&self, read: (i64, i64), reported: f64) -> Self {
        let (Some(from), Some(last)) = (self.from, self.last) else {
            return Self::start(read, reported);
        };
        if reported != self.reported {
            return Self::start(read, reported);
        }
        if read.1 - last.1 < PACE_MIN_STEP_MS {
            // Too close to measure a speed, but not to see a stall end.
            if self.still && speed(last, read) >= *PACE_RANGE.start() {
                return Self {
                    measured: self.measured,
                    ..Self::start(read, reported)
                };
            }
            return self.clone();
        }
        let step = speed(last, read);
        if !PACE_RANGE.contains(&step) {
            return Self {
                measured: self.measured,
                still: step.abs() < PACE_STILL,
                ..Self::start(read, reported)
            };
        }
        let mut next = Self {
            last: Some(read),
            still: false,
            ..self.clone()
        };
        if from == last || (speed(from, read) - step).abs() <= PACE_AGREE {
            next.steps += 1;
        } else {
            // It changed speed at the read before: the new run counts from there.
            next.from = Some(last);
            next.steps = 1;
            next.changing = true;
            next.turned = true;
        }
        if next.steps >= PACE_STEPS {
            next.changing = false;
            if next.turned {
                // Confirmed: the step that told it, part old speed and part new, is left out.
                next.from = Some(last);
                next.turned = false;
            }
            let (low, high) = PACE_CLAMP;
            let measured = speed(next.from.unwrap_or(last), read).clamp(low, high);
            // Kept unless it moved: each change is published again, and it settles as the run grows.
            let moved = self
                .measured
                .is_none_or(|before| (measured - before).abs() > 0.008);
            next.measured = if (measured - reported).abs() <= PACE_OFF {
                None
            } else if moved {
                Some((measured * 100.0).round() / 100.0)
            } else {
                self.measured
            };
        }
        next
    }
}

/// The speed between two reads, each (position_us, sampled_at_ms), in seconds of media per second.
fn speed(from: (i64, i64), to: (i64, i64)) -> f64 {
    let elapsed_ms = (to.1 - from.1).max(1) as f64;
    (to.0 - from.0) as f64 / (elapsed_ms * 1000.0)
}

/// Reads closer together than this can't confirm one another.
const CONFIRM_MIN_MS: i64 = 300;

/// Whether `read` moved on from `doubt` the way playback does; a `coarse` one (whole seconds) by one or more.
fn plausible(doubt: (i64, i64), read: (i64, i64), coarse: bool) -> bool {
    if read.1 - doubt.1 < CONFIRM_MIN_MS {
        return false;
    }
    if !coarse {
        return PACE_RANGE.contains(&speed(doubt, read));
    }
    let moved = read.0 - doubt.0;
    let fastest = speed(doubt, (read.0 - SECOND_US, read.1));
    let slowest = speed(doubt, (read.0 + SECOND_US, read.1));
    moved > 0 && fastest <= *PACE_RANGE.end() && slowest >= *PACE_RANGE.start()
}

/// A run from `next`'s read, if it is one.
fn start_pace(next: &Snapshot) -> Pace {
    if next.position_known {
        Pace::start((next.position_us, next.sampled_at_ms), next.rate)
    } else {
        Pace::default()
    }
}

/// `next` with `pace`, playing at its measured speed if it has one (0 while it stands still).
fn paced(mut next: Snapshot, pace: Pace) -> Snapshot {
    if pace.reported == next.rate && next.status == "Playing" {
        if pace.still {
            next.rate = 0.0;
        } else if let Some(measured) = pace.measured {
            next.rate = measured;
        }
    }
    next.pace = pace;
    next
}

/// A float, or an integer some players send for the rate.
fn float(value: &Value<'_>) -> Option<f64> {
    match unwrap_variant(value) {
        Value::F64(n) => Some(*n),
        other => integer(other).map(|n| n as f64),
    }
}

/// A plain boolean.
fn boolean(value: &Value<'_>) -> Option<bool> {
    match unwrap_variant(value) {
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::Instant;

    use super::{LyricsStep, Snapshot, TrackQuery, file_title, lyrics_step, pick};

    /// Each as (name, status, title, when it last started playing).
    const PLAYERS: [(&str, &str, &str, u64); 3] = [
        ("spotify", "Paused", "Song", 3),
        ("firefox", "Playing", "Video", 5),
        ("mpv", "Playing", "Film", 4),
    ];

    fn pick_among(
        players: &[(&'static str, &str, &str, u64)],
        chosen: Option<&'static str>,
    ) -> Option<&'static str> {
        let players: Vec<_> = players
            .iter()
            .map(|&(name, status, title, started)| {
                let snapshot = Snapshot {
                    status: status.into(),
                    title: title.into(),
                    ..Snapshot::default()
                };
                (name, snapshot, started)
            })
            .collect();
        let players = players.iter().map(|(name, s, started)| (name, s, *started));
        pick(players, chosen.as_ref()).copied()
    }

    fn shot(title: &str, position_us: i64, sampled_at_ms: i64, length_us: i64) -> Snapshot {
        Snapshot {
            status: "Playing".into(),
            title: title.into(),
            position_us,
            sampled_at_ms,
            length_us,
            rate: 1.0,
            position_known: true,
            ..Snapshot::default()
        }
    }

    /// `reconcile` as `refresh` calls it.
    fn fold(
        previous: &Snapshot,
        next: Snapshot,
        seeked_us: Option<i64>,
        browser: bool,
    ) -> Snapshot {
        let same = super::same_track(previous, &next);
        super::reconcile(previous, next, same, seeked_us, browser, false)
    }

    #[test]
    fn a_real_position_replaces_the_sample() {
        let previous = shot("Song", 30_000_000, 1_000, 180_000_000);
        let next = shot("Song", 32_000_000, 3_000, 180_000_000);
        let got = fold(&previous, next, None, true);
        assert_eq!(got.position_us, 32_000_000);
        assert_eq!(got.sampled_at_ms, 3_000);
    }

    #[test]
    fn a_zero_while_playing_does_not_rewind() {
        let previous = shot("Song", 30_000_000, 1_000, 180_000_000);
        let mut next = shot("Song", 0, 5_000, 0);
        next.position_known = true;
        let got = fold(&previous, next, None, true);
        // Four seconds on from 30 s, taken at the new read's time.
        assert_eq!(got.position_us, 34_000_000);
        assert_eq!(got.sampled_at_ms, 5_000);
        assert_eq!(got.length_us, 180_000_000);
    }

    #[test]
    fn seeked_wins_over_a_following_zero() {
        let previous = shot("Song", 30_000_000, 1_000, 180_000_000);
        let next = shot("Song", 0, 5_000, 0);
        let got = fold(&previous, next, Some(90_000_000), true);
        assert_eq!(got.position_us, 90_000_000);
        assert!(got.sampled_at_ms >= 5_000);
        assert_eq!(got.length_us, 180_000_000);
    }

    #[test]
    fn a_players_restart_is_taken_as_it_comes() {
        // Repeat one: the same 20 s track starts over at 10 s, with no `Seeked`.
        let previous = shot("Song", 9_000_000, 1_000, 20_000_000);
        let next = shot("Song", 2_000_000, 4_000, 20_000_000);
        let got = fold(&previous, next.clone(), None, false);
        assert_eq!((got.position_us, got.sampled_at_ms), (2_000_000, 4_000));
        // A browser's read that falls behind is a stale one: 9 s and three more.
        let got = fold(&previous, next, None, true);
        assert_eq!((got.position_us, got.sampled_at_ms), (12_000_000, 4_000));
    }

    #[test]
    fn a_browsers_zero_on_pause_and_resume_keeps_the_place() {
        let playing = shot("Song", 30_000_000, 1_000, 180_000_000);
        let paused = Snapshot {
            status: "Paused".into(),
            ..shot("Song", 0, 5_000, 180_000_000)
        };
        let got = fold(&playing, paused.clone(), None, true);
        assert_eq!((got.position_us, got.sampled_at_ms), (34_000_000, 5_000));
        // Resumed a minute later: still where it was paused.
        let resumed = shot("Song", 0, 65_000, 180_000_000);
        let got = fold(&got, resumed.clone(), None, true);
        assert_eq!((got.position_us, got.sampled_at_ms), (34_000_000, 65_000));
        assert_eq!(got.status, "Playing");
        // A paused read with no position at all, from any player, is no read either.
        let unknown = Snapshot {
            position_known: false,
            ..paused
        };
        let got = fold(&playing, unknown, None, false);
        assert_eq!(got.position_us, 34_000_000);
        // A player's own 0 on resume is where it is.
        let paused_at = Snapshot {
            status: "Paused".into(),
            ..shot("Song", 34_000_000, 5_000, 180_000_000)
        };
        assert_eq!(fold(&paused_at, resumed, None, false).position_us, 0);
    }

    #[test]
    fn a_new_rate_counts_from_the_read_that_brings_it() {
        let previous = shot("Song", 30_000_000, 1_000, 180_000_000);
        let faster = Snapshot {
            rate: 2.0,
            ..shot("Song", 0, 5_000, 180_000_000)
        };
        let got = fold(&previous, faster, None, true);
        // The four seconds before it went at the old speed.
        assert_eq!((got.position_us, got.sampled_at_ms), (34_000_000, 5_000));
        assert_eq!(got.rate, 2.0);
    }

    #[test]
    fn a_browser_starting_over_from_stopped_is_at_0() {
        let stopped = Snapshot {
            status: "Stopped".into(),
            ..shot("Clip", 20_000_000, 1_000, 20_000_000)
        };
        let got = fold(&stopped, shot("Clip", 0, 3_000, 20_000_000), None, true);
        assert_eq!(got.position_us, 0);
    }

    #[test]
    fn past_its_end_a_track_has_started_over() {
        // A video on loop in a browser: the tracked position ran past the end.
        let previous = shot("Clip", 18_000_000, 1_000, 20_000_000);
        let next = shot("Clip", 3_000_000, 6_000, 20_000_000);
        let got = fold(&previous, next, None, true);
        assert_eq!(got.position_us, 3_000_000);
    }

    #[test]
    fn a_browsers_zero_is_passed_over_and_a_players_is_a_restart() {
        let previous = shot("Song", 30_000_000, 1_000, 180_000_000);
        let next = shot("Song", 0, 5_000, 180_000_000);
        let got = fold(&previous, next.clone(), None, true);
        assert_eq!(got.position_us, 34_000_000);
        // Previous, pressed in the player itself: back to the start.
        let got = fold(&previous, next, None, false);
        assert_eq!((got.position_us, got.sampled_at_ms), (0, 5_000));
    }

    #[test]
    fn another_video_under_firefoxs_one_track_id_is_another_track() {
        let id = zbus::zvariant::OwnedObjectPath::try_from("/org/mpris/MediaPlayer2/firefox").ok();
        let previous = Snapshot {
            track_id: id.clone(),
            ..shot("First video", 60_000_000, 1_000, 300_000_000)
        };
        let next = Snapshot {
            track_id: id,
            length_us: 0,
            ..shot("Second video", 0, 3_000, 0)
        };
        let got = fold(&previous, next, None, true);
        assert_eq!((got.position_us, got.length_us), (0, 0));
    }

    #[test]
    fn browsers_are_told_apart() {
        assert!(super::is_browser(&[
            "org.mpris.MediaPlayer2.firefox.instance_1_7",
            "Mozilla Firefox",
            "firefox"
        ]));
        assert!(super::is_browser(&[
            "org.mpris.MediaPlayer2.zen",
            "Zen",
            "zen"
        ]));
        assert!(super::is_browser(&[
            "org.mpris.MediaPlayer2.chromium.instance42",
            "Chrome",
            "google-chrome"
        ]));
        assert!(!super::is_browser(&[
            "org.mpris.MediaPlayer2.spotify",
            "Spotify",
            "spotify"
        ]));
        assert!(!super::is_browser(&[
            "org.mpris.MediaPlayer2.vlc",
            "VLC media player",
            "vlc"
        ]));
    }

    #[test]
    fn a_new_title_drops_the_old_length() {
        let previous = shot("Song", 30_000_000, 1_000, 180_000_000);
        let next = shot("Other", 0, 5_000, 0);
        let got = fold(&previous, next, None, true);
        assert_eq!(got.length_us, 0);
        assert_eq!(got.position_us, 0);
    }

    /// `reconcile` for a read the island's poll made, of a player that is no browser.
    fn poll(previous: &Snapshot, next: Snapshot) -> Snapshot {
        let same = super::same_track(previous, &next);
        super::reconcile(previous, next, same, None, false, true)
    }

    #[test]
    fn a_browser_read_behind_stands_once_the_next_moves_on_from_it() {
        // YouTube stalled for three seconds while nobody looked: 31 s where 34 s was expected.
        let previous = shot("Song", 30_000_000, 1_000, 180_000_000);
        let behind = fold(
            &previous,
            shot("Song", 31_000_000, 5_000, 180_000_000),
            None,
            true,
        );
        assert_eq!(behind.position_us, 34_000_000);
        assert_eq!(behind.doubt, Some((31_000_000, 5_000)));
        // Played on from there: the stall was real.
        let got = fold(
            &behind,
            shot("Song", 31_400_000, 5_400, 180_000_000),
            None,
            true,
        );
        assert_eq!((got.position_us, got.sampled_at_ms), (31_400_000, 5_400));
        assert_eq!(got.doubt, None);
    }

    #[test]
    fn a_stale_browser_read_alone_or_repeated_is_passed_over() {
        let previous = shot("Song", 30_000_000, 1_000, 180_000_000);
        let stale = fold(
            &previous,
            shot("Song", 20_000_000, 3_000, 180_000_000),
            None,
            true,
        );
        assert_eq!(stale.position_us, 32_000_000);
        // The same stale value again: it does not move on, so it is still passed over.
        let again = fold(
            &stale,
            shot("Song", 20_000_000, 3_500, 180_000_000),
            None,
            true,
        );
        assert_eq!(again.position_us, 32_500_000);
        assert!(again.doubt.is_some());
        // Then a right one: taken, and the doubt is gone.
        let right = fold(
            &again,
            shot("Song", 33_000_000, 4_000, 180_000_000),
            None,
            true,
        );
        assert_eq!((right.position_us, right.doubt), (33_000_000, None));
        // A jump from a doubt is no speed a player plays at either.
        let jump = fold(
            &stale,
            shot("Song", 26_000_000, 3_500, 180_000_000),
            None,
            true,
        );
        assert_eq!(jump.position_us, 32_500_000);
        // Nor a read too soon after it to tell.
        let soon = fold(
            &stale,
            shot("Song", 20_100_000, 3_100, 180_000_000),
            None,
            true,
        );
        assert_eq!(soon.position_us, 32_100_000);
        assert_eq!(soon.doubt, Some((20_000_000, 3_000)));
    }

    #[test]
    fn a_browsers_zero_never_stands_however_often() {
        let mut got = shot("Song", 30_000_000, 1_000, 180_000_000);
        for at in [2_000, 2_500, 3_000, 3_500] {
            got = fold(&got, shot("Song", 0, at, 180_000_000), None, true);
            assert_eq!(got.doubt, None);
        }
        assert_eq!(got.position_us, 32_500_000);
    }

    #[test]
    fn a_poll_takes_a_players_seek_at_once_but_a_zero_only_confirmed() {
        // Spotify, seeked back inside the app with no signal: the poll's read is where it is.
        let previous = shot("Song", 90_000_000, 1_000, 180_000_000);
        let got = poll(&previous, shot("Song", 40_000_000, 2_000, 180_000_000));
        assert_eq!((got.position_us, got.doubt), (40_000_000, None));
        // A 0 from a poll may be a player that always answers 0.
        let zero = poll(&previous, shot("Song", 0, 2_000, 180_000_000));
        assert_eq!(zero.position_us, 91_000_000);
        let still = poll(&zero, shot("Song", 0, 2_400, 180_000_000));
        assert_eq!(still.position_us, 91_400_000);
        // A real restart moves on from it.
        let restarted = poll(&still, shot("Song", 380_000, 2_800, 180_000_000));
        assert_eq!(restarted.position_us, 380_000);
    }

    /// `count` polls a second apart after `from`, moving `speed` per second, with `rate` reported.
    fn reads(from: &Snapshot, count: i64, speed: f64, rate: f64) -> Snapshot {
        let mut got = from.clone();
        let (start_us, start_ms) = (from.position_us, from.sampled_at_ms);
        for i in 1..=count {
            let at = start_ms + i * 1_000;
            // A few microseconds off whole seconds, as players read (whole ones are Firefox's).
            let position = start_us + (i as f64 * speed * 1e6) as i64 + 7 * i;
            let next = Snapshot {
                rate,
                ..shot("Song", position, at, 600_000_000)
            };
            got = poll(&got, next);
        }
        got
    }

    #[test]
    fn a_speed_the_player_keeps_to_itself_is_measured() {
        let start = poll(
            &Snapshot::default(),
            shot("Song", 10_000_000, 1_000, 600_000_000),
        );
        // Playing twice as fast with Rate still 1: one step is not enough, two agreeing are.
        assert_eq!(reads(&start, 1, 2.0, 1.0).rate, 1.0);
        let fast = reads(&start, 2, 2.0, 1.0);
        assert_eq!(fast.rate, 2.0);
        // Back to normal speed: measured again (read sooner meanwhile), then the reported rate is right.
        let turning = reads(&fast, 1, 1.0, 1.0);
        assert!(turning.pace.changing);
        let back = reads(&fast, 3, 1.0, 1.0);
        assert_eq!(back.rate, 1.0);
        assert_eq!((back.pace.measured, back.pace.changing), (None, false));
        // Half speed, and clamped at the slow end.
        assert_eq!(reads(&start, 3, 0.5, 1.0).rate, 0.5);
        assert_eq!(reads(&start, 3, 0.22, 1.0).rate, 0.25);
        // A player whose Rate is right is left alone.
        assert_eq!(reads(&start, 4, 1.25, 1.25).rate, 1.25);
        assert_eq!(reads(&start, 4, 1.0, 1.0).pace.measured, None);
    }

    /// Polls as `poll_due` times them over a player that goes from `before` to `after` per second
    /// (Rate 1 all along) `into` ms past a read; the rate published from 3 s on, and polls >300 ms off.
    fn silent_change(before: f64, after: f64, into: i64) -> (Vec<f64>, usize) {
        let turn_ms = 20_000 + into;
        let truth = |at: i64| {
            let ms = at - 1_000;
            let slow = (at - turn_ms).max(0);
            // Off whole seconds, which only Firefox reads.
            ((ms - slow) as f64 * before + slow as f64 * after) * 1_000.0 + 1_234.0
        };
        let mut got = poll(
            &Snapshot::default(),
            shot("Song", 1_234, 1_000, 600_000_000),
        );
        let mut shown = (got.position_us, got.sampled_at_ms, got.rate);
        let (mut rates, mut off) = (Vec::new(), 0);
        let mut at = 1_000;
        while at < turn_ms + 30_000 {
            at += if got.pace.changing { 500 } else { 1_000 };
            let (from_us, from_ms, rate) = shown;
            let guess = from_us as f64 + (at - from_ms) as f64 * rate * 1_000.0;
            if at > turn_ms && (guess - truth(at)).abs() > 300_000.0 {
                off += 1;
            }
            got = poll(&got, shot("Song", truth(at) as i64, at, 600_000_000));
            // Published again as the island would be (see `NowPlaying::continues_as`).
            let still = (guess - got.position_us as f64).abs() < 250_000.0;
            if got.rate != rate || !still {
                shown = (got.position_us, got.sampled_at_ms, got.rate);
            }
            if at > turn_ms + 3_000 {
                rates.push(got.rate);
            }
        }
        (rates, off)
    }

    #[test]
    fn a_read_that_straddles_a_silent_speed_change_does_not_skew_it() {
        // mpv slowed from 2x to 0.5x with Rate still 1, anywhere between two reads: exactly 0.5 once
        // measured, off only on the (at most three) reads that tell the change.
        for (before, after) in [(2.0, 0.5), (0.5, 1.5), (1.5, 1.0)] {
            for into in (10..1_000).step_by(10) {
                let (rates, off) = silent_change(before, after, into);
                assert!(
                    rates.iter().all(|&r| r == after),
                    "{before}>{after} at {into}: {rates:?}"
                );
                assert!(off <= 3, "{before}>{after} at {into}: {off} polls off");
            }
        }
    }

    #[test]
    fn a_measured_speed_ends_with_the_song_a_pause_or_a_new_rate() {
        let start = poll(
            &Snapshot::default(),
            shot("Song", 10_000_000, 1_000, 600_000_000),
        );
        let fast = reads(&start, 3, 2.0, 1.0);
        assert_eq!(fast.rate, 2.0);
        // A stall in between keeps it (buffering does not change the speed), playing at 0 while it lasts.
        let stalled = poll(&fast, shot("Song", fast.position_us, 5_000, 600_000_000));
        assert_eq!((stalled.rate, stalled.pace.measured), (0.0, Some(2.0)));
        let moving = poll(
            &stalled,
            shot("Song", fast.position_us + 2_000_000, 6_000, 600_000_000),
        );
        assert_eq!(moving.rate, 2.0);
        // The next song starts at the rate reported.
        let next = poll(&fast, shot("Other", 1_000_000, 5_000, 600_000_000));
        assert_eq!((next.rate, next.pace.measured), (1.0, None));
        // Paused: the rate reported again.
        let paused = Snapshot {
            status: "Paused".into(),
            ..shot("Song", 16_000_000, 5_000, 600_000_000)
        };
        assert_eq!(poll(&fast, paused).rate, 1.0);
        // The page set a rate the player now reports: that one.
        let told = Snapshot {
            rate: 1.5,
            ..shot("Song", 18_000_000, 5_000, 600_000_000)
        };
        let told = poll(&fast, told);
        assert_eq!((told.rate, told.pace.measured), (1.5, None));
        // A seek the player signalled starts over too.
        let seeked = fold(
            &fast,
            shot("Song", 0, 5_000, 600_000_000),
            Some(60_000_000),
            false,
        );
        assert_eq!((seeked.rate, seeked.pace.measured), (1.0, None));
    }

    #[test]
    fn chromiums_rate_0_while_playing_is_buffering_but_not_on_resume() {
        let playing = shot("Song", 30_000_000, 1_000, 180_000_000);
        // Buffering: Chromium keeps Playing and says Rate 0.
        let buffering = Snapshot {
            rate: 0.0,
            ..shot("Song", 31_000_000, 2_000, 180_000_000)
        };
        let got = fold(&playing, buffering, None, true);
        assert_eq!((got.position_us, got.rate), (31_000_000, 0.0));
        // Resumed from a pause before its Rate came back: playing at the rate before.
        let paused = Snapshot {
            status: "Paused".into(),
            rate: 0.0,
            ..shot("Song", 31_000_000, 2_000, 180_000_000)
        };
        let resumed = Snapshot {
            rate: 0.0,
            ..shot("Song", 31_000_000, 9_000, 180_000_000)
        };
        assert_eq!(fold(&paused, resumed, None, true).rate, 1.0);
    }

    #[test]
    fn firefoxs_whole_seconds_keep_the_finer_place() {
        // Seeked gave the exact place; Firefox's reads are cut down to whole seconds.
        let previous = Snapshot {
            whole: 3,
            ..shot("Song", 42_173_167, 1_000, 420_000_000)
        };
        let got = fold(
            &previous,
            shot("Song", 43_000_000, 1_900, 420_000_000),
            None,
            true,
        );
        assert_eq!((got.position_us, got.rate), (43_073_167, 1.0));
        // Many reads on, still the finer place, never a stall from two reads in the same second.
        let mut got = got;
        for (i, at) in [2_200, 2_550, 2_900, 3_250, 3_600].into_iter().enumerate() {
            let whole = (42_173_167 + (at - 1_000) * 1_000) / 1_000_000 * 1_000_000;
            got = fold(&got, shot("Song", whole, at, 420_000_000), None, i % 2 == 0);
            assert_eq!(got.rate, 1.0);
        }
        assert_eq!(got.position_us, 44_773_167);
        // Played on half a second further than believed (a speed it kept to itself): back in its second.
        let ahead = fold(
            &got,
            shot("Song", 46_000_000, 4_600, 420_000_000),
            None,
            false,
        );
        assert_eq!(ahead.position_us, 46_500_000);
        // Seeked inside the page with no signal: the middle of its second, once confirmed.
        let back = fold(
            &got,
            shot("Song", 20_000_000, 4_000, 420_000_000),
            None,
            true,
        );
        assert_eq!(back.position_us, 45_173_167);
        let on = fold(
            &back,
            shot("Song", 21_000_000, 5_000, 420_000_000),
            None,
            true,
        );
        assert_eq!(on.position_us, 21_500_000);
        // A stale second that stays put is never confirmed.
        let stuck = fold(
            &back,
            shot("Song", 20_000_000, 5_000, 420_000_000),
            None,
            true,
        );
        assert_eq!(stuck.position_us, 46_173_167);
    }

    #[test]
    fn a_stall_plays_at_0_until_it_moves_on() {
        let start = poll(
            &Snapshot::default(),
            shot("Song", 10_000_000, 1_000, 600_000_000),
        );
        let moving = poll(&start, shot("Song", 11_000_000, 2_000, 600_000_000));
        assert_eq!(moving.rate, 1.0);
        // Buffering: two reads at the same place while it says it plays.
        let still = poll(&moving, shot("Song", 11_000_000, 3_000, 600_000_000));
        assert_eq!((still.position_us, still.rate), (11_000_000, 0.0));
        // Still stuck: nothing moves, and nothing is published (the same moment).
        let stuck = poll(&still, shot("Song", 11_000_000, 3_400, 600_000_000));
        assert_eq!(stuck.rate, 0.0);
        // Playing again: the read is ahead of the frozen guess, and the reported rate is back.
        let again = poll(&stuck, shot("Song", 11_300_000, 3_750, 600_000_000));
        assert_eq!((again.position_us, again.rate), (11_300_000, 1.0));
        // A browser's stall is seen the same way.
        let still = fold(
            &moving,
            shot("Song", 11_000_000, 3_000, 600_000_000),
            None,
            true,
        );
        assert_eq!(still.rate, 0.0);
        // Paused, the rate is the player's own.
        let paused = Snapshot {
            status: "Paused".into(),
            ..shot("Song", 11_000_000, 3_000, 600_000_000)
        };
        assert_eq!(poll(&still, paused).rate, 1.0);
    }

    #[test]
    fn a_rate_0_that_moves_on_plays_from_the_next_read() {
        let at_0 = |position_us, at| Snapshot {
            rate: 0.0,
            ..shot("Song", position_us, at, 180_000_000)
        };
        let playing = shot("Song", 30_000_000, 1_000, 180_000_000);
        // The first Rate 0 may be buffering: it stands for one read.
        let first = fold(&playing, at_0(31_000_000, 2_000), None, false);
        assert_eq!(first.rate, 0.0);
        // A second further a second later: it plays, whatever it says.
        let second = fold(&first, at_0(32_000_000, 3_000), None, false);
        assert_eq!((second.position_us, second.rate), (32_000_000, 1.0));
        let third = fold(&second, at_0(33_010_000, 4_000), None, false);
        assert_eq!(third.rate, 1.0);
        // At the speed it moves.
        let fast = fold(&third, at_0(34_510_000, 5_000), None, false);
        assert_eq!(fast.rate, 1.5);
        // Then at one place: buffering for real.
        let stuck = fold(&fast, at_0(34_510_000, 6_000), None, false);
        assert_eq!((stuck.position_us, stuck.rate), (34_510_000, 0.0));
    }

    #[test]
    fn a_player_answering_every_poll_with_0_is_read_every_second_again() {
        let due = super::poll_due;
        let mut got = shot("Song", 90_000_000, 1_000, 600_000_000);
        let mut at = 1_000;
        let mut waits = Vec::new();
        for _ in 0..6 {
            let then = Instant::now();
            let wait = due(true, Some(&got), Some(then), false).unwrap() - then;
            waits.push(wait.as_millis());
            at += wait.as_millis() as i64;
            got = poll(&got, shot("Song", 0, at, 600_000_000));
        }
        // Sooner to confirm the first zeros, then every second; its place never goes back to 0.
        assert_eq!(waits, [1000, 350, 350, 1000, 1000, 1000]);
        assert_eq!(got.position_us, 90_000_000 + (at - 1_000) * 1_000);
        // A real read is taken as ever.
        let read = poll(&got, shot("Song", 94_000_000, at + 1_000, 600_000_000));
        assert_eq!(read.position_us, 94_000_000);
    }

    #[test]
    fn polls_run_only_while_watched_and_playing() {
        let playing = shot("Song", 10_000_000, 1_000, 180_000_000);
        let paused = Snapshot {
            status: "Paused".into(),
            ..playing.clone()
        };
        let doubting = Snapshot {
            doubt: Some((1, 1)),
            ..playing.clone()
        };
        let due = super::poll_due;
        let then = Instant::now();
        // The island closed: never, playing or not.
        assert_eq!(due(false, Some(&playing), None, false), None);
        assert_eq!(due(false, Some(&playing), Some(then), false), None);
        // Nothing to read.
        assert_eq!(due(true, None, None, false), None);
        // Just opened: at once, even paused.
        assert!(due(true, Some(&paused), None, false).is_some_and(|at| at >= then));
        // Then every second while it plays, not while paused.
        assert_eq!(due(true, Some(&paused), Some(then), false), None);
        let second = Some(then + Duration::from_secs(1));
        assert_eq!(due(true, Some(&playing), Some(then), false), second);
        // Sooner to confirm a doubt or see a stall end; later after a read failed.
        let confirm = Some(then + Duration::from_millis(350));
        assert_eq!(due(true, Some(&doubting), Some(then), false), confirm);
        let mut still = playing.clone();
        still.pace.still = true;
        assert_eq!(due(true, Some(&still), Some(then), false), confirm);
        let mut changing = playing.clone();
        changing.pace.changing = true;
        let measure = Some(then + Duration::from_millis(500));
        assert_eq!(due(true, Some(&changing), Some(then), false), measure);
        let failed = Some(then + Duration::from_secs(10));
        assert_eq!(due(true, Some(&playing), Some(then), true), failed);
    }

    #[test]
    fn picks_the_chosen_player_else_the_one_playing_last() {
        assert_eq!(pick_among(&PLAYERS, None), Some("firefox"));
        assert_eq!(pick_among(&PLAYERS, Some("spotify")), Some("spotify"));
        // Picked, then gone: back to the rule.
        assert_eq!(pick_among(&PLAYERS, Some("vlc")), Some("firefox"));
    }

    #[test]
    fn a_paused_song_beats_a_player_stopped_since() {
        // VLC played a video after the song was paused, and the video ended.
        let after_video = [
            ("spotify", "Paused", "Song", 3),
            ("vlc", "Stopped", "Clip", 6),
        ];
        assert_eq!(pick_among(&after_video, None), Some("spotify"));
        // Playing with nothing to show: the paused song still shows.
        let untitled = [
            ("spotify", "Paused", "Song", 3),
            ("chrome", "Playing", "", 6),
        ];
        assert_eq!(pick_among(&untitled, None), Some("spotify"));
    }

    #[test]
    fn a_pick_left_empty_gives_way() {
        // Picked, then its file ended: `mpv --idle` has nothing to show, and Spotify plays.
        let idle = [("spotify", "Playing", "Song", 3), ("mpv", "Stopped", "", 4)];
        assert_eq!(pick_among(&idle, Some("mpv")), Some("spotify"));
        // Stopped with its song still in it, it has: the switch shows to go back.
        let stopped = [
            ("spotify", "Playing", "Song", 3),
            ("mpv", "Stopped", "Film", 4),
        ];
        assert_eq!(pick_among(&stopped, Some("mpv")), Some("mpv"));
        assert!(!super::shows(&Snapshot::default()));
    }

    #[test]
    fn lyrics_wait_for_the_setting_and_a_length_on_its_way() {
        let query = |length_s| TrackQuery {
            title: "Song".into(),
            artist: "Lumen Coast".into(),
            album: String::new(),
            length_s,
        };
        // Until the extension says, nothing is looked up.
        assert_eq!(lyrics_step(None, &query(216.0), false), LyricsStep::Wait);
        assert_eq!(
            lyrics_step(Some(false), &query(216.0), false),
            LyricsStep::Off
        );
        assert_eq!(
            lyrics_step(Some(true), &query(216.0), true),
            LyricsStep::Fetch
        );
        // Firefox's length comes a moment late: one lookup, with it.
        assert_eq!(lyrics_step(Some(true), &query(0.0), true), LyricsStep::Wait);
        // Never coming (a stream): looked up without.
        assert_eq!(
            lyrics_step(Some(true), &query(0.0), false),
            LyricsStep::Fetch
        );
    }

    #[test]
    fn a_file_with_no_title_goes_by_its_name() {
        assert_eq!(
            file_title("file:///home/user/Videos/Holiday-2026.mp4").as_deref(),
            Some("Holiday-2026")
        );
        assert_eq!(
            file_title("file:///home/user/My%20Videos/My%20clip.final.mkv").as_deref(),
            Some("My clip.final")
        );
        assert_eq!(file_title("https://www.youtube.com/watch?v=x"), None);
    }
}

/// The watcher on a private bus with fake players: what only shows with real calls (a hung player, a caller
/// leaving). Skipped where `dbus-daemon` is missing.
#[cfg(test)]
mod bus_tests {
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use tokio::time::{Instant, sleep};
    use zbus::object_server::InterfaceRef;
    use zbus::zvariant::{OwnedValue, Value};
    use zbus::{Connection, connection, interface};

    use super::super::MediaService;
    use super::watch;

    const PATH: &str = "/org/mpris/MediaPlayer2";
    const ISLED_PATH: &str = "/io/github/zickrian/isle";

    /// A session bus of its own, stopped with the test.
    struct Bus {
        daemon: Child,
        address: String,
    }

    impl Bus {
        fn start() -> Option<Self> {
            let mut daemon = Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--print-address=1"])
                .stdout(Stdio::piped())
                .spawn()
                .ok()?;
            let mut address = String::new();
            BufReader::new(daemon.stdout.take()?)
                .read_line(&mut address)
                .ok()?;
            Some(Self {
                daemon,
                address: address.trim().to_owned(),
            })
        }

        async fn connect(&self) -> Connection {
            connection::Builder::address(self.address.as_str())
                .unwrap()
                .build()
                .await
                .unwrap()
        }
    }

    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.daemon.kill();
            let _ = self.daemon.wait();
        }
    }

    struct App;

    #[interface(name = "org.mpris.MediaPlayer2")]
    impl App {
        #[zbus(property)]
        fn identity(&self) -> String {
            "Fake".into()
        }
    }

    /// A player that counts its Position reads, and hangs on them while `hung`.
    struct Player {
        title: &'static str,
        playing: bool,
        hung: Arc<AtomicBool>,
        reads: Arc<AtomicUsize>,
    }

    #[interface(name = "org.mpris.MediaPlayer2.Player")]
    impl Player {
        #[zbus(property)]
        fn playback_status(&self) -> String {
            if self.playing { "Playing" } else { "Paused" }.into()
        }

        #[zbus(property)]
        fn metadata(&self) -> HashMap<String, OwnedValue> {
            let title = OwnedValue::try_from(Value::from(self.title)).unwrap();
            HashMap::from([
                ("xesam:title".to_owned(), title),
                ("mpris:length".to_owned(), OwnedValue::from(180_000_000_i64)),
            ])
        }

        #[zbus(property)]
        async fn position(&self) -> i64 {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.hung.load(Ordering::SeqCst) {
                sleep(Duration::from_secs(60)).await;
            }
            30_000_000
        }

        #[zbus(property)]
        fn rate(&self) -> f64 {
            1.0
        }
    }

    struct Fake {
        conn: Connection,
        hung: Arc<AtomicBool>,
        reads: Arc<AtomicUsize>,
    }

    impl Fake {
        async fn start(bus: &Bus, name: &str, title: &'static str, playing: bool) -> Self {
            let (hung, reads) = (Arc::default(), Arc::<AtomicUsize>::default());
            let player = Player {
                title,
                playing,
                hung: Arc::clone(&hung),
                reads: Arc::clone(&reads),
            };
            let conn = bus.connect().await;
            conn.object_server().at(PATH, App).await.unwrap();
            conn.object_server().at(PATH, player).await.unwrap();
            conn.request_name(format!("org.mpris.MediaPlayer2.{name}"))
                .await
                .unwrap();
            Self { conn, hung, reads }
        }

        fn reads(&self) -> usize {
            self.reads.load(Ordering::SeqCst)
        }

        /// Starts playing, and says so as players do.
        async fn play(&self) {
            let player = self
                .conn
                .object_server()
                .interface::<_, Player>(PATH)
                .await
                .unwrap();
            player.get_mut().await.playing = true;
            let emitter = player.signal_emitter();
            player
                .get()
                .await
                .playback_status_changed(emitter)
                .await
                .unwrap();
        }
    }

    /// isled's media watcher on `bus`.
    async fn isled(bus: &Bus) -> (Connection, InterfaceRef<MediaService>) {
        let conn = bus.connect().await;
        let (service, wishes) = MediaService::new();
        conn.object_server().at(ISLED_PATH, service).await.unwrap();
        let iface = conn
            .object_server()
            .interface::<_, MediaService>(ISLED_PATH)
            .await
            .unwrap();
        tokio::spawn(watch(conn.clone(), iface.clone(), wishes));
        (conn, iface)
    }

    async fn set_watching(client: &Connection, isled: &Connection, watching: bool) {
        let isled = isled.unique_name().unwrap().to_owned();
        client
            .call_method(
                Some(isled),
                ISLED_PATH,
                Some("io.github.zickrian.isle.Media1"),
                "SetWatching",
                &(watching,),
            )
            .await
            .unwrap();
    }

    async fn until(within: Duration, mut done: impl AsyncFnMut() -> bool) -> bool {
        let end = Instant::now() + within;
        while Instant::now() < end {
            if done().await {
                return true;
            }
            sleep(Duration::from_millis(20)).await;
        }
        false
    }

    async fn title(iface: &InterfaceRef<MediaService>) -> String {
        iface.get().await.now_playing.title.clone()
    }

    #[tokio::test]
    async fn a_hung_player_holds_up_nothing_else() {
        let Some(bus) = Bus::start() else {
            eprintln!("no dbus-daemon: skipped");
            return;
        };
        let hung = Fake::start(&bus, "hung", "Hung song", true).await;
        let other = Fake::start(&bus, "other", "Other song", false).await;
        let (isled, iface) = isled(&bus).await;
        assert!(
            until(Duration::from_secs(3), async || title(&iface).await
                == "Hung song")
            .await
        );
        let island = bus.connect().await;
        set_watching(&island, &isled, true).await;
        assert!(until(Duration::from_secs(3), async || hung.reads() >= 2).await);
        // The next poll hangs (up to the 5 s timeout); meanwhile the other player starts.
        hung.hung.store(true, Ordering::SeqCst);
        let before = hung.reads();
        assert!(until(Duration::from_secs(3), async || hung.reads() > before).await);
        let started = Instant::now();
        other.play().await;
        let shown = until(Duration::from_secs(8), async || {
            title(&iface).await == "Other song"
        })
        .await;
        let took = started.elapsed();
        assert!(
            shown && took < Duration::from_millis(1500),
            "shown {shown} after {took:?}"
        );
        // And it is polled in turn, every second.
        let before = other.reads();
        sleep(Duration::from_millis(2500)).await;
        assert!(
            other.reads() - before >= 2,
            "{} reads",
            other.reads() - before
        );
    }

    #[tokio::test]
    async fn polls_stop_when_the_island_that_asked_leaves_the_bus() {
        let Some(bus) = Bus::start() else {
            eprintln!("no dbus-daemon: skipped");
            return;
        };
        let player = Fake::start(&bus, "spotify", "Song", true).await;
        let (isled, iface) = isled(&bus).await;
        assert!(
            until(Duration::from_secs(3), async || title(&iface).await
                == "Song")
            .await
        );
        // Asked by one shell, then by a newer one: the first leaving changes nothing.
        let old = bus.connect().await;
        set_watching(&old, &isled, true).await;
        let new = bus.connect().await;
        set_watching(&new, &isled, true).await;
        old.close().await.unwrap();
        sleep(Duration::from_millis(300)).await;
        let before = player.reads();
        sleep(Duration::from_millis(2500)).await;
        assert!(
            player.reads() - before >= 2,
            "{} reads",
            player.reads() - before
        );
        // The one that asked last crashes with the page open: polls stop.
        new.close().await.unwrap();
        sleep(Duration::from_millis(300)).await;
        let before = player.reads();
        sleep(Duration::from_millis(2500)).await;
        assert_eq!(player.reads() - before, 0);
    }
}
