// SPDX-License-Identifier: GPL-3.0-or-later

//! The helpers isled starts for the assistant (the AI CLIs, speech recognition): each leads a process
//! group of its own at a lower priority, so the desktop stays smooth while they work, and nothing they
//! start outlives them.

use std::ops::{Deref, DerefMut};

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};

/// How much they give way to the desktop (see nice(1)).
#[cfg(unix)]
const NICENESS: libc::c_int = 10;
/// A line of an AI CLI's output longer than this (a whole file it read, say) is skipped, never kept.
const MAX_LINE: usize = 8 * 1024 * 1024;

/// A started helper; dropped, its whole process group is killed.
pub struct Group(Child);

/// Starts `command` in a process group of its own, at a lower priority. Its own folder leads its PATH, so
/// a CLI that starts with `#!/usr/bin/env node` finds the Node installed beside it (nvm, volta…).
pub fn spawn(command: &mut Command) -> std::io::Result<Group> {
    let program = std::path::PathBuf::from(command.as_std().get_program());
    let path = path_for(&program);
    #[cfg(unix)]
    {
        // It never gains privileges (no setuid sudo or pkexec), unless it runs from a snap, whose launcher
        // needs them.
        if !from_snap(&program, path.as_deref()) {
            // SAFETY: prctl is async-signal-safe and only reads its integer arguments.
            unsafe {
                command.pre_exec(|| {
                    if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 {
                        Ok(())
                    } else {
                        Err(std::io::Error::last_os_error())
                    }
                });
            }
        }
    }
    if let Some(path) = path {
        command.env("PATH", path);
    }
    #[cfg(unix)]
    let child = command.process_group(0).kill_on_drop(true).spawn()?;
    #[cfg(not(unix))]
    let child = command.kill_on_drop(true).spawn()?;

    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: setpriority only reads its plain integer arguments.
        unsafe { libc::setpriority(libc::PRIO_PGRP, pid, NICENESS) };
    }
    Ok(Group(child))
}

/// Whether `program`, or the Node it would run on, is a snap's.
#[cfg(unix)]
fn from_snap(program: &std::path::Path, path: Option<&std::ffi::OsStr>) -> bool {
    let snap = |path: &std::path::Path| {
        std::fs::canonicalize(path)
            .is_ok_and(|real| real.starts_with("/snap") || real.ends_with("usr/bin/snap"))
    };
    let path = path.map_or_else(
        || std::env::var_os("PATH").unwrap_or_default(),
        std::ffi::OsStr::to_os_string,
    );
    let node = std::env::split_paths(&path)
        .map(|dir| dir.join("node"))
        .find(|node| node.is_file());
    snap(program)
        || program.starts_with("/snap")
        || node.is_some_and(|node| node.starts_with("/snap") || snap(&node))
}

/// The PATH for `program`: its own folder first, then isled's.
pub fn path_for(program: &std::path::Path) -> Option<std::ffi::OsString> {
    let dir = program.parent().filter(|dir| !dir.as_os_str().is_empty())?;
    let path = std::env::var_os("PATH").unwrap_or_default();
    let dirs = std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&path));
    std::env::join_paths(dirs).ok()
}

impl Drop for Group {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            // Its group, led by it: the node workers or servers an AI CLI starts go with it.
            if let Some(pid) = self.0.id().and_then(|pid| libc::pid_t::try_from(pid).ok()) {
                // SAFETY: killpg only reads its plain integer arguments.
                unsafe { libc::killpg(pid, libc::SIGKILL) };
            }
        }
    }
}

impl Deref for Group {
    type Target = Child;

    fn deref(&self) -> &Child {
        &self.0
    }
}

impl DerefMut for Group {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}

/// An AI CLI's JSON events, a line at a time, skipping those that cannot matter unparsed.
pub struct Events<R> {
    reader: BufReader<R>,
    line: Vec<u8>,
    limit: usize,
}

impl<R: AsyncRead + Unpin> Events<R> {
    pub fn new(output: R) -> Self {
        Self::with_limit(output, MAX_LINE)
    }

    fn with_limit(output: R, limit: usize) -> Self {
        Self {
            reader: BufReader::new(output),
            line: Vec::new(),
            limit,
        }
    }

    /// The next event holding one of `words` (each with its quotes, e.g. `"result"`: a key or a
    /// value), parsed; `None` once the output ends.
    pub async fn next(&mut self, words: &[&str]) -> std::io::Result<Option<serde_json::Value>> {
        loop {
            let Some(line) = self.next_line().await? else {
                return Ok(None);
            };
            if !words.iter().any(|word| line.contains(word)) {
                continue;
            }
            if let Ok(event) = serde_json::from_str(line) {
                return Ok(Some(event));
            }
        }
    }

    /// The next line, empty when it was too long to keep; `None` at the end.
    async fn next_line(&mut self) -> std::io::Result<Option<&str>> {
        self.line.clear();
        let mut skipped = false;
        let mut read_any = false;
        loop {
            let buffer = self.reader.fill_buf().await?;
            if buffer.is_empty() {
                if !read_any {
                    return Ok(None);
                }
                break;
            }
            read_any = true;
            let (part, ends) = match buffer.iter().position(|&byte| byte == b'\n') {
                Some(at) => (&buffer[..at], true),
                None => (buffer, false),
            };
            if skipped || self.line.len() + part.len() > self.limit {
                skipped = true;
                self.line.clear();
            } else {
                self.line.extend_from_slice(part);
            }
            let used = part.len() + usize::from(ends);
            self.reader.consume(used);
            if ends {
                break;
            }
        }
        if self.line.last() == Some(&b'\r') {
            self.line.pop();
        }
        Ok(Some(std::str::from_utf8(&self.line).unwrap_or_default()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn skips_lines_that_cannot_matter() {
        let output: &[u8] = b"{\"type\":\"user\",\"content\":\"x\"}\nnot json \"result\"\n\
            {\"type\":\"result\",\"n\":1}\r\n{\"type\":\"result\",\"n\":2}";
        let mut events = Events::new(output);
        let words = ["\"result\""];
        assert_eq!(events.next(&words).await.unwrap().unwrap()["n"], 1);
        // The last line may end without a newline.
        assert_eq!(events.next(&words).await.unwrap().unwrap()["n"], 2);
        assert!(events.next(&words).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn skips_lines_too_long_to_keep() {
        let long = format!("{{\"type\":\"result\",\"text\":\"{}\"}}\n", "x".repeat(100));
        let output = format!("{long}{{\"type\":\"result\",\"n\":3}}\n");
        let mut events = Events::with_limit(output.as_bytes(), 64);
        let event = events.next(&["\"result\""]).await.unwrap().unwrap();
        assert_eq!(event["n"], 3);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn takes_its_whole_group_along() {
        // A shell that leaves a grandchild running, as an AI CLI's node workers would.
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 & echo $!; wait"]);
        command.stdout(std::process::Stdio::piped());
        let mut group = spawn(&mut command).unwrap();
        let stdout = group.stdout.take().unwrap();
        let mut lines = tokio::io::AsyncBufReadExt::lines(tokio::io::BufReader::new(stdout));
        let grandchild: i32 = lines.next_line().await.unwrap().unwrap().parse().unwrap();
        drop(group);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // Gone, or a zombie left for whoever adopted it to reap.
        let state = std::fs::read_to_string(format!("/proc/{grandchild}/stat")).unwrap_or_default();
        let alive = state
            .rsplit(')')
            .next()
            .is_some_and(|rest| !rest.trim_start().starts_with('Z') && !rest.is_empty());
        assert!(!alive, "the grandchild outlived its group");
    }
}
