// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Saving a Shelf file the Shelf keeps itself (from the phone, a clipboard picture) into Downloads, and
// showing it there. Copied by GIO off the shell's thread, so a big video never holds the island up.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Names tried before giving up: "Photo.jpg", "Photo (2).jpg"… */
const MAX_NAMES = 999;
/** Why a file that left the Shelf can't be saved. */
const GONE = 'It is no longer on the Shelf';

/** The user's Downloads folder (XDG's, else ~/Downloads). */
export function downloadsDir() {
    const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
    return Gio.File.new_for_path(dir && dir !== GLib.get_home_dir() ? dir : GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']));
}

/** Whether `uri` is a copy the Shelf keeps itself, in isled's shelf folder: those can be saved. */
export function isShelfCopy(uri) {
    const file = Gio.File.new_for_uri(uri);
    const own = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'isle', 'shelf']));
    return Boolean(file.get_parent()?.equal(own));
}

/** `name`, or "name (n).ext" for the `n`th try. */
export function numbered(name, n) {
    if (n <= 1)
        return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** The URIs being saved now: a second ↓ on one of them is ignored. */
const saving = new Set();

/** Copies `uri` into Downloads under its own name, numbered rather than over a file: the copy's Gio.File,
 * or null when it is already being saved. Rejects with a short reason for the island. */
export async function saveToDownloads(uri, cancellable = null) {
    if (saving.has(uri))
        return null;
    saving.add(uri);
    try {
        return await save(uri, cancellable);
    } finally {
        saving.delete(uri);
    }
}

/** Runs an async GIO call, `begin(callback)`, to the value of `finish(source, result)`. */
function call(begin, finish) {
    return new Promise((resolve, reject) => {
        begin((source, result) => {
            try {
                resolve(finish(source, result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Makes `dir` and its missing parents, off the shell's thread; one already there is fine. */
async function makeDirectory(dir, cancellable) {
    try {
        await call(done => dir.make_directory_async(GLib.PRIORITY_LOW, cancellable, done),
            (source, result) => source.make_directory_finish(result));
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        const parent = dir.get_parent();
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) || !parent)
            throw new Error(writeReason(e), {cause: e});
        await makeDirectory(parent, cancellable);
        await makeDirectory(dir, cancellable);
    }
}

async function save(uri, cancellable) {
    const source = Gio.File.new_for_uri(uri);
    const name = source.get_basename();
    let input;
    try {
        input = await call(done => source.read_async(GLib.PRIORITY_LOW, cancellable, done),
            (file, result) => file.read_finish(result));
    } catch (e) {
        // Gone from the Shelf, or unreadable: nothing in Downloads is touched.
        throw new Error(e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ? GONE : 'It can\u2019t be read', {cause: e});
    }
    try {
        const dir = downloadsDir();
        await makeDirectory(dir, cancellable);
        for (let n = 1; n <= MAX_NAMES; n++) {
            const target = dir.get_child(numbered(name, n));
            // Made new, or not at all: a name in use (by the user, another program, another save) is skipped,
            // and only a file this call made is ever deleted.
            let output;
            try {
                output = await call(done => target.create_async(Gio.FileCreateFlags.NONE, GLib.PRIORITY_LOW, cancellable, done),
                    (file, result) => file.create_finish(result));
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    continue;
                throw new Error(writeReason(e), {cause: e});
            }
            try {
                await call(done => output.splice_async(input, Gio.OutputStreamSpliceFlags.CLOSE_TARGET, GLib.PRIORITY_LOW,
                    cancellable, done), (stream, result) => stream.splice_finish(result));
                return target;
            } catch (e) {
                // Half written (a full disk): this call's own file goes.
                target.delete_async(GLib.PRIORITY_LOW, null, null);
                throw new Error(e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NO_SPACE) ? writeReason(e) : reason(e), {cause: e});
            }
        }
        throw new Error('Too many files of that name in Downloads');
    } finally {
        input.close_async(GLib.PRIORITY_LOW, null, null);
    }
}

/** Why Downloads can't take the file. */
function writeReason(e) {
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NO_SPACE))
        return 'Not enough space in Downloads';
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED) || e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.READ_ONLY))
        return 'Downloads can\u2019t be written to';
    return e.message;
}

/** A failed copy's reason, as the island says it. */
function reason(e) {
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
        return GONE;
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NO_SPACE))
        return 'Not enough space in Downloads';
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED))
        return 'Downloads can’t be written to';
    return e.message;
}

/** Shows `file` selected in the file manager; else opens its folder. */
export function showInFiles(file) {
    Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1',
        'ShowItems', new GLib.Variant('(ass)', [[file.get_uri()], '']), null, Gio.DBusCallFlags.NONE, 3000, null,
        (bus, result) => {
            try {
                bus.call_finish(result);
            } catch {
                Gio.AppInfo.launch_default_for_uri_async(file.get_parent().get_uri(), null, null, null);
            }
        });
}
