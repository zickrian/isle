// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The assistant's light: light rising from a shape's edge, brightest along the bottom and gone by the top of the
// sides, its colours flowing round. Cairo draws it for Settings; on the island a shader draws the same per frame.

import Cairo from 'cairo';

import * as Theme from './theme.js';

const STOPS = 24;

// Light from the edge of a box `height` tall: `time` (s) moves it, `level` (0..1, the voice) swells it,
// `strength` fades it; `cache` keeps the rising mask while the height stays, `scale` is the shell's `uiScale`.
export function paintRim(cr, {left, right, top, radius}, height, colors, motion, strength, cache = {}, scale = 1) {
    const r = Math.max(0, radius);
    const sides = () => traceSides(cr, left, right, top, height, r);
    const {glass, steps, stroke, line, rise, work, flows: [faint, haze, crisp]} = rim(height, top, motion, strength, scale);
    const lit = ({time, alpha, streaks}) => flow(colors, left, right, time, alpha, streaks, work, glass);
    cr.pushGroup();
    cr.setOperator(Cairo.Operator.ADD);
    // Faint strokes, each narrower, so the edge glows softly inwards.
    cr.setSource(lit(faint));
    for (let i = 0; i < steps; i++) {
        cr.setLineWidth(stroke * (1 - i / steps));
        sides();
        cr.stroke();
    }
    // A haze along the bottom, deeper as it swells, with two brighter streaks passing each other.
    const mask = new Cairo.LinearGradient(0, height - rise, 0, height);
    mask.addColorStopRGBA(0, 0, 0, 0, 0);
    mask.addColorStopRGBA(1, 0, 0, 0, 1);
    cr.setSource(lit(haze));
    cr.mask(mask);
    // A crisp line of light at the very edge.
    cr.setSource(lit(crisp));
    cr.setLineWidth(line);
    sides();
    cr.stroke();
    cr.popGroupToSource();
    // Rising from the bottom: gone by the top of the sides.
    if (cache.top !== top || cache.height !== height) {
        const pattern = new Cairo.LinearGradient(0, top, 0, height);
        pattern.addColorStopRGBA(0, 0, 0, 0, 0);
        pattern.addColorStopRGBA(RISE_KNEE, 0, 0, 0, RISE_AT_KNEE);
        pattern.addColorStopRGBA(1, 0, 0, 0, 1);
        Object.assign(cache, {top, height, pattern});
    }
    cr.setOperator(Cairo.Operator.OVER);
    cr.mask(cache.pattern);
}

/** Where the rising mask bends, and how strong it is there. */
const RISE_KNEE = 0.55, RISE_AT_KNEE = 0.35;

// The light in numbers: its strokes (`stroke` wide, `steps` of them), haze (`rise` deep) and crisp `line`, and the
// flows of colour lighting each: faint, hazy with streaks, crisp.
function rim(height, top, {time, level, work = 0}, strength, scale) {
    // On glass the light keeps to the edge: a haze a touch fuller (lighter glass shows it less), a brighter rim, finer
    // steps inwards, and each colour lit by its own lightness so stacked light never burns to white.
    const glass = Theme.translucent();
    const mist = glass ? 1.05 : 1, bright = glass ? 1.3 : 1;
    const steps = glass ? 6 : 3;
    return {
        glass, steps, work,
        stroke: (22 + 16 * level) * scale,
        line: 2.5 * scale,
        rise: Math.min(52 * scale, Math.max(0, height - top) * 0.5) * (0.75 + 0.5 * level),
        flows: [
            {time, alpha: (0.1 + 0.08 * level) * strength * 3 / steps, streaks: null},
            {time: time * 0.8 + 2, alpha: (0.32 + 0.24 * level) * strength * mist, streaks: time},
            {time: time * 1.4, alpha: Math.min(1, (0.46 + 0.3 * level + 0.14 * work) * strength * bright), streaks: time + 3},
        ],
    };
}

/** `paintRim`'s light as RIM_UNIFORMS values, for a box whose `shoulder`s flare above its sides. Three colours. */
export function rimUniforms({left, right, top, radius, shoulder}, height, colors, motion, strength, scale = 1) {
    const {glass, steps, stroke, line, rise, work, flows} = rim(height, top, motion, strength, scale);
    // Whole turns of the flow look the same: kept small, so the shader's floats stay exact.
    const shift = flows.map(({time}) => (time * FLOW_SPEED) % 1);
    const [haze, crisp] = flows.slice(1).map(({streaks}) => streakAt(streaks));
    const color = i => [...colors[i % colors.length], glass ? weight(colors[i % colors.length]) : 1];
    return {
        body: [left, right, top, height],
        corner: [Math.max(0, radius), shoulder, Math.min(3, colors.length), steps],
        strokes: [stroke, line, rise, work],
        shift: [...shift, 0],
        alpha: [...flows.map(({alpha}) => alpha), 0],
        streaks: [...haze, ...crisp],
        c0: color(0), c1: color(1), c2: color(2),
    };
}

// The shader's uniforms (vec4s): the actor's size and the light's texel size (`frame`), the texels across and down
// (`grid`), then what `rimUniforms` gives.
export const RIM_UNIFORMS = Object.fromEntries(['frame', 'body', 'corner', 'strokes', 'shift', 'alpha', 'streaks', 'c0', 'c1', 'c2']
    .map(name => [name, 4]).concat([['grid', 2]]));

// What `paintRim` draws, per texel of a drawing `frame.z` units a pixel (soft light needs no finer), and its stops;
// the island's `outlineBody` and `outlineBeside` come before them (see island.js).
export const RIM_FUNCTIONS = `
vec4 rimColor(float k) {
    k = mod(k, corner.z);
    return k < 0.5 ? c0 : k < 1.5 ? c1 : c2;
}
float rimBump(float x, float at, float width) {
    float d = abs(mod(x - at + 1.5, 1.0) - 0.5);
    return exp(-(d * d) / (2.0 * width * width));
}
vec4 rimStop(float i, float shift, float alpha, vec2 streak, bool streaked) {
    float x = i / ${STOPS}.0;
    float at = (x + shift) * corner.z;
    float index = floor(at);
    float m = at - index;
    vec4 from = rimColor(index), to = rimColor(index + 1.0);
    float swell = streaked ? 0.62 + (0.55 + 0.75 * strokes.w) * rimBump(x, streak.x, 0.09) +
        (0.4 + 0.55 * strokes.w) * rimBump(x, streak.y, 0.13) : 1.0;
    return vec4(mix(from.rgb, to.rgb, m), min(1.0, alpha * swell * mix(from.a, to.a, m)));
}
vec4 rimFlow(float x, float shift, float alpha, vec2 streak, bool streaked) {
    float t = clamp((x - body.x) / max(body.y - body.x, 0.001), 0.0, 1.0) * ${STOPS}.0;
    float i = min(floor(t), ${STOPS - 1}.0);
    vec4 c = mix(rimStop(i, shift, alpha, streak, streaked), rimStop(i + 1.0, shift, alpha, streak, streaked), t - i);
    return vec4(c.rgb * c.a, c.a);
}
float rimSpan(float a0, float a1, float b0, float b1) {
    return max(0.0, min(a1, b1) - max(a0, b0));
}
float rimBand(float sd, float beside, float width) {
    float t = frame.z;
    return (rimSpan(sd - 0.5 * t, sd + 0.5 * t, -0.5 * width, 0.0) +
        beside * rimSpan(sd - 0.5 * t, sd + 0.5 * t, 0.0, 0.5 * width)) / t;
}
vec4 rimTexel(vec2 q, vec4 faint, vec4 haze, vec4 crisp) {
    float top = body.z, bottom = body.w, t = frame.z;
    float sd = -outlineBody(q).x, beside = outlineBeside(q).x;
    float clip = clamp(0.5 + max(-sd, beside) / t, 0.0, 1.0);
    float outer = clamp(0.5 + beside / t, 0.0, 1.0);
    float cap = clamp(0.5 + (q.y - top) / t, 0.0, 1.0);
    vec4 sum = vec4(0.0);
    for (int i = 0; i < 6; i++) {
        if (float(i) >= corner.w)
            break;
        sum += faint * rimBand(sd, outer, strokes.x * (1.0 - float(i) / corner.w)) * cap;
    }
    sum += haze * clamp((q.y - bottom + strokes.z) / max(strokes.z, 0.001), 0.0, 1.0) * clip;
    sum += crisp * rimBand(sd, outer, strokes.y) * cap;
    float k = clamp((q.y - top) / max(bottom - top, 0.001), 0.0, 1.0);
    float rising = k < ${RISE_KNEE} ? ${RISE_AT_KNEE} * k / ${RISE_KNEE} : mix(${RISE_AT_KNEE}, 1.0, (k - ${RISE_KNEE}) / (1.0 - ${RISE_KNEE}));
    return min(sum, vec4(1.0)) * rising * clip;
}
`;

// Each pixel blends its four nearest texels, as a drawing that size scaled up would; the flows are per column.
// `point` is GLSL for where the pixel is on the actor (see shader.js `effectPoint`).
export const rimCode = point => `
vec2 p = ${point};
float t = frame.z;
vec4 light = vec4(0.0);
if (p.x > max(0.0, body.x - corner.y - 2.0 * t) && p.x < min(grid.x * t, body.y + corner.y + 2.0 * t) &&
    p.y > 0.0 && p.y < min(grid.y * t, body.w + 2.0 * t)) {
    vec2 at = p / t - 0.5;
    vec2 cell = floor(at);
    vec2 f = at - cell;
    vec2 lo = (clamp(cell, vec2(0.0), grid - 1.0) + 0.5) * t;
    vec2 hi = (clamp(cell + 1.0, vec2(0.0), grid - 1.0) + 0.5) * t;
    vec4 faint0 = rimFlow(lo.x, shift.x, alpha.x, vec2(0.0), false);
    vec4 haze0 = rimFlow(lo.x, shift.y, alpha.y, streaks.xy, true);
    vec4 crisp0 = rimFlow(lo.x, shift.z, alpha.z, streaks.zw, true);
    vec4 faint1 = rimFlow(hi.x, shift.x, alpha.x, vec2(0.0), false);
    vec4 haze1 = rimFlow(hi.x, shift.y, alpha.y, streaks.xy, true);
    vec4 crisp1 = rimFlow(hi.x, shift.z, alpha.z, streaks.zw, true);
    light = mix(mix(rimTexel(lo, faint0, haze0, crisp0), rimTexel(vec2(hi.x, lo.y), faint1, haze1, crisp1), f.x),
        mix(rimTexel(vec2(lo.x, hi.y), faint0, haze0, crisp0), rimTexel(hi, faint1, haze1, crisp1), f.x), f.y);
}
cogl_color_out = light * cogl_color_in.a;
`;

/** The glow's path: up both sides and along the bottom, round its corners (`r`). */
function traceSides(cr, left, right, top, height, r) {
    cr.moveTo(left, top);
    cr.lineTo(left, height - r);
    cr.arcNegative(left + r, height - r, r, Math.PI, Math.PI / 2);
    cr.lineTo(right - r, height);
    cr.arcNegative(right - r, height - r, r, Math.PI / 2, 0);
    cr.lineTo(right, top);
}

/** How fast the colours flow round (widths per second). */
const FLOW_SPEED = 0.12;

/** Where the two streaks are at `time` (s), as fractions of the width: one going right, one left. */
const streakAt = time => [(time * 0.11) % 1, 1 - (time * 0.075 + 0.4) % 1];

/** A soft bump of brightness `width` wide (0..1) centred on `at`, wrapping round. */
const bump = (x, at, width) => {
    const d = Math.abs(((x - at) % 1 + 1.5) % 1 - 0.5);
    return Math.exp(-(d * d) / (2 * width * width));
};

// A left-to-right gradient of `colors`, flowing with `time`; `streaks` (a time) sends two brighter streaks
// along it in opposite directions, and `work` (0..1, the assistant at work) makes them brighter. `balanced`
// dims the lighter colours by their lightness.
function flow(colors, left, right, time, alpha, streaks = null, work = 0, balanced = false) {
    const gradient = new Cairo.LinearGradient(left, 0, right, 0);
    const weights = colors.map(color => balanced ? weight(color) : 1);
    const [a, b] = streaks === null ? [0, 0] : streakAt(streaks);
    for (let i = 0; i <= STOPS; i++) {
        const x = i / STOPS;
        const at = (x + time * FLOW_SPEED) * colors.length;
        const index = Math.floor(at);
        const mix = at - index;
        const from = colors[index % colors.length];
        const to = colors[(index + 1) % colors.length];
        const balance = weights[index % colors.length] +
            (weights[(index + 1) % colors.length] - weights[index % colors.length]) * mix;
        const swell = streaks === null ? 1
            : 0.62 + (0.55 + 0.75 * work) * bump(x, a, 0.09) + (0.4 + 0.55 * work) * bump(x, b, 0.13);
        gradient.addColorStopRGBA(x, from[0] + (to[0] - from[0]) * mix,
            from[1] + (to[1] - from[1]) * mix, from[2] + (to[2] - from[2]) * mix, Math.min(1, alpha * swell * balance));
    }
    return gradient;
}

/** How strongly a colour lights: Classic's blues and cyan as they are, lighter ones (yellow, green) less. */
function weight([r, g, b]) {
    const linear = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const lightness = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    return Math.min(1, 0.56 / Math.max(lightness, 0.05));
}
