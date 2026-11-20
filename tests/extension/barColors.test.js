// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The colours of music's bars: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {cavaColors, contrast, gradient, hslToRgb, miniBarColor, rgbToHsl} from '../../gnome-extension/src/barColors.js';

test('colours go to HSL and back', () => {
    const [h, s, l] = rgbToHsl(hslToRgb([200, 0.6, 0.5]));
    assert.ok(Math.abs(h - 200) < 0.01 && Math.abs(s - 0.6) < 0.001 && Math.abs(l - 0.5) < 0.001);
});

/** The wash the island gets from a cover of hue `h`, as `vividColor` makes it (brightness 0.35 to 0.8). */
function washFor(h, saturation) {
    const rgb = hslToRgb([h, 1, 0.5]);
    const peak = Math.max(...rgb);
    return rgb.map(channel => channel / peak * (0.35 + 0.45 * Math.min(1, saturation * 2)));
}

test('the bars show against the wash, keep its hue, and white text still reads over them', () => {
    const white = [1, 1, 1];
    let apart = Infinity, text = Infinity, hue = 0;
    for (let h = 0; h < 360; h += 5) {
        for (const saturation of [0.25, 0.5, 1]) {
            const wash = washFor(h, saturation);
            // The wash as the island shows it at the bottom: three parts of it to one of the dark glass.
            const seen = wash.map((channel, i) => channel * 0.75 + [0.08, 0.08, 0.1][i] * 0.25);
            for (const bar of cavaColors(wash)) {
                apart = Math.min(apart, contrast(bar, seen));
                // The bars show at about half over it.
                const blend = bar.map((channel, i) => channel * 0.55 + seen[i] * 0.45);
                text = Math.min(text, contrast(white, blend) / Math.min(4.5 / 0.8, contrast(white, seen)));
                const [barHue] = rgbToHsl(bar), [washHue] = rgbToHsl(wash);
                hue = Math.max(hue, Math.min(Math.abs(barHue - washHue), 360 - Math.abs(barHue - washHue)));
            }
        }
    }
    assert.ok(apart >= 1.35, `contrast with the wash ${apart}`);
    assert.ok(text >= 0.8, `text over the bars ${text}`);
    assert.ok(hue <= 20, `hue apart ${hue}`);
});

test('without a cover colour the bars are a muted blue', () => {
    assert.deepEqual(cavaColors(null), cavaColors([0.4, 0.4, 0.4]));
});

test('the closed island\'s bars keep the cover\'s hue and read on black; a grey cover keeps them white', () => {
    for (const h of [0, 60, 120, 200, 280, 330]) {
        const [r, g, b] = miniBarColor(washFor(h, 1)).match(/\d+/g).map(Number);
        assert.ok(contrast([r / 255, g / 255, b / 255], [0, 0, 0]) >= 4.5, `hue ${h}`);
        const apart = Math.abs(rgbToHsl([r / 255, g / 255, b / 255])[0] - h);
        assert.ok(Math.min(apart, 360 - apart) < 1, `hue ${h}`);
    }
    assert.equal(miniBarColor([0.4, 0.4, 0.4]), null);
    assert.equal(miniBarColor(null), null);
});

test('a gradient runs from the first colour to the last', () => {
    assert.deepEqual(gradient([0, 0, 0], [1, 1, 1], 3), ['rgb(0, 0, 0)', 'rgb(128, 128, 128)', 'rgb(255, 255, 255)']);
    assert.equal(gradient([0, 0, 0], [1, 1, 1], 1).length, 1);
});
