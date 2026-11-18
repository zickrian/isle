// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Pi (`pi`) in JSON print mode, with the user's own sign-ins and providers: one run per turn, resumed, with no
//! tools, extensions, skills or context files of the user's, its conversations in a folder of Isle's own so they
//! never mix with the user's. Its words stream as they come (#64).

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use anyhow::{Context, bail};
use chrono::{DateTime, Local, NaiveDate};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;

use super::answer::{Answer, SCHEMA};
use super::child::{self, Events};

const STDERR_LINES: usize = 20;
/// Pi's own network on start (update checks, package updates, telemetry): none, for an answer.
const QUIET: [(&str, &str); 2] = [("PI_OFFLINE", "1"), ("PI_SKIP_VERSION_CHECK", "1")];
/// Everything of the user's Pi that would act or add to the prompt, left out: Isle runs the actions itself.
const CONTAINED: &[&str] = &[
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
];
/// The API keys Pi reads from the environment for its most used providers (its docs' providers.md): one set is a
/// way to answer without signing in.
const API_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "CEREBRAS_API_KEY",
    "OPENCODE_API_KEY",
];

/// What each turn's `pi` run needs, and the conversation it resumes.
pub struct Pi {
    program: PathBuf,
    model: String,
    workspace: PathBuf,
    instructions: String,
    pub conversation: Option<String>,
}

/// `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`: where Pi keeps the user's sign-ins, settings and models.
fn agent_dir() -> PathBuf {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|dir| !dir.is_empty())
        .map_or_else(
            || dirs::home_dir().unwrap_or_default().join(".pi/agent"),
            PathBuf::from,
        )
}

/// Isle's own conversations with Pi, apart from the user's (`--session-dir`).
fn sessions() -> PathBuf {
    crate::store::data_dir().join("pi/sessions")
}

impl Pi {
    /// Remembers the conversation to resume (`resume`) and the job (`instructions`). Each turn starts `pi` and
    /// lets it exit: print mode answers once and stops.
    pub fn start(
        program: &Path,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
        instructions: &str,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(workspace)?;
        crate::store::create_private_dir(&sessions()).context("could not make Pi's folder")?;
        Ok(Self {
            program: program.to_owned(),
            model: model.to_owned(),
            workspace: workspace.to_owned(),
            // Pi has no web search, and no way to hold it to a schema: told both.
            instructions: format!(
                "{instructions}\n\nHere you cannot search the web: for anything current, answer from what you \
                 know and say it may be out of date.\n\nAnswer every request with one JSON object and nothing \
                 else (no text or code fence around it), as this JSON Schema describes: {SCHEMA}"
            ),
            conversation: resume.filter(|id| session_id(id)).map(str::to_owned),
        })
    }

    /// One turn; an error carries what Pi printed to stderr meanwhile.
    pub async fn ask(
        &mut self,
        prompt: &str,
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        let mut command = Command::new(&self.program);
        command
            .args(["--mode", "json", "-p"])
            .args(CONTAINED)
            .arg("--session-dir")
            .arg(sessions())
            .args(["--thinking", super::brain::EFFORT])
            .arg("--system-prompt")
            .arg(&self.instructions)
            .envs(QUIET)
            .current_dir(&self.workspace)
            // The request goes in on stdin: on the command line, any user could read it.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !self.model.is_empty() {
            command.args(["--model", &self.model]);
        }
        // An id Pi no longer has starts a new conversation by it.
        if let Some(id) = &self.conversation {
            command.args(["--session-id", id]);
        }
        let mut child =
            child::spawn(&mut command).context("could not start pi; is Pi installed?")?;
        let mut stdin = child.stdin.take().expect("piped stdin");
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
        // Written whole and closed: Pi reads stdin to its end before it starts. One that quit at once (a bad
        // option) still says why on stdout or stderr.
        let written = async {
            stdin.write_all(prompt.as_bytes()).await?;
            stdin.shutdown().await
        }
        .await;
        drop(stdin);
        let answer = read_turn(&mut self.conversation, events, draft).await;
        drop(child);
        let answer = match (answer, written) {
            (Err(err), Err(write)) => {
                Err(err.context(format!("could not hand pi the request: {write}")))
            }
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

/// Reads one run's events into an answer, keeping the conversation's id and passing on the draft as it comes.
async fn read_turn<R: AsyncRead + Unpin>(
    conversation: &mut Option<String>,
    mut events: Events<R>,
    draft: Option<&UnboundedSender<String>>,
) -> anyhow::Result<Answer> {
    let words: &[&str] = &[
        "\"session\"",
        "\"message_start\"",
        "\"message_update\"",
        "\"message_end\"",
        "\"agent_end\"",
    ];
    let mut written = String::new();
    let mut shown = String::new();
    // The last answer's words, or why it failed: Pi says an error there, and still exits 0.
    let mut last: Option<anyhow::Result<String>> = None;
    while let Some(event) = events.next(words).await? {
        match event["type"].as_str() {
            Some("session") => {
                if let Some(id) = event["id"].as_str().filter(|id| session_id(id)) {
                    *conversation = Some(id.to_owned());
                }
            }
            Some("message_start") if event["message"]["role"] == "assistant" => written.clear(),
            Some("message_update") => {
                let delta = &event["assistantMessageEvent"];
                if delta["type"] == "text_delta" {
                    written.push_str(delta["delta"].as_str().unwrap_or_default());
                    if let (Some(draft), Some(say)) = (draft, super::answer::partial_say(&written))
                        && say != shown
                    {
                        draft.send(say.clone()).ok();
                        shown = say;
                    }
                }
            }
            Some("message_end") if event["message"]["role"] == "assistant" => {
                last = Some(message_text(&event["message"]));
            }
            Some("agent_end") => break,
            _ => {}
        }
    }
    match last {
        Some(Ok(text)) if !text.trim().is_empty() => Ok(super::answer::from_text(&text)),
        Some(Ok(_)) => bail!("pi gave no answer"),
        Some(Err(err)) => Err(err),
        None => bail!("pi stopped"),
    }
}

/// An assistant message's words, or the error it ended with (signed out, a model it lacks, a used-up limit).
fn message_text(message: &Value) -> anyhow::Result<String> {
    if matches!(message["stopReason"].as_str(), Some("error" | "aborted")) {
        let reason = message["errorMessage"]
            .as_str()
            .filter(|reason| !reason.trim().is_empty())
            .unwrap_or("pi failed");
        bail!("{reason}");
    }
    Ok(message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect())
}

/// Whether Pi can answer: a sign-in or key it keeps, a provider of the user's own (`models.json`), or an API key
/// it reads from the environment.
pub fn signed_in() -> bool {
    let dir = agent_dir();
    let kept = std::fs::read(dir.join("auth.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|auth| auth.as_object().map(|keys| !keys.is_empty()))
        .unwrap_or(false);
    let env = API_KEYS
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()));
    kept || dir.join("models.json").is_file() || env
}

/// The model the user's own Pi answers with (`provider/model`, from its settings), if set.
pub fn user_model() -> Option<String> {
    let settings: Value =
        serde_json::from_slice(&std::fs::read(agent_dir().join("settings.json")).ok()?).ok()?;
    let provider = settings["defaultProvider"]
        .as_str()
        .filter(|p| !p.is_empty())?;
    let model = settings["defaultModel"]
        .as_str()
        .filter(|m| !m.is_empty())?;
    Some(format!("{provider}/{model}"))
}

/// The models `pi --list-models` lists: those of the providers the user can use, as `provider/model`.
pub async fn models(program: &Path) -> anyhow::Result<Vec<(String, String)>> {
    use tokio::io::AsyncReadExt;
    let mut command = Command::new(program);
    command
        .arg("--list-models")
        .args(["--no-extensions", "--no-approve"])
        .envs(QUIET)
        .current_dir(crate::store::data_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = child::spawn(&mut command).context("could not start pi")?;
    let mut listed = String::new();
    child
        .stdout
        .take()
        .expect("piped stdout")
        .read_to_string(&mut listed)
        .await?;
    let status = child.wait().await?;
    if !status.success() {
        bail!("pi --list-models failed ({status})");
    }
    Ok(listed_models(&listed))
}

/// The (provider, model) pairs of `pi --list-models`' table: only rows under its header, each `provider model
/// context max-out thinking images` with the last two yes or no. Anything else (Pi 0.85 prints "No models
/// available. Use /login…" with none, a warning, a search's "No models matching") is no model.
pub fn listed_models(listed: &str) -> Vec<(String, String)> {
    let mut lines = listed.lines();
    let header = |line: &str| {
        let mut columns = line.split_whitespace();
        columns.next() == Some("provider") && columns.next() == Some("model")
    };
    if !lines.by_ref().any(header) {
        return Vec::new();
    }
    lines
        .filter_map(|line| {
            let columns: Vec<&str> = line.split_whitespace().collect();
            let flags = columns.len().checked_sub(2).map(|at| &columns[at..])?;
            (columns.len() >= 6 && flags.iter().all(|flag| matches!(*flag, "yes" | "no"))).then(
                || {
                    (
                        columns[0].to_owned(),
                        columns[1..columns.len() - 4].join(" "),
                    )
                },
            )
        })
        .collect()
}

/// Whether `id` is a conversation id as Pi makes them (a UUID), never a path.
fn session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Deletes Isle's Pi conversation `id` now: its file, `<time>_<id>.jsonl`.
pub fn forget(id: &str) {
    if !session_id(id) {
        return;
    }
    let suffix = format!("_{id}.jsonl");
    for entry in std::fs::read_dir(sessions())
        .into_iter()
        .flatten()
        .flatten()
    {
        if entry.file_name().to_string_lossy().ends_with(&suffix)
            && entry.file_type().is_ok_and(|kind| kind.is_file())
        {
            std::fs::remove_file(entry.path()).ok();
        }
    }
}

/// Deletes Isle's Pi conversations last written before `today`.
pub fn prune(today: NaiveDate) {
    prune_in(&sessions(), today);
}

/// `prune` on a given folder.
fn prune_in(dir: &Path, today: NaiveDate) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .is_ok_and(|time| DateTime::<Local>::from(time).date_naive() < today);
        let file = entry.file_type().is_ok_and(|kind| kind.is_file());
        if old && file && entry.path().extension().is_some_and(|e| e == "jsonl") {
            std::fs::remove_file(entry.path()).ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A run's output as Pi 0.85 prints it, for `read_turn`.
    async fn read(lines: &[Value]) -> (Option<String>, anyhow::Result<Answer>, Vec<String>) {
        let output: String = lines.iter().map(|line| format!("{line}\n")).collect();
        let (sender, mut drafts) = tokio::sync::mpsc::unbounded_channel();
        let mut conversation = None;
        let answer = read_turn(
            &mut conversation,
            Events::new(output.as_bytes()),
            Some(&sender),
        )
        .await;
        let mut shown = Vec::new();
        while let Ok(draft) = drafts.try_recv() {
            shown.push(draft);
        }
        (conversation, answer, shown)
    }

    fn assistant(content: Value, stop: &str, error: Option<&str>) -> Value {
        let mut message =
            serde_json::json!({"role": "assistant", "content": content, "stopReason": stop});
        if let Some(error) = error {
            message["errorMessage"] = error.into();
        }
        message
    }

    #[tokio::test]
    async fn reads_pis_answer_its_draft_and_conversation() {
        let id = "96716011-ea72-4278-aa4e-15b258d5f947";
        let text = r#"{"say": "Halo, aku Isle.", "actions": [{"type": "open_url", "url": "https://pi.dev"}]}"#;
        let (head, tail) = text.split_at(20);
        let (conversation, answer, drafts) = read(&[
            serde_json::json!({"type": "session", "version": 3, "id": id}),
            serde_json::json!({"type": "agent_start"}),
            serde_json::json!({"type": "message_start", "message": {"role": "user", "content": []}}),
            serde_json::json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
            serde_json::json!({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": head}}),
            serde_json::json!({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "delta": "hmm"}}),
            serde_json::json!({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": tail}}),
            serde_json::json!({"type": "message_end", "message": assistant(serde_json::json!([
                {"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": text}]), "stop", None)}),
            serde_json::json!({"type": "agent_end", "messages": []}),
        ])
        .await;
        assert_eq!(conversation.as_deref(), Some(id));
        let answer = answer.unwrap();
        assert_eq!(
            (answer.say.as_str(), answer.actions.len()),
            ("Halo, aku Isle.", 1)
        );
        assert_eq!(drafts.last().map(String::as_str), Some("Halo, aku Isle."));
    }

    #[tokio::test]
    async fn an_error_it_ends_with_is_a_failure_though_it_exits_0() {
        // As Pi 0.85 printed it for an expired ChatGPT sign-in.
        let error = "OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): Could not \
                     validate your refresh token. Please try signing in again.";
        let (_, answer, _) = read(&[
            serde_json::json!({"type": "session", "id": "abc-123"}),
            serde_json::json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
            serde_json::json!({"type": "message_end", "message": assistant(serde_json::json!([]), "error", Some(error))}),
            serde_json::json!({"type": "agent_end", "messages": []}),
        ])
        .await;
        let error = format!("{:#}", answer.unwrap_err());
        assert!(error.contains("refresh token"), "{error}");
        let failure = super::super::brain::explain(super::super::brain::Provider::Pi, &error);
        assert!(failure.sign_in, "{failure:?}");
        assert_eq!(failure.error, "Sign in to Pi");
        // With no sign-in or key at all it exits 1 with this on stderr (the turn's error carries it).
        let none = "pi stopped: No API key found for the selected model. Use /login to log into a provider via \
                    OAuth or API key.";
        assert!(super::super::brain::explain(super::super::brain::Provider::Pi, none).sign_in);
        // Its provider out of reach (a local model's server not running, or offline).
        let (_, unreachable, _) = read(&[
            serde_json::json!({"type": "message_end", "message": assistant(serde_json::json!([]), "error", Some("Connection error."))}),
            serde_json::json!({"type": "agent_end", "messages": []}),
        ])
        .await;
        let failure = super::super::brain::explain(
            super::super::brain::Provider::Pi,
            &format!("{:#}", unreachable.unwrap_err()),
        );
        assert_eq!(failure.error, "Pi can’t reach its provider");
    }

    #[tokio::test]
    async fn plain_words_and_a_run_cut_short() {
        let (_, answer, _) = read(&[
            serde_json::json!({"type": "message_end", "message": assistant(serde_json::json!([
                {"type": "text", "text": "Just words."}]), "stop", None)}),
            serde_json::json!({"type": "agent_end", "messages": []}),
        ])
        .await;
        let answer = answer.unwrap();
        assert_eq!(
            (answer.say.as_str(), answer.actions.len()),
            ("Just words.", 0)
        );
        let (_, stopped, _) = read(&[serde_json::json!({"type": "agent_start"})]).await;
        assert_eq!(stopped.unwrap_err().to_string(), "pi stopped");
        let (_, empty, _) = read(&[
            serde_json::json!({"type": "message_end", "message": assistant(serde_json::json!([]), "stop", None)}),
            serde_json::json!({"type": "agent_end", "messages": []}),
        ])
        .await;
        assert_eq!(empty.unwrap_err().to_string(), "pi gave no answer");
    }

    #[test]
    fn no_models_is_none_whatever_pi_prints() {
        // Pi 0.85 with no sign-in, no key and no models.json (or a broken one): exit 0, this on stdout.
        let none = "No models available. Use /login to log into a provider via OAuth or API key. See:\n  \
                    /usr/lib/node_modules/pi/docs/providers.md\n  /usr/lib/node_modules/pi/docs/models.md\n";
        assert!(listed_models(none).is_empty());
        assert!(listed_models("").is_empty());
        assert!(listed_models("provider  model  context  max-out  thinking  images\n").is_empty());
        assert!(listed_models("No models matching \"x\"\n").is_empty());
        // Ids with a colon (a local model's tag) or a slash (a router's), as Pi lists them.
        let listed = "provider    model                 context  max-out  thinking  images\n\
                      ollama      qwen2.5-coder:7b      128K     16.4K    no        no    \n\
                      openrouter  anthropic/claude-4.5  200K     64K      yes       yes   \n";
        assert_eq!(
            listed_models(listed),
            [
                ("ollama".to_owned(), "qwen2.5-coder:7b".to_owned()),
                ("openrouter".to_owned(), "anthropic/claude-4.5".to_owned()),
            ]
        );
    }

    /// Against the Pi installed here: `cargo test -p isle-daemon -- --ignored real_pi`.
    #[tokio::test]
    #[ignore = "needs Pi installed"]
    async fn real_pi_lists_its_models() {
        let program = super::super::brain::Provider::Pi
            .program()
            .expect("pi installed");
        let listed = models(&program).await.unwrap();
        println!("{listed:?}");
        assert!(!listed.is_empty() && listed.iter().all(|(p, m)| !p.is_empty() && !m.is_empty()));
    }

    #[test]
    fn lists_the_models_pi_can_use() {
        let listed = "provider      model                context  max-out  thinking  images\n\
                      openai-codex  gpt-5.4-mini         272K     128K     yes       yes   \n\
                      anthropic     claude-sonnet-4-5    200K     64K      yes       yes   \n\n";
        assert_eq!(
            listed_models(listed),
            [
                ("openai-codex".to_owned(), "gpt-5.4-mini".to_owned()),
                ("anthropic".to_owned(), "claude-sonnet-4-5".to_owned()),
            ]
        );
    }

    #[test]
    fn keeps_to_isles_own_conversations() {
        assert!(session_id("96716011-ea72-4278-aa4e-15b258d5f947"));
        assert!(!session_id("../../.ssh/id_rsa") && !session_id(""));
        let dir = std::env::temp_dir().join(format!("isle-pi-prune-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("2026-01-01T00-00-00-000Z_aaaa.jsonl");
        let new = dir.join("2026-11-18T00-00-00-000Z_bbbb.jsonl");
        let other = dir.join("notes.txt");
        for path in [&old, &new, &other] {
            std::fs::write(path, "{}").unwrap();
        }
        let yesterday =
            std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 24 * 3600);
        for path in [&old, &other] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(yesterday)
                .unwrap();
        }
        prune_in(&dir, Local::now().date_naive());
        assert!(!old.exists() && new.exists() && other.exists());
        std::fs::remove_dir_all(dir).ok();
    }
}
