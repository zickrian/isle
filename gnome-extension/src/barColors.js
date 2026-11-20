// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Colours for music's bars, from the cover's: the closed island's little bars (brighter, to read on its black).

// ---- Colours (RGB and HSL in 0..1; hue in degrees) ----------------------------------------------------------------

export function rgbToHsl([r, g, b]) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const chroma = max - min;
    if (chroma === 0)
        return [0, 0, l];
    const s = chroma / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === r)
        h = ((g - b) / chroma) % 6;
    else if (max === g)
        h = (b - r) / chroma + 2;
    else
        h = (r - g) / chroma + 4;
    return [(h * 60 + 360) % 360, s, l];
}

export function hslToRgb([h, s, l]) {
    h = ((h % 360) + 360) % 360;
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - chroma / 2;
    const [r, g, b] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x]
        : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
    return [r + m, g + m, b + m];
}

/** WCAG relative luminance, and the contrast ratio between two colours. */
function luminance([r, g, b]) {
    const linear = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrast(a, b) {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
/** Colours too grey to have a hue worth following. */
const GREY = 0.12;
/** `rgb(...)` for a colour in 0..1. */
export function css([r, g, b]) {
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/** The colour of the closed island's little bars from the cover's (RGB 0..1 as `vividColor` gives, which is toned
 * dark for a wash): the same hue, bright, on the island's black. Null for a grey cover: the bars stay white. */
export function miniBarColor(cover) {
    if (!cover)
        return null;
    const [h, s] = rgbToHsl(cover);
    if (s < GREY)
        return null;
    return css(hslToRgb([h, clamp(s, 0.6, 0.95), 0.66]));
}
