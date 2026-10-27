// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The Shelf page: Clipboard (copy history; Super+V to search, ← → Enter to paste)
// and Files (dropped files to drag or copy into any app).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {iconSize, onUiScale} from '../compat.js';
import {DropLight} from '../dropLight.js';
import {Thumbnails} from '../thumbnails.js';
import {icon, iconButton, label, pillButton, setEnabled} from '../widgets.js';
import {ClipsView} from './clips.js';
import {FilesView, SHELF_CAPACITY} from './files.js';
import {Page} from './page.js';

const TABS = [
    {name: 'clipboard', label: 'Clipboard'},
    {name: 'files', label: 'Files'},
];
const FILTERS = [
    {kind: 'text', icon: 'isle-text', name: 'Text'},
    {kind: 'link', icon: 'isle-link', name: 'Links'},
    {kind: 'image', icon: 'isle-image', name: 'Images'},
    {kind: 'files', icon: 'isle-file', name: 'Files'},
];
/** How long "Clear all" waits for its confirming click. */
const CONFIRM_MS = 3000;
/** Crossfade between tabs. */
const TAB_FADE_MS = 150;
/** How long the hint says a file was added. */
const ADDED_MS = 2200;
/** The flare waits this long for a new file's colour, then lights in the shelf's own. */
const COLOR_WAIT_MS = 400;
/** A dragged file's colour comes from its preview, read within this long or not at all. */
const COLOR_LATE_MS = 1500;

/** The Shelf page; `_clips` and `_files` draw its two tabs. */
export const ShelfPage = GObject.registerClass({
    Signals: {
        // The Files tab came into or out of view; see `helperArea`.
        'helper-area-changed': {},
    },
}, class ShelfPage extends Page {
    /** `history` copies and pastes clipboard items; `settings` holds whether history is kept at all. */
    _init(daemon, history, settings, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-shelf',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        onUiScale(this, scale => (this.layout_manager.spacing = 8 * scale));
        this.name = 'shelf';
        this._history = history;
        this._settings = settings;
        this._tab = 'clipboard';
        this._filter = null;
        /** Items copied while the page is open; moved to the front on leaving. */
        this._copied = [];
        /** Views that changed while the page was closed, redrawn on opening. */
        this._stale = new Set();
        /** A file is being dragged towards the island, and over the drop zone. */
        this._dropping = false;
        this._dropOver = false;
        /** Every URI the drag on its way carries, once the helper has read them. */
        this._hovered = null;
        /** The files on the shelf last time it changed, to tell new ones. */
        this._shelved = null;
        /** A file just landed: the hint says so. */
        this._added = false;
        this._light = new DropLight(this);
        this._light.connect('changed', () => {
            this.emit('tint-changed');
            // The zone's light takes the same colours; kept as it fades out.
            if (this._light.colors)
                this._files.glowColors = this._light.colors;
        });
        this._light.connect('frame', (_light, time, level) => {
            this.emit('tint-motion', time, level);
            this._files.light = level;
        });

        this._clips = new ClipsView(daemon);
        this._clips.connect('activated', (_view, item, paste) => this._onActivated(item, paste));
        this._thumbnails = new Thumbnails();
        this._files = new FilesView(daemon, this._thumbnails);
        // The helper window must match the tab exactly, so it follows every
        // change of size or place (sync only reads them; nothing relayouts).
        this._files.connect('notify::allocation', () => {
            if (this._tab === 'files')
                this.emit('helper-area-changed');
        });

        this.add_child(this._buildBar());
        const content = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'isle-shelf-content', x_expand: true, y_expand: true});
        content.add_child(this._clips);
        content.add_child(this._files);
        this.add_child(content);

        // Copies arrive all day; the cards are only drawn while they can be seen.
        this.watch(['clipboard'], () => this._refresh('clips'));
        this.watch(['shelf'], () => {
            this._noticeNewFiles();
            this._refresh('files');
            // Full or not any more, mid-drag.
            if (this._dropping)
                this._syncRefusal();
        });
        this._settingsChanged = settings.connect('changed::clipboard-history', () => this._refresh('clips'));
        this.connect('destroy', () => {
            this._destroyed = true;
            settings.disconnect(this._settingsChanged);
            this._thumbnails.destroy();
            this._light.destroy();
        });
        this._updateClips();
        this._updateFilesHint();
        this.showTab('clipboard');
    }

    // Building

    /** The tabs, then the controls of the tab shown: filters, search and Clear, or the files hint. */
    _buildBar() {
        const bar = new St.BoxLayout({style_class: 'isle-shelf-bar'});

        const tabs = new St.BoxLayout({style_class: 'isle-segmented'});
        this._tabButtons = new Map();
        for (const {name, label: text} of TABS) {
            const button = new St.Button({style_class: 'isle-segment', label: text, can_focus: true});
            button.connect('clicked', () => this.showTab(name));
            this._tabButtons.set(name, button);
            tabs.add_child(button);
        }
        bar.add_child(tabs);

        // Clipboard: type filters, search (a button that opens into a field)
        // and Clear all.
        this._clipboardControls = new St.BoxLayout({style_class: 'isle-shelf-controls', x_expand: true});
        const filters = new St.BoxLayout({style_class: 'isle-segmented isle-segmented-icons'});
        this._filterButtons = new Map();
        for (const filter of FILTERS) {
            const button = new St.Button({
                style_class: 'isle-segment',
                child: new St.Icon({gicon: icon(filter.icon), icon_size: iconSize(13)}),
                accessible_name: `Only ${filter.name.toLowerCase()}`,
                can_focus: true,
            });
            button.connect('clicked', () => this._setFilter(this._filter === filter.kind ? null : filter.kind));
            this._filterButtons.set(filter.kind, button);
            filters.add_child(button);
        }
        this._clipboardControls.add_child(filters);

        this._search = new St.Entry({style_class: 'isle-entry isle-shelf-field', hint_text: 'Search', can_focus: true, x_expand: true});
        this._search.set_primary_icon(new St.Icon({gicon: icon('isle-search'), icon_size: iconSize(12), style_class: 'isle-shelf-field-icon'}));
        const text = this._search.clutter_text;
        // Ask for the keyboard before the field takes focus: the grab moves focus itself.
        text.connect('button-press-event', () => {
            this.emit('request-keyboard', true);
            return Clutter.EVENT_PROPAGATE;
        });
        text.connect('text-changed', () => {
            if (!this._clearingSearch)
                this._clips.query = this._search.text;
        });
        text.connect('activate', () => this._clips.activateSelected());
        text.connect('key-press-event', (_text, event) => this._onSearchKey(event));
        // The selection outline only means something while typing.
        text.connect('key-focus-in', () => (this._clips.keyboard = true));
        text.connect('key-focus-out', () => {
            this._clips.keyboard = false;
            if (!this._search.text)
                this._closeSearch();
        });
        this._search.hide();
        // Keeps the buttons at the end while the field is closed.
        this._searchSpacer = new St.Widget({x_expand: true});
        this._searchButton = iconButton('isle-search', 'isle-button-round isle-button-small',
            () => this._openSearch(), {size: 13, accessibleName: 'Search the clipboard history'});
        this._clipboardControls.add_child(this._searchSpacer);
        this._clipboardControls.add_child(this._search);
        this._clipboardControls.add_child(this._searchButton);

        this._clear = iconButton('isle-trash', 'isle-button-round isle-button-small', () => this._askToClear(),
            {size: 14, accessibleName: 'Clear the clipboard history'});
        this._confirm = pillButton('Clear all', 'isle-pill-small isle-shelf-confirm', () => this._clearHistory());
        this._confirm.hide();
        this._clipboardControls.add_child(this._clear);
        this._clipboardControls.add_child(this._confirm);
        bar.add_child(this._clipboardControls);

        // Files: what the tab is for.
        this._filesHint = label('', 'isle-shelf-hint', {
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        bar.add_child(this._filesHint);
        return bar;
    }

    // Search

    /** Opens the search field in place of its button, ready to type. */
    _openSearch() {
        this._searchSpacer.hide();
        this._searchButton.hide();
        this._search.show();
        this.emit('request-keyboard', true);
        this._search.grab_key_focus();
    }

    /** Puts the search button back in place of the field. */
    _closeSearch() {
        this._search.hide();
        this._searchSpacer.show();
        this._searchButton.show();
    }

    // Tabs

    /** Switches to tab `name`; with `focusSearch`, the search field takes the keyboard. */
    showTab(name, {focusSearch = false} = {}) {
        const changed = name !== this._tab;
        this._tab = name;
        for (const [tab, button] of this._tabButtons) {
            if (tab === name)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        const shown = name === 'clipboard' ? this._clips : this._files;
        const hidden = shown === this._clips ? this._files : this._clips;
        hidden.hide();
        if (changed && this.mapped) {
            shown.opacity = 0;
            shown.show();
            shown.ease({
                opacity: 255,
                duration: TAB_FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                // Laid out and settled: the helper can measure the tab now.
                onComplete: () => this.emit('helper-area-changed'),
            });
        } else {
            shown.opacity = 255;
            shown.show();
        }
        this._clipboardControls.visible = name === 'clipboard';
        this._filesHint.visible = name === 'files';
        if (name !== 'files') {
            this._light.off();
            this._setAdded(false);
        }
        // Files are dragged with the pointer, which apps (the drag-and-drop
        // helper included) only get while the island lets go of the keyboard.
        if (name === 'files')
            this.emit('request-keyboard', false);
        if (focusSearch) {
            this._search.text = '';
            this._openSearch();
        }
        if (changed)
            this.emit('helper-area-changed');
    }

    /** The Files tab while it is on screen, for the drag-and-drop helper to cover. */
    get helperArea() {
        return this._tab === 'files' ? this._files : null;
    }

    /** Set while the drag-and-drop helper's window covers the Files tab, which then draws nothing. */
    set helperActive(active) {
        this._files.helperActive = active;
    }

    /** Whether the drag-and-drop helper is installed. */
    set helperAvailable(available) {
        this._files.helperAvailable = available;
    }

    /** The shelf light's colours, which wash the island too. */
    get tint() {
        return this._light.colors;
    }

    /** A light that moves, rather than a flat wash. */
    get tintStyle() {
        return 'aura';
    }

    // Updates

    /** Redraws a view now if the page is open, else when it is next warmed up or opens. */
    _refresh(view) {
        if (!this.active) {
            this._stale.add(view);
            // Also while still on screen, fading out as the island closes.
            this.markCold({force: true});
            return;
        }
        if (view === 'clips') {
            this._updateClips();
        } else {
            this._files.update();
            this._updateFilesHint();
        }
    }

    /** A file is on its way to the island: say whether it can land. */
    set dropping(dropping) {
        this._dropping = dropping;
        this._files.dropping = dropping;
        if (!dropping) {
            this._dropOver = this._files.dropOver = false;
            // The next drag brings its own colours; a drop under way keeps its light.
            this._dragged = null;
            this._hovered = null;
            this._light.fileColors = null;
            if (!['landing', 'landed'].includes(this._light.state))
                this._light.off();
        }
        this._files.refused = dropping && Boolean(this._refusal);
        this._updateFilesHint();
    }


    /** The file is right over the drop zone. */
    set dropOver(over) {
        this._dropOver = over && this._dropping;
        this._files.dropOver = this._dropOver;
        this._updateFilesHint();
        if (this._dropping)
            this._light.approach(this._dropOver, Boolean(this._refusal));
    }

    /** The files dragged over the drop zone: the light takes their colours (at most three). */
    async showDragged(uris) {
        // A drag's files stay the same; the empty list as they leave or land says nothing.
        if (this._dropping && uris.length > 0) {
            this._hovered = uris;
            this._syncRefusal();
        }
        uris = uris.filter(uri => uri.startsWith('file://'));
        const token = this._dragged = {};
        // A preview slow to read keeps none from the light: it does without that file's colour.
        const late = new Promise(resolve => {
            this.later('dragged-colors', COLOR_LATE_MS, () => resolve(null));
        });
        const shown = await Promise.all(uris.slice(0, 3).map(uri => Promise.race([this._thumbnails.get(uri), late])));
        if (this._destroyed || token !== this._dragged)
            return;
        this._light.fileColors = shown.filter(Boolean).map(file => file.color);
    }

    /** The drag ended; `onShelf` if it was let go over the drop zone. Returns whether the shelf turned it away. */
    endDrop(onShelf) {
        const refused = onShelf && Boolean(this._refusal);
        if (onShelf && !refused)
            this._light.release();
        this.dropping = false;
        return refused;
    }

    // Why the files on their way can't all land, as the helper refuses them: 'local' (none is on this
    // computer) or 'room' (more than fit; files already on the shelf only move up); else null.
    get _refusal() {
        const shelf = this.daemon.state.shelf ?? [];
        const local = this._hovered?.filter(uri => uri.startsWith('file://'));
        if (local?.length === 0)
            return 'local';
        // Not read yet: as long as there is room for one.
        const fresh = local ? local.filter(uri => !shelf.some(item => item.uri === uri)).length : 1;
        return fresh > 0 && shelf.length + fresh > SHELF_CAPACITY ? 'room' : null;
    }

    /** The light, zone and hint say whether the files on their way can land. */
    _syncRefusal() {
        const refusal = this._refusal;
        this._files.refused = Boolean(refusal);
        this._updateFilesHint();
        this._light.approach(this._dropOver, Boolean(refusal));
    }

    /** Says what the Files tab is for, and when it is full. */
    _updateFilesHint() {
        const count = (this.daemon.state.shelf ?? []).length;
        const full = count >= SHELF_CAPACITY;
        const refusal = this._dropping ? this._refusal : null;
        let text;
        // An empty shelf's drop zone says it all itself.
        if (count === 0 && !this._added)
            text = '';
        else if (refusal === 'local')
            text = 'Only files on this computer';
        else if (refusal && full)
            text = 'Full · remove a file first';
        else if (refusal)
            text = `Only ${SHELF_CAPACITY - count} more fit`;
        else if (this._dropping)
            text = this._dropOver ? 'Release to add it' : 'Drop to keep it on the shelf';
        else if (this._added)
            text = 'Added · click to copy, or drag it into any app';
        else if (full)
            text = 'Full · remove a file to add another';
        else
            text = `${count} of ${SHELF_CAPACITY} · click to copy, or drag into any app`;
        this._filesHint.text = text;
        if (this._dropping || this._added)
            this._filesHint.add_style_class_name('active');
        else
            this._filesHint.remove_style_class_name('active');
    }

    /** Flares the light in the colour of a file that just landed, while Files is shown. */
    async _noticeNewFiles() {
        const items = this.daemon.state.shelf;
        if (!items) {
            // isled went away; what it lists when back is not new.
            this._shelved = null;
            return;
        }
        const uris = items.map(item => item.uri);
        const known = this._shelved;
        this._shelved = uris;
        // Newest first: the first new one is the latest; one dropped again moves to the front.
        const moved = known && uris.length === known.length && uris[0] !== known[0] ? uris[0] : null;
        const landed = known && (uris.find(uri => !known.includes(uri)) ?? moved);
        if (!landed || !this.active || this._tab !== 'files')
            return;
        const shown = await Promise.race([this._thumbnails.get(landed),
            new Promise(resolve => {
                this.later('flare-color', COLOR_WAIT_MS, resolve);
            })]);
        if (this._destroyed || !this.active || this._tab !== 'files')
            return;
        this._light.land(shown?.color);
        this._setAdded(true);
        this.later('added', ADDED_MS, () => this._setAdded(false));
    }

    /** Lights the hint for a moment after a file lands. */
    _setAdded(added) {
        this._added = added;
        this._updateFilesHint();
    }

    /** While the screen is shared or recorded, the clipboard history stays out of sight. */
    set sharing(sharing) {
        if (sharing === Boolean(this._sharing))
            return;
        this._sharing = sharing;
        this._updateClips();
        this.markCold();
    }

    /** Redraws the cards: none while history is off or the screen is shared. */
    _updateClips() {
        const off = !this._settings.get_boolean('clipboard-history');
        this._clips.update({off, hidden: Boolean(this._sharing)});
        const unpinned = (this.daemon.state.clipboard ?? []).some(item => !item.pinned);
        setEnabled(this._clear, unpinned);
    }

    // Clipboard

    /** Shows only one kind of item, or every kind for null; the chosen button stays lit. */
    _setFilter(kind) {
        this._filter = kind;
        for (const [filterKind, button] of this._filterButtons) {
            if (filterKind === kind)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
            // The icons are drawn white; the ones not chosen are dimmed.
            button.child.opacity = !kind || filterKind === kind ? 255 : 130;
        }
        this._clips.kind = kind;
    }

    /** ← → move between cards; Esc empties the search before it can close the island. */
    _onSearchKey(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Left:
            this._clips.moveSelection(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Right:
            this._clips.moveSelection(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Escape:
            // First Esc clears the search; the next one closes the island.
            if (!this._search.text)
                return Clutter.EVENT_PROPAGATE;
            this._search.text = '';
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    /** Copies the item back to the clipboard, and with `paste` types it into the window behind. */
    async _onActivated(item, paste) {
        // The extension may have stopped while the item was fetched.
        if (!await this._history.copy(item, {touch: paste}) || this._destroyed)
            return;
        if (paste) {
            this.emit('request-close');
            this._history.paste();
        } else {
            this._clips.flash(item, 'isle-check-symbolic', 'Copied');
            this._copied = [...this._copied.filter(id => id !== item.id), item.id];
        }
    }

    /** Swaps the trash button for "Clear all" for a few seconds, so one click never wipes it. */
    _askToClear() {
        this._clear.hide();
        this._confirm.show();
        this.later('confirm', CONFIRM_MS, () => this._endConfirm());
    }

    /** Back to the trash button. */
    _endConfirm() {
        this.cancel('confirm');
        this._confirm.hide();
        this._clear.show();
    }

    /** Clears all but the pinned items. */
    _clearHistory() {
        this._endConfirm();
        this.daemon.call('clipboard', 'Clear');
    }

    // Page

    /** Redraws the views that changed while closed. */
    _flushStale() {
        const clips = this._stale.delete('clips');
        if (clips)
            this._updateClips();
        if (this._stale.delete('files')) {
            this._files.update();
            this._updateFilesHint();
        }
        return clips;
    }

    /** Redraws ahead what changed while closed. */
    warmUp() {
        this._flushStale();
    }

    /** Without anything stale, only the "5m ago" ages move on. */
    onActivate() {
        if (!this._flushStale())
            this._clips.refreshAges();
        this.daemon.call('shelf', 'Refresh');
    }

    /** Items copied while open move to the front now, and the search empties for next time. */
    onDeactivate() {
        this._light.off();
        this._added = false;
        this._updateFilesHint();
        // Skipping any removed or cleared since.
        const items = this.daemon.state.clipboard ?? [];
        for (const id of this._copied.filter(copied => items.some(item => item.id === copied)))
            this.daemon.call('clipboard', 'Touch', id);
        this._copied = [];
        // Each visit starts with an empty search; the cards follow out of sight (see `warmUp`).
        if (this._search.text) {
            this._clearingSearch = true;
            this._search.text = '';
            this._clearingSearch = false;
            this._clips.clearQuery();
            this._refresh('clips');
        }
        this._closeSearch();
        this._endConfirm();
    }
});
