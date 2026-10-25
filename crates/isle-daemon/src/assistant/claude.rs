// SPDX-License-Identifier: GPL-3.0-or-later

//! Claude Code (`claude`) in stream-json print mode, with the user's own sign-in: one process per
//! conversation, kept to the web tools, without the user's settings, hooks, memory or MCP servers.

use std::collections::VecDeque;
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

/// The tools it may use: the web, nothing on this computer.
const TOOLS: &str = "WebSearch,WebFetch";
const STDERR_LINES: usize = 20;

pub struct Claude {
    _child: Group,
    stdin: ChildStdin,
    events: Events<ChildStdout>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    pub conversation: Option<String>,
}

impl Claude {
    /// Starts Claude Code with Isle's job (`instructions`) in place of its own coding-agent prompt.
    pub fn start(
        program: &Path,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
        instructions: &str,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(workspace)?;
        let mut command = Command::new(program);
        command
            .args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                // Its words as they come, for the island to show while it writes.
                "--include-partial-messages",
            ])
            .args(["--tools", TOOLS, "--allowedTools", TOOLS])
            // None of the user's settings, hooks, CLAUDE.md or MCP servers: only its sign-in, and how they
            // sign in (an API key helper, Bedrock or Vertex in their settings' `env`).
            .args(["--setting-sources", "", "--strict-mcp-config"])
            .args(["--system-prompt", instructions, "--json-schema", SCHEMA]);
        // A file only the user can read: on the command line, any user could read an API key in it.
        let sign_in = crate::store::data_dir().join("claude-sign-in.json");
        match sign_in_settings() {
            Some(json) => {
                write_sign_in(&sign_in, &json).context("could not hand Claude its sign-in")?;
                command.arg("--settings").arg(&sign_in);
            }
            None => {
                std::fs::remove_file(&sign_in).ok();
            }
        }
        if !model.is_empty() {
            command.args(["--model", model]);
        }
        if let Some(id) = resume {
            command.args(["--resume", id]);
        }
        command
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = child::spawn(&mut command)
            .context("could not start claude; is Claude Code installed?")?;
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

    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        self.stderr.lock().unwrap().clear();
        self.turn(prompt, activity, draft).await.map_err(|err| {
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
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        let message =
            serde_json::json!({"type": "user", "message": {"role": "user", "content": prompt}});
        // Claude Code that quit at once (signed out) still left its reason on stdout: read it then.
        let sent = self
            .stdin
            .write_all(format!("{message}\n").as_bytes())
            .await;
        // Its first event and its answer carry the conversation's id; tool results, the bulk, are skipped.
        // Its answer is written into the StructuredOutput tool: that JSON, as it comes, is the draft.
        let words: &[&str] = &[
            "\"init\"",
            "\"result\"",
            "\"tool_use\"",
            "\"input_json_delta\"",
        ];
        let mut written = String::new();
        let mut shown = String::new();
        while let Some(event) = self.events.next(words).await? {
            if let Some(id) = event["session_id"].as_str() {
                self.conversation = Some(id.to_owned());
            }
            match event["type"].as_str() {
                Some("result") => return parse_result(&event),
                Some("stream_event") => {
                    let delta = &event["event"]["delta"];
                    if delta["type"] == "input_json_delta" {
                        written.push_str(delta["partial_json"].as_str().unwrap_or_default());
                        if let (Some(draft), Some(say)) =
                            (draft, super::answer::partial_say(&written))
                            && say != shown
                        {
                            draft.send(say.clone()).ok();
                            shown = say;
                        }
                    } else if event["event"]["type"] == "content_block_start" {
                        written.clear();
                    }
                }
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
        sent.context("claude stopped")?;
        bail!("claude stopped")
    }
}

/// What Claude starts doing in a message, for the island: its web searches and the pages it reads.
fn steps(event: &Value) -> Vec<String> {
    let Some(content) = event["message"]["content"].as_array() else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|part| part["type"] == "tool_use")
        .filter_map(|tool| match tool["name"].as_str()? {
            "WebSearch" => Some(match tool["input"]["query"].as_str() {
                Some(query) => format!("Searching the web for “{query}”…"),
                None => "Searching the web…".into(),
            }),
            "WebFetch" => {
                let url = tool["input"]["url"].as_str().unwrap_or_default();
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

fn parse_result(event: &Value) -> anyhow::Result<Answer> {
    if event["is_error"].as_bool() == Some(true) || event["subtype"] != "success" {
        let reason = event["result"]
            .as_str()
            .or(event["error"].as_str())
            .unwrap_or("claude failed")
            .to_owned();
        bail!("{reason}");
    }
    if let Ok(answer) = Answer::deserialize(&event["structured_output"]) {
        return Ok(answer);
    }
    Ok(super::answer::from_text(
        event["result"].as_str().unwrap_or_default(),
    ))
}

/// `$CLAUDE_CONFIG_DIR`, else `~/.claude`: where Claude Code keeps its sign-in, settings and chats.
pub fn config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|dir| !dir.is_empty())
        .map_or_else(
            || dirs::home_dir().unwrap_or_default().join(".claude"),
            PathBuf::from,
        )
}

/// The parts of the user's settings.json that say how they sign in, as `--settings` JSON, if any.
fn sign_in_settings() -> Option<String> {
    let text = std::fs::read_to_string(config_dir().join("settings.json")).ok()?;
    let settings: Value = serde_json::from_str(&text).ok()?;
    let kept: serde_json::Map<String, Value> = SIGN_IN_KEYS
        .iter()
        .filter_map(|key| Some(((*key).to_owned(), settings.get(*key)?.clone())))
        .collect();
    (!kept.is_empty()).then(|| Value::Object(kept).to_string())
}

/// Writes `json` to `path` made anew, so it is the user's alone whatever an older file was.
fn write_sign_in(path: &Path, json: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        crate::store::create_private_dir(dir)?;
    }
    match std::fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err),
        _ => {}
    }
    crate::store::write_private(path, json.as_bytes())
}

const SIGN_IN_KEYS: &[&str] = &[
    "env",
    "apiKeyHelper",
    "awsAuthRefresh",
    "awsCredentialExport",
    "forceLoginMethod",
];

/// Whether Claude Code has a way to sign in: its own sign-in, an API key, or a cloud it is set to use.
pub fn signed_in() -> bool {
    let dir = config_dir();
    let env_says = [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()));
    let settings_say = sign_in_settings().is_some_and(|json| {
        [
            "apiKeyHelper",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_USE_",
        ]
        .iter()
        .any(|key| json.contains(key))
    });
    dir.join(".credentials.json").exists() || env_says || settings_say
}

/// Where Claude Code keeps the conversations it had in Isle's workspace (and only those).
fn store() -> Option<PathBuf> {
    let workspace = crate::store::data_dir().join("assistant");
    // Claude Code names a project's folder after its path, every character but letters and digits a dash.
    let name: String = workspace
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(config_dir().join("projects").join(name))
}

/// Deletes Isle's Claude conversation `id` now (an id as Claude makes them, never a path).
pub fn forget(id: &str) {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return;
    }
    if let Some(dir) = store() {
        std::fs::remove_file(dir.join(format!("{id}.jsonl"))).ok();
    }
}

/// Deletes Isle's Claude conversations last changed before `today`.
pub fn prune(today: NaiveDate) {
    let Some(entries) = store().and_then(|dir| std::fs::read_dir(dir).ok()) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .is_ok_and(|time| DateTime::<Local>::from(time).date_naive() < today);
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !old || kind.is_symlink() {
            continue;
        }
        // A conversation is `<id>.jsonl`, and a `<id>/` folder beside it for what its tools kept.
        if kind.is_dir() {
            std::fs::remove_dir_all(entry.path()).ok();
        } else if entry.path().extension().is_some_and(|e| e == "jsonl") {
            std::fs::remove_file(entry.path()).ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    #[cfg(unix)]
    fn its_sign_in_is_the_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("isle-claude-{}", std::process::id()));
        let path = dir.join("claude-sign-in.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_sign_in(&path, r#"{"env":{"ANTHROPIC_API_KEY":"k"}}"#).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("ANTHROPIC_API_KEY")
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reads_claudes_answer_and_steps() {
        let done = json!({"type": "result", "subtype": "success", "is_error": false, "result": "{}",
            "structured_output": {"say": "Oke, aku bukain YouTube.", "actions": [{"type": "open_url", "url": "https://youtube.com"}]}});
        let answer = parse_result(&done).unwrap();
        assert_eq!(
            (answer.say.as_str(), answer.actions.len()),
            ("Oke, aku bukain YouTube.", 1)
        );
        let signed_out = json!({"type": "result", "subtype": "success", "is_error": true, "result": "Invalid API key · Please run /login"});
        assert!(
            parse_result(&signed_out)
                .unwrap_err()
                .to_string()
                .contains("/login")
        );
        let search = json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "x"},
            {"type": "tool_use", "name": "WebSearch", "input": {"query": "cuaca jakarta"}}]}});
        assert_eq!(steps(&search), ["Searching the web for “cuaca jakarta”…"]);
    }

    #[test]
    fn keeps_to_isles_own_conversations() {
        let dir = store().unwrap();
        assert!(dir.starts_with(dirs::home_dir().unwrap().join(".claude/projects")));
        // Named after Isle's own workspace, wherever its data folder is (XDG_DATA_HOME moves it).
        let workspace = crate::store::data_dir().join("assistant");
        let slug: String = workspace
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        assert!(
            dir.to_string_lossy().ends_with(&slug),
            "{}",
            dir.display()
        );
    }
}
