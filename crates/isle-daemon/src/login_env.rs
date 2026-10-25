// SPDX-License-Identifier: GPL-3.0-or-later

//! What the user's login shell sets that isled lacks, started by systemd from the desktop session: where
//! their programs are (nvm, Homebrew, a custom npm prefix…), and what their AI CLIs read (another config
//! folder, an API key, a proxy). Asked once at start, as code editors do; what systemd already sets wins.

#[cfg(not(unix))]
pub fn import() {}

#[cfg(unix)]
pub use unix::import;

#[cfg(unix)]
mod unix {
    use std::ffi::OsString;
    use std::io::Read;
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};


/// A shell slower than this (a prompt, a network mount) is left behind.
const TIMEOUT: Duration = Duration::from_secs(3);
/// What comes before the environment, so whatever the startup files print is skipped.
const MARK: &str = "ISLE-ENV-1f2e";

/// Variables taken over, by name or by the start of it.
const KEPT: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUD_ML_REGION",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NVM_DIR",
    "VOLTA_HOME",
    "PNPM_HOME",
    "BUN_INSTALL",
    "FNM_DIR",
    "N_PREFIX",
    "NPM_CONFIG_PREFIX",
];
const KEPT_PREFIXES: &[&str] = &["ANTHROPIC_", "CLAUDE_CODE_", "AWS_", "VERTEX_"];
const PROXIES: &[&str] = &["http_proxy", "https_proxy", "no_proxy", "all_proxy"];

/// Takes over what the login shell sets. Call it before any other thread runs.
pub fn import() {
    let started = Instant::now();
    let Some(env) = login_env() else {
        return;
    };
    let mut taken = 0;
    for (name, value) in env {
        let Some(name) = name.to_str().map(str::to_owned) else {
            continue;
        };
        if name == "PATH" {
            if let Some(path) = joined_path(&value) {
                // SAFETY: called first thing, before isled starts any thread.
                unsafe { std::env::set_var("PATH", path) };
            }
            continue;
        }
        let wanted = KEPT.contains(&name.as_str())
            || KEPT_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
            || PROXIES.contains(&name.to_lowercase().as_str());
        if wanted && std::env::var_os(&name).is_none() {
            // SAFETY: as above.
            unsafe { std::env::set_var(&name, &value) };
            taken += 1;
        }
    }
    log::info!(
        "took {taken} settings and the PATH from the login shell in {} ms",
        started.elapsed().as_millis()
    );
}

/// isled's PATH, then the shell's folders it lacks.
fn joined_path(shell: &OsString) -> Option<OsString> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let before = dirs.len();
    for dir in std::env::split_paths(shell) {
        if dir.is_absolute() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    (dirs.len() > before).then(|| std::env::join_paths(dirs).ok())?
}

/// The environment of an interactive login shell, where version managers set themselves up.
fn login_env() -> Option<Vec<(OsString, OsString)>> {
    ask(&user_shell()?, TIMEOUT)
}

fn ask(shell: &Path, timeout: Duration) -> Option<Vec<(OsString, OsString)>> {
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &format!("printf {MARK}; env -0")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Its own group, so whatever its startup files leave running can be ended with it.
        .process_group(0)
        .spawn()
        .ok()?;
    let group = child.id() as libc::pid_t;
    let mut stdout = child.stdout.take()?;
    let (sender, output) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).ok();
        sender.send(bytes).ok();
    });
    let deadline = Instant::now() + timeout;
    let mut bytes = output.recv_timeout(timeout).ok();
    let exited = loop {
        if ended(group) {
            break true;
        }
        if Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if !exited || bytes.is_none() {
        // A job left by .bashrc can hold the output open after the shell ends; end it with the shell.
        // SAFETY: the group made above; its leader is not reaped yet, so the id is still ours.
        unsafe { libc::killpg(group, libc::SIGKILL) };
    }
    child.wait().ok();
    if exited && bytes.is_none() {
        bytes = output.recv_timeout(Duration::from_millis(500)).ok();
    }
    match bytes {
        Some(bytes) if exited => Some(parse(&bytes)),
        _ => {
            log::warn!(
                "the login shell ({}) took too long; going on without it",
                shell.display()
            );
            None
        }
    }
}

/// Whether the process ended, left unreaped so its id stays its own.
fn ended(pid: libc::pid_t) -> bool {
    // SAFETY: waitid only writes into `info`.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let flags = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
    let done = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, flags) };
    done == 0 && unsafe { info.si_pid() } != 0
}

/// `env -0`'s output after the mark: NAME=value, each ended by a NUL.
fn parse(bytes: &[u8]) -> Vec<(OsString, OsString)> {
    let start = bytes
        .windows(MARK.len())
        .rposition(|window| window == MARK.as_bytes())
        .map_or(bytes.len(), |at| at + MARK.len());
    bytes[start..]
        .split(|&b| b == 0)
        .filter_map(|entry| {
            let at = entry.iter().position(|&b| b == b'=')?;
            (at > 0).then(|| {
                (
                    OsString::from_vec(entry[..at].to_vec()),
                    OsString::from_vec(entry[at + 1..].to_vec()),
                )
            })
        })
        .collect()
}

/// The user's shell: $SHELL, else their entry in the password database.
fn user_shell() -> Option<PathBuf> {
    let shell = std::env::var_os("SHELL").map(PathBuf::from).or_else(|| {
        // SAFETY: getpwuid returns a pointer into static storage, read at once.
        let entry = unsafe { libc::getpwuid(libc::getuid()) };
        if entry.is_null() {
            return None;
        }
        let shell = unsafe { std::ffi::CStr::from_ptr((*entry).pw_shell) };
        Some(PathBuf::from(OsString::from_vec(shell.to_bytes().to_vec())))
    })?;
    // A login that cannot run commands (nologin, false) has nothing to give.
    let name = shell.file_name()?.to_string_lossy().into_owned();
    (shell.is_absolute() && shell.is_file() && !matches!(name.as_str(), "nologin" | "false"))
        .then_some(shell)
}
}

#[cfg(all(unix, test))]
mod tests {
    use super::unix::*;


    #[test]
    fn reads_the_environment_after_the_mark() {
        let mut out = b"Welcome back!\n".to_vec();
        out.extend(MARK.as_bytes());
        out.extend(b"PATH=/a:/b\0CODEX_HOME=/x/codex\0EMPTY=\0ODD\0");
        let env = parse(&out);
        assert_eq!(env.len(), 3);
        assert_eq!(env[0], ("PATH".into(), "/a:/b".into()));
        assert_eq!(env[1], ("CODEX_HOME".into(), "/x/codex".into()));
        assert!(parse(b"no mark here").is_empty());
    }

    #[test]
    fn asks_a_real_shell() {
        // sh -l -i reads little; it still answers with an environment and a PATH.
        let env = parse(
            &Command::new("/bin/sh")
                .args(["-c", &format!("printf {MARK}; env -0")])
                .output()
                .unwrap()
                .stdout,
        );
        assert!(env.iter().any(|(name, _)| name == "PATH"));
    }

    #[test]
    fn a_job_left_running_by_the_shell_does_not_hold_isled() {
        let dir = std::env::temp_dir().join(format!("isle-login-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shell = dir.join("shell");
        // Startup files that leave a job holding the output, then the command.
        std::fs::write(&shell, "#!/bin/sh\nsleep 30 &\nexec /bin/sh -c \"$4\"\n").unwrap();
        std::fs::set_permissions(&shell, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let started = Instant::now();
        // Other tests start programs meanwhile: a script just written can be "busy" for a moment.
        let env = (0..3)
            .find_map(|_| ask(&shell, Duration::from_millis(1500)))
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(env.iter().any(|(name, _)| name == "PATH"));
        // A shell that never answers is left behind.
        std::fs::write(&shell, "#!/bin/sh\nexec sleep 30\n").unwrap();
        let started = Instant::now();
        assert!(ask(&shell, Duration::from_millis(300)).is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
        std::fs::remove_dir_all(dir).ok();
    }
}
