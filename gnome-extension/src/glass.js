// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The glass theme's backdrop: copies of what lies under the island (wallpaper, windows, top bar), each redrawn
// only there, blurred by GNOME Shell's blur and cut to the island's shape by a shader.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {uiScale} from './compat.js';
import {effectPoint, shaderEffect} from './shader.js';

// The texture is `width` × `height`; the shape in it reaches down to `bottom`.
const SHAPE = ['width', 'height', 'bottom', 'left', 'right', 'radius', 'shoulder', 'crown', 'reach', 'drop'];
// How the blur is toned, in the same pass: its lightness mapped into a band (bright backdrops held `deep`er), its
// colour scaled, a sheen and a glow inside the body's edge, `reach` deep (see theme.js).
const TONE = ['saturation', 'lo', 'span', 'gamma', 'deep', 'sheen', 'glow'];
// And: from how light (`knee`, 0..1) a backdrop is held deeper; near the edge, `band` px deep, what is behind bent in
// by up to `lens` px, its red and blue `spread` apart (a thin rainbow where it bends most); the edge lit by `rim`, over
// about `rimWidth` px. No lens, no rim: none of that is done.
const LENS = ['knee', 'lens', 'band', 'spread', 'rim', 'rimWidth'];

// How far `p` is inside the body's edge: its sides, bottom and corners, and its top where that is free (a pill's).
const FUNCTIONS = `
float isleInner(vec2 p) {
    float d = min(min(p.x - left, right - p.x), bottom - p.y);
    if (p.y > bottom - radius) {
        vec2 c = vec2(clamp(p.x, left + radius, right - radius), bottom - radius);
        d = min(d, radius - length(p - c));
    }
    if (crown > 0.0) {
        d = min(d, p.y);
        if (p.y < crown) {
            vec2 c = vec2(clamp(p.x, left + crown, right - crown), crown);
            d = min(d, crown - length(p - c));
        }
    }
    return d;
}
// Which way is in, at p near the edge (a template literal: no backquotes in here).
vec2 isleNormal(vec2 p) {
    return normalize(vec2(isleInner(p + vec2(1.0, 0.0)) - isleInner(p - vec2(1.0, 0.0)),
        isleInner(p + vec2(0.0, 1.0)) - isleInner(p - vec2(0.0, 1.0))) + 1e-5);
}
`;

// Covered: the body (its bottom corners rounded, its top ones by `crown`) and the shoulders flaring out above it,
// each edge softened over a pixel, as Cairo draws the island's own outline (island.js `_outline`); toned within.
const CODE = `
vec2 p = ${effectPoint('vec2(width, height)')};
// The shape starts \`drop\` below the top (above, drawn up by auto-hide); what it cuts from stays where it is.
p.y -= drop;
float body = 0.0;
if (p.x >= left - 0.5 && p.x <= right + 0.5) {
    body = clamp(min(min(p.x - left, right - p.x), bottom - p.y) + 0.5, 0.0, 1.0);
    if (p.y > bottom - radius) {
        vec2 c = vec2(clamp(p.x, left + radius, right - radius), bottom - radius);
        body = min(body, clamp(0.5 - (length(p - c) - radius), 0.0, 1.0));
    }
    if (p.y < crown) {
        vec2 c = vec2(clamp(p.x, left + crown, right - crown), crown);
        body = min(body, clamp(0.5 - (length(p - c) - crown), 0.0, 1.0));
    }
}
float flare = 0.0;
if (shoulder > 0.0 && p.y < shoulder) {
    if (p.x < left && p.x > left - shoulder)
        flare = clamp(length(p - vec2(left - shoulder, shoulder)) - shoulder + 0.5, 0.0, 1.0);
    else if (p.x > right && p.x < right + shoulder)
        flare = clamp(length(p - vec2(right + shoulder, shoulder)) - shoulder + 0.5, 0.0, 1.0);
}
if (lens > 0.0) {
    float edgeIn = isleInner(p);
    if (edgeIn >= 0.0 && edgeIn < band) {
        // Inwards across the edge, most at the rim: there it shows what lies a little further in, as thick glass. Read
        // anew, so times the paint's own colour as Clutter's was (its opacity: the island fading as it hides).
        vec2 n = isleNormal(p);
        vec2 shift = n * lens * pow(1.0 - edgeIn / band, 2.0) / (vec2(width, height) + 3.0);
        vec2 uv = cogl_tex_coord_in[0].xy;
        vec4 bent = texture2D(cogl_sampler0, uv + shift);
        cogl_color_out = vec4(texture2D(cogl_sampler0, uv + shift * (1.0 + spread)).r, bent.g,
            texture2D(cogl_sampler0, uv + shift * (1.0 - spread)).b, bent.a) * cogl_color_in;
    }
}
float alpha = max(cogl_color_out.a, 0.0001);
vec3 rgb = cogl_color_out.rgb / alpha;
float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
rgb = lo + span * pow(max(luma, 0.0), gamma) * (1.0 - deep * smoothstep(knee, 1.0, luma)) + (rgb - luma) * span * saturation;
rgb += sheen * (1.0 - clamp(p.y / max(bottom, 1.0), 0.0, 1.0));
float inner = min(min(p.x - left, right - p.x), bottom - p.y);
if (p.y > bottom - radius) {
    vec2 c = vec2(clamp(p.x, left + radius, right - radius), bottom - radius);
    inner = min(inner, radius - length(p - c));
}
if (inner >= 0.0)
    rgb += glow * exp(-inner / reach) * (0.3 + 0.7 * p.y / max(bottom, 1.0));
if (rim > 0.0) {
    // Thick glass's edge catching the light: brightest where it faces up and left, again (less) down and right.
    float e = isleInner(p);
    if (e >= 0.0 && e < rimWidth * 8.0) {
        vec2 facing = -isleNormal(p);
        vec2 light = normalize(vec2(-1.0, -1.25));
        float lit = pow(max(dot(facing, light), 0.0), 1.6) + 0.6 * pow(max(dot(facing, -light), 0.0), 1.6);
        rgb += rim * (0.22 + lit) * (exp(-e / rimWidth) + 0.3 * exp(-e / (rimWidth * 3.5)));
    }
}
cogl_color_out.rgb = clamp(rgb, 0.0, 1.0) * cogl_color_out.a;
cogl_color_out *= max(body, flare);
`;

/** Cuts what it is on to the island's shape, and tones it. */
const ShapeMask = shaderEffect('ShapeMask', Object.fromEntries([...SHAPE, ...TONE, ...LENS].map(name => [name, 1])), CODE,
    FUNCTIONS);

/** Least time between two blurs of what changed under a resting island: what is behind it (a video, a page
 * scrolling) is blurred at most this often, never the island's own motion, which is the shape (see `BackdropMask`). */
const BACKDROP_FRAME_MS = 33;
/** For this long after its shape last changed, the island counts as moving: everything is blurred at once. */
const SETTLE_MS = 250;

/** The island's shape mask, which also keeps the blur it drew: while the island rests, a change under it is blurred
 * again at most every `BACKDROP_FRAME_MS`, the last one always; in between, the blur it has is shown again (no copy
 * drawn, no blur). Its shape and tone, and everything while it moves, are drawn every frame as before. */
const BackdropMask = GObject.registerClass(
class BackdropMask extends ShapeMask {
    _init() {
        super._init();
        this._shapedAt = 0;
        this._blurredAt = 0;
        this._catchUp = 0;
    }

    /** The shape (or tone) changed now: the island is moving, or just was. */
    shaped() {
        this._shapedAt = GLib.get_monotonic_time();
    }

    vfunc_paint(node, paintContext, flags) {
        const now = GLib.get_monotonic_time();
        const dirty = flags & Clutter.EffectPaintFlags.ACTOR_DIRTY;
        const resting = now - this._shapedAt > SETTLE_MS * 1000;
        const wait = BACKDROP_FRAME_MS * 1000 - (now - this._blurredAt);
        if (dirty && resting && wait > 0 && this._blurredAt) {
            // Shown as it was; blurred again when its time comes (the actor stays dirty until then).
            this._queueCatchUp(Math.ceil(wait / 1000));
            super.vfunc_paint(node, paintContext, flags & ~Clutter.EffectPaintFlags.ACTOR_DIRTY);
            return;
        }
        if (dirty)
            this._blurredAt = now;
        super.vfunc_paint(node, paintContext, flags);
    }

    _queueCatchUp(ms) {
        if (this._catchUp)
            return;
        this._catchUp = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms), () => {
            this._catchUp = 0;
            this.get_actor()?.queue_redraw();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Its pending catch-up stopped: the backdrop it is on goes or rests (an effect has no `destroy` of its own). */
    stopCatchUp() {
        if (this._catchUp)
            GLib.source_remove(this._catchUp);
        this._catchUp = 0;
    }
});

/** `names` paired with `values`, as `setUniforms` takes them. */
const zip = (names, values) => Object.fromEntries(names.map((name, i) => [name, values[i]]));

/** Rounds every corner of `actor` by `radius` (in its pixels) in an offscreen pass, so what is round it shows
 * through the corners; null takes it off. For a small actor only (a call's preview). */
export function roundCorners(actor, radius) {
    let mask = actor._roundMask;
    if (radius === null) {
        if (mask) {
            actor.disconnect(mask._sizeId);
            actor.remove_effect(mask);
            actor._roundMask = null;
        }
        return;
    }
    if (!mask) {
        mask = actor._roundMask = new ShapeMask();
        mask.setUniforms(zip(TONE, [1, 0, 1, 1, 0, 0, 0]));
        mask.setUniforms(zip(LENS, [0.55, 0, 1, 0, 0, 1]));
        mask._sizeId = actor.connect('notify::allocation', () => syncRound(actor));
        actor.add_effect(mask);
    }
    mask._radius = radius;
    syncRound(actor);
}

function syncRound(actor) {
    const mask = actor._roundMask;
    const [width, height] = actor.get_size();
    const radius = Math.min(mask._radius, width / 2, height / 2);
    mask.setUniforms(zip(SHAPE, [width, height, height, 0, width, radius, 0, radius, 1, 0]));
}

// What a copy of a window follows of it: a clone draws its source without the source's own fade and motion.
const MIRRORED = ['opacity', 'scale-x', 'scale-y', 'pivot-point', 'translation-x', 'translation-y'];

/** What of a window is copied: its surfaces alone. Other extensions add to the window's actor (Blur my Shell's
 * blur behind it reads the screen, and drawn a second time here its real one flickers, #23). */
function surfaceOf(actor) {
    return actor.get_children().find(child => child.constructor.$gtype?.name?.startsWith('MetaSurface')) ?? actor;
}

/** A window's moves, resizes and fades: any can uncover a window under it (see `GlassBackdrop._prune`). Each is set
 * before the frame it shows in, where its new allocation is only known as that frame is laid out. */
const UNCOVERING = ['x', 'y', 'width', 'height', ...MIRRORED.filter(name => name !== 'pivot-point')]
    .map(name => `notify::${name}`);

/** Whether `a` and `b` ({x, y, width, height}) share any pixel. */
function overlaps(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** The surfaces in `actor` for which GNOME keeps `is-obscured`: whether each lies wholly under windows that are opaque
 * there, worked out before every frame and whatever copies it. None where GNOME has no such property. */
function surfacesIn(actor) {
    const found = GObject.Object.find_property.call(actor.constructor, 'is-obscured') ? [actor] : [];
    for (const child of actor.get_children())
        found.push(...surfacesIn(child));
    return found;
}

/** Whether `surface` (see `surfacesIn`) is wholly under windows that are opaque there. */
function isObscured(surface) {
    // A property of a class GNOME doesn't describe, so read through a GValue.
    const value = new GObject.Value();
    value.init(GObject.TYPE_BOOLEAN);
    surface.get_property('is-obscured', value);
    return value.get_boolean();
}

/** A copy that tells Clutter it draws only within `paintArea` (its own pixels), so a change in its source redraws
 * just that part of the screen; with `mirror` (an actor), it fades, scales and moves as that does. */
const AreaClone = GObject.registerClass(
class AreaClone extends Clutter.Clone {
    _init(source, {mirror = null} = {}) {
        super._init({source});
        this._area = null;
        this._bindings = mirror
            ? MIRRORED.map(name => mirror.bind_property(name, this, name, GObject.BindingFlags.SYNC_CREATE)) : [];
        this.connect('destroy', () => this._bindings.forEach(binding => binding.unbind()));
    }

    set paintArea(area) {
        const old = this._area;
        if (old && ['x', 'y', 'width', 'height'].every(key => old[key] === area[key]))
            return;
        this._area = area;
        // Clutter keeps the last volume until told: the redraws would stay in the old area.
        this.invalidate_paint_volume();
    }

    vfunc_get_paint_volume(volume) {
        if (!this._area)
            return false;
        volume.set_origin(new Graphene.Point3D({x: this._area.x, y: this._area.y, z: 0}));
        volume.set_width(this._area.width);
        volume.set_height(this._area.height);
        return true;
    }
});

/** The blurred backdrop of a see-through theme, for the island or any rounded shape beside it. The blur is on a frame a
 * radius larger all round (its edges blur what is there); the cut on this actor, so its shader's pixels are the shape's. */
export const GlassBackdrop = GObject.registerClass(
class GlassBackdrop extends St.Widget {
    _init() {
        super._init({visible: false, clip_to_allocation: true});
        this._pad = 0;
        this._on = false;
        this._rect = null;
        this._frame = new St.Widget({clip_to_allocation: true});
        this.add_child(this._frame);
        // The copies, at their places on the screen: the wallpaper, the windows under the island, the top bar.
        this._layers = new Clutter.Actor();
        this._frame.add_child(this._layers);
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR});
        this._frame.add_effect(this._blur);
        this._mask = new BackdropMask();
        this.add_effect(this._mask);
        this._wallpaper = null;
        this._bar = null;
        this._windows = new Map();
        this._watched = new Set();
        this._places = null;
        /** Override-redirect windows (an X11 menu) where they are: not copied (see `_prune`). */
        this._overrides = [];
        this._later = 0;
        /** Whether a copy is hidden, under other windows (see `_prune`), and the look that hides those. */
        this._pruned = false;
        this._pruneLater = 0;
        // Going with the island (Isle off, the shell shutting down): its signals and copies go with it; only a
        // pending look is taken back, as the shell may already be gone.
        this.connect('destroy', () => {
            this._on = false;
            this._mask.stopCatchUp();
            if (this._later)
                global.compositor?.get_laters().remove(this._later);
            if (this._pruneLater)
                global.compositor?.get_laters().remove(this._pruneLater);
            this._later = this._pruneLater = 0;
            this._watched.clear();
            this._windows.clear();
            this._places = null;
        });
    }

    /** Shows it blurred and toned as `blur` says ({radius, brightness, small, large, lo, span, gamma, sheen, glow}:
     * see theme.js), or takes it down for null. */
    set look(blur) {
        if (blur) {
            this._blur.radius = blur.radius;
            this._blur.brightness = blur.brightness;
            this._tone = blur;
            this._pad = blur.radius;
            this._start();
        } else {
            this._stop();
        }
        this._syncVisible();
    }

    /** Copies and follows what is behind the island. */
    _start() {
        if (this._on)
            return;
        this._on = true;
        this._wallpaper = new AreaClone(Main.layoutManager._backgroundGroup);
        // The bar alone, not its box: Blur my Shell puts its blur there, and copied it flickers (#31, as #23).
        this._bar = new AreaClone(Main.panel);
        this._layers.add_child(this._wallpaper);
        this._layers.add_child(this._bar);
        // Each let go of when either side goes, so nothing is left behind as the shell shuts down.
        const later = () => this._queueSync();
        global.window_group.connectObject('child-added', later, 'child-removed', later, this);
        global.display.connectObject('restacked', later, this);
        // A bar that hides or slides away (another extension) shows here as it is.
        Main.layoutManager.panelBox.connectObject('notify::allocation', later, 'notify::mapped', later,
            'notify::translation-y', later, this);
        Main.panel.connectObject('notify::allocation', later, this);
        // The overview hides the windows; the island shows its colour alone there.
        Main.overview.connectObject('showing', () => this._syncVisible(), 'hidden', () => this._syncVisible(), this);
        this._queueSync();
    }

    /** Lets go of every copy and signal: glass turned off. */
    _stop() {
        if (!this._on)
            return;
        this._on = false;
        if (this._later)
            global.compositor.get_laters().remove(this._later);
        if (this._pruneLater)
            global.compositor.get_laters().remove(this._pruneLater);
        this._later = this._pruneLater = 0;
        this._pruned = false;
        this._mask.stopCatchUp();
        for (const object of [global.window_group, global.display, Main.layoutManager.panelBox, Main.panel, Main.overview])
            object.disconnectObject(this);
        this._watched.forEach(actor => actor.disconnectObject(this));
        this._watched.clear();
        this._places = null;
        this._windows.forEach(clone => clone.destroy());
        this._windows.clear();
        this._wallpaper?.destroy();
        this._bar?.destroy();
        this._wallpaper = this._bar = null;
    }

    _syncVisible() {
        this.visible = this._on && !Main.overview.visible;
    }

    /** Looks again at the windows once before the next frame, however many changed. */
    _queueSync() {
        this._places = null;
        if (!this._on || this._later)
            return;
        this._later = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._later = 0;
            this._syncWindows();
            return false;
        });
    }

    /** The windows that may be copied, in their stacking order, with where each is: read again only after one changed
     * (see `_queueSync`), not on every frame of the island moving. */
    _windowPlaces() {
        if (this._places)
            return this._places;
        const actors = global.get_window_actors();
        // Every window is followed (a move can bring one under the island); only those under it are copied.
        for (const actor of actors) {
            if (this._watched.has(actor))
                continue;
            this._watched.add(actor);
            actor.connectObject(
                'notify::allocation', () => this._queueSync(),
                'notify::visible', () => this._queueSync(),
                // Its surfaces can be replaced (an X11 window going full screen): copied anew.
                'child-added', () => this._queueSync(),
                'child-removed', () => this._queueSync(),
                // A closed window's actor goes with its handlers: only forgotten here.
                'destroy', () => {
                    this._watched.delete(actor);
                    this._queueSync();
                }, this);
            // At once, not before the next frame: the frame it moves in may already show what it uncovers.
            for (const signal of UNCOVERING)
                actor.connectObject(signal, () => this._unprune(), this);
        }
        const place = actor => ({actor, x: actor.x, y: actor.y, width: actor.width, height: actor.height});
        const shown = actors.filter(actor => actor.visible);
        this._places = shown.filter(actor => !actor.meta_window?.is_override_redirect()).map(place);
        this._overrides = shown.filter(actor => actor.meta_window?.is_override_redirect()).map(place);
        return this._places;
    }

    /** Hides the copies of windows wholly under others, as GNOME found them at the last frame (`is-obscured`), so
     * what changes in them blurs nothing again, and GNOME may let them rest: a window covered on screen is asked to
     * draw no frames, but one that is copied is drawn here, so it would draw on (a video behind a maximised window,
     * 60 frames a second). What covers them is copied above them, so the glass looks the same. Not while an
     * override-redirect window (not copied) reaches under the island. */
    _prune() {
        const rect = this._frameRect();
        if (!this._on || !rect || this._overrides.some(place => overlaps(place, rect)))
            return;
        for (const clone of this._windows.values()) {
            if (clone.visible && this._covered(clone)) {
                clone.hide();
                this._pruned = true;
            }
        }
    }

    /** Whether all of `clone`'s window is under other windows; follows each of its surfaces, to show it again the
     * moment that changes. */
    _covered(clone) {
        const surfaces = surfacesIn(clone.source);
        clone._surfaces ??= new Set();
        for (const surface of surfaces) {
            if (clone._surfaces.has(surface))
                continue;
            clone._surfaces.add(surface);
            surface.connectObject('notify::is-obscured', () => {
                if (isObscured(surface))
                    this._queuePrune();
                else
                    this._unprune();
            }, 'destroy', () => clone._surfaces?.delete(surface), clone);
        }
        return surfaces.length > 0 && surfaces.every(isObscured);
    }

    /** Hides what is under other windows once this frame is drawn: GNOME then knows what it covers. */
    _queuePrune() {
        if (!this._on || this._pruneLater)
            return;
        this._pruneLater = global.compositor.get_laters().add(Meta.LaterType.IDLE, () => {
            this._pruneLater = 0;
            this._prune();
            return false;
        });
    }

    /** Shows every copy hidden by `_prune` again, then looks again after the frame: something moved, and may
     * have uncovered one. */
    _unprune() {
        // A window moved, faded, came or went: blurred every frame while that goes on (see `BackdropMask`).
        this._mask.shaped();
        if (this._pruned) {
            this._pruned = false;
            this._windows.forEach(clone => clone.show());
        }
        this._queuePrune();
    }

    /** Copies the windows that reach under the island, in their stacking order, and follows each window. */
    _syncWindows() {
        if (!this._on)
            return;
        const places = this._windowPlaces();
        const rect = this._frameRect();
        const under = rect ? places.filter(place => overlaps(place, rect)).map(({actor}) => actor) : [];
        // Whatever changed may have uncovered one: all shown, and those still covered hidden after the frame.
        this._unprune();
        for (const [actor, clone] of this._windows) {
            if (!under.includes(actor)) {
                clone.destroy();
                this._windows.delete(actor);
            }
        }
        let below = this._wallpaper;
        for (const actor of under) {
            let clone = this._windows.get(actor);
            const source = surfaceOf(actor);
            if (clone && clone.source !== source) {
                clone.destroy();
                clone = null;
            }
            if (!clone) {
                clone = new AreaClone(source, {mirror: actor});
                // A surface that comes or goes (a video's) may not be covered: looked at again.
                if (source !== actor)
                    source.connectObject('child-added', () => this._queueSync(), 'child-removed', () => this._queueSync(), clone);
                this._windows.set(actor, clone);
                this._layers.add_child(clone);
            }
            // Only when out of order: restacking always lays the copies out again.
            if (clone.get_previous_sibling() !== below)
                this._layers.set_child_above_sibling(clone, below);
            below = clone;
        }
        if (this._bar.get_previous_sibling() !== below)
            this._layers.set_child_above_sibling(this._bar, below);
        this._placeCopies();
    }

    /** Where the frame lies on the screen, or null before it is placed. */
    _frameRect() {
        if (!this._rect)
            return null;
        const {stageX, stageY, width, height} = this._rect, pad = this._pad;
        return {x: stageX - pad, y: stageY - pad, width: width + 2 * pad, height: height + 2 * pad};
    }

    /** Each copy at its source's place, drawing only over the frame. */
    _placeCopies() {
        const rect = this._frameRect();
        if (!rect)
            return;
        this._layers.set_position(-rect.x, -rect.y);
        const place = (clone, x, y) => {
            clone.set_position(x, y);
            clone.paintArea = {x: rect.x - x, y: rect.y - y, width: rect.width, height: rect.height};
        };
        place(this._wallpaper, 0, 0);
        const bar = Main.layoutManager.panelBox;
        this._bar.visible = bar.mapped;
        place(this._bar, bar.x + bar.translation_x + Main.panel.x, bar.y + bar.translation_y + Main.panel.y);
        // A window scales its surfaces up itself on a display scaled without scaled views (GNOME 46 at 200%).
        this._windows.forEach((clone, actor) => {
            // A window with no surfaces yet is copied whole, until they come (see `surfaceOf`).
            if (clone.source === actor) {
                place(clone, actor.x, actor.y);
                return;
            }
            const scale = actor.get_child_transform?.()?.get_x_scale?.() || 1;
            clone.set_size(clone.source.width * scale, clone.source.height * scale);
            place(clone, actor.x + clone.source.x * scale, actor.y + clone.source.y * scale);
        });
    }

    /**
     * Over `width` × `height` at `stageX`, `stageY`: the body `left` to `right` and down to `bottom`, its bottom corners
     * `radius` round and its top ones `crown` (a pill, a bubble), shoulders `shoulder` wide, its glow `reach` deep, `open` 0..1;
     * all of it `drop` below the top (above for less than 0), over the same blurred frame.
     */
    place({stageX, stageY, width, height, bottom = height, left, right, radius, shoulder = 0, crown = 0, reach, open, drop = 0}) {
        if (!this._on)
            return;
        const old = this._rect;
        this._rect = {stageX, stageY, width, height};
        const pad = this._pad;
        this.set_size(width, height);
        this._frame.set_position(-pad, -pad);
        this._frame.set_size(width + 2 * pad, height + 2 * pad);
        this._mask.shaped();
        this._mask.setUniforms(zip(SHAPE, [width, height, bottom, left, right, Math.min(radius, (right - left) / 2, bottom),
            shoulder, Math.min(crown, (right - left) / 2, bottom), reach, drop]));
        const tone = this._tone;
        this._mask.setUniforms(zip(TONE, [tone.small + (tone.large - tone.small) * open, tone.lo, tone.span, tone.gamma,
            tone.deep ?? 0, tone.sheen, tone.glow]));
        this._mask.setUniforms(zip(LENS, [tone.knee ?? 0.55, (tone.lens ?? 0) * uiScale(), (tone.band ?? 1) * uiScale(),
            tone.spread ?? 0, tone.rim ?? 0, (tone.rimWidth ?? 1) * uiScale()]));
        // A new size can bring other windows under it.
        if (!old || old.stageX !== stageX || old.stageY !== stageY || old.width !== width || old.height !== height)
            this._syncWindows();
    }
});
