// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! A file's tile, one size for all, as in pages/files.js: drag it out, click to copy,
//! double-click to open, × to remove, ↓ (on a file the shelf keeps itself) to save into Downloads.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use gtk::{gdk, gdk_pixbuf, gio, glib, pango, prelude::*};
use gtk4 as gtk;
use log::warn;

use crate::service;
use crate::shelf::Item;

/// Sizes in logical pixels; keep them in step with pages/files.js.
const TILE_WIDTH: i32 = 84;
const PREVIEW_SIZE: i32 = 52;
/// A file type's icon, drawn inside the preview's square.
const ICON_SIZE: i32 = 46;
/// File names are cut to this width.
const NAME_WIDTH: i32 = 76;
/// The ×: a small round badge over the preview's top-right corner.
const REMOVE_SIZE: i32 = 18;
/// The preview's square plus room above it for the ×.
const FRAME_HEIGHT: i32 = PREVIEW_SIZE + 6;
/// Thumbnails are cut at twice their size, sharp on HiDPI screens too.
const THUMBNAIL_PIXELS: i32 = PREVIEW_SIZE * 2;
/// A new file's tile pops in for this long (see style.css).
const FRESH_FOR: Duration = Duration::from_millis(600);
/// While a file has no thumbnail yet, it is looked for again after each of these (the island makes one).
const THUMBNAIL_WAITS: [Duration; 4] = [
    Duration::from_millis(800),
    Duration::from_millis(1500),
    Duration::from_secs(3),
    Duration::from_secs(5),
];
/// A file's thumbnail, or that making one failed.
const THUMBNAIL_ATTRIBUTES: &str = "thumbnail::path,thumbnail::failed,thumbnail::is-valid";
/// Kinds of file no thumbnailer draws, besides any `text/`: their icon is not waited on to give way. Whole
/// types: a part ("xml", "zip") would also catch documents and comics that do get one (docx, cbz).
const NO_THUMBNAIL: &[&str] = &[
    "application/x-shellscript",
    "application/json",
    "application/xml",
    "application/zip",
    "application/x-tar",
    "application/gzip",
    "application/x-compressed-tar",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "application/x-rar",
    "application/x-xz",
    "application/x-bzip2",
    "application/x-executable",
    "application/x-sharedlib",
];
/// The ×, white: drawn the same as the island's own (icons/isle-close-symbolic.svg), not the icon theme's.
const CLOSE_ICON: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect fill="#ffffff" x="7.1" y="2.2" width="1.8" height="11.6" rx=".9" transform="rotate(45 8 8)"/><rect fill="#ffffff" x="7.1" y="2.2" width="1.8" height="11.6" rx=".9" transform="rotate(-45 8 8)"/></svg>"##;
/// The ↓, white: drawn the same as the island's own (icons/isle-save-symbolic.svg).
const SAVE_ICON: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="#ffffff" d="M7.25 2h1.5v6.6l2.2-2.2 1.06 1.06L8 11.47 3.99 7.46 5.05 6.4l2.2 2.2zM3 12.5h10V14H3z"/></svg>"##;

thread_local! {
    /// Whether the extension handles Save (it says so with SetSaves): an older one doesn't, so no ↓.
    static SAVES: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Sets whether ↓ is shown; true if that changed.
pub fn set_saves(saves: bool) -> bool {
    SAVES.with(|cell| cell.replace(saves) != saves)
}

/// How long "Copied" shows on the tile.
const COPIED_FOR: Duration = Duration::from_millis(1100);
/// How long a drop waits for the app it landed on to answer before the drag ends anyway.
const DROP_ANSWER_WITHIN: Duration = Duration::from_secs(3);

/// Image types copied as the picture itself, so chat apps paste an image
/// rather than a file. Others (and these, if unreadable) go as a file.
const PICTURE_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/bmp",
    "image/tiff",
];

/// Builds the tile for `item`; `fresh` makes it pop in, `on_remove` gets its URI on ×.
pub fn new(item: &Item, fresh: bool, on_remove: impl Fn(String) + 'static) -> gtk::Widget {
    let file = gio::File::for_uri(&item.uri);
    // The type and icon its name says, from the first frame: the icon the island's tile beneath shows, not a stand-in
    // swapped a moment later. Guessed, as nothing may wait on the disk here (a file on a network mount that went away
    // would hang the window); `load_preview` then sets what the file itself says.
    let (guess, _) = gio::content_type_guess(Some(item.name.as_str()), None::<&[u8]>);
    let content_type: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(Some(guess.to_string())));

    let preview = preview_square(&["preview"]);
    let icon = gtk::Image::builder()
        .icon_name("text-x-generic")
        .pixel_size(ICON_SIZE)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .hexpand(true)
        .build();
    icon.set_from_gicon(&gio::content_type_get_icon(&guess));
    preview.append(&icon);
    load_preview(&file, &preview, &icon, &content_type);

    let copied = gtk::Box::builder()
        .css_classes(["copied"])
        .hexpand(false)
        .halign(gtk::Align::Fill)
        .valign(gtk::Align::Fill)
        .can_target(false)
        .build();
    copied.append(
        &gtk::Image::builder()
            .icon_name("object-select-symbolic")
            .pixel_size(18)
            .hexpand(true)
            .halign(gtk::Align::Center)
            .build(),
    );
    let preview_with_flash = gtk::Overlay::builder().child(&preview).build();
    preview_with_flash.add_overlay(&copied);

    let remove = gtk::Button::builder()
        .child(
            &gtk::Image::builder()
                .gicon(&gio::BytesIcon::new(&glib::Bytes::from_static(CLOSE_ICON)))
                .pixel_size(10)
                .build(),
        )
        .css_classes(["remove"])
        .build();
    remove.update_property(&[gtk::accessible::Property::Label("Remove from the shelf")]);
    let uri = item.uri.clone();
    remove.connect_clicked(move |_| on_remove(uri.clone()));
    // A file the shelf keeps itself (from a phone, a clipboard picture): ↓ under the pointer saves it.
    let save = (SAVES.with(std::cell::Cell::get) && is_shelf_copy(&file)).then(|| {
        let icon = gio::BytesIcon::new(&glib::Bytes::from_static(SAVE_ICON));
        let save = gtk::Button::builder()
            .child(&gtk::Image::builder().gicon(&icon).pixel_size(10).build())
            .css_classes(["remove", "save"])
            .build();
        save.update_property(&[gtk::accessible::Property::Label("Save to Downloads")]);
        let uri = item.uri.clone();
        save.connect_clicked(move |_| service::announce_save(&uri));
        save
    });

    let frame = frame(&preview_with_flash, Some(&remove), save.as_ref());
    let tile = tile_box(&frame, &item.name, fresh);

    // Dragging the tile hands the file to whatever it is dropped on.
    let source = gtk::DragSource::new();
    source.set_actions(gdk::DragAction::COPY);
    let dragged = file.clone();
    // Its URI alone: offered as a file list, GTK adds the document portal's types, and Chrome
    // (WhatsApp Web, Gmail) then takes no drop at all.
    source.connect_prepare(move |_, _, _| {
        let uris = glib::Bytes::from_owned(format!("{}\r\n", dragged.uri()).into_bytes());
        Some(gdk::ContentProvider::for_bytes("text/uri-list", &uris))
    });
    let drag_icon = preview.clone();
    source.connect_drag_begin(move |source, drag| {
        let paintable = gtk::WidgetPaintable::new(Some(&drag_icon));
        source.set_icon(Some(&paintable), PREVIEW_SIZE / 2, PREVIEW_SIZE / 2);
        service::announce_dragging(true);
        // Mutter may never answer a drop from XWayland, leaving the icon on screen and the drag
        // open: once dropped the icon goes, and the drag ends by itself if no answer comes.
        let source = source.downgrade();
        drag.connect_drop_performed(move |drag| {
            if let Some(icon) = drag.drag_surface() {
                icon.hide();
            }
            let (source, drag) = (source.clone(), drag.downgrade());
            glib::timeout_add_local_once(DROP_ANSWER_WITHIN, move || {
                if let (Some(source), Some(drag)) = (source.upgrade(), drag.upgrade())
                    && source.drag().as_ref() == Some(&drag)
                {
                    source.drag_cancel();
                }
            });
        });
    });
    // Also after a cancelled drag.
    source.connect_drag_end(|_, _, _| service::announce_dragging(false));
    tile.add_controller(source);

    // A click copies the file; a double click opens it. A drag cancels the
    // click, and the × has a click of its own.
    let click = gtk::GestureClick::new();
    click.connect_released(move |gesture, presses, x, y| {
        let Some(tile) = gesture.widget() else { return };
        let on = |button: &gtk::Button, target: &gtk::Widget| {
            target.is_ancestor(button) || target == button.upcast_ref::<gtk::Widget>()
        };
        if tile
            .pick(x, y, gtk::PickFlags::DEFAULT)
            .is_some_and(|target| {
                on(&remove, &target) || save.as_ref().is_some_and(|save| on(save, &target))
            })
        {
            return;
        }
        match presses {
            1 => {
                copy(&file, content_type.borrow().as_deref(), &tile);
                flash(&copied);
            }
            2 => open(&file, tile.root().and_downcast::<gtk::Window>()),
            _ => {}
        }
    });
    tile.add_controller(click);

    tile.upcast()
}

/// The rounded square the icon or thumbnail sits in.
fn preview_square(classes: &[&str]) -> gtk::Box {
    gtk::Box::builder()
        .width_request(PREVIEW_SIZE)
        .height_request(PREVIEW_SIZE)
        // Its icon expands within it only (see `tile_box`).
        .hexpand(false)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::End)
        // Clips the thumbnail to the rounded corners.
        .overflow(gtk::Overflow::Hidden)
        .css_classes(classes)
        .build()
}

/// The preview, centred at the bottom of a box with room for the × above
/// its top-right corner.
fn frame(
    preview: &impl IsA<gtk::Widget>,
    remove: Option<&gtk::Button>,
    save: Option<&gtk::Button>,
) -> gtk::Overlay {
    let room = gtk::Box::builder()
        .width_request(TILE_WIDTH)
        .height_request(FRAME_HEIGHT)
        .build();
    let frame = gtk::Overlay::builder().child(&room).build();
    preview.set_halign(gtk::Align::Center);
    preview.set_valign(gtk::Align::End);
    frame.add_overlay(preview);
    if let Some(remove) = remove {
        remove.set_halign(gtk::Align::Start);
        remove.set_valign(gtk::Align::Start);
        remove.set_size_request(REMOVE_SIZE, REMOVE_SIZE);
        // Its centre a few pixels inside the preview's corner.
        remove.set_margin_start((TILE_WIDTH + PREVIEW_SIZE) / 2 - REMOVE_SIZE + 6);
        frame.add_overlay(remove);
    }
    if let Some(save) = save {
        save.set_halign(gtk::Align::Start);
        save.set_valign(gtk::Align::Start);
        save.set_size_request(REMOVE_SIZE, REMOVE_SIZE);
        // The ×'s place mirrored, over the preview's other corner.
        save.set_margin_start(
            TILE_WIDTH - ((TILE_WIDTH + PREVIEW_SIZE) / 2 - REMOVE_SIZE + 6) - REMOVE_SIZE,
        );
        frame.add_overlay(save);
    }
    frame
}

/// Whether `file` sits right in isled's shelf folder: a copy the shelf keeps (and deletes) itself.
fn is_shelf_copy(file: &gio::File) -> bool {
    let own = glib::user_data_dir().join("isle").join("shelf");
    file.path()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .is_some_and(|parent| parent == own)
}

/// The frame above its name, in a fixed-width column.
fn tile_box(frame: &gtk::Overlay, name: &str, fresh: bool) -> gtk::Box {
    // NAME_WIDTH wide and two lines, as in the island: a tiny natural width keeps a long name from
    // widening the tile, and only a longer name loses its middle.
    let label = gtk::Label::builder()
        .label(name)
        .wrap(true)
        .wrap_mode(pango::WrapMode::WordChar)
        .lines(2)
        .justify(gtk::Justification::Center)
        .valign(gtk::Align::Start)
        .ellipsize(pango::EllipsizeMode::Middle)
        .width_request(NAME_WIDTH)
        .max_width_chars(1)
        .halign(gtk::Align::Center)
        .css_classes(["name"])
        .build();
    // Never wider than that: set outright, so the icon's expanding (to centre it) can't reach the
    // row and give one tile all the room left over.
    let tile = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(4)
        .width_request(TILE_WIDTH)
        .hexpand(false)
        .valign(gtk::Align::Center)
        .css_classes(["tile"])
        .build();
    if fresh {
        // Only once: a tile is moved about later, which would replay it.
        tile.add_css_class("fresh");
        let tile = tile.downgrade();
        glib::timeout_add_local_once(FRESH_FOR, move || {
            if let Some(tile) = tile.upgrade() {
                tile.remove_css_class("fresh");
            }
        });
    }
    tile.append(frame);
    tile.append(&label);
    tile
}

/// Shows "copied" over the preview for a moment.
fn flash(copied: &gtk::Box) {
    copied.add_css_class("shown");
    let copied = copied.downgrade();
    glib::timeout_add_local_once(COPIED_FOR, move || {
        if let Some(copied) = copied.upgrade() {
            copied.remove_css_class("shown");
        }
    });
}

/// Shows the file's thumbnail (or, for a picture, the picture itself), cut
/// to a square; otherwise its type's icon.
fn load_preview(
    file: &gio::File,
    preview: &gtk::Box,
    icon: &gtk::Image,
    content_type: &Rc<RefCell<Option<String>>>,
) {
    let (file, preview, icon, content_type) = (
        file.clone(),
        preview.clone(),
        icon.clone(),
        content_type.clone(),
    );
    glib::spawn_future_local(async move {
        let Ok(info) = file
            .query_info_future(
                &format!("standard::content-type,standard::icon,{THUMBNAIL_ATTRIBUTES}"),
                gio::FileQueryInfoFlags::NONE,
                glib::Priority::LOW,
            )
            .await
        else {
            return; // gone; isled drops it on the next refresh
        };
        let kind = info.content_type().map(|kind| kind.to_string());
        content_type.replace(kind.clone());
        if let Some(gicon) = info.icon() {
            icon.set_from_gicon(&gicon);
        }

        let picture = kind
            .as_deref()
            .is_some_and(|kind| kind.starts_with("image/"));
        // Pictures and videos fill the square; a document's page shows whole, as in Files.
        let whole = !picture
            && !kind
                .as_deref()
                .is_some_and(|kind| kind.starts_with("video/"));
        let mut source = info
            .attribute_byte_string("thumbnail::path")
            .map(PathBuf::from)
            .or_else(|| picture.then(|| file.path()).flatten());
        // None yet: the island makes one as Files would (a PDF's first page); looked for again meanwhile,
        // unless it is a kind no thumbnailer draws (text, an archive), which keeps its icon.
        let drawable = !kind
            .as_deref()
            .is_some_and(|kind| kind.starts_with("text/") || NO_THUMBNAIL.contains(&kind));
        let mut failed = thumbnail_failed(&info);
        for wait in THUMBNAIL_WAITS {
            if source.is_some() || !drawable || failed {
                break;
            }
            glib::timeout_future(wait).await;
            let info = file
                .query_info_future(
                    THUMBNAIL_ATTRIBUTES,
                    gio::FileQueryInfoFlags::NONE,
                    glib::Priority::LOW,
                )
                .await
                .ok();
            source = info
                .as_ref()
                .and_then(|info| info.attribute_byte_string("thumbnail::path"))
                .map(PathBuf::from);
            failed = info.is_some_and(|info| thumbnail_failed(&info));
        }
        let Some(source) = source else { return };
        let texture = gio::spawn_blocking(move || square_texture(&source, whole)).await;
        if let Ok(Some(texture)) = texture {
            let picture = gtk::Image::builder()
                .paintable(&texture)
                .pixel_size(PREVIEW_SIZE)
                .hexpand(true)
                .build();
            preview.remove(&icon);
            preview.append(&picture);
            preview.add_css_class(if whole { "page" } else { "thumbnail" });
        }
    });
}

/// Whether making a thumbnail already failed for the file as it is now; it is not tried again until
/// the file changes, as in Files (thumbnails.js).
fn thumbnail_failed(info: &gio::FileInfo) -> bool {
    info.boolean("thumbnail::failed") && info.boolean("thumbnail::is-valid")
}

/// The image at `path`, [`THUMBNAIL_PIXELS`] a side: its middle square, or `whole`, fitted on a clear square.
/// Runs on a worker thread: big photos take a while to decode.
fn square_texture(path: &Path, whole: bool) -> Option<gdk::Texture> {
    let (_, width, height) = gdk_pixbuf::Pixbuf::file_info(path)?;
    if width <= 0 || height <= 0 {
        return None;
    }
    let side = THUMBNAIL_PIXELS;
    if whole {
        let scale = f64::from(side) / f64::from(width.max(height));
        let fitted_width = ((f64::from(width) * scale).round() as i32).max(1);
        let fitted_height = ((f64::from(height) * scale).round() as i32).max(1);
        let page = gdk_pixbuf::Pixbuf::from_file_at_scale(path, fitted_width, fitted_height, false)
            .ok()?
            .add_alpha(false, 0, 0, 0)
            .ok()?;
        let square = gdk_pixbuf::Pixbuf::new(gdk_pixbuf::Colorspace::Rgb, true, 8, side, side)?;
        square.fill(0);
        page.copy_area(
            0,
            0,
            fitted_width,
            fitted_height,
            &square,
            (side - fitted_width) / 2,
            (side - fitted_height) / 2,
        );
        #[allow(deprecated)] // the replacement needs GTK 4.20
        return Some(gdk::Texture::for_pixbuf(&square));
    }
    let scale = f64::from(side) / f64::from(width.min(height));
    let scaled_width = ((f64::from(width) * scale).round() as i32).max(side);
    let scaled_height = ((f64::from(height) * scale).round() as i32).max(side);
    let pixbuf =
        gdk_pixbuf::Pixbuf::from_file_at_scale(path, scaled_width, scaled_height, false).ok()?;
    let square = pixbuf
        .new_subpixbuf(
            (scaled_width - side) / 2,
            (scaled_height - side) / 2,
            side,
            side,
        )
        .copy()?;
    #[allow(deprecated)] // the replacement needs GTK 4.20
    Some(gdk::Texture::for_pixbuf(&square))
}

/// Copies the file: a picture as the image itself (what chats paste best), else as a file.
fn copy(file: &gio::File, content_type: Option<&str>, widget: &gtk::Widget) {
    let clipboard = widget.clipboard();
    let as_file = file_content(file);
    let picture = content_type.is_some_and(|kind| PICTURE_TYPES.contains(&kind));
    let Some(path) = file.path().filter(|_| picture) else {
        clipboard.set_content(Some(&as_file)).ok();
        return;
    };
    // A PNG is offered as its own bytes, never decoded. Other kinds are offered as PNG too, which
    // apps that take no other format need, so they go through a texture.
    if content_type == Some("image/png") {
        glib::spawn_future_local(async move {
            let content = match gio::spawn_blocking(move || std::fs::read(path)).await {
                Ok(Ok(png)) => {
                    gdk::ContentProvider::for_bytes("image/png", &glib::Bytes::from_owned(png))
                }
                _ => as_file,
            };
            clipboard.set_content(Some(&content)).ok();
        });
        return;
    }
    glib::spawn_future_local(async move {
        match gio::spawn_blocking(move || gdk::Texture::from_filename(path)).await {
            Ok(Ok(texture)) => clipboard.set_texture(&texture),
            _ => {
                clipboard.set_content(Some(&as_file)).ok();
            }
        }
    });
}

/// A file for the clipboard; no plain text, or text fields would paste its path.
fn file_content(file: &gio::File) -> gdk::ContentProvider {
    let uri = file.uri();
    gdk::ContentProvider::new_union(&[
        gdk::ContentProvider::for_bytes(
            "x-special/gnome-copied-files",
            &glib::Bytes::from_owned(format!("copy\n{uri}").into_bytes()),
        ),
        gdk::ContentProvider::for_bytes(
            "text/uri-list",
            &glib::Bytes::from_owned(format!("{uri}\r\n").into_bytes()),
        ),
    ])
}

/// Opens the file in its default app.
fn open(file: &gio::File, parent: Option<gtk::Window>) {
    let launcher = gtk::FileLauncher::new(Some(file));
    launcher.launch(parent.as_ref(), None::<&gio::Cancellable>, |result| {
        if let Err(err) = result {
            warn!("could not open the file: {err}");
        }
    });
}
