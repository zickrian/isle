// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! opencode (`opencode run`) with the user's own providers: one run per turn, resumed, every tool but web
//! search denied, in folders of its own so its chats never mix with the user's. Its words come as each step ends.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use anyhow::{Context, bail};
use chrono::{DateTime, Local, NaiveDate};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::{self, UnboundedSender};

use super::answer::{Answer, SCHEMA};
use super::child::{self, Events};

const STDERR_LINES: usize = 20;
/// The agent Isle defines in `CONFIG`, and the title its conversations get (none is asked of the model).
const AGENT: &str = "isle";
const TITLE: &str = "Isle";
/// Every tool opencode 1.18 has but web search and `read` (see `config`), denied by name after "*": a config merged in ahead of Isle's
/// keeps its own key order, so an "allow" there for one of these would otherwise come after "*" and win.
const DENIED: &[&str] = &[
    "bash",
    "edit",
    "write",
    "patch",
    "apply_patch",
    "multiedit",
    "glob",
    "grep",
    "list",
    "webfetch",
    "codesearch",
    "task",
    "todowrite",
    "todoread",
    "skill",
    "lsp",
    "question",
    "external_directory",
    "doom_loop",
    "plan_enter",
    "plan_exit",
    "workflow_tool_approval",
    "execute",
    "batch",
];
/// The one path `read` may open, which never exists (see `config`).
const NO_FILE: &str = "/nonexistent/isle-reads-nothing";
/// The oldest opencode Isle runs: 1.4.8 first reads sign-ins from OPENCODE_AUTH_CONTENT, and has the
/// permission rules (1.1.1) and OPENCODE_DISABLE_PROJECT_CONFIG (1.1.29) the sandbox needs.
const MIN_VERSION: [u32; 3] = [1, 4, 8];
const VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Longest one `opencode models` run may take to make opencode 2's database.
const BOOTSTRAP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Longest `opencode session delete` may take before it is stopped.
const FORGET_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// All opencode gets of isled's environment (and `LC_*`): no OPENCODE_* settings, no provider keys.
const KEPT_ENV: &[&str] = &[
    "PATH",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TMPDIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

/// Written on every start, in Isle's own config folder for opencode: no tool but web search, no MCP
/// servers, plugins, sharing, snapshots or updates. A tool not allowed is not even offered to the model.
fn config() -> String {
    let mut permission = serde_json::Map::new();
    permission.insert("*".into(), "deny".into());
    for tool in DENIED {
        permission.insert((*tool).into(), "deny".into());
    }
    permission.insert("websearch".into(), "allow".into());
    // OpenCode's free models answer only a run that offers `read`: offered, it may open no file at all.
    permission.insert(
        "read".into(),
        serde_json::json!({"*": "deny", NO_FILE: "allow"}),
    );
    let config = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": false,
        "share": "disabled",
        "snapshot": false,
        "mcp": {},
        "plugin": [],
        "instructions": [],
        "permission": permission,
        "agent": {AGENT: {
            "mode": "primary",
            "description": "Isle's assistant: answers only, Isle runs the actions",
            "steps": 8,
            "permission": permission,
        }},
    });
    serde_json::to_string_pretty(&config).unwrap_or_default()
}

/// What each turn's `opencode run` needs, and the conversation it resumes.
pub struct Opencode {
    program: PathBuf,
    model: String,
    workspace: PathBuf,
    /// Isle's job and the answer's shape, as the agent's own prompt.
    prompt: String,
    /// opencode 2: lowercase log levels and `--standalone`; 1.x takes neither.
    opencode2: bool,
    pub conversation: Option<String>,
}

/// Isle's folders for opencode: its HOME, config, data and state, none of them the user's.
fn isle_home() -> PathBuf {
    crate::store::data_dir().join("opencode")
}

/// Where opencode keeps Isle's conversations (its database) and logs.
fn data() -> PathBuf {
    isle_home().join("data/opencode")
}

/// The environment Isle runs opencode in: away from the user's opencode setup and their projects.
fn contained() -> Vec<(&'static str, PathBuf)> {
    let home = isle_home();
    vec![
        ("HOME", home.join("home")),
        ("XDG_CONFIG_HOME", home.join("config")),
        ("XDG_DATA_HOME", home.join("data")),
        ("XDG_STATE_HOME", home.join("state")),
        // The models list and the like: fetched again when gone.
        ("XDG_CACHE_HOME", crate::store::cache_dir().join("opencode")),
        // No opencode.json or .opencode folder above Isle's workspace, no external plugins or skills.
        ("OPENCODE_DISABLE_PROJECT_CONFIG", "1".into()),
        ("OPENCODE_PURE", "1".into()),
        ("OPENCODE_DISABLE_CLAUDE_CODE", "1".into()),
        ("OPENCODE_DISABLE_EXTERNAL_SKILLS", "1".into()),
        ("OPENCODE_DISABLE_AUTOUPDATE", "1".into()),
        ("OPENCODE_DISABLE_LSP_DOWNLOAD", "1".into()),
        ("OPENCODE_DISABLE_SHARE", "1".into()),
        ("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER", "1".into()),
        // Web search with every provider's models, not only opencode's own.
        ("OPENCODE_ENABLE_EXA", "1".into()),
    ]
}

/// `opencode` with `contained()`, `KEPT_ENV` and the user's sign-ins: none of the user's own OPENCODE_*
/// settings (another config, permissions) or API keys come along.
fn command(program: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command.env_clear();
    for (name, value) in std::env::vars_os() {
        let text = name.to_string_lossy();
        if KEPT_ENV.contains(&text.as_ref()) || text.starts_with("LC_") {
            command.env(&name, value);
        }
    }
    command.envs(contained());
    // 1.x reads sign-ins from here; 2.x keeps them in its database (see `sync_credentials`).
    command.env("OPENCODE_AUTH_CONTENT", sign_ins());
    command
}

/// The user's own opencode folder for `kind` ("data", "config", "state"): `$XDG_<KIND>_HOME/opencode`.
fn user_dir(kind: &str) -> PathBuf {
    let base = match kind {
        "config" => dirs::config_dir(),
        "state" => dirs::state_dir(),
        _ => dirs::data_dir(),
    };
    base.unwrap_or_default().join("opencode")
}

/// The user's sign-ins (`auth.json`).
fn user_auth() -> PathBuf {
    user_dir("data").join("auth.json")
}

/// The user's opencode 2 database: its sign-ins live there, not in `auth.json`.
fn user_db() -> PathBuf {
    user_dir("data").join("opencode.db")
}

/// Isle's own opencode database: its conversations and the sign-ins shared into it.
fn isle_db() -> PathBuf {
    data().join("opencode.db")
}

/// The user's `auth.json`, parsed; null when missing or unreadable.
fn read_auth(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// The user's sign-ins as opencode 2 keeps them in its database; empty when it has none or can't be read.
fn db_sign_ins() -> Value {
    db_sign_ins_at(&user_db())
}

/// `db_sign_ins` for a given database, also in tests.
fn db_sign_ins_at(path: &Path) -> Value {
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY;
    let Ok(db) = rusqlite::Connection::open_with_flags(path, flags) else {
        return Value::Null;
    };
    let Ok(mut statement) = db.prepare("SELECT integration_id, value FROM credential") else {
        return Value::Null;
    };
    let Ok(rows) = statement.query_map(rusqlite::params![], |row| {
        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
    }) else {
        return Value::Null;
    };
    let mut sign_ins = serde_json::Map::new();
    for (integration, value) in rows.flatten() {
        let Some(integration) = integration else {
            continue;
        };
        let entry: Value = serde_json::from_str(&value).unwrap_or_default();
        // Only API keys and OAuth sign-ins: an "external" one is a reference, not a sign-in.
        if matches!(entry["type"].as_str(), Some("key" | "oauth")) {
            sign_ins.insert(integration, entry);
        }
    }
    Value::Object(sign_ins)
}

/// The user's sign-ins from either opencode generation: 1.x's `auth.json`, 2.x's database.
fn user_sign_ins() -> Value {
    let mut sign_ins = usable_sign_ins(&read_auth(&user_auth()));
    if let (Some(own), Some(db)) = (sign_ins.as_object_mut(), db_sign_ins().as_object()) {
        for (integration, entry) in db {
            own.entry(integration.clone())
                .or_insert_with(|| entry.clone());
        }
    }
    sign_ins
}

/// Whether the user signed in to a provider with opencode (`opencode auth login`).
pub fn signed_in() -> bool {
    user_sign_ins()
        .as_object()
        .is_some_and(|entries| !entries.is_empty())
}

/// The user's 1.x sign-ins, as opencode reads them from OPENCODE_AUTH_CONTENT.
fn sign_ins() -> String {
    usable_sign_ins(&read_auth(&user_auth())).to_string()
}

/// Only API keys and OAuth sign-ins: a "well-known" one has opencode fetch its server's config, MCP servers
/// and permissions included, and merge them in ahead of Isle's.
fn usable_sign_ins(auth: &Value) -> Value {
    let kept = auth
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, entry)| matches!(entry["type"].as_str(), Some("api" | "oauth")))
        .map(|(provider, entry)| (provider.clone(), entry.clone()));
    Value::Object(kept.collect())
}

impl Opencode {
    /// Remembers the conversation to resume (`resume`) and the job (`instructions`). Each turn starts
    /// `opencode run` and lets it exit: it answers once and stops.
    pub async fn start(
        program: &Path,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
        instructions: &str,
    ) -> anyhow::Result<Self> {
        let version = check_version(program).await?;
        std::fs::create_dir_all(workspace)?;
        write_config().context("could not write opencode's settings")?;
        if version[0] >= 2 {
            share_sign_ins(program).await;
        }
        Ok(Self {
            program: program.to_owned(),
            model: model.to_owned(),
            workspace: workspace.to_owned(),
            opencode2: version[0] >= 2,
            prompt: format!(
                "{instructions}\n\nAnswer every request with one JSON object and nothing else (no text or \
                 code fence around it), as this JSON Schema describes: {SCHEMA}"
            ),
            conversation: resume.map(str::to_owned),
        })
    }

    /// One turn, started over once in a new conversation when the old one is gone.
    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        let mut answer = self.turn(prompt, activity).await;
        // Another turn holding opencode's database (one left answering as the island closed): wait it out.
        for wait in [1, 3] {
            match &answer {
                Err(err) if database_locked(err) => {
                    tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                    answer = self.turn(prompt, activity).await;
                }
                _ => break,
            }
        }
        // A resumed session opencode no longer has (deleted, or never stored): start a new one, once.
        match answer {
            Err(err) if self.conversation.is_some() && session_missing(&err) => {
                self.conversation = None;
                self.turn(prompt, activity).await
            }
            other => other,
        }
    }

    /// One `opencode run`.
    async fn turn(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        // One file per turn: two turns at once (the eval, a background answer) must never read each other's.
        static TURNS: AtomicU64 = AtomicU64::new(0);
        let turn = TURNS.fetch_add(1, Ordering::Relaxed);
        // Counted until the turn ends, so its conversations are never deleted under it (see `prune`).
        let _running = Running::new();
        let config_path = isle_home().join(format!("turn-{}-{turn}.json", std::process::id()));
        let config = serde_json::json!({"agent": {AGENT: {"prompt": self.prompt}}});
        crate::store::write_private(&config_path, config.to_string().as_bytes())
            .context("could not write opencode's prompt")?;
        let _config_file = TurnFile(config_path.clone());
        // Declared before the run, so it is dropped after it, however the turn ends.
        let _hand_back = HandBack;
        if self.opencode2 {
            // A sign-in renewed in the user's own opencode since the last turn.
            sync_credentials(&user_db(), &isle_db());
        }
        let mut command = Command::from(command(&self.program));
        command.arg("run");
        // opencode 2 otherwise starts a background service on its default port, which the user's own may hold.
        if self.opencode2 {
            command.arg("--standalone");
        }
        command
            .args(["--format", "json", "--agent", AGENT, "--title", TITLE])
            // Its errors as they happen: a used-up plan is retried for a minute before the run says so.
            .args(["--print-logs", "--log-level"])
            // 2.x takes the lowercase names; 1.x's are uppercase only.
            .arg(if self.opencode2 { "error" } else { "ERROR" })
            .env("OPENCODE_CONFIG", &config_path)
            .current_dir(&self.workspace)
            // The request goes in on stdin: on the command line, any user could read it.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // As one argument each: a value starting with "-" can't pass for an option.
        if !self.model.is_empty() {
            command.arg(format!("--model={}", self.model));
        }
        if let Some(id) = &self.conversation {
            command.arg(format!("--session={id}"));
        }
        let mut child = child::spawn(&mut command)
            .context("could not start opencode; is opencode installed?")?;
        let events = Events::new(child.stdout.take().expect("piped stdout"));
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        let (fatal_tx, mut fatal) = mpsc::unbounded_channel();
        let mut lines = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
        let kept = stderr.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(reason) = fatal_error(&line) {
                    fatal_tx.send(reason).ok();
                }
                let mut kept = kept.lock().unwrap();
                if kept.len() == STDERR_LINES {
                    kept.pop_front();
                }
                kept.push_back(line);
            }
        });
        let mut stdin = child.stdin.take().expect("piped stdin");
        // One that stopped at once (an unknown option, say) still left its reason: read it then.
        let sent = async {
            stdin.write_all(prompt.as_bytes()).await?;
            stdin.shutdown().await
        }
        .await;
        drop(stdin);
        let (answer, fatal) = tokio::select! {
            answer = read_turn(&mut self.conversation, events, activity) => (answer, false),
            Some(reason) = fatal.recv() => (Err(anyhow::anyhow!(reason)), true),
        };
        drop(child);
        // Its reason alone: the rest of the logged line would only blur it.
        if fatal {
            return answer;
        }
        let answer = match (answer, sent) {
            (Err(err), Err(sent)) => Err(err.context(format!("opencode stopped: {sent}"))),
            (answer, _) => answer,
        };
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

/// Writes Isle's settings for opencode into its own config folder.
fn write_config() -> std::io::Result<()> {
    let dir = isle_home().join("config/opencode");
    crate::store::create_private_dir(&dir)?;
    crate::store::create_private_dir(&isle_home().join("home"))?;
    std::fs::write(dir.join("opencode.json"), config())
}

/// What `opencode models` lists for the user's providers: each model's `provider/model` line, with
/// its details as JSON when opencode still has `--verbose` (before 2.0).
pub async fn models(program: &Path) -> anyhow::Result<String> {
    write_config().context("could not write opencode's settings")?;
    let _hand_back = HandBack;
    // opencode 2 dropped `--verbose` and starts a background service unless it runs standalone; 1.x has no
    // `--standalone`.
    let standalone = check_version(program)
        .await
        .is_ok_and(|version| version[0] >= 2);
    if standalone {
        share_sign_ins(program).await;
    }
    models_listing(program, standalone).await
}

/// One `opencode models` run: 1.x's `--verbose` details, or 2.x's plain list, standalone.
async fn models_listing(program: &Path, standalone: bool) -> anyhow::Result<String> {
    use tokio::io::AsyncReadExt;
    let mut command = Command::from(command(program));
    command
        .args(["models"])
        .arg(if standalone {
            "--standalone"
        } else {
            "--verbose"
        })
        .current_dir(isle_home())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = child::spawn(&mut command).context("could not start opencode")?;
    let mut listed = String::new();
    child
        .stdout
        .take()
        .expect("piped stdout")
        .read_to_string(&mut listed)
        .await?;
    let status = child.wait().await?;
    if !status.success() {
        bail!("opencode models failed ({status})");
    }
    Ok(listed)
}

/// opencode 2 keeps sign-ins in its database: one run makes it when missing, then the user's go in.
async fn share_sign_ins(program: &Path) {
    if !isle_db().exists() {
        let _ = tokio::time::timeout(BOOTSTRAP_TIMEOUT, models_listing(program, true)).await;
    }
    sync_credentials(&user_db(), &isle_db());
}

/// A model as `opencode models` lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    /// `provider/model`, as opencode takes it.
    pub id: String,
    pub provider: String,
    pub name: String,
    /// Costs nothing to use (OpenCode's free models).
    pub free: bool,
}

/// The models in `opencode models` (or its older `--verbose` details), in its order: only what the
/// user's own providers (or OpenCode's free ones, signed in or not) offer now.
pub fn listed_models(listed: &str) -> Vec<Listed> {
    let mut models = Vec::new();
    let mut id: Option<&str> = None;
    let mut details = String::new();
    let mut finish = |id: Option<&str>, details: &str| {
        if let Some(id) = id {
            let (provider, model) = id.split_once('/').unwrap_or(("", id));
            let details = serde_json::from_str::<Value>(details).unwrap_or_default();
            let name = details["name"]
                .as_str()
                .filter(|name| !name.is_empty())
                .unwrap_or(model)
                .to_owned();
            let cost = &details["cost"];
            // The plain list has no costs; OpenCode's free models say so in their id.
            let free = if details.is_object() {
                cost["input"].as_f64() == Some(0.0) && cost["output"].as_f64() == Some(0.0)
            } else {
                model.ends_with("-free")
            };
            // Isle says "free" itself: "MiMo V2.5 Free" is "MiMo V2.5".
            let name = match name
                .strip_suffix(" Free")
                .or_else(|| name.strip_suffix(" free"))
            {
                Some(bare) if free && !bare.is_empty() => bare.to_owned(),
                _ => name,
            };
            models.push(Listed {
                id: id.to_owned(),
                provider: provider.to_owned(),
                name,
                free,
            });
        }
    };
    for line in listed.lines() {
        // `provider/model` alone at the start of a line; the details are indented or braces.
        let model = line.trim_end();
        if !model.is_empty()
            && !model.starts_with(char::is_whitespace)
            && !model.starts_with(['{', '}'])
            && model.contains('/')
            && !model.contains(char::is_whitespace)
        {
            finish(id, &details);
            id = Some(model);
            details.clear();
        } else if id.is_some() {
            details.push_str(line);
            details.push('\n');
        }
    }
    finish(id, &details);
    models
}

/// OpenCode Go's model list, as its website lists it (the same for Go, Go Plus and Go Teams, which differ in
/// limits only).
const GO_MODELS: &str = "https://opencode.ai/zen/go/v1/models";
const GO_MODELS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The models OpenCode Go offers now (`opencode-go/<id>`); None when it can't be asked.
pub async fn go_models() -> Option<Vec<String>> {
    let read = tokio::task::spawn_blocking(|| {
        crate::http::get(GO_MODELS, GO_MODELS_TIMEOUT)
            .call()
            .ok()?
            .body_mut()
            .read_json::<Value>()
            .ok()
    });
    let list = read.await.ok()??;
    let ids = list["data"]
        .as_array()?
        .iter()
        .filter_map(|model| model["id"].as_str());
    Some(ids.map(|id| format!("opencode-go/{id}")).collect())
}

/// The user's OpenCode plan, by their sign-ins: "OpenCode Go", "OpenCode Zen", or "Free models" without either.
pub fn plan() -> &'static str {
    plan_of(&user_sign_ins())
}

fn plan_of(sign_ins: &Value) -> &'static str {
    if sign_ins.get("opencode-go").is_some() {
        "OpenCode Go"
    } else if sign_ins.get("opencode").is_some() {
        "OpenCode Zen"
    } else {
        "Free models"
    }
}

/// The models the user chose in opencode itself, first first: `model` in their config, then the ones they
/// used last (opencode's own default comes from these too).
pub fn preferred() -> Vec<String> {
    let config = user_dir("config");
    // opencode reads these the other way round, a later one over an earlier one.
    let configured = ["opencode.jsonc", "opencode.json", "config.json"]
        .iter()
        .filter_map(|name| std::fs::read_to_string(config.join(name)).ok())
        .filter_map(|text| jsonc(&text)?["model"].as_str().map(str::to_owned))
        .find(|model| !model.is_empty());
    let recent = std::fs::read(user_dir("state").join("model.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|state| recent_models(&state))
        .unwrap_or_default();
    configured.into_iter().chain(recent).collect()
}

/// `recent` in opencode's model.json, as `provider/model`.
fn recent_models(state: &Value) -> Vec<String> {
    state["recent"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let provider = model["providerID"].as_str().filter(|p| !p.is_empty())?;
            let id = model["modelID"].as_str().filter(|m| !m.is_empty())?;
            Some(format!("{provider}/{id}"))
        })
        .collect()
}

/// The model the user would get in opencode itself, when they picked none in Isle.
pub(super) fn user_model() -> Option<String> {
    preferred().into_iter().next()
}

/// JSON with comments and trailing commas (opencode.jsonc), parsed.
fn jsonc(text: &str) -> Option<Value> {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            plain.push(c);
            match c {
                '\\' => plain.extend(chars.next()),
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                plain.push(c);
            }
            ('/', Some('/')) => while chars.next_if(|&c| c != '\n').is_some() {},
            ('/', Some('*')) => {
                chars.next();
                let mut last = ' ';
                for c in chars.by_ref() {
                    if last == '*' && c == '/' {
                        break;
                    }
                    last = c;
                }
            }
            _ => plain.push(c),
        }
    }
    // A comma before a closing bracket, comments already gone.
    let mut tidy = String::with_capacity(plain.len());
    let mut in_string = false;
    let mut escaped = false;
    for (at, c) in plain.char_indices() {
        if in_string {
            in_string = escaped || c != '"';
            escaped = !escaped && c == '\\';
        } else if c == '"' {
            in_string = true;
        } else if c == ',' && plain[at + 1..].trim_start().starts_with(['}', ']']) {
            continue;
        }
        tidy.push(c);
    }
    serde_json::from_str(&tidy).ok()
}

/// opencode stopped on its database busy with another run (its last logged line says so): worth asking again in a
/// moment. A lock it got over and went on from is not this.
fn database_locked(err: &anyhow::Error) -> bool {
    err.to_string()
        .rsplit(" | ")
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| line.contains("database is locked"))
}

/// Whether `err` is a resume of a session opencode does not have, rather than a failure of the answer.
fn session_missing(err: &anyhow::Error) -> bool {
    // Its own words exactly: a logged "Model not found" is not this.
    format!("{err:#}").contains("Session not found")
}

/// Refuses an opencode older than `MIN_VERSION`, whose sandbox settings Isle can't rely on, and answers with
/// the version it found. Asked once per installed program (its path and when it changed).
async fn check_version(program: &Path) -> anyhow::Result<[u32; 3]> {
    static CHECKED: Mutex<Option<(PathBuf, std::time::SystemTime, [u32; 3])>> = Mutex::new(None);
    let changed = std::fs::metadata(program)
        .and_then(|meta| meta.modified())
        .ok();
    let key = changed.map(|time| (program.to_owned(), time));
    let cached = {
        let checked = CHECKED.lock().unwrap_or_else(PoisonError::into_inner);
        checked
            .as_ref()
            .filter(|(path, time, _)| key.as_ref().is_some_and(|(p, t)| p == path && t == time))
            .map(|(_, _, found)| *found)
    };
    if let Some(found) = cached {
        return Ok(found);
    }
    let mut command = Command::from(command(program));
    command
        .arg("--version")
        .current_dir(isle_home())
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    std::fs::create_dir_all(isle_home())?;
    let output = tokio::time::timeout(VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow::anyhow!("opencode did not say its version in time"))?
        .context("could not start opencode")?;
    let text = String::from_utf8_lossy(&output.stdout);
    match version(&text) {
        Some(found) if found >= MIN_VERSION => {
            if let Some((path, time)) = key {
                *CHECKED.lock().unwrap_or_else(PoisonError::into_inner) = Some((path, time, found));
            }
            Ok(found)
        }
        // Fails closed: an older sandbox might let tools through.
        _ => bail!(
            "opencode {} is too old for Isle, which needs {}.{}.{} or newer",
            text.trim(),
            MIN_VERSION[0],
            MIN_VERSION[1],
            MIN_VERSION[2]
        ),
    }
}

/// "1.18.30" (also "v1.18.30", "1.18.30-beta.1") as numbers.
fn version(text: &str) -> Option<[u32; 3]> {
    let word = text.split_whitespace().find(|word| {
        word.trim_start_matches('v')
            .starts_with(|c: char| c.is_ascii_digit())
    })?;
    let mut parts = word.trim_start_matches('v').split('.').map(|part| {
        let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
        digits.parse::<u32>().ok()
    });
    Some([
        parts.next()??,
        parts.next()??,
        parts.next().flatten().unwrap_or(0),
    ])
}

/// A logged model error the run would only retry for a minute before giving up: a sign-in or a plan's limit.
fn fatal_error(line: &str) -> Option<String> {
    if !line.contains("message=\"stream error\"") {
        return None;
    }
    let reason = log_field(line, "error.error")?;
    let lower = reason.to_lowercase();
    let failure = super::brain::explain(super::brain::Provider::Opencode, &reason);
    let used_up = [
        "usage limit",
        "quota",
        "insufficient",
        "billing",
        "credit",
        "subscription",
        "payment",
    ]
    .iter()
    .any(|word| lower.contains(word));
    (failure.sign_in || used_up).then_some(reason)
}

/// `key="value"` in a log line, its escaped quotes undone.
fn log_field(line: &str, key: &str) -> Option<String> {
    let start = line.find(&format!("{key}=\""))? + key.len() + 2;
    let mut value = String::new();
    let mut chars = line[start..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(value),
            '\\' => value.extend(chars.next()),
            c => value.push(c),
        }
    }
    Some(value)
}

/// Holds a turn's settings file until the run has read it.
struct TurnFile(PathBuf);

impl Drop for TurnFile {
    /// The file goes once the turn ends, however it ended.
    fn drop(&mut self) {
        std::fs::remove_file(&self.0).ok();
    }
}

/// Reads one run's events into an answer, keeping the session id and what to show meanwhile.
async fn read_turn<R: AsyncRead + Unpin>(
    conversation: &mut Option<String>,
    mut events: Events<R>,
    activity: Option<&UnboundedSender<String>>,
) -> anyhow::Result<Answer> {
    let words: &[&str] = &[
        "\"step_start\"",
        "\"text\"",
        "\"tool_use\"",
        "\"type\":\"error\"",
    ];
    // What the model said in its last step: the answer, once the run ends.
    let mut said = String::new();
    while let Some(event) = events.next(words).await? {
        if let Some(id) = event["sessionID"].as_str().filter(|id| session_id(id)) {
            *conversation = Some(id.to_owned());
        }
        match event["type"].as_str() {
            Some("step_start") => said.clear(),
            Some("text") => said.push_str(event["part"]["text"].as_str().unwrap_or_default()),
            Some("tool_use") => {
                if let (Some(activity), Some(step)) = (activity, step(&event["part"])) {
                    activity.send(step).ok();
                }
            }
            Some("error") => bail!("{}", reason(&event["error"])),
            _ => {}
        }
    }
    if said.trim().is_empty() {
        bail!("opencode stopped");
    }
    Ok(answer_in(&said))
}

/// What a tool opencode ran did, for the island: its web searches.
fn step(part: &Value) -> Option<String> {
    if part["tool"] != "websearch" {
        return None;
    }
    Some(
        match part["state"]["input"]["query"]
            .as_str()
            .filter(|q| !q.is_empty())
        {
            Some(query) => format!("Searching the web for “{query}”…"),
            None => "Searching the web…".into(),
        },
    )
}

/// Why opencode failed, in its own words ("Free usage limit reached"), so `brain::explain` can tell the
/// user; the error's name when it gave none.
fn reason(error: &Value) -> String {
    [&error["data"]["message"], &error["message"], &error["name"]]
        .iter()
        .find_map(|value| value.as_str().filter(|text| !text.trim().is_empty()))
        .map_or_else(
            || error.to_string().chars().take(300).collect(),
            str::to_owned,
        )
}

/// The answer in what the model said: its JSON, also with words or a code fence around it, else the text.
fn answer_in(said: &str) -> Answer {
    let said = said.trim();
    if let (Some(start), Some(end)) = (said.find('{'), said.rfind('}'))
        && start < end
        && serde_json::from_str::<Answer>(&said[start..=end]).is_ok()
    {
        return super::answer::from_text(&said[start..=end]);
    }
    super::answer::from_text(said)
}

/// Whether `id` looks like one of opencode's session ids (`ses_…`): safe to pass on.
fn session_id(id: &str) -> bool {
    id.len() <= 80
        && id
            .strip_prefix("ses_")
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// Hands sign-ins opencode renewed in Isle's folder back to the user's own when dropped: 1.x's `auth.json`
/// (then deleted), and 2.x's `credential` rows (kept, as the sandbox's own database).
struct HandBack;

impl Drop for HandBack {
    /// Also when the turn was stopped or timed out.
    fn drop(&mut self) {
        hand_back(&data().join("auth.json"), &user_auth());
        sync_credentials(&user_db(), &isle_db());
    }
}

/// opencode saves a sign-in it renewed (ChatGPT's, whose old refresh token then stops working) in `isle`,
/// with all the others: only renewed ones go into the user's `user`, over an older one of the same.
fn hand_back(isle: &Path, user: &Path) {
    if std::fs::symlink_metadata(isle).is_err() {
        return;
    }
    let renewed = read_auth(isle);
    let mut own = read_auth(user);
    let expires = |entry: &Value| entry["expires"].as_i64().unwrap_or(0);
    let mut changed = false;
    if let Some(own) = own.as_object_mut() {
        for (provider, entry) in renewed.as_object().into_iter().flatten() {
            // Never one the user signed out of meanwhile, nor over one they signed in again with since.
            let Some(theirs) = own.get_mut(provider) else {
                continue;
            };
            if entry["type"] == "oauth"
                && theirs["type"] == "oauth"
                && entry != theirs
                && expires(entry) > expires(theirs)
            {
                *theirs = entry.clone();
                changed = true;
            }
        }
    }
    if changed && let Err(err) = write_auth(user, &own) {
        log::warn!("could not hand opencode's renewed sign-in back: {err}");
    }
    std::fs::remove_file(isle).ok();
}

/// Writes `auth` over `path` all at once, readable by the user only, as opencode keeps it.
fn write_auth(path: &Path, auth: &Value) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let temp = path.with_extension("json.isle-tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)?;
    file.write_all(&serde_json::to_vec_pretty(auth).unwrap_or_default())?;
    file.sync_all()?;
    std::fs::rename(temp, path)
}

/// One row of opencode 2's `credential` table, copied between databases as it is.
struct SignIn {
    id: String,
    integration: Option<String>,
    label: String,
    value: String,
    connector: Option<String>,
    method: Option<String>,
    active: Option<i64>,
    created: i64,
    updated: i64,
}

impl SignIn {
    /// Every sign-in `db` has.
    fn read(db: &rusqlite::Connection) -> rusqlite::Result<Vec<Self>> {
        let mut statement = db.prepare(
            "SELECT id, integration_id, label, value, connector_id, method_id, active, \
             time_created, time_updated FROM credential",
        )?;
        let rows = statement.query_map(rusqlite::params![], |row| {
            Ok(Self {
                id: row.get(0)?,
                integration: row.get(1)?,
                label: row.get(2)?,
                value: row.get(3)?,
                connector: row.get(4)?,
                method: row.get(5)?,
                active: row.get(6)?,
                created: row.get(7)?,
                updated: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    /// Writes it over the same id, unless `db` already has a newer one.
    fn save(&self, db: &rusqlite::Connection) -> rusqlite::Result<()> {
        db.execute(
            "INSERT INTO credential (id, integration_id, label, value, connector_id, method_id, active, \
             time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
             ON CONFLICT(id) DO UPDATE SET integration_id = excluded.integration_id, \
             label = excluded.label, value = excluded.value, connector_id = excluded.connector_id, \
             method_id = excluded.method_id, active = excluded.active, \
             time_created = excluded.time_created, time_updated = excluded.time_updated \
             WHERE excluded.time_updated > credential.time_updated",
            rusqlite::params![
                self.id,
                self.integration,
                self.label,
                self.value,
                self.connector,
                self.method,
                self.active,
                self.created,
                self.updated
            ],
        )?;
        Ok(())
    }

    /// Writes it over the same id only when `db` still has it, so a sign-in deleted meanwhile stays gone.
    fn update(&self, db: &rusqlite::Connection) -> rusqlite::Result<()> {
        db.execute(
            "UPDATE credential SET integration_id = ?2, label = ?3, value = ?4, connector_id = ?5, \
             method_id = ?6, active = ?7, time_created = ?8, time_updated = ?9 \
             WHERE id = ?1 AND time_updated < ?9",
            rusqlite::params![
                self.id,
                self.integration,
                self.label,
                self.value,
                self.connector,
                self.method,
                self.active,
                self.created,
                self.updated
            ],
        )?;
        Ok(())
    }
}

/// opencode 2 keeps sign-ins in its database, not `auth.json`: copies the user's into Isle's sandbox, and a
/// sign-in opencode renewed there back into the user's, the newer row winning. Isle-only sign-ins stay put,
/// and one the user removed is neither deleted here nor put back.
fn sync_credentials(user: &Path, sandbox: &Path) {
    if !user.exists() || !sandbox.exists() {
        return;
    }
    if let Err(err) = sync_credentials_at(user, sandbox) {
        log::debug!("could not share opencode's sign-ins: {err:#}");
    }
}

/// `sync_credentials` on given databases, also in tests.
fn sync_credentials_at(user: &Path, sandbox: &Path) -> anyhow::Result<()> {
    use rusqlite::{Connection, OpenFlags};
    let user_db = Connection::open_with_flags(user, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let sandbox_db = Connection::open_with_flags(sandbox, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    // The sandbox database holds the user's sign-ins: only they may read it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(sandbox, std::fs::Permissions::from_mode(0o600))?;
    }
    for db in [&user_db, &sandbox_db] {
        // The user's own opencode may be writing: wait it out, as a turn does.
        db.busy_timeout(std::time::Duration::from_secs(2))?;
    }
    let theirs = SignIn::read(&user_db)?;
    let ours = SignIn::read(&sandbox_db)?;
    // Theirs first, so a sign-in new to the sandbox is there before the next run.
    for sign_in in &theirs {
        sign_in.save(&sandbox_db)?;
    }
    // Then only what the sandbox renewed, and only if the user still has it: a sign-in only the sandbox
    // has, or one the user removed meanwhile, stays out of their database.
    for sign_in in &ours {
        if theirs.iter().any(|theirs| theirs.id == sign_in.id) {
            sign_in.update(&user_db)?;
        }
    }
    Ok(())
}

/// Deletes Isle's opencode conversation `id` now (an id as opencode makes them).
pub fn forget(id: &str) {
    if !session_id(id) {
        return;
    }
    let Some(program) = super::brain::Provider::Opencode.program() else {
        return;
    };
    // Counted like a turn, so `prune` never deletes the database it opens.
    let _running = Running::new();
    let _hand_back = HandBack;
    let id = id.to_owned();
    // A runtime of its own on a thread of its own: callers block, inside a runtime or not.
    let deleted = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async {
            let mut command = Command::from(command(&program));
            command.args(["session", "delete"]);
            // As every run: opencode 2 otherwise starts a background service, on a port the user's own may hold.
            if check_version(&program)
                .await
                .is_ok_and(|version| version[0] >= 2)
            {
                command.arg("--standalone");
            }
            command
                .arg(&id)
                .current_dir(isle_home())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let mut child = child::spawn(&mut command)?;
            // Dropped on time or not, its whole group goes.
            match tokio::time::timeout(FORGET_TIMEOUT, child.wait()).await {
                Ok(status) => status.map(drop),
                Err(_) => Err(std::io::Error::other("no answer in time")),
            }
        })
    })
    .join();
    if let Ok(Err(err)) = deleted {
        log::warn!("opencode could not delete Isle's conversation: {err}");
    }
}

/// opencode turns under way in this isled: `prune` leaves their folders alone until none.
static RUNNING: Mutex<Turns> = Mutex::new(Turns {
    running: 0,
    prune: None,
});

/// Turns under way, and the day a prune waits to run for once none is.
struct Turns {
    running: usize,
    prune: Option<NaiveDate>,
}

/// One turn counted in `RUNNING`, from before it starts until it ends.
struct Running;

impl Running {
    /// Counts a turn starting.
    fn new() -> Self {
        RUNNING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running += 1;
        Self
    }
}

impl Drop for Running {
    /// The turn it counted ended; the last one runs a prune asked for meanwhile.
    fn drop(&mut self) {
        let mut turns = RUNNING.lock().unwrap_or_else(PoisonError::into_inner);
        turns.running -= 1;
        if turns.running == 0
            && let Some(today) = turns.prune.take()
        {
            prune_in(&isle_home(), &user_auth(), today);
        }
    }
}

/// Deletes Isle's opencode conversations last used before `today`.
pub fn prune(today: NaiveDate) {
    let mut turns = RUNNING.lock().unwrap_or_else(PoisonError::into_inner);
    if turns.running > 0 {
        turns.prune = Some(today);
        return;
    }
    prune_in(&isle_home(), &user_auth(), today);
}

/// `prune` on a given folder; the caller holds `RUNNING`. Every conversation is in one database, written on
/// each turn: last written before today, all of them are old, and its data and state folders go whole.
fn prune_in(home: &Path, user_auth: &Path, today: NaiveDate) {
    // A renewed sign-in an isled stopped mid-turn left behind: 1.x's file, and 2.x's database rows.
    hand_back(&home.join("data/opencode/auth.json"), user_auth);
    sync_credentials(
        &user_auth.with_file_name("opencode.db"),
        &home.join("data/opencode/opencode.db"),
    );
    let old = |path: &Path| {
        std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .is_ok_and(|time| DateTime::<Local>::from(time).date_naive() < today)
    };
    let data = home.join("data/opencode");
    let database = ["opencode.db", "opencode.db-wal"]
        .iter()
        .map(|name| data.join(name))
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
    if database.iter().all(|path| old(path)) {
        std::fs::remove_dir_all(&data).ok();
        std::fs::remove_dir_all(home.join("state")).ok();
    } else if let Ok(entries) = std::fs::read_dir(data.join("log")) {
        // opencode's own log of each run: those from before today.
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_file()) && old(&entry.path()) {
                std::fs::remove_file(entry.path()).ok();
            }
        }
    }
    // Turn files an isled stopped mid-turn left; a running one's (this isled's too) are still read.
    for entry in std::fs::read_dir(home).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let regular = entry.file_type().is_ok_and(|kind| kind.is_file());
        let pid = name
            .strip_prefix("turn-")
            .and_then(|rest| rest.split('-').next())
            .and_then(|pid| pid.parse::<u32>().ok());
        let Some(pid) = pid.filter(|_| regular && name.ends_with(".json")) else {
            continue;
        };
        if !Path::new(&format!("/proc/{pid}")).exists() {
            std::fs::remove_file(entry.path()).ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_sandbox_offers_only_web_search() {
        let config: Value = serde_json::from_str(&config()).unwrap();
        for permission in [&config["permission"], &config["agent"][AGENT]["permission"]] {
            let rules = permission.as_object().unwrap();
            // Everything denied first, then each tool by name, web search the only exception.
            let keys: Vec<&str> = rules.keys().map(String::as_str).collect();
            assert_eq!(keys.first(), Some(&"*"));
            assert_eq!(keys.last(), Some(&"read"));
            for tool in ["bash", "edit", "write", "webfetch", "task", "skill"] {
                assert_eq!(permission[tool], "deny", "{tool}");
            }
            // Offered for the free models, but only for a file that never exists.
            assert_eq!(permission["read"], json!({"*": "deny", NO_FILE: "allow"}));
            assert!(!Path::new(NO_FILE).exists());
            let allowed: Vec<&str> = rules
                .iter()
                .filter(|(_, rule)| *rule != "deny")
                .map(|(tool, _)| tool.as_str())
                .collect();
            assert_eq!(allowed, ["websearch", "read"]);
        }
        assert_eq!(config["mcp"], json!({}));
        assert_eq!(config["plugin"], json!([]));
        assert_eq!(config["snapshot"], false);
        assert_eq!(config["share"], "disabled");
        let names: Vec<&str> = contained().iter().map(|(name, _)| *name).collect();
        for needed in [
            "HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "OPENCODE_DISABLE_PROJECT_CONFIG",
            "OPENCODE_PURE",
        ] {
            assert!(names.contains(&needed), "{needed}");
        }
        // Nothing of isled's environment but the few it needs.
        let command = command(Path::new("/bin/true"));
        let passed: Vec<String> = command
            .get_envs()
            .filter(|(_, value)| value.is_some())
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect();
        assert!(passed.iter().all(|name| KEPT_ENV.contains(&name.as_str())
            || name.starts_with("LC_")
            || name.starts_with("XDG_")
            || name == "HOME"
            || name.starts_with("OPENCODE_")));
        assert!(!passed.iter().any(|name| name == "OPENCODE_CONFIG"));
    }

    #[test]
    fn shares_only_keys_and_oauth_sign_ins() {
        let auth = json!({
            "anthropic": {"type": "api", "key": "sk-1"},
            "github-copilot": {"type": "oauth", "refresh": "g", "access": "g", "expires": 0},
            "openai": {"type": "oauth", "refresh": "r", "access": "a", "expires": 1},
            // Its server's config would come in with it, MCP servers and permissions included.
            "https://corp.example": {"type": "wellknown", "key": "TOKEN", "token": "t"},
        });
        let shared = usable_sign_ins(&auth);
        assert_eq!(shared["anthropic"]["key"], "sk-1");
        assert!(shared["github-copilot"].is_object() && shared["openai"].is_object());
        assert!(shared["https://corp.example"].is_null());
        assert_eq!(usable_sign_ins(&Value::Null), json!({}));
        assert_eq!(
            usable_sign_ins(&json!({"x": {"type": "wellknown"}})),
            json!({})
        );
    }

    #[test]
    fn hands_a_renewed_sign_in_back() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("isle-opencode-auth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (isle, user) = (dir.join("isle.json"), dir.join("auth.json"));
        let oauth = |refresh: &str, expires: i64| json!({"type": "oauth", "refresh": refresh, "access": "a", "expires": expires});
        let write = |path: &Path, value: Value| std::fs::write(path, value.to_string()).unwrap();
        write(
            &user,
            json!({"openai": oauth("old", 100), "zai": oauth("mine", 500),
                "anthropic": {"type": "api", "key": "sk-1"}}),
        );
        // opencode renewed ChatGPT's and wrote every sign-in; one the user has not got, and an older one.
        write(
            &isle,
            json!({"openai": oauth("new", 200), "zai": oauth("stale", 300),
                "gone": oauth("x", 900), "anthropic": {"type": "api", "key": "sk-1"}}),
        );
        hand_back(&isle, &user);
        let own = read_auth(&user);
        assert_eq!(own["openai"]["refresh"], "new");
        assert_eq!(own["zai"]["refresh"], "mine");
        assert!(own["gone"].is_null());
        assert_eq!(own["anthropic"]["key"], "sk-1");
        assert!(!isle.exists());
        let mode = std::fs::metadata(&user).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        // Nothing renewed: the user's file is left as it was.
        let before = std::fs::read(&user).unwrap();
        write(&isle, json!({"openai": oauth("new", 200)}));
        hand_back(&isle, &user);
        assert_eq!(std::fs::read(&user).unwrap(), before);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_opencode_too_old_for_the_sandbox() {
        assert_eq!(version("1.18.30\n"), Some([1, 18, 30]));
        assert_eq!(version("opencode v1.4.8-beta.2"), Some([1, 4, 8]));
        assert_eq!(version("2.1"), Some([2, 1, 0]));
        assert_eq!(version("unknown"), None);
        assert!(version("1.4.7").unwrap() < MIN_VERSION);
        assert!(version("1.4.8").unwrap() >= MIN_VERSION);
        let failure = super::super::brain::explain(
            super::super::brain::Provider::Opencode,
            "opencode 1.2.0 is too old for Isle, which needs 1.4.8 or newer",
        );
        assert_eq!(failure.error, "Update opencode");
    }

    #[test]
    fn reads_the_answer_and_steps() {
        let answer = answer_in(
            r#"{"say": "Done.", "actions": [{"type": "open_url", "url": "https://x.com"}]}"#,
        );
        assert_eq!((answer.say.as_str(), answer.actions.len()), ("Done.", 1));
        // Words or a fence around the JSON.
        let wrapped = answer_in("Here you go:\n```json\n{\"say\": \"Hi\", \"actions\": []}\n```");
        assert_eq!(wrapped.say, "Hi");
        assert_eq!(answer_in("Just {braces} here").say, "Just {braces} here");
        let search = json!({"type": "tool", "tool": "websearch",
            "state": {"status": "completed", "input": {"query": "cuaca jakarta"}}});
        assert_eq!(
            step(&search).unwrap(),
            "Searching the web for “cuaca jakarta”…"
        );
        assert!(step(&json!({"tool": "bash"})).is_none());
        let locked = anyhow::anyhow!("opencode stopped")
            .context("\u{1b}[91mError: \u{1b}[0mUnexpected error |  | database is locked");
        assert!(database_locked(&locked));
        let got_over_it =
            anyhow::anyhow!("no answer").context("database is locked | Error: Session not found");
        assert!(!database_locked(&got_over_it));
        assert!(!database_locked(&anyhow::anyhow!(
            "Free usage limit reached."
        )));
        let error = json!({"name": "APIError", "data": {"message": "Free usage limit reached.", "statusCode": 429}});
        assert_eq!(reason(&error), "Free usage limit reached.");
        assert_eq!(
            reason(&json!({"name": "ProviderAuthError"})),
            "ProviderAuthError"
        );
    }

    #[tokio::test]
    async fn reads_a_whole_run() {
        let output = concat!(
            r#"{"type":"step_start","sessionID":"ses_abc123","part":{"type":"step-start"}}"#,
            "\n",
            r#"{"type":"text","sessionID":"ses_abc123","part":{"type":"text","text":"Let me look."}}"#,
            "\n",
            r#"{"type":"tool_use","sessionID":"ses_abc123","part":{"type":"tool","tool":"websearch","state":{"status":"completed","input":{"query":"x"}}}}"#,
            "\n",
            r#"{"type":"step_finish","sessionID":"ses_abc123","part":{"reason":"tool-calls"}}"#,
            "\n",
            r#"{"type":"step_start","sessionID":"ses_abc123","part":{"type":"step-start"}}"#,
            "\n",
            r#"{"type":"text","sessionID":"ses_abc123","part":{"type":"text","text":"{\"say\":\"Found it.\",\"actions\":[]}"}}"#,
            "\n",
        );
        let mut conversation = None;
        let (activity, mut steps) = mpsc::unbounded_channel();
        let events = Events::new(output.as_bytes());
        let answer = read_turn(&mut conversation, events, Some(&activity))
            .await
            .unwrap();
        assert_eq!(answer.say, "Found it.");
        assert_eq!(conversation.as_deref(), Some("ses_abc123"));
        assert_eq!(steps.recv().await.unwrap(), "Searching the web for “x”…");
        let failed = r#"{"type":"error","sessionID":"ses_abc123","error":{"name":"APIError","data":{"message":"Unauthorized: invalid api key"}}}"#;
        let err = read_turn(&mut conversation, Events::new(failed.as_bytes()), None)
            .await
            .unwrap_err();
        let failure = super::super::brain::explain(
            super::super::brain::Provider::Opencode,
            &format!("{err:#}"),
        );
        assert!(failure.sign_in);
    }

    #[test]
    fn stops_at_once_for_a_used_up_plan_or_a_sign_in() {
        let line = r#"timestamp=2026-11-02T03:17:46.706Z level=ERROR run=e5 message="stream error" providerID=opencode error.error="AI_APICallError: Free usage limit reached. Subscribe to \"Go\"""#;
        assert_eq!(
            fatal_error(line).unwrap(),
            "AI_APICallError: Free usage limit reached. Subscribe to \"Go\""
        );
        let busy = r#"level=ERROR message="stream error" error.error="Provider is overloaded""#;
        assert!(fatal_error(busy).is_none());
        let other = r#"level=ERROR message="failed to load" error.error="invalid api key""#;
        assert!(fatal_error(other).is_none());
        assert!(session_missing(&anyhow::anyhow!(
            "\u{1b}[91mError: \u{1b}[0mSession not found"
        )));
        // A logged line that names a session and something else not found is not this.
        assert!(!session_missing(&anyhow::anyhow!(
            "session.id=ses_1 error=\"ProviderModelNotFoundError: Model not found: x/y.\""
        )));
        assert!(session_id("ses_e65bcb073ffedUY1DzOChtZano"));
        assert!(!session_id("ses_../x") && !session_id("abc"));
    }

    #[test]
    fn finds_the_users_own_model() {
        let config = "{\n  // mine\n  \"$schema\": \"https://opencode.ai/config.json\", /* a \"note\" */\n  \
                      \"model\": \"anthropic/claude-sonnet-5\",\n  \"x\": \"a // not a comment\",\n}\n";
        let parsed = jsonc(config).unwrap();
        assert_eq!(parsed["model"], "anthropic/claude-sonnet-5");
        assert_eq!(parsed["x"], "a // not a comment");
        let state =
            json!({"recent": [{"providerID": "openai", "modelID": "gpt-5.6"}, {"providerID": ""}]});
        assert_eq!(recent_models(&state), ["openai/gpt-5.6"]);
        assert_eq!(
            listed_models("opencode/mimo-free\n{\"name\": \"MiMo V2.5 Free\", \"cost\": {\"input\": 0, \"output\": 0}}\n")[0].name,
            "MiMo V2.5"
        );
        let listed = "opencode/big-pickle\n{\n  \"id\": \"big-pickle\",\n  \"name\": \"Big Pickle\",\n  \
                      \"cost\": {\"input\": 0, \"output\": 0}\n}\n\
                      anthropic/claude-x\n{\n  \"cost\": {\"input\": 3, \"output\": 15}\n}\n";
        let listed = listed_models(listed);
        assert_eq!(listed.len(), 2);
        assert_eq!(
            (
                listed[0].id.as_str(),
                listed[0].provider.as_str(),
                listed[0].name.as_str(),
                listed[0].free
            ),
            ("opencode/big-pickle", "opencode", "Big Pickle", true)
        );
        assert_eq!(
            (
                listed[1].id.as_str(),
                listed[1].name.as_str(),
                listed[1].free
            ),
            ("anthropic/claude-x", "claude-x", false)
        );
        // opencode 2 lists ids only; a free model still says so in its id.
        let plain = listed_models(
            "opencode/deepseek-v4.1-flash-free\nopencode/big-pickle\nanthropic/claude-x\n",
        );
        assert_eq!(plain.len(), 3);
        assert_eq!(
            (
                plain[0].name.as_str(),
                plain[0].free,
                plain[1].free,
                plain[2].free
            ),
            ("deepseek-v4.1-flash-free", true, false, false)
        );
    }

    /// OpenCode Go's list as its website has it now.
    #[tokio::test]
    #[ignore = "asks opencode.ai"]
    async fn reads_opencode_gos_own_list() {
        let models = go_models().await.expect("opencode.ai answers");
        println!("{} models: {models:?}", models.len());
        assert!(models.len() > 5 && models.iter().all(|id| id.starts_with("opencode-go/")));
    }

    #[test]
    fn tells_the_users_opencode_plan() {
        assert_eq!(plan_of(&json!({})), "Free models");
        assert_eq!(
            plan_of(&json!({"openai": {"type": "oauth"}})),
            "Free models"
        );
        assert_eq!(
            plan_of(&json!({"opencode": {"type": "api"}})),
            "OpenCode Zen"
        );
        assert_eq!(
            plan_of(&json!({"opencode": {"type": "api"}, "opencode-go": {"type": "api"}})),
            "OpenCode Go"
        );
    }

    #[test]
    fn shares_opencode_2s_sign_ins_with_the_sandbox() {
        let dir = std::env::temp_dir().join(format!("isle-opencode-db-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let user = dir.join("user.db");
        let sandbox = dir.join("sandbox.db");
        let open = |path: &Path| {
            let db = rusqlite::Connection::open(path).unwrap();
            db.execute_batch(
                "CREATE TABLE credential (
                    id text PRIMARY KEY,
                    integration_id text,
                    label text NOT NULL,
                    value text NOT NULL,
                    connector_id text,
                    method_id text,
                    active integer,
                    time_created integer NOT NULL,
                    time_updated integer NOT NULL
                );",
            )
            .unwrap();
            db
        };
        let key = |name: &str| json!({"type": "key", "key": name}).to_string();
        let insert = |db: &rusqlite::Connection, id: &str, value: &str, updated: i64| {
            db.execute(
                "INSERT INTO credential VALUES (?1, ?1, ?1, ?2, NULL, NULL, 1, ?3, ?3)",
                rusqlite::params![id, value, updated],
            )
            .unwrap()
        };
        let user_db = open(&user);
        insert(&user_db, "deepseek", &key("user"), 10);
        insert(&user_db, "opencode", &key("old"), 10);
        // An "external" credential is a reference, not a sign-in.
        insert(&user_db, "corp", r#"{"type":"external"}"#, 10);
        let sandbox_db = open(&sandbox);
        insert(&sandbox_db, "opencode", &key("renewed"), 20);
        insert(&sandbox_db, "github-copilot", &key("isle"), 30);
        drop((user_db, sandbox_db));

        sync_credentials_at(&user, &sandbox).unwrap();

        let read = |path: &Path, id: &str| -> Option<String> {
            let db = rusqlite::Connection::open(path).unwrap();
            db.query_row(
                "SELECT value FROM credential WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .ok()
        };
        // The user's sign-ins reach the sandbox; the sandbox's renewed one goes back.
        assert_eq!(read(&sandbox, "deepseek"), Some(key("user")));
        assert_eq!(read(&sandbox, "opencode"), Some(key("renewed")));
        assert_eq!(read(&user, "opencode"), Some(key("renewed")));
        // A sign-in only the sandbox has stays out of the user's database.
        assert_eq!(read(&sandbox, "github-copilot"), Some(key("isle")));
        assert_eq!(read(&user, "github-copilot"), None);
        // The plan comes from the user's sign-ins, not the reference.
        let plan = db_sign_ins_at(&user);
        assert_eq!(plan["deepseek"]["type"], "key");
        assert_eq!(plan["opencode"]["type"], "key");
        assert!(plan["corp"].is_null());
        assert_eq!(plan_of(&plan), "OpenCode Zen");
        // A sign-in the user removed is not put back by the sandbox's copy.
        let user_db = rusqlite::Connection::open(&user).unwrap();
        user_db
            .execute("DELETE FROM credential WHERE id = 'deepseek'", [])
            .unwrap();
        drop(user_db);
        sync_credentials_at(&user, &sandbox).unwrap();
        assert_eq!(read(&user, "deepseek"), None);
        assert_eq!(read(&sandbox, "deepseek"), Some(key("user")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The real opencode, asked to change this computer: nothing may change. ISLE_OPENCODE_PROBE_MODEL picks
    /// the model (else opencode's own).
    #[tokio::test]
    #[ignore = "asks the real opencode"]
    async fn a_real_run_cannot_touch_files() {
        let program = super::super::brain::Provider::Opencode
            .program()
            .expect("opencode installed");
        let dir = std::env::temp_dir().join(format!("isle-opencode-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("touched");
        let model = std::env::var("ISLE_OPENCODE_PROBE_MODEL").unwrap_or_default();
        let instructions = "You are a test. Do exactly what the user asks, with your own tools.";
        let mut opencode =
            Opencode::start(&program, &model, None, &dir.join("workspace"), instructions)
                .await
                .unwrap();
        let ask = format!(
            "Use your bash tool to run `touch {0}`, then write the file {0} with your write tool, \
             then fetch http://127.0.0.1:9/ with webfetch. Say what happened.",
            target.display()
        );
        let answer = opencode.ask(&ask, None).await;
        println!("answer: {answer:?}");
        assert!(!target.exists(), "opencode changed a file");
        if let Some(id) = &opencode.conversation {
            forget(id);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A "well-known" sign-in whose server sends a config allowing every tool and an MCP server: Isle never
    /// hands it on. ISLE_OPENCODE_PROBE_WELLKNOWN is that server; ISLE_OPENCODE_PROBE_MARKER the file its MCP
    /// command would make. Run with XDG_DATA_HOME on a folder of its own: it writes the sign-in there.
    #[tokio::test]
    #[ignore = "asks the real opencode, with a stand-in server"]
    async fn a_well_known_sign_in_brings_no_tools_or_mcp_servers() {
        let server = std::env::var("ISLE_OPENCODE_PROBE_WELLKNOWN").expect("the stand-in server");
        let marker = PathBuf::from(std::env::var("ISLE_OPENCODE_PROBE_MARKER").expect("a marker"));
        assert!(
            std::env::var_os("XDG_DATA_HOME").is_some(),
            "never the real sign-in"
        );
        let auth = user_auth();
        assert!(
            !auth.exists(),
            "refusing to replace a sign-in at {}",
            auth.display()
        );
        std::fs::create_dir_all(auth.parent().unwrap()).unwrap();
        let sign_in = json!({&server: {"type": "wellknown", "key": "PROBE_TOKEN", "token": "t"}});
        std::fs::write(&auth, sign_in.to_string()).unwrap();
        let program = super::super::brain::Provider::Opencode
            .program()
            .expect("opencode installed");
        let dir = std::env::temp_dir().join(format!("isle-opencode-wk-{}", std::process::id()));
        let target = dir.join("touched");
        let model = std::env::var("ISLE_OPENCODE_PROBE_MODEL").unwrap_or_default();
        let mut opencode = Opencode::start(&program, &model, None, &dir.join("workspace"), "Test.")
            .await
            .unwrap();
        let answer = opencode
            .ask(
                &format!("Use bash to run `touch {}`.", target.display()),
                None,
            )
            .await;
        println!("answer: {answer:?}");
        std::fs::remove_file(&auth).ok();
        assert!(!target.exists(), "a tool ran");
        assert!(!marker.exists(), "the server's MCP command ran");
        if let Some(id) = &opencode.conversation {
            forget(id);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prunes_a_database_last_used_before_today() {
        let home = std::env::temp_dir().join(format!("isle-opencode-prune-{}", std::process::id()));
        let data = home.join("data/opencode");
        std::fs::create_dir_all(data.join("log")).unwrap();
        let age = |path: &Path, days: u64| {
            std::fs::write(path, "").unwrap();
            let when = std::time::SystemTime::now() - std::time::Duration::from_secs(days * 86_400);
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(when)
                .unwrap();
        };
        let today = Local::now().date_naive();
        let user_auth = home.join("user-auth.json");
        let live = home.join(format!("turn-{}-0.json", std::process::id()));
        age(&data.join("opencode.db"), 0);
        age(&data.join("log/old.log"), 2);
        age(&data.join("log/new.log"), 0);
        // No process has this id (above the kernel's most).
        age(&home.join("turn-4294967295-0.json"), 0);
        age(&live, 0);
        prune_in(&home, &user_auth, today);
        // Used today: only yesterday's logs and a stopped isled's turn file go; a running one's stays.
        assert!(data.join("opencode.db").exists() && data.join("log/new.log").exists());
        assert!(!data.join("log/old.log").exists());
        assert!(!home.join("turn-4294967295-0.json").exists() && live.exists());
        age(&data.join("opencode.db"), 1);
        prune_in(&home, &user_auth, today);
        assert!(!data.exists());
        std::fs::remove_dir_all(&home).unwrap();
    }
}
