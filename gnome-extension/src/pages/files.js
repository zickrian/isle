// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The shelf's Files tab. The `isle-shelf` helper draws it over this view for drag and
// drop; both look the same tile for tile, so the hand-over cannot be seen.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL, onUiScale, px, uiScale} from '../compat.js';
import {isShelfCopy} from '../downloads.js';
import {Lines, icon, iconButton, label} from '../widgets.js';

/** The shelf holds this many files (as isled enforces). */
export const SHELF_CAPACITY = 6;

// Sizes in CSS pixels (see `px`); keep them in step with the helper's tile.rs, which GTK scales likewise.
const TILE_WIDTH = 84;
const PREVIEW_SIZE = 52;
const ICON_SIZE = 46;
const REMOVE_SIZE = 18;
/** The ×'s disc as the helper draws it: GTK puts its 1.5 px border outside the 18 px. */
const REMOVE_DISC = REMOVE_SIZE + 3;
const NAME_WIDTH = 76;
/** The preview's square plus room above it for the ×. */
const FRAME_HEIGHT = PREVIEW_SIZE + 6;
/** How long "copied" shows on a tile. */
const COPIED_MS = 1100;
/** The drop zone's dashed outline, drawn here alone, under the helper's see-through window too: one dash
 * all the time (St borders cannot dash, and GTK's 1 px dashes are dots). */
const ZONE_RADIUS = 16;
const DASH = [4, 3];
/** A file landing flashes the outline white, fading out over this long. */
const LANDED_MS = 650;
/** The drop zone's outline and fill (white alphas): at rest, a file on its way, a file over it. */
const ZONE = {idle: [0.22, 0.025], near: [0.35, 0.035], over: [0.65, 0.06]};
/** The light rising inside it from the bottom, until the drop light gives its colours: blue into violet. */
const ZONE_GLOW = [[0.43, 0.48, 1], [0.54, 0.36, 1]];
const ZONE_GLOW_ALPHA = [0.45, 0.12];
const FILES_TYPE = 'x-special/gnome-copied-files';

/** How fast the ↓ shows and goes with the pointer. */
const SAVE_FADE_MS = 120;

// The tiles and drop zone St draws itself, seen whenever the helper window isn't over them. Signals:
// `save` (uri) for ↓ on a file the Shelf keeps itself.
export const FilesView = GObject.registerClass({
    Signals: {'save': {param_types: [GObject.TYPE_STRING]}},
}, class FilesView extends St.Widget {
    /** `thumbnails` loads the previews and keeps them while the files stay. */
    _init(daemon, thumbnails) {
        super._init({
            style_class: 'isle-shelf-files',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._daemon = daemon;
        this._thumbnails = thumbnails;
        /** isled's last list: kept while it is away, as the helper keeps its own, so the two never disagree. */
        this._items = [];
        this._helperActive = false;
        /** Fading out under the helper's window as it fades in (see `handOver`). */
        this._handingOver = false;
        this._helperAvailable = false;
        this._dropping = false;
        this._dropOver = false;
        /** Why the files on their way can't all land: 'local', 'room' or null (see ShelfPage's `_refusal`). */
        this._refusal = null;
        this._refused = false;
        /** How lit the zone is (0..1), with the island's drop light, and in which colours. */
        this._light = 0;
        /** How bright a file's landing still leaves the outline (1 at landing, then down to 0). */
        this._landed = 0;
        this._glow = ZONE_GLOW;
        this._lastClick = {uri: null, at: 0};
        /** Each file's tile, kept while the file stays, so its preview never reloads (and blinks). */
        this._tileFor = new Map();

        // Expanding, as BinLayout only honours START for children that do.
        this._tiles = new St.BoxLayout({
            style_class: 'isle-shelf-tiles',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._tiles);

        this._empty = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'isle-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._empty.add_child(new St.Icon({gicon: icon('isle-shelf'), icon_size: 24, style_class: 'isle-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        this._emptyTitle = label('', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER});
        this._emptyHint = label('', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER});
        this._empty.add_child(this._emptyTitle);
        this._empty.add_child(this._emptyHint);
        this.add_child(this._empty);
        // Behind the tiles, so its fill never tints them.
        this._zone = new St.DrawingArea({x_expand: true, y_expand: true, visible: false});
        this._zone.connect('repaint', area => this._paintZone(area));
        this._landing = new Clutter.Timeline({actor: this._zone, duration: LANDED_MS, progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._landing.connect('new-frame', timeline => {
            this._landed = 1 - timeline.get_progress();
            this._zone.queue_repaint();
        });
        this._landing.connect('stopped', () => {
            this._landed = 0;
            if (!this._destroyed)
                this._syncZone();
        });
        this.insert_child_at_index(this._zone, 0);
        this.connect('destroy', () => {
            this._destroyed = true;
            this._landing.stop();
        });
        this.update();
        // Another scale: the tiles are made again at its size.
        onUiScale(this, () => {
            for (const tile of this._tileFor.values())
                tile.destroy();
            this._tileFor.clear();
            this.update();
        }, {now: false});
    }

    /** While the helper window covers this tab, show nothing of its own so the two never mix. */
    set helperActive(active) {
        this._handingOver = false;
        if (active === this._helperActive)
            return;
        this._helperActive = active;
        this.update();
    }

    /** The helper's window fading in over the tiles: they fade out with it, so the names are never drawn twice in
     * full (doubled, as if bold). Ended by `helperActive`, or `handBack` when the window doesn't come. */
    handOver(duration) {
        this._handingOver = true;
        // Only the names and ×: the pictures are the same in the window, so they stay (fading both would dim them).
        for (const part of this._handedOverParts())
            part.ease({opacity: 0, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    /** Each tile's name and ×, which the helper's window draws again a pixel or two off. */
    _handedOverParts() {
        return [...this._tileFor.values()].flatMap(tile => tile._handedOver ?? []);
    }

    /** The parts `handOver` faded, whole again (unseen under the window, or shown again). */
    _restoreParts() {
        for (const part of this._handedOverParts()) {
            part.remove_transition('opacity');
            part.opacity = 255;
        }
    }

    /** The helper's window went before it was in: the tiles show again. */
    handBack() {
        if (!this._handingOver)
            return;
        this._handingOver = false;
        this.update();
    }

    /** Whether the helper is installed, so files can be dropped here. */
    set helperAvailable(available) {
        if (available === this._helperAvailable)
            return;
        this._helperAvailable = available;
        this.update();
    }

    /** A file is on its way: the zone and words say where it will land; the tiles stay as they are. */
    set dropping(dropping) {
        if (dropping === this._dropping)
            return;
        this._dropping = dropping;
        this._syncZone();
        this._updateEmptyText();
    }

    /** The file is right over the drop zone. */
    set dropOver(over) {
        if (over === this._dropOver)
            return;
        this._dropOver = over;
        this._zone.queue_repaint();
        this._updateEmptyText();
    }

    /** Why the files on their way can't all land, or null: the zone stays unlit, its outline red. */
    set refusal(refusal) {
        if (refusal === this._refusal)
            return;
        this._refusal = refusal;
        this._refused = Boolean(refusal);
        this._zone.queue_repaint();
        this._updateEmptyText();
    }

    /** How lit the zone is (0..1); it follows the island's drop light. */
    set light(level) {
        this._light = level;
        if (this._zone.visible)
            this._zone.queue_repaint();
    }

    /** The light's colours (RGB 0..1, eased in place): the zone glows in the first into the last. */
    set glowColors(colors) {
        this._glow = [colors[0], colors[colors.length - 1]];
        this._zone.queue_repaint();
    }

    /** A file landed: the outline flashes white and fades. */
    flashLanded() {
        this._landing.stop();
        this._landed = 1;
        this._syncZone();
        this._landing.start();
    }

    /** The zone's fill, its rising light and its dashes; only the dashes while a landing fades over files. */
    _paintZone(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const full = this._refused;
        const dragging = this._dropping && this._helperAvailable;
        const [from, to] = [ZONE[dragging ? 'near' : 'idle'], ZONE.over];
        const t = full ? 0 : Math.min(1, this._light);
        const [line, fill] = from.map((value, i) => value + (to[i] - value) * t);
        const scale = uiScale();
        const zone = dragging || this._items.length === 0;
        roundedRect(cr, width, height, ZONE_RADIUS * scale, 0.5 * scale);
        cr.setSourceRGBA(1, 1, 1, zone ? fill : 0);
        cr.fillPreserve();
        if (zone && t > 0) {
            cr.save();
            cr.clipPreserve();
            const glow = new Cairo.RadialGradient(width / 2, height * 1.3, 0, width / 2, height * 1.3, width * 0.55);
            glow.addColorStopRGBA(0, ...this._glow[0], ZONE_GLOW_ALPHA[0] * t);
            glow.addColorStopRGBA(0.55, ...this._glow[1], ZONE_GLOW_ALPHA[1] * t);
            glow.addColorStopRGBA(1, 0, 0, 0, 0);
            cr.setSource(glow);
            cr.paint();
            cr.restore();
        }
        if (full && dragging)
            cr.setSourceRGBA(1, 0.36, 0.36, 0.6);
        else
            cr.setSourceRGBA(1, 1, 1, Math.max(zone ? line : 0, 0.9 * this._landed));
        strokeDashed(cr, scale);
        cr.$dispose();
    }

    /** isled's last list (kept while it is away), as the tiles show it. */
    get items() {
        return this._items;
    }

    /** Redraws from isled's shelf list. */
    update() {
        // While isled is away (no list) the last one stays, previews and all.
        if (this._daemon.state.shelf) {
            this._items = this._daemon.state.shelf;
            this._thumbnails.keepOnly(this._items.map(item => item.uri));
        }
        const items = this._items;
        this._syncTiles(items);
        this._syncZone();
        this._tiles.visible = items.length > 0;
        this._empty.visible = items.length === 0;
        // Under the helper's window the tiles stay laid out but unseen (hidden, the tab would shrink and the
        // window go, blinking). The empty shelf's words are only drawn here: the helper's are see-through.
        if (!this._handingOver) {
            this._tiles.opacity = this._helperActive ? 0 : 255;
            this._restoreParts();
        }
        this._updateEmptyText();
    }

    /** At rest it marks an empty shelf; under the helper's see-through window too, which draws none. */
    _syncZone() {
        const dragging = this._dropping && this._helperAvailable;
        this._zone.visible = dragging || this._landed > 0 || this._items.length === 0;
        this._zone.queue_repaint();
    }

    /** A tile per file, newest first; a file's tile is made once and kept while it stays. */
    _syncTiles(items) {
        const wanted = new Set(items.map(item => item.uri));
        for (const [uri, tile] of this._tileFor) {
            if (!wanted.has(uri)) {
                tile.destroy();
                this._tileFor.delete(uri);
            }
        }
        items.forEach((item, index) => {
            let tile = this._tileFor.get(item.uri);
            if (!tile) {
                tile = this._tile(item);
                this._tileFor.set(item.uri, tile);
                this._tiles.insert_child_at_index(tile, index);
            } else if (this._tiles.get_child_at_index(index) !== tile) {
                this._tiles.set_child_at_index(tile, index);
            }
        });
    }

    /** What the empty shelf says, as the helper does: where to drop, and what then. */
    _updateEmptyText() {
        const dragging = this._dropping && this._helperAvailable;
        // The same words as the helper's (crates/isle-shelf), which keeps its own see-through.
        let title = 'No files on the shelf', hint = 'Drop files here, then drag them into any app';
        if (!this._helperAvailable)
            [title, hint] = ['No files on the shelf', 'Dropping files here isn’t set up; install Isle again to add it'];
        else if (dragging && this._dropOver && this._refusal === 'local')
            [title, hint] = ['Only files on this computer', 'Links and files online can’t be kept'];
        else if (dragging && this._dropOver && this._refusal)
            [title, hint] = ['Too many files', 'The shelf holds six at a time'];
        else if (dragging)
            [title, hint] = [this._dropOver ? 'Release to add it' : 'Drop to add it', 'Then drag it into any app, or click to copy it'];
        this._emptyTitle.text = title;
        this._emptyHint.text = hint;
    }

    // Tiles

    /** One file: its preview, a × to take it off, and its name; the thumbnail comes in later. */
    _tile(item) {
        const preview = new St.Bin({style_class: 'isle-shelf-preview', width: px(PREVIEW_SIZE), height: px(PREVIEW_SIZE)});
        // A plain file icon until the file's own one is known (or for good,
        // if the file is gone).
        preview.child = new St.Icon({gicon: icon('isle-file'), icon_size: ICON_SIZE * 0.6, opacity: 160});

        const copied = new St.Bin({
            style_class: 'isle-shelf-copied',
            width: px(PREVIEW_SIZE),
            height: px(PREVIEW_SIZE),
            opacity: 0,
            child: new St.Icon({gicon: icon('isle-check-symbolic'), icon_size: 18}),
        });
        const remove = iconButton('isle-close-symbolic', 'isle-shelf-remove',
            () => this._daemon.call('shelf', 'Remove', item.uri), {size: 10, accessibleName: 'Remove from the shelf'});
        remove.set_size(px(REMOVE_DISC), px(REMOVE_DISC));

        // Files the Shelf keeps itself (sent from the phone, a clipboard picture): ↓ saves one into Downloads,
        // shown under the pointer, mirroring the ×.
        const save = isShelfCopy(item.uri) ? iconButton('isle-save-symbolic', 'isle-shelf-remove isle-shelf-save',
            () => this.emit('save', item.uri), {size: 10, accessibleName: 'Save to Downloads'}) : null;
        save?.set_size(px(REMOVE_DISC), px(REMOVE_DISC));
        save?.set({opacity: 0, reactive: false});
        const tile = this._tileBox(this._frame(preview, {copied, remove, save}), item.name);
        // What fades as the helper's window comes in (see `handOver`): its picture is the same, drawn over.
        tile._handedOver = [tile._names, remove];
        if (save) {
            tile.connect('notify::hover', () => {
                save.reactive = tile.hover;
                save.remove_transition('opacity');
                save.ease({opacity: tile.hover ? 255 : 0, duration: SAVE_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            });
        }
        tile.accessible_name = item.name;
        tile.connect('clicked', () => this._onClicked(item, copied));

        let destroyed = false;
        tile.connect('destroy', () => (destroyed = true));
        this._thumbnails.get(item.uri).then(shown => {
            if (destroyed || !shown)
                return;
            if (shown.image) {
                preview.add_style_class_name('thumbnail');
                // A document's page shows whole, as in Files, rather than cut to the square.
                if (shown.whole)
                    preview.add_style_class_name('whole');
                preview.style = `background-image: url("${GLib.filename_to_uri(shown.image, null).replace(/"/g, '%22')}");`;
                preview.child = null;
            } else if (shown.gicon) {
                preview.child = new St.Icon({gicon: shown.gicon, icon_size: ICON_SIZE});
            }
        });
        return tile;
    }

    /** The preview (with `copied` over it) and room for the × over its corner. */
    _frame(preview, {copied = null, remove = null, save = null} = {}) {
        const scale = uiScale();
        const frame = new St.Widget({layout_manager: new Clutter.FixedLayout(), width: TILE_WIDTH * scale, height: FRAME_HEIGHT * scale});
        const left = (TILE_WIDTH - PREVIEW_SIZE) / 2;
        for (const square of [preview, copied].filter(Boolean)) {
            frame.add_child(square);
            square.set_position(left * scale, (FRAME_HEIGHT - PREVIEW_SIZE) * scale);
        }
        if (remove) {
            frame.add_child(remove);
            // Its centre a few pixels inside the preview's corner.
            remove.set_position((left + PREVIEW_SIZE - REMOVE_SIZE + 6) * scale, 0);
        }
        if (save) {
            frame.add_child(save);
            // The ×'s place mirrored, over the preview's other corner.
            save.set_position((TILE_WIDTH - (left + PREVIEW_SIZE - REMOVE_SIZE + 6) - REMOVE_DISC) * scale, 0);
        }
        return frame;
    }

    /** The frame over the file's name, as one button. */
    _tileBox(frame, name) {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-shelf-tile-box'});
        box.add_child(frame);
        const text = label(name, 'isle-shelf-name', {width: px(NAME_WIDTH), y_align: Clutter.ActorAlign.FILL});
        // Two lines ("Alex Morgan / CV.pdf" whole); only a longer name loses its middle.
        text.clutter_text.set({line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            line_alignment: Pango.Alignment.CENTER, ellipsize: Pango.EllipsizeMode.MIDDLE});
        // Two lines' room, a shorter name in its middle, as the helper's (crates/isle-shelf).
        // The label is given its lines' height whole: on GNOME 50 and later it measures one, and a long name showed on
        // one line here but two in the helper's window.
        const lines = new St.Widget({style_class: 'isle-shelf-name-lines', layout_manager: new Clutter.BinLayout()});
        lines.add_child(new Lines(text, 2, {x_expand: false, x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(lines);
        const button = new St.Button({
            style_class: 'isle-shelf-tile',
            child: box,
            can_focus: true,
            width: px(TILE_WIDTH),
            y_align: Clutter.ActorAlign.CENTER,
        });
        button._names = lines;
        return button;
    }

    // Clicks

    /** A click copies the file; a second one soon after opens it. */
    _onClicked(item, copied) {
        const now = GLib.get_monotonic_time() / 1000;
        const double = this._lastClick.uri === item.uri &&
            now - this._lastClick.at < Clutter.Settings.get_default().double_click_time;
        this._lastClick = {uri: double ? null : item.uri, at: now};
        if (double) {
            Gio.AppInfo.launch_default_for_uri_async(item.uri, global.create_app_launch_context(0, -1), null, null);
            return;
        }
        this._copy(item);
        copied.remove_all_transitions();
        copied.opacity = 255;
        copied.ease({opacity: 0, delay: COPIED_MS, duration: 200});
    }

    /** Copies the file: a PNG as the image (chats paste it as one), anything else as a file. */
    async _copy(item) {
        const clipboard = St.Clipboard.get_default();
        const file = Gio.File.new_for_uri(item.uri);
        // St takes one type, so only PNGs go as pictures here; the helper converts the rest.
        if ((await this._thumbnails.get(item.uri))?.contentType === 'image/png') {
            try {
                const bytes = await new Promise((resolve, reject) => {
                    file.load_bytes_async(null, (source, result) => {
                        try {
                            resolve(source.load_bytes_finish(result)[0]);
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
                return;
            } catch (e) {
                console.warn(`Isle: could not read ${item.uri}: ${e.message}`);
            }
        }
        clipboard.set_content(St.ClipboardType.CLIPBOARD, FILES_TYPE,
            GLib.Bytes.new(new TextEncoder().encode(`copy\n${item.uri}`)));
    }
});

/** Traces a rounded rectangle `inset` px inside `width` × `height`. */
function roundedRect(cr, width, height, radius, inset) {
    const r = Math.min(radius, width / 2, height / 2) - inset;
    const [left, top, right, bottom] = [inset, inset, width - inset, height - inset];
    cr.newSubPath();
    cr.arc(right - r, top + r, r, -Math.PI / 2, 0);
    cr.arc(right - r, bottom - r, r, 0, Math.PI / 2);
    cr.arc(left + r, bottom - r, r, Math.PI / 2, Math.PI);
    cr.arc(left + r, top + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/** Strokes the traced path in 1 px dashes (times `scale`), as GTK draws a dashed border. */
function strokeDashed(cr, scale) {
    cr.setLineWidth(scale);
    cr.setDash(DASH.map(length => length * scale), 0);
    cr.stroke();
}
