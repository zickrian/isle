// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Clipboard history over D-Bus: the shell reports copies, isled keeps the list and images.
//! Images are stored once per hash in `~/.local/share/isle/clips`, each with a thumbnail.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};
use std::time::Duration;

use image::{DynamicImage, ImageFormat};
use isle_core::clipboard::{
    Added, Clip, ClipError, ClipboardHistory, MAX_PINNED, PinError, content_hash,
};
use log::{debug, warn};
use serde::Serialize;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface};

use crate::clock::now_ms;
use crate::store::{Store, create_private_dir, data_dir, write_private};

/// Largest image accepted, in bytes of PNG.
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;

/// Thumbnails are the card's picture (136 CSS px wide, about 105 tall) at twice its pixels,
/// sharp at 1× and 2×; CARD_PICTURE in clipRules.js says how the card shows them.
const THUMB_WIDTH: u32 = 272;
const THUMB_HEIGHT: u32 = 216;

/// Thumbnails older versions made are made again this long after isled starts, off login's way.
const REMAKE_AFTER: Duration = Duration::from_secs(15);

/// The Clipboard1 D-Bus object: the saved history and the image files it refers to.
pub struct ClipboardService {
    history: ClipboardHistory,
    store: Store<ClipboardHistory>,
    clips: ClipFiles,
    /// Images still without this version's thumbnail, and whether an older one stands in.
    stale: HashMap<String, bool>,
}

impl ClipboardService {
    /// Loads the history and tidies it against the image files on disk.
    pub fn load() -> Self {
        let mut store = Store::new("clipboard");
        let mut history: ClipboardHistory = store.load();
        let clips = ClipFiles {
            dir: data_dir().join("clips"),
        };

        // An image item is useless without its image, which the user may have
        // deleted while isled was not running; a thumbnail can be made again.
        let before = history.items().len();
        history.retain(|item| {
            item.clip
                .image_hash()
                .is_none_or(|hash| clips.image(hash).is_file())
        });
        // Their files go with the orphans below.
        history.prune();
        if history.items().len() != before {
            store.save(&history);
        }
        // Folders made by older versions were readable by others.
        if clips.dir.is_dir()
            && let Err(err) = create_private_dir(&clips.dir)
        {
            warn!("could not make {} private: {err}", clips.dir.display());
        }
        // Without the real list (unreadable, or corrupt and set aside), every
        // image would look like an orphan.
        if !store.lost_track() {
            clips.remove_orphans(&history.image_hashes().collect());
        }
        let stale = clips.stale(history.image_hashes());
        Self {
            history,
            store,
            clips,
            stale,
        }
    }

    /// Saves the history and signals `Items`.
    async fn changed(&self, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        self.store.save(&self.history);
        self.items_changed(emitter).await
    }

    /// Saves and announces an addition, then deletes the image files the
    /// addition pushed out of the history.
    async fn added(&self, added: Added, emitter: &SignalEmitter<'_>) -> fdo::Result<u64> {
        self.changed(emitter).await?;
        self.clips.remove(&added.unreferenced);
        Ok(added.id)
    }

    /// The `Items` list, built fresh from the history.
    fn view(&self) -> Vec<ItemView<'_>> {
        self.history
            .items()
            .iter()
            .map(|item| {
                let image = match &item.clip {
                    Clip::Image {
                        hash,
                        width,
                        height,
                    } => Some((hash, *width, *height)),
                    _ => None,
                };
                let thumb_size = image
                    .filter(|(hash, ..)| !self.stale.contains_key(hash.as_str()))
                    .map(|(_, width, height)| ThumbPlan::new(width, height).size());
                ItemView {
                    id: item.id,
                    kind: item.clip.kind(),
                    preview: item.clip.preview(),
                    uris: item.clip.uris(),
                    image: image.map(|(hash, ..)| path_string(&self.clips.image(hash))),
                    thumb: image.and_then(|(hash, ..)| self.thumb_path(hash)),
                    thumb_width: thumb_size.map(|(width, _)| width),
                    thumb_height: thumb_size.map(|(_, height)| height),
                    width: image.map(|(_, width, _)| width),
                    height: image.map(|(.., height)| height),
                    app_id: &item.app_id,
                    at_ms: item.at_ms,
                    pinned: item.pinned,
                }
            })
            .collect()
    }

    /// The thumbnail to show: this version's, an older one until that is made, or none.
    fn thumb_path(&self, hash: &str) -> Option<String> {
        match self.stale.get(hash) {
            None => Some(path_string(&self.clips.thumb(hash))),
            Some(true) => Some(path_string(&self.clips.old_thumb(hash))),
            Some(false) => None,
        }
    }
}

/// Makes the thumbnails older versions left again, one at a time off the event loop,
/// then announces them all at once.
pub async fn remake_thumbs(own: InterfaceRef<ClipboardService>) {
    let (clips, hashes): (ClipFiles, Vec<String>) = {
        let service = own.get().await;
        (
            service.clips.clone(),
            service.stale.keys().cloned().collect(),
        )
    };
    if hashes.is_empty() {
        return;
    }
    tokio::time::sleep(REMAKE_AFTER).await;
    for hash in hashes {
        if !own.get().await.stale.contains_key(&hash) {
            continue; // copied again meanwhile, so made already
        }
        let made = {
            let (clips, hash) = (clips.clone(), hash.clone());
            blocking(move || clips.remake_thumb(&hash)).await
        };
        let mut service = own.get_mut().await;
        let referenced = service.history.image_hashes().any(|h| h == hash);
        match made {
            // Removed meanwhile: what was just written goes too.
            _ if !referenced => {
                service.stale.remove(&hash);
                service.clips.remove(std::slice::from_ref(&hash));
            }
            Ok(Ok(())) => {
                service.stale.remove(&hash);
            }
            // The older thumbnail stays; isled tries again when it next starts.
            Ok(Err(err)) | Err(err) => warn!("could not make a clipboard thumbnail again: {err}"),
        }
    }
    crate::trim_memory();
    let service = own.get().await;
    if let Err(err) = service.items_changed(own.signal_emitter()).await {
        warn!("could not announce the new clipboard thumbnails: {err}");
    }
}

/// An `Items` entry: text cut to a preview, images as paths, so the list stays small.
/// `GetText` returns the full content.
#[derive(Serialize)]
struct ItemView<'a> {
    id: u64,
    kind: &'static str,
    preview: String,
    uris: &'a [String],
    image: Option<String>,
    thumb: Option<String>,
    thumb_width: Option<u32>,
    thumb_height: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
    app_id: &'a str,
    at_ms: i64,
    pinned: bool,
}

/// The error for an id that is not in the history.
fn not_found(id: u64) -> fdo::Error {
    fdo::Error::InvalidArgs(format!("no clipboard item with id {id}"))
}

/// A clip the history refused, as a D-Bus error.
fn invalid(err: ClipError) -> fdo::Error {
    fdo::Error::InvalidArgs(err.to_string())
}

#[interface(name = "io.github.zickrian.isle.Clipboard1")]
impl ClipboardService {
    /// Records copied text and returns its id; copying the same text again
    /// moves the existing item to the top.
    async fn add_text(
        &mut self,
        text: &str,
        app_id: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<u64> {
        let clip = Clip::from_text(text).map_err(invalid)?;
        let added = self.history.add(clip, app_id, now_ms());
        self.added(added, &emitter).await
    }

    /// Records a copied PNG image and returns its id. Decoding and scaling
    /// a large screenshot takes a moment, so it runs off the event loop.
    async fn add_image(
        &mut self,
        png: Vec<u8>,
        app_id: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<u64> {
        if png.len() > MAX_IMAGE_BYTES {
            return Err(invalid(ClipError::TooLarge));
        }
        let (png, hash) = blocking(move || {
            let hash = content_hash(&png);
            (png, hash)
        })
        .await?;

        // A known image only needs its files written again if they are gone.
        let known = self
            .history
            .image_size(&hash)
            .filter(|_| self.clips.has(&hash));
        let (width, height) = match known {
            Some(size) => size,
            None => {
                let clips = self.clips.clone();
                let hash = hash.clone();
                blocking(move || clips.store(&hash, &png)).await??
            }
        };
        self.stale.remove(&hash);
        let clip = Clip::Image {
            hash,
            width,
            height,
        };
        let added = self.history.add(clip, app_id, now_ms());
        let added = self.added(added, &emitter).await;
        // The image and its decoded pixels are gone now.
        crate::trim_memory();
        added
    }

    /// Records copied files (`file://` URIs) and returns the item's id.
    async fn add_files(
        &mut self,
        uris: Vec<String>,
        app_id: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<u64> {
        let clip = Clip::from_uris(uris).map_err(invalid)?;
        let added = self.history.add(clip, app_id, now_ms());
        self.added(added, &emitter).await
    }

    /// The full content to put back on the clipboard: the text, the file
    /// URIs one per line, or the path of an image's PNG file. GNOME Shell's to ask, no other program's.
    async fn get_text(
        &self,
        id: u64,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> fdo::Result<String> {
        crate::caller::shell_only(connection, &header).await?;
        let item = self.history.get(id).ok_or_else(|| not_found(id))?;
        Ok(match &item.clip {
            Clip::Text { text } | Clip::Link { text } => text.clone(),
            Clip::Files { uris } => uris.join("\n"),
            Clip::Image { hash, .. } => path_string(&self.clips.image(hash)),
        })
    }

    /// The ids of the items whose whole text (or files' names) holds `query`, ignoring case, in the list's
    /// order. GNOME Shell's to ask, no other program's: guess after guess, it would tell what was copied.
    async fn search(
        &self,
        query: &str,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> fdo::Result<Vec<u64>> {
        crate::caller::shell_only(connection, &header).await?;
        let query = query.to_lowercase();
        // A copy of the texts, searched off the event loop: they can be long.
        let items: Vec<(u64, Clip)> = self
            .history
            .items()
            .iter()
            .filter(|item| item.clip.image_hash().is_none())
            .map(|item| (item.id, item.clip.clone()))
            .collect();
        blocking(move || {
            items
                .into_iter()
                .filter(|(_, clip)| clip.contains(&query))
                .map(|(id, _)| id)
                .collect()
        })
        .await
    }

    /// Moves an item to the top, as the user just copied it again.
    async fn touch(
        &mut self,
        id: u64,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if !self.history.touch(id, now_ms()) {
            return Err(not_found(id));
        }
        Ok(self.changed(&emitter).await?)
    }

    /// Pins or unpins an item; at most `MAX_PINNED` can be pinned.
    async fn set_pinned(
        &mut self,
        id: u64,
        pinned: bool,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        match self.history.set_pinned(id, pinned) {
            Ok(()) => {}
            Err(PinError::NotFound) => return Err(not_found(id)),
            Err(PinError::Full) => {
                return Err(fdo::Error::LimitsExceeded(format!(
                    "at most {MAX_PINNED} items can be pinned"
                )));
            }
        }
        Ok(self.changed(&emitter).await?)
    }

    /// Removes one item, and its image files if nothing else uses them.
    async fn remove(
        &mut self,
        id: u64,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let unreferenced = self.history.remove(id).ok_or_else(|| not_found(id))?;
        self.changed(&emitter).await?;
        self.clips.remove(&unreferenced);
        Ok(())
    }

    /// Removes every item that is not pinned.
    async fn clear(
        &mut self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let unreferenced = self.history.clear();
        self.changed(&emitter).await?;
        self.clips.remove(&unreferenced);
        Ok(())
    }

    /// JSON array of items, newest first (see `ItemView`).
    #[zbus(property)]
    fn items(&self) -> String {
        serde_json::to_string(&self.view()).unwrap_or_default()
    }
}

/// Runs blocking work on tokio's blocking pool, so the D-Bus connection,
/// which shares isled's only thread with everything else, keeps flowing.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> fdo::Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| fdo::Error::Failed(format!("clipboard work failed: {err}")))
}

/// The directory of stored images: `<hash>.png`, the image as copied, and
/// `<hash>.card.png`, its thumbnail (`<hash>.thumb.png` up to 1.5.1).
#[derive(Clone)]
struct ClipFiles {
    dir: PathBuf,
}

impl ClipFiles {
    /// The image as copied.
    fn image(&self, hash: &str) -> PathBuf {
        self.dir.join(format!("{hash}.png"))
    }

    /// Its thumbnail.
    fn thumb(&self, hash: &str) -> PathBuf {
        self.dir.join(format!("{hash}.card.png"))
    }

    /// The thumbnail older versions made: fit within 320×200, blurry on the card.
    fn old_thumb(&self, hash: &str) -> PathBuf {
        self.dir.join(format!("{hash}.thumb.png"))
    }

    /// Both files are there.
    fn has(&self, hash: &str) -> bool {
        self.image(hash).is_file() && self.thumb(hash).is_file()
    }

    /// Of `hashes`, those without this version's thumbnail, and whether an older one is there.
    fn stale<'a>(&self, hashes: impl Iterator<Item = &'a str>) -> HashMap<String, bool> {
        hashes
            .filter(|hash| !self.thumb(hash).is_file())
            .map(|hash| (hash.to_owned(), self.old_thumb(hash).is_file()))
            .collect()
    }

    /// Stores a PNG and its thumbnail, returning the image's size. Blocks; the decoder's
    /// default limits cap how much memory a hostile image can claim.
    fn store(&self, hash: &str, png: &[u8]) -> fdo::Result<(u32, u32)> {
        let image = image::load_from_memory_with_format(png, ImageFormat::Png)
            .map_err(|err| fdo::Error::InvalidArgs(format!("not a readable PNG image: {err}")))?;
        create_private_dir(&self.dir).map_err(store_error)?;
        write_replacing(&self.image(hash), png).map_err(store_error)?;
        self.write_thumb(hash, &image, png)?;
        Ok((image.width(), image.height()))
    }

    /// Makes the thumbnail again from the stored image. Blocks, as `store` does.
    fn remake_thumb(&self, hash: &str) -> fdo::Result<()> {
        let png = fs::read(self.image(hash)).map_err(store_error)?;
        let image = image::load_from_memory_with_format(&png, ImageFormat::Png)
            .map_err(|err| fdo::Error::Failed(format!("not a readable PNG image: {err}")))?;
        self.write_thumb(hash, &image, &png)
    }

    /// Writes the thumbnail `ThumbPlan` makes of `image`, whose PNG is `png`.
    fn write_thumb(&self, hash: &str, image: &DynamicImage, png: &[u8]) -> fdo::Result<()> {
        let (width, height) = (image.width(), image.height());
        let plan = ThumbPlan::new(width, height);
        let size = plan.size();
        if size == (width, height) {
            // The whole image as it is: scaling it up would only blur it.
            write_replacing(&self.thumb(hash), png).map_err(store_error)?;
        } else {
            let mut thumb = image.crop_imm(plan.x, plan.y, plan.width, plan.height);
            if (plan.width, plan.height) != size {
                thumb = thumb.thumbnail_exact(size.0, size.1);
            }
            let mut bytes = Cursor::new(Vec::new());
            thumb
                .write_to(&mut bytes, ImageFormat::Png)
                .map_err(|err| fdo::Error::Failed(format!("could not make a thumbnail: {err}")))?;
            write_replacing(&self.thumb(hash), bytes.get_ref()).map_err(store_error)?;
        }
        self.link_old_thumb(hash);
        Ok(())
    }

    /// Keeps the older name for the thumbnail too, a link to the same file: an older isled (a
    /// rollback) drops an image without it. Best effort, as that name is not read here.
    fn link_old_thumb(&self, hash: &str) {
        let old = self.old_thumb(hash);
        remove_file(&old);
        if let Err(err) = fs::hard_link(self.thumb(hash), &old) {
            debug!("could not link {}: {err}", old.display());
        }
    }

    /// Deletes the files of images no item refers to any more.
    fn remove(&self, hashes: &[String]) {
        for hash in hashes {
            for path in [self.image(hash), self.thumb(hash), self.old_thumb(hash)] {
                remove_file(&path);
            }
        }
    }

    /// Deletes files not in `referenced`: images dropped while isled was down, and
    /// leftovers of interrupted writes.
    fn remove_orphans(&self, referenced: &HashSet<&str>) {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return,
            Err(err) => {
                debug!("could not list {}: {err}", self.dir.display());
                return;
            }
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_str();
            // The older name stays while its image does (see `link_old_thumb`).
            if let Some(hash) = name.and_then(|name| name.strip_suffix(".thumb.png")) {
                if !referenced.contains(hash) {
                    remove_file(&entry.path());
                }
                continue;
            }
            let hash = name.and_then(|name| {
                name.strip_suffix(".card.png")
                    .or_else(|| name.strip_suffix(".png"))
            });
            if !hash.is_some_and(|hash| referenced.contains(hash)) {
                remove_file(&entry.path());
            }
        }
    }
}

/// What of an image becomes its thumbnail: its middle cut to the card's shape and scaled down to
/// `THUMB_WIDTH`×`THUMB_HEIGHT`, or, for an image too small or thin to fill that, its middle at its
/// own pixels, for the island to show sharp rather than blown up.
#[derive(Debug, PartialEq, Eq)]
struct ThumbPlan {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    /// Whether the cut is scaled to the full thumbnail size.
    scaled: bool,
}

impl ThumbPlan {
    fn new(width: u32, height: u32) -> Self {
        let (cut_width, cut_height, scaled) = if width >= THUMB_WIDTH && height >= THUMB_HEIGHT {
            // Wider than the card: all its height; else all its width.
            let (w, h) = (u64::from(width), u64::from(height));
            let (tw, th) = (u64::from(THUMB_WIDTH), u64::from(THUMB_HEIGHT));
            if w * th > h * tw {
                (((h * tw + th / 2) / th).min(w) as u32, height, true)
            } else {
                (width, ((w * th + tw / 2) / tw).min(h) as u32, true)
            }
        } else {
            (width.min(THUMB_WIDTH), height.min(THUMB_HEIGHT), false)
        };
        Self {
            x: (width - cut_width) / 2,
            y: (height - cut_height) / 2,
            width: cut_width,
            height: cut_height,
            scaled,
        }
    }

    /// The thumbnail's size in pixels.
    fn size(&self) -> (u32, u32) {
        if self.scaled {
            (THUMB_WIDTH, THUMB_HEIGHT)
        } else {
            (self.width, self.height)
        }
    }
}

/// A file error while storing an image, as a D-Bus error.
fn store_error(err: io::Error) -> fdo::Error {
    fdo::Error::IOError(format!("could not store image: {err}"))
}

/// Writes through a temporary file and renames it into place, so an
/// interrupted write never leaves a half-written image under a real name.
fn write_replacing(path: &Path, bytes: &[u8]) -> io::Result<()> {
    // Its own temporary name: two writes of one file (a thumbnail made again as the image is
    // copied again) never share one.
    static WRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut temp = path.as_os_str().to_owned();
    temp.push(format!(".{n}.tmp"));
    write_private(Path::new(&temp), bytes)?;
    fs::rename(&temp, path)
}

/// Best effort: a file that cannot be deleted only costs disk space, and is
/// tried again as an orphan when isled next starts.
fn remove_file(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => debug!("removed {}", path.display()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => debug!("could not remove {}: {err}", path.display()),
    }
}

/// For D-Bus, which wants text even for a path that is not UTF-8.
fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use image::{Rgba, RgbaImage};

    use super::*;

    /// The cut (x, y, width, height) and the thumbnail's size.
    fn plan(width: u32, height: u32) -> (u32, u32, u32, u32, (u32, u32)) {
        let plan = ThumbPlan::new(width, height);
        (plan.x, plan.y, plan.width, plan.height, plan.size())
    }

    #[test]
    fn a_screenshot_is_cut_to_the_card_and_scaled_down() {
        // The card's 272:216 at full height, from the middle.
        assert_eq!(plan(1920, 1080), (280, 0, 1360, 1080, (272, 216)));
        assert_eq!(plan(417, 290), (26, 0, 365, 290, (272, 216)));
    }

    #[test]
    fn the_card_shape_is_only_scaled() {
        assert_eq!(plan(1360, 1080), (0, 0, 1360, 1080, (272, 216)));
        assert_eq!(plan(272, 216), (0, 0, 272, 216, (272, 216)));
    }

    #[test]
    fn a_thin_strip_keeps_its_pixels() {
        // Scaling 56 px to the card's height would blow it up: its middle, as it is.
        assert_eq!(plan(1913, 56), (820, 0, 272, 56, (272, 56)));
        assert_eq!(plan(417, 137), (72, 0, 272, 137, (272, 137)));
    }

    #[test]
    fn a_tall_image_keeps_its_pixels() {
        assert_eq!(plan(100, 2000), (0, 892, 100, 216, (100, 216)));
        // Wide enough to fill the card: cut to its shape, then scaled.
        assert_eq!(plan(600, 3000), (0, 1262, 600, 476, (272, 216)));
    }

    #[test]
    fn a_small_icon_is_kept_whole() {
        assert_eq!(plan(32, 32), (0, 0, 32, 32, (32, 32)));
    }

    /// A fresh, empty directory for one test.
    fn scratch(name: &str) -> ClipFiles {
        let dir = std::env::temp_dir().join(format!("isle-clips-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        ClipFiles { dir }
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = RgbaImage::from_fn(width, height, |x, y| Rgba([x as u8, y as u8, 90, 255]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    fn size_of(path: &Path) -> (u32, u32) {
        let image = image::open(path).unwrap();
        (image.width(), image.height())
    }

    #[test]
    fn storing_writes_the_thumbnail_for_the_card() {
        let clips = scratch("store");
        assert_eq!(clips.store("wide", &png(1913, 56)).unwrap(), (1913, 56));
        assert_eq!(size_of(&clips.thumb("wide")), (272, 56));
        clips.store("shot", &png(1280, 800)).unwrap();
        assert_eq!(size_of(&clips.thumb("shot")), (272, 216));
        // A small image is its own thumbnail, byte for byte.
        let icon = png(32, 32);
        clips.store("icon", &icon).unwrap();
        assert_eq!(fs::read(clips.thumb("icon")).unwrap(), icon);
        assert!(clips.has("icon"));
        fs::remove_dir_all(&clips.dir).unwrap();
    }

    #[test]
    fn older_thumbnails_stand_in_until_made_again() {
        let clips = scratch("remake");
        // As 1.5.1 left them: an image with its 320×200 thumbnail, and one without.
        fs::write(clips.image("old"), png(1913, 56)).unwrap();
        fs::write(clips.old_thumb("old"), png(320, 9)).unwrap();
        fs::write(clips.image("bare"), png(40, 30)).unwrap();
        // Of an image no longer in the list.
        fs::write(clips.old_thumb("gone"), png(320, 9)).unwrap();

        let referenced: HashSet<&str> = ["old", "bare"].into();
        clips.remove_orphans(&referenced);
        assert!(clips.old_thumb("old").is_file());
        assert!(!clips.old_thumb("gone").exists());
        let stale = clips.stale(["old", "bare"].into_iter());
        assert_eq!(
            stale,
            HashMap::from([("old".into(), true), ("bare".into(), false)])
        );
        assert!(!clips.has("old"));

        clips.remake_thumb("old").unwrap();
        clips.remake_thumb("bare").unwrap();
        assert_eq!(size_of(&clips.thumb("old")), (272, 56));
        assert_eq!(size_of(&clips.thumb("bare")), (40, 30));
        assert!(clips.stale(["old", "bare"].into_iter()).is_empty());
        // Made again, the older name is the new thumbnail too, so an older isled keeps the image.
        clips.remove_orphans(&referenced);
        assert_eq!(size_of(&clips.old_thumb("old")), (272, 56));
        assert_eq!(size_of(&clips.old_thumb("bare")), (40, 30));
        assert!(clips.has("old") && clips.has("bare"));
        fs::remove_dir_all(&clips.dir).unwrap();
    }

    #[test]
    fn removing_an_image_takes_every_thumbnail() {
        let clips = scratch("remove");
        clips.store("shot", &png(400, 300)).unwrap();
        fs::write(clips.old_thumb("shot"), png(320, 200)).unwrap();
        clips.remove(&["shot".to_owned()]);
        assert_eq!(fs::read_dir(&clips.dir).unwrap().count(), 0);
        fs::remove_dir_all(&clips.dir).unwrap();
    }

    #[test]
    fn storing_again_replaces_the_older_thumbnail() {
        let clips = scratch("again");
        fs::write(clips.old_thumb("shot"), png(320, 200)).unwrap();
        clips.store("shot", &png(400, 300)).unwrap();
        assert_eq!(
            size_of(&clips.old_thumb("shot")),
            size_of(&clips.thumb("shot"))
        );
        fs::remove_dir_all(&clips.dir).unwrap();
    }

    #[test]
    fn writes_of_one_file_never_share_a_temporary_name() {
        let clips = scratch("race");
        create_private_dir(&clips.dir).unwrap();
        let path = clips.thumb("same");
        let writers: Vec<_> = (0..8u8)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || write_replacing(&path, &[i; 4096]))
            })
            .collect();
        for writer in writers {
            writer.join().unwrap().unwrap();
        }
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.len() == 4096 && bytes.iter().all(|&b| b == bytes[0]));
        assert_eq!(fs::read_dir(&clips.dir).unwrap().count(), 1);
        fs::remove_dir_all(&clips.dir).unwrap();
    }
}
