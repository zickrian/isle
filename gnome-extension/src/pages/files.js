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

import {VERTICAL, iconSize, onUiScale, px, uiScale} from '../compat.js';
import {icon, iconButton, label} from '../widgets.js';

/** The shelf holds this many files (as isled enforces). */
export const SHELF_CAPACITY = 6;

// Sizes in CSS pixels (see `px`); keep them in step with the helper's tile.rs, which GTK scales likewise.
const TILE_WIDTH = 84;
const PREVIEW_SIZE = 52;
const ICON_SIZE = 46;
const REMOVE_SIZE = 18;
const NAME_WIDTH = 76;
/** The preview's square plus room above it for the ×. */
const FRAME_HEIGHT = PREVIEW_SIZE + 6;
/** How long "copied" shows on a tile. */
const COPIED_MS = 1100;
/** The dashed outlines, as the helper's style.css draws them (St borders cannot dash). */
const ZONE_RADIUS = 16;
const DASH = [4, 3];
/** The drop zone's outline and fill (white alphas): at rest, a file on its way, a file over it. */
const ZONE = {idle: [0.22, 0.025], near: [0.35, 0.035], over: [0.65, 0.06]};
/** The light rising inside it from the bottom, until the drop light gives its colours: blue into violet. */
const ZONE_GLOW = [[0.43, 0.48, 1], [0.54, 0.36, 1]];
const ZONE_GLOW_ALPHA = [0.45, 0.12];
const FILES_TYPE = 'x-special/gnome-copied-files';

/** The tiles and drop zone St draws itself, seen whenever the helper window isn't over them. */
export const FilesView = GObject.registerClass(
class FilesView extends St.Widget {
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
        this._helperActive = false;
        this._helperAvailable = false;
        this._dropping = false;
        this._dropOver = false;
        /** The files on their way can't all land (see ShelfPage's `_refusal`). */
        this._refused = false;
        /** How lit the zone is (0..1), with the island's drop light, and in which colours. */
        this._light = 0;
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
        this._empty.add_child(new St.Icon({gicon: icon('isle-shelf'), icon_size: iconSize(24), style_class: 'isle-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        this._emptyTitle = label('', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER});
        this._emptyHint = label('', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER});
        this._empty.add_child(this._emptyTitle);
        this._empty.add_child(this._emptyHint);
        this.add_child(this._empty);
        // Behind the tiles, so its fill never tints them.
        this._zone = new St.DrawingArea({x_expand: true, y_expand: true, visible: false});
        this._zone.connect('repaint', area => this._paintZone(area));
        this.insert_child_at_index(this._zone, 0);
        this.connect('destroy', () => (this._destroyed = true));
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
        if (active === this._helperActive)
            return;
        this._helperActive = active;
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

    /** The files on their way can't all land: the zone stays unlit, its outline red. */
    set refused(refused) {
        if (refused === this._refused)
            return;
        this._refused = refused;
        this._zone.queue_repaint();
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

    /** The zone's fill, its rising light and, unless the helper draws them, its dashes. */
    _paintZone(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const full = this._refused;
        const dragging = this._dropping && this._helperAvailable;
        const [from, to] = [ZONE[dragging ? 'near' : 'idle'], ZONE.over];
        const t = full ? 0 : Math.min(1, this._light);
        const [line, fill] = from.map((value, i) => value + (to[i] - value) * t);
        const scale = uiScale();
        roundedRect(cr, width, height, ZONE_RADIUS * scale, 0.5 * scale);
        cr.setSourceRGBA(1, 1, 1, fill);
        cr.fillPreserve();
        if (t > 0) {
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
        if (!this._helperActive) {
            if (full && dragging)
                cr.setSourceRGBA(1, 0.36, 0.36, 0.6);
            else
                cr.setSourceRGBA(1, 1, 1, line);
            strokeDashed(cr, scale);
        }
        cr.$dispose();
    }

    /** Redraws from isled's shelf list. */
    update() {
        const items = this._daemon.state.shelf ?? [];
        // Not while isled is away (no list), or every preview would go.
        if (this._daemon.state.shelf)
            this._thumbnails.keepOnly(items.map(item => item.uri));
        this._syncTiles(items);
        this._syncZone();
        this._tiles.visible = items.length > 0;
        this._empty.visible = items.length === 0;
        // Under the helper's window they stay laid out but unseen: hidden, the tab would shrink to nothing,
        // the window (placed by it) would go, they would show again, and round it would go, blinking.
        for (const actor of [this._tiles, this._empty])
            actor.opacity = this._helperActive ? 0 : 255;
        this._updateEmptyText();
    }

    /** At rest it marks an empty shelf. Under the helper only its fill and light show: the helper,
     * which can't know the files' colours, draws the dashes. */
    _syncZone() {
        const dragging = this._dropping && this._helperAvailable;
        this._zone.visible = dragging || (this._daemon.state.shelf ?? []).length === 0;
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
        let title = 'Drop files here', hint = 'Then drag them into any app, or click to copy';
        if (!this._helperAvailable)
            [title, hint] = ['No files on the shelf', 'Drag and drop needs the shelf helper; run install.sh again'];
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
        preview.child = new St.Icon({gicon: icon('isle-file'), icon_size: iconSize(Math.round(ICON_SIZE * 0.6)), opacity: 160});

        const copied = new St.Bin({
            style_class: 'isle-shelf-copied',
            width: px(PREVIEW_SIZE),
            height: px(PREVIEW_SIZE),
            opacity: 0,
            child: new St.Icon({gicon: icon('isle-check-symbolic'), icon_size: iconSize(18)}),
        });
        const remove = iconButton('isle-close-symbolic', 'isle-shelf-remove',
            () => this._daemon.call('shelf', 'Remove', item.uri), {size: 10, accessibleName: 'Remove from the shelf'});
        remove.set_size(px(REMOVE_SIZE), px(REMOVE_SIZE));

        const tile = this._tileBox(this._frame(preview, {copied, remove}), item.name);
        tile.accessible_name = item.name;
        tile.connect('clicked', () => this._onClicked(item, copied));

        let destroyed = false;
        tile.connect('destroy', () => (destroyed = true));
        this._thumbnails.get(item.uri).then(shown => {
            if (destroyed || !shown)
                return;
            if (shown.image) {
                preview.add_style_class_name('thumbnail');
                preview.style = `background-image: url("${GLib.filename_to_uri(shown.image, null).replace(/"/g, '%22')}");`;
                preview.child = null;
            } else if (shown.gicon) {
                preview.child = new St.Icon({gicon: shown.gicon, icon_size: iconSize(ICON_SIZE)});
            }
        });
        return tile;
    }

    /** The preview (with `copied` over it) and room for the × over its corner. */
    _frame(preview, {copied = null, remove = null} = {}) {
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
        return frame;
    }

    /** The frame over the file's name, as one button. */
    _tileBox(frame, name) {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-shelf-tile-box'});
        box.add_child(frame);
        const text = label(name, 'isle-shelf-name', {width: px(NAME_WIDTH), x_align: Clutter.ActorAlign.CENTER});
        // Two lines ("Alex Morgan / CV.pdf" whole); only a longer name loses its middle.
        text.clutter_text.set({line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            line_alignment: Pango.Alignment.CENTER, ellipsize: Pango.EllipsizeMode.MIDDLE});
        box.add_child(text);
        return new St.Button({
            style_class: 'isle-shelf-tile',
            child: box,
            can_focus: true,
            width: px(TILE_WIDTH),
            y_align: Clutter.ActorAlign.CENTER,
        });
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
