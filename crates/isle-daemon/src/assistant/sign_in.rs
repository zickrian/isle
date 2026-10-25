// SPDX-License-Identifier: GPL-3.0-or-later

//! The user's own sign-in, shared with Isle's copy of a CLI (Codex, agy): Isle's home for it links to the
//! user's sign-in file. A CLI that renews its token replaces the link with a file of its own; that newer
//! sign-in goes back over the user's, so neither is left holding a token the server has since replaced.

use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

fn make_symlink(real: &Path, linked: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(real, linked)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(real, linked).or_else(|_| fs::copy(real, linked).map(drop))
    }
}

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
        .and_then(|()| make_symlink(real, linked));
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
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let mut file = opts.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    #[cfg(windows)]
    let _ = fs::remove_file(to);
    fs::rename(temp, to)
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::*;

    fn aged(path: &Path, seconds_ago: u64) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(seconds_ago))
            .unwrap();
    }

    #[test]
    #[cfg(unix)]
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
        // Signed out (`codex logout`): Isle's copy goes too, and nothing comes back.
        fs::remove_file(&linked).unwrap();
        fs::write(&linked, "token 3").unwrap();
        fs::remove_file(&real).unwrap();
        share(&real, &linked);
        assert!(!real.exists() && fs::symlink_metadata(&linked).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
