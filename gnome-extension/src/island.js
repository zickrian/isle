// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The island itself: a black shape hanging from the top bar that springs between sizes and
// cross-fades views. On a bar that is not black it hangs from the screen's top edge, like a notch.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {px, uiScale} from './compat.js';
import {GlassBackdrop} from './glass.js';
import {RIM_FUNCTIONS, RIM_UNIFORMS, rimCode, rimUniforms} from './glow.js';
import {effectPoint, shaderEffect} from './shader.js';
import {GENTLE, Spring, SpringDriver} from './spring.js';
import * as Theme from './theme.js';
import {fence, setEnabled, slideBy} from './widgets.js';


/** Sideways speed (CSS px/s) `nudge` gives: a ~15 px stretch that springs back, as at a volume limit. */
const NUDGE_VELOCITY = 220;
/** How long a view takes to glide to its new place when its width changes. */
const GLIDE_MS = 360;
/** The shape layer reaches this far past the island on each side, in stage pixels: it covers the fraction of
 * one the island is drawn off its place, whatever the scale. */
const SHAPE_PAD = 1;
/** While the island moves, the layers drawn by shaders keep one size, as a new one makes new textures (and a new blur)
 * for them: room for the overshoot (of the way still to go) and a nudge's stretch (CSS px) past the target. */
const ROOM_OVERSHOOT = 0.1;
const ROOM_SLACK = 16;
/** How deep the glass's glow reaches in from its edge, in CSS pixels (see glass.js). */
const GLASS_GLOW_REACH = 4;
/** Up to this tall the glass keeps its colour down (a closed island, an alert); from the next, it is open. */
const GLASS_CLOSED = 48, GLASS_OPEN = 140;

/** How long a tint takes to come and go: a wash, and a glow (which lingers out). */
const TINT_FADE = {wash: [450, 450], glow: [380, 1100], aura: [300, 500]};

/** An alert done: its light this much brighter (level), fading over this long (ms). */
const PULSE_LEVEL = 0.6;
const PULSE_MS = 900;
/** An alert waiting: its light breathes down to this opacity and back, each way this long (ms). */
const BREATH_OPACITY = 140;
const BREATH_MS = 1400;
const BREATHS = 4;
/** The 'aura' glow is soft: it is drawn as at 1/this of the size, scaled up. */
const GLOW_SCALE = 2;

// The outline `_box` gives, in GLSL, as (how far inside, the edge's normal) for the nearest edge: of the body below
// the top bar (its sides and rounded bottom), and of the band above it with the shoulders that flare from it.
const OUTLINE = `
vec3 edgeMin(vec3 a, vec3 b) {
    return a.x < b.x ? a : b;
}
vec3 edgeMax(vec3 a, vec3 b) {
    return a.x > b.x ? a : b;
}
vec3 outlineBody(vec2 q) {
    float r = corner.x;
    vec2 c = vec2(clamp(q.x, body.x + r, body.y - r), min(q.y, body.w - r));
    float off = length(q - c);
    if (off > 0.0)
        return vec3(r - off, (q - c) / off);
    return edgeMin(edgeMin(vec3(q.x - body.x, 1.0, 0.0), vec3(body.y - q.x, 1.0, 0.0)), vec3(body.w - q.y, 0.0, 1.0));
}
vec3 outlineFlare(vec2 q, float x, float side) {
    float sh = corner.y;
    vec2 c = vec2(x - side * sh, body.z + sh);
    float off = max(length(q - c), 0.0001);
    vec3 arc = edgeMin(vec3(off - sh, (q - c) / off), vec3(c.y - q.y, 0.0, 1.0));
    return edgeMin(arc, edgeMin(vec3(sh + side * (q.x - x), 1.0, 0.0), vec3(sh - side * (q.x - x), 1.0, 0.0)));
}
vec3 outlineBeside(vec2 q) {
    float sh = corner.y;
    vec3 band = edgeMin(edgeMin(vec3(q.x - body.x + sh, 1.0, 0.0), vec3(body.y + sh - q.x, 1.0, 0.0)),
        vec3(body.z - q.y, 0.0, 1.0));
    if (sh <= 0.0)
        return band;
    return edgeMax(band, edgeMax(outlineFlare(q, body.x, 1.0), outlineFlare(q, body.y, -1.0)));
}
// The share of a pixel (so many a unit) inside an edge: a square cut by a straight line, as Cairo has it.
float coverage(vec3 edge, float pixel) {
    float a = max(abs(edge.y), abs(edge.z)), b = min(abs(edge.y), abs(edge.z));
    float u = edge.x * pixel, h = 0.5 * (a + b);
    if (u >= h)
        return 1.0;
    if (u <= -h)
        return 0.0;
    if (u < b - h)
        return (u + h) * (u + h) / (2.0 * a * b);
    if (u > h - b)
        return 1.0 - (h - u) * (h - u) / (2.0 * a * b);
    return (u + h - 0.5 * b) / a;
}
`;

// The shape in the theme's colour (`fill`), a 'wash' (`style` 1) or 'glow' (2) of `tint` (rgb, strength) over it,
// and the theme's `edge` (rgb, on; `edgeAlpha` at the top and the bottom), each edge softened over a pixel.
const SHAPE_CODE = `
vec2 p = ${effectPoint('frame.xy')};
float pixel = frame.z, left = body.x, right = body.y, top = body.z, bottom = body.w;
vec3 edgeAt = edgeMin(edgeMax(outlineBody(p), outlineBeside(p)), vec3(p.y, 0.0, 1.0));
float inside = edgeAt.x;
float cover = coverage(edgeAt, pixel);
vec4 color = vec4(fill.rgb, 1.0) * fill.a * cover;
vec4 tinted = vec4(tint.rgb, 1.0) * tint.a * cover;
if (style > 1.5) {
    // A pool of light at each bottom corner, joined by a faint band along the bottom edge.
    float r = max(min((right - left) * 0.36, max(0.0, bottom - top) * 1.05), 0.001);
    float a = 0.2 * clamp((p.y - bottom + 0.4 * r) / (0.4 * r), 0.0, 1.0);
    color = tinted * a + color * (1.0 - tinted.a * a);
    for (int i = 0; i < 2; i++) {
        float t = length(p - vec2(i == 0 ? left + 0.12 * r : right - 0.12 * r, bottom + 0.2 * r)) / r;
        a = t < 0.4 ? mix(0.95, 0.42, t / 0.4) : mix(0.42, 0.0, min(1.0, (t - 0.4) / 0.6));
        color = tinted * a + color * (1.0 - tinted.a * a);
    }
} else if (style > 0.5) {
    // Clear under the top bar, deepening to the colour.
    float a = 0.75 * clamp((p.y - top) / max(bottom - top, 0.001), 0.0, 1.0);
    color = tinted * a + color * (1.0 - tinted.a * a);
}
if (edge.a > 0.0) {
    // A hairline inside the shape, none along the screen's top edge, lit from above and fading downwards.
    float band = max(0.0, min(inside + 0.5 / pixel, 1.0) - max(inside - 0.5 / pixel, 0.0)) * pixel *
        clamp(0.5 + (p.y - 1.0) * pixel, 0.0, 1.0);
    float a = mix(edgeAlpha.x, edgeAlpha.y, clamp(p.y / max(bottom, 0.001), 0.0, 1.0)) * band;
    color = vec4(edge.rgb, 1.0) * a + color * (1.0 - a);
}
cogl_color_out = color * cogl_color_in.a;
`;

/** The island's shape, drawn by the GPU as it changes (see `_syncShape`). */
const ShapeFill = shaderEffect('ShapeFill', {frame: 4, body: 4, corner: 4, fill: 4, tint: 4, style: 1, edge: 4, edgeAlpha: 2},
    SHAPE_CODE, OUTLINE);

// What the views draw, cut to the outline as the shape is (see SHAPE_CODE).
const VIEWS_CODE = `
vec2 p = ${effectPoint('frame.xy')};
cogl_color_out *= coverage(edgeMin(edgeMax(outlineBody(p), outlineBeside(p)), vec3(p.y, 0.0, 1.0)), frame.z);
`;

/** Keeps the views inside the island's rounded outline while it changes shape (see `_syncViews`). */
const ViewsMask = shaderEffect('ViewsMask', {frame: 4, body: 4, corner: 4}, VIEWS_CODE, OUTLINE);

/** The 'aura' light, drawn by the GPU each frame (see glow.js). */
const RimLight = shaderEffect('RimLight', RIM_UNIFORMS, rimCode(effectPoint('frame.xy')), OUTLINE + RIM_FUNCTIONS);

/** Cross-fade timings in milliseconds. */
const FADE_OUT = 160;
const FADE_IN = 320;
/** The incoming view waits for the shape to make room before appearing. */
const FADE_IN_DELAY = 120;
/** How far (CSS px) the views slide as the shape grows or shrinks: they travel with it. Whole
 * pixels only, never a scale: a scaled picture or text is resampled every frame and seems to shiver. */
const VIEW_SHIFT = 8;
/** Below this shoulder size (CSS px) the corners may climb into the top bar, so the island rounds smoothly. */
const SHOULDER_FADE = 4;

/** The shape and its views; springs drive the size, and the views stay still on screen as it moves. */
export const Island = GObject.registerClass({
    Properties: {
        // How strongly `tint` washes the island, so it can fade in and out.
        'tint-strength': GObject.ParamSpec.double('tint-strength', null, null,
            GObject.ParamFlags.READWRITE, 0, 1, 0),
        // Like `hover`, without its :hover pseudo class: setting that restyles every view.
        'hovered': GObject.ParamSpec.boolean('hovered', null, null, GObject.ParamFlags.READABLE, false),
    },
    Signals: {'geometry-changed': {}},
}, class Island extends St.Widget {
    /** Starts at zero size; the first `morph` gives it a shape. */
    _init() {
        super._init({
            name: 'isleIsland',
            reactive: true,
            layout_manager: new Clutter.FixedLayout(),
        });

        /** Height of the top bar the island grows out of; 0 for none. */
        this._topInset = 0;
        this._hovered = false;
        this._monitor = null;
        this._view = null;
        this._pointerAtMorph = null;
        this._views = [];
        this._tint = null;
        this._tintStyle = 'wash';
        this._tintStrength = 0;
        this._motion = {time: 0, level: 0, work: 0};
        this._breathing = false;
        this._pulse = null;

        /** Where the island and its views' frame were last put, in whole pixels (see `_sync`). */
        this._islandX = 0;
        this._islandFraction = 0;
        this._stageX = 0;
        /** The size of the layers drawn by shaders (see `_roomFor`). */
        this._room = {width: 0, height: 0};
        this._width = new Spring(0);
        this._height = new Spring(0);
        this._radius = new Spring(0, GENTLE);
        this._shoulder = new Spring(0, GENTLE);
        this._springs = [this._width, this._height, this._radius, this._shoulder];
        this._driver = new SpringDriver(this, this._springs, () => this._sync());

        // The glass theme's blurred backdrop, under the shape (see glass.js).
        this._backdrop = new GlassBackdrop();
        this.add_child(this._backdrop);
        this._shape = new St.Widget({x: -SHAPE_PAD});
        this._fill = new ShapeFill();
        this._shape.add_effect(this._fill);
        this.add_child(this._shape);
        // The moving 'aura' light, on a layer of its own: the shape below is only drawn when it changes.
        this._glow = new St.Widget({visible: false});
        this._rim = new RimLight();
        this._glow.add_effect(this._rim);
        // A breath asked for while it was hidden starts as it shows (see `_breathe`).
        this._glow.connect('notify::mapped', () => this._breathing && this._breathe());
        this.add_child(this._glow);
        // Its shader is built the first time it draws: once, unlit, as the island first shows (see `_warmGlow`).
        this._warmPaint = 0;
        this._warmId = this.connect('notify::mapped', () => this.mapped && this._warmGlow());
        // Their edges are softened over a pixel of the display they are on.
        this._shape.connect('resource-scale-changed', () => this._syncShape());
        this._glow.connect('resource-scale-changed', () => this._queueGlow());

        // Clips the views while the island grows; a fixed layout keeps them at
        // full size (a bin would squeeze them), so nothing reflows.
        this._stage = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
        });
        // While it moves, the views are also cut to its rounded corners: a spring past its size leaves content
        // that fits at rest beyond them for a moment. A layer of the shaders' size, so its texture stays.
        this._viewsLayer = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this._viewsMask = new ViewsMask();
        this._viewsMask.enabled = false;
        this._viewsLayer.add_effect(this._viewsMask);
        this._viewsLayer.add_child(this._stage);
        this.add_child(this._viewsLayer);
        this._stageEnd = fence(this._stage);
        this.connect('destroy', () => this._onDestroy());
    }

    /** Whether a pointer rests on it. */
    get hovered() {
        return this._hovered;
    }

    /** Notifies `hovered` only on a change. */
    _setHovered(hovered) {
        if (hovered === this._hovered)
            return;
        this._hovered = hovered;
        this.notify('hovered');
    }

    /** Whether the pointer is on it, read again: a keyboard grab keeps the leave from it while it lasts. */
    syncHover() {
        const [x, y] = global.get_pointer();
        this._setHovered(this.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y)));
    }

    // A finger is no pointer resting on it: a tap's own enter and leave are not hovers.
    vfunc_enter_event(event) {
        if (!event.get_event_sequence())
            this._setHovered(true);
        return super.vfunc_enter_event(event);
    }

    /** Leaving into one of its own children is no leave. */
    vfunc_leave_event(event) {
        const related = event.get_related();
        if (!event.get_event_sequence() && (!related || !this.contains(related)))
            this._setHovered(false);
        return super.vfunc_leave_event(event);
    }

    /** The height of the bar the island grows out of; its body starts below. */
    set topInset(height) {
        this._topInset = height;
        this._sync();
    }

    /** The top bar's height, as last set. */
    get topInset() {
        return this._topInset;
    }

    /** The monitor to centre on: `{x, y, width, height}`. */
    set monitor(monitor) {
        this._monitor = monitor;
        this._sync();
    }

    /** The `tint-strength` property, eased by `setTint`. */
    get tint_strength() {
        return this._tintStrength;
    }

    /** Redraws the tint on its layer: the glow for 'aura', else the shape. */
    set tint_strength(value) {
        this._tintStrength = value;
        this.notify('tint-strength');
        this._syncGlowShown();
        this._queueGlow();
        this._syncShape();
    }

    // Colours the island with `rgb` (0..1; null fades it): 'wash' rises to the bottom, 'glow' spills
    // up from the two bottom corners, 'aura' (a list of colours) flows around the edge.
    setTint(rgb, style = 'wash') {
        // Another light: a done alert's brightening stops, never moving the next one.
        this._pulse?.stop();
        this._pulse = null;
        if (rgb) {
            this._tint = rgb;
            this._tintStyle = style;
            // The shape draws every style but the glow.
            this._syncShape();
        }
        const [fadeIn, fadeOut] = TINT_FADE[this._tintStyle];
        this.remove_transition('tint-strength');
        this.ease_property('tint-strength', rgb ? 1 : 0, {
            duration: rgb ? fadeIn : fadeOut,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** Moves the 'aura' tint: `time` in seconds, `level` (0..1) swells it, `work` (0..1) brightens its streaks. */
    setTintMotion(time, level, work = 0) {
        this._motion.time = time;
        this._motion.level = level;
        this._motion.work = work;
        this._queueGlow();
    }

    /** The 'aura' a moment brighter, settling to `level`: an alert that tells something is done. */
    pulseTint(time, level) {
        this._pulse?.stop();
        this._pulse = null;
        if (!St.Settings.get().enable_animations) {
            this.setTintMotion(time, level);
            return;
        }
        const pulse = new Clutter.Timeline({actor: this, duration: PULSE_MS});
        pulse.connect('new-frame', (_timeline, ms) => this.setTintMotion(time, level + PULSE_LEVEL * (1 - ms / PULSE_MS) ** 2));
        pulse.connect('completed', () => {
            if (this._pulse === pulse)
                this._pulse = null;
            this.setTintMotion(time, level);
        });
        this._pulse = pulse;
        pulse.start();
    }

    /** While true, the 'aura' breathes slowly a few times (an alert waiting for an answer): its layer's
     * opacity only, so nothing is drawn again. */
    set breathing(breathing) {
        if (breathing === this._breathing)
            return;
        this._breathing = breathing;
        this._breathe();
    }

    // Starts or stops the breath. Only once the layer is on screen: `ease` would jump to its end otherwise.
    _breathe() {
        this._glow.remove_transition('opacity');
        if (!this._breathing) {
            this._glow.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return;
        }
        this._glow.opacity = 255;
        if (this._glow.mapped && St.Settings.get().enable_animations) {
            // A few breaths, then still and bright: nothing redrawn while it waits on.
            this._glow.ease({opacity: BREATH_OPACITY, duration: BREATH_MS, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: 2 * BREATHS - 1, autoReverse: true});
        }
    }

    /** Where `actor` in the shown view (the view itself by default) will be once the island settles: {x, y, width, height}. */
    restingRect(actor = this._view) {
        if (!this._monitor || !this._view)
            return null;
        // Views stay put on screen, centred on the monitor (see `_placeView`).
        const viewX = this._screenX(this._view);
        const [viewLeft, viewTop] = this._view.get_transformed_position();
        const [left, top] = actor.get_transformed_position();
        const [actorWidth, actorHeight] = actor.get_transformed_size();
        // As it will be: the view may still be scaling in (see `_showView`).
        const scale = this._view.scale_x || 1;
        return {
            x: Math.round(viewX + (left - viewLeft) / scale),
            y: Math.round(this._monitor.y + (top - viewTop) / scale),
            width: Math.round(actorWidth / scale),
            height: Math.round(actorHeight / scale),
        };
    }

    /** Whether the island's shape, as it is right now, covers `rect`. */
    covers({x, y, width, height}) {
        const [left, top] = this.get_transformed_position();
        const bodyLeft = left + Math.max(0, this._shoulder.value);
        const bodyRight = bodyLeft + Math.max(0, this._width.value);
        return x >= bodyLeft && x + width <= bodyRight && y >= top &&
            y + height <= top + Math.max(0, this._height.value);
    }

    /** Whether the island's shape will cover `rect` once it settles: its body is centred on the monitor. */
    willCover({x, y, width, height}) {
        if (!this._monitor)
            return false;
        const {x: monitorX, y: top, width: monitorWidth} = this._monitor;
        const bodyWidth = Math.max(0, this._width.target);
        const bodyLeft = monitorX + (monitorWidth - bodyWidth) / 2;
        return x >= bodyLeft && x + width <= bodyLeft + bodyWidth && y >= top &&
            y + height <= top + Math.max(0, this._height.target);
    }

    /** Animates to `size` ({width, height, radius, shoulder}) and shows `view`, already sized to fit. */
    morph(size, view) {
        // Content travels with the shape: out with it as it grows, in from it as it shrinks.
        const growing = size.height + size.width > this._height.target + this._width.target;
        this._pointerAtMorph = global.get_pointer();
        this._width.setTarget(size.width);
        this._height.setTarget(size.height);
        this._radius.setTarget(size.radius);
        this._shoulder.setTarget(size.shoulder);

        // The first shape appears without animating: an island of zero size
        // is on no monitor, so it would get no frames to animate with.
        const firstShow = this._view === null;
        if (firstShow || !St.Settings.get().enable_animations) {
            for (const spring of this._springs)
                spring.reset(spring.target);
            this._sync();
        } else if (this._springs.some(spring => !spring.settled)) {
            // Already its size (an alert updating in place): no frame to run.
            this._driver.start();
        }
        this._showView(view, growing);
    }

    /** Shows `view` out of sight and reach (or hides it again) while the island rests closed, so its next
     * showing finds its style and layout ready. Never the view on screen: false then. */
    warmView(view, shown) {
        if (view === this._view)
            return false;
        if (shown) {
            // A fade still under way (it was on screen a moment ago) must not bring it back.
            view.remove_all_transitions();
            view.opacity = 0;
            // Just below the island, past its clip: unseen and out of reach, yet on the monitor, so its icons
            // and text are made at the monitor's scale now, not in the first frames it is opened.
            const below = Math.ceil(this.height) + 1;
            slideBy(view, 'y', below, below);
            this._placeView(view);
            view.show();
        } else {
            view.hide();
            slideBy(view, 'y', 0, 0);
        }
        return true;
    }

    /** Whether the island is still changing shape. */
    get morphing() {
        return this._driver?.running ?? false;
    }

    /** Whether the pointer hasn't moved since the island last changed shape: not only while it changes, as with
     * animations off (or on its first showing) it takes its new shape at once and the pointer is met after. */
    get changedUnderPointer() {
        if (!this._pointerAtMorph)
            return false;
        const [x, y] = global.get_pointer();
        return x === this._pointerAtMorph[0] && y === this._pointerAtMorph[1];
    }

    /** Adds a view, hidden. All views are added up front so they are always on the stage. */
    addView(view) {
        view.connect('notify::width', () => this._onViewWidth(view));
        view.opacity = 0;
        // For good: toggling it would restyle the view's every child.
        view.reactive = true;
        view.hide();
        this._stage.insert_child_below(view, this._stageEnd);
        this._views.push(view);
    }

    /** A quick rubber-band stretch, e.g. pressing volume up at 100%. */
    nudge() {
        if (!St.Settings.get().enable_animations)
            return;
        this._width.velocity += px(NUDGE_VELOCITY);
        this._driver.start();
    }

    // A view that changes width moves its edges at once; the one shown glides there instead (FLIP: it is put in its
    // new place, offset back to where it was, and slid to none in whole pixels), as the shape springs after.
    _onViewWidth(view) {
        const before = this._monitor ? view.x + this._islandX + this._stageX : null;
        this._placeView(view);
        // One that keeps its middle still (the closed island's clock) grows at its sides instead.
        if (before === null || view !== this._view || !view.mapped || view.keepsMiddle || !St.Settings.get().enable_animations)
            return;
        const offset = view.translation_x + before - (view.x + this._islandX + this._stageX);
        if (offset === 0)
            return;
        slideBy(view, 'x', offset, 0, {duration: GLIDE_MS});
    }

    /** Where `view` sits on screen: centred on the monitor, in whole pixels. */
    _screenX(view) {
        return Math.round(this._monitor.x + (this._monitor.width - view.width) / 2);
    }

    // Centres `view` on the monitor, not on the island: as the island grows or shrinks around it, the
    // view stays still on screen, where two separate roundings would shake it by a pixel each frame.
    _placeView(view) {
        const x = this._monitor
            ? this._screenX(view) - this._islandX - this._stageX
            : Math.round((Math.ceil(Math.max(0, this._width.value)) - view.width) / 2);
        view.set_position(x, 0);
    }

    /** Cross-fades from the shown view to `view`, both sliding the way the shape moves. */
    _showView(view, growing = true) {
        if (view === this._view)
            return;

        const previous = this._view;
        const shift = px(VIEW_SHIFT);
        // Down as the island takes room, up as it gives it; never sideways, it hangs from the top.
        if (previous) {
            previous.remove_all_transitions();
            slideBy(previous, 'y', previous.translation_y, growing ? shift : -shift, {duration: FADE_OUT});
            previous.ease({
                opacity: 0,
                duration: FADE_OUT,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: finished => {
                    if (!finished)
                        return;
                    previous.hide();
                    slideBy(previous, 'y', 0, 0);
                },
            });
        }

        this._view = view;
        // Still fading out (shown again within a moment): it comes back from where it is, without a blink.
        const returning = view.visible && view.opacity > 0;
        view.remove_all_transitions();
        this._placeView(view);
        const from = returning ? view.translation_y : growing ? -shift : shift;
        slideBy(view, 'x', 0, 0);
        view.show();
        if (!returning)
            view.opacity = 0;
        const delay = previous && !returning ? FADE_IN_DELAY : 0;
        view.ease({opacity: 255, delay, duration: FADE_IN, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        // Settles as the shape does.
        slideBy(view, 'y', from, 0, {delay, duration: FADE_IN + 80});
    }

    /** Sizes and places everything from the springs' current values; runs every animation frame. */
    _sync() {
        const width = Math.max(0, this._width.value);
        const height = Math.max(0, this._height.value);
        // The actor spans the body plus a shoulder on each side.
        const margin = Math.max(0, this._shoulder.value);
        const outerWidth = width + 2 * margin;

        this.set_size(Math.ceil(outerWidth), Math.ceil(height));
        const room = this._roomFor(outerWidth, height);
        // A pixel wider on each side, for the fraction the island is drawn off its whole-pixel place.
        this._shape.set_size(room.width + 2 * SHAPE_PAD, room.height);
        this._glow.set_size(room.width, room.height);
        this._viewsLayer.set_size(room.width, room.height);
        // Whole pixels keep text sharp while the island resizes.
        this._stageX = Math.round(margin);
        this._stage.set_position(this._stageX, 0);
        this._stage.set_size(Math.ceil(width), Math.ceil(height));
        if (this._monitor) {
            const {x, y, width: monitorWidth} = this._monitor;
            const exact = x + (monitorWidth - outerWidth) / 2;
            this._islandX = Math.round(exact);
            this._islandFraction = exact - this._islandX;
            this.set_position(this._islandX, y);
        }
        // A hidden view is placed as it shows.
        for (const view of this._views) {
            if (view.visible)
                this._placeView(view);
        }
        this._placeBackdrop(outerWidth, height, margin, width, room);
        this._syncShape();
        this._syncViews(room);
        this._queueGlow();
        this.emit('geometry-changed');
    }

    /** The size of the layers drawn by shaders: the island's own at rest; while it moves, grown to where it goes. */
    _roomFor(outerWidth, height) {
        const exact = {width: Math.ceil(outerWidth), height: Math.ceil(height)};
        if (this._springs.every(spring => spring.settled)) {
            this._room = exact;
            return exact;
        }
        const reach = (value, target) => Math.ceil(Math.max(value, target + ROOM_OVERSHOOT * Math.abs(target - value)) +
            px(ROOM_SLACK));
        const outerTarget = Math.max(0, this._width.target) + 2 * Math.max(0, this._shoulder.target);
        this._room = {
            width: Math.max(this._room.width, reach(outerWidth, outerTarget)),
            height: Math.max(this._room.height, reach(height, this._height.target)),
        };
        return this._room;
    }

    /** Cuts the views to the outline while the island moves; at rest they fit, drawn straight. */
    _syncViews(room) {
        const moving = !this._springs.every(spring => spring.settled);
        this._viewsMask.enabled = moving;
        if (!moving)
            return;
        const height = Math.max(0, this._height.value);
        const {left, right, top, radius, shoulder} = this._box(height);
        this._viewsMask.setUniforms({
            frame: [room.width, room.height, this._viewsLayer.get_resource_scale() || 1, 0],
            body: [left + this._islandFraction, right + this._islandFraction, top, height],
            corner: [radius, shoulder, 0, 0],
        });
    }

    /** The shape as it is now, in the theme's colour with its tint and edge, given to its shader. */
    _syncShape() {
        const height = Math.max(0, this._height.value);
        const {left, right, top, radius, shoulder} = this._box(height);
        const shift = SHAPE_PAD + this._islandFraction;
        const [width, actorHeight] = this._shape.get_size();
        const tinted = this._tint && this._tintStyle !== 'aura';
        const edge = Theme.edge();
        this._fill.setUniforms({
            frame: [width, actorHeight, this._shape.get_resource_scale() || 1, 0],
            body: [left + shift, right + shift, top, height],
            corner: [radius, shoulder, 0, 0],
            fill: Theme.fill(),
            tint: tinted ? [...this._tint, this._tintStrength] : [0, 0, 0, 0],
            style: {wash: 1, glow: 2}[this._tintStyle] ?? 0,
            edge: edge ? [...edge.color, 1] : [0, 0, 0, 0],
            edgeAlpha: edge ? [edge.top, edge.bottom] : [0, 0],
        });
    }

    /** The theme changed: the shape in its colour, glass blurring what is behind, and everything Cairo paints in
     * the island's colour (the bot's badge ring, a call's corners) drawn again. A rare change: a walk is fine. */
    refreshTheme() {
        this._backdrop.look = Theme.blur();
        this._sync();
        // Parts with more to change than a drawing (a call's rounded preview) follow in `syncTheme`; disabled
        // buttons take the look's dimming.
        const repaint = actor => {
            if (actor instanceof St.DrawingArea)
                actor.queue_repaint();
            actor.syncTheme?.();
            if (actor._isleDisabled)
                setEnabled(actor, false);
            actor.get_children().forEach(repaint);
        };
        repaint(this);
    }

    /** Whether an 'aura' tint lights the glow layer. */
    get _glowLit() {
        return this._tintStyle === 'aura' && Boolean(this._tint) && this._tintStrength > 0;
    }

    /** Shows the glow layer while it is lit. */
    _syncGlowShown() {
        this._glow.visible = this._glowLit;
    }

    /** Draws the glow layer once with nothing lit (its uniforms all 0), so its shader is built before an alert's or the
     * assistant's first frame needs it; that takes a frame of its own. */
    _warmGlow() {
        this.disconnect(this._warmId);
        this._warmId = 0;
        this._glow.visible = true;
        this._warmPaint = global.stage.connect('after-paint', () => {
            // Not drawn yet without a size.
            if (!this._glow.width || !this._glow.height)
                return;
            global.stage.disconnect(this._warmPaint);
            this._warmPaint = 0;
            this._syncGlowShown();
        });
    }

    // Moves the 'aura' once, just before the frame: the shape and the motion may both ask in one frame.
    _queueGlow() {
        if (!this._glowLit || this._glowLater)
            return;
        this._glowLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._glowLater = 0;
            if (this._glowLit)
                this._syncGlow();
            return false;
        });
    }

    /** The 'aura' light inside the shape as it is now, given to its shader. */
    _syncGlow() {
        const height = Math.max(0, this._height.value);
        const outerWidth = Math.max(0, this._width.value) + 2 * Math.max(0, this._shoulder.value);
        // In the pixels of the drawing it stands for (see GLOW_SCALE), which has the display's own.
        const pixels = Math.ceil(this._glow.get_resource_scale()) || 1;
        const box = this._box(height);
        const [width, actorHeight] = this._glow.get_size();
        this._rim.setUniforms({
            frame: [width, actorHeight, GLOW_SCALE / pixels, 0],
            grid: [Math.ceil(outerWidth / GLOW_SCALE) * pixels, Math.ceil(height / GLOW_SCALE) * pixels],
            ...rimUniforms({...box, left: box.left + this._islandFraction, right: box.right + this._islandFraction},
                height, this._tint, this._motion, this._tintStrength, uiScale()),
        });
    }

    /** The glass backdrop over the island as it is now drawn: its body, corners and shoulders (see `_box`). */
    _placeBackdrop(outerWidth, height, margin, width, room) {
        if (!this._monitor || !Theme.blur())
            return;
        const top = Math.min(this._topInset, height);
        const fraction = this._islandFraction;
        this._backdrop.place({
            stageX: this._islandX, stageY: this._monitor.y,
            width: room.width, height: room.height, bottom: height,
            left: margin + fraction, right: margin + width + fraction,
            radius: this._bodyRadius(height),
            shoulder: top > 0 ? 0 : Math.min(margin, Math.max(0, height / 2)),
            reach: GLASS_GLOW_REACH * uiScale(),
            open: Math.max(0, Math.min(1, (height / uiScale() - GLASS_CLOSED) / (GLASS_OPEN - GLASS_CLOSED))),
        });
    }

    /** The radius of the body's bottom corners, `height` tall. */
    _bodyRadius(height) {
        const top = Math.min(this._topInset, height);
        const margin = Math.max(0, this._shoulder.value);
        const shoulder = Math.min(margin, Math.max(0, (height - top) / 2));
        const hanging = Math.min(1, margin / px(SHOULDER_FADE));
        return Math.max(0, Math.min(this._radius.value, height - top * hanging - shoulder, Math.max(0, this._width.value) / 2));
    }

    /** The island's shape `height` tall: its body `left` to `right` below `top`, its bottom corners' `radius` and
     * its `shoulder`s', which flare from the band above the body (the top bar's, `top` deep) to its sides. */
    _box(height) {
        const top = Math.min(this._topInset, height);
        // Shoulders and corners must share the part below the top bar; an
        // island without shoulders may round its corners inside the bar.
        const margin = Math.max(0, this._shoulder.value);
        const shoulder = Math.min(margin, Math.max(0, (height - top) / 2));
        const left = margin;
        return {left, right: left + Math.max(0, this._width.value), top, radius: this._bodyRadius(height), shoulder};
    }

    /** Stops the springs and a pending glow redraw. */
    _onDestroy() {
        this._pulse?.stop();
        this._pulse = null;
        this._driver?.destroy();
        this._driver = null;
        if (this._glowLater)
            global.compositor.get_laters().remove(this._glowLater);
        this._glowLater = 0;
        if (this._warmPaint)
            global.stage.disconnect(this._warmPaint);
        this._warmPaint = 0;
    }
});
