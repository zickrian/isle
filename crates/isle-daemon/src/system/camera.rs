// SPDX-License-Identifier: GPL-3.0-or-later

//! Whether a camera is in use, counted from inotify opens and closes of `/dev/video*`.
//! A change only counts after [`SETTLE`], to ignore quick probes by udev or PipeWire.

use zbus::object_server::InterfaceRef;

use super::SystemService;

#[cfg(not(target_os = "linux"))]
pub async fn watch(_iface: InterfaceRef<SystemService>) -> anyhow::Result<()> {
    std::future::pending::<()>().await;
    Ok(())
}

#[cfg(target_os = "linux")]
use linux::*;

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use futures_util::StreamExt;
    use inotify::{EventMask, Inotify, WatchDescriptor, WatchMask, Watches};
    use log::debug;
    use tokio::time::{Instant, sleep_until};
    use zbus::object_server::InterfaceRef;

    use super::super::{SystemService, publish};

    const DEVICES: &str = "/dev";
    const SETTLE: Duration = Duration::from_millis(1500);

    /// A watched `/dev/video*` node.
    struct Camera {
        path: PathBuf,
        /// Handles currently held on it.
        open: usize,
    }


pub async fn watch(iface: InterfaceRef<SystemService>) -> anyhow::Result<()> {
    let inotify = Inotify::init()?;
    let mut watches = inotify.watches();
    // Cameras come and go (USB webcams), so watch the directory too.
    let directory = watches.add(DEVICES, WatchMask::CREATE | WatchMask::DELETE)?;
    let mut cameras: HashMap<WatchDescriptor, Camera> = HashMap::new();
    // Count the handles held right now, e.g. a call already running when
    // isled starts.
    rescan(&mut watches, &mut cameras).await;

    // Start from what is published, which after a restart of this watcher
    // may be a stale "in use" that needs clearing.
    let mut published = iface.get().await.state.camera_in_use;
    let mut settle_at = (in_use(&cameras) != published).then(|| Instant::now() + SETTLE);

    let mut events = inotify.into_event_stream([0u8; 1024])?;
    loop {
        tokio::select! {
            event = events.next() => {
                let Some(event) = event else { return Ok(()) };
                let event = event?;
                if event.mask.contains(EventMask::Q_OVERFLOW) {
                    debug!("camera events were lost; counting open handles afresh");
                    rescan(&mut watches, &mut cameras).await;
                } else if event.wd == directory {
                    let Some(name) = event.name.as_ref().and_then(|n| n.to_str()) else { continue };
                    if !name.starts_with("video") {
                        continue;
                    }
                    let path = Path::new(DEVICES).join(name);
                    if event.mask.contains(EventMask::CREATE) {
                        add_camera(&mut watches, &mut cameras, path);
                    } else if event.mask.contains(EventMask::DELETE) {
                        // Unplugged: its handles die with the device, so stop counting them now.
                        cameras.retain(|_, camera| camera.path != path);
                    }
                } else if let Some(camera) = cameras.get_mut(&event.wd) {
                    if event.mask.contains(EventMask::OPEN) {
                        camera.open += 1;
                    } else if event.mask.intersects(EventMask::CLOSE_WRITE | EventMask::CLOSE_NOWRITE) {
                        camera.open = camera.open.saturating_sub(1);
                    } else if event.mask.contains(EventMask::IGNORED) {
                        // The device went away; its watch is gone with it.
                        cameras.remove(&event.wd);
                    }
                }
                if in_use(&cameras) != published {
                    settle_at = Some(Instant::now() + SETTLE);
                }
            }
            () = sleep_until(settle_at.unwrap_or_else(Instant::now)), if settle_at.is_some() => {
                settle_at = None;
                let in_use = in_use(&cameras);
                if in_use != published {
                    published = in_use;
                    debug!("camera in use: {in_use}");
                    publish(&iface, |state| state.camera_in_use = in_use, None).await;
                }
            }
        }
    }
}

fn in_use(cameras: &HashMap<WatchDescriptor, Camera>) -> bool {
    cameras.values().any(|camera| camera.open > 0)
}

/// Rebuilds the camera list and every count from scratch: at start-up, and
/// when inotify lost events so the counts can no longer be trusted.
async fn rescan(watches: &mut Watches, cameras: &mut HashMap<WatchDescriptor, Camera>) {
    cameras.clear();
    for path in camera_paths() {
        add_camera(watches, cameras, path);
    }
    // Every process's handles are looked at: file work, off the runtime's thread.
    let devices: Vec<PathBuf> = cameras.values().map(|camera| camera.path.clone()).collect();
    let open = tokio::task::spawn_blocking(move || holders(&devices))
        .await
        .unwrap_or_default();
    for camera in cameras.values_mut() {
        camera.open = open.get(&camera.path).copied().unwrap_or(0);
    }
}

fn camera_paths() -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(DEVICES) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("video"))
        })
        .collect()
}

fn add_camera(
    watches: &mut Watches,
    cameras: &mut HashMap<WatchDescriptor, Camera>,
    path: PathBuf,
) {
    let mask = WatchMask::OPEN | WatchMask::CLOSE_WRITE | WatchMask::CLOSE_NOWRITE;
    match watches.add(&path, mask) {
        // Adding a node that is already watched returns its existing
        // descriptor; keep the count it has.
        Ok(descriptor) => {
            cameras
                .entry(descriptor)
                .or_insert(Camera { path, open: 0 });
        }
        Err(err) => debug!("cannot watch {}: {err}", path.display()),
    }
}

/// Open handles on each of `devices` from our own processes' `/proc/*/fd` (others' are unreadable),
/// in one pass. Only used when inotify counts are not trustworthy: at start-up and after lost events.
fn holders(devices: &[PathBuf]) -> HashMap<PathBuf, usize> {
    let mut open = HashMap::new();
    let Ok(processes) = fs::read_dir("/proc") else {
        return open;
    };
    if devices.is_empty() {
        return open;
    }
    for fd in processes
        .flatten()
        .filter_map(|process| fs::read_dir(process.path().join("fd")).ok())
        .flat_map(|fds| fds.flatten())
    {
        if let Ok(target) = fs::read_link(fd.path())
            && devices.contains(&target)
        {
            *open.entry(target).or_default() += 1;
        }
    }
    open
}
}
