// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Lyrics found by the providers Isle asks itself, kept on disk so that a song is asked about once (isled keeps
// LRCLIB's own). Only lyrics that were found: a song without any is asked about again.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Files kept at most; the oldest go first. */
const MAX_FILES = 400;

/** FNV-1a, as a name for the file of a song and its providers. */
function fnv1a(text) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(text)) {
        hash ^= BigInt(byte);
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, '0');
}

/** {get(key) → {status, lines} | null, set(key, result)}, in the user's cache directory. Never throws. */
export function createLyricsCache() {
    const dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), 'isle', 'lyrics-providers']));
    let made = false;
    const fileFor = key => dir.get_child(`${fnv1a(key)}.json`);
    return {
        get(key) {
            try {
                const [ok, bytes] = fileFor(key).load_contents(null);
                if (!ok)
                    return null;
                const data = JSON.parse(new TextDecoder().decode(bytes));
                // Another song with the same name for its file is not this one.
                return data.key === key && Array.isArray(data.lines) ? {status: data.status, lines: data.lines} : null;
            } catch (e) {
                return null;
            }
        },
        set(key, result) {
            try {
                if (!made) {
                    GLib.mkdir_with_parents(dir.get_path(), 0o755);
                    made = true;
                    this._prune();
                }
                const json = JSON.stringify({key, status: result.status, lines: result.lines});
                fileFor(key).replace_contents(new TextEncoder().encode(json), null, false, Gio.FileCreateFlags.NONE, null);
            } catch (e) {
                console.warn(`Isle: could not keep the lyrics: ${e.message}`);
            }
        },
        /** Keeps the newest MAX_FILES. */
        _prune() {
            try {
                const infos = [];
                const children = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
                for (let info = children.next_file(null); info; info = children.next_file(null))
                    infos.push([info.get_name(), info.get_modification_date_time()?.to_unix() ?? 0]);
                children.close(null);
                infos.sort((a, b) => b[1] - a[1]);
                for (const [name] of infos.slice(MAX_FILES))
                    dir.get_child(name).delete(null);
            } catch (e) {
                // Nothing to prune yet.
            }
        },
    };
}
