// SPDX-License-Identifier: GPL-3.0-or-later

//! Small JSON files under the user's data directory, one per feature.

use std::fs;
use std::io::{self, Write};
use std::marker::PhantomData;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use log::{debug, warn};
use serde::Serialize;
use serde::de::DeserializeOwned;

/// Every store's writer, for [`flush`] on the way out.
static WRITERS: Mutex<Vec<Weak<Writer>>> = Mutex::new(Vec::new());

pub struct Store<T> {
    path: PathBuf,
    writer: Arc<Writer>,
    /// Set when the file exists but could not be read (e.g. permission
    /// denied). Saving would replace data we never saw, so it is skipped.
    read_only: bool,
    /// Set when the file was corrupt and moved aside: the loaded value is a
    /// fresh default, not what the user had.
    fell_back: bool,
    _value: PhantomData<T>,
}

impl<T: Serialize + DeserializeOwned + Default> Store<T> {
    /// A store at `~/.local/share/isle/<name>.json`.
    pub fn new(name: &str) -> Self {
        Self::at(data_dir().join(format!("{name}.json")))
    }

    pub(crate) fn at(path: PathBuf) -> Self {
        let writer = Arc::new(Writer {
            path: path.clone(),
            pending: Mutex::default(),
            writing: Mutex::default(),
        });
        let mut writers = lock(&WRITERS);
        writers.retain(|writer| writer.strong_count() > 0);
        writers.push(Arc::downgrade(&writer));
        Self {
            path,
            writer,
            read_only: false,
            fell_back: false,
            _value: PhantomData,
        }
    }

    /// Loads the stored value, falling back to the default. A corrupt file is moved aside to
    /// `<name>.json.corrupt`; one that cannot be read or moved turns saving off until restart.
    pub fn load(&mut self) -> T {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return T::default(),
            Err(err) => {
                warn!(
                    "could not read {}: {err}; changes will not be saved, so it is not overwritten",
                    self.path.display()
                );
                self.read_only = true;
                return T::default();
            }
        };
        serde_json::from_slice(&bytes).unwrap_or_else(|err| {
            let backup = self.path.with_extension("json.corrupt");
            self.fell_back = true;
            match fs::rename(&self.path, &backup) {
                Ok(()) => warn!(
                    "{} is invalid ({err}); moved to {}",
                    self.path.display(),
                    backup.display()
                ),
                Err(rename_err) => {
                    warn!(
                        "{} is invalid ({err}) and could not be moved aside ({rename_err}); \
                         changes will not be saved, so it is not overwritten",
                        self.path.display()
                    );
                    self.read_only = true;
                }
            }
            T::default()
        })
    }

    /// Whether the value stands in for unreadable or corrupt data, so files it no longer
    /// mentions may still belong to the user's real data.
    pub fn lost_track(&self) -> bool {
        self.read_only || self.fell_back
    }

    /// Saves atomically, so a crash mid-write never leaves a truncated file. The disk work runs on a
    /// blocking thread; saves made meanwhile are merged into the newest, which always lands last.
    pub fn save(&self, value: &T) {
        let Some(waiting) = self.queue(value) else {
            return;
        };
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) if !waiting => {
                let writer = self.writer.clone();
                runtime.spawn_blocking(move || writer.write());
            }
            Ok(_) => {}
            Err(_) => self.writer.write(),
        }
    }

    /// Saves before returning, for a file another `Store` of it may read or delete right after.
    pub fn save_now(&self, value: &T) {
        if self.queue(value).is_some() {
            self.writer.write();
        }
    }

    /// Hands `value` to the writer; whether a write was already waiting, `None` if not to be saved.
    fn queue(&self, value: &T) -> Option<bool> {
        if self.read_only {
            debug!("not saving {}: it could not be loaded", self.path.display());
            return None;
        }
        let mut bytes = match serde_json::to_vec(value) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("could not save {}: {err}", self.path.display());
                return None;
            }
        };
        bytes.push(b'\n');
        // A write already waiting takes these bytes instead of its own.
        Some(lock(&self.writer.pending).replace(bytes).is_some())
    }
}

impl<T> Store<T> {
    /// Deletes the file, and any save still waiting to be written: what it held is gone for good.
    pub fn remove(&self) {
        let _writing = lock(&self.writer.writing);
        lock(&self.writer.pending).take();
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => warn!("could not delete {}: {err}", self.path.display()),
        }
    }
}

/// Writes a store's file, one write at a time.
struct Writer {
    path: PathBuf,
    /// The newest value not yet taken for writing.
    pending: Mutex<Option<Vec<u8>>>,
    /// Held from taking a value until it is written, so writes land in the order they were taken.
    writing: Mutex<()>,
}

impl Writer {
    fn write(&self) {
        let _writing = lock(&self.writing);
        let Some(bytes) = lock(&self.pending).take() else {
            return;
        };
        if let Err(err) = write_atomic(&self.path, &bytes) {
            warn!("could not save {}: {err}", self.path.display());
        }
    }
}

/// Writes every save still waiting, before isled exits.
pub fn flush() {
    let writers: Vec<Arc<Writer>> = lock(&WRITERS).iter().filter_map(Weak::upgrade).collect();
    for writer in writers {
        writer.write();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Creates `dir` (and its parents) readable by the user alone: the clipboard
/// history can hold things worth keeping private.
pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        fs::DirBuilder::new()
            .recursive(true)
            .create(dir)
    }
}

/// Writes a file only the user can read.
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    private_file(path)?.write_all(bytes)
}

fn private_file(path: &Path) -> io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    opts.mode(0o600);
    opts.open(path)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    let mut file = private_file(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    #[cfg(windows)]
    let _ = fs::remove_file(path);
    fs::rename(temp, path)?;
    // Flush the rename itself too, so the new file survives a power cut.
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("isle")
}

pub fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("isle")
}

/// Keeps the `keep` newest files in `dir` and deletes the rest (cover art and lyrics, one per song, would
/// otherwise pile up). Never follows links, and leaves folders alone.
pub fn prune_newest(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (_, path) in files.into_iter().skip(keep) {
        fs::remove_file(path).ok();
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn keeps_only_the_newest_files() {
        let dir = scratch("prune");
        fs::create_dir_all(dir.join("folder")).unwrap();
        for i in 0..5 {
            fs::write(dir.join(format!("{i}")), "x").unwrap();
            // Distinct times, oldest first.
            let at = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000 + i);
            fs::File::options()
                .write(true)
                .open(dir.join(format!("{i}")))
                .unwrap()
                .set_modified(at)
                .unwrap();
        }
        prune_newest(&dir, 2);
        let mut left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["3", "4", "folder"]);
        fs::remove_dir_all(dir).unwrap();
    }

    /// A fresh, empty directory for one test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("isle-store-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn corrupt_files_are_moved_aside() {
        let dir = scratch("corrupt");
        let path = dir.join("list.json");
        fs::write(&path, "{ not json").unwrap();

        let mut store = Store::<Vec<u32>>::at(path.clone());
        assert_eq!(store.load(), Vec::<u32>::new());
        assert_eq!(
            fs::read_to_string(dir.join("list.json.corrupt")).unwrap(),
            "{ not json"
        );
        store.save(&vec![1]);
        assert_eq!(store.load(), [1]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_the_pretty_files_older_versions_wrote() {
        let dir = scratch("pretty");
        let path = dir.join("list.json");
        fs::write(&path, "[\n  1,\n  2\n]\n").unwrap();
        let mut store = Store::<Vec<u32>>::at(path.clone());
        assert_eq!(store.load(), [1, 2]);
        store.save(&vec![3, 4]);
        assert_eq!(fs::read_to_string(&path).unwrap(), "[3,4]\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn the_last_save_lands_last() {
        let dir = scratch("latest");
        let path = dir.join("list.json");
        let store = Store::<Vec<u32>>::at(path.clone());
        for i in 0..50 {
            store.save(&vec![i]);
            if i % 7 == 0 {
                tokio::task::yield_now().await;
            }
        }
        // As isled does on the way out: whatever still waits is written now.
        flush();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[49]\n");
        // Nothing written later puts an older value back.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(fs::read_to_string(&path).unwrap(), "[49]\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn unreadable_files_are_never_overwritten() {
        let dir = scratch("unreadable");
        let path = dir.join("list.json");
        fs::write(&path, "[1, 2]").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o200)).unwrap();
        // Root reads anything, so there is nothing to test then.
        if fs::read(&path).is_ok() {
            fs::remove_dir_all(dir).unwrap();
            return;
        }

        let mut store = Store::<Vec<u32>>::at(path.clone());
        assert_eq!(store.load(), Vec::<u32>::new());
        store.save(&vec![3]);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1, 2]");
        fs::remove_dir_all(dir).unwrap();
    }
}
