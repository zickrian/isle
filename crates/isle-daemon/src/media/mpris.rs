// SPDX-License-Identifier: GPL-3.0-or-later

//! Watches every MPRIS player on the session bus and publishes the active one.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::StreamExt;
use log::{debug, warn};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio::time::Instant;
use zbus::fdo::{DBusProxy, PropertiesProxy};
use zbus::names::{InterfaceName, OwnedBusName};
use zbus::object_server::InterfaceRef;
use zbus::proxy::CacheProperties;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, MatchRule, MessageStream, proxy};

use super::gap::GapBridge;
use super::lyrics::{self, Lyrics, LyricsStatus, TrackQuery};
use super::{MediaService, NowPlaying, PlayerChoice, Wish, art};
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

#[proxy(
    interface = "org.mpris.MediaPlayer2.Player",
    default_path = "/org/mpris/MediaPlayer2",
    gen_blocking = false
)]
pub trait Player {
    fn play_pause(&self) -> zbus::Result<()>;
    fn next(&self) -> zbus::Result<()>;
    fn previous(&self) -> zbus::Result<()>;
    fn seek(&self, offset: i64) -> zbus::Result<()>;
    fn set_position(&self, track_id: &ObjectPath<'_>, position: i64) -> zbus::Result<()>;
    #[zbus(property)]
    fn position(&self) -> zbus::Result<i64>;
    #[zbus(signal)]
    fn seeked(&self, position: i64) -> zbus::Result<()>;
}

#[proxy(
    interface = "org.mpris.MediaPlayer2",
    default_path = "/org/mpris/MediaPlayer2",
    gen_blocking = false
)]
pub trait App {
    fn raise(&self) -> zbus::Result<()>;
}

enum Event {
    /// A player's properties changed or it seeked.
    Player(OwnedBusName),
    /// A cover art download finished, successfully or not.
    ArtDone { url: String, ok: bool },
    /// The result of lyrics lookup number `lookup`.
    Lyrics { lookup: u64, lyrics: Lyrics },
    /// Time to retry lyrics lookup number `lookup`, which failed.
    RetryLyrics { lookup: u64 },
    /// A gap between songs may be over; see [`GapBridge`].
    GapOver,
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
}

struct Entry {
    player: PlayerProxy<'static>,
    properties: PropertiesProxy<'static>,
    identity: String,
    desktop_entry: String,
    snapshot: Snapshot,
    /// Order in which players last started playing; the latest one wins.
    started_playing: u64,
    listener: AbortHandle,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.listener.abort();
    }
}

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
    /// Whether lyrics are looked up online (Settings).
    lyrics_enabled: bool,
}

/// Runs forever, keeping `iface` in sync with the active player.
pub async fn watch(conn: Connection, iface: InterfaceRef<MediaService>) -> anyhow::Result<()> {
    if !conn.is_bus() {
        std::future::pending::<()>().await;
        return Ok(());
    }
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
        lyrics_enabled: true,
    };
    let (wishes, mut wished) = mpsc::unbounded_channel();
    watcher.iface.get_mut().await.wishes = Some(wishes);

    for name in dbus.list_names().await? {
        if is_player(name.as_str()) {
            watcher.add(name).await;
        }
    }
    watcher.publish().await;

    loop {
        tokio::select! {
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
                Event::Player(name) => watcher.refresh(&name).await,
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
            },
            else => return Ok(()),
        }
        watcher.publish().await;
    }
}

/// The player to show: the one picked by hand while it runs, else the one playing, else the one that played
/// last. Each player comes as (name, playing, when it last started playing).
fn pick<'a, N: PartialEq + 'a>(
    players: impl Iterator<Item = (&'a N, bool, u64)> + Clone,
    chosen: Option<&N>,
) -> Option<&'a N> {
    if let Some(name) = players
        .clone()
        .map(|(name, _, _)| name)
        .find(|name| Some(*name) == chosen)
    {
        return Some(name);
    }
    players
        .max_by_key(|&(_, playing, started)| (playing, started))
        .map(|(name, _, _)| name)
}

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

impl Watcher {
    async fn add(&mut self, name: OwnedBusName) {
        match self.connect(name.clone()).await {
            Ok(entry) => {
                debug!("found media player {name}");
                self.players.insert(name.clone(), entry);
                self.refresh(&name).await;
            }
            Err(err) => warn!("could not watch media player {name}: {err}"),
        }
    }

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

        // Only the player's own properties: Identity and the like are read once, above.
        let mut changed = properties
            .receive_properties_changed_with_args(&[(0, PLAYER_INTERFACE)])
            .await?;
        let mut seeked = player.receive_seeked().await?;
        let events = self.events.clone();
        let listener = tokio::spawn(async move {
            loop {
                tokio::select! {
                    Some(_) = changed.next() => {}
                    Some(_) = seeked.next() => {}
                    else => break,
                }
                // The rest of a burst comes with it, and the player is read once.
                let quiet = tokio::time::sleep(BURST);
                tokio::pin!(quiet);
                loop {
                    tokio::select! {
                        () = &mut quiet => break,
                        Some(_) = changed.next() => {}
                        Some(_) = seeked.next() => {}
                    }
                }
                if events.send(Event::Player(name.clone())).is_err() {
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
            snapshot: Snapshot::default(),
            started_playing: 0,
            listener,
        })
    }

    async fn refresh(&mut self, name: &OwnedBusName) {
        let Some(entry) = self.players.get_mut(name) else {
            return;
        };
        let all = bounded(
            entry
                .properties
                .get_all(InterfaceName::from_static_str_unchecked(PLAYER_INTERFACE)),
        )
        .await;
        let snapshot = match all {
            Ok(all) => snapshot(&all),
            Err(err) => {
                debug!("could not read {name}: {err}");
                return;
            }
        };
        if snapshot.status == "Playing" && entry.snapshot.status != "Playing" {
            self.play_counter += 1;
            entry.started_playing = self.play_counter;
            // Another player started: the one picked by hand gives way.
            if self.chosen.as_ref().is_some_and(|chosen| chosen != name) {
                self.chosen = None;
            }
        }
        entry.snapshot = snapshot;
    }

    /// The player picked by hand, else the one that is playing, else the one that played most recently.
    fn active(&self) -> Option<&Entry> {
        self.active_name().and_then(|name| self.players.get(name))
    }

    fn active_name(&self) -> Option<&OwnedBusName> {
        let players = self.players.iter().map(|(name, entry)| {
            (
                name,
                entry.snapshot.status == "Playing",
                entry.started_playing,
            )
        });
        pick(players, self.chosen.as_ref())
    }

    fn wish(&mut self, wish: Wish) {
        match wish {
            Wish::Player(name) => {
                self.chosen = OwnedBusName::try_from(name)
                    .ok()
                    .filter(|name| self.players.contains_key(name));
            }
            Wish::Lyrics(enabled) if enabled != self.lyrics_enabled => {
                self.lyrics_enabled = enabled;
                // Looked up again (or put away) for the current track.
                self.lyrics_query = None;
                self.lyrics_lookup += 1;
            }
            Wish::Lyrics(_) => {}
        }
    }

    /// The players that run, for picking one; empty with fewer than two.
    fn choices(&self) -> Vec<PlayerChoice> {
        if self.players.len() < 2 {
            return Vec::new();
        }
        let active = self.active_name();
        let mut choices: Vec<PlayerChoice> = self
            .players
            .iter()
            .map(|(name, entry)| PlayerChoice {
                name: name.to_string(),
                identity: entry.identity.clone(),
                desktop_entry: entry.desktop_entry.clone(),
                playing: entry.snapshot.status == "Playing",
                active: Some(name) == active,
            })
            .collect();
        choices.sort_by(|a, b| a.identity.cmp(&b.identity).then(a.name.cmp(&b.name)));
        choices
    }

    async fn publish(&mut self) {
        let art_url = self.active().map(|entry| entry.snapshot.art_url.clone());
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
        self.load_lyrics(query).await;

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

    /// Starts loading lyrics when the track changes.
    async fn load_lyrics(&mut self, query: Option<TrackQuery>) {
        if query.as_ref().map(TrackQuery::key) == self.lyrics_query.as_ref().map(TrackQuery::key) {
            return;
        }
        self.lyrics_query = query.clone();
        self.lyrics_failures = 0;
        match query {
            Some(query) if !self.lyrics_enabled => {
                self.lyrics_lookup += 1;
                self.set_lyrics(query.status(LyricsStatus::Off)).await;
            }
            Some(query) => {
                self.set_lyrics(query.status(LyricsStatus::Loading)).await;
                self.fetch_lyrics(query);
            }
            None => {
                // Forget any lookup still running for the previous track.
                self.lyrics_lookup += 1;
                self.set_lyrics(Lyrics::default()).await;
            }
        }
    }

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

    Snapshot {
        status: get("PlaybackStatus")
            .and_then(string)
            .unwrap_or_else(|| "Stopped".into()),
        title: meta("xesam:title").and_then(string).unwrap_or_default(),
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
        position_us: get("Position").and_then(integer).unwrap_or(0),
        sampled_at_ms: now_ms(),
        rate: get("Rate").and_then(float).unwrap_or(1.0),
        can_go_next: flag("CanGoNext"),
        can_go_previous: flag("CanGoPrevious"),
        can_play_pause: flag("CanPause") || flag("CanPlay"),
        can_seek: flag("CanSeek"),
    }
}

fn unwrap_variant<'a>(value: &'a Value<'a>) -> &'a Value<'a> {
    match value {
        Value::Value(inner) => unwrap_variant(inner),
        other => other,
    }
}

fn string(value: &Value<'_>) -> Option<String> {
    match unwrap_variant(value) {
        Value::Str(s) => Some(s.to_string()),
        Value::ObjectPath(path) => Some(path.to_string()),
        _ => None,
    }
}

fn strings(value: &Value<'_>) -> Vec<String> {
    match unwrap_variant(value) {
        Value::Array(array) => array.iter().filter_map(string).collect(),
        other => string(other).into_iter().collect(),
    }
}

fn integer(value: &Value<'_>) -> Option<i64> {
    match unwrap_variant(value) {
        Value::I64(n) => Some(*n),
        Value::U64(n) => i64::try_from(*n).ok(),
        Value::I32(n) => Some(i64::from(*n)),
        Value::U32(n) => Some(i64::from(*n)),
        Value::F64(n) => Some(*n as i64),
        _ => None,
    }
}

fn float(value: &Value<'_>) -> Option<f64> {
    match unwrap_variant(value) {
        Value::F64(n) => Some(*n),
        other => integer(other).map(|n| n as f64),
    }
}

fn boolean(value: &Value<'_>) -> Option<bool> {
    match unwrap_variant(value) {
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::pick;

    const PLAYERS: [(&str, bool, u64); 3] = [
        ("spotify", false, 3),
        ("firefox", true, 5),
        ("mpv", true, 4),
    ];

    fn pick_from(chosen: Option<&'static str>) -> Option<&'static str> {
        let players = PLAYERS
            .iter()
            .map(|(name, playing, started)| (name, *playing, *started));
        pick(players, chosen.as_ref()).copied()
    }

    #[test]
    fn picks_the_chosen_player_else_the_one_playing_last() {
        assert_eq!(pick_from(None), Some("firefox"));
        assert_eq!(pick_from(Some("spotify")), Some("spotify"));
        // Picked, then gone: back to the rule.
        assert_eq!(pick_from(Some("vlc")), Some("firefox"));
    }
}
