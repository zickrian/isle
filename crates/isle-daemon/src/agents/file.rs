// SPDX-License-Identifier: GPL-3.0-or-later

//! Changing another program's config file with care: a backup before Isle first changes it, then the
//! whole new file put in place at once, with the old one's permissions.

use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// The file's text; `None` when there is no such file.
pub fn read(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// `path` with `suffix` added to its name: `settings.json.isle-backup`.
pub fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.file_name().unwrap_or_default());
    name.push(suffix);
    path.with_file_name(name)
}

/// Copies the file aside as `<name>.isle-backup`, unless one is there already (the first is the
/// user's own).
pub fn backup_once(path: &Path) -> io::Result<()> {
    let backup = sibling(path, ".isle-backup");
    if !path.exists() || backup.symlink_metadata().is_ok() {
        return Ok(());
    }
    fs::copy(path, backup).map(drop)
}

/// Replaces the file with `text` all at once. A link is followed, so a dotfile kept elsewhere stays one.
pub fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    #[cfg(unix)]
    let mode = fs::metadata(&target).map_or(0o600, |meta| meta.permissions().mode() & 0o7777);
    let temp = sibling(&target, ".isle-tmp");
    let _ = fs::remove_file(&temp);
    let written = (|| {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let mut file = opts.open(&temp)?;
        file.write_all(text.as_bytes())?;
        #[cfg(unix)]
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
        #[cfg(windows)]
        let _ = fs::remove_file(&target);
        fs::rename(&temp, &target)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A fresh, empty directory for one test.
    pub fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("isle-agents-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    #[cfg(unix)]
    fn writes_keep_the_mode_and_follow_links() {
        let dir = scratch("write");
        let real = dir.join("real.json");
        fs::write(&real, "old").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o640)).unwrap();
        let link = dir.join("settings.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_atomic(&link, "new").unwrap();
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
        let mode = fs::metadata(&real).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
        assert!(!sibling(&real, ".isle-tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_the_first_backup_is_kept() {
        let dir = scratch("backup");
        let path = dir.join("config.toml");
        backup_once(&path).unwrap();
        assert!(!sibling(&path, ".isle-backup").exists());
        fs::write(&path, "first").unwrap();
        backup_once(&path).unwrap();
        fs::write(&path, "second").unwrap();
        backup_once(&path).unwrap();
        let backup = fs::read_to_string(sibling(&path, ".isle-backup")).unwrap();
        assert_eq!(backup, "first");
        fs::remove_dir_all(dir).unwrap();
    }
}
