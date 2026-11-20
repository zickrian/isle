// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Colours for music's bars, from the cover's: the closed island's little bars (brighter, to read on its black) and
// cava's (the same hue as the cover's wash behind them, so they show against it and never clash with it).

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
/** Bars with no cover colour to follow: a muted cool blue, under the white text. */
const NEUTRAL = [[0.42, 0.47, 0.6], [0.36, 0.42, 0.58]];
/** The bars' two colours differ in hue by this much, both ways round the wash's (analogous, never opposite). */
const HUE_SPREAD = 16;

/** What the wash looks like where the bars are, at the bottom of the island: three parts of it to one of the dark glass. */
const WASH_SHARE = 0.75;
const GLASS = [0.08, 0.08, 0.1];
/** The bars are a background, under white text. Against the wash they are this much lighter (on a dark wash) or
 * deeper (on any other), in luminance: they show, and the text reads on them as well as on the wash. */
const STEP = 2.2;
/** A wash this dark (luminance) takes lighter bars, and those never get lighter than this. */
const DARK_WASH = 0.06;
const BRIGHTEST_BAR = 0.12;

/** The HSL lightness at which the colour of hue `h` and saturation `s` has luminance `target` (bisection). */
function lightnessFor(h, s, target) {
    let low = 0.02, high = 0.9;
    for (let i = 0; i < 24; i++) {
        const middle = (low + high) / 2;
        if (luminance(hslToRgb([h, s, middle])) < target)
            low = middle;
        else
            high = middle;
    }
    return (low + high) / 2;
}

/** The two colours (RGB, 0..1) of cava's bars, from the first bar to the last, for an island washed in `wash` (RGB
 * 0..1, as `vividColor` gives; null for none): the wash's hue, a little to either side, a step lighter than the wash
 * if it is dark and a step deeper if not, so that they show against it but stay under the text. */
export function cavaColors(wash) {
    if (!wash)
        return NEUTRAL;
    const [h, s] = rgbToHsl(wash);
    if (s < GREY)
        return NEUTRAL;
    const background = wash.map((channel, i) => channel * WASH_SHARE + GLASS[i] * (1 - WASH_SHARE));
    const here = luminance(background);
    const target = here < DARK_WASH ? Math.min(here * STEP + 0.01, BRIGHTEST_BAR) : here / STEP;
    const saturation = clamp(0.55 + s * 0.35, 0.55, 0.9);
    return [h - HUE_SPREAD, h + HUE_SPREAD].map(hue => hslToRgb([hue, saturation, lightnessFor(hue, saturation, target)]));
}

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

/** `count` colours from `from` to `to` (RGB 0..1), as `rgb(...)`. */
export function gradient(from, to, count) {
    return Array.from({length: count}, (_, i) => {
        const t = count > 1 ? i / (count - 1) : 0;
        return css(from.map((channel, k) => channel + (to[k] - channel) * t));
    });
}
