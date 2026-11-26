// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The island's looks, as Settings offers them and theme.js draws them.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import * as Theme from '../../gnome-extension/src/theme.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../gnome-extension');

test('the schema offers Black, Glass and Clear Glass, Black by default', () => {
    const schema = readFileSync(resolve(root, 'schemas/org.gnome.shell.extensions.isle.gschema.xml'), 'utf8');
    const key = schema.match(/<key name="island-theme"[\s\S]*?<\/key>/)[0];
    assert.deepEqual([...key.matchAll(/<choice value="([^"]+)"\/>/g)].map(m => m[1]), ['black', 'glass', 'clear']);
    assert.match(key, /<default>'black'<\/default>/);
});

test('glass and clear show what is behind them; black, and any name it doesn\'t know, is solid black', () => {
    for (const name of ['glass', 'clear']) {
        Theme.setTheme(name);
        assert.equal(Theme.translucent(), true);
        assert.ok(Theme.blur());
    }
    for (const name of ['black', 'gnome', '']) {
        Theme.setTheme(name);
        assert.equal(Theme.translucent(), false);
        assert.equal(Theme.blur(), null);
        assert.deepEqual(Theme.fill(), [0, 0, 0, 1]);
    }
});

test('clear glass keeps Isle\'s blur while letting more of the backdrop through than glass', () => {
    const tone = () => {
        const b = Theme.blur(), [r, , , a] = Theme.fill();
        const toned = b.lo + b.span * 0.3 ** b.gamma;
        return toned * (1 - a) + r * a;
    };
    Theme.setTheme('glass', 0);
    const glassRadius = Theme.blur().radius;
    const glassTone = tone();
    Theme.setTheme('clear', 100);
    assert.equal(Theme.blur().radius, glassRadius);
    assert.ok(tone() > glassTone);
    assert.ok(Theme.fill()[3] < 0.1);
});

test('the glass tint runs from clear glass to dark smoked glass, still blurred', () => {
    // How light a mid-grey backdrop ends up, after the tone and the smoke (as glass.js draws it).
    const tone = () => {
        const b = Theme.blur(), [r, , , a] = Theme.fill();
        const toned = b.lo + b.span * 0.3 ** b.gamma;
        return toned * (1 - a) + r * a;
    };
    Theme.setTheme('glass', 0);
    const clear = [...Theme.fill()], light = tone();
    assert.ok(Theme.blur());
    Theme.setTheme('glass', 100);
    assert.ok(Theme.blur() && tone() < light * 0.7);
    Theme.setTheme('glass', 50);
    const mid = tone();
    Theme.setTheme('glass', 100);
    assert.ok(mid < light && mid > tone());
    Theme.setTheme('black', 100);
    assert.deepEqual(Theme.fill(), [0, 0, 0, 1]);
    Theme.setTheme('glass', 0);
    assert.deepEqual(Theme.fill(), clear);
});
