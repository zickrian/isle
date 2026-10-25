// SPDX-License-Identifier: GPL-3.0-or-later

//! `isled --agent-hook claude|codex`: run by the AI itself, it turns what the AI hands its hooks into an
//! event for the running isled, or (a permission) asks the island and prints the user's answer for the AI.
//! It never fails: when there is no answer (no isled, no reply in time) it prints nothing, and the AI asks
//! in its own terminal as it would without Isle.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use zbus::proxy::{CacheProperties, MethodFlags};

use super::{Event, Request};

/// All the hook may take, connecting included.
const TIMEOUT: Duration = Duration::from_secs(1);
/// A permission waits this long for the island at most (the AIs give the hook ten minutes).
const ANSWER: Duration = Duration::from_secs(9 * 60 + 40);
/// The longest command or path the island asks about (it shows it whole, over a few lines).
const MAX_SHOWN: usize = 160;
/// Claude Code's payload is small; more than this is not read.
const MAX_INPUT: u64 = 1024 * 1024;
/// How often a waiting permission looks whether it was answered in the AI's own terminal instead.
const ANSWERED_EVERY: Duration = Duration::from_secs(1);
/// How long the tool's call may take to show in the transcript before that is no longer looked for.
const FIND_CALL_FOR: u32 = 6;
/// The end of the transcript searched for the tool's call, and the most read of it at a time.
const TRANSCRIPT_TAIL: u64 = 1024 * 1024;

/// `args` are what follows `--agent-hook`: the AI, then (Codex) its JSON as the last.
pub async fn run(args: &[String]) {
    let ai = args.first().map(String::as_str);
    // Codex's old `notify` passes its JSON as the last argument; hooks pass theirs on stdin.
    let payload: Option<Value> = match args.get(1..).and_then(<[String]>::last) {
        Some(json) if ai == Some("codex") => serde_json::from_str(json).ok(),
        _ => {
            let mut input = Vec::new();
            let _ = std::io::stdin().take(MAX_INPUT).read_to_end(&mut input);
            serde_json::from_slice(&input).ok()
        }
    };
    let Some(payload) = payload else { return };
    if payload["hook_event_name"] == "PermissionRequest" {
        let Some(request) = request(ai.unwrap_or_default(), &payload) else {
            return;
        };
        // Answered in its terminal first, the AI leaves its hook waiting: it ends itself, and with it the
        // island's alert.
        tokio::select! {
            answer = tokio::time::timeout(ANSWER, decide(&request)) => {
                if let Ok(Ok(answer)) = answer
                    && let Some(output) = decision(ai.unwrap_or_default(), &answer, &payload)
                {
                    println!("{output}");
                }
            }
            () = answered_elsewhere(&payload), if ai == Some("claude") => {}
        }
        return;
    }
    let event = match ai {
        Some("claude") => from_claude(&payload),
        Some("codex") => from_codex(&payload).or_else(|| from_codex_hook(&payload)),
        _ => None,
    };
    if let Some(event) = event {
        let _ = tokio::time::timeout(TIMEOUT, send(&event)).await;
    }
}

/// What the island shows of a permission: the tool, and what it would run or touch.
fn request(ai: &str, payload: &Value) -> Option<Request> {
    if !matches!(ai, "claude" | "codex") {
        return None;
    }
    let text = |key: &str| payload[key].as_str().unwrap_or_default();
    let input = &payload["tool_input"];
    let line = ["command", "file_path", "path", "url", "pattern", "query"]
        .iter()
        .find_map(|key| input[key].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| readable(input));
    // Only what the island can show whole: more lines, hidden characters or more than fits, and the AI
    // asks in its terminal, where all of it shows.
    if !crate::assistant::shows_whole(&line, MAX_SHOWN) {
        return None;
    }
    let cwd = if text("cwd").is_empty() {
        std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        text("cwd").to_owned()
    };
    Some(Request {
        provider: ai.into(),
        cwd,
        pids: ancestors(),
        session: text("session_id").into(),
        tool: text("tool_name").into(),
        input: line,
        always: !rule_suggestions(payload).is_empty(),
        ..Request::default()
    })
}

/// A tool's input with no command, path or link (an MCP tool's), as `key: value` pairs, all of them, so the
/// island shows what is asked without the JSON around it.
fn readable(input: &Value) -> String {
    match input {
        Value::Null => String::new(),
        Value::Object(fields) => fields
            .iter()
            .map(|(key, value)| match value {
                Value::String(text) => format!("{key}: {text}"),
                other => format!("{key}: {other}"),
            })
            .collect::<Vec<_>>()
            .join(", "),
        other => other.to_string(),
    }
}

/// Asks the island and waits; "" for no answer. Never starts isled.
async fn decide(request: &Request) -> zbus::Result<String> {
    let bus = zbus::conn::Builder::session()?
        .method_timeout(ANSWER)
        .build()
        .await?;
    let proxy: zbus::Proxy = zbus::proxy::Builder::new(&bus)
        .destination(crate::BUS_NAME)?
        .path(crate::OBJECT_PATH)?
        .interface("io.github.zickrian.isle.Agents1")?
        .cache_properties(CacheProperties::No)
        .build()
        .await?;
    let json = serde_json::to_string(request).unwrap_or_default();
    proxy
        .call_with_flags::<_, _, String>("Decide", MethodFlags::NoAutoStart.into(), &(json,))
        .await?
        .ok_or_else(|| zbus::Error::Failure("no answer".into()))
}

/// Resolves once the permission was answered in Claude Code's own terminal (it asks there at the same
/// time; Codex waits for the hook): its transcript has the result of this tool call. Never, when that cannot be told (no transcript, the call not found in it).
async fn answered_elsewhere(payload: &Value) {
    let path = payload["transcript_path"].as_str().map(PathBuf::from);
    let mut found = None;
    for _ in 0..FIND_CALL_FOR {
        found = path
            .as_deref()
            .and_then(|path| pending_call(path, &payload["tool_name"], &payload["tool_input"]));
        if found.is_some() {
            break;
        }
        tokio::time::sleep(ANSWERED_EVERY).await;
    }
    let (Some(path), Some((id, mut read))) = (path, found) else {
        return std::future::pending().await;
    };
    loop {
        if read_on(&path, &mut read).is_some_and(|text| has_result(&text, &id)) {
            return;
        }
        tokio::time::sleep(ANSWERED_EVERY).await;
    }
}

/// As `find_call`, but only a call still waiting: an earlier, same call that has its result already means
/// this one is not written yet.
fn pending_call(path: &Path, tool: &Value, input: &Value) -> Option<(String, u64)> {
    let (id, read) = find_call(path, tool, input)?;
    let mut probe = read;
    let answered = read_on(path, &mut probe).is_some_and(|text| has_result(&text, &id));
    (!answered).then_some((id, read))
}

/// The id of the newest call of `tool` with `input` in the transcript at `path`, and where the lines
/// after it start.
fn find_call(path: &Path, tool: &Value, input: &Value) -> Option<(String, u64)> {
    let mut file = std::fs::File::open(path).ok()?;
    let start = file.metadata().ok()?.len().saturating_sub(TRANSCRIPT_TAIL);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(TRANSCRIPT_TAIL).read_to_end(&mut bytes).ok()?;
    // Whole lines only, newest first, each with where the next one starts.
    let mut line_end = bytes.iter().rposition(|&b| b == b'\n')? + 1;
    for line in bytes[..line_end].rsplit(|&b| b == b'\n').skip(1) {
        let next = start + line_end as u64;
        line_end = line_end.saturating_sub(line.len() + 1);
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        if !line.contains("tool_use") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let calls = entry["message"]["content"].as_array().into_iter().flatten();
        for call in calls.filter(|call| call["type"] == "tool_use" && &call["name"] == tool) {
            // The input as given, or at least its command: the AI may add a field of its own.
            let same = &call["input"] == input
                || (!input["command"].is_null() && call["input"]["command"] == input["command"]);
            if same && let Some(id) = call["id"].as_str() {
                return Some((id.to_owned(), next));
            }
        }
    }
    None
}

/// What was written to `path` since `read` (whole lines only), moving `read` on.
fn read_on(path: &Path, read: &mut u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len <= *read {
        return None;
    }
    file.seek(SeekFrom::Start(*read)).ok()?;
    let mut bytes = Vec::new();
    file.take(TRANSCRIPT_TAIL).read_to_end(&mut bytes).ok()?;
    let whole = bytes.iter().rposition(|&b| b == b'\n')? + 1;
    bytes.truncate(whole);
    *read += whole as u64;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Whether `lines` hold the result of the call `id`: run, or refused in the terminal.
fn has_result(lines: &str, id: &str) -> bool {
    lines
        .lines()
        .any(|line| line.contains(id) && line.contains("tool_result"))
}

/// The rules Claude suggests keeping for next time (this command, this folder); never a change of its
/// permission mode.
fn rule_suggestions(payload: &Value) -> Vec<Value> {
    payload["permission_suggestions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|rule| matches!(rule["type"].as_str(), Some("addRules" | "addDirectories")))
        .cloned()
        .collect()
}

/// The user's answer as the AI's hook output, or none (no answer: the AI asks itself). "always" keeps
/// the rule Claude itself suggested, where it suggested it.
fn decision(ai: &str, answer: &str, payload: &Value) -> Option<String> {
    let decision = match answer {
        "allow" => serde_json::json!({"behavior": "allow"}),
        "always" if ai == "claude" => {
            serde_json::json!({"behavior": "allow", "updatedPermissions": rule_suggestions(payload)})
        }
        "always" => serde_json::json!({"behavior": "allow"}),
        "deny" => {
            serde_json::json!({"behavior": "deny", "message": "The user denied this from Isle."})
        }
        _ => return None,
    };
    Some(serde_json::json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}).to_string())
}

/// Codex's `Stop` hook: its turn is done.
fn from_codex_hook(payload: &Value) -> Option<Event> {
    let text = |key: &str| payload[key].as_str().unwrap_or_default();
    if text("hook_event_name") != "Stop" {
        return None;
    }
    let session = [text("session_id"), text("turn_id")]
        .into_iter()
        .find(|id| !id.is_empty())
        .unwrap_or_default();
    event(
        "codex",
        "done",
        text("cwd"),
        first_line(text("last_assistant_message")),
        session,
    )
}

/// Never starts isled: when it is not running there is no island to tell.
async fn send(event: &Event) -> zbus::Result<()> {
    let bus = zbus::Connection::session().await?;
    let proxy: zbus::Proxy = zbus::proxy::Builder::new(&bus)
        .destination(crate::BUS_NAME)?
        .path(crate::OBJECT_PATH)?
        .interface("io.github.zickrian.isle.Agents1")?
        .cache_properties(CacheProperties::No)
        .build()
        .await?;
    let json = serde_json::to_string(event).unwrap_or_default();
    proxy
        .call_with_flags::<_, _, ()>("Report", MethodFlags::NoAutoStart.into(), &(json,))
        .await?;
    Ok(())
}

/// Claude Code's `Notification` (needs a permission, or waits for the user) and `Stop` (done).
fn from_claude(payload: &Value) -> Option<Event> {
    let text = |key: &str| payload[key].as_str().unwrap_or_default();
    let (kind, message) = match text("hook_event_name") {
        "Notification" => {
            // A permission too: the island skips it when it asked for that session already (see
            // `decide`), and shows it when it could not (a long command, too many waiting).
            let kind = notification_kind(text("notification_type"), text("message"))?;
            (kind, text("message"))
        }
        "Stop" => ("done", first_line(text("last_assistant_message"))),
        _ => return None,
    };
    event("claude", kind, text("cwd"), message, text("session_id"))
}

fn notification_kind(kind: &str, message: &str) -> Option<&'static str> {
    match kind {
        "permission_prompt" => Some("permission"),
        "idle_prompt" | "elicitation_dialog" => Some("waiting"),
        // Signed in again: nothing to do.
        "auth_success" => None,
        // Older Claude Codes send only the message.
        _ if message.to_lowercase().contains("permission") => Some("permission"),
        _ => Some("waiting"),
    }
}

/// Codex's `agent-turn-complete`.
fn from_codex(payload: &Value) -> Option<Event> {
    let text = |key: &str| payload[key].as_str().unwrap_or_default();
    if text("type") != "agent-turn-complete" {
        return None;
    }
    let session = [text("thread-id"), text("turn-id")]
        .into_iter()
        .find(|id| !id.is_empty())
        .unwrap_or_default();
    let message = first_line(text("last-assistant-message"));
    event("codex", "done", text("cwd"), message, session)
}

fn first_line(text: &str) -> &str {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
}

/// The folder the AI works in: the payload's, else the hook's own (the AI starts it there).
fn event(provider: &str, kind: &str, cwd: &str, message: &str, session: &str) -> Option<Event> {
    let cwd = if cwd.is_empty() {
        std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        cwd.to_owned()
    };
    let project = Path::new(&cwd)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Event {
        provider: provider.into(),
        kind: kind.into(),
        project,
        cwd,
        message: message.into(),
        session: session.into(),
        pids: ancestors(),
    }
    .checked()
    .ok()
}

/// This hook's parent processes, nearest first, up to init: the AI, its shell, and the terminal or
/// editor whose window it runs in.
#[cfg(unix)]
fn ancestors() -> Vec<u32> {
    let mut pids = Vec::new();
    let mut pid = std::os::unix::process::parent_id();
    while pid > 1 && pids.len() < 32 {
        pids.push(pid);
        let Some(parent) = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|stat| parent_of(&stat))
        else {
            break;
        };
        pid = parent;
    }
    pids
}

#[cfg(not(unix))]
fn ancestors() -> Vec<u32> {
    Vec::new()
}

/// The parent's pid in a /proc/<pid>/stat line; the command name in brackets may hold spaces or ')'.
#[cfg(any(unix, test))]
fn parent_of(stat: &str) -> Option<u32> {
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn shows_a_tools_input_readably() {
        let input = json!({"owner": "zickrian", "repo": "isle", "draft": false});
        assert_eq!(
            readable(&input),
            "owner: zickrian, repo: isle, draft: false"
        );
        assert_eq!(readable(&Value::Null), "");
    }

    #[test]
    fn reads_the_parent_from_a_stat_line() {
        assert_eq!(parent_of("1234 (bash) S 1200 1234 1234 0"), Some(1200));
        // A name with spaces and a closing bracket of its own.
        assert_eq!(parent_of("77 (Web Content) x) S 42 77 77 0"), Some(42));
        assert_eq!(parent_of("garbage"), None);
    }

    #[test]
    #[cfg(unix)]
    fn finds_its_parents() {
        let pids = ancestors();
        assert_eq!(pids.first(), Some(&std::os::unix::process::parent_id()));
        assert!(pids.iter().all(|&pid| pid > 1));
    }

    use super::*;

    #[test]
    fn sees_an_answer_given_in_the_terminal() {
        let path =
            std::env::temp_dir().join(format!("isle-transcript-{}.jsonl", std::process::id()));
        let input = json!({"command": "npm test", "description": "Run the tests"});
        let call = json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "toolu_older", "name": "Bash", "input": {"command": "ls"}},
            {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": input}]}});
        std::fs::write(
            &path,
            format!("{{\"type\":\"user\",\"note\":\"é\"}}\n{call}\n{{\"partial"),
        )
        .unwrap();
        let (id, mut read) = find_call(&path, &json!("Bash"), &input).unwrap();
        assert_eq!(id, "toolu_1");
        // Another call's result is not this one's; this one's is.
        let other = json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_older"}]}});
        let mine = json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_1"}]}});
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        std::io::Write::write_all(&mut file, format!("\"}}\n{other}\n").as_bytes()).unwrap();
        assert!(!has_result(&read_on(&path, &mut read).unwrap(), &id));
        std::io::Write::write_all(&mut file, format!("{mine}\n").as_bytes()).unwrap();
        assert!(has_result(&read_on(&path, &mut read).unwrap(), &id));
        assert!(read_on(&path, &mut read).is_none());
        assert!(find_call(&path, &json!("Bash"), &json!({"command": "rm -rf /"})).is_none());
        // The same command again: until its own call is written, the old one (answered) is not taken.
        assert!(pending_call(&path, &json!("Bash"), &input).is_none());
        let again = json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "toolu_2", "name": "Bash", "input": input}]}});
        std::io::Write::write_all(&mut file, format!("{again}\n").as_bytes()).unwrap();
        assert_eq!(
            pending_call(&path, &json!("Bash"), &input).unwrap().0,
            "toolu_2"
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn claude_permission_and_waiting() {
        let permission = from_claude(&json!({
            "session_id": "8a7c",
            "transcript_path": "/home/a/.claude/projects/x.jsonl",
            "cwd": "/home/a/code/isle",
            "hook_event_name": "Notification",
            "message": "Claude needs your permission to use Bash"
        }));
        // Sent on: the island shows it only if it could not ask through PermissionRequest.
        assert_eq!(permission.unwrap().kind, "permission");
        let waiting = from_claude(&json!({
            "cwd": "/home/a/code/isle",
            "hook_event_name": "Notification",
            "message": "Claude is waiting for your input"
        }))
        .unwrap();
        assert_eq!(waiting.kind, "waiting");
        let typed = from_claude(&json!({
            "cwd": "/w",
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt",
            "message": "Claude needs your approval"
        }));
        assert_eq!(typed.unwrap().kind, "permission");
        assert!(
            from_claude(
                &json!({"hook_event_name": "Notification", "notification_type": "auth_success"})
            )
            .is_none()
        );
    }

    #[test]
    fn claude_stopping_is_done() {
        let done = from_claude(&json!({
            "session_id": "8a7c",
            "cwd": "/home/a/code/isle",
            "hook_event_name": "Stop",
            "stop_hook_active": false
        }))
        .unwrap();
        assert_eq!((done.kind.as_str(), done.message.as_str()), ("done", ""));
        let summed_up = from_claude(&json!({
            "cwd": "/home/a/code/isle",
            "hook_event_name": "Stop",
            "last_assistant_message": "\nFixed the build.\n\nDetails follow…"
        }))
        .unwrap();
        assert_eq!(summed_up.message, "Fixed the build.");
        assert!(from_claude(&json!({"hook_event_name": "PreToolUse"})).is_none());
        assert!(from_claude(&json!([1, 2])).is_none());
    }

    #[test]
    fn a_permission_is_asked_and_answered_as_each_ai_wants() {
        let claude = json!({
            "hook_event_name": "PermissionRequest", "session_id": "s1", "cwd": "/home/a/korus",
            "tool_name": "Bash", "tool_input": {"command": "git push origin main", "description": "Push"},
            "permission_suggestions": [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "git push:*"}],
                "behavior": "allow", "destination": "localSettings"}]
        });
        // What the island could not show whole asks in the terminal.
        let mut hidden = claude.clone();
        hidden["tool_input"]["command"] = json!("echo ok\nrm -rf ~");
        assert!(request("claude", &hidden).is_none());
        hidden["tool_input"]["command"] = json!("x".repeat(MAX_SHOWN + 1));
        assert!(request("claude", &hidden).is_none());
        let asked = request("claude", &claude).unwrap();
        assert_eq!(
            (asked.tool.as_str(), asked.input.as_str(), asked.always),
            ("Bash", "git push origin main", true)
        );
        let allow: Value =
            serde_json::from_str(&decision("claude", "allow", &claude).unwrap()).unwrap();
        assert_eq!(
            allow["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(
            allow["hookSpecificOutput"]["decision"],
            json!({"behavior": "allow"})
        );
        let always: Value =
            serde_json::from_str(&decision("claude", "always", &claude).unwrap()).unwrap();
        assert_eq!(
            always["hookSpecificOutput"]["decision"]["updatedPermissions"],
            claude["permission_suggestions"]
        );
        // A suggested change of mode is never kept by Always, nor offers it alone.
        let mut moded = claude.clone();
        moded["permission_suggestions"]
            .as_array_mut()
            .unwrap()
            .push(
                json!({"type": "setMode", "mode": "bypassPermissions", "destination": "session"}),
            );
        let always: Value =
            serde_json::from_str(&decision("claude", "always", &moded).unwrap()).unwrap();
        assert_eq!(
            always["hookSpecificOutput"]["decision"]["updatedPermissions"],
            claude["permission_suggestions"]
        );
        moded["permission_suggestions"] = json!([{"type": "setMode", "mode": "acceptEdits"}]);
        assert!(!request("claude", &moded).unwrap().always);
        let deny: Value =
            serde_json::from_str(&decision("codex", "deny", &claude).unwrap()).unwrap();
        assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
        // No answer: nothing printed, the AI asks in its terminal.
        assert!(decision("claude", "", &claude).is_none());
        let edit = json!({"hook_event_name": "PermissionRequest", "tool_name": "apply_patch",
            "tool_input": {"command": "*** Begin Patch"}, "cwd": "/w"});
        let asked = request("codex", &edit).unwrap();
        assert!(!asked.always && asked.input == "*** Begin Patch");
        assert!(request("agy", &edit).is_none());
    }

    #[test]
    fn codex_stop_hook_is_done() {
        let done = from_codex_hook(
            &json!({"hook_event_name": "Stop", "session_id": "t1", "cwd": "/home/a/site",
            "last_assistant_message": "All tests pass.\nMore."}),
        )
        .unwrap();
        assert_eq!(
            (
                done.kind.as_str(),
                done.message.as_str(),
                done.project.as_str()
            ),
            ("done", "All tests pass.", "site")
        );
    }

    #[test]
    fn codex_turns_are_done() {
        let done = from_codex(&json!({
            "type": "agent-turn-complete",
            "thread-id": "0199a",
            "turn-id": "12",
            "cwd": "/home/a/code/site",
            "input-messages": ["fix the header"],
            "last-assistant-message": "  Fixed the header's height.  \nAlso tidied the CSS."
        }))
        .unwrap();
        assert_eq!(
            done,
            Event {
                provider: "codex".into(),
                kind: "done".into(),
                project: "site".into(),
                cwd: "/home/a/code/site".into(),
                message: "Fixed the header's height.".into(),
                session: "0199a".into(),
                // Where the hook runs: so its window is told from others that name the project.
                pids: ancestors(),
            }
        );
        let turn_only =
            from_codex(&json!({"type": "agent-turn-complete", "turn-id": "12", "cwd": "/w"}));
        assert_eq!(turn_only.unwrap().session, "12");
        assert!(from_codex(&json!({"type": "something-else"})).is_none());
    }
}
