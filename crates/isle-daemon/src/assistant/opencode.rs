// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! opencode (`opencode run`) with the user's own providers: one run per turn, resumed, every tool but web
//! search denied, in folders of its own so its chats never mix with the user's. Its words come as each step ends.

use std::collections::{HashSet, VecDeque};
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
/// Longest `opencode models` may take to make opencode 2's database.
const BOOTSTRAP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// How old Isle's copy of opencode 1.x's model catalog (models.dev's) may get before it is fetched again:
/// 1.x keeps using the one it has, so a model dropped since stayed in Settings and a new one never came.
const CATALOG_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
/// opencode 2's models that have a medium variant (`provider/model`), as its API lists them: asked by each
/// model listing, and by a turn when no listing did yet. `None` until asked.
static MEDIUM: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Longest one `opencode auth ...` may take before it is stopped.
const AUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// How long the user's own sign-ins are reused before asking opencode again.
const USER_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30);
/// Longest `opencode session delete` may take before it is stopped.
const FORGET_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// One credential sync at a time: a model listing and a turn must not interleave.
static SYNCING: Mutex<()> = Mutex::new(());
/// The user's last `auth export`, with the data folder it came from; `None` when it failed, so a failing
/// opencode is not started again for every check.
#[allow(clippy::type_complexity)]
static USER_SIGN_INS: Mutex<Option<(PathBuf, std::time::Instant, Option<Vec<Value>>)>> =
    Mutex::new(None);
/// opencode's version as last asked, with the program and its change time it is good for.
static VERSION: Mutex<Option<(PathBuf, std::time::SystemTime, [u32; 3])>> = Mutex::new(None);
/// The sandbox's sign-ins as last synced, so a pre-turn or pre-listing sync need not start opencode.
static SANDBOX_SIGN_INS: Mutex<Option<(PathBuf, Vec<Value>)>> = Mutex::new(None);
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
    // Read from the user's file each time; a sign-in opencode renews goes back to it (see `HandBack`).
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

/// The user's opencode 2 database: its sign-ins live there, not `auth.json`.
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

/// Whether the user signed in to a provider with opencode (`opencode auth login`).
pub fn signed_in() -> bool {
    user_sign_ins()
        .as_object()
        .is_some_and(|entries| !entries.is_empty())
}

/// The user's sign-ins from either opencode generation: 1.x's `auth.json`, 2.x's `opencode auth export`.
fn user_sign_ins() -> Value {
    let mut sign_ins = usable_sign_ins(&read_auth(&user_auth()));
    // opencode 1.x has an opencode.db too, but no `auth export`: only a version Isle already knows is 2 or
    // newer is asked, so a check never waits for opencode to start just to say its version.
    if user_db().exists()
        && let Some(program) = super::brain::Provider::Opencode.program()
        && known_version(&program).is_some_and(|version| version[0] >= 2)
        && let Some(data) = dirs::data_dir()
        && let Ok(rows) = user_auth_rows(&program, &data)
        && let Some(own) = sign_ins.as_object_mut()
    {
        for row in &rows {
            if let Some(integration) = row["integrationID"].as_str() {
                own.insert(integration.to_owned(), row["value"].clone());
            }
        }
    }
    sign_ins
}

/// Whether the user signed in to OpenAI in opencode with a ChatGPT account (not an API key): opencode then
/// asks Codex's servers, which take only the models Codex lists for that account.
pub fn chatgpt_sign_in() -> bool {
    user_sign_ins()["openai"]["type"] == "oauth"
}

/// The user's sign-ins, as opencode reads them from OPENCODE_AUTH_CONTENT.
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

/// `command` for the blocking auth calls below, which cannot await.
fn std_command(program: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command.env_clear();
    for (name, value) in std::env::vars_os() {
        let text = name.to_string_lossy();
        if KEPT_ENV.contains(&text.as_ref()) || text.starts_with("LC_") {
            command.env(&name, value);
        }
    }
    command.envs(contained());
    command.env("OPENCODE_AUTH_CONTENT", sign_ins());
    command
}

/// `opencode auth` in the user's own folder (`sandbox` false) or Isle's.
fn auth_command(program: &Path, data_home: &Path, sandbox: bool) -> std::process::Command {
    let mut command = if sandbox {
        std_command(program)
    } else {
        std::process::Command::new(program)
    };
    command.env("XDG_DATA_HOME", data_home);
    command
}

/// Waits for an auth command, killing it after `timeout`.
fn wait_auth(
    child: &mut std::process::Child,
    timeout: std::time::Duration,
) -> anyhow::Result<std::process::ExitStatus> {
    let start = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if start.elapsed() >= timeout {
            child.kill().ok();
            let _ = child.wait();
            bail!("opencode auth took too long");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// opencode 2's sign-ins as `opencode auth export` gives them, keys and OAuth only.
fn auth_export(program: &Path, data_home: &Path, sandbox: bool) -> anyhow::Result<Vec<Value>> {
    let mut command = auth_command(program, data_home, sandbox);
    command
        .args(["auth", "export", "--standalone"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .context("could not start opencode auth export")?;
    let status = wait_auth(&mut child, AUTH_TIMEOUT)?;
    let mut stdout = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        std::io::Read::read_to_end(&mut out, &mut stdout)?;
    }
    if !status.success() {
        bail!("opencode auth export failed");
    }
    let rows: Vec<Value> =
        serde_json::from_slice(&stdout).context("opencode auth export gave no list")?;
    Ok(sign_ins_from(rows))
}

/// Imports `rows` with `opencode auth import`, which skips ids that are already there.
fn auth_import(
    program: &Path,
    data_home: &Path,
    sandbox: bool,
    rows: &[Value],
) -> anyhow::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut command = auth_command(program, data_home, sandbox);
    command
        .args(["auth", "import", "--standalone"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .context("could not start opencode auth import")?;
    let mut stdin = child
        .stdin
        .take()
        .context("no stdin for opencode auth import")?;
    let json = serde_json::to_vec(rows)?;
    if let Err(err) = std::io::Write::write_all(&mut stdin, &json) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err.into());
    }
    drop(stdin);
    if !wait_auth(&mut child, AUTH_TIMEOUT)?.success() {
        bail!("opencode auth import failed");
    }
    Ok(())
}

/// Removes one sign-in, so `auth import` can put a newer one under the same id.
fn auth_logout(
    program: &Path,
    data_home: &Path,
    sandbox: bool,
    integration: &str,
    id: &str,
) -> anyhow::Result<()> {
    let mut command = auth_command(program, data_home, sandbox);
    command
        .args(["auth", "logout", integration, id, "--standalone"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .context("could not start opencode auth logout")?;
    if !wait_auth(&mut child, AUTH_TIMEOUT)?.success() {
        bail!("opencode auth logout failed");
    }
    Ok(())
}

/// The user's sign-ins, reusing the last export for a few seconds: their own opencode changes them
/// rarely, and every export starts a whole opencode.
fn user_auth_rows(program: &Path, data_home: &Path) -> anyhow::Result<Vec<Value>> {
    let mut cached = USER_SIGN_INS.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((path, at, rows)) = cached.as_ref()
        && path.as_path() == data_home
        && at.elapsed() < USER_CACHE_TTL
    {
        // A failure is not "no sign-ins": the sandbox's copies must not be logged out over it.
        return rows
            .clone()
            .context("opencode auth export failed a moment ago");
    }
    let rows = auth_export(program, data_home, false);
    *cached = Some((
        data_home.to_owned(),
        std::time::Instant::now(),
        rows.as_ref().ok().cloned(),
    ));
    rows
}

/// Forgets the cached user export: after Isle writes a renewed sign-in back to the user's database.
fn forget_user_auth_rows() {
    *USER_SIGN_INS.lock().unwrap_or_else(PoisonError::into_inner) = None;
}

/// The sandbox's sign-ins, from the last sync unless `fresh` asks opencode again.
fn sandbox_auth_rows(program: &Path, data_home: &Path, fresh: bool) -> anyhow::Result<Vec<Value>> {
    let mut cached = SANDBOX_SIGN_INS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if !fresh
        && let Some((path, rows)) = cached.as_ref()
        && path.as_path() == data_home
    {
        return Ok(rows.clone());
    }
    let rows = auth_export(program, data_home, true)?;
    *cached = Some((data_home.to_owned(), rows.clone()));
    Ok(rows)
}

/// Replaces the cached sandbox state after imports or removals.
fn cache_sandbox_rows(data_home: &Path, rows: &[Value]) {
    *SANDBOX_SIGN_INS
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some((data_home.to_owned(), rows.to_vec()));
}

/// Forgets the cached sandbox state: its database is gone, or a sync did not finish.
fn forget_sandbox_rows() {
    *SANDBOX_SIGN_INS
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = None;
}

/// Only API keys and OAuth sign-ins: an "external" or "well-known" one would bring its server's config,
/// MCP servers and permissions.
fn sign_ins_from(rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter()
        .filter(|row| {
            matches!(row["value"]["type"].as_str(), Some("key" | "oauth"))
                && row["id"].is_string()
                && row["integrationID"].is_string()
        })
        .collect()
}

/// When an OAuth sign-in expires, in opencode's milliseconds; 0 when it says.
fn auth_expires(row: &Value) -> i64 {
    row["value"]["expires"].as_i64().unwrap_or(0)
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
        let _hand_back = HandBack(self.opencode2);
        if self.opencode2 {
            // The sandbox database, with the user's sign-ins from since the last turn.
            share_sign_ins(&self.program).await;
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
        if self.opencode2 {
            // A variant the model lacks is refused in 2.x: medium only where it has one.
            let model = with_effort(&self.program, &self.model).await;
            if !model.is_empty() {
                command.arg(format!("--model={model}"));
            }
        } else {
            if !self.model.is_empty() {
                command.arg(format!("--model={}", self.model));
            }
            // 1.x passes over a variant the model lacks.
            command.arg(format!("--variant={}", super::brain::EFFORT));
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
    // opencode 2 dropped `--verbose` and starts a background service unless it runs standalone; 1.x has no
    // `--standalone`.
    let standalone = check_version(program)
        .await
        .is_ok_and(|version| version[0] >= 2);
    let _hand_back = HandBack(standalone);
    if standalone {
        share_sign_ins(program).await;
        // opencode's API says what the plain list does not: each model's name, its price (Big Pickle is free
        // with no "-free" in its id) and which think at medium, for the turns. Not beside the plain list: two
        // private servers on one database, and one of them fails. The plain list when the API cannot say.
        if let Some(api) = model_api(program).await {
            *MEDIUM.lock().unwrap_or_else(PoisonError::into_inner) = Some(medium_of(&api));
            let named = listing_of(&api);
            if !listed_models(&named).is_empty() {
                return Ok(named);
            }
        }
        return models_listing(program, true).await;
    }
    refresh_catalog(program).await;
    models_listing(program, false).await
}

/// opencode 2's models as its own API gives them (`/api/model`); `None` when it could not say.
async fn model_api(program: &Path) -> Option<Value> {
    let mut command = Command::from(command(program));
    command
        .args(["api", "GET", "/api/model", "--standalone"])
        .current_dir(isle_home())
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    let output = tokio::time::timeout(BOOTSTRAP_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

/// An `/api/model` answer as 1.x's `opencode models --verbose` lists models: `provider/model`, then its name and
/// first price as JSON, for [`listed_models`].
fn listing_of(answer: &Value) -> String {
    let mut listed = String::new();
    for model in answer["data"].as_array().into_iter().flatten() {
        let (Some(provider), Some(id)) = (model["providerID"].as_str(), model["id"].as_str())
        else {
            continue;
        };
        if model["enabled"] == false {
            continue;
        }
        // 2.x prices in tiers; the first is the plain one.
        let cost = if model["cost"].is_array() {
            &model["cost"][0]
        } else {
            &model["cost"]
        };
        let details = serde_json::json!({
            "name": model["name"],
            "cost": {"input": cost["input"], "output": cost["output"]},
            "api": {"id": model["modelID"].as_str().unwrap_or(id)},
        });
        listed.push_str(&format!("{provider}/{id}\n{details}\n"));
    }
    listed
}

/// The models in an `/api/model` answer that have a variant named [`super::brain::EFFORT`].
fn medium_of(answer: &Value) -> HashSet<String> {
    answer["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| {
            model["variants"].as_array().is_some_and(|variants| {
                variants.iter().any(|variant| {
                    variant["id"] == super::brain::EFFORT || *variant == super::brain::EFFORT
                })
            })
        })
        .filter_map(|model| {
            Some(format!(
                "{}/{}",
                model["providerID"].as_str()?,
                model["id"].as_str()?
            ))
        })
        .collect()
}

/// `model` with opencode 2's `#medium` where it has that variant; as it is otherwise (its own default).
async fn with_effort(program: &Path, model: &str) -> String {
    if model.is_empty() {
        return String::new();
    }
    let known = MEDIUM
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let medium = match known {
        Some(medium) => medium,
        None => {
            let medium = model_api(program)
                .await
                .map(|api| medium_of(&api))
                .unwrap_or_default();
            *MEDIUM.lock().unwrap_or_else(PoisonError::into_inner) = Some(medium.clone());
            medium
        }
    };
    if medium.contains(model) {
        format!("{model}#{}", super::brain::EFFORT)
    } else {
        model.to_owned()
    }
}

/// Brings Isle's copy of opencode 1.x's model catalog up to date when it is a day old: the user's own copy
/// when that is newer (nothing downloaded), else opencode fetches it again, as it does when it has none.
async fn refresh_catalog(program: &Path) {
    let age = |path: &Path| {
        std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.elapsed().ok())
    };
    let isle = crate::store::cache_dir().join("opencode/opencode/models.json");
    let isle_age = age(&isle);
    if isle_age.is_some_and(|age| age < CATALOG_MAX_AGE) {
        return;
    }
    if let Some(user) = dirs::cache_dir().map(|dir| dir.join("opencode/models.json"))
        && let Some(user_age) = age(&user)
        && user_age < CATALOG_MAX_AGE
        && isle_age.is_none_or(|isle_age| user_age < isle_age)
        && copy_catalog(&user, &isle).is_ok()
    {
        return;
    }
    let mut command = Command::from(command(program));
    command
        .args(["models", "--refresh"])
        .current_dir(isle_home())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let _ = tokio::time::timeout(BOOTSTRAP_TIMEOUT, command.status()).await;
}

/// Copies the catalog `from` over `to` all at once, so opencode never reads half of it.
fn copy_catalog(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let part = to.with_extension("json.part");
    std::fs::copy(from, &part)?;
    std::fs::rename(&part, to)
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

/// opencode 2 keeps its sign-ins in its database: one run makes it when missing, then the user's go in.
async fn share_sign_ins(program: &Path) {
    if !user_db().exists() {
        return;
    }
    if !isle_db().exists() {
        forget_sandbox_rows();
        let _ = tokio::time::timeout(BOOTSTRAP_TIMEOUT, models_listing(program, true)).await;
    }
    // It starts opencode and waits for it: on a thread of its own, not one the daemon's tasks run on.
    let program = program.to_owned();
    let _ = tokio::task::spawn_blocking(move || sync_credentials(&program, false)).await;
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
    /// The model the provider is asked for: "gpt-6.1-sol" for "openai/gpt-6.1-sol-fast" (a faster tier of it).
    pub base: String,
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
            let base = details["api"]["id"]
                .as_str()
                .filter(|base| !base.is_empty())
                .unwrap_or(model)
                .to_owned();
            models.push(Listed {
                id: id.to_owned(),
                provider: provider.to_owned(),
                name,
                free,
                base,
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

/// The program and its change time a version found is good for.
fn version_key(program: &Path) -> Option<(PathBuf, std::time::SystemTime)> {
    let changed = std::fs::metadata(program)
        .and_then(|meta| meta.modified())
        .ok()?;
    Some((program.to_owned(), changed))
}

/// opencode's version if Isle already asked it (a model listing or a turn does), else `None`: never starts it.
fn known_version(program: &Path) -> Option<[u32; 3]> {
    let key = version_key(program)?;
    VERSION
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .filter(|(path, time, _)| *path == key.0 && *time == key.1)
        .map(|(_, _, found)| *found)
}

/// Asks opencode its version now, for `isled --doctor`, which lists or runs nothing first.
pub async fn learn_version(program: &Path) {
    let _ = check_version(program).await;
}

/// Refuses an opencode older than `MIN_VERSION`, whose sandbox settings Isle can't rely on, and answers with
/// the version it found. Asked once per installed program (its path and when it changed).
async fn check_version(program: &Path) -> anyhow::Result<[u32; 3]> {
    let key = version_key(program);
    if let Some(found) = known_version(program) {
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
                *VERSION.lock().unwrap_or_else(PoisonError::into_inner) = Some((path, time, found));
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

/// Hands sign-ins opencode renewed in Isle's folder back to the user's own when dropped, then deletes them.
struct HandBack(bool);

impl Drop for HandBack {
    /// Also when the turn was stopped or timed out.
    fn drop(&mut self) {
        hand_back(&data().join("auth.json"), &user_auth());
        if self.0
            && let Some(program) = super::brain::Provider::Opencode.program()
        {
            // The turn or listing may have renewed a sign-in: read the sandbox again, on a blocking thread
            // when a runtime is there (a dropped turn must not hold up the daemon's tasks).
            let sync = move || sync_credentials(&program, true);
            match tokio::runtime::Handle::try_current() {
                Ok(runtime) => drop(runtime.spawn_blocking(sync)),
                Err(_) => sync(),
            }
        }
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

/// opencode 2 keeps sign-ins in its database: copies the user's into Isle's sandbox, and a sign-in
/// opencode renewed there back into the user's, the newer one winning. Isle-only sign-ins stay put; one
/// the user removed is removed from the sandbox once it was copied from them, but not put back.
fn sync_credentials(program: &Path, fresh_sandbox: bool) {
    if !user_db().exists() || !isle_db().exists() {
        return;
    }
    let Some(user_data) = dirs::data_dir() else {
        return;
    };
    // A model listing and a turn must not interleave exports, imports and logouts.
    let _syncing = SYNCING.lock().unwrap_or_else(PoisonError::into_inner);
    let sandbox_data = isle_home().join("data");
    let shared = isle_home().join("shared.json");
    if let Err(err) =
        sync_credentials_at(program, &user_data, &sandbox_data, &shared, fresh_sandbox)
    {
        forget_sandbox_rows();
        log::debug!("could not share opencode's sign-ins: {err:#}");
    }
}

/// The ids copied from the user's opencode, so a removed one can go from the sandbox too (ids only,
/// no secrets).
fn read_shared(path: &Path) -> Vec<String> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// `sync_credentials` on given data folders, also in tests.
fn sync_credentials_at(
    program: &Path,
    user_data: &Path,
    sandbox_data: &Path,
    shared_path: &Path,
    fresh_sandbox: bool,
) -> anyhow::Result<()> {
    // The exports are independent: start them together, so a cold sync pays one startup.
    let (user, sandbox) = std::thread::scope(|scope| -> anyhow::Result<_> {
        let user = scope.spawn(|| user_auth_rows(program, user_data));
        let sandbox = scope.spawn(|| sandbox_auth_rows(program, sandbox_data, fresh_sandbox));
        let user = user
            .join()
            .map_err(|_| anyhow::anyhow!("user sign-in export panicked"))??;
        let sandbox = sandbox
            .join()
            .map_err(|_| anyhow::anyhow!("sandbox sign-in export panicked"))??;
        Ok((user, sandbox))
    })?;
    let mut final_sandbox = sandbox.clone();
    let before = read_shared(shared_path);
    let mut shared = Vec::new();
    // A sign-in copied from the user's opencode that they have since removed goes from the sandbox too.
    for id in before.clone() {
        if user
            .iter()
            .any(|row| row["id"].as_str() == Some(id.as_str()))
        {
            shared.push(id);
            continue;
        }
        if let Some(row) = sandbox
            .iter()
            .find(|row| row["id"].as_str() == Some(id.as_str()))
            && let (Some(integration), Some(row_id)) =
                (row["integrationID"].as_str(), row["id"].as_str())
        {
            if let Err(err) = auth_logout(program, sandbox_data, true, integration, row_id) {
                // Keep it and try again next time; one unknown or busy sign-in must not block the rest.
                log::debug!("could not remove opencode's sign-in {row_id}: {err:#}");
                shared.push(id);
            } else {
                final_sandbox.retain(|row| row["id"].as_str() != Some(row_id));
            }
        }
    }
    // Hand back what opencode renewed in Isle's sandbox, over an older sign-in of the user's.
    let mut renewed = Vec::new();
    let mut replaced = Vec::new();
    for row in &sandbox {
        let Some(theirs) = user.iter().find(|theirs| theirs["id"] == row["id"]) else {
            continue;
        };
        if row["value"]["type"] == "oauth"
            && auth_expires(row) > auth_expires(theirs)
            && let (Some(integration), Some(id)) =
                (row["integrationID"].as_str(), row["id"].as_str())
        {
            auth_logout(program, user_data, false, integration, id)?;
            replaced.push(theirs.clone());
            renewed.push(row.clone());
        }
    }
    if let Err(err) = auth_import(program, user_data, false, &renewed) {
        // Put back what was there if the import failed, so a sign-in is never lost.
        let _ = auth_import(program, user_data, false, &replaced);
        forget_user_auth_rows();
        return Err(err);
    }
    if !renewed.is_empty() {
        forget_user_auth_rows();
    }
    // Then the user's sign-ins into the sandbox: a new one, or a newer key or sign-in than Isle has.
    let mut fresh = Vec::new();
    for row in &user {
        let Some(theirs) = sandbox.iter().find(|theirs| theirs["id"] == row["id"]) else {
            fresh.push(row.clone());
            final_sandbox.push(row.clone());
            continue;
        };
        let changed = match row["value"]["type"].as_str() {
            Some("key") => row["value"] != theirs["value"],
            Some("oauth") => {
                auth_expires(row) >= auth_expires(theirs) && row["value"] != theirs["value"]
            }
            _ => false,
        };
        if changed
            && let (Some(integration), Some(id)) =
                (row["integrationID"].as_str(), row["id"].as_str())
        {
            auth_logout(program, sandbox_data, true, integration, id)?;
            final_sandbox.retain(|row| row["id"].as_str() != Some(id));
            fresh.push(row.clone());
            final_sandbox.push(row.clone());
        }
    }
    auth_import(program, sandbox_data, true, &fresh)?;
    cache_sandbox_rows(sandbox_data, &final_sandbox);
    for row in &user {
        if let Some(id) = row["id"].as_str()
            && !shared.iter().any(|kept| kept == id)
        {
            shared.push(id.to_owned());
        }
    }
    if shared != before {
        crate::store::write_private(shared_path, &serde_json::to_vec(&shared)?)?;
    }
    Ok(())
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
    let _hand_back = HandBack(false);
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
    // The database this cached may be the one about to go.
    forget_sandbox_rows();
    // A renewed sign-in an isled stopped mid-turn left behind.
    hand_back(&home.join("data/opencode/auth.json"), user_auth);
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
    fn names_and_prices_opencode_2s_models_from_its_api() {
        let answer = json!({"data": [
            {"providerID": "opencode", "id": "big-pickle", "name": "Big Pickle", "enabled": true,
                "cost": [{"input": 0, "output": 0}]},
            {"providerID": "deepseek", "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro", "enabled": true,
                "cost": [{"input": 0.4, "output": 1.6}]},
            {"providerID": "opencode", "id": "gone", "name": "Gone", "enabled": false, "cost": []}
        ]});
        let listed = listed_models(&listing_of(&answer));
        let shown: Vec<_> = listed
            .iter()
            .map(|m| (m.id.as_str(), m.name.as_str(), m.free))
            .collect();
        assert_eq!(
            shown,
            [
                ("opencode/big-pickle", "Big Pickle", true),
                ("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", false)
            ]
        );
    }

    #[test]
    fn thinks_at_medium_only_where_opencode_2_has_that_variant() {
        let answer = json!({"data": [
            {"providerID": "deepseek", "id": "deepseek-v4-pro", "variants": [{"id": "low"}, {"id": "medium"}]},
            {"providerID": "opencode", "id": "glm-5.3-flash-free", "variants": [{"id": "low"}, {"id": "high"}]},
            {"providerID": "opencode", "id": "big-pickle", "variants": []},
            {"providerID": "openai", "id": "gpt-6.1-sol", "variants": ["low", "medium", "high"]}
        ]});
        let medium = medium_of(&answer);
        assert!(
            medium.contains("deepseek/deepseek-v4-pro") && medium.contains("openai/gpt-6.1-sol")
        );
        assert!(
            !medium.contains("opencode/glm-5.3-flash-free")
                && !medium.contains("opencode/big-pickle")
        );
    }

    #[test]
    fn shares_only_keys_and_oauth_from_opencode_2s_database() {
        let kept = sign_ins_from(vec![
            json!({"id": "a", "integrationID": "a", "value": {"type": "key"}}),
            json!({"id": "b", "integrationID": "b", "value": {"type": "oauth"}}),
            json!({"id": "c", "integrationID": "c", "value": {"type": "external"}}),
            json!({"id": "d", "integrationID": "d", "value": {"type": "wellknown"}}),
        ]);
        assert_eq!(kept.len(), 2);
        assert!(kept.iter().all(|row| row["id"] != "c" && row["id"] != "d"));
    }

    #[test]
    fn stops_an_auth_command_that_hangs() {
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(wait_auth(&mut child, std::time::Duration::from_millis(100)).is_err());
    }

    /// A stand-in `opencode auth`: `creds.json` in each data folder, imports to `imported.json`, and a
    /// logout log. A `fail-import` file there makes the next import fail once.
    fn fake_opencode(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("bin/opencode");
        std::fs::create_dir_all(program.parent().unwrap()).unwrap();
        std::fs::write(
            &program,
            "#!/bin/sh\ncase \"$1 $2\" in\n  \"auth export\") cat \"$XDG_DATA_HOME/creds.json\" ;;\n  \"auth import\") if [ -e \"$XDG_DATA_HOME/fail-import\" ]; then rm -f \"$XDG_DATA_HOME/fail-import\"; cat > \"$XDG_DATA_HOME/failed-import.json\"; exit 1; fi; cat > \"$XDG_DATA_HOME/imported.json\" ;;\n  \"auth logout\") printf '%s %s\\n' \"$3\" \"$4\" >> \"$XDG_DATA_HOME/logout.log\" ;;\n  *) exit 1 ;;\nesac\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        program
    }

    #[test]
    fn shares_opencode_2s_sign_ins_with_the_sandbox() {
        let dir = std::env::temp_dir().join(format!("isle-opencode-2-auth-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let user = dir.join("user");
        let sandbox = dir.join("sandbox");
        let shared = dir.join("shared.json");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&sandbox).unwrap();
        let program = fake_opencode(&dir);
        let write = |dir: &Path, rows: Value| {
            std::fs::write(dir.join("creds.json"), rows.to_string()).unwrap();
        };
        write(
            &user,
            json!([
                {"id": "deepseek", "integrationID": "deepseek", "label": "DeepSeek", "active": true, "value": {"type": "key", "key": "user"}},
                {"id": "opencode", "integrationID": "opencode", "label": "Personal", "active": true, "value": {"type": "oauth", "refresh": "old", "access": "old", "expires": 10}},
                {"id": "corp", "integrationID": "corp", "label": "Corp", "active": true, "value": {"type": "external"}}
            ]),
        );
        write(
            &sandbox,
            json!([
                {"id": "opencode", "integrationID": "opencode", "label": "Personal", "active": true, "value": {"type": "oauth", "refresh": "renewed", "access": "renewed", "expires": 20}},
                {"id": "github-copilot", "integrationID": "github-copilot", "label": "Copilot", "active": true, "value": {"type": "key", "key": "isle"}}
            ]),
        );
        sync_credentials_at(&program, &user, &sandbox, &shared, true).unwrap();
        let marked: Vec<String> = serde_json::from_slice(&std::fs::read(&shared).unwrap()).unwrap();
        assert!(marked.contains(&"deepseek".to_owned()) && marked.contains(&"opencode".to_owned()));
        assert!(!marked.contains(&"github-copilot".to_owned()));
        let imported = |dir: &Path| -> Vec<Value> {
            serde_json::from_slice(&std::fs::read(dir.join("imported.json")).unwrap()).unwrap()
        };
        let into_sandbox = imported(&sandbox);
        assert!(
            into_sandbox
                .iter()
                .any(|row| row["id"] == "deepseek" && row["value"]["key"] == json!("user"))
        );
        assert!(!into_sandbox.iter().any(|row| row["id"] == "corp"));
        let into_user = imported(&user);
        assert!(
            into_user
                .iter()
                .any(|row| row["id"] == "opencode" && row["value"]["refresh"] == json!("renewed"))
        );
        assert!(!into_user.iter().any(|row| row["id"] == "github-copilot"));
        let logouts = std::fs::read_to_string(user.join("logout.log")).unwrap_or_default();
        assert!(logouts.contains("opencode opencode"));
        // A sign-in the user removed is not put back, and its shared sandbox copy goes too.
        write(&user, json!([]));
        std::fs::remove_file(user.join("imported.json")).unwrap();
        sync_credentials_at(&program, &user, &sandbox, &shared, true).unwrap();
        assert!(!user.join("imported.json").exists());
        let logouts = std::fs::read_to_string(sandbox.join("logout.log")).unwrap_or_default();
        assert!(logouts.contains("opencode opencode"));
        let marked: Vec<String> = serde_json::from_slice(&std::fs::read(&shared).unwrap()).unwrap();
        assert!(marked.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn puts_a_sign_in_back_when_the_hand_back_fails() {
        let dir =
            std::env::temp_dir().join(format!("isle-opencode-2-auth-back-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let user = dir.join("user");
        let sandbox = dir.join("sandbox");
        let shared = dir.join("shared.json");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&sandbox).unwrap();
        let program = fake_opencode(&dir);
        let oauth = |refresh: &str, expires: i64| {
            json!({"id": "opencode", "integrationID": "opencode", "label": "Personal", "active": true,
                "value": {"type": "oauth", "refresh": refresh, "access": refresh, "expires": expires}})
        };
        std::fs::write(
            user.join("creds.json"),
            json!([oauth("old", 10)]).to_string(),
        )
        .unwrap();
        std::fs::write(
            sandbox.join("creds.json"),
            json!([oauth("renewed", 20)]).to_string(),
        )
        .unwrap();
        std::fs::write(user.join("fail-import"), b"").unwrap();
        assert!(sync_credentials_at(&program, &user, &sandbox, &shared, true).is_err());
        let restored: Vec<Value> =
            serde_json::from_slice(&std::fs::read(user.join("imported.json")).unwrap()).unwrap();
        assert!(
            restored
                .iter()
                .any(|row| row["value"]["refresh"] == json!("old"))
        );
        assert!(
            !restored
                .iter()
                .any(|row| row["value"]["refresh"] == json!("renewed"))
        );
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
