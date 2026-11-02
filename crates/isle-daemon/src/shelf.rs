// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use isle_core::shelf::{CAPACITY, Shelf, ShelfItem};
use log::warn;
use tokio::sync::oneshot::{self, error::TryRecvError};
use tokio::sync::watch;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface};

use crate::clock::now_ms;
use crate::store::{Store, data_dir};
use crate::uri;

/// How long a file may take to say whether it is still there; one on a network mount that went
/// away can hang, and is then taken to be there.
const CHECK_WITHIN: Duration = Duration::from_secs(2);

/// The file shelf on the bus, saved to disk after every change.
pub struct ShelfService {
    shelf: Shelf,
    store: Store<Shelf>,
    /// Checks that ran out of time, by URI; such a file is not checked again until its check ends.
    stalled: HashMap<String, oneshot::Receiver<bool>>,
    /// Counts changes, for phone sharing's page to follow.
    changes: watch::Sender<u64>,
}

impl ShelfService {
    /// Loads the saved shelf, dropping copies no longer listed; `prune` drops files gone since.
    pub fn load() -> Self {
        let mut store = Store::new("shelf");
        let shelf: Shelf = store.load();
        if !store.lost_track() {
            remove_unlisted_copies(&shelf);
        }
        Self {
            shelf,
            store,
            stalled: HashMap::new(),
            changes: watch::Sender::new(0),
        }
    }

    /// Saves the shelf and tells the extension.
    async fn changed(&self, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        self.store.save(&self.shelf);
        self.changes.send_modify(|count| *count += 1);
        self.items_changed(emitter).await
    }

    /// The files on the shelf, without those whose last check hung (a network mount gone away).
    pub fn answering(&self) -> Vec<ShelfItem> {
        self.shelf
            .items()
            .iter()
            .filter(|item| !self.stalled.contains_key(&item.uri))
            .cloned()
            .collect()
    }

    /// Changes each time the shelf does.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Puts a file a phone sent (in the shelf's own folder) on the shelf; false when it is full.
    pub async fn add_received(
        &mut self,
        path: &std::path::Path,
        emitter: &SignalEmitter<'_>,
    ) -> bool {
        let item = ShelfItem {
            uri: uri::from_path(path),
            name: path
                .file_name()
                .map_or_else(String::new, |name| name.to_string_lossy().into_owned()),
            added_at_ms: now_ms(),
        };
        if !self.shelf.add(item) {
            return false;
        }
        if let Err(err) = self.changed(emitter).await {
            warn!("could not tell of a file from a phone: {err}");
        }
        true
    }
}

#[interface(name = "io.github.zickrian.isle.Shelf1")]
impl ShelfService {
    /// Adds local files by `file://` URI. Other URIs are rejected without stopping the rest;
    /// the call then fails as invalid, naming the rejected URIs.
    async fn add(
        &mut self,
        uris: Vec<String>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let mut rejected = Vec::new();
        let mut full = Vec::new();
        let mut added = false;
        for uri in uris {
            let Some(path) = uri::to_path(&uri) else {
                rejected.push(uri);
                continue;
            };
            let name = path
                .file_name()
                .map_or_else(|| uri.clone(), |name| name.to_string_lossy().into_owned());
            let item = ShelfItem {
                uri: uri.clone(),
                name,
                added_at_ms: now_ms(),
            };
            if self.shelf.add(item) {
                added = true;
            } else {
                full.push(uri);
            }
        }
        if added {
            self.changed(&emitter).await?;
        }
        if !full.is_empty() {
            return Err(fdo::Error::LimitsExceeded(format!(
                "the shelf holds {CAPACITY} files; remove one to add {}",
                full.join(" ")
            )));
        }
        if rejected.is_empty() {
            Ok(())
        } else {
            Err(fdo::Error::InvalidArgs(format!(
                "not local files: {}",
                rejected.join(" ")
            )))
        }
    }

    /// Takes one file off the shelf, deleting it only if it is the shelf's own copy.
    async fn remove(
        &mut self,
        uri: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if self.shelf.remove(uri) {
            forget(uri);
            self.changed(&emitter).await?;
        }
        Ok(())
    }

    /// Empties the shelf, deleting the shelf's own copies.
    async fn clear(
        &mut self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        for item in self.shelf.items() {
            forget(&item.uri);
        }
        self.shelf.clear();
        Ok(self.changed(&emitter).await?)
    }

    /// Drops items whose files no longer exist, shortly after it returns.
    async fn refresh(&self, #[zbus(connection)] connection: &zbus::Connection) -> fdo::Result<()> {
        let own = connection
            .object_server()
            .interface::<_, ShelfService>(crate::OBJECT_PATH)
            .await?;
        tokio::spawn(prune(own));
        Ok(())
    }

    /// JSON array of `ShelfItem`, newest first.
    #[zbus(property)]
    fn items(&self) -> String {
        serde_json::to_string(self.shelf.items()).unwrap_or_default()
    }
}

/// Drops files that no longer exist (moved or deleted, maybe while Isle was not running).
/// Checked off the runtime thread, so a file that hangs holds up nothing else.
pub async fn prune(own: InterfaceRef<ShelfService>) {
    // One at a time: two at once would both start a check of a file that hangs.
    if PRUNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let _done = Pruned;
    let checks: Vec<Check> = {
        let mut service = own.get_mut().await;
        service
            .stalled
            .retain(|_, check| matches!(check.try_recv(), Err(TryRecvError::Empty)));
        let service = &*service;
        service
            .shelf
            .items()
            .iter()
            .filter(|item| !service.stalled.contains_key(&item.uri))
            .map(|item| check(item.uri.clone()))
            .collect()
    };
    let (gone, stalled) = settle(checks, CHECK_WITHIN).await;
    let mut service = own.get_mut().await;
    service.stalled.extend(stalled);
    if service
        .shelf
        .retain_existing(|item| !gone.contains(&item.uri))
        && let Err(err) = service.changed(own.signal_emitter()).await
    {
        warn!("could not tell of files gone from the shelf: {err}");
    }
}

/// Whether a prune is under way (see `prune`).
static PRUNING: AtomicBool = AtomicBool::new(false);

/// Lets the next prune run once this one is over, however it ends.
struct Pruned;

impl Drop for Pruned {
    fn drop(&mut self) {
        PRUNING.store(false, Ordering::Release);
    }
}

/// A file's URI and the answer to whether it still exists.
type Check = (String, oneshot::Receiver<bool>);

/// Starts checking whether `uri` still exists, on a thread of its own rather than tokio's pool:
/// one that hangs for good then holds up nothing, not even isled's exit.
fn check(uri: String) -> Check {
    let (answer, check) = oneshot::channel();
    let path = uri.clone();
    // Had it not started, the answer is dropped and the file taken to be there.
    std::thread::Builder::new()
        .name("shelf-check".into())
        .spawn(move || answer.send(file_exists(&path)))
        .ok();
    (uri, check)
}

/// Waits up to `within` for all `checks`: the URIs found gone, and the checks still running.
async fn settle(checks: Vec<Check>, within: Duration) -> (Vec<String>, Vec<Check>) {
    let deadline = tokio::time::Instant::now() + within;
    let mut gone = Vec::new();
    let mut stalled = Vec::new();
    for (uri, mut check) in checks {
        match tokio::time::timeout_at(deadline, &mut check).await {
            Ok(Ok(false)) => gone.push(uri),
            Ok(_) => {}
            Err(_) => stalled.push((uri, check)),
        }
    }
    (gone, stalled)
}

/// Deletes the shelf's own copy of a clipboard image (kept so it outlives the history).
/// The user's own files are never touched.
fn forget(uri: &str) {
    let Some(path) = uri::to_path(uri) else {
        return;
    };
    if is_copy(&path, &owned_dir())
        && let Err(err) = std::fs::remove_file(&path)
    {
        log::debug!("could not remove {}: {err}", path.display());
    }
}

/// Deletes copies in the shelf's folder that are no longer on the shelf
/// (taken off while isled was not running, or refused because it was full).
fn remove_unlisted_copies(shelf: &Shelf) {
    let Ok(entries) = std::fs::read_dir(owned_dir()) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let listed = shelf
            .items()
            .iter()
            .any(|item| uri::to_path(&item.uri).as_ref() == Some(&path));
        if !listed && let Err(err) = std::fs::remove_file(&path) {
            log::debug!("could not remove {}: {err}", path.display());
        }
    }
}

/// Whether `path` is a file right in the shelf's folder; `shelf/../x` is not, as any bus client may add it.
fn is_copy(path: &std::path::Path, dir: &std::path::Path) -> bool {
    path.parent() == Some(dir) && path.file_name().is_some()
}

/// Where copies made for the shelf live (clipboard images, files from a phone): `~/.local/share/isle/shelf`.
pub fn owned_dir() -> std::path::PathBuf {
    data_dir().join("shelf")
}

/// Whether a `file://` URI still points at something on disk.
fn file_exists(uri: &str) -> bool {
    uri::to_path(uri).is_some_and(|path| path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn deletes_only_its_own_copies() {
        let dir = Path::new("/home/a/.local/share/isle/shelf");
        assert!(is_copy(&dir.join("Clipboard image.png"), dir));
        for path in [
            "/home/a/.local/share/isle/shelf/../../Documents/x",
            "/home/a/.local/share/isle/shelf/..",
            "/home/a/.local/share/isle/shelf/sub/x",
            "/home/a/Documents/x",
        ] {
            assert!(!is_copy(Path::new(path), dir), "{path}");
        }
        let uri = "file:///home/a/.local/share/isle/shelf/../../Documents/x";
        assert!(!is_copy(&uri::to_path(uri).unwrap(), dir));
    }

    #[tokio::test]
    async fn a_file_that_hangs_stays() {
        // As a stat on a network mount that went away: no answer for long.
        let (answer, hanging) = oneshot::channel();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(5));
            answer.send(false)
        });
        let checks = vec![
            ("file:///mnt/nfs/a".to_owned(), hanging),
            check("file:///nowhere/isle-shelf-test".into()),
            check("file:///".into()),
        ];
        let started = std::time::Instant::now();
        let (gone, stalled) = settle(checks, Duration::from_millis(300)).await;
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(gone, ["file:///nowhere/isle-shelf-test"]);
        let stalled: Vec<_> = stalled.iter().map(|(uri, _)| uri.as_str()).collect();
        assert_eq!(stalled, ["file:///mnt/nfs/a"]);
    }
}
