// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The user's sign-in, linked into Isle's home for a CLI (Codex, agy). A token the CLI renews there goes
//! back over the user's, so neither side is left holding one the server has since replaced.

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// Makes `linked` (Isle's) a link to `real` (the user's), first handing a renewed sign-in back.
pub fn share(real: &Path, linked: &Path) {
    if renewed(real, linked)
        && let Err(err) = copy_back(linked, real)
    {
        log::warn!(
            "could not hand a renewed sign-in back to {}: {err}",
            real.display()
        );
    }
    link(real, linked);
}

/// Makes `linked` (Isle's) a link to `real` (the user's), without copying back.
pub fn link(real: &Path, linked: &Path) {
    // The user signed out (or never signed in): so is Isle's copy, never the other way round.
    if !real.exists() {
        if fs::symlink_metadata(linked).is_ok() {
            fs::remove_file(linked).ok();
        }
        return;
    }
    if fs::read_link(linked).is_ok_and(|target| target == real) {
        return;
    }
    let relinked = linked
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| match fs::remove_file(linked) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        })
        .and_then(|()| std::os::unix::fs::symlink(real, linked));
    if let Err(err) = relinked {
        log::warn!("could not share the sign-in at {}: {err}", real.display());
    }
}

/// Whether `linked` is a file of its own (no longer the link), newer than the user's `real` one.
fn renewed(real: &Path, linked: &Path) -> bool {
    let Ok(own) = fs::symlink_metadata(linked) else {
        return false;
    };
    if !own.file_type().is_file() {
        return false;
    }
    match (
        own.modified(),
        fs::metadata(real).and_then(|m| m.modified()),
    ) {
        (Ok(own), Ok(user)) => own > user,
        // The user's is gone: they signed out, which Isle's copy must not undo.
        _ => false,
    }
}

/// Writes `from` over `to` all at once, readable by the user only, as sign-ins are.
fn copy_back(from: &Path, to: &Path) -> std::io::Result<()> {
    let bytes = fs::read(from)?;
    let temp = to.with_extension("isle-tmp");
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(temp, to)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::*;

    fn aged(path: &Path, seconds_ago: u64) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(seconds_ago))
            .unwrap();
    }

    #[test]
    fn a_renewed_sign_in_goes_back_and_an_old_copy_is_replaced() {
        let root = std::env::temp_dir().join(format!("isle-sign-in-{}", std::process::id()));
        let (real, linked) = (root.join("user/auth.json"), root.join("isle/auth.json"));
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        // Not signed in yet: nothing to link.
        share(&real, &linked);
        assert!(!linked.exists());
        fs::write(&real, "token 1").unwrap();
        share(&real, &linked);
        assert_eq!(fs::read_link(&linked).unwrap(), real);
        // The CLI renewed it in Isle's home: the user gets it, and the link is back.
        fs::remove_file(&linked).unwrap();
        fs::write(&linked, "token 2").unwrap();
        aged(&real, 60);
        share(&real, &linked);
        assert_eq!(fs::read_to_string(&real).unwrap(), "token 2");
        assert_eq!(fs::read_link(&linked).unwrap(), real);
        // An older copy (the user signed in again since): the user's stays.
        fs::remove_file(&linked).unwrap();
        fs::write(&linked, "stale").unwrap();
        aged(&linked, 120);
        share(&real, &linked);
        assert_eq!(fs::read_to_string(&real).unwrap(), "token 2");
        assert_eq!(fs::read_link(&linked).unwrap(), real);
        // Linking without sharing never hands a newer replacement back.
        fs::remove_file(&linked).unwrap();
        fs::write(&linked, "newer").unwrap();
        aged(&real, 60);
        link(&real, &linked);
        assert_eq!(fs::read_to_string(&real).unwrap(), "token 2");
        assert_eq!(fs::read_link(&linked).unwrap(), real);
        // Signed out (`codex logout`): Isle's copy goes too, and nothing comes back.
        fs::remove_file(&linked).unwrap();
        fs::write(&linked, "token 3").unwrap();
        fs::remove_file(&real).unwrap();
        share(&real, &linked);
        assert!(!real.exists() && fs::symlink_metadata(&linked).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
