// SPDX-License-Identifier: GPL-3.0-or-later

//! AI agent alerts: Claude Code and Codex, once the user turns them on, run `isled --agent-hook` when
//! they need the user or finish, and the island shows it. The hooks live in each AI's own config.

mod claude;
mod codex;
mod file;
pub mod hook;
mod json_hooks;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
#[cfg(target_os = "linux")]
use inotify::{EventMask, Inotify, WatchMask};
use log::{debug, warn};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
#[cfg(target_os = "linux")]
use tokio::time::sleep_until;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface};

use crate::assistant::Provider;

/// Longest texts the island gets, in characters.
const MAX_MESSAGE: usize = 160;
const MAX_PROJECT: usize = 60;
const MAX_SESSION: usize = 100;
const MAX_CWD: usize = 1024;
/// How many of the hook's parent processes come along: enough for a terminal or editor and their shells.
const MAX_PIDS: usize = 32;
/// Events of one kind from one AI session closer together than this are dropped.
const MIN_GAP: Duration = Duration::from_millis(300);
/// A permission waits this long for an answer on the island; then the AI asks in its own terminal
/// (its hook may wait ten minutes: this ends first).
const ANSWER_WITHIN: Duration = Duration::from_secs(9 * 60 + 30);
/// Asks waiting at once, at most; more ask in their own terminals (a flood is never shown).
const MAX_WAITING: usize = 8;
/// While a permission waits, how often isled checks the hook asking is still there (the user may have
/// answered in the terminal, and the AI let its hook go).
const STILL_ASKING: Duration = Duration::from_secs(2);
const MAX_INPUT: usize = 300;
const MAX_TOOL: usize = 60;
/// A config file is looked at again once it has been quiet this long.
#[cfg(target_os = "linux")]
const SETTLE: Duration = Duration::from_millis(250);

const KINDS: [&str; 3] = ["permission", "waiting", "done"];

/// The AIs whose alerts Isle can show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ai {
    Claude,
    Codex,
}

impl Ai {
    const ALL: [Ai; 2] = [Ai::Claude, Ai::Codex];

    fn id(self) -> &'static str {
        match self {
            Ai::Claude => "claude",
            Ai::Codex => "codex",
        }
    }

    fn from_id(id: &str) -> Option<Ai> {
        Self::ALL.into_iter().find(|ai| ai.id() == id)
    }

    fn name(self) -> &'static str {
        match self {
            Ai::Claude => "Claude Code",
            Ai::Codex => "Codex",
        }
    }

    fn config(self) -> PathBuf {
        match self {
            Ai::Claude => claude::settings_path(),
            Ai::Codex => codex::config_path(),
        }
    }

    /// Where Isle's hooks are: Codex's hooks.json, or its config.toml's `notify` for an older Codex.
    fn hooks_file(self) -> PathBuf {
        match self {
            Ai::Codex if json_hooks::hooked(&codex::hooks_path(), &codex::SPEC) => {
                codex::hooks_path()
            }
            _ => self.config(),
        }
    }

    fn found(self) -> bool {
        match self {
            Ai::Claude => Provider::Claude.program().is_some(),
            Ai::Codex => Provider::Codex.program().is_some(),
        }
    }

    fn hooked(self) -> bool {
        match self {
            Ai::Claude => claude::hooked(&self.config()),
            Ai::Codex => codex::hooked(&self.config()),
        }
    }

    fn hook(self) -> anyhow::Result<()> {
        let isled = isled_path()?;
        let isled = isled
            .to_str()
            .with_context(|| format!("isled's path {} is not UTF-8", isled.display()))?;
        match self {
            Ai::Claude => claude::install(&self.config(), &claude::command(isled, "claude")),
            Ai::Codex => codex::install(&self.config(), isled, &claude::command(isled, "codex")),
        }
    }

    /// Whether there was a hook to take out.
    fn unhook(self) -> anyhow::Result<bool> {
        match self {
            Ai::Claude => claude::remove(&self.config()),
            Ai::Codex => codex::remove(&self.config()),
        }
    }
}

/// This isled, as hooks run it. Replaced while running (an update), the kernel adds " (deleted)".
fn isled_path() -> anyhow::Result<PathBuf> {
    let exe = std::env::current_exe().context("could not find isled's own path")?;
    let exe = exe
        .to_str()
        .and_then(|path| path.strip_suffix(" (deleted)"))
        .map_or(exe.clone(), PathBuf::from);
    Ok(std::fs::canonicalize(&exe).unwrap_or(exe))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
struct Status {
    found: bool,
    hooked: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
struct Agents {
    claude: Status,
    codex: Status,
}

impl Agents {
    fn read() -> Self {
        let status = |ai: Ai| Status {
            found: ai.found(),
            hooked: ai.hooked(),
        };
        Self {
            claude: status(Ai::Claude),
            codex: status(Ai::Codex),
        }
    }
}

/// What an AI hook reports, and the island shows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Event {
    pub provider: String,
    pub kind: String,
    pub project: String,
    pub cwd: String,
    pub message: String,
    pub session: String,
    /// The hook's parent processes, nearest first: the agent's terminal or editor is among them, so the
    /// island can tell its window from others that merely name the project.
    pub pids: Vec<u32>,
}

impl Event {
    /// Checked, on one line each and cut to size: the project is the folder's name unless given.
    pub fn checked(mut self) -> Result<Self, String> {
        if Ai::from_id(&self.provider).is_none() {
            return Err(format!("unknown provider `{}`", cut(&self.provider, 40)));
        }
        if !KINDS.contains(&self.kind.as_str()) {
            return Err(format!("unknown kind `{}`", cut(&self.kind, 40)));
        }
        let cwd = self.cwd.trim();
        self.cwd = if cwd.starts_with('/')
            && cwd.chars().count() <= MAX_CWD
            && !cwd.contains(char::is_control)
        {
            cwd.to_owned()
        } else {
            String::new()
        };
        if self.project.trim().is_empty() {
            self.project = Path::new(&self.cwd)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
        }
        self.project = cut(&self.project, MAX_PROJECT);
        self.message = cut(&self.message, MAX_MESSAGE);
        self.session = cut(&self.session, MAX_SESSION);
        self.pids.retain(|&pid| pid > 1);
        self.pids.truncate(MAX_PIDS);
        Ok(self)
    }
}

/// `text` on one line, its spaces collapsed, at most `max` characters (an ellipsis ends a cut one).
fn cut(text: &str, max: usize) -> String {
    let words: Vec<String> = text
        .split_whitespace()
        .map(|word| word.chars().filter(|c| !c.is_control()).collect())
        .filter(|word: &String| !word.is_empty())
        .collect();
    let line = words.join(" ");
    if line.chars().count() <= max {
        return line;
    }
    let mut short: String = line.chars().take(max.saturating_sub(1)).collect();
    short.truncate(short.trim_end().len());
    short.push('…');
    short
}

/// A permission an AI agent asks for, as its hook sends it and the island shows it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Request {
    pub id: String,
    pub provider: String,
    pub project: String,
    pub cwd: String,
    pub session: String,
    /// The tool (Bash, Edit…) and what it would run or touch, on one line.
    pub tool: String,
    pub input: String,
    /// Whether the AI offers to keep it for next time (Claude's "always").
    pub always: bool,
    /// The hook's parent processes (see `Event::pids`).
    pub pids: Vec<u32>,
}

impl Request {
    fn checked(mut self) -> Result<Self, String> {
        let event = Event {
            provider: self.provider.clone(),
            kind: "permission".into(),
            project: self.project.clone(),
            cwd: self.cwd.clone(),
            message: String::new(),
            session: self.session.clone(),
            pids: std::mem::take(&mut self.pids),
        }
        .checked()?;
        self.project = event.project;
        self.cwd = event.cwd;
        self.session = event.session;
        self.pids = event.pids;
        self.tool = cut(&self.tool, MAX_TOOL);
        self.input = cut(&self.input, MAX_INPUT);
        Ok(self)
    }
}

/// Drops an event that follows the last of its kind from the same AI session too closely.
#[derive(Default)]
struct Limiter {
    last: HashMap<(String, String, String), Instant>,
}

impl Limiter {
    fn allow(&mut self, event: &Event, now: Instant) -> bool {
        let key = (
            event.provider.clone(),
            event.kind.clone(),
            event.session.clone(),
        );
        if self
            .last
            .get(&key)
            .is_some_and(|at| now.duration_since(*at) < MIN_GAP)
        {
            return false;
        }
        // Only the recent are kept: each AI session adds its own, which over weeks would pile up.
        self.last.retain(|_, at| now.duration_since(*at) < MIN_GAP);
        self.last.insert(key, now);
        true
    }
}

/// Permissions waiting for the user, by id, and where each answer goes.
type Waiting = std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>;

#[derive(Default)]
pub struct AgentsService {
    limiter: std::sync::Mutex<Limiter>,
    waiting: std::sync::Arc<Waiting>,
    asked: std::sync::atomic::AtomicU64,
}

#[interface(name = "io.github.zickrian.isle.Agents1")]
impl AgentsService {
    /// Puts Isle's hook in `provider`'s config, or takes it out. GNOME Shell's to ask, no other program's.
    async fn set_hooked(
        &self,
        provider: &str,
        on: bool,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        crate::caller::shell_only(connection, &header).await?;
        let ai = Ai::from_id(provider)
            .ok_or_else(|| fdo::Error::InvalidArgs(format!("no AI called `{provider}`")))?;
        let done =
            tokio::task::spawn_blocking(move || if on { ai.hook() } else { ai.unhook().map(drop) })
                .await
                .map_err(|err| fdo::Error::Failed(err.to_string()))?;
        if let Err(err) = self.agents_changed(&emitter).await {
            warn!("could not publish the AI alerts: {err}");
        }
        done.map_err(|err| fdo::Error::Failed(format!("{err:#}")))
    }

    /// From `isled --agent-hook`: JSON `{provider, kind, project, cwd, message, session}`.
    async fn report(
        &self,
        json: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let event: Event =
            serde_json::from_str(json).map_err(|err| fdo::Error::InvalidArgs(err.to_string()))?;
        let event = event.checked().map_err(fdo::Error::InvalidArgs)?;
        let allowed = self
            .limiter
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .allow(&event, Instant::now());
        if !allowed {
            debug!(
                "dropped a {} {} event: too soon",
                event.provider, event.kind
            );
            return Ok(());
        }
        let json = serde_json::to_string(&event).unwrap_or_default();
        Ok(Self::event(&emitter, &json).await?)
    }

    /// From `isled --agent-hook` as an AI asks a permission: JSON `{provider, project, cwd, session, tool,
    /// input, always}`. Shows it on the island and waits for the user: "allow", "always" or "deny"; "" when
    /// the island will not answer (the AI then asks in its own terminal).
    async fn decide(
        &self,
        json: &str,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<String> {
        let request: Request =
            serde_json::from_str(json).map_err(|err| fdo::Error::InvalidArgs(err.to_string()))?;
        let mut request = request.checked().map_err(fdo::Error::InvalidArgs)?;
        let number = self
            .asked
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        request.id = format!("{}-{number}", request.provider);
        let (answer, answered) = tokio::sync::oneshot::channel();
        {
            let mut waiting = self
                .waiting
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if waiting.len() >= MAX_WAITING {
                return Ok(String::new());
            }
            waiting.insert(request.id.clone(), answer);
        }
        let shown = serde_json::to_string(&request).unwrap_or_default();
        Self::asking(&emitter, &shown).await?;
        let asker = header.sender().map(|name| name.to_owned());
        let decision = wait_for_answer(connection, asker, answered).await;
        // Over, one way or another: the island lets it go.
        let still = self
            .waiting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&request.id);
        if still.is_some() {
            Self::withdrawn(&emitter, &request.id).await.ok();
        }
        Ok(decision)
    }

    /// The island's answer to permission `id`: "allow", "always" or "deny" ("" lets the AI ask itself).
    async fn resolve(
        &self,
        id: &str,
        decision: &str,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> fdo::Result<()> {
        crate::caller::shell_only(connection, &header).await?;
        if !["allow", "always", "deny", ""].contains(&decision) {
            return Err(fdo::Error::InvalidArgs(format!(
                "no such answer `{}`",
                cut(decision, 20)
            )));
        }
        let answer = self
            .waiting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(id);
        if let Some(answer) = answer {
            answer.send(decision.to_owned()).ok();
        }
        Ok(())
    }

    /// An AI asks a permission: the JSON `Decide` got, with its `id` for `Resolve`.
    #[zbus(signal)]
    async fn asking(emitter: &SignalEmitter<'_>, json: &str) -> zbus::Result<()>;

    /// Permission `id` needs no answer any more (answered in the terminal, or it waited too long).
    #[zbus(signal)]
    async fn withdrawn(emitter: &SignalEmitter<'_>, id: &str) -> zbus::Result<()>;

    /// JSON `{claude: {found, hooked}, codex: {found, hooked}}`, read afresh.
    #[zbus(property)]
    fn agents(&self) -> String {
        serde_json::to_string(&Agents::read()).unwrap_or_default()
    }

    #[zbus(signal)]
    async fn event(emitter: &SignalEmitter<'_>, json: &str) -> zbus::Result<()>;
}

/// The user's answer, or "" if none comes in time or the hook asking is gone (the AI moved on).
async fn wait_for_answer(
    connection: &zbus::Connection,
    asker: Option<zbus::names::UniqueName<'static>>,
    mut answered: tokio::sync::oneshot::Receiver<String>,
) -> String {
    let dbus = zbus::fdo::DBusProxy::new(connection).await.ok();
    let deadline = Instant::now() + ANSWER_WITHIN;
    loop {
        tokio::select! {
            answer = &mut answered => return answer.unwrap_or_default(),
            () = tokio::time::sleep(STILL_ASKING) => {
                if Instant::now() >= deadline {
                    return String::new();
                }
                if let (Some(dbus), Some(asker)) = (&dbus, &asker)
                    && !dbus.name_has_owner(asker.clone().into()).await.unwrap_or(true)
                {
                    return String::new();
                }
            }
        }
    }
}

/// Publishes `Agents` again whenever an AI's config file changes (the user, or the AI, edited it).
pub async fn watch(iface: InterfaceRef<AgentsService>) {
    let mut published = Agents::read();
    loop {
        if let Err(err) = watch_configs(&iface, &mut published).await {
            debug!("stopped watching the AIs' configs: {err}");
            return;
        }
    }
}

/// Returns when a config folder came or went, to watch afresh.
#[cfg(not(target_os = "linux"))]
async fn watch_configs(
    iface: &InterfaceRef<AgentsService>,
    published: &mut Agents,
) -> anyhow::Result<()> {
    tokio::time::sleep(Duration::from_secs(5)).await;
    let now = Agents::read();
    if now != *published {
        *published = now;
        let service = iface.get().await;
        if let Err(err) = service.agents_changed(iface.signal_emitter()).await {
            warn!("could not publish the AI alerts: {err}");
        }
    }
    Ok(())
}

/// Returns when a config folder came or went, to watch afresh.
#[cfg(target_os = "linux")]
async fn watch_configs(
    iface: &InterfaceRef<AgentsService>,
    published: &mut Agents,
) -> anyhow::Result<()> {
    use futures_util::StreamExt;
    let inotify = Inotify::init()?;
    let mut watches = inotify.watches();
    let files: Vec<PathBuf> = Ai::ALL
        .into_iter()
        .map(Ai::config)
        .chain([codex::hooks_path()])
        .collect();
    // Where their programs land when installed (npm, nvm, volta, bun, pnpm, the installers), as the
    // assistant looks for them: a new one is found at once. A new Node under nvm is watched in turn.
    // A folder not there yet (a new user's ~/.local/bin, nvm before its first Node): its nearest parent
    // that is, for the next folder down to appear, and then all is watched again.
    let home = dirs::home_dir().unwrap_or_default();
    let mut ahead: Vec<(inotify::WatchDescriptor, std::ffi::OsString)> = Vec::new();
    let mut watch_or_ahead = |dir: &Path, mask: WatchMask| {
        if watches.add(dir, mask | WatchMask::MASK_ADD).is_ok() {
            return;
        }
        let mut below = dir;
        while let Some(parent) = below.parent() {
            if parent.is_dir() {
                let appear = WatchMask::CREATE | WatchMask::MOVED_TO | WatchMask::MASK_ADD;
                if let (Ok(wd), Some(name)) = (watches.add(parent, appear), below.file_name()) {
                    ahead.push((wd, name.to_owned()));
                }
                break;
            }
            below = parent;
        }
    };
    for dir in crate::assistant::install_dirs(&home)
        .into_iter()
        .chain([PathBuf::from("/usr/bin")])
        .filter(|dir| dir.starts_with(&home) || dir.is_dir())
    {
        watch_or_ahead(
            &dir,
            WatchMask::CREATE | WatchMask::MOVED_TO | WatchMask::DELETE,
        );
    }
    let nvm_nodes = std::env::var_os("NVM_DIR")
        .filter(|dir| !dir.is_empty())
        .map_or_else(|| home.join(".nvm"), PathBuf::from)
        .join("versions/node");
    watch_or_ahead(&nvm_nodes, WatchMask::CREATE | WatchMask::MOVED_TO);
    let nodes = watches
        .add(
            &nvm_nodes,
            WatchMask::CREATE | WatchMask::MOVED_TO | WatchMask::MASK_ADD,
        )
        .ok();
    let mut watched = false;
    for file in &files {
        let Some(dir) = file.parent() else { continue };
        let changes = WatchMask::CLOSE_WRITE
            | WatchMask::MOVED_TO
            | WatchMask::MOVED_FROM
            | WatchMask::CREATE
            | WatchMask::DELETE
            | WatchMask::DELETE_SELF
            | WatchMask::MOVE_SELF;
        if watches.add(dir, changes).is_ok() {
            watched = true;
        } else if let Some(parent) = dir.parent()
            && watches
                .add(parent, WatchMask::CREATE | WatchMask::MOVED_TO)
                .is_ok()
        {
            // The folder appearing (the AI's first run).
            watched = true;
        }
    }
    if !watched {
        std::future::pending::<()>().await;
    }
    let programs = [
        std::ffi::OsStr::new("claude"),
        std::ffi::OsStr::new("codex"),
    ];
    let names: Vec<&std::ffi::OsStr> = files
        .iter()
        .flat_map(|file| [file.file_name(), file.parent().and_then(Path::file_name)])
        .flatten()
        .chain(programs)
        .collect();
    let mut events = inotify.into_event_stream([0u8; 1024])?;
    let mut due = None;
    let mut again = false;
    loop {
        tokio::select! {
            event = events.next() => {
                let event = event.context("inotify stopped")??;
                let gone = EventMask::DELETE_SELF | EventMask::MOVE_SELF | EventMask::IGNORED | EventMask::Q_OVERFLOW;
                let named = event.name.as_deref().is_some_and(|name| names.contains(&name));
                let new_node = nodes.as_ref() == Some(&event.wd);
                let appeared = ahead
                    .iter()
                    .any(|(wd, name)| *wd == event.wd && event.name.as_deref() == Some(name.as_os_str()));
                if event.mask.intersects(gone) || new_node || appeared || (named && event.mask.contains(EventMask::ISDIR)) {
                    again = true;
                } else if !named {
                    continue;
                }
                due = Some(Instant::now() + SETTLE);
            }
            () = sleep_until(due.unwrap_or_else(Instant::now)), if due.is_some() => {
                due = None;
                let now = Agents::read();
                if now != *published {
                    *published = now;
                    let service = iface.get().await;
                    if let Err(err) = service.agents_changed(iface.signal_emitter()).await {
                        warn!("could not publish the AI alerts: {err}");
                    }
                }
                if again {
                    return Ok(());
                }
            }
        }
    }
}

/// For `isled --doctor`: whether each AI's alerts are on.
pub fn report() -> String {
    let lines: Vec<String> = Ai::ALL
        .into_iter()
        .map(|ai| {
            let state = match (ai.found(), ai.hooked()) {
                (_, true) => format!("on ({})", ai.hooks_file().display()),
                (true, false) => "off".to_owned(),
                (false, false) => "off (not installed)".to_owned(),
            };
            format!("  {}: {state}", ai.name())
        })
        .collect();
    lines.join("\n")
}

/// `isled --unhook-all`: takes Isle's hooks out of every AI's config, as Isle is uninstalled.
pub fn unhook_all() {
    for ai in Ai::ALL {
        let name = ai.name();
        match ai.unhook() {
            Ok(true) => println!("{name}: alerts removed from {}", ai.config().display()),
            Ok(false) => println!("{name}: no alerts were set up"),
            Err(err) => println!("{name}: could not remove the alerts: {err:#}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(json: &str) -> Result<Event, String> {
        serde_json::from_str::<Event>(json).unwrap().checked()
    }

    #[test]
    fn events_are_checked_and_cut_to_size() {
        let checked = event(
            r#"{"provider": "claude", "kind": "permission", "cwd": "/home/a/isle",
                "message": "  Claude needs\n your permission\tto use Bash  ", "session": "abc"}"#,
        )
        .unwrap();
        assert_eq!(checked.project, "isle");
        assert_eq!(checked.message, "Claude needs your permission to use Bash");
        assert_eq!(checked.session, "abc");

        let long = event(&format!(
            r#"{{"provider": "codex", "kind": "done", "cwd": "relative/path",
                 "project": "{}", "message": "{}\u0007"}}"#,
            "p".repeat(100),
            "word ".repeat(100)
        ))
        .unwrap();
        assert_eq!(long.cwd, "");
        assert_eq!(long.project.chars().count(), MAX_PROJECT);
        assert!(long.project.ends_with('…'));
        assert!(long.message.chars().count() <= MAX_MESSAGE);
        assert!(long.message.ends_with("word…"));

        assert!(event(r#"{"provider": "agy", "kind": "done"}"#).is_err());
        assert!(event(r#"{"provider": "claude", "kind": "exploded"}"#).is_err());
        assert!(event(r#"{"provider": "claude", "kind": "done"}"#).is_ok());
    }

    #[test]
    fn events_too_close_together_are_dropped() {
        let mut limiter = Limiter::default();
        let done = event(r#"{"provider": "claude", "kind": "done"}"#).unwrap();
        let waiting = event(r#"{"provider": "claude", "kind": "waiting"}"#).unwrap();
        let codex = event(r#"{"provider": "codex", "kind": "done"}"#).unwrap();
        let start = Instant::now();
        assert!(limiter.allow(&done, start));
        assert!(!limiter.allow(&done, start + Duration::from_millis(100)));
        assert!(limiter.allow(&waiting, start + Duration::from_millis(100)));
        assert!(limiter.allow(&codex, start + Duration::from_millis(100)));
        assert!(limiter.allow(&done, start + Duration::from_millis(400)));
        // Sessions long over are forgotten.
        assert_eq!(limiter.last.len(), 1);
    }

    #[test]
    fn agents_are_published_as_json() {
        let agents = Agents {
            claude: Status {
                found: true,
                hooked: false,
            },
            codex: Status::default(),
        };
        assert_eq!(
            serde_json::to_string(&agents).unwrap(),
            r#"{"claude":{"found":true,"hooked":false},"codex":{"found":false,"hooked":false}}"#
        );
    }
}
