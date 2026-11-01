// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The Antigravity CLI (`agy`) in stream-json print mode: one process per voice session,
//! started while the user speaks so its start-up is hidden, and one turn per request.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};

use anyhow::{Context, bail};
use chrono::{DateTime, Local, NaiveDate};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc::UnboundedSender;

use super::answer::{Answer, SCHEMA};
use super::child::{self, Events, Group};

/// agy may only search and read the web: its own settings may let it run anything unasked. The tool's name is
/// the one just before `transcriptPath`, so a "name" in its arguments cannot pass; other layouts are refused.
const HOOKS: &str = r#"{"isle-guard": {"PreToolUse": [{"matcher": "*", "hooks": [{"timeout": 5, "command":
"grep -qE '\"name\": *\"(search_web|read_url_content|finish|wait)\" *[}] *, *\"transcriptPath\"' && echo '{\"decision\":\"allow\"}' || echo '{\"decision\":\"deny\",\"reason\":\"Isle allows only web search and reading pages; answer with actions instead.\"}'"}]}]}}"#;

/// agy's own home: Isle's conversations stay apart from the user's own agy and are cleared each day.
pub fn home() -> PathBuf {
    crate::store::data_dir().join("agy")
}

/// Where agy keeps its conversations, under `home()`.
fn store() -> PathBuf {
    home().join(".gemini/antigravity-cli")
}

/// What agy keeps per conversation, each named by its id: `<id>.db`, `brain/<id>/` and the like.
const PER_CONVERSATION: &[&str] = &[
    "conversations",
    "brain",
    "annotations",
    "presence",
    "implicit",
];

/// Where agy keeps its sign-in, under its home: before agy 1.4, and since (beside the system keyring).
pub const LOGIN: &str = ".gemini/antigravity-cli/antigravity-oauth-token";
const STANDALONE_LOGIN: &str = ".gemini/jetski-standalone-oauth-token";


/// Written in the user's home once agy's sign-in and onboarding finish, including when its token is kept
/// in the keyring.
pub const ONBOARDING: &str = ".gemini/antigravity-cli/cache/onboarding.json";

/// The default Cloud Code project id cached by agy.
const DEFAULT_PROJECT: &str = ".gemini/antigravity-cli/cache/default_project_id.txt";

/// `--print /usage` takes at most 15 seconds.
const USAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// `agy --version` takes at most this long; it is asked once per installed binary.
const VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Links Isle's agy home to the user's agy sign-in, so signing in once (in `user`'s home) is enough
/// (see sign_in.rs). Onboarding and the project id are shared too: agy refuses to start without them.
fn link_login(user: &Path, isle: &Path) {
    for login in [LOGIN, STANDALONE_LOGIN] {
        super::sign_in::share(&user.join(login), &isle.join(login));
    }
    super::sign_in::share(&user.join(ONBOARDING), &isle.join(ONBOARDING));
    super::sign_in::share(&user.join(DEFAULT_PROJECT), &isle.join(DEFAULT_PROJECT));
}

/// Whether the user signed in to agy: its token file, or `onboarding.json` once signed in with the keyring.
pub fn signed_in() -> bool {
    dirs::home_dir().is_some_and(|home| signed_in_at(&home))
}

/// Whether agy has a token or completed keyring onboarding in `home`.
pub fn signed_in_at(home: &Path) -> bool {
    if [LOGIN, STANDALONE_LOGIN].iter().any(|login| home.join(login).exists()) {
        return true;
    }
    std::fs::read_to_string(home.join(ONBOARDING))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|json| json["onboardingComplete"] == true)
}

/// Whether `agy --version` ("1.4.12") is 1.1.11 or newer, where `--print /usage` reads the quota
/// instead of starting a turn.
pub fn supports_usage(version: &str) -> bool {
    let mut parts = version.trim().split('.');
    let (Some(major), Some(minor), Some(patch)) = (
        parts.next().and_then(|s| s.parse::<u32>().ok()),
        parts.next().and_then(|s| s.parse::<u32>().ok()),
        parts.next().and_then(|s| s.parse::<u32>().ok()),
    ) else {
        return false;
    };
    parts.next().is_none() && (major, minor, patch) >= (1, 1, 11)
}

/// Why reading agy's usage failed, which picks the note and the next try (see usage.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageError {
    /// Older than 1.1.11, where `/usage` started a model turn instead of reading the quota.
    NeedsUpdate,
    SignIn,
    Offline,
    Busy,
}

/// Whether an agy binary supports `/usage`, and the program and modification time it was asked about.
type VersionCheck = (PathBuf, Option<std::time::SystemTime>, bool);

/// The last answer to "is this agy new enough for `/usage`": `agy` is asked again only when it changes.
static VERSION_OK: std::sync::LazyLock<Mutex<Option<VersionCheck>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// The usage `agy --print /usage` reports for this sign-in: its JSON, read in Isle's home for agy.
pub async fn usage(program: &Path) -> Result<Value, UsageError> {
    if !version_supports_usage(program).await {
        return Err(UsageError::NeedsUpdate);
    }
    let user = dirs::home_dir();
    let home = home();
    if let Some(user) = &user {
        link_login(user, &home);
    }
    std::fs::create_dir_all(&home).map_err(|_| UsageError::Busy)?;
    let mut command = Command::new(program);
    command
        .args([
            "--print",
            "/usage",
            "--output-format",
            "json",
            "--log-file",
            "/dev/null",
        ])
        .current_dir(&home)
        .env("HOME", &home)
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "1")
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME")
        .env_remove("XDG_STATE_HOME")
        .env_remove("XDG_CACHE_HOME")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = child::spawn(&mut command).map_err(|_| UsageError::Busy)?;
    // Dropped by the timeout, the group takes agy and anything it started with it.
    let read = tokio::time::timeout(USAGE_TIMEOUT, read_usage(child)).await;
    // It may have renewed its sign-in meanwhile: the user's own agy gets it (see sign_in.rs).
    if let Some(user) = &user {
        link_login(user, &home);
    }
    match read {
        Err(_) => Err(UsageError::Offline),
        Ok(Err(_)) => Err(UsageError::Busy),
        Ok(Ok((stdout, stderr, status))) => parse_usage(&stdout, &stderr, status.success()),
    }
}

/// Whether this agy reads `/usage` instead of starting a turn, from `agy --version` once per binary.
async fn version_supports_usage(program: &Path) -> bool {
    let modified = std::fs::metadata(program)
        .and_then(|meta| meta.modified())
        .ok();
    {
        let asked = VERSION_OK.lock().unwrap();
        if let Some((path, when, ok)) = asked.as_ref()
            && path.as_path() == program
            && *when == modified
        {
            return *ok;
        }
    }
    // A version that could not be read says nothing about the binary: it is asked again next time.
    let Some(version) = version_of(program).await else {
        return false;
    };
    let ok = supports_usage(&version);
    *VERSION_OK.lock().unwrap() = Some((program.to_path_buf(), modified, ok));
    ok
}

/// What `agy --version` says ("1.4.12"), if it can be read in time.
async fn version_of(program: &Path) -> Option<String> {
    let mut command = Command::new(program);
    command
        .arg("--version")
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = child::spawn(&mut command).ok()?;
    let mut version = String::new();
    let mut out = child.stdout.take()?;
    tokio::time::timeout(VERSION_TIMEOUT, out.read_to_string(&mut version))
        .await
        .ok()?
        .ok()?;
    let status = child.wait().await.ok()?;
    status.success().then_some(version)
}

/// All of agy's output and how it ended. Reads both pipes at once: it would block on a full one otherwise.
async fn read_usage(mut child: Group) -> std::io::Result<(String, String, ExitStatus)> {
    let mut out = child.stdout.take().expect("piped stdout");
    let mut err = child.stderr.take().expect("piped stderr");
    let (stdout, stderr) = tokio::join!(drain(&mut out), drain(&mut err));
    let (stdout, stderr) = (stdout?, stderr?);
    let status = child.wait().await?;
    Ok((stdout, stderr, status))
}

/// Everything a pipe of agy's output says.
async fn drain<P: AsyncRead + Unpin>(pipe: &mut P) -> std::io::Result<String> {
    let mut text = String::new();
    pipe.read_to_string(&mut text).await?;
    Ok(text)
}

/// What agy says when its sign-in is gone or was refused.
const SIGN_IN_WORDS: &[&str] = &[
    "not logged in",
    "authentication",
    "sign in",
    "login",
    "unauthenticated",
];

/// What agy says when the quota service could not be reached.
const OFFLINE_WORDS: &[&str] = &[
    "network",
    "dial tcp",
    "connection refused",
    "no such host",
    "context deadline exceeded",
    "timed out",
];

/// agy's usage JSON, or why there is none: its sign-in, the network, or anything else it said.
fn parse_usage(stdout: &str, stderr: &str, success: bool) -> Result<Value, UsageError> {
    let json = serde_json::from_str::<Value>(stdout).ok();
    let error = json.as_ref().and_then(|json| json["error"].as_str());
    let said = [stdout, stderr, error.unwrap_or_default()]
        .join("\n")
        .to_lowercase();
    if SIGN_IN_WORDS.iter().any(|words| said.contains(*words)) {
        return Err(UsageError::SignIn);
    }
    if OFFLINE_WORDS.iter().any(|words| said.contains(*words)) {
        return Err(UsageError::Offline);
    }
    match json {
        Some(json) if success && json["status"] == "SUCCESS" => Ok(json),
        _ => Err(UsageError::Busy),
    }
}

/// What `agy models` lists for this account (`id<TAB>name` lines): run in Isle's home for agy, as every
/// agy here, and asking nothing of the AI.
pub async fn models(program: &Path) -> anyhow::Result<String> {
    let user = dirs::home_dir();
    if let Some(user) = &user {
        link_login(user, &home());
    }
    std::fs::create_dir_all(home())?;
    let mut command = Command::new(program);
    command
        .arg("models")
        .current_dir(home())
        .env("HOME", home())
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME")
        .env_remove("XDG_STATE_HOME")
        .env_remove("XDG_CACHE_HOME")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = child::spawn(&mut command).context("could not start agy")?;
    let (mut stdout, mut stderr) = (String::new(), String::new());
    let mut out = child.stdout.take().expect("piped stdout");
    let mut err = child.stderr.take().expect("piped stderr");
    let (read, _) = tokio::join!(
        out.read_to_string(&mut stdout),
        err.read_to_string(&mut stderr)
    );
    read?;
    let status = child.wait().await?;
    // It may have renewed its sign-in meanwhile: the user's own agy gets it (see sign_in.rs).
    if let Some(user) = &user {
        link_login(user, &home());
    }
    anyhow::ensure!(status.success(), "agy models failed: {}", stderr.trim());
    Ok(stdout)
}

/// Deletes the conversations last used before `today`, all of a conversation's files together.
pub fn prune(today: NaiveDate) {
    prune_in(&store(), today);
}

/// `prune` on a given store folder, so tests can use a temporary one.
fn prune_in(store: &Path, today: NaiveDate) {
    let mut last_used: HashMap<String, (NaiveDate, Vec<PathBuf>)> = HashMap::new();
    for dir in PER_CONVERSATION {
        let Ok(entries) = std::fs::read_dir(store.join(dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = name.split('.').next().unwrap_or_default().to_owned();
            let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else {
                continue;
            };
            let day = DateTime::<Local>::from(modified).date_naive();
            let (latest, paths) = last_used.entry(id).or_insert((day, Vec::new()));
            *latest = (*latest).max(day);
            paths.push(entry.path());
        }
    }
    for (latest, paths) in last_used.into_values() {
        if latest < today {
            paths.iter().for_each(remove);
        }
    }
    // agy writes a log per run: those from before today go too.
    if let Ok(entries) = std::fs::read_dir(store.join("log")) {
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .is_ok_and(|modified| DateTime::<Local>::from(modified).date_naive() < today);
            if old && entry.file_type().is_ok_and(|kind| kind.is_file()) {
                std::fs::remove_file(entry.path()).ok();
            }
        }
    }
}

/// Deletes the conversation `id` now.
pub fn forget(id: &str) {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return;
    }
    for dir in PER_CONVERSATION {
        if let Ok(entries) = std::fs::read_dir(store().join(dir)) {
            entries
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with(id))
                .for_each(|entry| remove(&entry.path()));
        }
    }
}

/// Deletes a conversation's file or folder, logging anything but "already gone".
fn remove(path: &PathBuf) {
    let removed = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    // Already gone (agy cleaned up itself) is what was wanted.
    if let Err(err) = removed
        && err.kind() != std::io::ErrorKind::NotFound
    {
        log::warn!("could not delete {}: {err}", path.display());
    }
}

/// Lines of agy's stderr kept to explain a failure (it prints sign-in problems there).
const STDERR_LINES: usize = 20;

impl Drop for Agy {
    // Quitting, agy may have renewed its sign-in: the user's own agy gets it (see sign_in.rs).
    fn drop(&mut self) {
        if let Some(user) = dirs::home_dir() {
            link_login(&user, &home());
        }
    }
}

/// A running agy for one voice session, read a turn at a time.
pub struct Agy {
    _child: Group,
    stdin: ChildStdin,
    events: Events<ChildStdout>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    /// Set from agy's first event; a later session can resume it.
    pub conversation: Option<String>,
}

impl Agy {
    /// Starts agy in its own home with Isle's hook in `workspace`, resuming `resume` if given.
    pub(super) fn start_program(
        program: &Path,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
    ) -> anyhow::Result<Self> {
        if let Some(user) = dirs::home_dir() {
            link_login(&user, &home());
        }
        let agents = workspace.join(".agents");
        std::fs::create_dir_all(&agents)?;
        std::fs::write(agents.join("hooks.json"), HOOKS).context("could not write agy's hooks")?;
        let mut command = Command::new(program);
        command
            .args(["--print=", "--input-format", "stream-json"])
            .args(["--output-format", "stream-json", "--disable-slash-commands"])
            .args(["--json-schema", SCHEMA]);
        if !model.is_empty() {
            command.args(["--model", model]);
        }
        if let Some(id) = resume {
            command.args(["--conversation", id]);
        }
        command
            .current_dir(workspace)
            .env("HOME", home())
            // Its own home only: folders the session moved elsewhere would lead it out of it.
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("XDG_DATA_HOME")
            .env_remove("XDG_STATE_HOME")
            .env_remove("XDG_CACHE_HOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = child::spawn(&mut command)
            .context("could not start agy; is the Antigravity CLI installed?")?;
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
        Ok(Self {
            _child: child,
            stdin,
            events,
            stderr,
            conversation: resume.map(str::to_owned),
        })
    }

    /// One turn; `activity` hears what agy does meanwhile ("Searching the web for …").
    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        // Only this turn's lines explain this turn's failure.
        self.stderr.lock().unwrap().clear();
        self.turn(prompt, activity).await.map_err(|err| {
            let stderr = Vec::from(self.stderr.lock().unwrap().clone()).join(" | ");
            if stderr.is_empty() {
                err
            } else {
                err.context(stderr)
            }
        })
    }

    /// Sends the prompt and reads events until the result, passing tool steps to `activity`.
    async fn turn(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        let message = serde_json::json!({"event": "user", "message": {"content": prompt}});
        // agy that stopped at once (signed out, say) still left its reason on stdout: read it then.
        let sent = self
            .stdin
            .write_all(format!("{message}\n").as_bytes())
            .await;
        let words: &[&str] = match activity {
            Some(_) => &["\"init\"", "\"result\"", "\"step_update\""],
            None => &["\"init\"", "\"result\""],
        };
        while let Some(event) = self.events.next(words).await? {
            match event["event"].as_str() {
                Some("init") => {
                    self.conversation = event["conversation_id"].as_str().map(str::to_owned);
                }
                Some("result") => return parse_result(&event["result"]),
                Some("step_update") => {
                    if let (Some(activity), Some(step)) = (activity, step(&event["step_update"])) {
                        activity.send(step).ok();
                    }
                }
                _ => {}
            }
        }
        sent.context("agy stopped")?;
        bail!("agy stopped")
    }
}

/// What a tool agy starts is doing, for the island; `None` for anything else.
fn step(update: &Value) -> Option<String> {
    if update["step_type"] != "tool" || update["state"] != "ACTIVE" {
        return None;
    }
    let args = &update["tool_info"]["parameters"];
    match update["tool_name"].as_str()? {
        "search_web" => Some(match args["query"].as_str() {
            Some(query) => format!("Searching the web for “{query}”…"),
            None => "Searching the web…".into(),
        }),
        "read_url_content" => {
            let url = args["Url"]
                .as_str()
                .or(args["url"].as_str())
                .unwrap_or_default();
            let host = url
                .split("://")
                .nth(1)
                .and_then(|rest| rest.split('/').next());
            Some(format!("Reading {}…", host.unwrap_or("a page")))
        }
        _ => None,
    }
}

/// The answer from agy's result event, or its error.
fn parse_result(result: &Value) -> anyhow::Result<Answer> {
    if result["status"] != "SUCCESS" {
        let error = result["error"].as_str().unwrap_or("agy failed");
        bail!("{error}");
    }
    if let Ok(answer) = Answer::deserialize(&result["structured_output"]) {
        return Ok(answer);
    }
    // No structured output: the reply as said, without actions.
    Ok(super::answer::from_text(
        result["response"].as_str().unwrap_or_default(),
    ))
}

#[cfg(test)]
mod tests {

    #[test]
    fn either_versions_sign_in_counts() {
        let home = std::env::temp_dir().join(format!("isle-agy-login-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".gemini/antigravity-cli")).unwrap();
        assert!(!signed_in_at(&home));
        // agy 1.4 and later.
        std::fs::write(home.join(STANDALONE_LOGIN), "token").unwrap();
        assert!(signed_in_at(&home));
        std::fs::remove_file(home.join(STANDALONE_LOGIN)).unwrap();
        // Before.
        std::fs::write(home.join(LOGIN), "token").unwrap();
        assert!(signed_in_at(&home));
        std::fs::remove_dir_all(&home).unwrap();
    }
    use super::*;

    #[test]
    fn checks_which_agy_versions_support_usage() {
        // Before 1.1.11, `--print /usage` started a model turn.
        assert!(!supports_usage("1.1.10"));
        assert!(!supports_usage("1.1.11-rc.1"));
        assert!(supports_usage("1.1.11"));
        assert!(supports_usage("1.4.12"));
        assert!(!supports_usage(""));
        assert!(!supports_usage("1.1"));
        assert!(!supports_usage("1.2.0.1"));
    }

    #[test]
    fn recognises_keyring_onboarding_as_signed_in() {
        let home = std::env::temp_dir().join(format!("isle-onboarding-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        assert!(!signed_in_at(&home));
        // What agy writes once its keyring sign-in and onboarding finish.
        let onboarding = home.join(ONBOARDING);
        std::fs::create_dir_all(onboarding.parent().unwrap()).unwrap();
        std::fs::write(&onboarding, r#"{"onboardingComplete": true}"#).unwrap();
        assert!(signed_in_at(&home));
        // Onboarding that did not finish, or a file that is not JSON, is no sign-in.
        std::fs::write(&onboarding, r#"{"onboardingComplete": false}"#).unwrap();
        assert!(!signed_in_at(&home));
        std::fs::write(&onboarding, "{not json").unwrap();
        assert!(!signed_in_at(&home));
        // The token file older agy writes, without any onboarding.
        std::fs::remove_file(&onboarding).unwrap();
        std::fs::write(home.join(LOGIN), "token").unwrap();
        assert!(signed_in_at(&home));
        std::fs::remove_dir_all(home).unwrap();
    }

    /// An agy older than 1.1.11 would start a model turn on `/usage`: it is never asked for it.
    #[tokio::test]
    async fn refuses_usage_from_an_old_agy() {
        let root = std::env::temp_dir().join(format!("isle-agy-old-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let marker = root.join("ran");
        let fake = root.join("agy");
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.1.10; exit 0; fi\ntouch '{}'\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        assert_eq!(usage(&fake).await, Err(UsageError::NeedsUpdate));
        assert!(!marker.exists(), "an old agy was asked for /usage");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tells_why_reading_usage_failed() {
        let reported = serde_json::json!({"status": "SUCCESS", "command": {"name": "usage"}});
        assert_eq!(parse_usage(&reported.to_string(), "", true), Ok(reported));
        // Signed out, as agy says on stderr or in its JSON error.
        assert_eq!(
            parse_usage("", "Error: authentication required.", false),
            Err(UsageError::SignIn)
        );
        assert_eq!(
            parse_usage(r#"{"status":"ERROR","error":"not logged in"}"#, "", false),
            Err(UsageError::SignIn)
        );
        // The quota service could not be reached.
        assert_eq!(
            parse_usage("", "dial tcp: no such host", false),
            Err(UsageError::Offline)
        );
        assert_eq!(
            parse_usage("", "Error: context deadline exceeded", false),
            Err(UsageError::Offline)
        );
        // Anything else, including output that is no usage JSON at all.
        assert_eq!(
            parse_usage("", "Error: something else", false),
            Err(UsageError::Busy)
        );
        assert_eq!(parse_usage("", "", true), Err(UsageError::Busy));
        assert_eq!(
            parse_usage(r#"{"status":"ERROR","error":"internal"}"#, "", true),
            Err(UsageError::Busy)
        );
    }

    #[test]
    fn prunes_whole_conversations_last_used_before_today() {
        let store = std::env::temp_dir().join(format!("isle-prune-{}", std::process::id()));
        let today = Local::now().date_naive();
        let touch = |path: &str, days_ago: u64| {
            let path = store.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "").unwrap();
            let when =
                std::time::SystemTime::now() - std::time::Duration::from_secs(days_ago * 86_400);
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(when)
                .unwrap();
        };
        touch("conversations/old.db", 2);
        touch("brain/old/plan.md", 2);
        // A conversation's folder is as old as what was last written in it.
        let two_days_ago =
            std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 86_400);
        let brain = std::fs::File::open(store.join("brain/old")).unwrap();
        brain.set_modified(two_days_ago).unwrap();
        touch("conversations/new.db", 2);
        // Its write-ahead log was used today, so the conversation is today's.
        touch("conversations/new.db-wal", 0);
        touch("log/cli-old.log", 2);
        touch("log/cli-new.log", 0);
        prune_in(&store, today);
        assert!(!store.join("log/cli-old.log").exists());
        assert!(store.join("log/cli-new.log").exists());
        assert!(!store.join("conversations/old.db").exists());
        assert!(!store.join("brain/old").exists());
        assert!(store.join("conversations/new.db").exists());
        std::fs::remove_dir_all(&store).unwrap();
    }

    /// agy signed out prints its reason and quits before reading the request; the island must say
    /// to sign in, not that agy stopped.
    #[tokio::test]
    async fn a_signed_out_agy_asks_to_sign_in() {
        let root = std::env::temp_dir().join(format!("isle-signed-out-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let fake = root.join("agy");
        std::fs::write(
            &fake,
            "#!/bin/sh\necho 'Error: authentication required.' >&2\n\
             echo '{\"event\":\"result\",\"result\":{\"status\":\"ERROR\",\"error\":\"authentication failed or timed out\"}}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        // A test running a program at the same moment may still hold the new script open ("Text file
        // busy") for a blink: try again then.
        let mut agy = loop {
            match Agy::start_program(&fake, "", None, &root.join("workspace")) {
                Ok(agy) => break agy,
                Err(err) if format!("{err:#}").contains("Text file busy") => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                Err(err) => panic!("{err:#}"),
            }
        };
        // Give it the moment to quit, as a signed-out agy does.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let err = agy.ask("hi", None).await.unwrap_err();
        let failure =
            super::super::brain::explain(super::super::brain::Provider::Agy, &format!("{err:#}"));
        assert!(failure.sign_in, "{err:#}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shares_the_users_sign_in() {
        let root = std::env::temp_dir().join(format!("isle-agy-login-{}", std::process::id()));
        let (user, isle) = (root.join("user"), root.join("isle"));
        std::fs::create_dir_all(user.join(LOGIN).parent().unwrap()).unwrap();
        // Not signed in yet: nothing to link.
        link_login(&user, &isle);
        assert!(!isle.join(LOGIN).exists());
        std::fs::write(user.join(LOGIN), "token").unwrap();
        link_login(&user, &isle);
        assert_eq!(std::fs::read_to_string(isle.join(LOGIN)).unwrap(), "token");
        // agy replaced the link with a copy older than the user's: linked again.
        std::fs::remove_file(isle.join(LOGIN)).unwrap();
        std::fs::write(isle.join(LOGIN), "stale").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(isle.join(LOGIN))
            .unwrap()
            .set_modified(old)
            .unwrap();
        link_login(&user, &isle);
        assert_eq!(
            std::fs::read_link(isle.join(LOGIN)).unwrap(),
            user.join(LOGIN)
        );
        assert_eq!(std::fs::read_to_string(user.join(LOGIN)).unwrap(), "token");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tells_what_agy_does() {
        let search = serde_json::json!({"step_type": "tool", "state": "ACTIVE", "tool_name": "search_web",
            "tool_info": {"parameters": {"query": "cuaca jakarta"}}});
        assert_eq!(
            step(&search).unwrap(),
            "Searching the web for “cuaca jakarta”…"
        );
        let read = serde_json::json!({"step_type": "tool", "state": "ACTIVE", "tool_name": "read_url_content",
            "tool_info": {"parameters": {"Url": "https://www.bmkg.go.id/cuaca"}}});
        assert_eq!(step(&read).unwrap(), "Reading www.bmkg.go.id…");
        assert_eq!(
            step(&serde_json::json!({"step_type": "agent_response"})),
            None
        );
    }

    #[test]
    fn schema_and_hooks_are_valid_json() {
        serde_json::from_str::<Value>(SCHEMA).unwrap();
        let hooks: Value = serde_json::from_str(HOOKS).unwrap();
        let command = hooks["isle-guard"]["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        // Run as agy runs it, with what agy sends.
        let decide = |input: &str| {
            let mut child = std::process::Command::new("sh")
                .args(["-c", command])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            use std::io::Write;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
            let out = child.wait_with_output().unwrap();
            serde_json::from_slice::<Value>(&out.stdout).unwrap()["decision"].clone()
        };
        let call = |tool_call: &str| {
            format!(r#"{{"conversationId":"c","toolCall":{tool_call},"transcriptPath":"/t"}}"#)
        };
        assert_eq!(
            decide(&call(r#"{"args":{"query":"weather"},"name":"search_web"}"#)),
            "allow"
        );
        assert_eq!(
            decide(&call(
                r#"{"args":{"CommandLine":"ls"},"name":"run_command"}"#
            )),
            "deny"
        );
        // A "name" in the arguments is not the tool's.
        assert_eq!(
            decide(&call(
                r#"{"args":{"name":"search_web"},"name":"run_command"}"#
            )),
            "deny"
        );
        assert_eq!(decide(r#"{"name":"search_web"}"#), "deny");
    }

    #[test]
    fn reads_structured_output() {
        let result = serde_json::json!({"status": "SUCCESS", "response": "",
            "structured_output": {"say": "Opening Google.", "actions": [{"type": "open_url", "url": "https://google.com"}]}});
        let answer = parse_result(&result).unwrap();
        assert_eq!(answer.say, "Opening Google.");
        assert_eq!(answer.actions[0]["url"], "https://google.com");
    }

    #[test]
    fn falls_back_to_the_plain_reply() {
        let result = serde_json::json!({"status": "SUCCESS", "response": "Hi there\n"});
        assert_eq!(parse_result(&result).unwrap().say, "Hi there");
        let failed = serde_json::json!({"status": "ERROR", "error": "not signed in"});
        assert_eq!(
            parse_result(&failed).unwrap_err().to_string(),
            "not signed in"
        );
    }
}
