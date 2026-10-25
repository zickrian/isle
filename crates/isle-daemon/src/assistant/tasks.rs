// SPDX-License-Identifier: GPL-3.0-or-later

//! Commands the AI asks to run (installing an app, say), once the user pressed Run: each is a systemd unit
//! of its own (the user's, or the system's when it needs root), so it carries on whatever happens to the
//! island, the screen lock or isled. GNOME Shell starts it (so the password dialog, if any, is GNOME's own);
//! isled watches its log until it ends, and finds it again after a restart.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::chat::mask_secrets;
use super::check::tail;
use crate::store::{Store, create_private_dir, write_private};

/// A command runs this long at most; then systemd stops it.
pub const MAX_RUN: Duration = Duration::from_secs(30 * 60);
/// How often its log is read while it runs.
const POLL: Duration = Duration::from_millis(400);
/// How often isled asks systemd whether it still runs (a stop, a crash, a logout end it without a word).
const ALIVE_EVERY: u32 = 5;
/// What the AI and the island get of the output, at most.
const MAX_OUTPUT: usize = 4000;
/// The line the wrapper prints last, with the exit code: `\n[isle-exit 0]`.
const EXIT_MARK: &str = "[isle-exit ";
/// Runs the command (in a subshell, so an `exit` in it ends only that), then says how it ended; a
/// command stopped or cut short says nothing.
const WRAPPER: &str = "( eval \"$1\" ); printf '\\n[isle-exit %d]\\n' \"$?\"";
/// As root, the same, its output written by the user ($2, $3) rather than root, so the log in their home
/// can never be made to point root at a file of the system.
const ROOT_WRAPPER: &str = "{ ( eval \"$1\" ); printf '\\n[isle-exit %d]\\n' \"$?\"; } 2>&1 | \
    chroot --userspec=\"$2:$3\" / tee -a -- \"$4\" >/dev/null";

/// Who runs it: the user, or root (the system, after GNOME's password dialog).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    User,
    System,
}

/// A command started, as kept in tasks.json until it ended and was told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub command: String,
    pub why: String,
    pub scope: Scope,
    pub log: PathBuf,
    /// Milliseconds since 1970.
    pub started: i64,
}

fn current_uid_gid() -> (u32, u32) {
    #[cfg(unix)]
    unsafe {
        (libc::getuid(), libc::getgid())
    }
    #[cfg(not(unix))]
    {
        (1000, 1000)
    }
}

impl Task {
    pub fn unit(&self) -> String {
        format!("isle-run-{}", self.id)
    }

    /// What GNOME Shell runs to start it: `systemd-run` with its log, limits and environment.
    pub fn spawn(&self) -> Vec<String> {
        let mut argv = vec!["systemd-run".to_owned()];
        if self.scope == Scope::User {
            argv.push("--user".into());
        }
        let log = self.log.display();
        argv.extend([
            format!("--unit={}", self.unit()),
            "--collect".into(),
            "--quiet".into(),
        ]);
        if self.scope == Scope::User {
            argv.extend([
                format!("--property=StandardOutput=append:{log}"),
                format!("--property=StandardError=append:{log}"),
            ]);
        }
        argv.extend([
            format!("--property=RuntimeMaxSec={}", MAX_RUN.as_secs()),
            "--setenv=DEBIAN_FRONTEND=noninteractive".into(),
            "--setenv=LANG=C.UTF-8".into(),
            format!("--setenv=PATH={}", path(self.scope)),
        ]);
        if self.scope == Scope::User
            && let Some(home) = dirs::home_dir()
        {
            argv.push(format!("--working-directory={}", home.display()));
        }
        let wrapper = match self.scope {
            Scope::User => WRAPPER,
            Scope::System => ROOT_WRAPPER,
        };
        argv.extend([
            "--".into(),
            "bash".into(),
            "-c".into(),
            wrapper.into(),
            "isle".into(),
        ]);
        argv.push(self.command.clone());
        if self.scope == Scope::System {
            let (uid, gid) = current_uid_gid();
            argv.extend([uid.to_string(), gid.to_string(), log.to_string()]);
        }
        argv
    }

    /// What GNOME Shell runs to stop it.
    pub fn stop(&self) -> Vec<String> {
        let mut argv = vec!["systemctl".to_owned()];
        if self.scope == Scope::User {
            argv.push("--user".into());
        }
        argv.extend(["stop".into(), self.unit()]);
        argv
    }
}

/// The PATH a command gets: the system's, and for the user's own commands where their programs live
/// (npm, nvm, pipx, cargo, Homebrew…); never as root, so a program the user can write cannot stand in
/// for `apt`.
fn path(scope: Scope) -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let mut dirs: Vec<String> = Vec::new();
    if scope == Scope::User {
        let own = USER_PATH.iter().map(|dir| home.join(dir));
        for dir in own.chain(super::install_dirs(&home)) {
            let dir = dir.display().to_string();
            if Path::new(&dir).is_dir()
                && !dirs.contains(&dir)
                && !SYSTEM_PATH.contains(&dir.as_str())
            {
                dirs.push(dir);
            }
        }
    }
    dirs.extend(SYSTEM_PATH.iter().map(|dir| (*dir).to_owned()));
    dirs.join(":")
}

const USER_PATH: &[&str] = &[".local/bin", ".npm-global/bin", ".cargo/bin"];
const SYSTEM_PATH: &[&str] = &[
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
    "/snap/bin",
];

/// How a command ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    Exited(i32),
    /// Stopped (Stop, the time limit) or cut short (a logout, a crash) before it could say.
    Stopped,
}

/// What a command reports as it runs: its output so far (the end of it, secrets hidden), how long, and
/// once over how it ended.
#[derive(Debug, Clone)]
pub struct Progress {
    pub output: String,
    pub seconds: f64,
    pub ended: Option<Ended>,
}

/// Where logs go: Isle's cache, which outlives a logout, so a command run as root that carried on
/// meanwhile is still told right at the next login. Each is deleted once told.
fn logs() -> PathBuf {
    crate::store::cache_dir().join("runs")
}

/// The longest command a card offers; it shows whole on a few lines.
pub const MAX_COMMAND: usize = 400;

/// Whether `text` shows as it is, whole, on one line of at most `max` characters: no line breaks,
/// control characters, or characters that hide or reorder text (bidi controls, zero-width ones).
pub fn shows_whole(text: &str, max: usize) -> bool {
    let hidden = |c: char| {
        c.is_control()
            || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}'
                | '\u{061C}' | '\u{FEFF}' | '\u{00AD}')
    };
    text.chars().count() <= max && !text.chars().any(hidden)
}

/// A new task for `command`, its log made ready (private to the user, who alone writes to it).
pub fn prepare(command: &str, why: &str, scope: Scope) -> std::io::Result<Task> {
    // The time, and a count: two in the same millisecond still differ.
    static COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let count = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!("{:x}-{count}", super::chat::now_ms());
    let dir = logs();
    create_private_dir(&dir)?;
    let log = dir.join(format!("run-{id}.log"));
    write_private(&log, b"")?;
    Ok(Task {
        id,
        command: command.to_owned(),
        why: why.to_owned(),
        scope,
        log,
        started: super::chat::now_ms(),
    })
}

/// Follows `task` until it ends, sending its progress as it goes; returns how it ended and its output.
pub async fn follow(task: &Task, progress: impl Fn(Progress)) -> (Ended, String) {
    let started = std::time::Instant::now();
    let mut output = String::new();
    let mut read = 0u64;
    let mut rounds = 0u32;
    loop {
        if let Ok(text) = read_from(&task.log, &mut read).await
            && !text.is_empty()
        {
            output.push_str(&text);
            // Only the end is kept: a long install prints megabytes.
            if output.len() > 4 * MAX_OUTPUT {
                output = tail(&output, 2 * MAX_OUTPUT);
            }
        }
        if let Some(code) = exit_code(&output) {
            let shown = shown(&output);
            progress(Progress {
                output: shown.clone(),
                seconds: started.elapsed().as_secs_f64(),
                ended: Some(Ended::Exited(code)),
            });
            return (Ended::Exited(code), shown);
        }
        rounds += 1;
        // Gone without a word: stopped, or cut short. Its last lines may still be on their way.
        if rounds.is_multiple_of(ALIVE_EVERY) && !running(task).await {
            tokio::time::sleep(POLL).await;
            if let Ok(text) = read_from(&task.log, &mut read).await {
                output.push_str(&text);
            }
            let shown = shown(&output);
            let ended = exit_code(&output).map_or(Ended::Stopped, Ended::Exited);
            progress(Progress {
                output: shown.clone(),
                seconds: started.elapsed().as_secs_f64(),
                ended: Some(ended.clone()),
            });
            return (ended, shown);
        }
        progress(Progress {
            output: shown(&output),
            // Whole seconds, as the card shows them: a round with no new output then changes nothing.
            seconds: started.elapsed().as_secs() as f64,
            ended: None,
        });
        tokio::time::sleep(POLL).await;
    }
}

/// The output as shown: without the wrapper's last line, the end of it, secrets hidden.
fn shown(output: &str) -> String {
    let body = match output.rfind(EXIT_MARK) {
        Some(at) => &output[..at],
        None => output,
    };
    tail(&mask_secrets(body), MAX_OUTPUT)
}

fn exit_code(output: &str) -> Option<i32> {
    let at = output.rfind(EXIT_MARK)?;
    output[at + EXIT_MARK.len()..]
        .split(']')
        .next()?
        .trim()
        .parse()
        .ok()
}

async fn read_from(path: &Path, offset: &mut u64) -> std::io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(*offset)).await?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await?;
    *offset += bytes.len() as u64;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Whether systemd still runs the task's unit.
async fn running(task: &Task) -> bool {
    let mut command = tokio::process::Command::new("systemctl");
    if task.scope == Scope::User {
        command.arg("--user");
    }
    command.args(["is-active", "--quiet", &task.unit()]);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // systemctl missing (no systemd): the log alone says when it is over.
    command
        .status()
        .await
        .map_or(true, |status| status.success())
}

/// Tasks started and not yet told, kept so isled finds them again after a restart.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Running {
    pub tasks: Vec<Task>,
}

pub fn store() -> Store<Running> {
    // Tests (the eval among them) keep their own: never a task the user's isled then finds.
    Store::new(if cfg!(test) { "tasks-test" } else { "tasks" })
}

/// Keeps a started task in tasks.json, so isled finds it again after a restart (see `mod.rs`).
pub fn remember(task: &Task) {
    remember_in(&mut store(), task);
}

/// Takes a task out of tasks.json once it has been told.
pub fn forget(task: &Task) {
    forget_in(&mut store(), task);
}

// Written at once: each call has its own store, and a quick command's forget must find its remember.
fn remember_in(store: &mut Store<Running>, task: &Task) {
    let mut running = store.load();
    running.tasks.retain(|t| t.id != task.id);
    running.tasks.push(task.clone());
    store.save_now(&running);
}

fn forget_in(store: &mut Store<Running>, task: &Task) {
    let mut running = store.load();
    running.tasks.retain(|t| t.id != task.id);
    // None left: no file at all.
    if running.tasks.is_empty() {
        store.remove();
    } else {
        store.save_now(&running);
    }
}

/// What became of a task while isled was not watching: how it ended and its output, or `None` if it
/// still runs (then it is followed again).
pub async fn settled(task: &Task) -> Option<(Ended, String)> {
    let mut read = 0;
    let output = read_from(&task.log, &mut read).await.unwrap_or_default();
    if let Some(code) = exit_code(&output) {
        return Some((Ended::Exited(code), shown(&output)));
    }
    if running(task).await {
        return None;
    }
    Some((Ended::Stopped, shown(&output)))
}

/// Deletes a task's log once it has been told.
/// Whether `task` (as read back from tasks.json) is one Isle made: its log in Isle's folder, its id plain.
pub fn is_own(task: &Task) -> bool {
    task.log.parent() == Some(logs().as_path())
        && task.log.file_name() == Some(std::ffi::OsStr::new(&format!("run-{}.log", task.id)))
        && !task.id.is_empty()
        && task
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn clean(task: &Task) {
    std::fs::remove_file(&task.log).ok();
}

/// What a command may do that the user should know before running it, most telling first: removing
/// things, running a script from the web, needing the password.
pub fn risks(command: &str, root: bool) -> Vec<&'static str> {
    let lower = command.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| c.is_whitespace() || c == ';' || c == '&' || c == '|')
        .filter(|w| !w.is_empty())
        .collect();
    let has = |w: &str| words.contains(&w);
    let mut risks = Vec::new();
    let removes = has("rm")
        || has("rmdir")
        || has("purge")
        || has("autoremove")
        || has("uninstall")
        || (has("remove")
            && (has("apt")
                || has("apt-get")
                || has("dnf")
                || has("snap")
                || has("zypper")
                || has("flatpak")))
        || words.iter().any(|w| w.starts_with("-r") && has("pacman"));
    if removes {
        risks.push("removes");
    }
    let fetches = has("curl") || has("wget");
    let runs = lower.contains("| sh")
        || lower.contains("| bash")
        || lower.contains("|sh")
        || lower.contains("|bash")
        || lower.contains("bash <(")
        || lower.contains("sh <(")
        || lower.contains("bash -c \"$(")
        || lower.contains("sh -c \"$(");
    if fetches && runs {
        risks.push("internet");
    }
    if root {
        risks.push("root");
    }
    risks
}

/// Why `command` will not even be offered: it could wreck the system or the user's files.
pub fn refused(command: &str) -> Option<&'static str> {
    let lower = command.to_lowercase();
    // Each command of a line on its own (`a && b; c | d`), without a sudo in front.
    for part in lower.split(['&', ';', '|', '\n']) {
        let words: Vec<&str> = part
            .split_whitespace()
            .skip_while(|w| matches!(*w, "sudo" | "pkexec" | "-e"))
            .collect();
        let Some((program, args)) = words.split_first() else {
            continue;
        };
        let flags: String = args
            .iter()
            .filter(|a| a.starts_with('-') && !a.starts_with("--"))
            .flat_map(|a| a.chars())
            .collect();
        let targets: Vec<&&str> = args.iter().filter(|a| !a.starts_with('-')).collect();
        let everything = |t: &&&str| {
            matches!(
                **t,
                "/" | "/*"
                    | "~"
                    | "~/"
                    | "~/*"
                    | "$home"
                    | "$home/"
                    | "$home/*"
                    | "/home"
                    | "/home/*"
                    | "/usr"
                    | "/etc"
                    | "/boot"
            )
        };
        if *program == "rm"
            && flags.contains('r')
            && (targets.iter().any(everything) || args.contains(&"--no-preserve-root"))
        {
            return Some("it would delete the whole system or home folder");
        }
        if program.starts_with("mkfs") || program.starts_with("wipefs") {
            return Some("it would erase a disk");
        }
        if *program == "dd" && args.iter().any(|a| a.starts_with("of=/dev/")) {
            return Some("it would erase a disk");
        }
        if matches!(*program, "chmod" | "chown")
            && flags.contains('r')
            && targets
                .iter()
                .any(|t| matches!(**t, "/" | "/usr" | "/etc" | "/bin"))
        {
            return Some("it would break the system's permissions");
        }
    }
    if lower.contains(":(){") || lower.contains(":() {") {
        return Some("it would freeze the computer");
    }
    if lower.contains("> /dev/sd")
        || lower.contains(">/dev/sd")
        || lower.contains("> /dev/nvme")
        || lower.contains(">/dev/nvme")
    {
        return Some("it would erase a disk");
    }
    None
}

/// `command` as the AI may write it, with `sudo` (or pkexec) before its commands: the command without them,
/// and whether it needs root (then the whole line runs as root). Only a sudo where a command starts counts,
/// outside quotes (`grep sudo log` keeps its word); one with options but -E (`sudo -u postgres …`) asks for
/// what Isle can't do: Err with why.
pub fn without_sudo(command: &str, root: bool) -> Result<(String, bool), &'static str> {
    let chars: Vec<char> = command.trim().chars().collect();
    let word_at = |i: usize| -> String {
        chars[i..]
            .iter()
            .take_while(|c| !c.is_whitespace())
            .collect()
    };
    let mut out = String::with_capacity(chars.len());
    let mut needs_root = root;
    let (mut single, mut double, mut escaped, mut starts) = (false, false, false, true);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if starts && !single && !double && !c.is_whitespace() {
            let word = word_at(i);
            if word == "sudo" || word == "pkexec" {
                needs_root = true;
                i += word.chars().count();
                // Its own options: -E (keep the environment) is harmless here; any other is refused.
                loop {
                    while i < chars.len() && chars[i].is_whitespace() {
                        i += 1;
                    }
                    if i >= chars.len() || !chars[i].eq(&'-') {
                        break;
                    }
                    let option = word_at(i);
                    if !matches!(option.as_str(), "-E" | "--preserve-env") {
                        return Err(
                            "sudo with options (another user, a login shell) can't run from Isle",
                        );
                    }
                    i += option.chars().count();
                }
                continue;
            }
            starts = false;
        }
        if escaped {
            escaped = false;
        } else if c == '\\' && !single {
            escaped = true;
        } else if c == '\'' && !double {
            single = !single;
        } else if c == '"' && !single {
            double = !double;
        } else if !single && !double && matches!(c, ';' | '|' | '&' | '(' | '\n') {
            starts = true;
        }
        out.push(c);
        i += 1;
    }
    Ok((out.trim().to_owned(), needs_root))
}

/// The card the island shows for a task: JSON for the extension.
pub fn card(
    task: &Task,
    detail: &str,
    risks: &[&str],
    status: &str,
    progress: Option<&Progress>,
) -> Value {
    let (output, seconds, exit) = match progress {
        Some(p) => (
            p.output.as_str(),
            p.seconds,
            match p.ended {
                Some(Ended::Exited(code)) => Some(code),
                _ => None,
            },
        ),
        None => ("", 0.0, None),
    };
    json!({
        "id": task.id,
        "command": if task.scope == Scope::System { format!("sudo {}", task.command) } else { task.command.clone() },
        "why": task.why,
        "detail": detail,
        "risks": risks,
        "status": status,
        "output": output,
        "seconds": seconds,
        "exit": exit,
        "stop": task.stop(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_task_forgotten_right_after_it_started_stays_forgotten() {
        let dir = std::env::temp_dir().join(format!("isle-tasks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tasks.json");
        let task = |id: &str| Task {
            id: id.into(),
            command: "true".into(),
            why: "Test".into(),
            scope: Scope::User,
            log: dir.join(format!("run-{id}.log")),
            started: 0,
        };
        remember_in(&mut Store::at(path.clone()), &task("a"));
        remember_in(&mut Store::at(path.clone()), &task("b"));
        forget_in(&mut Store::at(path.clone()), &task("a"));
        forget_in(&mut Store::at(path.clone()), &task("b"));
        // No write still on its way puts a told task back.
        crate::store::flush();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn only_commands_shown_whole_are_offered() {
        assert!(shows_whole("sudo apt install -y vlc", MAX_COMMAND));
        assert!(!shows_whole("echo ok\nrm -rf ~", MAX_COMMAND));
        assert!(!shows_whole("ls \u{202E}fdp.exe", MAX_COMMAND));
        assert!(!shows_whole("ls\u{200B}", MAX_COMMAND));
        assert!(!shows_whole(&"a".repeat(MAX_COMMAND + 1), MAX_COMMAND));
    }

    #[test]
    fn sees_what_a_command_may_do() {
        assert_eq!(risks("apt install -y libreoffice", true), ["root"]);
        assert_eq!(
            risks("curl -fsSL https://ollama.com/install.sh | sh", false),
            ["internet"]
        );
        assert_eq!(
            risks("apt purge -y libreoffice*", true),
            ["removes", "root"]
        );
        assert_eq!(risks("rm -rf ~/Downloads/old", false), ["removes"]);
        assert!(risks("npm install -g @openai/codex", false).is_empty());
        assert!(risks("curl -o x.deb https://example.com/x.deb", false).is_empty());
    }

    #[test]
    fn refuses_what_would_wreck_the_system() {
        for bad in [
            "rm -rf /",
            "sudo rm -rf / --no-preserve-root",
            "rm -rf ~",
            "rm -rf ~/*",
            "mkfs.ext4 /dev/sda1",
            "dd if=/dev/zero of=/dev/sda",
            ":(){ :|:& };:",
            "rm  -rf   /",
        ] {
            assert!(refused(bad).is_some(), "{bad} was offered");
        }
        for fine in [
            "rm -rf ~/Downloads/old",
            "rm -rf /tmp/isle-test",
            "apt install -y vlc",
            "dd if=a.iso of=b.img",
        ] {
            assert!(refused(fine).is_none(), "{fine} was refused");
        }
    }

    #[test]
    fn takes_sudo_off_and_runs_as_root() {
        let ok = |command: &str, root| without_sudo(command, root).unwrap();
        assert_eq!(
            ok("sudo apt install -y vlc", false),
            ("apt install -y vlc".into(), true)
        );
        assert_eq!(
            ok("apt update && sudo apt install -y vlc", false),
            ("apt update && apt install -y vlc".into(), true)
        );
        assert_eq!(
            ok("sudo -E apt upgrade", false),
            ("apt upgrade".into(), true)
        );
        assert_eq!(
            ok("pkexec systemctl restart x", false),
            ("systemctl restart x".into(), true)
        );
        assert_eq!(ok("npm i -g x", false), ("npm i -g x".into(), false));
        assert_eq!(ok("apt install x", true), ("apt install x".into(), true));
        // Only where a command starts, and not in quotes: its word stays.
        assert_eq!(
            ok("grep sudo /var/log/auth.log", false),
            ("grep sudo /var/log/auth.log".into(), false)
        );
        assert_eq!(
            ok("cd x && sudo usermod -aG sudo kz", false),
            ("cd x && usermod -aG sudo kz".into(), true)
        );
        assert_eq!(ok("visudo -c", false), ("visudo -c".into(), false));
        assert_eq!(
            ok("echo 'a; sudo b'", false),
            ("echo 'a; sudo b'".into(), false)
        );
        assert_eq!(
            ok("echo pseudo code", false),
            ("echo pseudo code".into(), false)
        );
        // Run as someone else, or a login shell: not something Isle can do.
        assert!(without_sudo("sudo -u postgres createdb x", false).is_err());
        assert!(without_sudo("sudo -i", false).is_err());
    }

    #[test]
    fn reads_how_it_ended() {
        assert_eq!(exit_code("Setting up vlc ...\n\n[isle-exit 0]\n"), Some(0));
        assert_eq!(
            exit_code("E: Unable to locate package x\n\n[isle-exit 100]\n"),
            Some(100)
        );
        assert_eq!(exit_code("still going"), None);
        assert_eq!(shown("a\nb\n\n[isle-exit 0]\n"), "a\nb");
    }

    #[test]
    fn wraps_commands_as_the_extension_expects() {
        // actionRules.js checks a command starts with exactly these.
        let rules = include_str!("../../../../gnome-extension/src/actionRules.js");
        let js = WRAPPER.replace('\\', "\\\\").replace('\'', "\\'");
        assert!(rules.contains(&format!("RUN_WRAPPER = '{js}';")), "{js}");
        let tail = ROOT_WRAPPER
            .strip_prefix(&format!("{{ {WRAPPER}; }}"))
            .unwrap();
        assert!(rules.contains(&format!("ROOT_WRAPPER = `{{ ${{RUN_WRAPPER}}; }}{tail}`;")));
    }

    #[test]
    fn starts_and_stops_through_systemd() {
        let task = Task {
            id: "abc".into(),
            command: "apt install -y vlc".into(),
            why: "Install VLC".into(),
            scope: Scope::System,
            log: PathBuf::from("/run/user/1000/isle/run-abc.log"),
            started: 0,
        };
        let argv = task.spawn();
        assert_eq!(argv[0], "systemd-run");
        assert!(
            !argv.contains(&"--user".to_owned())
                && argv.contains(&"--unit=isle-run-abc".to_owned())
        );
        // Root opens no file of the user's: its output goes to them through `tee`, run as them.
        assert!(!argv.iter().any(|arg| arg.contains("append:")));
        let (uid, gid) = current_uid_gid();
        assert_eq!(
            &argv[argv.len() - 8..],
            [
                "bash",
                "-c",
                ROOT_WRAPPER,
                "isle",
                "apt install -y vlc",
                &uid.to_string(),
                &gid.to_string(),
                "/run/user/1000/isle/run-abc.log"
            ]
        );
        assert_eq!(task.stop(), ["systemctl", "stop", "isle-run-abc"]);
        let user = Task {
            scope: Scope::User,
            ..task.clone()
        };
        let argv = user.spawn();
        assert!(argv.contains(
            &"--property=StandardOutput=append:/run/user/1000/isle/run-abc.log".to_owned()
        ));
        assert_eq!(
            &argv[argv.len() - 5..],
            ["bash", "-c", WRAPPER, "isle", "apt install -y vlc"]
        );
        assert!(argv.contains(&"--user".to_owned()) && user.stop()[1] == "--user");
        // Root never looks in the user's folders for its programs.
        let paths = |task: &Task| {
            task.spawn()
                .into_iter()
                .find(|arg| arg.starts_with("--setenv=PATH="))
                .unwrap()
        };
        assert!(
            paths(&task).ends_with(
                "=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
            )
        );
        // The user's own folders that are there come first (none, maybe, where the tests run).
        assert!(
            paths(&user).ends_with(
                ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
            ) || paths(&user).ends_with(
                "=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
            )
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn follows_a_command_to_its_end() {
        // As systemd would, with the wrapper: the log fills, then the exit line. "two" comes well after a
        // poll (POLL), even on a slow CI runner, so "one" is seen on its own first.
        let task = prepare("echo hi", "Say hi", Scope::User).unwrap();
        let log = task.log.clone();
        let wrapper = format!("{{ {WRAPPER}; }} >> {} 2>&1", log.display());
        let mut child = tokio::process::Command::new("bash")
            .args([
                "-c",
                &wrapper,
                "isle",
                "echo one; sleep 2; echo two; exit 3",
            ])
            .spawn()
            .unwrap();
        let seen = std::sync::Mutex::new(Vec::new());
        let (ended, output) = follow(&task, |p| seen.lock().unwrap().push(p.output)).await;
        child.wait().await.unwrap();
        assert_eq!(ended, Ended::Exited(3));
        assert_eq!(output, "one\ntwo");
        assert!(seen.lock().unwrap().iter().any(|o| o == "one"));
        clean(&task);
        assert!(!log.exists());
    }
}
