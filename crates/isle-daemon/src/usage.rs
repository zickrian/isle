// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! AI plan usage for the island: Claude's, ChatGPT's, Grok's and Antigravity's limits, read where each
//! CLI's /usage or /status reads them (Codex's session logs fill in). Warns once as a limit nears.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use log::warn;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface};

use crate::assistant::AgyUsageError;
use crate::clock::now_ms;
use crate::store::Store;

/// Codex's local logs are read each minute while signed in; Claude is asked every 10, backing off to an
/// hour after failures so its server is never pressed. Nothing runs while locked or with usage off.
const LOCAL_EVERY: Duration = Duration::from_secs(60);
const CLAUDE_EVERY: Duration = Duration::from_secs(10 * 60);
const CLAUDE_BACKOFF: Duration = Duration::from_secs(60 * 60);
/// Without Codex signed in, the sign-in files are looked for this often, or when Claude is due.
const NOTHING_SIGNED_IN_EVERY: Duration = Duration::from_secs(30 * 60);
/// The shortest sleep, so a deadline just missed never spins.
const MIN_WAIT: Duration = Duration::from_secs(1);
/// Offline (as at login, before the network is up), Claude is asked again after these, then as usual.
const OFFLINE_RETRIES: [Duration; 4] = [
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(2 * 60),
    Duration::from_secs(5 * 60),
];
/// Only the end of a Codex log is read: its newest limits are written last.
const CODEX_TAIL: u64 = 256 * 1024;
/// Asked to refresh (the page opened), Claude is asked again only after this long.
const CLAUDE_AT_MOST: Duration = Duration::from_secs(2 * 60);
const AGY_AT_MOST: Duration = Duration::from_secs(30 * 60);
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(10);
/// Only Codex's newest session logs are looked at.
const CODEX_FILES: usize = 8;
/// Where Codex's /status reads the plan and its limits.
const CODEX_USAGE: &str = "https://chatgpt.com/backend-api/wham/usage";

/// Every plan's limits, as the page draws them.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Usage {
    pub providers: Vec<Provider>,
}

/// One AI's plan and its limits.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub plan: String,
    /// Each limit the plan has, as it reports them: a 5-hour session, a week, a model's week…
    pub windows: Vec<Window>,
    /// When the numbers were read; 0 when never.
    pub updated_ms: i64,
    /// Why the numbers may be old ("Open Claude Code to refresh its sign-in"); empty when fresh.
    pub note: String,
    /// With no limits to show, why ("Grok doesn’t share…"); empty for the page's own words.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub empty: String,
}

/// One limit: how much is used and when it starts over.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Window {
    pub label: String,
    pub percent: f64,
    /// 0 when unknown.
    pub resets_at_ms: i64,
}

/// What the extension sends from Settings.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct Config {
    enabled: bool,
    claude: bool,
    codex: bool,
    /// Missing from an older extension: on, like the setting's own default.
    #[serde(default = "on")]
    grok: bool,
    #[serde(default = "on")]
    agy: bool,
    #[serde(default)]
    agy_claude_gpt: bool,
    #[serde(default)]
    agy_argon: bool,
    /// The AI assistant turned on: off, a plan seen here starts no AI to list its models.
    #[serde(default = "on")]
    assistant: bool,
    warn: f64,
    critical: f64,
}

/// Serde default for settings an older extension leaves out.
fn on() -> bool {
    true
}

impl Default for Config {
    /// Usage off, warnings at 80% and 95%.
    fn default() -> Self {
        // Off until the extension says otherwise, so nothing is asked of Claude unbidden.
        Self {
            enabled: false,
            claude: true,
            codex: true,
            grok: true,
            agy: true,
            agy_claude_gpt: false,
            agy_argon: false,
            assistant: true,
            warn: 80.0,
            critical: 95.0,
        }
    }
}

/// The usage page's D-Bus side: its config and the last numbers.
pub struct UsageService {
    usage: Usage,
    config: Config,
    opened: AtomicBool,
    refresh: Arc<Notify>,
}

impl UsageService {
    /// Also returns the handle that wakes the reading loop.
    pub fn new() -> (Self, Arc<Notify>) {
        let refresh = Arc::new(Notify::new());
        (
            Self {
                usage: Usage::default(),
                config: Config::default(),
                opened: AtomicBool::new(false),
                refresh: refresh.clone(),
            },
            refresh,
        )
    }
}

#[interface(name = "io.github.zickrian.isle.Usage1")]
impl UsageService {
    /// JSON `{enabled, claude, codex, grok, agy, agy_claude_gpt, agy_argon, assistant, warn,
    /// critical}`, from Settings.
    fn set_config(&mut self, config: &str) -> fdo::Result<()> {
        self.config =
            serde_json::from_str(config).map_err(|err| fdo::Error::InvalidArgs(err.to_string()))?;
        crate::assistant::set_assistant_on(self.config.assistant);
        self.refresh.notify_one();
        Ok(())
    }

    /// Reads the usage again now, Claude's too.
    fn refresh(&self) {
        self.opened.store(true, Ordering::Relaxed);
        self.refresh.notify_one();
    }

    /// JSON `{providers: [{id, name, plan, windows: [{label, percent, resets_at_ms}], updated_ms, note}]}`.
    #[zbus(property)]
    fn usage(&self) -> String {
        serde_json::to_string(&self.usage).unwrap_or_default()
    }

    /// A limit passed `percent` (the warning or the critical mark) of its window.
    #[zbus(signal)]
    async fn alert(
        emitter: &SignalEmitter<'_>,
        provider: &str,
        window: &str,
        percent: f64,
        resets_at_ms: i64,
    ) -> zbus::Result<()>;
}

/// The marks already warned about, by "provider/window/reset": 1 the warning, 2 the critical one.
type Alerted = BTreeMap<String, u8>;

/// Reads the usage now and then, publishes it, and warns as limits near.
pub async fn run(iface: InterfaceRef<UsageService>, refresh: Arc<Notify>) {
    let mut store: Store<Alerted> = Store::new("usage-alerts");
    let mut alerted = store.load();
    let mut claude: Option<Provider> = None;
    let mut asked_claude: Option<Instant> = None;
    let mut claude_wait = CLAUDE_EVERY;
    // Failures in a row, and how the last ask went wrong (`None`: it did not).
    let mut failures = 0;
    let mut last_error = None;
    let mut grok: Option<Provider> = None;
    let mut asked_grok: Option<Instant> = None;
    let mut grok_wait = CLAUDE_EVERY;
    let mut grok_failures = 0;
    let mut grok_last_error = None;
    // One answer holds every Antigravity pool, so the toggles need no new ask.
    let mut agy: Option<AgyUsage> = None;
    let mut asked_agy: Option<Instant> = None;
    let mut agy_wait = AGY_AT_MOST;
    let mut agy_failures = 0;
    let mut codex = CodexReader::default();
    // Unlocking wakes the loop, to ask Claude if it came due meanwhile.
    let mut locked = crate::system::locked();
    // No timer before Settings, while usage is off, or with only Antigravity enabled.
    let mut next = None;
    let mut watch_lock = false;
    loop {
        let forced = match next {
            None => tokio::select! {
                () = refresh.notified() => true,
                Ok(()) = locked.changed(), if watch_lock => false,
            },
            Some(wait) => tokio::select! {
                () = tokio::time::sleep(wait) => false,
                () = refresh.notified() => true,
                Ok(()) = locked.changed() => false,
            },
        };
        let paused = *locked.borrow_and_update();
        let (config, opened) = {
            let service = iface.get().await;
            (
                service.config.clone(),
                service.opened.swap(false, Ordering::Relaxed),
            )
        };
        if !config.enabled {
            next = None;
            watch_lock = false;
            publish(&iface, Usage::default()).await;
            continue;
        }
        let mut providers = Vec::new();
        if config.claude && claude_sign_in().exists() {
            let due = |every| asked_claude.is_none_or(|at: Instant| at.elapsed() >= every);
            // Opening the page asks sooner, but never while Claude's server is given time after failing.
            if (forced && page_wait(last_error).is_some_and(due)) || (!paused && due(claude_wait)) {
                asked_claude = Some(Instant::now());
                let fresh = tokio::task::spawn_blocking(read_claude).await.ok();
                failures = if matches!(fresh, Some(Ok(_))) {
                    0
                } else {
                    failures + 1
                };
                last_error = match &fresh {
                    Some(Err(why)) => Some(*why),
                    _ => None,
                };
                claude_wait = wait_after(fresh.as_ref().map(|r| r.as_ref().map(|_| ())), failures);
                // Another plan than the assistant knows: it looks at the models again.
                if let Some(Ok(fresh)) = &fresh {
                    crate::assistant::plan_seen("claude", &fresh.plan);
                }
                claude = match (fresh, claude.take()) {
                    (Some(Ok(fresh)), _) => Some(fresh),
                    // The last numbers stay, saying why they are old.
                    (Some(Err(why)), Some(mut last)) => Some(Provider {
                        note: why.note().into(),
                        ..std::mem::take(&mut last)
                    }),
                    (Some(Err(why)), None) => Some(Provider {
                        note: why.note().into(),
                        ..claude_shell()
                    }),
                    (None, last) => last,
                };
            }
            providers.extend(claude.clone());
        } else if config.claude {
            claude = None;
        }
        if config.grok && grok_auth().exists() {
            let due = |every| asked_grok.is_none_or(|at: Instant| at.elapsed() >= every);
            if (forced && grok_page_wait(grok_last_error).is_some_and(due))
                || (!paused && due(grok_wait))
            {
                asked_grok = Some(Instant::now());
                let fresh = tokio::task::spawn_blocking(read_grok).await.ok();
                grok_failures = if matches!(fresh, Some(Ok(_))) {
                    0
                } else {
                    grok_failures + 1
                };
                grok_last_error = match &fresh {
                    Some(Err(why)) => Some(*why),
                    _ => None,
                };
                grok_wait = grok_wait_after(
                    fresh.as_ref().map(|r| r.as_ref().map(|_| ())),
                    grok_failures,
                );
                if let Some(Ok(fresh)) = &fresh {
                    crate::assistant::plan_seen("grok", &fresh.plan);
                }
                grok = match (fresh, grok.take()) {
                    (Some(Ok(fresh)), _) => Some(fresh),
                    (Some(Err(why)), Some(mut last)) => Some(Provider {
                        note: why.note().into(),
                        ..std::mem::take(&mut last)
                    }),
                    (Some(Err(why)), None) => Some(Provider {
                        note: why.note().into(),
                        ..grok_shell()
                    }),
                    (None, last) => last,
                };
            }
            providers.extend(grok.clone());
        } else if config.grok {
            grok = None;
        }
        let agy_start = providers.len();
        if config.agy
            && config.assistant
            && let Some(program) = agy_program()
        {
            let due = |every| asked_agy.is_none_or(|at: Instant| at.elapsed() >= every);
            if opened && !paused && due(agy_wait) {
                asked_agy = Some(Instant::now());
                // A JSON shape not understood counts as a failed read, backing off as one.
                let fresh = crate::assistant::agy_usage(&program)
                    .await
                    .and_then(|response| agy_live(&response, now_ms()));
                let outcome = fresh.as_ref().map(|_| ()).map_err(|err| *err);
                agy_failures = if outcome.is_ok() { 0 } else { agy_failures + 1 };
                agy_wait = agy_wait_after(outcome, agy_failures);
                agy = Some(match (fresh, agy.take()) {
                    (Ok(fresh), _) => fresh,
                    // The last numbers stay, saying why they are old.
                    (Err(why), Some(last)) => last.noted(agy_note(why)),
                    (Err(why), None) => AgyUsage {
                        gemini: agy_shell(agy_note(why)),
                        ..AgyUsage::default()
                    },
                });
            }
            match &agy {
                Some(agy) => providers.extend(agy_providers(agy, &config)),
                None => providers.push(agy_shell("")),
            }
        } else if config.agy && config.assistant {
            agy = None;
        }
        let agy_end = providers.len();
        if config.codex && paused && !forced {
            // Locked, nobody sees them: the last numbers stand until unlocking wakes the loop.
            providers.extend(codex.shown.clone());
        } else if config.codex {
            // File work and a request: done on a blocking thread, as Claude's request is.
            let mut reader = std::mem::take(&mut codex);
            if let Ok((back, read)) = tokio::task::spawn_blocking(move || {
                let read = reader.read(forced, paused);
                (reader, read)
            })
            .await
            {
                codex = back;
                providers.extend(read);
            }
        }
        for provider in &mut providers {
            settle(provider, now_ms());
        }
        let warnings = marks_passed(&providers, &config, &mut alerted, now_ms());
        if !warnings.is_empty() {
            store.save(&alerted);
        }
        for (provider, window, percent, resets_at_ms) in warnings {
            let emitter = iface.signal_emitter();
            if let Err(err) =
                UsageService::alert(emitter, &provider, &window, percent, resets_at_ms).await
            {
                warn!("could not send a usage alert: {err}");
            }
        }
        let due_in = |asked: Option<Instant>, wait: Duration| {
            wait.saturating_sub(asked.map_or(Duration::ZERO, |at| at.elapsed()))
        };
        let claude_due_in = claude
            .as_ref()
            .filter(|_| config.claude && !paused)
            .map(|_| due_in(asked_claude, claude_wait));
        let grok_due_in = grok
            .as_ref()
            .filter(|_| config.grok && !paused)
            .map(|_| due_in(asked_grok, grok_wait));
        let remote_due = [claude_due_in, grok_due_in].into_iter().flatten().min();
        watch_lock = config.agy && !config.claude && !config.codex && !config.grok;
        next = if watch_lock {
            None
        } else {
            let now = now_ms();
            let next_reset = [
                next_reset(&providers[..agy_start], now),
                next_reset(&providers[agy_end..], now),
            ]
            .into_iter()
            .flatten()
            .min();
            Some(next_wait(
                config.codex && !paused && codex_signed_in(),
                remote_due,
                next_reset,
            ))
        };
        publish(&iface, Usage { providers }).await;
    }
}

/// How long to sleep: until a plan asked over the network is due (`None`: not asked) or a window
/// resets, and at most a minute while Codex is signed in; otherwise only now and then, for a sign-in.
fn next_wait(
    codex_signed_in: bool,
    claude_due_in: Option<Duration>,
    next_reset: Option<Duration>,
) -> Duration {
    let longest = if codex_signed_in {
        LOCAL_EVERY
    } else {
        NOTHING_SIGNED_IN_EVERY
    };
    [claude_due_in, next_reset]
        .into_iter()
        .flatten()
        .fold(longest, Duration::min)
        .max(MIN_WAIT)
}

/// How long until the next window resets, when `settle` starts it over.
fn next_reset(providers: &[Provider], now: i64) -> Option<Duration> {
    providers
        .iter()
        .flat_map(|provider| &provider.windows)
        .filter(|window| window.resets_at_ms > now)
        .map(|window| Duration::from_millis((window.resets_at_ms - now) as u64))
        .min()
}

/// How long until Claude is asked again after `outcome` (`None` when the read itself broke), the
/// `failures`th failure in a row.
fn wait_after(outcome: Option<Result<(), &ClaudeError>>, failures: usize) -> Duration {
    match outcome {
        Some(Ok(())) => CLAUDE_EVERY,
        // Only the sign-in file was read: look again soon, for Claude Code renewing it.
        Some(Err(ClaudeError::NeedsRefresh)) => CLAUDE_AT_MOST,
        Some(Err(ClaudeError::Offline)) => OFFLINE_RETRIES
            .get(failures.saturating_sub(1))
            .copied()
            .unwrap_or(CLAUDE_EVERY),
        Some(Err(ClaudeError::SignIn)) => CLAUDE_EVERY,
        Some(Err(ClaudeError::Busy)) | None => {
            let doubled = 2u32.saturating_pow(u32::try_from(failures).unwrap_or(u32::MAX));
            CLAUDE_EVERY.saturating_mul(doubled).min(CLAUDE_BACKOFF)
        }
    }
}

/// How soon after the last ask opening the page asks Claude again, after `last` went wrong (`None`: it
/// did not); `None` while its server is given time after failing.
fn page_wait(last: Option<ClaudeError>) -> Option<Duration> {
    match last {
        Some(ClaudeError::Busy) => None,
        // Nothing reached the server: offline, or only the sign-in file was read.
        Some(ClaudeError::Offline | ClaudeError::NeedsRefresh) => Some(OFFLINE_RETRIES[0]),
        Some(ClaudeError::SignIn) | None => Some(CLAUDE_AT_MOST),
    }
}

/// Whether Codex is signed in, so its logs may yet bring limits worth a look each minute.
fn codex_signed_in() -> bool {
    crate::assistant::codex_home().join("auth.json").exists()
}

/// Stores and signals new numbers; the same ones again send nothing.
async fn publish(iface: &InterfaceRef<UsageService>, usage: Usage) {
    let mut service = iface.get_mut().await;
    if service.usage == usage {
        return;
    }
    service.usage = usage;
    if let Err(err) = service.usage_changed(iface.signal_emitter()).await {
        warn!("could not publish the AI usage: {err}");
    }
}

/// A window whose reset has passed starts over at 0, until the numbers are read again.
fn settle(provider: &mut Provider, now: i64) {
    for window in &mut provider.windows {
        if window.resets_at_ms > 0 && window.resets_at_ms <= now {
            window.percent = 0.0;
        }
    }
}

/// The marks newly passed, as (provider, window, percent, reset); each is warned about once per window.
/// An Antigravity pool is titled with its plan, as the cards share a name.
fn marks_passed(
    providers: &[Provider],
    config: &Config,
    alerted: &mut Alerted,
    now: i64,
) -> Vec<(String, String, f64, i64)> {
    // Windows that have reset are forgotten; one with no known reset (0) only once it is low again.
    alerted.retain(|key, _| {
        key.rsplit('/')
            .next()
            .and_then(|r| r.parse::<i64>().ok())
            .is_none_or(|r| r == 0 || r > now)
    });
    let mut passed = Vec::new();
    for provider in providers {
        // Antigravity's pools share a name: the alert says which one crossed the mark.
        let title = if provider.id.starts_with("agy-") && !provider.plan.is_empty() {
            format!("{} · {}", provider.name, provider.plan)
        } else {
            provider.name.clone()
        };
        for window in &provider.windows {
            let level = if window.percent >= config.critical {
                2
            } else if window.percent >= config.warn {
                1
            } else {
                0
            };
            // A reset read again a moment off (its fraction of a second changes) is the same window.
            let prefix = format!("{}/{}/", provider.id, window.label);
            let key = alerted
                .keys()
                .find(|key| {
                    key.strip_prefix(&prefix)
                        .and_then(|r| r.parse::<i64>().ok())
                        .is_some_and(|r| (r - window.resets_at_ms).abs() < 60_000)
                })
                .cloned()
                .unwrap_or_else(|| format!("{prefix}{}", window.resets_at_ms));
            if level == 0 && window.resets_at_ms == 0 {
                alerted.remove(&key);
            }
            if level > alerted.get(&key).copied().unwrap_or(0) {
                alerted.insert(key, level);
                passed.push((
                    title.clone(),
                    window.label.clone(),
                    window.percent,
                    window.resets_at_ms,
                ));
            }
        }
    }
    passed
}

/// Why Claude's limits could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaudeError {
    /// The sign-in ran out; Claude Code renews it once opened.
    NeedsRefresh,
    /// No sign-in, or the server turned it down.
    SignIn,
    /// No network (yet).
    Offline,
    /// The server failed or answered in a way not understood.
    Busy,
}

impl ClaudeError {
    /// What the page says, under the last numbers.
    fn note(self) -> &'static str {
        match self {
            ClaudeError::NeedsRefresh => "Open Claude Code to refresh its sign-in",
            ClaudeError::SignIn => "Sign in again with Claude Code",
            ClaudeError::Offline => "Offline; showing the last numbers",
            ClaudeError::Busy => "Could not reach Claude; showing the last numbers",
        }
    }
}

/// Where Claude Code keeps its sign-in.
fn claude_sign_in() -> std::path::PathBuf {
    crate::assistant::claude_config_dir().join(".credentials.json")
}

/// Claude with its plan, before any limits are read.
fn claude_shell() -> Provider {
    Provider {
        id: "claude".into(),
        name: "Claude".into(),
        // As the assistant's Settings and Claude Code name it ("Team").
        plan: crate::assistant::claude_plan(),
        ..Provider::default()
    }
}

/// Claude's limits now, with Claude Code's sign-in (read, never refreshed: that is Claude Code's to do).
fn read_claude() -> Result<Provider, ClaudeError> {
    #[cfg(test)]
    if let Some(read) = lifecycle_tests::read_claude() {
        return read;
    }
    let text = std::fs::read_to_string(claude_sign_in()).map_err(|_| ClaudeError::SignIn)?;
    let sign_in: Value = serde_json::from_str(&text).map_err(|_| ClaudeError::SignIn)?;
    let oauth = &sign_in["claudeAiOauth"];
    let token = oauth["accessToken"].as_str().ok_or(ClaudeError::SignIn)?;
    if oauth["expiresAt"]
        .as_i64()
        .is_some_and(|expires| expires <= now_ms())
    {
        return Err(ClaudeError::NeedsRefresh);
    }
    let response: Value =
        crate::http::get("https://api.anthropic.com/api/oauth/usage", CLAUDE_TIMEOUT)
            .header("Authorization", &format!("Bearer {token}"))
            .header("anthropic-beta", "oauth-2025-04-20")
            // Said plainly who asks, never another app.
            .header("User-Agent", concat!("Isle/", env!("CARGO_PKG_VERSION")))
            .call()
            .and_then(|mut reply| reply.body_mut().read_json())
            .map_err(|err| {
                warn!("could not read Claude's usage: {err}");
                match err {
                    ureq::Error::StatusCode(401 | 403) => ClaudeError::SignIn,
                    ureq::Error::StatusCode(_) | ureq::Error::Json(_) => ClaudeError::Busy,
                    _ => ClaudeError::Offline,
                }
            })?;
    Ok(Provider {
        windows: claude_windows(&response),
        updated_ms: now_ms(),
        ..claude_shell()
    })
}

/// The limits Claude reports for this plan, in its order: "5 hours", "Week", "Week · Opus"…
fn claude_windows(response: &Value) -> Vec<Window> {
    if let Some(limits) = response["limits"].as_array() {
        return limits
            .iter()
            .filter_map(|limit| {
                let label = match limit["group"].as_str().or(limit["kind"].as_str())? {
                    "session" => "5 hours".to_owned(),
                    "weekly" | "weekly_all" | "weekly_scoped" => "Week".to_owned(),
                    other => title_case(other),
                };
                let model = limit["scope"]["model"]["display_name"]
                    .as_str()
                    .filter(|m| !m.is_empty());
                Some(Window {
                    label: model.map_or(label.clone(), |model| format!("{label} · {model}")),
                    percent: limit["percent"].as_f64()?,
                    resets_at_ms: limit["resets_at"].as_str().map_or(0, rfc3339_ms),
                })
            })
            .collect();
    }
    // The older shape: one object per window.
    [
        ("five_hour", "5 hours"),
        ("seven_day", "Week"),
        ("seven_day_opus", "Week · Opus"),
    ]
    .iter()
    .filter_map(|(key, label)| {
        let window = response.get(*key).filter(|w| !w.is_null())?;
        Some(Window {
            label: (*label).into(),
            percent: window["utilization"].as_f64()?,
            resets_at_ms: window["resets_at"].as_str().map_or(0, rfc3339_ms),
        })
    })
    .collect()
}

/// Why Grok's allowance could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GrokError {
    /// The sign-in ran out; Grok renews it once opened.
    NeedsRefresh,
    /// No sign-in, or the server turned it down.
    SignIn,
    /// No network (yet).
    Offline,
    /// The server failed or answered in a way not understood.
    Busy,
}

impl GrokError {
    /// What the page says, under the last numbers.
    fn note(self) -> &'static str {
        match self {
            GrokError::NeedsRefresh => "Open Grok to refresh its sign-in",
            GrokError::SignIn => "Sign in again with Grok",
            GrokError::Offline => "Offline; showing the last numbers",
            GrokError::Busy => "Could not reach Grok; showing the last numbers",
        }
    }

    /// Grok's failures map onto Claude's, so both back off alike.
    fn as_claude(self) -> ClaudeError {
        match self {
            GrokError::NeedsRefresh => ClaudeError::NeedsRefresh,
            GrokError::SignIn => ClaudeError::SignIn,
            GrokError::Offline => ClaudeError::Offline,
            GrokError::Busy => ClaudeError::Busy,
        }
    }
}

/// Where Grok keeps its sign-in.
fn grok_auth() -> std::path::PathBuf {
    crate::assistant::grok_home().join("auth.json")
}

/// Grok with its plan, before its allowance is read.
fn grok_shell() -> Provider {
    Provider {
        id: "grok".into(),
        name: "Grok".into(),
        plan: crate::assistant::grok_plan(),
        ..Provider::default()
    }
}

/// How long until Grok is asked again; the same pauses as Claude's, it is the same kind of request.
fn grok_wait_after(outcome: Option<Result<(), &GrokError>>, failures: usize) -> Duration {
    let mapped = outcome.map(|result| result.map_err(|err| err.as_claude()));
    wait_after(
        mapped.as_ref().map(|result| result.as_ref().map(|_| ())),
        failures,
    )
}

/// Grok's take on `page_wait`.
fn grok_page_wait(last: Option<GrokError>) -> Option<Duration> {
    page_wait(last.map(GrokError::as_claude))
}

/// Grok's allowance now, with Grok's sign-in (read, never refreshed: that is Grok's to do).
fn read_grok() -> Result<Provider, GrokError> {
    #[cfg(test)]
    if let Some(read) = lifecycle_tests::read_grok() {
        return read;
    }
    Ok(grok_live(&grok_billing()?, now_ms()))
}

/// What Grok's billing says for this sign-in, as its CLI's /usage asks.
fn grok_billing() -> Result<Value, GrokError> {
    let sign_in = crate::assistant::grok_sign_in().ok_or(GrokError::SignIn)?;
    if sign_in.expires_ms > 0 && sign_in.expires_ms <= now_ms() {
        return Err(GrokError::NeedsRefresh);
    }
    let mut request = crate::http::get(&crate::assistant::grok_billing_url(), CLAUDE_TIMEOUT)
        .header("Authorization", &format!("Bearer {}", sign_in.token))
        .header("X-XAI-Token-Auth", "xai-grok-cli")
        .header("x-userid", &sign_in.user_id)
        // Said plainly who asks, never another app.
        .header("User-Agent", concat!("Isle/", env!("CARGO_PKG_VERSION")));
    if let Some(version) = crate::assistant::grok_client_version() {
        request = request.header("x-grok-client-version", &version);
    }
    let response: Value = request
        .call()
        .and_then(|mut reply| reply.body_mut().read_json())
        .map_err(|err| {
            warn!("could not read Grok's usage: {err}");
            match err {
                ureq::Error::StatusCode(401 | 403) => GrokError::SignIn,
                ureq::Error::StatusCode(_) | ureq::Error::Json(_) => GrokError::Busy,
                _ => GrokError::Offline,
            }
        })?;
    Ok(response)
}

/// The allowance Grok's /usage shows: the included share of this period, and on-demand once it is used.
fn grok_live(response: &Value, now: i64) -> Provider {
    let config = &response["config"];
    let mut windows = Vec::new();
    let resets = config["currentPeriod"]["end"]
        .as_str()
        .or(config["billingPeriodEnd"].as_str())
        .map(rfc3339_ms)
        .unwrap_or(0);
    if let Some(percent) = config["creditUsagePercent"].as_f64() {
        windows.push(Window {
            label: grok_period(config["currentPeriod"]["type"].as_str().unwrap_or_default()),
            percent,
            resets_at_ms: resets,
        });
    } else if let (Some(limit), Some(used)) = (
        config["monthlyLimit"]["val"]
            .as_i64()
            .or(config["monthly_limit"]["val"].as_i64()),
        config["used"]["val"].as_i64(),
    ) && limit > 0
    {
        windows.push(Window {
            label: "Month".into(),
            percent: used as f64 / limit as f64 * 100.0,
            resets_at_ms: resets,
        });
    }
    let cap = config["onDemandCap"]["val"].as_i64().unwrap_or(0);
    let extra = config["onDemandUsed"]["val"].as_i64().unwrap_or(0);
    if cap > 0 && extra > 0 {
        windows.push(Window {
            label: "On demand".into(),
            percent: extra as f64 / cap as f64 * 100.0,
            resets_at_ms: resets,
        });
    }
    // A Free plan reports its week but no share of it: nothing to draw, so the page says why.
    let empty = if windows.is_empty() {
        "Grok doesn’t share how much of this plan is used".into()
    } else {
        String::new()
    };
    Provider {
        windows,
        updated_ms: now,
        empty,
        ..grok_shell()
    }
}

/// Grok's period type ("WEEKLY") as a window label.
fn grok_period(kind: &str) -> String {
    let kind = kind.to_ascii_lowercase();
    if kind.contains("week") {
        "Week".into()
    } else if kind.contains("month") {
        "Month".into()
    } else if kind.contains("day") {
        "Day".into()
    } else {
        "Limit".into()
    }
}

/// Antigravity's plan and limits, as one `agy --print /usage` answers for every pool at once: the Gemini
/// card always shows, the Claude & GPT and Argon ones when Settings turns them on, from that same answer.
#[derive(Debug, Clone, Default, PartialEq)]
struct AgyUsage {
    gemini: Provider,
    claude_gpt: Option<Provider>,
    argon: Option<Provider>,
}

impl AgyUsage {
    /// The same numbers, saying why they are old.
    fn noted(mut self, note: &str) -> Self {
        self.gemini.note = note.into();
        for pool in self.claude_gpt.iter_mut().chain(self.argon.iter_mut()) {
            pool.note = note.into();
        }
        self
    }
}

/// The cards Settings asks for, from one answer: Gemini always, the other pools when turned on.
fn agy_providers(agy: &AgyUsage, config: &Config) -> Vec<Provider> {
    let mut providers = vec![agy.gemini.clone()];
    if config.agy_claude_gpt {
        providers.extend(agy.claude_gpt.clone());
    }
    if config.agy_argon {
        providers.extend(agy.argon.clone());
    }
    providers
}

/// A pool of Antigravity's limits: each one a card of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgyPool {
    Gemini,
    ClaudeGpt,
    Argon,
}

/// The pool `group` holds, from its name and its buckets' ids ("gemini-5h", "3p-weekly", "gemini-argon-…").
fn agy_pool(group: &Value) -> Option<AgyPool> {
    let name = group["name"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let starts = |prefix: &str| {
        group["buckets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|bucket| bucket["id"].as_str())
            .any(|id| id.starts_with(prefix))
    };
    if name.contains("argon") || starts("gemini-argon") {
        Some(AgyPool::Argon)
    } else if name.contains("claude") || name.contains("gpt") || starts("3p-") {
        Some(AgyPool::ClaudeGpt)
    } else if name.contains("gemini") || starts("gemini-") {
        Some(AgyPool::Gemini)
    } else {
        None
    }
}

/// One bucket's window, when what it says is left is a real share of the limit.
fn agy_window(bucket: &Value) -> Option<Window> {
    let remaining = bucket["remaining_fraction"].as_f64()?;
    if !remaining.is_finite() || !(0.0..=1.0).contains(&remaining) {
        return None;
    }
    Some(Window {
        label: agy_label(bucket["window"].as_str().unwrap_or_default()),
        percent: (1.0 - remaining).clamp(0.0, 1.0) * 100.0,
        resets_at_ms: bucket["reset_time"].as_str().map_or(0, rfc3339_ms),
    })
}

/// A group's buckets as windows, the 5-hour session above the week: agy lists the week first.
fn agy_windows(buckets: &[Value]) -> Vec<Window> {
    let mut windows: Vec<Window> = buckets.iter().filter_map(agy_window).collect();
    windows.sort_by_key(|window| window.label != "5 hours");
    windows
}

/// A bucket's window kind as a label: "5h" reads "5 hours", "weekly" "Week".
fn agy_label(window: &str) -> String {
    match window {
        "5h" => "5 hours".into(),
        "weekly" => "Week".into(),
        "daily" => "Day".into(),
        "" => "Limit".into(),
        other => title_case(other),
    }
}

/// Antigravity's answer to `agy --print /usage --output-format json` as the cards it holds, read at `now`.
fn agy_live(response: &Value, now: i64) -> Result<AgyUsage, AgyUsageError> {
    let data = &response["command"]["data"];
    let groups = data["groups"].as_array().ok_or(AgyUsageError::Busy)?;
    let mut gemini = Vec::new();
    let mut claude_gpt = Vec::new();
    let mut argon = Vec::new();
    for group in groups {
        let Some(buckets) = group["buckets"].as_array() else {
            continue;
        };
        match agy_pool(group) {
            Some(AgyPool::Gemini) => gemini.extend(agy_windows(buckets)),
            Some(AgyPool::ClaudeGpt) => claude_gpt.extend(agy_windows(buckets)),
            Some(AgyPool::Argon) => argon.extend(agy_windows(buckets)),
            None => {}
        }
    }
    // Argon's separate quota is what a paid plan has; agy names the tier only when it says anything at all.
    let paid_pro = groups.iter().any(|group| {
        let quota = group["description"].as_str().unwrap_or_default();
        matches!(agy_pool(group), Some(AgyPool::Argon)) || quota.contains("For paid Pro plans")
    });
    let plan = if paid_pro {
        "Pro".to_owned()
    } else {
        data["plan"].as_str().map_or_else(String::new, title_case)
    };
    let usage = AgyUsage {
        gemini: Provider {
            id: "agy".into(),
            name: "Antigravity".into(),
            plan,
            windows: gemini,
            updated_ms: now,
            ..Provider::default()
        },
        claude_gpt: (!claude_gpt.is_empty()).then(|| Provider {
            id: "agy-claude-gpt".into(),
            name: "Antigravity".into(),
            plan: "Claude & GPT".into(),
            windows: claude_gpt,
            updated_ms: now,
            ..Provider::default()
        }),
        argon: (!argon.is_empty()).then(|| Provider {
            id: "agy-argon".into(),
            name: "Antigravity".into(),
            plan: "Argon".into(),
            windows: argon,
            updated_ms: now,
            ..Provider::default()
        }),
    };
    if usage.gemini.windows.is_empty() && usage.claude_gpt.is_none() && usage.argon.is_none() {
        return Err(AgyUsageError::Busy);
    }
    Ok(usage)
}

/// What the page says under Antigravity's last numbers, and what it says with none.
fn agy_note(err: AgyUsageError) -> &'static str {
    match err {
        AgyUsageError::NeedsUpdate => "Update Antigravity (agy) to 1.1.11 or newer",
        AgyUsageError::SignIn => "Sign in again with Antigravity",
        AgyUsageError::Offline => "Offline; showing the last numbers",
        AgyUsageError::Busy => "Could not reach Antigravity; showing the last numbers",
    }
}

/// How long to wait before another page-open read after an Antigravity outcome.
fn agy_wait_after(outcome: Result<(), AgyUsageError>, failures: usize) -> Duration {
    match outcome {
        Ok(()) | Err(AgyUsageError::SignIn) => AGY_AT_MOST,
        Err(AgyUsageError::Offline) => OFFLINE_RETRIES
            .get(failures.saturating_sub(1))
            .copied()
            .unwrap_or(AGY_AT_MOST),
        Err(AgyUsageError::NeedsUpdate | AgyUsageError::Busy) => CLAUDE_BACKOFF,
    }
}

/// Antigravity with no limits to show, saying why.
fn agy_shell(note: &str) -> Provider {
    Provider {
        id: "agy".into(),
        name: "Antigravity".into(),
        note: note.into(),
        ..Provider::default()
    }
}

/// `agy`, when it is installed and signed in: nothing is asked of it otherwise.
fn agy_program() -> Option<PathBuf> {
    if !crate::assistant::agy_signed_in() {
        return None;
    }
    crate::assistant::Provider::Agy.program()
}

/// ChatGPT's plan and limits: asked as Codex's /status does, as often as Claude's, and in between as Codex
/// last saw them in its logs (read again only when its newest log changed).
#[derive(Default)]
struct CodexReader {
    seen: Option<(PathBuf, std::time::SystemTime)>,
    last: Option<Provider>,
    live: Option<Provider>,
    asked: Option<Instant>,
    /// What `read` gave last, shown again while the screen is locked.
    shown: Option<Provider>,
}

impl CodexReader {
    /// The newest of what ChatGPT said and what Codex logged, with the plan as ChatGPT says it now (an
    /// upgrade shows at once); `None` without Codex. `forced`: the page opened; `paused`: the screen is locked.
    fn read(&mut self, forced: bool, paused: bool) -> Option<Provider> {
        let due = |every| self.asked.is_none_or(|at: Instant| at.elapsed() >= every);
        if (forced && due(CLAUDE_AT_MOST)) || (!paused && due(CLAUDE_EVERY)) {
            self.asked = Some(Instant::now());
            // Failed (offline, signed out), the last answer stands and the logs fill in.
            if let Some(fresh) = read_codex_live() {
                // Another plan than the assistant knows: it looks at the models again.
                crate::assistant::plan_seen("codex", &fresh.plan);
                self.live = Some(fresh);
            }
        }
        let logged = self.read_logs();
        self.shown = match (self.live.clone(), logged) {
            (Some(live), Some(logged)) if logged.updated_ms > live.updated_ms => Some(Provider {
                plan: live.plan,
                ..logged
            }),
            (Some(live), _) => Some(live),
            (None, logged) => logged,
        };
        self.shown.clone()
    }

    /// The limits in Codex's newest logs. Both the user's Codex and Isle's are looked at.
    fn read_logs(&mut self) -> Option<Provider> {
        // Each folder's newest, so a long history of the user's own never hides Isle's fresh ones.
        let mut files = Vec::new();
        for sessions in [
            crate::assistant::codex_home().join("sessions"),
            crate::store::data_dir().join("codex/sessions"),
        ] {
            let mut newest = Vec::new();
            newest_logs(&sessions, &mut newest);
            files.extend(newest);
        }
        let modified = |file: &PathBuf| std::fs::metadata(file).and_then(|m| m.modified()).ok();
        files.sort_by_key(|file| std::cmp::Reverse(modified(file)));
        let newest = files
            .first()
            .and_then(|file| Some((file.clone(), modified(file)?)));
        if newest.is_some() && newest == self.seen {
            return self.last.clone();
        }
        self.seen = newest;
        self.last = files
            .iter()
            .take(CODEX_FILES)
            .find_map(|file| codex_limits(file));
        self.last.clone()
    }
}

/// ChatGPT's plan and limits now, with Codex's sign-in (read, never refreshed: that is Codex's to do);
/// `None` when signed out, offline or refused.
fn read_codex_live() -> Option<Provider> {
    let text = std::fs::read_to_string(crate::assistant::codex_home().join("auth.json")).ok()?;
    let sign_in: Value = serde_json::from_str(&text).ok()?;
    let token = sign_in["tokens"]["access_token"].as_str()?;
    let mut request = crate::http::get(CODEX_USAGE, CLAUDE_TIMEOUT)
        .header("Authorization", &format!("Bearer {token}"))
        // Said plainly who asks, never another app.
        .header("User-Agent", concat!("Isle/", env!("CARGO_PKG_VERSION")));
    if let Some(account) = sign_in["tokens"]["account_id"].as_str() {
        request = request.header("ChatGPT-Account-Id", account);
    }
    let response: Value = request
        .call()
        .and_then(|mut reply| reply.body_mut().read_json())
        .map_err(|err| warn!("could not read ChatGPT's usage: {err}"))
        .ok()?;
    Some(codex_live(&response, now_ms()))
}

/// The answer of ChatGPT's usage endpoint as a provider read at `now`.
fn codex_live(response: &Value, now: i64) -> Provider {
    let limits = &response["rate_limit"];
    let windows = ["primary_window", "secondary_window"]
        .iter()
        .filter_map(|key| {
            let window = limits.get(*key).filter(|w| !w.is_null())?;
            Some(Window {
                label: window_label(window["limit_window_seconds"].as_i64().unwrap_or(0) / 60),
                percent: window["used_percent"].as_f64()?,
                resets_at_ms: window["reset_at"].as_i64().map_or(0, |s| s * 1000),
            })
        })
        .collect();
    Provider {
        id: "codex".into(),
        name: "ChatGPT".into(),
        plan: crate::assistant::codex_plan(response["plan_type"].as_str().unwrap_or_default()),
        windows,
        updated_ms: now,
        ..Provider::default()
    }
}

/// The newest limits in one Codex log, from its last part.
fn codex_limits(file: &Path) -> Option<Provider> {
    use std::io::{Read, Seek, SeekFrom};
    let mut log = std::fs::File::open(file).ok()?;
    let length = log.metadata().ok()?.len();
    log.seek(SeekFrom::Start(length.saturating_sub(CODEX_TAIL)))
        .ok()?;
    let mut tail = Vec::new();
    log.read_to_end(&mut tail).ok()?;
    let text = String::from_utf8_lossy(&tail);
    let (limits, at) = text.lines().rev().find_map(|line| {
        // Most lines are messages; only parse the ones that can hold limits.
        if !line.contains("rate_limits") {
            return None;
        }
        let event: Value = serde_json::from_str(line).ok()?;
        let limits = find_key(&event, "rate_limits")?.clone();
        Some((limits, event["timestamp"].as_str().map_or(0, rfc3339_ms)))
    })?;
    let modified = std::fs::metadata(file)
        .and_then(|m| m.modified())
        .map(|t| chrono::DateTime::<chrono::Local>::from(t).timestamp_millis())
        .unwrap_or(0);
    Some(Provider {
        id: "codex".into(),
        name: "ChatGPT".into(),
        plan: crate::assistant::codex_plan(limits["plan_type"].as_str().unwrap_or_default()),
        windows: codex_windows(&limits),
        updated_ms: if at > 0 { at } else { modified },
        note: "As of Codex’s last use".into(),
        ..Provider::default()
    })
}

/// Codex's session logs, newest first: sessions/<year>/<month>/<day>/*.jsonl.
fn newest_logs(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    entries.sort_by(|a, b| b.cmp(a));
    for path in entries {
        if files.len() >= CODEX_FILES {
            return;
        }
        if path.is_dir() {
            newest_logs(&path, files);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            files.push(path);
        }
    }
}

/// The primary and secondary limits ChatGPT reports.
fn codex_windows(limits: &Value) -> Vec<Window> {
    ["primary", "secondary"]
        .iter()
        .filter_map(|key| {
            let window = limits.get(*key).filter(|w| !w.is_null())?;
            Some(Window {
                label: window_label(window["window_minutes"].as_i64().unwrap_or(0)),
                percent: window["used_percent"].as_f64()?,
                resets_at_ms: window["resets_at"].as_i64().map_or(0, |s| s * 1000),
            })
        })
        .collect()
}

/// A window of `minutes` as people say it: "5 hours", "Week", "30 days".
fn window_label(minutes: i64) -> String {
    match minutes {
        300 => "5 hours".to_owned(),
        10080 => "Week".to_owned(),
        m if m > 0 && m % 1440 == 0 => format!("{} days", m / 1440),
        m if m > 0 => format!("{} hours", (m + 30) / 60),
        _ => "Limit".to_owned(),
    }
}

/// The first value under `key`, at any depth.
fn find_key<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map
            .get(key)
            .filter(|v| !v.is_null())
            .or_else(|| map.values().find_map(|v| find_key(v, key))),
        Value::Array(items) => items.iter().find_map(|v| find_key(v, key)),
        _ => None,
    }
}

/// 0 when the time does not parse.
fn rfc3339_ms(text: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(text).map_or(0, |t| t.timestamp_millis())
}

/// A limit's kind as a label: "weekly_opus" reads "Weekly Opus".
fn title_case(text: &str) -> String {
    text.split(['_', ' '])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or(String::new(), |first| {
                first.to_uppercase().chain(chars).collect()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_chatgpts_plan_and_limits_as_status_does() {
        // A free account, as the endpoint answered on 2026-10-26: one 30-day window.
        let free = json!({"plan_type": "free", "rate_limit": {"allowed": true, "limit_reached": false,
            "primary_window": {"used_percent": 82, "limit_window_seconds": 2_592_000,
                "reset_after_seconds": 2_464_312, "reset_at": 1_795_444_424},
            "secondary_window": null}});
        let codex = codex_live(&free, 1_000);
        assert_eq!((codex.id.as_str(), codex.plan.as_str()), ("codex", "Free"));
        assert_eq!(codex.updated_ms, 1_000);
        assert_eq!(
            codex.windows,
            [Window {
                label: "30 days".into(),
                percent: 82.0,
                resets_at_ms: 1_795_444_424_000
            }]
        );
        // A paid one: 5 hours and a week.
        let pro = json!({"plan_type": "prolite", "rate_limit": {
            "primary_window": {"used_percent": 5, "limit_window_seconds": 18_000, "reset_at": 10},
            "secondary_window": {"used_percent": 23, "limit_window_seconds": 604_800, "reset_at": 20}}});
        let codex = codex_live(&pro, 0);
        // As Codex names it.
        assert_eq!(codex.plan, "Pro");
        let labels: Vec<&str> = codex.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["5 hours", "Week"]);
    }

    #[test]
    fn reads_groks_weekly_allowance() {
        // As Grok's billing endpoint answered: one weekly pool, on-demand unused, products are slices of it.
        let response = json!({"config": {
            "creditUsagePercent": 51.0,
            "currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY",
                "end": "2026-10-27T09:17:29.281618+00:00"},
            "onDemandCap": {"val": 10},
            "onDemandUsed": {"val": 0},
            "productUsage": [{"product": "GrokBuild", "usagePercent": 14.0}]
        }});
        let grok = grok_live(&response, 1_000);
        assert_eq!((grok.id.as_str(), grok.name.as_str()), ("grok", "Grok"));
        assert_eq!(grok.updated_ms, 1_000);
        assert_eq!(grok.windows.len(), 1);
        assert_eq!(grok.windows[0].label, "Week");
        assert_eq!(grok.windows[0].percent, 51.0);
        assert!(grok.windows[0].resets_at_ms > 0);
        // On-demand shows once it is actually used.
        let over = json!({"config": {"creditUsagePercent": 100.0,
            "currentPeriod": {"type": "USAGE_PERIOD_TYPE_MONTHLY", "end": "2026-11-01T00:00:00Z"},
            "onDemandCap": {"val": 500}, "onDemandUsed": {"val": 125}}});
        let grok = grok_live(&over, 0);
        let labels: Vec<&str> = grok.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["Month", "On demand"]);
        assert_eq!(grok.windows[1].percent, 25.0);
    }

    #[test]
    fn sleeps_until_something_is_due() {
        let minutes = |m: u64| Duration::from_secs(m * 60);
        // Codex signed in: its logs each minute.
        assert_eq!(next_wait(true, Some(minutes(10)), None), LOCAL_EVERY);
        // Only Claude: until it is due, not each minute.
        assert_eq!(next_wait(false, Some(minutes(10)), None), minutes(10));
        assert_eq!(next_wait(false, Some(minutes(60)), None), minutes(30));
        // A window that resets sooner wakes it, to start that window over.
        assert_eq!(
            next_wait(false, Some(minutes(10)), Some(minutes(3))),
            minutes(3)
        );
        // Claude not asked (locked, or signed out): only for a sign-in.
        assert_eq!(next_wait(false, None, None), NOTHING_SIGNED_IN_EVERY);
        // Overdue never spins.
        assert_eq!(next_wait(true, Some(Duration::ZERO), None), MIN_WAIT);
    }

    #[test]
    fn finds_the_next_reset() {
        let provider = |resets: &[i64]| Provider {
            windows: resets
                .iter()
                .map(|&resets_at_ms| Window {
                    resets_at_ms,
                    ..Window::default()
                })
                .collect(),
            ..Provider::default()
        };
        let providers = [provider(&[0, 5_000]), provider(&[900, 3_000])];
        assert_eq!(
            next_reset(&providers, 1_000),
            Some(Duration::from_millis(2_000))
        );
        assert_eq!(next_reset(&providers, 6_000), None);
    }

    #[test]
    fn offline_is_tried_again_soon_and_a_failing_server_ever_later() {
        let offline = Some(Err(&ClaudeError::Offline));
        let waits: Vec<u64> = (1..=6).map(|n| wait_after(offline, n).as_secs()).collect();
        assert_eq!(waits, [30, 60, 120, 300, 600, 600]);
        let busy = Some(Err(&ClaudeError::Busy));
        assert_eq!(wait_after(busy, 1), CLAUDE_EVERY * 2);
        assert_eq!(wait_after(busy, 9), CLAUDE_BACKOFF);
        assert_eq!(wait_after(Some(Ok(())), 0), CLAUDE_EVERY);
        assert_eq!(
            wait_after(Some(Err(&ClaudeError::NeedsRefresh)), 3),
            CLAUDE_AT_MOST
        );
    }

    #[test]
    fn opening_the_page_asks_claude_at_most_every_two_minutes() {
        assert_eq!(page_wait(None), Some(CLAUDE_AT_MOST));
        assert_eq!(page_wait(Some(ClaudeError::SignIn)), Some(CLAUDE_AT_MOST));
        assert_eq!(
            page_wait(Some(ClaudeError::Offline)),
            Some(OFFLINE_RETRIES[0])
        );
        assert_eq!(page_wait(Some(ClaudeError::Busy)), None);
    }

    #[test]
    fn reads_claudes_limits_whatever_the_plan_has() {
        let team = json!({"five_hour": {"utilization": 21.0}, "limits": [
            {"kind": "session", "group": "session", "percent": 21, "resets_at": "2026-10-21T16:10:00+00:00"},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 0, "resets_at": "2026-10-24T21:00:00+00:00",
             "scope": {"model": {"display_name": "Fable"}}}]});
        let windows = claude_windows(&team);
        assert_eq!(windows.len(), 2);
        assert_eq!(
            (windows[0].label.as_str(), windows[0].percent),
            ("5 hours", 21.0)
        );
        assert_eq!(
            windows[0].resets_at_ms,
            rfc3339_ms("2026-10-21T16:10:00+00:00")
        );
        assert_eq!(windows[1].label, "Week · Fable");
        let older = json!({"five_hour": {"utilization": 4.0, "resets_at": null}, "seven_day": {"utilization": 31.5},
            "seven_day_opus": null});
        let windows = claude_windows(&older);
        assert_eq!(
            windows.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(),
            ["5 hours", "Week"]
        );
    }

    #[test]
    fn reads_what_codex_saw() {
        let pro = json!({"primary": {"used_percent": 9.0, "window_minutes": 10080, "resets_at": 1793084579},
            "secondary": null, "plan_type": "prolite"});
        let windows = codex_windows(&pro);
        assert_eq!(windows.len(), 1);
        assert_eq!(
            (windows[0].label.as_str(), windows[0].percent),
            ("Week", 9.0)
        );
        assert_eq!(windows[0].resets_at_ms, 1_793_084_579_000);
        assert_eq!(crate::assistant::codex_plan("prolite"), "Pro");
        let plus = json!({"primary": {"used_percent": 50.0, "window_minutes": 300}, "secondary":
            {"used_percent": 20.0, "window_minutes": 10080}});
        let labels: Vec<_> = codex_windows(&plus).into_iter().map(|w| w.label).collect();
        assert_eq!(labels, ["5 hours", "Week"]);
        let line = json!({"timestamp": "2026-10-21T08:59:00Z", "payload": {"info": {}, "rate_limits": pro}});
        assert_eq!(
            find_key(&line, "rate_limits").unwrap()["plan_type"],
            "prolite"
        );
    }

    #[test]
    fn warns_once_per_mark_and_window() {
        let config = Config {
            enabled: true,
            ..Config::default()
        };
        let mut alerted = Alerted::new();
        let at = |percent: f64| {
            vec![Provider {
                id: "claude".into(),
                name: "Claude".into(),
                windows: vec![Window {
                    label: "5 hours".into(),
                    percent,
                    resets_at_ms: 2_000,
                }],
                ..Provider::default()
            }]
        };
        assert!(marks_passed(&at(50.0), &config, &mut alerted, 1_000).is_empty());
        assert_eq!(
            marks_passed(&at(82.0), &config, &mut alerted, 1_000).len(),
            1
        );
        assert!(marks_passed(&at(85.0), &config, &mut alerted, 1_000).is_empty());
        assert_eq!(
            marks_passed(&at(96.0), &config, &mut alerted, 1_000).len(),
            1
        );
        assert!(marks_passed(&at(99.0), &config, &mut alerted, 1_000).is_empty());
        // Once the window has reset, it may warn again.
        assert!(marks_passed(&[], &config, &mut alerted, 3_000).is_empty() && alerted.is_empty());
    }

    #[test]
    fn a_reset_read_a_moment_off_is_the_same_window() {
        let config = Config {
            enabled: true,
            ..Config::default()
        };
        let mut alerted = Alerted::new();
        let at = |percent: f64, resets_at_ms: i64| {
            vec![Provider {
                id: "claude".into(),
                name: "Claude".into(),
                windows: vec![Window {
                    label: "5 hours".into(),
                    percent,
                    resets_at_ms,
                }],
                ..Provider::default()
            }]
        };
        let reset = 1_793_084_579_000;
        assert_eq!(
            marks_passed(&at(82.0, reset + 123), &config, &mut alerted, 1_000).len(),
            1
        );
        assert!(marks_passed(&at(83.0, reset + 456), &config, &mut alerted, 2_000).is_empty());
        assert!(marks_passed(&at(84.0, reset - 80), &config, &mut alerted, 3_000).is_empty());
        assert_eq!(
            marks_passed(&at(96.0, reset + 7), &config, &mut alerted, 4_000).len(),
            1
        );
        // The next window, hours later, warns again.
        let next = reset + 5 * 3600 * 1000;
        assert_eq!(
            marks_passed(&at(82.0, next), &config, &mut alerted, 5_000).len(),
            1
        );
    }

    #[test]
    fn a_limit_with_no_known_reset_warns_once_until_it_is_low_again() {
        let config = Config {
            enabled: true,
            ..Config::default()
        };
        let mut alerted = Alerted::new();
        let at = |percent: f64| {
            vec![Provider {
                id: "codex".into(),
                name: "ChatGPT".into(),
                windows: vec![Window {
                    label: "Week".into(),
                    percent,
                    resets_at_ms: 0,
                }],
                ..Provider::default()
            }]
        };
        assert_eq!(
            marks_passed(&at(85.0), &config, &mut alerted, 1_000).len(),
            1
        );
        // A minute later, and later still: no repeat.
        assert!(marks_passed(&at(85.0), &config, &mut alerted, 61_000).is_empty());
        assert!(marks_passed(&at(86.0), &config, &mut alerted, 121_000).is_empty());
        // Low again (a reset nobody announced), then high: a new warning.
        assert!(marks_passed(&at(5.0), &config, &mut alerted, 181_000).is_empty());
        assert_eq!(
            marks_passed(&at(83.0), &config, &mut alerted, 241_000).len(),
            1
        );
    }

    #[test]
    fn reads_the_newest_limits_from_the_end_of_a_codex_log() {
        let file = std::env::temp_dir().join(format!("isle-codex-{}.jsonl", std::process::id()));
        let line = |percent: f64| {
            json!({"timestamp": "2026-10-21T08:00:00Z", "payload": {"rate_limits": {"plan_type": "plus",
                "primary": {"used_percent": percent, "window_minutes": 300, "resets_at": 1793084579}}}})
            .to_string()
        };
        let filler = "x".repeat(300 * 1024);
        std::fs::write(
            &file,
            format!(
                "{}\n{filler}\n{}\n{{\"other\":1}}\n",
                line(10.0),
                line(42.0)
            ),
        )
        .unwrap();
        let codex = codex_limits(&file).unwrap();
        assert_eq!(
            (codex.plan.as_str(), codex.windows[0].percent),
            ("Plus", 42.0)
        );
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn a_window_past_its_reset_starts_over() {
        let mut provider = Provider {
            windows: vec![Window {
                label: "Week".into(),
                percent: 70.0,
                resets_at_ms: 1_000,
            }],
            ..Provider::default()
        };
        settle(&mut provider, 2_000);
        assert_eq!(provider.windows[0].percent, 0.0);
    }

    /// `agy --print /usage --output-format json`'s answer, as agy 1.4.12 writes it.
    fn agy_response() -> Value {
        json!({"status": "SUCCESS", "command": {"name": "usage", "data": {
            "description": "Within each group, models share a weekly limit and a 5-hour limit.",
            "groups": [
                {"name": "Gemini Models", "description": "Models within this group: Gemini Flash, Gemini Pro",
                 "buckets": [
                    {"id": "gemini-weekly", "name": "Weekly Limit Remaining", "window": "weekly",
                     "remaining_fraction": 0.9862579703330994, "reset_time": "2026-11-08T13:18:53Z"},
                    {"id": "gemini-5h", "name": "Five Hour Limit Remaining", "window": "5h",
                     "remaining_fraction": 0.9723628759384155, "reset_time": "2026-11-01T18:18:53Z"}]},
                {"name": "Claude and GPT models", "description": "Models within this group: GPT-OSS",
                 "buckets": [
                    {"id": "3p-weekly", "name": "Weekly Limit Remaining", "window": "weekly",
                     "remaining_fraction": 1, "reset_time": "2026-11-08T14:19:27Z"},
                    {"id": "3p-5h", "name": "Five Hour Limit Remaining", "window": "5h",
                     "remaining_fraction": 1, "reset_time": "2026-11-01T19:19:27Z"}]},
                {"name": "Gemini 4 Argon",
                 "description": "For paid Pro plans, Argon quota is separate.",
                 "buckets": [
                    {"id": "gemini-argon-wtu-weekly", "name": "Gemini 4 Argon Weekly Limit",
                     "window": "weekly", "remaining_fraction": 0.8144966959953308,
                     "reset_time": "2026-11-08T13:49:46Z"}]}]}}})
    }

    /// A card's limits' labels, top to bottom.
    fn labels(provider: &Provider) -> Vec<&str> {
        provider.windows.iter().map(|w| w.label.as_str()).collect()
    }

    /// The cards' ids, in the order they show.
    fn ids(providers: &[Provider]) -> Vec<&str> {
        providers.iter().map(|p| p.id.as_str()).collect()
    }

    /// The same cards with every limit at `percent`, as a warning sees them.
    fn at_percent(providers: &[Provider], percent: f64) -> Vec<Provider> {
        let mut marked = providers.to_vec();
        for provider in &mut marked {
            for window in &mut provider.windows {
                window.percent = percent;
            }
        }
        marked
    }

    #[test]
    fn reads_antigravitys_groups_into_cards() {
        let usage = agy_live(&agy_response(), 1_000).unwrap();
        // agy lists the week first; the cards show the 5-hour session on top.
        assert_eq!(labels(&usage.gemini), ["5 hours", "Week"]);
        assert_eq!(usage.gemini.id, "agy");
        assert_eq!(usage.gemini.name, "Antigravity");
        // Argon's separate quota is what a paid plan has.
        assert_eq!(usage.gemini.plan, "Pro");
        assert_eq!(usage.gemini.updated_ms, 1_000);
        // What is left, as the share used, and when that starts over.
        let used = usage.gemini.windows[0].percent;
        assert!((used - 2.7637).abs() < 0.01, "{used}");
        let reset = rfc3339_ms("2026-11-01T18:18:53Z");
        assert_eq!(usage.gemini.windows[0].resets_at_ms, reset);
        let claude_gpt = usage.claude_gpt.as_ref().unwrap();
        assert_eq!(labels(claude_gpt), ["5 hours", "Week"]);
        assert_eq!(claude_gpt.id, "agy-claude-gpt");
        assert_eq!(claude_gpt.name, "Antigravity");
        assert_eq!(claude_gpt.plan, "Claude & GPT");
        // A limit with nothing used says so.
        assert_eq!(claude_gpt.windows[1].percent, 0.0);
        let argon = usage.argon.as_ref().unwrap();
        assert_eq!(argon.id, "agy-argon");
        assert_eq!(argon.name, "Antigravity");
        assert_eq!(argon.plan, "Argon");
        assert_eq!(labels(argon), ["Week"]);
        let used = argon.windows[0].percent;
        assert!((used - 18.55).abs() < 0.01, "{used}");
        // The pools show only when Settings turns them on, all from this one answer.
        let default_cards = agy_providers(&usage, &Config::default());
        assert_eq!(ids(&default_cards), ["agy"]);
        let pools = Config {
            agy_claude_gpt: true,
            ..Config::default()
        };
        let gemini_and_claude = agy_providers(&usage, &pools);
        assert_eq!(ids(&gemini_and_claude), ["agy", "agy-claude-gpt"]);
        let all = Config {
            agy_claude_gpt: true,
            agy_argon: true,
            ..Config::default()
        };
        let every_card = agy_providers(&usage, &all);
        assert_eq!(ids(&every_card), ["agy", "agy-claude-gpt", "agy-argon"]);
        // A warning says which pool crossed the mark, as the cards share a name.
        let warned = at_percent(&every_card, 99.0);
        let mut titles: Vec<String> = marks_passed(&warned, &all, &mut Alerted::new(), 1_000)
            .into_iter()
            .map(|(title, ..)| title)
            .collect();
        titles.sort();
        titles.dedup();
        assert_eq!(
            titles,
            [
                "Antigravity",
                "Antigravity · Argon",
                "Antigravity · Claude & GPT"
            ]
        );
    }

    #[test]
    fn classifies_antigravitys_groups_and_skips_unusable_buckets() {
        // Groups told apart by their buckets' ids, as an agy naming them otherwise would.
        let response = json!({"command": {"data": {"groups": [
            {"name": "", "buckets": [
                {"id": "gemini-5h", "window": "5h", "remaining_fraction": 0.5, "reset_time": null},
                // Not a share of anything: dropped, never drawn as a made-up number.
                {"id": "gemini-weekly", "window": "weekly", "remaining_fraction": 1.5},
                {"id": "gemini-weekly", "window": "weekly", "remaining_fraction": -0.2},
                {"id": "gemini-weekly", "window": "weekly", "remaining_fraction": "0.5"},
                {"id": "gemini-weekly", "window": "weekly", "remaining_fraction": null},
                {"id": "gemini-weekly", "window": "weekly"},
                {"id": "gemini-weekly", "window": "weekly", "remaining_fraction": 0.75,
                 "reset_time": "not a time"}]},
            {"name": "Claude and GPT models", "buckets": [
                {"id": "3p-5h", "window": "daily", "remaining_fraction": 1,
                 "reset_time": "2026-11-01T19:19:27Z"}]}]}}});
        let usage = agy_live(&response, 0).unwrap();
        // The 5-hour session first; a reset nobody gave (0) and one that does not parse stay 0.
        assert_eq!(labels(&usage.gemini), ["5 hours", "Week"]);
        assert_eq!(usage.gemini.windows[0].percent, 50.0);
        assert_eq!(usage.gemini.windows[0].resets_at_ms, 0);
        assert_eq!(usage.gemini.windows[1].percent, 25.0);
        assert_eq!(usage.gemini.windows[1].resets_at_ms, 0);
        // A pool named only by its buckets, its day window labelled as people say it.
        let claude_gpt = usage.claude_gpt.as_ref().unwrap();
        assert_eq!(claude_gpt.windows[0].label, "Day");
        assert_eq!(claude_gpt.windows[0].percent, 0.0);
        let reset = rfc3339_ms("2026-11-01T19:19:27Z");
        assert_eq!(claude_gpt.windows[0].resets_at_ms, reset);
        // No Argon group and no tier named: the plan stays empty.
        assert!(usage.argon.is_none());
        assert_eq!(usage.gemini.plan, "");
        // A group of another kind is not drawn; with nothing usable at all, the read failed.
        let other = json!({"command": {"data": {"groups": [
            {"name": "Something else", "buckets": [{"id": "other-5h", "remaining_fraction": 0}]}]}}});
        assert_eq!(agy_live(&other, 0), Err(AgyUsageError::Busy));
        assert_eq!(
            agy_live(&json!({"status": "SUCCESS"}), 0),
            Err(AgyUsageError::Busy)
        );
    }

    #[test]
    fn antigravity_keeps_its_cards_when_a_read_fails() {
        let usage = agy_live(&agy_response(), 1_000).unwrap();
        let failed = usage.clone().noted(agy_note(AgyUsageError::SignIn));
        // Every card says why its numbers are old; the numbers themselves stay.
        assert_eq!(failed.gemini.note, "Sign in again with Antigravity");
        assert_eq!(failed.claude_gpt.as_ref().unwrap().note, failed.gemini.note);
        assert_eq!(failed.argon.as_ref().unwrap().note, failed.gemini.note);
        assert_eq!(failed.gemini.windows, usage.gemini.windows);
        // With nothing read yet, one card says why there is nothing.
        let shell = AgyUsage {
            gemini: agy_shell(agy_note(AgyUsageError::NeedsUpdate)),
            ..AgyUsage::default()
        };
        let all = Config {
            agy_claude_gpt: true,
            agy_argon: true,
            ..Config::default()
        };
        let providers = agy_providers(&shell, &all);
        assert_eq!(ids(&providers), ["agy"]);
        assert_eq!(
            providers[0].note,
            "Update Antigravity (agy) to 1.1.11 or newer"
        );
        assert!(providers[0].windows.is_empty());
    }

    #[test]
    fn antigravity_waits_between_page_open_reads() {
        assert_eq!(agy_wait_after(Ok(()), 0), AGY_AT_MOST);
        assert_eq!(agy_wait_after(Err(AgyUsageError::SignIn), 1), AGY_AT_MOST);
        for (index, retry) in OFFLINE_RETRIES.iter().enumerate() {
            assert_eq!(
                agy_wait_after(Err(AgyUsageError::Offline), index + 1),
                *retry
            );
        }
        assert_eq!(
            agy_wait_after(Err(AgyUsageError::Offline), OFFLINE_RETRIES.len() + 1),
            AGY_AT_MOST
        );
        assert_eq!(agy_wait_after(Err(AgyUsageError::Busy), 1), CLAUDE_BACKOFF);
        assert_eq!(
            agy_wait_after(Err(AgyUsageError::NeedsUpdate), 1),
            CLAUDE_BACKOFF
        );
    }

    #[test]
    #[ignore = "asks Grok's server with this computer's sign-in"]
    fn reads_the_real_grok_usage() {
        match grok_billing() {
            Ok(response) => println!(
                "grok billing: {response}\ngrok: {:?}",
                grok_live(&response, now_ms())
            ),
            Err(err) => println!("grok: {err:?}"),
        }
    }

    #[tokio::test]
    #[ignore = "runs agy against Antigravity's quota with this computer's sign-in"]
    async fn reads_the_real_agy_usage() {
        let Some(program) = crate::assistant::Provider::Agy.program() else {
            println!("agy: not installed");
            return;
        };
        match crate::assistant::agy_usage(&program).await {
            Ok(response) => println!(
                "agy usage from {}: {:#?}",
                program.display(),
                agy_live(&response, now_ms())
            ),
            Err(err) => println!("agy: {err:?}"),
        }
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::Mutex;

    use serde_json::json;
    use zbus::{Connection, Proxy, connection};

    use super::*;

    const PATH: &str = "/io/github/zickrian/isle";
    const INTERFACE: &str = "io.github.zickrian.isle.Usage1";
    const ROOT: &str = "ISLE_USAGE_TEST_ROOT";

    struct Reads {
        claude: Result<Provider, ClaudeError>,
        grok: Result<Provider, GrokError>,
        claude_calls: usize,
        grok_calls: usize,
    }

    static READS: Mutex<Option<Reads>> = Mutex::new(None);

    pub(super) fn read_claude() -> Option<Result<Provider, ClaudeError>> {
        let mut reads = READS.lock().unwrap();
        let reads = reads.as_mut()?;
        reads.claude_calls += 1;
        Some(reads.claude.clone())
    }

    pub(super) fn read_grok() -> Option<Result<Provider, GrokError>> {
        let mut reads = READS.lock().unwrap();
        let reads = reads.as_mut()?;
        reads.grok_calls += 1;
        Some(reads.grok.clone())
    }

    fn isolated(name: &str) -> Option<PathBuf> {
        if let Some(root) = std::env::var_os(ROOT) {
            return Some(root.into());
        }
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "isle-usage-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        for dir in ["user", "bin", "claude", "codex", "grok", "tmp", "runtime"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        std::fs::set_permissions(
            root.join("runtime"),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .env_clear()
            .args([
                "--exact",
                &format!("usage::lifecycle_tests::{name}"),
                "--nocapture",
            ])
            .env(ROOT, &root)
            .env("HOME", root.join("user"))
            .env("PATH", root.join("bin"))
            .env("XDG_DATA_HOME", root.join("data"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_STATE_HOME", root.join("state"))
            .env("XDG_CACHE_HOME", root.join("cache"))
            .env("TMPDIR", root.join("tmp"))
            .env("XDG_RUNTIME_DIR", root.join("runtime"))
            .env("CLAUDE_CONFIG_DIR", root.join("claude"))
            .env("CODEX_HOME", root.join("codex"))
            .env("GROK_HOME", root.join("grok"))
            .status()
            .unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert!(status.success(), "isolated usage lifecycle failed: {name}");
        None
    }

    struct Bus {
        daemon: Child,
        address: String,
    }

    impl Bus {
        fn start() -> Self {
            let mut daemon = Command::new("/usr/bin/dbus-daemon")
                .args(["--session", "--nofork", "--print-address=1"])
                .arg(format!(
                    "--address=unix:tmpdir={}",
                    std::env::temp_dir().display()
                ))
                .stdout(Stdio::piped())
                .spawn()
                .expect("usage lifecycle tests need dbus-daemon");
            let mut address = String::new();
            BufReader::new(daemon.stdout.take().unwrap())
                .read_line(&mut address)
                .unwrap();
            Self {
                daemon,
                address: address.trim().to_owned(),
            }
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

    struct Service {
        server: Connection,
        client: Connection,
        task: tokio::task::JoinHandle<()>,
        _bus: Bus,
    }

    impl Service {
        async fn start() -> Self {
            let bus = Bus::start();
            let server = bus.connect().await;
            let client = bus.connect().await;
            let (service, refresh) = UsageService::new();
            server.object_server().at(PATH, service).await.unwrap();
            let iface = server
                .object_server()
                .interface::<_, UsageService>(PATH)
                .await
                .unwrap();
            let task = tokio::spawn(run(iface, refresh));
            Self {
                server,
                client,
                task,
                _bus: bus,
            }
        }

        async fn proxy(&self) -> Proxy<'_> {
            Proxy::new(
                &self.client,
                self.server.unique_name().unwrap(),
                PATH,
                INTERFACE,
            )
            .await
            .unwrap()
        }

        async fn configure(&self, config: &Value) {
            self.proxy()
                .await
                .call::<_, _, ()>("SetConfig", &(config.to_string(),))
                .await
                .unwrap();
        }

        async fn refresh(&self) {
            self.proxy()
                .await
                .call::<_, _, ()>("Refresh", &())
                .await
                .unwrap();
        }

        async fn usage(&self) -> Value {
            let text: String = self.proxy().await.get_property("Usage").await.unwrap();
            serde_json::from_str(&text).unwrap()
        }

        async fn wait_for(&self, description: &str, matches: impl Fn(&Value) -> bool) -> Value {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let usage = self.usage().await;
                if matches(&usage) {
                    return usage;
                }
                assert!(
                    Instant::now() < deadline,
                    "{description}: last publication {usage}"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        async fn expect(&self, providers: &Value) {
            self.wait_for("expected exact cached providers", |usage| {
                &usage["providers"] == providers
            })
            .await;
        }
    }

    impl Drop for Service {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    fn config() -> Value {
        json!({"enabled": true, "claude": false, "codex": false, "grok": false,
            "agy": true, "agy_claude_gpt": true, "agy_argon": true, "assistant": true})
    }

    fn fake_agy(root: &Path, fail: bool) {
        let onboarding = root.join("user/.gemini/antigravity-cli/cache/onboarding.json");
        std::fs::create_dir_all(onboarding.parent().unwrap()).unwrap();
        std::fs::write(onboarding, r#"{"onboardingComplete":true}"#).unwrap();
        let response = json!({"status": "SUCCESS", "command": {"name": "usage", "data": {
        "groups": [
            {"name": "Gemini", "buckets": [{"id": "gemini-5h", "window": "5h", "remaining_fraction": 0.75}]},
            {"name": "Claude and GPT", "buckets": [{"id": "3p-weekly", "window": "weekly", "remaining_fraction": 0.5}]},
            {"name": "Argon", "buckets": [{"id": "gemini-argon-wtu-weekly", "window": "weekly", "remaining_fraction": 0.25}]}
        ]}}});
        let answer = if fail {
            r#"{"status":"ERROR","error":"quota service busy"}"#.to_owned()
        } else {
            response.to_string()
        };
        let script = format!(
            "#!/bin/sh\nprintf x >> '{0}/all-calls'\nif [ \"$1\" = --version ]; then printf '1.4.12\\n'; exit 0; fi\n[ \"$1\" = --print ] && [ \"$2\" = /usage ] || exit 2\nprintf x >> '{0}/usage-calls'\nprintf '%s\\n' '{answer}'\n",
            root.display()
        );
        let program = root.join("bin/agy");
        std::fs::write(&program, script).unwrap();
        std::fs::set_permissions(program, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
    }

    fn calls(root: &Path, file: &str) -> usize {
        std::fs::read(root.join(file)).unwrap_or_default().len()
    }

    async fn toggle(service: &Service, config: &mut Value, key: &str, cached: &Value) {
        config[key] = json!(false);
        service.configure(config).await;
        service.expect(&json!([])).await;
        service.refresh().await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        service.expect(&json!([])).await;
        config[key] = json!(true);
        service.configure(config).await;
        service.expect(cached).await;
        service.refresh().await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        service.expect(cached).await;
    }

    #[tokio::test]
    async fn antigravity_visibility_preserves_cached_pools_and_cooldown() {
        let Some(root) = isolated("antigravity_visibility_preserves_cached_pools_and_cooldown")
        else {
            return;
        };
        fake_agy(&root, false);
        let service = Service::start().await;
        let mut config = config();
        service.configure(&config).await;
        service
            .wait_for("unread Antigravity shell", |usage| {
                usage["providers"][0]["id"] == "agy"
            })
            .await;
        assert_eq!(
            calls(&root, "all-calls"),
            0,
            "configuration must not invoke agy"
        );
        service.refresh().await;
        let first = service
            .wait_for("three populated Antigravity pools", |usage| {
                usage["providers"][2]["updated_ms"]
                    .as_i64()
                    .is_some_and(|at| at > 0)
            })
            .await;
        let cached = first["providers"].clone();
        let expected = [
            ("agy", "5 hours", 25.0),
            ("agy-claude-gpt", "Week", 50.0),
            ("agy-argon", "Week", 75.0),
        ];
        assert_eq!(cached.as_array().unwrap().len(), expected.len());
        let updated = cached[0]["updated_ms"].as_i64().unwrap();
        for (provider, (id, label, percent)) in cached.as_array().unwrap().iter().zip(expected) {
            assert_eq!(provider["id"], id);
            assert_eq!(provider["updated_ms"], updated);
            assert_eq!(
                provider["windows"],
                json!([{"label": label, "percent": percent, "resets_at_ms": 0}])
            );
        }
        assert_eq!(calls(&root, "usage-calls"), 1);
        for (key, hidden) in [
            ("agy_claude_gpt", "agy-claude-gpt"),
            ("agy_argon", "agy-argon"),
        ] {
            config[key] = json!(false);
            service.configure(&config).await;
            let shown = Value::Array(
                cached
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|p| p["id"] != hidden)
                    .cloned()
                    .collect(),
            );
            service.expect(&shown).await;
            config[key] = json!(true);
            service.configure(&config).await;
            service.expect(&cached).await;
            assert_eq!(calls(&root, "usage-calls"), 1);
        }
        for key in ["enabled", "agy", "assistant"] {
            let before = calls(&root, "all-calls");
            toggle(&service, &mut config, key, &cached).await;
            assert_eq!(
                calls(&root, "all-calls"),
                before,
                "{key} bypassed the CLI gate/cooldown"
            );
            assert_eq!(calls(&root, "usage-calls"), 1);
        }
        std::fs::remove_file(root.join("user/.gemini/antigravity-cli/cache/onboarding.json"))
            .unwrap();
        service.configure(&config).await;
        service.expect(&json!([])).await;
        service.refresh().await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        service.expect(&json!([])).await;
        assert_eq!(
            calls(&root, "usage-calls"),
            1,
            "signed-out cache must not trigger a read"
        );
        std::fs::write(
            root.join("user/.gemini/antigravity-cli/cache/onboarding.json"),
            r#"{"onboardingComplete":true}"#,
        )
        .unwrap();
        service.configure(&config).await;
        service
            .expect(&serde_json::to_value(vec![agy_shell("")]).unwrap())
            .await;
        assert_eq!(
            calls(&root, "usage-calls"),
            1,
            "sign-in must not bypass cooldown"
        );
    }

    #[tokio::test]
    async fn antigravity_visibility_preserves_error_backoff() {
        let Some(root) = isolated("antigravity_visibility_preserves_error_backoff") else {
            return;
        };
        fake_agy(&root, true);
        let service = Service::start().await;
        let mut config = config();
        service.configure(&config).await;
        service.refresh().await;
        let first = service
            .wait_for("Antigravity failure note", |usage| {
                usage["providers"][0]["note"] == agy_note(AgyUsageError::Busy)
            })
            .await;
        let cached = first["providers"].clone();
        assert_eq!(cached[0]["updated_ms"], 0);
        assert_eq!(cached[0]["windows"], json!([]));
        for key in ["enabled", "agy", "assistant"] {
            toggle(&service, &mut config, key, &cached).await;
            assert_eq!(calls(&root, "usage-calls"), 1, "{key} reset error backoff");
        }
    }

    #[tokio::test]
    async fn subscription_visibility_preserves_cached_reads_and_backoff() {
        let Some(_root) = isolated("subscription_visibility_preserves_cached_reads_and_backoff")
        else {
            return;
        };
        for failed in [false, true] {
            let claude = Provider {
                windows: vec![Window {
                    label: "5 hours".into(),
                    percent: 37.0,
                    resets_at_ms: 0,
                }],
                updated_ms: 1_234,
                ..claude_shell()
            };
            let grok = Provider {
                windows: vec![Window {
                    label: "Week".into(),
                    percent: 63.0,
                    resets_at_ms: 0,
                }],
                updated_ms: 2_345,
                ..grok_shell()
            };
            *READS.lock().unwrap() = Some(Reads {
                claude: if failed {
                    Err(ClaudeError::Busy)
                } else {
                    Ok(claude.clone())
                },
                grok: if failed {
                    Err(GrokError::Busy)
                } else {
                    Ok(grok.clone())
                },
                claude_calls: 0,
                grok_calls: 0,
            });
            for (id, auth, expected) in [
                ("claude", claude_sign_in(), claude),
                ("grok", grok_auth(), grok),
            ] {
                std::fs::create_dir_all(auth.parent().unwrap()).unwrap();
                std::fs::write(&auth, "{}").unwrap();
                let service = Service::start().await;
                let mut config = config();
                config["agy"] = json!(false);
                config[id] = json!(true);
                service.configure(&config).await;
                let first = service
                    .wait_for("subscription initial read", |usage| {
                        usage["providers"][0]["id"] == id
                    })
                    .await;
                let cached = first["providers"].clone();
                let mut expected = expected;
                if failed {
                    expected.windows.clear();
                    expected.updated_ms = 0;
                    expected.note = if id == "claude" {
                        ClaudeError::Busy.note()
                    } else {
                        GrokError::Busy.note()
                    }
                    .into();
                }
                assert_eq!(cached, serde_json::to_value(vec![expected]).unwrap());
                for key in ["enabled", id] {
                    toggle(&service, &mut config, key, &cached).await;
                }
                {
                    let reads = READS.lock().unwrap();
                    let reads = reads.as_ref().unwrap();
                    assert_eq!(
                        if id == "claude" {
                            reads.claude_calls
                        } else {
                            reads.grok_calls
                        },
                        1,
                        "{id} bypassed cooldown/backoff"
                    );
                }
                std::fs::remove_file(&auth).unwrap();
                service.configure(&config).await;
                service.expect(&json!([])).await;
                std::fs::write(&auth, "{}").unwrap();
                service.configure(&config).await;
                service.refresh().await;
                tokio::time::sleep(Duration::from_millis(40)).await;
                service.expect(&json!([])).await;
            }
        }
    }

    #[tokio::test]
    async fn antigravity_missing_program_invalidates_cached_account() {
        let Some(root) = isolated("antigravity_missing_program_invalidates_cached_account") else {
            return;
        };
        fake_agy(&root, false);
        let service = Service::start().await;
        let config = config();
        service.configure(&config).await;
        service.refresh().await;
        service
            .wait_for("initial Antigravity pools", |usage| {
                usage["providers"][2]["updated_ms"]
                    .as_i64()
                    .is_some_and(|at| at > 0)
            })
            .await;
        std::fs::remove_file(root.join("bin/agy")).unwrap();
        service.configure(&config).await;
        service.expect(&json!([])).await;
        fake_agy(&root, false);
        service.configure(&config).await;
        service
            .expect(&serde_json::to_value(vec![agy_shell("")]).unwrap())
            .await;
        service.refresh().await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        service
            .expect(&serde_json::to_value(vec![agy_shell("")]).unwrap())
            .await;
        assert_eq!(calls(&root, "usage-calls"), 1);
    }

    #[tokio::test]
    async fn codex_local_subscription_survives_visibility_toggles() {
        let Some(root) = isolated("codex_local_subscription_survives_visibility_toggles") else {
            return;
        };
        let sessions = root.join("codex/sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let event = json!({"timestamp": "2026-11-02T00:00:00Z", "payload": {"rate_limits": {
            "plan_type": "plus", "primary": {"window_minutes": 300, "used_percent": 31},
            "secondary": {"window_minutes": 10080, "used_percent": 47}
        }}});
        std::fs::write(sessions.join("test.jsonl"), event.to_string()).unwrap();
        let service = Service::start().await;
        let mut config = config();
        config["agy"] = json!(false);
        config["codex"] = json!(true);
        service.configure(&config).await;
        let first = service
            .wait_for("local Codex subscription", |usage| {
                usage["providers"][0]["id"] == "codex"
            })
            .await;
        let cached = first["providers"].clone();
        assert_eq!(
            cached[0]["windows"],
            json!([
                {"label": "5 hours", "percent": 31.0, "resets_at_ms": 0},
                {"label": "Week", "percent": 47.0, "resets_at_ms": 0}
            ])
        );
        assert_eq!(cached[0]["updated_ms"], rfc3339_ms("2026-11-02T00:00:00Z"));
        for key in ["enabled", "codex"] {
            toggle(&service, &mut config, key, &cached).await;
        }
        config["assistant"] = json!(false);
        service.configure(&config).await;
        service.refresh().await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        service.expect(&cached).await;
        assert!(
            !root.join("codex/auth.json").exists(),
            "Codex fixture must remain offline"
        );
    }
}
