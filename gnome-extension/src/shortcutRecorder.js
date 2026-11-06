// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Super+V into Settings' shortcut sheet. GNOME Shell takes Super+V (its calendar shortcut) before any window sees it,
// and Isle answers it there (shell.js); so while the sheet waits for a shortcut it owns this name on the session bus,
// and the Super+V Isle is given goes to it rather than opening the island. Plain Gio: used by prefs.js and shell.js.

import Gio from 'gi://Gio';

export const RECORDER_NAME = 'io.github.zickrian.isle.ShortcutRecorder';
export const RECORDER_PATH = '/io/github/zickrian/isle/ShortcutRecorder';
const RECORDER_INTERFACE = 'io.github.zickrian.isle.ShortcutRecorder';
const RECORDER_XML = `<node><interface name="${RECORDER_INTERFACE}"><method name="SuperV"/></interface></node>`;

/** Takes the name for as long as a sheet waits; `onSuperV` runs on Super+V. Returns what lets it go. */
export function listenForSuperV(onSuperV) {
    const object = Gio.DBusExportedObject.wrapJSObject(RECORDER_XML, {SuperV: () => onSuperV()});
    object.export(Gio.DBus.session, RECORDER_PATH);
    const owner = Gio.bus_own_name_on_connection(Gio.DBus.session, RECORDER_NAME, Gio.BusNameOwnerFlags.REPLACE |
        Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT, null, null);
    return () => {
        Gio.bus_unown_name(owner);
        object.unexport();
    };
}

/** Calls `onChange(waiting)` as a sheet starts or stops waiting. Returns what stops watching. */
export function watchRecorder(onChange) {
    const id = Gio.bus_watch_name(Gio.BusType.SESSION, RECORDER_NAME, Gio.BusNameWatcherFlags.NONE,
        () => onChange(true), () => onChange(false));
    return () => Gio.bus_unwatch_name(id);
}

/** Gives the waiting sheet Super+V. */
export function sendSuperV() {
    Gio.DBus.session.call(RECORDER_NAME, RECORDER_PATH, RECORDER_INTERFACE, 'SuperV', null, null,
        Gio.DBusCallFlags.NO_AUTO_START, -1, null, null);
}
