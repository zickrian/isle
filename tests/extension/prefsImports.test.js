// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Settings runs outside GNOME Shell: nothing it imports may import the shell's own modules or libraries.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../gnome-extension');
const SHELL_ONLY = /^(resource:\/\/\/org\/gnome\/shell\/|gi:\/\/(St|Clutter|Meta|Mtk|Shell|Cogl)(\?|$))/;

/** Every module `file` imports, with what each one imports, from the extension's own files. */
function imports(file, seen = new Map()) {
    if (seen.has(file))
        return seen;
    const specs = [...readFileSync(file, 'utf8').matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]);
    seen.set(file, specs);
    for (const spec of specs.filter(s => s.startsWith('.')))
        imports(resolve(dirname(file), spec), seen);
    return seen;
}

test('nothing Settings loads imports GNOME Shell', () => {
    const bad = [...imports(resolve(root, 'prefs.js'))].flatMap(([file, specs]) =>
        specs.filter(spec => SHELL_ONLY.test(spec)).map(spec => `${file.slice(root.length + 1)}: ${spec}`));
    assert.deepEqual(bad, []);
});
