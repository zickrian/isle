// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The call going on, with round controls: a live preview of the call's window (you and
// whoever you call), its app and duration, mute, and a way back. It only has a tab during a call.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL, onUiScale, px, uiScale} from '../compat.js';
import * as Format from '../format.js';
import {roundCorners} from '../glass.js';
import * as Theme from '../theme.js';
import {icon, label, setEnabled} from '../widgets.js';
import {Page} from './page.js';

/** Sizes in CSS pixels (see `px`). */
const PREVIEW_HEIGHT = 128;
/** The preview takes the window's shape within these widths, cropping what is wider. */
const PREVIEW_MIN_WIDTH = 168;
const PREVIEW_MAX_WIDTH = 228;
/** The preview's width while it shows only the app's icon. */
const PLACEHOLDER_WIDTH = 196;
const PREVIEW_RADIUS = 14;

/** A rounded rectangle path, for cairo. */
function roundedRect(cr, x, y, width, height, radius) {
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// A live copy of a window, drawn by the shell from what is on screen already: nothing is captured,
// and the copy only exists while it is shown. Without one it shows the app's icon.
const WindowPreview = GObject.registerClass(
class WindowPreview extends St.Widget {
    /** Builds the stacked layers: copy, icon placeholder, corners and hover mark. */
    _init() {
        super._init({
            style_class: 'isle-call-preview',
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            // Its parts expand to fill it; kept from spreading to the row, which would widen it.
            x_expand: false,
            y_expand: false,
        });
        this._width = PLACEHOLDER_WIDTH;
        this._window = null;
        this._actor = null;
        this._clone = null;
        this._windowIds = [];
        this._actorId = 0;

        // The copy is cropped and scaled by hand.
        this._view = new St.Widget({layout_manager: new Clutter.FixedLayout(), x_expand: true, y_expand: true});
        this._placeholder = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'isle-call-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._appIcon = new St.Icon({icon_size: 40, x_align: Clutter.ActorAlign.CENTER});
        this._hint = label('', 'isle-call-hint', {x_align: Clutter.ActorAlign.CENTER});
        this._placeholder.add_child(this._appIcon);
        this._placeholder.add_child(this._hint);
        // Rounds the corners by painting them in the island's colour, with a hairline edge.
        this._corners = new St.DrawingArea({x_expand: true, y_expand: true});
        this._corners.connect('repaint', area => this._repaintCorners(area));
        this._hover = new St.Bin({
            style_class: 'isle-call-preview-hover',
            child: new St.Icon({gicon: icon('isle-open-symbolic'), icon_size: 16}),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
        });
        for (const child of [this._view, this._placeholder, this._corners, this._hover])
            this.add_child(child);
        this.connect('destroy', () => this._detach());
        onUiScale(this, scale => {
            this.set_size(this._width * scale, PREVIEW_HEIGHT * scale);
            if (this._clone)
                this._layout();
            this.syncTheme();
        });
        this.syncTheme();
    }

    /** On glass the corners are cut away, as the glass round them varies; on black they are painted over. */
    syncTheme() {
        roundCorners(this, Theme.translucent() ? PREVIEW_RADIUS * uiScale() : null);
    }

    /** Shows `window` live, or else `gicon` with an optional `hint`. */
    update({window = null, gicon = null, hint = null}) {
        if (window !== this._window) {
            this._detach();
            if (window)
                this._attach(window);
        }
        const live = Boolean(this._clone);
        this._view.visible = live;
        this._placeholder.visible = !live;
        this._appIcon.gicon = gicon;
        this._hint.text = hint ?? '';
        this._hint.visible = Boolean(hint);
        if (!live)
            this._setWidth(PLACEHOLDER_WIDTH);
    }

    /** Shows the "go to the call" mark while the pointer is over it. */
    set hovered(hovered) {
        this._hover.ease({opacity: hovered ? 255 : 0, duration: 150});
    }

    /** Starts the live copy and follows the window as it moves or resizes. */
    _attach(window) {
        const actor = window.get_compositor_private();
        if (!actor)
            return;
        this._window = window;
        this._actor = actor;
        this._clone = new Clutter.Clone({source: actor});
        this._view.add_child(this._clone);
        this._windowIds = ['size-changed', 'position-changed'].map(signal =>
            window.connect(signal, () => this._layout()));
        this._actorId = actor.connect('destroy', () => this.update({gicon: this._appIcon.gicon}));
        this._layout();
    }

    /** Drops the copy and every signal on the window. */
    _detach() {
        this._windowIds.forEach(id => this._window.disconnect(id));
        this._windowIds = [];
        if (this._actorId)
            this._actor.disconnect(this._actorId);
        this._actorId = 0;
        this._clone?.destroy();
        this._clone = null;
        this._window = null;
        this._actor = null;
    }

    /** Fills the preview with the window's frame (not its shadow), centred. */
    _layout() {
        const frame = this._window.get_frame_rect();
        const buffer = this._window.get_buffer_rect();
        if (frame.width <= 0 || frame.height <= 0)
            return;
        const width = Math.min(PREVIEW_MAX_WIDTH, Math.max(PREVIEW_MIN_WIDTH,
            Math.round(PREVIEW_HEIGHT * frame.width / frame.height)));
        this._setWidth(width);
        // On the stage, in its pixels, as the window's frame is.
        const [stageWidth, stageHeight] = [px(width), px(PREVIEW_HEIGHT)];
        const scale = Math.max(stageWidth / frame.width, stageHeight / frame.height);
        this._clone.set_size(Math.round(buffer.width * scale), Math.round(buffer.height * scale));
        this._clone.set_position(
            Math.round((buffer.x - frame.x) * scale - (frame.width * scale - stageWidth) / 2),
            Math.round((buffer.y - frame.y) * scale - (frame.height * scale - stageHeight) / 2));
    }

    /** Sets the width, in CSS pixels. */
    _setWidth(width) {
        if (width === this._width)
            return;
        this._width = width;
        this.width = px(width);
    }

    /** The island's colour outside the rounded shape (not on glass: see `syncTheme`), then a faint white edge. */
    _repaintCorners(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const scale = uiScale();
        const radius = PREVIEW_RADIUS * scale, edge = scale / 2;
        if (!Theme.translucent()) {
            cr.rectangle(0, 0, width, height);
            roundedRect(cr, 0, 0, width, height, radius);
            cr.setFillRule(Cairo.FillRule.EVEN_ODD);
            cr.setSourceRGBA(...Theme.solid(), 1);
            cr.fill();
        }
        roundedRect(cr, edge, edge, width - 2 * edge, height - 2 * edge, radius - edge);
        cr.setSourceRGBA(1, 1, 1, 0.1);
        cr.setLineWidth(scale);
        cr.stroke();
        cr.$dispose();
    }
});

/** The call page: preview on the left, app, duration and controls on the right. */
export const CallPage = GObject.registerClass(
class CallPage extends Page {
    /** `call` is the call tracker; `privacy` says when the screen is shared or recorded. */
    _init(daemon, call, privacy, settings, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-call',
            // St's `spacing` only reaches St.BoxLayout, so it is set here, scaled as St would.
            layout_manager: new Clutter.BoxLayout(),
            height,
        });
        onUiScale(this, scale => (this.layout_manager.spacing = 22 * scale));
        this.name = 'call';
        this._call = call;
        this._privacy = privacy;
        this._settings = settings;
        this._available = call.active;

        this._preview = new WindowPreview();
        this._previewButton = new St.Button({
            style_class: 'isle-call-preview-button',
            child: this._preview,
            can_focus: true,
            track_hover: true,
            accessible_name: 'Go to the call',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._previewButton.connect('clicked', () => this._open());
        this._previewButton.connect('notify::hover', () => (this._preview.hovered = this._previewButton.hover));
        this.add_child(this._previewButton);

        const side = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'isle-call-side'});
        const head = new St.BoxLayout({style_class: 'isle-call-head'});
        this._appIcon = new St.Icon({icon_size: 20, y_align: Clutter.ActorAlign.CENTER});
        this._name = label('', 'isle-call-name');
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        head.add_child(this._appIcon);
        head.add_child(this._name);
        side.add_child(head);

        // "Video call · 12:34", the time in green as in the closed island.
        const status = new St.BoxLayout({style_class: 'isle-call-status'});
        this._kind = label('', 'isle-call-kind');
        this._duration = label('0:00', 'isle-call-duration');
        status.add_child(this._kind);
        status.add_child(label('·', 'isle-call-kind'));
        status.add_child(this._duration);
        side.add_child(status);

        const controls = new St.BoxLayout({style_class: 'isle-call-controls'});
        this._mute = this._control('isle-mic-symbolic', 'Mute', () => call.toggleMuted());
        this._show = this._control('isle-open-symbolic', 'Open', () => this._open());
        controls.add_child(this._mute.box);
        controls.add_child(this._show.box);
        side.add_child(controls);
        this.add_child(side);

        this._callChanged = call.connect('changed', () => this._update());
        this._settingsChanged = settings.connect('changed::call-preview', () => this._update());
        this._update();
        this.connect('destroy', () => this._onDestroy());
    }

    /** Only during a call. */
    get available() {
        return this._call.active;
    }

    /** During a call, a page worth opening on. */
    get relevant() {
        return this._call.active;
    }

    /** A round button with its caption below. */
    _control(iconName, caption, onClick) {
        const button = new St.Button({
            style_class: 'isle-call-control',
            child: new St.Icon({gicon: icon(iconName), icon_size: 18}),
            can_focus: true,
            accessible_name: caption,
            x_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', () => onClick());
        const text = label(caption, 'isle-call-control-label', {x_align: Clutter.ActorAlign.CENTER});
        const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-call-control-box'});
        box.add_child(button);
        box.add_child(text);
        return {box, button, text};
    }

    /** Raises the call's window and closes the island. */
    _open() {
        this._call.raise();
        this.emit('request-close');
    }

    /** Redraws from the call's state; tells the island when the tab comes or goes. */
    _update() {
        const call = this._call;
        if (call.active !== this._available) {
            this._available = call.active;
            this.emit('availability-changed');
        }
        if (!call.active) {
            this._preview.update({});
            return;
        }
        const gicon = call.gicon ?? icon('isle-phone-symbolic');
        this._appIcon.gicon = gicon;
        this._name.text = call.name;
        this._kind.text = call.video ? 'Video call' : 'Voice call';

        const muted = call.muted;
        this._mute.button.child.gicon = icon(muted ? 'isle-mic-off-symbolic' : 'isle-mic-symbolic');
        if (muted)
            this._mute.button.add_style_pseudo_class('checked');
        else
            this._mute.button.remove_style_pseudo_class('checked');
        this._mute.text.text = muted ? 'Muted' : 'Mute';
        this._mute.button.accessible_name = muted ? 'Unmute the microphone' : 'Mute the microphone';

        const reachable = Boolean(call.window || call.app);
        setEnabled(this._show.button, reachable);
        this._previewButton.reactive = reachable;
        this._preview.update({...this._previewSource(), gicon});
        this._tick();
    }

    /** What the preview shows: the call's window while this page is on screen, if allowed. */
    _previewSource() {
        const {window} = this._call;
        if (!this.active || !window || !this._settings.get_boolean('call-preview'))
            return {};
        // Whoever watches the shared or recorded screen should not see the call.
        if (this._privacy.screenShare || this._privacy.recording)
            return {hint: 'Hidden while sharing'};
        return {window};
    }

    /** Shows the call's length, just after each second turns. */
    _tick() {
        if (!this._call.active)
            return;
        const elapsedMs = (GLib.get_monotonic_time() - this._call.since) / 1000;
        this._duration.text = Format.duration(elapsedMs);
        if (this.active)
            this.later('tick', 1000 - (elapsedMs % 1000) + 10, () => this._tick());
    }

    /** Starts the preview and the clock. */
    onActivate() {
        this._update();
    }

    /** Swaps the live copy for the icon. */
    onDeactivate() {
        // The live copy only exists while it is shown.
        this._preview.update({gicon: this._appIcon.gicon});
    }

    /** Lets go of the call and settings signals. */
    _onDestroy() {
        this._call.disconnect(this._callChanged);
        this._settings.disconnect(this._settingsChanged);
    }
});
