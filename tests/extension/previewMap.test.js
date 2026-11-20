// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// What the island opens on while a setting changes: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {PREVIEWED_KEYS, PREVIEWS, previewTarget} from '../../gnome-extension/src/previewMap.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../gnome-extension');
const schema = readFileSync(resolve(root, 'schemas/org.gnome.shell.extensions.isle.gschema.xml'), 'utf8');
const keys = [...schema.matchAll(/<key name="([^"]+)"/g)].map(match => match[1]);

/** Every .js file under `directory`. */
function sources(directory) {
    return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory())
            return sources(path);
        return path.endsWith('.js') ? [path] : [];
    });
}

test('every setting has an entry, so that a new one is decided on when it is added', () => {
    assert.deepEqual(keys.filter(key => !(key in PREVIEWS)), []);
    assert.deepEqual(Object.keys(PREVIEWS).filter(key => !keys.includes(key)), []);
});

test('a setting the shell writes itself never opens the island', () => {
    const written = new Set();
    for (const file of [...sources(resolve(root, 'src')), resolve(root, 'extension.js')]) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/(?:set_(?:boolean|int|string|strv|double|value)|reset)\(\s*'([a-z0-9-]+)'/g))
            written.add(match[1]);
    }
    assert.deepEqual(PREVIEWED_KEYS.filter(key => written.has(key)), []);
});

test('cava and the lyrics providers open the lyrics; the island\'s look opens it on its own page', () => {
    for (const key of PREVIEWED_KEYS.filter(key => key.startsWith('cava-') || key.startsWith('lyrics-')))
        assert.deepEqual(previewTarget(key), {page: 'music', mode: 'lyrics'}, key);
    for (const key of ['island-theme', 'open-size', 'glass-tint', 'island-shape'])
        assert.deepEqual(previewTarget(key), {page: null}, key);
});

test('a setting with nothing to show, or one that does not exist, opens nothing', () => {
    assert.equal(previewTarget('dnd-icon'), null);
    assert.equal(previewTarget('no-such-setting'), null);
});
