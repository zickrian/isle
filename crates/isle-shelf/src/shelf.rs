// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The see-through shelf window: the files' tiles and the drop zone; isled owns the list.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gtk::{gdk, gdk_pixbuf, gio, glib, prelude::*};
use gtk4 as gtk;
use log::warn;
use serde::Deserialize;

use crate::{service, tile, x11};

const DAEMON: &str = "io.github.zickrian.isle.Daemon";
const DAEMON_PATH: &str = "/io/github/zickrian/isle/Daemon";
const SHELF_INTERFACE: &str = "io.github.zickrian.isle.Shelf1";
/// The island's own shelf icon, so the empty shelf looks the same in both, whatever the icon theme.
const SHELF_ICON: &[u8] = include_bytes!("../../../gnome-extension/icons/isle-shelf.svg");
/// isled keeps this many files; a full shelf turns drops away.
const CAPACITY: usize = 6;
/// Hidden this long, the helper quits, its memory freed; the extension's next Show starts it again.
const IDLE_QUIT_SECS: u32 = 20;
/// Files dropped this recently (µs) are new on the shelf: their tiles pop in as they land.
const JUST_DROPPED_US: i64 = 3_000_000;

/// Why the files dragged over the window can't all land.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Refusal {
    /// None of them is on this computer (links, or files online).
    NotLocal,
    /// More than the shelf has room for.
    NoRoom,
}

/// One file on the shelf, as isled describes it.
#[derive(Debug, Clone, Deserialize)]
pub struct Item {
    pub uri: String,
    pub name: String,
}

/// The shelf window; clones share it.
#[derive(Clone)]
pub struct ShelfWindow(Rc<Inner>);

/// The widgets and the state behind the window.
struct Inner {
    window: gtk::Window,
    stack: gtk::Stack,
    tiles: gtk::Box,
    empty_title: gtk::Label,
    empty_hint: gtk::Label,
    daemon: RefCell<Option<gio::DBusProxy>>,
    /// Where the window belongs (x, y, width, height), kept for re-placing.
    area: Cell<Option<(i32, i32, i32, i32)>>,
    /// The files' area inside the window (x, y, width, height): with `Place`, the only part that takes
    /// the pointer until a file is dragged in, so the island around it keeps its clicks.
    input: Cell<Option<(i32, i32, i32, i32)>>,
    /// The files on the shelf, newest first.
    items: RefCell<Vec<Item>>,
    /// Each file's tile, kept while the file stays, so its thumbnail loads
    /// once; files without one are new and fade in.
    tile_cache: RefCell<HashMap<String, gtk::Widget>>,
    /// A file is being dragged towards the island (the extension says so).
    near: Cell<bool>,
    /// A file is being dragged over this window.
    over: Cell<bool>,
    /// The local files dragged over the window, once read; none at all if it carries only others.
    dragged: RefCell<Option<Vec<String>>>,
    /// When files were last dropped here (monotonic µs): only their tiles pop in, not a list read afresh.
    dropped_at: Cell<i64>,
    /// Quits the helper once hidden for `IDLE_QUIT_SECS`.
    idle_quit: RefCell<Option<glib::SourceId>>,
}

impl ShelfWindow {
    /// Builds the window, takes drops and connects to isled; shown only once the extension asks.
    pub fn new(app: &gtk::Application) -> Self {
        let window = gtk::Window::builder()
            .application(app)
            .title("Isle shelf")
            .decorated(false)
            .resizable(false)
            .css_classes(["isle-shelf"])
            .build();
        window.connect_realize(|window| {
            if let Err(err) = x11::make_override_redirect(window) {
                warn!("could not make the shelf window float above the shell: {err}");
            }
        });

        // From the left at their own width, as in the island: the row never stretches a tile.
        let tiles = gtk::Box::builder()
            .orientation(gtk::Orientation::Horizontal)
            .spacing(6)
            .halign(gtk::Align::Start)
            .valign(gtk::Align::Center)
            .build();
        let scroller = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Automatic)
            .vscrollbar_policy(gtk::PolicyType::Never)
            .hexpand(true)
            .child(&tiles)
            .build();
        let filled = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        filled.append(&scroller);

        let empty_title = gtk::Label::builder().css_classes(["empty-title"]).build();
        let empty_hint = gtk::Label::builder().css_classes(["empty-hint"]).build();
        // No crossfade: a new file's tile fades in by itself, and the two
        // states would show through each other meanwhile.
        let stack = gtk::Stack::builder().css_classes(["drop-area"]).build();
        stack.add_named(&filled, Some("files"));
        stack.add_named(&empty_state(&empty_title, &empty_hint), Some("empty"));
        window.set_child(Some(&stack));

        let shelf = Self(Rc::new(Inner {
            window,
            stack,
            tiles,
            empty_title,
            empty_hint,
            daemon: RefCell::default(),
            area: Cell::default(),
            items: RefCell::default(),
            tile_cache: RefCell::default(),
            input: Cell::default(),
            near: Cell::default(),
            over: Cell::default(),
            dragged: RefCell::default(),
            dropped_at: Cell::new(i64::MIN / 2),
            idle_quit: RefCell::default(),
        }));
        shelf.accept_drops();
        let weak = Rc::downgrade(&shelf.0);
        shelf.0.window.connect_map(move |window| {
            if let Some(inner) = weak.upgrade() {
                // Just after GDK's own placement on mapping, so this one wins.
                let shelf = ShelfWindow(inner);
                glib::idle_add_local_once(move || {
                    shelf.place();
                    shelf.limit_input();
                });
            }
            announce_first_frame(window);
        });
        // Another scale (GNOME's arriving after the helper started, or `set_scale`): the same place in X pixels.
        let weak = Rc::downgrade(&shelf.0);
        shelf.0.window.connect_scale_factor_notify(move |window| {
            if let Some(inner) = weak.upgrade()
                && window.is_mapped()
            {
                ShelfWindow(inner).place();
            }
        });
        shelf.connect_daemon();

        shelf.render();
        // Started hidden (by any call, not only Show): it quits unless shown within `IDLE_QUIT_SECS`.
        shelf.hide();
        shelf
    }

    /// Shows the window over the given area of the screen (logical pixels).
    pub fn show_at(&self, x: i32, y: i32, width: i32, height: i32) {
        self.show_over((x, y, width, height), (x, y, width, height));
    }

    /// Like `show_over`, for the whole time the tab is open: the window stays put as a file is dragged
    /// in (nothing moves or jumps), and only `area` takes the pointer until one is.
    pub fn place_over(&self, window: (i32, i32, i32, i32), area: (i32, i32, i32, i32)) {
        let (x, y, ..) = window;
        let (ax, ay, awidth, aheight) = area;
        self.0.input.set(Some((ax - x, ay - y, awidth, aheight)));
        self.set_margins(window, area);
        self.place_window(window);
        self.limit_input();
    }

    /// Shows the window over `window`, with the files in `area` inside it; the rest is see-through
    /// and still takes drops.
    pub fn show_over(&self, window: (i32, i32, i32, i32), area: (i32, i32, i32, i32)) {
        self.0.input.set(None);
        self.set_margins(window, area);
        self.place_window(window);
        self.limit_input();
    }

    /// Insets the files' area within the window.
    fn set_margins(
        &self,
        (x, y, width, height): (i32, i32, i32, i32),
        (ax, ay, awidth, aheight): (i32, i32, i32, i32),
    ) {
        let stack = &self.0.stack;
        stack.set_margin_start(ax - x);
        stack.set_margin_top(ay - y);
        stack.set_margin_end(x + width - (ax + awidth));
        stack.set_margin_bottom(y + height - (ay + aheight));
    }

    /// Lets the pointer through outside the files' area, but while a file is dragged in.
    fn limit_input(&self) {
        let Some(surface) = self.0.window.surface() else {
            return;
        };
        match self.0.input.get() {
            Some((x, y, width, height)) if !self.0.near.get() => {
                let rect = gtk::cairo::RectangleInt::new(x, y, width, height);
                surface.set_input_region(Some(&gtk::cairo::Region::create_rectangle(&rect)));
            }
            _ => surface.set_input_region(None),
        }
    }

    /// Sizes and shows the window at the given screen rectangle.
    fn place_window(&self, (x, y, width, height): (i32, i32, i32, i32)) {
        if let Some(quit) = self.0.idle_quit.take() {
            quit.remove();
        }
        self.0.area.set(Some((x, y, width, height)));
        let window = &self.0.window;
        window.set_default_size(width, height);
        window.set_size_request(width, height);
        window.present();
        // Files may have been deleted since the shelf was last shown.
        self.call("Refresh", None);
        // Already mapped (moved, not reshown): place it now. Otherwise the map
        // handler does, since mapping restores where GDK last had the window.
        if window.is_mapped() {
            self.place();
        }
    }

    /// Moves the X window where the extension wants it.
    fn place(&self) {
        let Some((x, y, width, height)) = self.0.area.get() else {
            return;
        };
        if let Err(err) = x11::place(&self.0.window, x, y, width, height) {
            warn!("could not position the shelf window: {err}");
        }
    }

    /// The scale GTK draws at: X pixels per logical one.
    pub fn scale(&self) -> i32 {
        self.0.window.scale_factor()
    }

    /// Draws at `scale` from now on, whatever GNOME's settings say.
    pub fn set_scale(&self, scale: i32) {
        let display = WidgetExt::display(&self.0.window);
        match display.downcast_ref::<gdk4_x11::X11Display>() {
            #[allow(deprecated)] // X11 itself is deprecated since GTK 4.18; this still works
            Some(display) => display.set_surface_scale(scale),
            None => warn!("the shelf window is not on X11; its scale stays"),
        }
    }

    /// Hides the window; the helper quits if it stays hidden for `IDLE_QUIT_SECS`.
    pub fn hide(&self) {
        self.0.window.set_visible(false);
        if self.0.idle_quit.borrow().is_some() {
            return;
        }
        let weak = Rc::downgrade(&self.0);
        let quit = glib::timeout_add_seconds_local_once(IDLE_QUIT_SECS, move || {
            let Some(inner) = weak.upgrade() else { return };
            inner.idle_quit.take();
            if !inner.window.is_visible()
                && let Some(app) = inner.window.application()
            {
                log::info!("the shelf stayed hidden; quitting until it is needed");
                app.quit();
            }
        });
        self.0.idle_quit.replace(Some(quit));
    }

    /// Whether a file is being dragged towards the island: the shelf then
    /// shows where it will land before the pointer even gets here.
    pub fn set_dropping(&self, dropping: bool) {
        // Kept running while a drag is on its way; free to quit again once it is gone.
        if dropping {
            if let Some(quit) = self.0.idle_quit.take() {
                quit.remove();
            }
        } else if !self.0.window.is_visible() {
            self.hide();
        }
        if self.0.near.replace(dropping) != dropping {
            self.limit_input();
            self.render();
        }
    }

    /// Why the files dragged in can't all land, if so; files already on the shelf only move to the front.
    fn refusal(&self) -> Option<Refusal> {
        let items = self.0.items.borrow();
        let fresh = match &*self.0.dragged.borrow() {
            Some(uris) if uris.is_empty() => return Some(Refusal::NotLocal),
            Some(uris) => uris
                .iter()
                .filter(|uri| !items.iter().any(|item| item.uri == **uri))
                .count(),
            // Not read yet: as long as there is room for one.
            None => 1,
        };
        (fresh > 0 && items.len() + fresh > CAPACITY).then_some(Refusal::NoRoom)
    }

    /// No action for a tile dragged out of here, or for files that can't land.
    fn accepts(&self, target: &gtk::DropTarget) -> gdk::DragAction {
        if dragged_from_here(target) || self.refusal().is_some() {
            gdk::DragAction::empty()
        } else {
            gdk::DragAction::COPY
        }
    }

    /// Files dropped anywhere on the window go onto the shelf.
    fn accept_drops(&self) {
        let target = gtk::DropTarget::new(gdk::FileList::static_type(), gdk::DragAction::COPY);
        // Read while hovering, so the island can light in the files' colours before the drop.
        target.set_preload(true);
        let weak = Rc::downgrade(&self.0);
        target.connect_value_notify(move |target| {
            let Some(inner) = weak.upgrade() else { return };
            if dragged_from_here(target) {
                return;
            }
            let files = dragged_files(target);
            // All of them, so the island can tell links and files online from local ones.
            let uris: Vec<String> = files
                .as_ref()
                .map(|files| {
                    files
                        .files()
                        .iter()
                        .map(|file| file.uri().to_string())
                        .collect()
                })
                .unwrap_or_default();
            service::announce_hovering(&uris);
            inner.dragged.replace(files.as_ref().map(local_uris));
            ShelfWindow(inner).render();
        });
        // Files that can't all land are refused (the island's hint says why), once they are read.
        let weak = Rc::downgrade(&self.0);
        target.connect_enter(move |target, _, _| {
            let Some(inner) = weak.upgrade() else {
                return gdk::DragAction::empty();
            };
            let shelf = ShelfWindow(inner);
            if !dragged_from_here(target) {
                // What an earlier drag left must not count, while this one's files are read.
                shelf
                    .0
                    .dragged
                    .replace(dragged_files(target).as_ref().map(local_uris));
                shelf.0.over.set(true);
                shelf.render();
            }
            shelf.accepts(target)
        });
        let weak = Rc::downgrade(&self.0);
        target.connect_motion(move |target, _, _| match weak.upgrade() {
            Some(inner) => ShelfWindow(inner).accepts(target),
            None => gdk::DragAction::empty(),
        });
        let weak = Rc::downgrade(&self.0);
        target.connect_leave(move |_| {
            if let Some(inner) = weak.upgrade()
                && inner.over.replace(false)
            {
                ShelfWindow(inner).render();
            }
        });

        let weak = Rc::downgrade(&self.0);
        target.connect_drop(move |target, value, _, _| {
            let Some(inner) = weak.upgrade() else {
                return false;
            };
            if dragged_from_here(target) {
                return false;
            }
            let Ok(files) = value.get::<gdk::FileList>() else {
                return false;
            };
            let uris = local_uris(&files);
            let shelf = ShelfWindow(inner);
            shelf.0.dragged.replace(Some(uris.clone()));
            let refused = shelf.refusal().is_some();
            shelf.0.over.set(false);
            shelf.render();
            if refused {
                return false;
            }
            // The island flashes its outline as the file lands (files.js).
            shelf.0.dropped_at.set(glib::monotonic_time());
            shelf.call("Add", Some(&(uris,).to_variant()));
            true
        });
        self.0.window.add_controller(target);
    }

    /// Follows isled's list of shelf files, redrawing as it changes.
    fn connect_daemon(&self) {
        let weak = Rc::downgrade(&self.0);
        gio::DBusProxy::for_bus(
            gio::BusType::Session,
            gio::DBusProxyFlags::DO_NOT_AUTO_START_AT_CONSTRUCTION,
            None,
            DAEMON,
            DAEMON_PATH,
            SHELF_INTERFACE,
            None::<&gio::Cancellable>,
            move |result| {
                let Some(inner) = weak.upgrade() else { return };
                let proxy = match result {
                    Ok(proxy) => proxy,
                    Err(err) => {
                        warn!("could not reach isled: {err}");
                        return;
                    }
                };
                let shelf = ShelfWindow(inner);
                let weak = Rc::downgrade(&shelf.0);
                // The typed signal helper requires `Send`; this one stays on
                // the main thread like the rest of the UI.
                proxy.connect_local("g-properties-changed", false, move |values| {
                    let proxy = values[0].get::<gio::DBusProxy>().ok()?;
                    // While isled restarts the last list stays, or its tiles would all go and pop in again.
                    let items = items(&proxy)?;
                    if let Some(inner) = weak.upgrade() {
                        inner.items.replace(items);
                        let shelf = ShelfWindow(inner);
                        // Only what was just dropped here pops in: a list read again (the island asks as the
                        // Files tab opens, the helper started anew) shows its tiles as they are, not arriving.
                        let fresh =
                            glib::monotonic_time() - shelf.0.dropped_at.get() < JUST_DROPPED_US;
                        shelf.render_tiles(fresh);
                        shelf.render();
                    }
                    None
                });
                shelf.0.items.replace(items(&proxy).unwrap_or_default());
                // What is there at start is not new.
                shelf.render_tiles(false);
                shelf.render();
                shelf.0.daemon.replace(Some(proxy));
            },
        );
    }

    /// Calls a method on isled's shelf; a failure is only logged.
    fn call(&self, method: &str, args: Option<&glib::Variant>) {
        let Some(proxy) = self.0.daemon.borrow().clone() else {
            return;
        };
        let method = method.to_owned();
        proxy.call(
            &method.clone(),
            args,
            gio::DBusCallFlags::NONE,
            -1,
            None::<&gio::Cancellable>,
            move |result| {
                if let Err(err) = result {
                    warn!("shelf {method} failed: {err}");
                }
            },
        );
    }

    /// The drop area's look and words for the current drag.
    fn render(&self) {
        let inner = &self.0;
        let count = inner.items.borrow().len();
        let dragging = inner.near.get() || inner.over.get();
        let refusal = self.refusal().filter(|_| dragging);
        // The one class with a rule (style.css): the window must draw while a file comes near.
        set_class(&inner.stack, "dropping", dragging);

        // The tiles stay as they are while a file comes in: nothing makes room or moves.
        let (title, hint) = if inner.over.get() && refusal == Some(Refusal::NotLocal) {
            (
                "Only files on this computer",
                "Links and files online can't be kept",
            )
        } else if inner.over.get() && refusal.is_some() {
            ("Too many files", "The shelf holds six at a time")
        } else if inner.over.get() {
            (
                "Release to add it",
                "Then drag it into any app, or click to copy it",
            )
        } else if dragging {
            (
                "Drop to add it",
                "Then drag it into any app, or click to copy it",
            )
        } else {
            (
                "No files on the shelf",
                "Drop files here, then drag them into any app",
            )
        };
        inner.empty_title.set_label(title);
        inner.empty_hint.set_label(hint);
        inner
            .stack
            .set_visible_child_name(if count == 0 { "empty" } else { "files" });
    }

    /// Whether the extension saves files on Save: the tiles are made again, with or without ↓.
    pub fn set_saves(&self, saves: bool) {
        if tile::set_saves(saves) {
            self.0
                .tile_cache
                .take()
                .into_values()
                .for_each(|old| self.0.tiles.remove(&old));
            self.render_tiles(false);
        }
    }

    /// Lays out a tile per file, newest first. A file already shown keeps its tile where it is, or moves it;
    /// only new files get tiles (fading in with `mark_new`) and only gone ones lose theirs, so nothing else
    /// is taken down and put back, nor replays its arrival.
    fn render_tiles(&self, mark_new: bool) {
        let inner = &self.0;
        let mut old = inner.tile_cache.take();
        let mut cache = HashMap::new();
        let mut previous: Option<gtk::Widget> = None;
        for item in inner.items.borrow().iter() {
            let tile = old.remove(&item.uri).unwrap_or_else(|| {
                let weak = Rc::downgrade(&self.0);
                tile::new(item, mark_new, move |uri| {
                    if let Some(inner) = weak.upgrade() {
                        ShelfWindow(inner).call("Remove", Some(&(uri,).to_variant()));
                    }
                })
            });
            if tile.parent().is_none() {
                inner.tiles.insert_child_after(&tile, previous.as_ref());
            } else if tile.prev_sibling() != previous {
                inner.tiles.reorder_child_after(&tile, previous.as_ref());
            }
            previous = Some(tile.clone());
            cache.insert(item.uri.clone(), tile);
        }
        for gone in old.into_values() {
            inner.tiles.remove(&gone);
        }
        inner.tile_cache.replace(cache);
    }
}

/// Says `Drawn` once the window has drawn its first frame since it was shown, so the extension fades in
/// what GTK drew, never an empty window.
fn announce_first_frame(window: &gtk::Window) {
    let Some(clock) = window.frame_clock() else {
        service::announce_drawn();
        return;
    };
    let handler = Rc::new(Cell::new(None));
    let once = handler.clone();
    handler.set(Some(clock.connect_after_paint(move |clock| {
        if let Some(id) = once.take() {
            clock.disconnect(id);
        }
        service::announce_drawn();
    })));
}

/// The files' URIs, local ones only: isled keeps nothing else.
fn local_uris(files: &gdk::FileList) -> Vec<String> {
    files
        .files()
        .iter()
        .filter(|file| file.is_native())
        .map(|file| file.uri().to_string())
        .collect()
}

/// The files dragged over the window, once read.
fn dragged_files(target: &gtk::DropTarget) -> Option<gdk::FileList> {
    target
        .value()
        .and_then(|value| value.get::<gdk::FileList>().ok())
}

/// Whether the drag is a tile carried out of this window, not a file coming in.
fn dragged_from_here(target: &gtk::DropTarget) -> bool {
    target.current_drop().and_then(|drop| drop.drag()).is_some()
}

/// Adds or removes a CSS class.
fn set_class(widget: &impl IsA<gtk::Widget>, class: &str, on: bool) {
    if on {
        widget.add_css_class(class);
    } else {
        widget.remove_css_class(class);
    }
}

/// The shelf's items from the proxy's cached `Items` property (JSON); none while isled is away.
fn items(proxy: &gio::DBusProxy) -> Option<Vec<Item>> {
    proxy
        .cached_property("Items")
        .and_then(|value| value.get::<String>())
        .and_then(|json| serde_json::from_str(&json).ok())
}

/// [`SHELF_ICON`] at `size` px, drawn at twice that so it stays sharp on a HiDPI screen.
fn shelf_icon(size: i32) -> gtk::Image {
    let image = gtk::Image::builder()
        .pixel_size(size)
        .css_classes(["empty-icon"])
        .build();
    let stream = gio::MemoryInputStream::from_bytes(&glib::Bytes::from_static(SHELF_ICON));
    match gdk_pixbuf::Pixbuf::from_stream_at_scale(
        &stream,
        size * 2,
        size * 2,
        true,
        gio::Cancellable::NONE,
    ) {
        Ok(pixbuf) => image.set_paintable(Some(&gdk::Texture::for_pixbuf(&pixbuf))),
        Err(err) => {
            warn!("could not draw the shelf icon: {err}");
            image.set_icon_name(Some("folder-download-symbolic"));
        }
    }
    image
}

/// The icon, title and hint shown when the shelf has no files.
fn empty_state(title: &gtk::Label, hint: &gtk::Label) -> gtk::Box {
    let box_ = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(4)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .css_classes(["empty"])
        .build();
    box_.append(&shelf_icon(24));
    box_.append(title);
    box_.append(hint);
    box_
}
