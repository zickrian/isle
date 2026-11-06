// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! `isle-shelf`: the shelf's drag-and-drop window, as Shell widgets can't DnD with apps.
//! An X11 override-redirect window: the only kind GNOME Shell stacks above the island.

mod service;
mod shelf;
mod tile;
mod x11;

use std::env;

use gtk::{gdk, gio, glib, prelude::*};
use gtk4 as gtk;

use crate::shelf::ShelfWindow;

const APP_ID: &str = "io.github.zickrian.isle.ShelfWindow";

/// Starts the GTK app on X11 and the CPU renderer, then waits for D-Bus calls.
fn main() -> glib::ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    // SAFETY: called before GTK starts and before any other thread exists.
    unsafe { env::set_var("GDK_BACKEND", "x11") };
    // This small window uses about a third less memory rendered on the CPU than
    // the GPU. A renderer set by the user is kept.
    if env::var_os("GSK_RENDERER").is_none() {
        // SAFETY: as above.
        unsafe { env::set_var("GSK_RENDERER", "cairo") };
        // Nor are OpenGL and Vulkan loaded, which the CPU renderer never uses (GDK_DEBUG before
        // GTK 4.16, GDK_DISABLE since), unless the user set them.
        let (variable, value) = if gtk::minor_version() < 16 {
            ("GDK_DEBUG", "gl-disable,vulkan-disable")
        } else {
            ("GDK_DISABLE", "gl,vulkan")
        };
        if env::var_os(variable).is_none() {
            // SAFETY: as above.
            unsafe { env::set_var(variable, value) };
        }
    }

    // The bus name is owned by hand (not through GApplication) so the
    // interface is exported before anyone can call it.
    let app = gtk::Application::builder()
        .application_id(APP_ID)
        .flags(gio::ApplicationFlags::NON_UNIQUE)
        .build();

    app.connect_startup(|app| {
        load_css();
        if let Err(err) = start_service(app) {
            log::error!("could not offer the shelf window on D-Bus: {err}");
            app.quit();
        }
        // Stay running while hidden, waiting for the extension to call Show.
        std::mem::forget(app.hold());
    });
    app.connect_activate(|_| {});
    app.run()
}

/// Exports the shelf window's D-Bus interface, then takes the bus name; quits if it is taken.
fn start_service(app: &gtk::Application) -> Result<(), glib::Error> {
    let connection = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>)?;
    service::register(&connection, ShelfWindow::new(app))?;
    let app = app.clone();
    // The name stays owned for as long as the process runs.
    gio::bus_own_name_on_connection(
        &connection,
        APP_ID,
        gio::BusNameOwnerFlags::DO_NOT_QUEUE,
        |_, _| {},
        move |_, name| {
            log::info!("{name} is taken; another isle-shelf is running");
            app.quit();
        },
    );
    Ok(())
}

/// Applies the shelf's stylesheet to the whole display, above the user's own `gtk.css`.
///
/// The window must look like the island beneath it whatever the GTK theme: a theme installed in
/// `~/.config/gtk-4.0/gtk.css` loads at USER priority, above APPLICATION, and its rules (a coloured
/// frame on any drop target, its own button size and corners) drew over the island. This provider
/// only reaches this process's one window.
fn load_css() {
    let provider = gtk::CssProvider::new();
    provider.load_from_string(include_str!("style.css"));
    gtk::style_context_add_provider_for_display(
        &gdk::Display::default().expect("GTK has no default display"),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_USER + 1,
    );
}
