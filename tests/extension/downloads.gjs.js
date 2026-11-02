// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Saving a Shelf file into Downloads, against a scratch HOME: `gjs -m tests/extension/downloads.gjs.js`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const home = GLib.dir_make_tmp('isle-downloads-XXXXXX');
GLib.setenv('HOME', home, true);
GLib.setenv('XDG_DATA_HOME', `${home}/.local/share`, true);
GLib.setenv('XDG_CONFIG_HOME', `${home}/.config`, true);
// Downloads deeper than any folder there yet: it is made with its parents.
GLib.mkdir_with_parents(`${home}/.config`, 0o755);
GLib.file_set_contents(`${home}/.config/user-dirs.dirs`, 'XDG_DOWNLOAD_DIR="$HOME/Deep/Down/Downloads"\n');
const {isShelfCopy, numbered, saveToDownloads} = await import('../../gnome-extension/src/downloads.js');

let failures = 0;
function check(what, actual, expected) {
    if (JSON.stringify(actual) === JSON.stringify(expected))
        return;
    failures++;
    printerr(`FAIL ${what}: ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}
const read = path => new TextDecoder().decode(GLib.file_get_contents(path)[1]);

const shelf = `${home}/.local/share/isle/shelf`;
GLib.mkdir_with_parents(shelf, 0o700);
const photo = `${shelf}/Photo.jpg`;
GLib.file_set_contents(photo, 'picture');
const uri = GLib.filename_to_uri(photo, null);
const downloads = `${home}/Deep/Down/Downloads`;

check('numbered', numbered('Photo.jpg', 2), 'Photo (2).jpg');
check('a Shelf copy', isShelfCopy(uri), true);
check('a file from elsewhere', isShelfCopy(GLib.filename_to_uri(`${home}/Photo.jpg`, null)), false);

// Downloads made with its parents, then free names only; a file of the user's is left as it is.
const first = await saveToDownloads(uri);
GLib.file_set_contents(`${downloads}/Photo (2).jpg`, 'mine');
const second = await saveToDownloads(uri);
check('first save', first.get_basename(), 'Photo.jpg');
check('second save skips a name in use', second.get_basename(), 'Photo (3).jpg');
check('the user’s file untouched', read(`${downloads}/Photo (2).jpg`), 'mine');

// Pressed twice while the first copy runs: one copy.
const [a, b] = await Promise.all([saveToDownloads(uri), saveToDownloads(uri)]);
check('a second press while saving is ignored', [Boolean(a), b], [true, null]);
check('so one more file', Gio.File.new_for_path(`${downloads}/Photo (5).jpg`).query_exists(null), false);

// Gone from the Shelf: a clear reason, nothing touched.
let reason;
try {
    await saveToDownloads(GLib.filename_to_uri(`${shelf}/Gone.jpg`, null));
} catch (e) {
    reason = e.message;
}
check('a file gone', reason, 'It is no longer on the Shelf');

// Another program takes the free name just as Isle goes to write it, and Isle's copy then fails: that
// program's file is never deleted, and Isle's half file is.
let raced = null;
const realCreate = Gio.File.prototype.create_async;
Gio.File.prototype.create_async = function (...args) {
    if (!raced) {
        raced = this.get_path();
        GLib.file_set_contents(raced, 'theirs');
    }
    return realCreate.apply(this, args);
};
const realSplice = Gio.OutputStream.prototype.splice_finish;
Gio.OutputStream.prototype.splice_finish = () => {
    throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.NO_SPACE, 'full');
};
reason = '';
try {
    await saveToDownloads(uri);
} catch (e) {
    reason = e.message;
}
Gio.File.prototype.create_async = realCreate;
Gio.OutputStream.prototype.splice_finish = realSplice;
check('the race: their file kept', raced && read(raced), 'theirs');
check('the race: the reason', reason, 'Not enough space in Downloads');
GLib.usleep(200000);
check('the race: no half file of Isle\u2019s', GLib.file_test(`${downloads}/Photo (6).jpg`, GLib.FileTest.EXISTS), false);

// Two saves of files with the same name at once: both kept, each whole.
const elsewhere = `${home}/Elsewhere`;
GLib.mkdir_with_parents(elsewhere, 0o755);
GLib.file_set_contents(`${elsewhere}/Twin.txt`, 'one');
GLib.file_set_contents(`${shelf}/Twin.txt`, 'two');
const twins = await Promise.all([saveToDownloads(GLib.filename_to_uri(`${elsewhere}/Twin.txt`, null)),
    saveToDownloads(GLib.filename_to_uri(`${shelf}/Twin.txt`, null))]);
check('two saves at once land under two names', twins.map(file => read(file.get_path())).sort(), ['one', 'two']);

// A source that can't be read: said so, nothing left behind.
GLib.file_set_contents(`${shelf}/Locked.jpg`, 'x');
GLib.chmod(`${shelf}/Locked.jpg`, 0o000);
reason = '';
try {
    await saveToDownloads(GLib.filename_to_uri(`${shelf}/Locked.jpg`, null));
} catch (e) {
    reason = e.message;
}
check('a file that can\u2019t be read', reason, 'It can\u2019t be read');
check('nothing left of it', GLib.file_test(`${downloads}/Locked.jpg`, GLib.FileTest.EXISTS), false);

// Downloads that can't be read or written: said so at once, not after 999 names.
GLib.chmod(downloads, 0o000);
reason = '';
const started = GLib.get_monotonic_time();
try {
    await saveToDownloads(uri);
} catch (e) {
    reason = e.message;
}
GLib.chmod(downloads, 0o755);
check('Downloads that can\u2019t be written', reason, 'Downloads can\u2019t be written to');
check('said at once', (GLib.get_monotonic_time() - started) < 2e6, true);

GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(home)}`);
if (failures)
    imports.system.exit(1);
print('downloads: all passed');
