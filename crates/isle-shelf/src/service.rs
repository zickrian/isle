// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The D-Bus interface the GNOME extension uses to place the window.

use gtk::{gio, glib, prelude::*};
use gtk4 as gtk;

use crate::shelf::ShelfWindow;

const INTERFACE: &str = r#"
<node>
  <interface name="io.github.zickrian.isle.ShelfWindow1">
    <!-- Places are in logical pixels, as GTK's: the extension divides the stage's by its scale. -->
    <method name="Show">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
      <arg name="width" type="i" direction="in"/>
      <arg name="height" type="i" direction="in"/>
    </method>
    <!-- While a file is dragged in, the window covers the whole island (x…height), so a drop lands
         anywhere on it; the files stay where the island's tab is (ax…aheight). -->
    <method name="ShowOver">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
      <arg name="width" type="i" direction="in"/>
      <arg name="height" type="i" direction="in"/>
      <arg name="ax" type="i" direction="in"/>
      <arg name="ay" type="i" direction="in"/>
      <arg name="awidth" type="i" direction="in"/>
      <arg name="aheight" type="i" direction="in"/>
    </method>
    <!-- The same, for as long as the tab is open (1.0.7): the window never moves when a file is
         dragged in, and only the files' area takes the pointer until one is. -->
    <method name="Place">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
      <arg name="width" type="i" direction="in"/>
      <arg name="height" type="i" direction="in"/>
      <arg name="ax" type="i" direction="in"/>
      <arg name="ay" type="i" direction="in"/>
      <arg name="awidth" type="i" direction="in"/>
      <arg name="aheight" type="i" direction="in"/>
    </method>
    <method name="Hide"/>
    <!-- 1.5.4: the extension saves files on Save; until it says so (an older one), no ↓ is shown. -->
    <method name="SetSaves">
      <arg name="saves" type="b" direction="in"/>
    </method>
    <!-- 1.1: the scale GTK draws at (X pixels per logical one), and setting it: the extension sets
         it if the window comes out another size than asked, as when GTK started before GNOME's. -->
    <method name="Scale">
      <arg name="scale" type="i" direction="out"/>
    </method>
    <method name="SetScale">
      <arg name="scale" type="i" direction="in"/>
    </method>
    <!-- A file is being dragged towards the island: show where it will
         land before the pointer gets to the window. -->
    <method name="SetDropping">
      <arg name="dropping" type="b" direction="in"/>
    </method>
    <!-- A file is being dragged out: the island must stay open meanwhile,
         or hiding this window would end the drag. -->
    <signal name="Dragging">
      <arg name="active" type="b"/>
    </signal>
    <!-- The files dragged over the window, so the island can light in their
         colours (and since 1.1 links and files online too, which can't land); none once they leave. -->
    <signal name="Hovering">
      <arg name="uris" type="as"/>
    </signal>
    <!-- 1.5: the window has drawn its first frame since it was shown, so the extension fades in
         something drawn, never an empty (black) window. -->
    <signal name="Drawn"/>
    <!-- 1.5.4: ↓ was pressed on a file the shelf keeps itself; the extension saves it into Downloads. -->
    <signal name="Save">
      <arg name="uri" type="s"/>
    </signal>
  </interface>
</node>"#;

/// The largest scale `SetScale` takes.
const MAX_SCALE: i32 = 4;
const OBJECT_PATH: &str = "/io/github/zickrian/isle/ShelfWindow";
const INTERFACE_NAME: &str = "io.github.zickrian.isle.ShelfWindow1";

/// Exports the interface on `connection`.
pub fn register(connection: &gio::DBusConnection, window: ShelfWindow) -> Result<(), glib::Error> {
    let info = gio::DBusNodeInfo::for_xml(INTERFACE)?
        .lookup_interface(INTERFACE_NAME)
        .expect("the interface is defined above");

    connection
        .register_object(OBJECT_PATH, &info)
        .method_call(move |_, _, _, _, method, params, invocation| match method {
            "Show" => match params.get::<(i32, i32, i32, i32)>() {
                Some((x, y, width, height)) if width > 0 && height > 0 => {
                    window.show_at(x, y, width, height);
                    invocation.return_value(None);
                }
                _ => {
                    invocation.return_error(gio::DBusError::InvalidArgs, "expected a positive size")
                }
            },
            "ShowOver" | "Place" => {
                match params.get::<(i32, i32, i32, i32, i32, i32, i32, i32)>() {
                    Some((x, y, width, height, ax, ay, awidth, aheight))
                        if awidth > 0
                            && aheight > 0
                            && ax >= x
                            && ay >= y
                            && ax + awidth <= x + width
                            && ay + aheight <= y + height =>
                    {
                        let (rect, area) = ((x, y, width, height), (ax, ay, awidth, aheight));
                        if method == "Place" {
                            window.place_over(rect, area);
                        } else {
                            window.show_over(rect, area);
                        }
                        invocation.return_value(None);
                    }
                    _ => invocation.return_error(
                        gio::DBusError::InvalidArgs,
                        "expected an area inside the window",
                    ),
                }
            }
            "Scale" => invocation.return_value(Some(&(window.scale(),).to_variant())),
            "SetScale" => match params.get::<(i32,)>() {
                Some((scale,)) if (1..=MAX_SCALE).contains(&scale) => {
                    window.set_scale(scale);
                    invocation.return_value(None);
                }
                _ => invocation
                    .return_error(gio::DBusError::InvalidArgs, "expected a scale of 1 to 4"),
            },
            "Hide" => {
                window.hide();
                invocation.return_value(None);
            }
            "SetSaves" => match params.get::<(bool,)>() {
                Some((saves,)) => {
                    window.set_saves(saves);
                    invocation.return_value(None);
                }
                None => invocation.return_error(gio::DBusError::InvalidArgs, "expected a boolean"),
            },
            "SetDropping" => match params.get::<(bool,)>() {
                Some((dropping,)) => {
                    window.set_dropping(dropping);
                    invocation.return_value(None);
                }
                None => invocation.return_error(gio::DBusError::InvalidArgs, "expected a boolean"),
            },
            _ => invocation.return_error(gio::DBusError::UnknownMethod, method),
        })
        .build()?;
    Ok(())
}

/// Tells the extension whether a file is being dragged out of the shelf.
pub fn announce_dragging(active: bool) {
    announce("Dragging", &(active,).to_variant());
}

/// Tells the extension which files are dragged over the window (none once they leave).
pub fn announce_hovering(uris: &[String]) {
    announce("Hovering", &(uris,).to_variant());
}

/// Tells the extension the window has drawn since it was shown.
pub fn announce_drawn() {
    announce("Drawn", &().to_variant());
}

/// Asks the extension to save the file at `uri` into Downloads.
pub fn announce_save(uri: &str) {
    announce("Save", &(uri,).to_variant());
}

/// Emits one of the interface's signals; a failure is only logged.
fn announce(signal: &str, args: &glib::Variant) {
    let result = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>)
        .and_then(|bus| bus.emit_signal(None, OBJECT_PATH, INTERFACE_NAME, signal, Some(args)));
    if let Err(err) = result {
        log::warn!("could not announce {signal}: {err}");
    }
}
