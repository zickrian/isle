// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Codex as an app server with the user's sign-in: one process per conversation, kept up between turns so a
//! reply needs no start-up. Read-only with web search, in a home of its own apart from the user's chats.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError};

use anyhow::{Context, bail};
use chrono::{DateTime, Local, NaiveDate};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc::UnboundedSender;

use super::answer::{Answer, SCHEMA};
use super::child::{self, Events, Group};

const STDERR_LINES: usize = 20;
/// `model/list` comes in pages; a plan has a handful of models, so a few pages are plenty.
const MODEL_PAGES: usize = 5;
/// Blank space an answer ends in once its model is stuck (see `stuck`): far more than JSON ever needs.
const STUCK_BLANKS: usize = 200;
/// How long a stopped turn may take to end before the answer is given anyway.
const INTERRUPT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
/// Isle's Codex only answers, with web search: no shell, no files, no browser or desktop control, no
/// plugins or apps. Unknown keys are ignored, so names a Codex version lacks do no harm.
const CONFIG: &str =
    "# Written by Isle on every start: Codex here only answers; Isle runs the actions.
web_search = \"live\"
# Isle's own job and context say all: none of Codex's coding-agent notes about its sandbox (which would
# make it think it cannot act; Isle acts for it), its environment, apps or collaboration modes.
include_permissions_instructions = false
include_environment_context = false
include_apps_instructions = false
include_collaboration_mode_instructions = false
[features]
shell_tool = false
unified_exec = false
unified_exec_tty = false
shell_snapshot = false
apply_patch_freeform = false
view_image = false
computer_use = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
in_app_browser = false
in_app_local_automation = false
apps = false
plugins = false
remote_plugin = false
plugin_sharing = false
hooks = false
multi_agent = false
image_generation = false
skill_search = false
skill_mcp_dependency_install = false
tool_suggest = false
goals = false
worktrees = false
workspace_dependencies = false
sleep_tool = false
memories = false
";

/// One running `codex app-server` and the conversation it holds.
pub struct Codex {
    _child: Group,
    stdin: ChildStdin,
    events: Events<ChildStdout>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    model: String,
    workspace: PathBuf,
    instructions: String,
    schema: Value,
    next_id: u64,
    /// The thread is loaded in this process (started, or resumed from `conversation`).
    ready: bool,
    pub conversation: Option<String>,
    /// Counted for `prune` until the process above is gone (dropped after it).
    _alive: Alive,
}

/// Isle's Codex processes in this isled, starting or running: `prune` deletes their databases only at none.
static LIVE: Mutex<usize> = Mutex::new(0);

/// Held while one of them starts: Codexes making their databases at once (after `prune`) all but one stop,
/// "failed to initialize sqlite state runtime".
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// One Codex counted in `LIVE`, from before it starts until it is dropped.
struct Alive;

impl Alive {
    /// Waits for a `prune` under way, so no database goes while this Codex opens it.
    fn new() -> Self {
        *LIVE.lock().unwrap_or_else(PoisonError::into_inner) += 1;
        Self
    }
}

impl Drop for Alive {
    /// The Codex it counted is gone.
    fn drop(&mut self) {
        *LIVE.lock().unwrap_or_else(PoisonError::into_inner) -= 1;
    }
}

/// Codex's home for Isle, under Isle's data folder; it shares only the user's sign-in.
fn home() -> PathBuf {
    crate::store::data_dir().join("codex")
}

impl Codex {
    /// Starts the app server and says hello to it; the conversation (`resume`, else a new one with
    /// `instructions` as its job) is opened with the first turn, or by `warm`.
    pub async fn start(
        program: &Path,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
        instructions: &str,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(workspace)?;
        std::fs::create_dir_all(home())?;
        link_sign_in(&user_home(), &home());
        std::fs::write(home().join("config.toml"), CONFIG)
            .context("could not write Codex's settings")?;
        // "" is Codex's own default: the user's own model was weighed before (see `Session::choice`), so one
        // it refused is never put back here.
        let model = model.to_owned();
        let mut command = Command::new(program);
        command
            .args(["app-server", "-c", "sandbox_mode=\"read-only\""])
            .env("CODEX_HOME", home())
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let starting = STARTING.lock().await;
        let alive = Alive::new();
        let mut child =
            child::spawn(&mut command).context("could not start codex; is Codex installed?")?;
        let stdin = child.stdin.take().expect("piped stdin");
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
        let mut codex = Self {
            _child: child,
            stdin,
            events,
            stderr,
            model,
            workspace: workspace.to_owned(),
            instructions: instructions.to_owned(),
            schema: serde_json::from_str(&strict(SCHEMA)?)?,
            next_id: 0,
            ready: false,
            conversation: resume.map(str::to_owned),
            _alive: alive,
        };
        let version = env!("CARGO_PKG_VERSION");
        codex
            .request(
                "initialize",
                json!({"clientInfo": {"name": "isle", "version": version}}),
            )
            .await
            .map_err(|err| codex.explained(err))?;
        drop(starting);
        codex.notify("initialized").await?;
        Ok(codex)
    }

    /// The account (`account/read`) and each page of the models its plan allows (`model/list`), from a
    /// server of its own that is dropped after: nothing is asked of the AI.
    pub async fn models(program: &Path) -> anyhow::Result<(Value, Vec<Value>)> {
        let workspace = crate::store::data_dir().join("assistant");
        let mut codex = Self::start(program, "", None, &workspace, "").await?;
        let account = codex.request("account/read", json!({})).await;
        let account = account.map_err(|err| codex.explained(err))?;
        let mut pages = Vec::new();
        let mut cursor = Value::Null;
        for _ in 0..MODEL_PAGES {
            let page = codex
                .request(
                    "model/list",
                    json!({"cursor": cursor, "includeHidden": false}),
                )
                .await
                .map_err(|err| codex.explained(err))?;
            cursor = page["nextCursor"].clone();
            pages.push(page);
            if cursor.is_null() {
                break;
            }
        }
        Ok((account, pages))
    }

    /// Opens the conversation now, so the first turn need not wait for it.
    pub async fn warm(&mut self) -> anyhow::Result<()> {
        self.open().await.map_err(|err| self.explained(err))
    }

    /// One turn: `activity` hears its web searches, `draft` the spoken words as they stream in.
    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        self.stderr.lock().unwrap().clear();
        let answer = self.turn(prompt, activity, draft).await;
        // A token it renewed meanwhile goes back to the user's own Codex.
        link_sign_in(&user_home(), &home());
        answer.map_err(|err| self.explained(err))
    }

    /// `err`, with what Codex last said on stderr.
    fn explained(&self, err: anyhow::Error) -> anyhow::Error {
        let stderr = Vec::from(self.stderr.lock().unwrap().clone()).join(" | ");
        if stderr.is_empty() {
            err
        } else {
            err.context(stderr)
        }
    }

    /// The conversation loaded in this process: resumed (once its process had to go), else started.
    async fn open(&mut self) -> anyhow::Result<()> {
        if self.ready {
            return Ok(());
        }
        let cwd = self.workspace.to_string_lossy().into_owned();
        let model = (!self.model.is_empty()).then(|| self.model.clone());
        let resumed = match self.conversation.clone() {
            Some(id) => self
                .request(
                    "thread/resume",
                    json!({"threadId": id, "model": model, "cwd": cwd,
                    "approvalPolicy": "never", "sandbox": "read-only"}),
                )
                .await
                .ok(),
            None => None,
        };
        let thread = match resumed {
            Some(thread) => thread,
            // Gone (deleted at midnight, say): a new one.
            None => {
                self.request(
                    "thread/start",
                    json!({"model": model, "cwd": cwd, "approvalPolicy": "never",
                        "sandbox": "read-only", "baseInstructions": self.instructions}),
                )
                .await?
            }
        };
        self.conversation = thread["thread"]["id"].as_str().map(str::to_owned);
        anyhow::ensure!(self.conversation.is_some(), "codex opened no conversation");
        self.ready = true;
        Ok(())
    }

    /// Runs a turn and reads its events until Codex is done; anything it asks of Isle is refused.
    async fn turn(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        self.open().await?;
        let thread = self.conversation.clone().unwrap_or_default();
        let params = json!({"threadId": thread, "input": [{"type": "text", "text": prompt}],
            "outputSchema": self.schema, "effort": super::brain::EFFORT});
        let started = self.send("turn/start", params).await?;
        let mut turn = None;
        let mut answer = None;
        let mut written = String::new();
        let mut shown = String::new();
        while let Some(message) = self.events.next(&[""]).await? {
            // Refused (the thread busy or gone, say), it says why now rather than never start.
            if let Some(reply) = reply_to(&message, started) {
                turn = reply?["turn"]["id"].as_str().map(str::to_owned);
                continue;
            }
            match message["method"].as_str() {
                Some("item/agentMessage/delta") => {
                    written.push_str(message["params"]["delta"].as_str().unwrap_or_default());
                    if stuck(&written) {
                        self.interrupt(&thread, turn.as_deref()).await;
                        return salvage(&written)
                            .context("codex got stuck writing its answer")
                            .and_then(|text| parse_answer(&text));
                    }
                    if let (Some(draft), Some(say)) = (draft, super::answer::partial_say(&written))
                        && say != shown
                    {
                        draft.send(say.clone()).ok();
                        shown = say;
                    }
                }
                Some("item/started") => {
                    if let (Some(activity), Some(step)) =
                        (activity, step(&message["params"]["item"]))
                    {
                        activity.send(step).ok();
                    }
                }
                Some("item/completed") => {
                    let item = &message["params"]["item"];
                    if item["type"] == "agentMessage" {
                        answer = item["text"].as_str().map(str::to_owned);
                    }
                }
                Some("turn/completed") => {
                    let turn = &message["params"]["turn"];
                    if let Some(reason) = turn["error"]["message"].as_str() {
                        bail!("{reason}");
                    }
                    return match answer {
                        Some(text) => parse_answer(&text),
                        None => bail!("codex answered nothing"),
                    };
                }
                Some("error") if message["params"]["willRetry"] != true => {
                    let reason = message["params"]["error"]["message"]
                        .as_str()
                        .unwrap_or("codex failed");
                    bail!("{reason}");
                }
                // It asks something of Isle (an approval, say): never granted; this Codex only answers.
                Some(_) if message.get("id").is_some() => {
                    self.reply_error(&message["id"]).await?;
                }
                _ => {}
            }
        }
        bail!("codex stopped")
    }

    /// Sends a request and waits for its result, answering whatever Codex asks meanwhile.
    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = self.send(method, params).await?;
        while let Some(message) = self.events.next(&[""]).await? {
            if let Some(reply) = reply_to(&message, id) {
                return reply;
            }
            if message.get("id").is_some() && message.get("method").is_some() {
                self.reply_error(&message["id"]).await?;
            }
        }
        bail!("codex stopped")
    }

    /// Sends a JSON-RPC request without waiting; returns its id.
    async fn send(&mut self, method: &str, params: Value) -> anyhow::Result<u64> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await?;
        Ok(id)
    }

    /// A JSON-RPC notification, which gets no answer.
    async fn notify(&mut self, method: &str) -> anyhow::Result<()> {
        self.write(json!({"jsonrpc": "2.0", "method": method}))
            .await
    }

    /// Refuses a request from Codex, such as an approval.
    /// Stops `turn` and waits (a while at most) for it to end, so the next one finds the thread free.
    async fn interrupt(&mut self, thread: &str, turn: Option<&str>) {
        let Some(turn) = turn else {
            return;
        };
        let stop = json!({"threadId": thread, "turnId": turn});
        let ended = async {
            self.send("turn/interrupt", stop).await?;
            while let Some(message) = self.events.next(&[""]).await? {
                if message["method"] == "turn/completed" {
                    break;
                }
                if message.get("id").is_some() && message.get("method").is_some() {
                    self.reply_error(&message["id"]).await?;
                }
            }
            anyhow::Ok(())
        };
        if !matches!(
            tokio::time::timeout(INTERRUPT_WAIT, ended).await,
            Ok(Ok(()))
        ) {
            log::warn!("codex did not end a stopped turn");
        }
    }

    async fn reply_error(&mut self, id: &Value) -> anyhow::Result<()> {
        self.write(json!({"jsonrpc": "2.0", "id": id,
            "error": {"code": -32601, "message": "Isle's Codex only answers"}}))
            .await
    }

    /// One message per line, as the app server reads them.
    async fn write(&mut self, message: Value) -> anyhow::Result<()> {
        self.stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .context("codex stopped")
    }
}

/// Codex's reply to request `id`, if `message` is it: its result, or why it refused.
fn reply_to(message: &Value, id: u64) -> Option<anyhow::Result<Value>> {
    if message["id"] != id || message.get("method").is_some() {
        return None;
    }
    Some(match message.get("error") {
        Some(error) => Err(anyhow::anyhow!(
            "{}",
            error["message"].as_str().unwrap_or("codex refused")
        )),
        None => Ok(message["result"].clone()),
    })
}

/// What Codex starts doing, for the island: its web searches.
fn step(item: &Value) -> Option<String> {
    if item["type"] != "webSearch" {
        return None;
    }
    Some(match item["query"].as_str().filter(|q| !q.is_empty()) {
        Some(query) => format!("Searching the web for “{query}”…"),
        None => "Searching the web…".into(),
    })
}

/// Its answer; without the JSON asked for, the text as said, as the other AIs' (see `answer::from_text`).
fn parse_answer(text: &str) -> anyhow::Result<Answer> {
    let Ok(mut value) = serde_json::from_str::<Value>(text.trim()) else {
        anyhow::ensure!(!text.trim().is_empty(), "codex answered nothing");
        return Ok(super::answer::from_text(text));
    };
    // Its schema has every field, unused ones null: only what was given is kept.
    if let Some(answer) = value.as_object_mut() {
        answer.retain(|_, field| !field.is_null());
    }
    if let Some(actions) = value["actions"].as_array_mut() {
        for action in actions.iter_mut().filter_map(Value::as_object_mut) {
            action.retain(|_, field| !field.is_null());
        }
    }
    let mut answer: Answer = serde::Deserialize::deserialize(&value)?;
    answer
        .actions
        .iter_mut()
        .for_each(super::answer::window_focus);
    Ok(answer)
}

/// Whether the answer only grows by blank space: held to the schema, a model can find no way on (an
/// action's other fields still owed) and writes spaces, which JSON allows, until it is stopped.
fn stuck(written: &str) -> bool {
    written.len() - written.trim_end().len() >= STUCK_BLANKS
}

/// `text`, cut off mid-way, with its open string, arrays and objects closed:
/// `{"say":"Ok","actions":[{"type":"lock"` gives `{"say":"Ok","actions":[{"type":"lock"}]}`.
fn closed(text: &str) -> String {
    let mut open = Vec::new();
    let (mut in_string, mut escaped) = (false, false);
    for c in text.chars() {
        match c {
            _ if escaped => escaped = false,
            '\\' if in_string => escaped = true,
            '"' => in_string = !in_string,
            '{' if !in_string => open.push('}'),
            '[' if !in_string => open.push(']'),
            '}' | ']' if !in_string => {
                open.pop();
            }
            _ => {}
        }
    }
    let mut out = text.to_owned();
    if in_string {
        out.push('"');
    }
    out.extend(open.iter().rev());
    out
}

/// The JSON a stuck answer was writing, closed after its last whole field; None if none parses.
fn salvage(written: &str) -> Option<String> {
    let mut text = written.trim_end();
    // A field cut off (a key without its value) is dropped back to the comma before it.
    for _ in 0..8 {
        let whole = closed(text);
        if serde_json::from_str::<Value>(&whole).is_ok() {
            return Some(whole);
        }
        text = text[..text.rfind(',')?].trim_end();
    }
    None
}

/// `schema` as Codex's structured output needs it: every field required (optional ones may be null),
/// and no others allowed.
fn strict(schema: &str) -> anyhow::Result<String> {
    /// Tightens one object, then its properties and items in turn.
    fn tighten(node: &mut Value) {
        let Some(object) = node.as_object_mut() else {
            return;
        };
        let required: Vec<String> = object
            .get("required")
            .and_then(Value::as_array)
            .map(|r| {
                r.iter()
                    .filter_map(|k| k.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let keys = match object.get_mut("properties") {
            Some(Value::Object(properties)) => {
                for (key, property) in properties.iter_mut() {
                    tighten(property);
                    if !required.contains(key) {
                        if let Some(kind) = property.get("type").cloned() {
                            property["type"] = Value::Array(vec![kind, Value::from("null")]);
                        }
                        // A field that may be null may not also be held to a list of values.
                        if let Some(property) = property.as_object_mut() {
                            property.remove("enum");
                        }
                    }
                }
                Some(
                    properties
                        .keys()
                        .map(|k| Value::from(k.as_str()))
                        .collect::<Vec<_>>(),
                )
            }
            _ => None,
        };
        if let Some(all) = keys {
            object.insert("required".into(), Value::Array(all));
            object.insert("additionalProperties".into(), Value::Bool(false));
        }
        if let Some(items) = object.get_mut("items") {
            tighten(items);
        }
    }
    let mut value: Value = serde_json::from_str(schema)?;
    tighten(&mut value);
    Ok(value.to_string())
}

/// The user's own Codex home: `$CODEX_HOME`, else `~/.codex`.
pub fn user_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .filter(|dir| !dir.is_empty())
        .map_or_else(
            || dirs::home_dir().unwrap_or_default().join(".codex"),
            PathBuf::from,
        )
}

/// Where the user's own Codex keeps its sign-in.
pub fn user_auth() -> PathBuf {
    user_home().join("auth.json")
}

/// The top-level `model` in the user's config.toml, which Isle uses too unless told otherwise. None with a
/// provider of their own (Azure, Ollama…): OpenAI's service, which Isle's Codex uses, would not know it.
pub(super) fn user_model() -> Option<String> {
    let config = std::fs::read_to_string(user_home().join("config.toml")).ok()?;
    if config
        .lines()
        .take_while(|line| !line.trim_start().starts_with('['))
        .any(|line| line.trim_start().starts_with("model_provider"))
    {
        return None;
    }
    top_level_model(&config)
}

/// `model = "…"` before the first table; a profile's model doesn't count.
fn top_level_model(config: &str) -> Option<String> {
    config
        .lines()
        .take_while(|line| !line.trim_start().starts_with('['))
        .find_map(|line| {
            let value = line
                .trim()
                .strip_prefix("model")?
                .trim_start()
                .strip_prefix('=')?;
            Some(value.trim().trim_matches('"').to_owned())
        })
}

/// Links Isle's Codex home to the user's sign-in (`auth.json`; see sign_in.rs).
fn link_sign_in(user: &Path, isle: &Path) {
    super::sign_in::share(&user.join("auth.json"), &isle.join("auth.json"));
}

/// Deletes Isle's Codex conversation `id` now: through Codex itself, which keeps it in its databases too,
/// then any file of it left.
pub fn forget(id: &str) {
    // The Codex that had it may still be letting go of it (its lock), a moment after it was stopped.
    for attempt in 0..4 {
        match delete_thread(id) {
            Ok(()) => break,
            Err(err) if attempt == 3 => {
                log::warn!("codex could not delete conversation {id}: {err:#}")
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(500)),
        }
    }
    forget_files(id);
}

/// Asks a short-lived Codex app server to delete thread `id` (blocking; at most a few seconds).
fn delete_thread(id: &str) -> anyhow::Result<()> {
    use std::io::{BufRead, Write};
    let program = super::brain::Provider::Codex
        .program()
        .context("codex is not installed")?;
    let mut command = std::process::Command::new(&program);
    if let Some(path) = super::child::path_for(&program) {
        command.env("PATH", path);
    }
    // Counted like any Codex of Isle's, so `prune` never deletes its databases as it opens them.
    let _alive = Alive::new();
    let mut child = command
        .arg("app-server")
        .env("CODEX_HOME", home())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let (done, answered) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if let Ok(message) = serde_json::from_str::<Value>(&line)
                && message["id"] == 2
            {
                let error = message["error"]["message"].as_str().map(str::to_owned);
                done.send(error).ok();
                return;
            }
        }
    });
    for message in [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "isle", "version": env!("CARGO_PKG_VERSION")}}}),
        json!({"jsonrpc": "2.0", "method": "initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "thread/delete", "params": {"threadId": id}}),
    ] {
        writeln!(stdin, "{message}")?;
    }
    let result = answered.recv_timeout(std::time::Duration::from_secs(8));
    child.kill().ok();
    child.wait().ok();
    match result {
        Ok(None) => Ok(()),
        Ok(Some(error)) => bail!("{error}"),
        Err(_) => bail!("no answer"),
    }
}

/// Deletes the files of conversation `id` left in Isle's Codex home.
fn forget_files(id: &str) {
    /// Removes every file under `dir` whose path names `id`.
    fn walk(dir: &Path, id: &str) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for path in entries.flatten().map(|e| e.path()) {
            if path.is_dir() {
                walk(&path, id);
            } else if path.to_string_lossy().contains(id) {
                std::fs::remove_file(&path).ok();
            }
        }
    }
    walk(&home().join("sessions"), id);
}

/// Whether a Codex that Isle started runs now (its home in its environment).
fn running() -> bool {
    let wanted = format!("CODEX_HOME={}", home().display());
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            std::fs::read(entry.path().join("environ")).is_ok_and(|environ| {
                environ
                    .split(|&b| b == 0)
                    .any(|var| var == wanted.as_bytes())
            })
        })
}

/// Deletes Isle's Codex conversations last changed before `today`; with no Isle Codex running, its
/// databases go too (they hold only Isle's conversations, and Codex makes them again).
pub fn prune(today: NaiveDate) {
    // Held while deleting: a Codex this isled starts meanwhile waits (see `Alive`).
    let live = LIVE.lock().unwrap_or_else(PoisonError::into_inner);
    if *live == 0 && !running() {
        for entry in std::fs::read_dir(home()).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.contains(".sqlite") {
                std::fs::remove_file(entry.path()).ok();
            }
        }
        for dir in ["thread-writer-locks", "tmp"] {
            std::fs::remove_dir_all(home().join(dir)).ok();
        }
    }
    drop(live);
    /// Removes files last changed before `today`, then the folders left empty.
    fn walk(dir: &Path, today: NaiveDate) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Never through a link, which could lead out of Isle's own folder.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                walk(&path, today);
                // Folders emptied by it go too.
                std::fs::remove_dir(&path).ok();
            } else if entry
                .metadata()
                .and_then(|meta| meta.modified())
                .is_ok_and(|time| DateTime::<Local>::from(time).date_naive() < today)
            {
                std::fs::remove_file(&path).ok();
            }
        }
    }
    walk(&home().join("sessions"), today);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_the_schema_strict() {
        let strict: Value = serde_json::from_str(&strict(SCHEMA).unwrap()).unwrap();
        assert_eq!(strict["additionalProperties"], false);
        assert_eq!(
            strict["properties"]["listen"]["type"],
            serde_json::json!(["boolean", "null"])
        );
        let item = &strict["properties"]["actions"]["items"];
        assert_eq!(item["additionalProperties"], false);
        let fields = item["properties"].as_object().unwrap().len();
        assert!(fields > 15 && item["required"].as_array().unwrap().len() == fields);
        // The action type stays required and limited to the known ones.
        assert_eq!(item["properties"]["type"]["type"], "string");
        assert!(item["properties"]["type"]["enum"].is_array());
        assert_eq!(
            item["properties"]["terms"]["type"],
            serde_json::json!(["array", "null"])
        );
    }

    #[test]
    fn a_refused_request_says_why() {
        let busy = json!({"jsonrpc": "2.0", "id": 3,
            "error": {"code": -32600, "message": "thread t1 is busy"}});
        let err = reply_to(&busy, 3).unwrap().unwrap_err();
        assert_eq!(format!("{err:#}"), "thread t1 is busy");
        let started = json!({"id": 3, "result": {"turn": {"id": "u1"}}});
        assert_eq!(reply_to(&started, 3).unwrap().unwrap()["turn"]["id"], "u1");
        // Another request's reply, an event, or Codex asking something of its own under the same number.
        assert!(reply_to(&busy, 2).is_none());
        assert!(reply_to(&json!({"method": "turn/started", "params": {}}), 3).is_none());
        let asks = json!({"id": 3, "method": "item/commandExecution/requestApproval"});
        assert!(reply_to(&asks, 3).is_none());
    }

    #[test]
    fn takes_only_the_top_level_model() {
        assert_eq!(
            top_level_model("model = \"gpt-5.5\"\n[profiles.fast]\nmodel = \"mini\"\n").as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(top_level_model("[profiles.fast]\nmodel = \"mini\"\n"), None);
    }

    #[test]
    fn reads_codexs_answer() {
        let text = r#"{"say":"Membuka YouTube.","listen":false,"actions":[{"type":"open_url","url":"https://www.youtube.com","app":null,"minutes":null}]}"#;
        let answer = parse_answer(text).unwrap();
        assert_eq!(answer.say, "Membuka YouTube.");
        assert_eq!(
            answer.actions[0],
            serde_json::json!({"type": "open_url", "url": "https://www.youtube.com"})
        );
        assert_eq!(
            step(&serde_json::json!({"type": "webSearch", "query": "cuaca"})).unwrap(),
            "Searching the web for “cuaca”…"
        );
    }

    #[test]
    fn keeps_what_a_stuck_answer_wrote() {
        // Its first action cut off after its type, then only blank space (as seen with "kunci layar").
        let written = format!(
            "{}{}",
            r#"{"say":"Aku kunci layarnya.","listen":false,"done":true,"actions":[{"type":"lock""#,
            " \n\t".repeat(80)
        );
        assert!(stuck(&written));
        assert!(!stuck(r#"{"say":"ok",   "actions":[]}"#));
        let answer = parse_answer(&salvage(&written).unwrap()).unwrap();
        assert_eq!(answer.say, "Aku kunci layarnya.");
        assert_eq!(answer.actions, vec![serde_json::json!({"type": "lock"})]);
        // A key without its value goes; a string cut off is closed; quotes and brackets inside it count not.
        let answer = parse_answer(
            &salvage(r#"{"say":"Done [\"a\" {b}","actions":[{"type":"lock","url""#).unwrap(),
        )
        .unwrap();
        assert_eq!(answer.say, r#"Done ["a" {b}"#);
        assert_eq!(answer.actions, vec![serde_json::json!({"type": "lock"})]);
        assert_eq!(closed(r#"{"say":"Half a sen"#), r#"{"say":"Half a sen"}"#);
        assert!(salvage("   ").is_none());
    }
}
