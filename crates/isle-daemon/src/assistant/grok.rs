// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 caffeinepx
// Copyright (C) 2026 zickrian

//! Grok (`grok`) in headless print mode, with the user's own sign-in: one run per turn, resumed, kept to
//! the web tools, in a home of its own so its chats never mix with the user's. Its words stream as they come.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use anyhow::{Context, bail};
use chrono::{DateTime, Local, NaiveDate};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;

use super::answer::{Answer, SCHEMA};
use super::child::{self, Events};

const STDERR_LINES: usize = 20;
/// Longest a first request waits for `grok models` to name the plan's default.
const DEFAULT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// The file in each workspace's sessions folder where Grok keeps every prompt it was given.
const HISTORY: &str = "prompt_history.jsonl";
/// A turn that searches and then answers fits in this many model rounds.
const MAX_TURNS: &str = "8";
/// Isle's Grok only answers, with web search: no shell, no files, no subagents.
const TOOLS: &str = "web_search,web_fetch";
const DISALLOWED: &str = "run_terminal_cmd,search_replace,write,task,image_gen";
/// Written on every start, in Isle's own home for Grok: none of the user's tools, memory or workflows.
const CONFIG: &str =
    "# Written by Isle on every start: Grok here only answers; Isle runs the actions.
[features]
telemetry = false
feedback = false

[memory]
enabled = false

[workflows]
enabled = false
";

/// What each turn's `grok` run needs, and the conversation it resumes.
pub struct Grok {
    program: PathBuf,
    model: String,
    workspace: PathBuf,
    instructions: String,
    pub conversation: Option<String>,
}

/// The HOME Isle runs Grok with: GROK_HOME alone still brings the user's ~/.claude skills, hooks and
/// MCP servers (24k tokens a turn, and Isle's own hooks firing).
fn isle_home() -> PathBuf {
    crate::store::data_dir().join("grok")
}

/// Grok's home for Isle, inside it; it shares only the user's sign-in.
fn home() -> PathBuf {
    isle_home().join(".grok")
}

/// The environment Isle runs Grok in, away from the user's own Grok and Claude Code setups.
fn contained() -> [(&'static str, PathBuf); 3] {
    [
        ("HOME", isle_home()),
        ("GROK_HOME", home()),
        ("GROK_DISABLE_AUTOUPDATER", "1".into()),
    ]
}

/// Left out of that environment: they would lead Grok back to the user's folders.
const UNSET: [&str; 4] = [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
];

/// The user's own Grok home: `$GROK_HOME`, else `~/.grok`.
pub fn user_home() -> PathBuf {
    std::env::var_os("GROK_HOME")
        .filter(|dir| !dir.is_empty())
        .map_or_else(
            || dirs::home_dir().unwrap_or_default().join(".grok"),
            PathBuf::from,
        )
}

impl Grok {
    /// Remembers the conversation to resume (`resume`) and the job (`instructions`). Each turn starts
    /// `grok` and lets it exit: headless mode answers once and stops.
    pub async fn start(
        program: &Path,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
        instructions: &str,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(workspace)?;
        crate::store::create_private_dir(&home()).context("could not make Grok's folder")?;
        std::fs::write(home().join("config.toml"), CONFIG)
            .context("could not write Grok's settings")?;
        trust_workspace(workspace);
        link_sign_in();
        let model = if model.is_empty() {
            default_model(program).await
        } else {
            model.to_owned()
        };
        Ok(Self {
            program: program.to_owned(),
            model,
            workspace: workspace.to_owned(),
            instructions: instructions.to_owned(),
            conversation: resume.map(str::to_owned),
        })
    }

    /// One turn, started over once in a new conversation when the old one is gone.
    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        let answer = self.turn(prompt, activity, draft).await;
        // A resumed session Grok no longer has (pruned, or never stored): start a new one, once.
        let answer = match answer {
            Err(err) if self.conversation.is_some() && session_missing(&err) => {
                self.conversation = None;
                self.turn(prompt, activity, draft).await
            }
            other => other,
        };
        // A token it renewed meanwhile goes back to the user's own Grok.
        link_sign_in();
        answer
    }

    /// One headless run.
    async fn turn(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        // One file per turn: two turns at once (the eval, a background answer) must never read each other's.
        static TURNS: AtomicU64 = AtomicU64::new(0);
        let turn = TURNS.fetch_add(1, Ordering::Relaxed);
        // Counted until the turn ends, so Grok's index is never deleted under it (see `forget_index`).
        let _running = Running::new();
        let prompt_path = home().join(format!("prompt-{}-{turn}.txt", std::process::id()));
        crate::store::write_private(&prompt_path, prompt.as_bytes())
            .context("could not write Grok's prompt")?;
        let _prompt_file = PromptFile(prompt_path.clone());
        let mut command = Command::new(&self.program);
        command
            .arg("--prompt-file")
            .arg(&prompt_path)
            .args([
                "--output-format",
                "streaming-messages-json",
                "--include-partial-messages",
                "--verbatim",
                "--json-schema",
                SCHEMA,
                "--system-prompt-override",
            ])
            .arg(&self.instructions)
            .args(["--tools", TOOLS, "--disallowed-tools", DISALLOWED])
            // Headless runs can't ask: the web tools are allowed by name, nothing else is.
            .args(["--allow", "WebFetch", "--allow", "WebSearch"])
            .args(["--no-plan", "--no-subagents", "--no-memory"])
            .args([
                "--reasoning-effort",
                super::brain::EFFORT,
                "--max-turns",
                MAX_TURNS,
            ])
            .arg("--leader-socket")
            .arg(home().join("leader.sock"))
            .arg("--cwd")
            .arg(&self.workspace)
            .current_dir(&self.workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.envs(contained());
        for var in UNSET {
            command.env_remove(var);
        }
        if !self.model.is_empty() {
            command.args(["--model", &self.model]);
        }
        if let Some(id) = &self.conversation {
            command.args(["--resume", id]);
        }
        let mut child =
            child::spawn(&mut command).context("could not start grok; is Grok installed?")?;
        let events = Events::new(child.stdout.take().expect("piped stdout"));
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        let mut lines = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
        let kept = stderr.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let mut kept = kept.lock().unwrap();
                if kept.len() == STDERR_LINES {
                    kept.pop_front();
                }
                kept.push_back(line);
            }
        });
        let answer = read_turn(&mut self.conversation, events, activity, draft).await;
        drop(child);
        answer.map_err(|err| {
            let stderr = Vec::from(stderr.lock().unwrap().clone()).join(" | ");
            if stderr.is_empty() {
                err
            } else {
                err.context(stderr)
            }
        })
    }
}

/// What `grok models` lists for the signed-in account, and the caches it leaves in Isle's Grok home:
/// (listing, models_cache.json, settings_cache.json; the user's own when Isle's has none yet).
pub async fn models(program: &Path) -> anyhow::Result<(String, Value, Value)> {
    use tokio::io::AsyncReadExt;
    crate::store::create_private_dir(&home()).context("could not make Grok's folder")?;
    link_sign_in();
    let mut command = Command::new(program);
    command
        .arg("models")
        .arg("--leader-socket")
        .arg(home().join("leader.sock"))
        .envs(contained())
        .current_dir(isle_home())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for var in UNSET {
        command.env_remove(var);
    }
    let mut child = child::spawn(&mut command).context("could not start grok")?;
    let mut listed = String::new();
    child
        .stdout
        .take()
        .expect("piped stdout")
        .read_to_string(&mut listed)
        .await?;
    let status = child.wait().await?;
    link_sign_in();
    if !status.success() {
        bail!("grok models failed ({status})");
    }
    let cache = |name: &str| {
        [home(), user_home()]
            .iter()
            .map(|dir| std::fs::read(dir.join(name)).ok())
            .find_map(|bytes| serde_json::from_slice::<Value>(&bytes?).ok())
            .unwrap_or_default()
    };
    Ok((
        listed,
        cache("models_cache.json"),
        cache("settings_cache.json"),
    ))
}

/// The plan a settings cache of Grok's names ("Free", "SuperGrok"); its payload is kept as a JSON string.
pub fn plan_in(settings: &Value) -> String {
    let payload = settings["payload"]
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| settings["payload"].clone());
    payload["settings"]["subscription_tier_display"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// The plan as Grok last cached it: Isle's Grok home, else the user's own.
pub fn plan() -> String {
    [home(), user_home()]
        .iter()
        .filter_map(|dir| std::fs::read(dir.join("settings_cache.json")).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|settings| plan_in(&settings))
        .find(|plan| !plan.is_empty())
        .unwrap_or_default()
}

/// Whether `err` is a resume of a session Grok does not have, rather than a failure of the answer.
fn session_missing(err: &anyhow::Error) -> bool {
    // The whole chain: what Grok wrote to stderr is the outer context, its reason inside.
    let text = format!("{err:#}").to_lowercase();
    text.contains("session")
        && (text.contains("not found")
            || text.contains("does not exist")
            || text.contains("no such")
            || text.contains("unknown"))
}

/// Holds the prompt file until the run has read it.
struct PromptFile(PathBuf);

impl Drop for PromptFile {
    /// The prompt goes once the turn ends, however it ended.
    fn drop(&mut self) {
        std::fs::remove_file(&self.0).ok();
    }
}

/// Reads one run's stream into an answer, keeping the session id and what to show meanwhile.
async fn read_turn(
    conversation: &mut Option<String>,
    mut events: Events<tokio::process::ChildStdout>,
    activity: Option<&UnboundedSender<String>>,
    draft: Option<&UnboundedSender<String>>,
) -> anyhow::Result<Answer> {
    let words: &[&str] = &[
        "\"init\"",
        "\"result\"",
        "\"tool_use\"",
        "\"text_delta\"",
        "\"input_json_delta\"",
        "\"type\":\"error\"",
        "\"type\": \"error\"",
    ];
    let mut written = String::new();
    let mut shown = String::new();
    while let Some(event) = events.next(words).await? {
        if let Some(id) = event["session_id"].as_str().filter(|id| !id.is_empty()) {
            *conversation = Some(id.to_owned());
        }
        match event["type"].as_str() {
            Some("result") => return parse_result(&event),
            Some("error") => bail!("{}", reason(&event)),
            Some("stream_event") => note_delta(&event["event"], &mut written, &mut shown, draft),
            Some("assistant") => {
                if let Some(activity) = activity {
                    steps(&event).into_iter().for_each(|step| {
                        activity.send(step).ok();
                    });
                }
            }
            _ => {}
        }
    }
    bail!("grok stopped")
}

/// The answer so far, from a partial message: the schema's JSON, or the text it is writing.
fn note_delta(
    event: &Value,
    written: &mut String,
    shown: &mut String,
    draft: Option<&UnboundedSender<String>>,
) {
    let delta = &event["delta"];
    match delta["type"].as_str() {
        Some("input_json_delta") => {
            written.push_str(delta["partial_json"].as_str().unwrap_or_default())
        }
        Some("text_delta") => written.push_str(delta["text"].as_str().unwrap_or_default()),
        _ => {
            if event["type"] == "content_block_start" {
                written.clear();
            }
            return;
        }
    }
    if let (Some(draft), Some(say)) = (draft, super::answer::partial_say(written))
        && say != *shown
    {
        draft.send(say.clone()).ok();
        *shown = say;
    }
}

/// What Grok starts doing, for the island: its web searches and the pages it reads.
fn steps(event: &Value) -> Vec<String> {
    let Some(content) = event["message"]["content"].as_array() else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|part| part["type"] == "tool_use")
        .filter_map(|tool| match tool["name"].as_str()? {
            "web_search" | "WebSearch" => Some(match query(tool) {
                Some(query) => format!("Searching the web for “{query}”…"),
                None => "Searching the web…".into(),
            }),
            "web_fetch" | "WebFetch" => {
                let url = tool["input"]["url"]
                    .as_str()
                    .or(tool["input"]["uri"].as_str())
                    .unwrap_or_default();
                let host = url
                    .split("://")
                    .nth(1)
                    .and_then(|rest| rest.split('/').next());
                Some(format!("Reading {}…", host.unwrap_or("a page")))
            }
            _ => None,
        })
        .collect()
}

/// A search's terms, under whichever name this Grok gives them.
fn query(tool: &Value) -> Option<&str> {
    ["query", "q", "search_term"]
        .iter()
        .find_map(|key| tool["input"][*key].as_str().filter(|q| !q.is_empty()))
}

/// Why Grok failed, in its own words wherever it put them ("rate_limited", "unknown model id"), so
/// `brain::explain` can tell the user; the event itself when it named none.
fn reason(event: &Value) -> String {
    let error = &event["error"];
    [
        &event["result"],
        &event["message"],
        error,
        &error["message"],
        &error["type"],
        &event["error_type"],
    ]
    .iter()
    .find_map(|value| value.as_str().filter(|text| !text.trim().is_empty()))
    .map_or_else(
        || event.to_string().chars().take(300).collect(),
        str::to_owned,
    )
}

/// The final event's answer: the schema's JSON, else its text as said.
fn parse_result(event: &Value) -> anyhow::Result<Answer> {
    if event["is_error"].as_bool() == Some(true)
        || event["subtype"].as_str().is_some_and(|s| s != "success")
    {
        bail!("{}", reason(event));
    }
    if let Ok(answer) = Answer::deserialize(&event["structured_output"]) {
        return Ok(answer);
    }
    Ok(super::answer::from_text(
        event["result"].as_str().unwrap_or_default(),
    ))
}

/// The model in the user's own config.toml (`[models] default`), when they picked none.
pub(super) fn user_model() -> Option<String> {
    model_in(&std::fs::read_to_string(user_home().join("config.toml")).ok()?)
}

/// The plan's default, for a start with no model (a refused user pick is never retried here). Never left to
/// Grok: in Isle's fresh home it picks one a Free plan may not have (grok-4.6).
async fn default_model(program: &Path) -> String {
    let catalog = super::models::current().remove("grok");
    if let Some(default) = catalog.map(|c| c.default).filter(|d| !d.is_empty()) {
        return default;
    }
    // Not listed yet (its first request): asked now, once, without holding up isled for long.
    let Ok(Ok((listed, _, _))) = tokio::time::timeout(DEFAULT_TIMEOUT, models(program)).await
    else {
        return String::new();
    };
    listed
        .lines()
        .find_map(|line| line.trim().strip_prefix("* ")?.strip_suffix(" (default)"))
        .unwrap_or_default()
        .trim()
        .to_owned()
}

/// `default` in the `[models]` table of `config`.
fn model_in(config: &str) -> Option<String> {
    let mut in_models = false;
    for line in config.lines() {
        let line = line.trim();
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            in_models = name.trim() == "models";
            continue;
        }
        if !in_models {
            continue;
        }
        // Other keys, comments or blank lines may come first: only this one counts.
        let Some(value) = line
            .strip_prefix("default")
            .and_then(|rest| rest.trim_start().strip_prefix('='))
        else {
            continue;
        };
        let value = toml_string(value);
        if !value.is_empty() {
            return Some(value.to_owned());
        }
    }
    None
}

/// A config value without its quotes, or the part before a `#` comment when it has none.
fn toml_string(value: &str) -> &str {
    let value = value.trim();
    match value.chars().next() {
        Some(quote @ ('"' | '\'')) => value[1..].split(quote).next().unwrap_or_default(),
        _ => value.split('#').next().unwrap_or_default().trim(),
    }
}

/// Marks Isle's workspace trusted, so a headless run there is not held for a question nobody can answer.
fn trust_workspace(workspace: &Path) {
    let path = workspace
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let now = chrono::Utc::now().timestamp();
    let text = format!("[folders.\"{path}\"]\ntrusted = true\ndecided_at = {now}\n");
    std::fs::write(home().join("trusted_folders.toml"), text).ok();
}

/// Links Isle's Grok home to the user's sign-in (`auth.json`; see sign_in.rs).
fn link_sign_in() {
    super::sign_in::share(&user_home().join("auth.json"), &home().join("auth.json"));
}

/// A sign-in Grok stored: the session token, the user id the billing call names, and when it runs out
/// (0 when it did not say).
pub struct SignIn {
    pub token: String,
    pub user_id: String,
    pub expires_ms: i64,
}

/// Whether Grok has a way to sign in: its own sign-in, or an API key.
pub fn signed_in() -> bool {
    std::env::var_os("XAI_API_KEY").is_some_and(|key| !key.is_empty()) || sign_in().is_some()
}

/// The newest sign-in in `auth.json` (several accounts: the one that lasts longest).
pub fn sign_in() -> Option<SignIn> {
    let text = std::fs::read_to_string(user_home().join("auth.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    sign_in_from(&value)
}

/// Picks from parsed `auth.json`; entries without a token or user id are skipped.
fn sign_in_from(value: &Value) -> Option<SignIn> {
    let mut best: Option<SignIn> = None;
    for entry in value.as_object()?.values() {
        let Some(token) = entry["key"].as_str().filter(|token| !token.is_empty()) else {
            continue;
        };
        let Some(user_id) = entry["user_id"].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        let expires_ms = entry["expires_at"].as_str().map(rfc3339_ms).unwrap_or(0);
        let better = best
            .as_ref()
            .is_none_or(|have| expires_ms >= have.expires_ms);
        if better {
            best = Some(SignIn {
                token: token.to_owned(),
                user_id: user_id.to_owned(),
                expires_ms,
            });
        }
    }
    best
}

/// The installed Grok's version, as it last wrote it, for the billing call that asks.
pub fn client_version() -> Option<String> {
    let text = std::fs::read_to_string(user_home().join("version.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value["version"]
        .as_str()
        .filter(|version| !version.is_empty())
        .map(str::to_owned)
}

/// Where Grok reads the plan's allowance. `$GROK_CLI_CHAT_PROXY_BASE_URL`, else `[endpoints]` in the
/// user's config, else Grok's own proxy.
pub fn billing_url() -> String {
    // Only over https: the request carries the sign-in's token.
    let base = std::env::var("GROK_CLI_CHAT_PROXY_BASE_URL")
        .ok()
        .filter(|url| url.trim().starts_with("https://"))
        .or_else(proxy_from_config)
        .unwrap_or_else(|| "https://cli-chat-proxy.grok.com/v1".to_owned());
    format!(
        "{}/billing?format=credits",
        base.trim().trim_end_matches('/')
    )
}

/// `cli_chat_proxy_base_url` in the `[endpoints]` table of the user's config, https only.
fn proxy_from_config() -> Option<String> {
    let config = std::fs::read_to_string(user_home().join("config.toml")).ok()?;
    let mut in_endpoints = false;
    for line in config.lines() {
        let line = line.trim();
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            in_endpoints = name.trim() == "endpoints";
            continue;
        }
        if !in_endpoints {
            continue;
        }
        // Other keys of the table come first too: only this one counts.
        let Some(value) = line
            .strip_prefix("cli_chat_proxy_base_url")
            .and_then(|rest| rest.trim_start().strip_prefix('='))
        else {
            continue;
        };
        let value = toml_string(value);
        if value.starts_with("https://") {
            return Some(value.to_owned());
        }
    }
    None
}

/// Unix milliseconds, 0 when unreadable.
fn rfc3339_ms(text: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(text).map_or(0, |time| time.timestamp_millis())
}

/// Deletes Isle's Grok conversation `id` now (an id as Grok makes them, never a path).
pub fn forget(id: &str) {
    if !session_id(id) {
        return;
    }
    if let Some(program) = super::brain::Provider::Grok.program() {
        let mut command = std::process::Command::new(program);
        command
            .args(["sessions", "delete", id])
            // The default socket stays ~/.grok/leader.sock even with GROK_HOME set.
            .arg("--leader-socket")
            .arg(home().join("leader.sock"))
            .envs(contained())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for var in UNSET {
            command.env_remove(var);
        }
        if let Ok(mut child) = command.spawn() {
            let _ = child.wait();
        }
    }
    forget_files(id);
}

/// Whether `id` looks like one of Grok's session ids: safe to pass on and to match folder names with.
fn session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Deletes the folder of conversation `id` left in Isle's Grok home.
fn forget_files(id: &str) {
    /// Removes the folder named `id` and every prompt history under `dir`.
    fn walk(dir: &Path, id: &str) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if entry.file_name().to_string_lossy() == id {
                    std::fs::remove_dir_all(&path).ok();
                } else {
                    walk(&path, id);
                }
            } else if entry.file_name() == HISTORY {
                // Grok's list of every prompt typed, its conversations' requests among them.
                std::fs::remove_file(&path).ok();
            }
        }
    }
    walk(&home().join("sessions"), id);
    forget_index();
}

/// Grok turns under way in this isled: `forget_index` leaves the index alone until none.
static RUNNING: Mutex<Turns> = Mutex::new(Turns {
    running: 0,
    forget_index: false,
});

/// Grok turns under way, and whether the index waits to be deleted once none is.
struct Turns {
    running: usize,
    forget_index: bool,
}

/// One Grok turn counted in `RUNNING`, from before it starts until it ends.
struct Running;

impl Running {
    /// Waits for an index deletion under way, so Grok never opens it half deleted.
    fn new() -> Self {
        RUNNING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running += 1;
        Self
    }
}

impl Drop for Running {
    /// The turn it counted ended; the last one deletes an index asked to go meanwhile.
    fn drop(&mut self) {
        let mut turns = RUNNING.lock().unwrap_or_else(PoisonError::into_inner);
        turns.running -= 1;
        if turns.running == 0 && turns.forget_index {
            turns.forget_index = false;
            delete_index();
        }
    }
}

/// Grok's search index of its conversations (their prompts in it): made again as Grok needs it.
fn forget_index() {
    // With a Grok turn under way, once it ends (see `Running`); a turn starting meanwhile waits.
    let mut turns = RUNNING.lock().unwrap_or_else(PoisonError::into_inner);
    if turns.running > 0 {
        turns.forget_index = true;
        return;
    }
    delete_index();
}

/// Deletes the index's files; the caller holds `RUNNING`.
fn delete_index() {
    for name in [
        "session_search.sqlite",
        "session_search.sqlite-wal",
        "session_search.sqlite-shm",
    ] {
        std::fs::remove_file(home().join("sessions").join(name)).ok();
    }
}

/// Deletes Isle's Grok conversations last changed before `today`.
pub fn prune(today: NaiveDate) {
    /// Removes session folders last changed before `today`, prompt histories, and folders left empty.
    fn walk(dir: &Path, today: NaiveDate) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if !kind.is_dir() {
                // Every prompt Grok was given, the deleted conversations' too.
                if entry.file_name() == HISTORY {
                    std::fs::remove_file(&path).ok();
                }
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if session_id(&name) {
                let old = entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .is_ok_and(|time| DateTime::<Local>::from(time).date_naive() < today);
                if old {
                    std::fs::remove_dir_all(&path).ok();
                }
            } else {
                walk(&path, today);
                std::fs::remove_dir(&path).ok();
            }
        }
    }
    walk(&home().join("sessions"), today);
    forget_index();
    forget_prompts();
    // Grok's own log of each run, the requests in it: started anew each day.
    std::fs::remove_dir_all(home().join("logs")).ok();
}

/// Deletes the prompt files an isled that was stopped mid-turn left (its own are deleted as each turn ends).
fn forget_prompts() {
    let Ok(entries) = std::fs::read_dir(home()) else {
        return;
    };
    let mine = format!("prompt-{}-", std::process::id());
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let regular = entry.file_type().is_ok_and(|kind| kind.is_file());
        if regular
            && name.starts_with("prompt-")
            && name.ends_with(".txt")
            && !name.starts_with(&mine)
        {
            std::fs::remove_file(entry.path()).ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_groks_answer_and_steps() {
        let done = json!({"type": "result", "subtype": "success", "is_error": false, "result": "{}",
            "structured_output": {"say": "Done.", "actions": [{"type": "open_url", "url": "https://x.com"}]}});
        let answer = parse_result(&done).unwrap();
        assert_eq!((answer.say.as_str(), answer.actions.len()), ("Done.", 1));
        let failed = json!({"type": "result", "subtype": "error_during_execution", "is_error": true,
            "result": "Please run grok login"});
        assert!(
            parse_result(&failed)
                .unwrap_err()
                .to_string()
                .contains("login")
        );
        let search = json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "web_search", "input": {"query": "weather"}}]}});
        assert_eq!(steps(&search), ["Searching the web for “weather”…"]);
    }

    #[test]
    fn reads_the_users_default_model_and_sign_in() {
        let config = "[cli]\ninstaller = \"internal\"\n\n[models]\ndefault = \"grok-4.7\"\n";
        assert_eq!(model_in(config).as_deref(), Some("grok-4.7"));
        assert!(model_in("[cli]\ndefault = \"no\"\n").is_none());
        // Comments, blank lines and other keys may come first; a comment may follow.
        let commented = "[models]\n# my pick\n\nfast = \"x\"\ndefault = \"grok-4.7\" # best\n";
        assert_eq!(model_in(commented).as_deref(), Some("grok-4.7"));
        assert_eq!(toml_string("https://p/v1 # corp"), "https://p/v1");
        assert_eq!(toml_string("'a#b' # c"), "a#b");
        let auth = json!({"https://auth.x.ai::one": {"key": "old", "user_id": "a",
            "expires_at": "2026-01-01T00:00:00Z"},
            "https://auth.x.ai::two": {"key": "new", "user_id": "b",
            "expires_at": "2026-12-01T00:00:00Z"}});
        let sign_in = sign_in_from(&auth).unwrap();
        assert_eq!(
            (sign_in.token.as_str(), sign_in.user_id.as_str()),
            ("new", "b")
        );
        assert!(sign_in.expires_ms > 0);
    }

    #[test]
    fn billing_url_stays_on_the_proxy() {
        assert!(billing_url().starts_with("https://"));
        assert!(billing_url().ends_with("/billing?format=credits"));
    }
}
