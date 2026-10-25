// SPDX-License-Identifier: GPL-3.0-or-later

//! The Antigravity CLI (`agy`) in stream-json print mode: one process per voice session,
//! started while the user speaks so its start-up is hidden, and one turn per request.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use anyhow::{Context, bail};
use chrono::{DateTime, Local, NaiveDate};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc::UnboundedSender;

use super::answer::{Answer, SCHEMA};
use super::child::{self, Events, Group};

/// agy may only search the web and read pages; commands and file changes go through Isle's actions,
/// which the user sees (agy's own settings may let it run anything without asking). The hook gets
/// `{"toolCall":{"args":{…},"name":"…"},"transcriptPath":…}`: the tool's own name is the one that closes
/// `toolCall`, so a "name" inside its arguments cannot pass for it; any other layout is refused.
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

/// Where agy keeps its sign-in, under its home.
pub const LOGIN: &str = ".gemini/antigravity-cli/antigravity-oauth-token";

/// Links Isle's agy home to the user's agy sign-in, so signing in once (in `user`'s home) is enough
/// (see sign_in.rs).
fn link_login(user: &Path, isle: &Path) {
    super::sign_in::share(&user.join(LOGIN), &isle.join(LOGIN));
}

/// Deletes the conversations last used before `today`, all of a conversation's files together.
pub fn prune(today: NaiveDate) {
    prune_in(&store(), today);
}

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

pub struct Agy {
    _child: Group,
    stdin: ChildStdin,
    events: Events<ChildStdout>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    /// Set from agy's first event; a later session can resume it.
    pub conversation: Option<String>,
}

impl Agy {
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
    use super::*;

    #[test]
    #[cfg(unix)]
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
    #[cfg(unix)]
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
    #[cfg(unix)]
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
    #[cfg(unix)]
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
