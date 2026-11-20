// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The colours of music's bars: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {contrast, hslToRgb, miniBarColor, rgbToHsl} from '../../gnome-extension/src/barColors.js';

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
