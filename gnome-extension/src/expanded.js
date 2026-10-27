// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The open island: a header row inside the top bar (tabs to the pages on the
// left; live activity and the clock on the right) above one page at a time. See docs/product-spec.md, section 5.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {timerColor} from './compact.js';
import {VERTICAL, iconSize, onUiScale, px, uiScale} from './compat.js';
import * as Format from './format.js';
import * as Playback from './playback.js';
import {watchClock} from './wallClock.js';
import {Bars, PrivacyDots, RecordingDot, Ring, fence, icon, iconButton, label, slideBy} from './widgets.js';

/** Sizes and distances in CSS pixels (see `px`). */
const EXPANDED_WIDTH = 600;
/** The least room between the tabs and the status on the right. */
const HEADER_GAP = 16;
export const PAGE_HEIGHT = 150;
/** Room below the page, so its content clears the rounded corners. */
export const BOTTOM_PADDING = 14;

/** Each page's tab: its icon, and the label shown while it is open. */
const TABS = {
    call: {icon: 'isle-phone-symbolic', label: 'Call'},
    music: {icon: 'isle-music', label: 'Music'},
    notifications: {icon: 'isle-bell', label: 'Notifications'},
    focus: {icon: 'isle-timer', label: 'Focus'},
    reminders: {icon: 'isle-tasks', label: 'Reminders'},
    shelf: {icon: 'isle-shelf', label: 'Shelf'},
    calendar: {icon: 'isle-calendar', label: 'Calendar'},
    usage: {icon: 'isle-gauge', label: 'Usage'},
};
/** How bright a tab's icon is: open, under the pointer, otherwise. */
const TAB_OPACITY = {open: 255, hover: 230, idle: 140};
/** The settings icon's, as bright as the sparkle's colour (0.6) beside it. */
const SETTINGS_OPACITY = 153;

/** The music bars' opacity while the song is paused, as on the closed island. */
const PAUSED_BARS_OPACITY = 110;
const SLIDE_DISTANCE = 48;
const SLIDE_DURATION = 260;
/** Touchpad travel (in wheel clicks) that flips a page; one flip a swipe. */
const SWIPE_STEP = 1.5;
/** Wheel travel that flips a page; a long spin flips several. */
const WHEEL_STEP = 1;
/** Minimum time between page flips from a spinning wheel. */
const WHEEL_REPEAT_MS = 200;
/** A pause this long between scroll events starts a new gesture. */
const GESTURE_GAP_MS = 180;

// Header and pager of the open island; the island itself sizes and tints around it.
export const ExpandedView = GObject.registerClass({
    Signals: {
        'page-changed': {},
        // The page slide finished; the new page is in its final place.
        'page-settled': {},
        // The current page wants the island wider or narrower.
        'width-changed': {},
        // The current page's tint colour changed; see `tint`.
        'tint-changed': {},
        // The current page's 'aura' tint moved: time (s), level (0..1).
        'tint-motion': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
        // The mic button: open the voice assistant.
        'voice-requested': {},
        // The gear by the clock: Isle's settings.
        'settings-requested': {},
    },
}, class ExpandedView extends St.BoxLayout {
    /** `privacy` and `call` feed the header's status; `pages` are built by the island, in tab order. */
    _init(daemon, privacy, call, settings, pages) {
        super._init({...VERTICAL, style_class: 'isle-expanded', width: px(EXPANDED_WIDTH)});
        this._daemon = daemon;
        this._privacy = privacy;
        this._call = call;
        this._settings = settings;
        this._pages = pages;
        // Some pages (Call) have no tab until there is something on them.
        this._index = Math.max(0, pages.findIndex(page => page.available));
        this._active = false;
        this._width = px(EXPANDED_WIDTH);
        this._lastFlip = 0;
        /** The scroll gesture in progress: travel so far, and whether it flipped. */
        this._gesture = {dx: 0, dy: 0, flipped: false, at: 0};
        /** Set once smooth scrolling is seen; its click-style copies are then ignored. */
        this._smoothScrolling = false;

        // Sideways scrolls always flip pages, so catch them before lists and lyrics do;
        // vertical scrolls those leave flip pages in `vfunc_scroll_event`.
        this.connect('captured-event', (_actor, event) => this._captureScroll(event));

        this._header = this._buildHeader();
        // The open tab's name is only measured right once on the stage.
        this.connect('notify::mapped', () => {
            if (this.mapped)
                this._syncTabs();
        });
        this.add_child(this._header);
        this.add_child(this._buildPager());
        const bottom = new St.Widget();
        this.add_child(bottom);
        onUiScale(bottom, scale => {
            bottom.height = BOTTOM_PADDING * scale;
            this._pagerArea.height = PAGE_HEIGHT * scale;
        });

        for (const page of pages) {
            page.connect('width-changed', () => {
                if (page === this.page)
                    this._syncWidth();
            });
            page.connect('tint-changed', () => {
                if (page === this.page)
                    this.emit('tint-changed');
            });
            page.connect('tint-motion', (_page, time, level) => {
                if (page === this.page)
                    this.emit('tint-motion', time, level);
            });
            page.connect('news-changed', () => this._syncTabs());
            page.connect('availability-changed', () => this._onAvailabilityChanged(page));
        }

        this._daemonChanged = daemon.connect('changed', (_daemon, key) => {
            if (key === 'nowPlaying' || key === 'pomodoro')
                this._updateHeader();
        });
        this._privacyChanged = privacy.connect('changed', () => this._updateHeader());
        this._callChanged = call.connect('changed', () => this._updateHeader());
        this._syncPage();
        this._syncWidth();
        // Another scale, font or theme: the tab names are measured again, and the width with them.
        onUiScale(this, () => {
            this._nameWidths.clear();
            this._syncTabs();
        }, {now: false});
        this._themeChanged = St.ThemeContext.get_for_stage(global.stage).connect('changed', () => this._nameWidths.clear());
        this.connect('destroy', () => this._onDestroy());
    }

    /** Tabs on the left, status and clock on the right. */
    _buildHeader() {
        const header = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'isle-header'});
        this._tabsBox = this._buildTabs();
        header.add_child(this._tabsBox);

        // Right: a running recording (click to stop), privacy dots, music, the focus ring and the clock.
        // A call has its own green tab on the left.
        const status = this._status = new St.BoxLayout({style_class: 'isle-header-status', x_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        const recordingBox = new St.BoxLayout({style_class: 'isle-recording-pill-box'});
        recordingBox.add_child(new RecordingDot());
        this._recordingTime = label('', 'isle-recording-time');
        recordingBox.add_child(this._recordingTime);
        this._recordingButton = new St.Button({
            style_class: 'isle-recording-pill',
            child: recordingBox,
            accessible_name: 'Stop recording',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._recordingButton.connect('clicked', () => this._privacy.stopRecording());
        this._privacyDots = new PrivacyDots();
        this._headerBars = new Bars({height: 14});
        status.add_child(this._recordingButton);
        status.add_child(this._privacyDots);
        status.add_child(this._headerBars);
        // The assistant, as AI rather than a microphone: it listens, and it can be typed to.
        this._micButton = iconButton('isle-sparkle-symbolic', 'isle-button-flat isle-header-mic',
            () => this.emit('voice-requested'), {size: 15, accessibleName: 'AI assistant'});
        status.add_child(this._micButton);

        const clock = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, style_class: 'isle-header-clock'});
        this._headerRing = new Ring({size: 15, lineWidth: 2.5});
        this._date = label('', 'isle-header-date');
        this._time = label('', 'isle-header-time');
        clock.add_child(this._headerRing);
        clock.add_child(this._date);
        clock.add_child(this._time);
        status.add_child(clock);
        const settings = iconButton('isle-settings', 'isle-button-flat isle-header-settings',
            () => this.emit('settings-requested'), {size: 15, accessibleName: 'Settings'});
        // Its icon is an image, which takes no CSS colour: dimmed as the sparkle beside it, lit under the pointer.
        settings.child.opacity = SETTINGS_OPACITY;
        settings.connect('notify::hover', () => settings.child.ease({opacity: settings.hover ? 255 : SETTINGS_OPACITY, duration: 120}));
        status.add_child(settings);
        header.add_child(status);
        return header;
    }

    /** Whether the voice assistant is on, to show its mic button. */
    set voiceEnabled(enabled) {
        this._micButton.visible = enabled;
    }

    /** A tab per page; the open one is lit and says its name. */
    _buildTabs() {
        const tabs = new St.BoxLayout({style_class: 'isle-tabs', x_expand: true, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
        /** The open name's width per tab, measured once (see `_syncTabs`). */
        this._nameWidths = new Map();
        this._tabs = this._pages.map((page, index) => {
            const {icon: iconName, label: text} = TABS[page.name];
            const glyph = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
            const tabIcon = new St.Icon({gicon: icon(iconName), icon_size: iconSize(15)});
            glyph.add_child(tabIcon);
            // Something new waits on this page (unseen notifications).
            const badge = new St.Widget({
                style_class: 'isle-tab-badge',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                visible: false,
            });
            glyph.add_child(badge);
            const name = label(text, 'isle-tab-label', {y_align: Clutter.ActorAlign.CENTER});
            // The name opens and closes by width, so the tabs beside it slide over instead of jumping.
            const nameClip = new St.Widget({layout_manager: new Clutter.BinLayout(), clip_to_allocation: true, width: 0, y_align: Clutter.ActorAlign.CENTER});
            nameClip.add_child(name);
            const box = new St.BoxLayout({style_class: 'isle-tab-box'});
            box.add_child(glyph);
            box.add_child(nameClip);
            const tab = new St.Button({
                style_class: `isle-tab isle-tab-${page.name}`,
                child: box,
                can_focus: true,
                track_hover: true,
                accessible_name: text,
                y_align: Clutter.ActorAlign.CENTER,
            });
            tab.connect('clicked', () => this.showPage(index));
            // Hovering fades its icon only: nothing else of the tabs changes.
            tab.connect('notify::hover', () => this._syncTabIcon(this._tabs[index]));
            tabs.add_child(tab);
            return {tab, icon: tabIcon, name, nameClip, badge};
        });
        return tabs;
    }

    /** The tab's icon as bright as its state (open, hovered or idle), fading with its background. */
    _syncTabIcon(entry) {
        if (!entry)
            return;
        const {tab, icon: tabIcon} = entry;
        // 150 ms, as the tab's background in the stylesheet.
        const open = this._tabs[this._index] === entry;
        const opacity = TAB_OPACITY[open ? 'open' : tab.hover ? 'hover' : 'idle'];
        if (tabIcon.opacity !== opacity)
            tabIcon.ease({opacity, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    /** Lights the open page's tab and shows which pages have news. */
    _syncTabs() {
        const animate = this.mapped && St.Settings.get().enable_animations;
        this._tabs.forEach(({tab, name, nameClip, badge}, index) => {
            const open = index === this._index;
            if (open)
                tab.add_style_pseudo_class('checked');
            else
                tab.remove_style_pseudo_class('checked');
            // Measured once on the stage (styled), then kept: measuring right after the restyle above would
            // style and lay the name out in this frame. Until then the open name keeps its width.
            let width = 0;
            if (open) {
                if (!this._nameWidths.has(index) && this.get_stage())
                    this._nameWidths.set(index, name.get_preferred_width(-1)[1]);
                width = this._nameWidths.get(index) ?? nameClip.width;
            }
            if (nameClip.width !== width || nameClip.get_transition('width')) {
                nameClip.remove_all_transitions();
                name.remove_all_transitions();
                if (animate) {
                    nameClip.ease({width, duration: SLIDE_DURATION, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
                    name.ease({opacity: open ? 255 : 0, duration: SLIDE_DURATION, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                } else {
                    nameClip.width = width;
                    name.opacity = open ? 255 : 0;
                }
            }
            tab.visible = this._pages[index].available;
            this._syncTabIcon(this._tabs[index]);
            badge.visible = !open && Boolean(this._pages[index].hasNews);
        });
        // The open tab's name may need more room.
        this._syncWidth();
    }

    /** Every page stacked in one clipped area, only the open one shown. */
    _buildPager() {
        const area = this._pagerArea = new St.Widget({layout_manager: new Clutter.BinLayout()});

        this._pager = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
        });
        for (const page of this._pages) {
            page.x_expand = page.y_expand = true;
            page.hide();
            this._pager.add_child(page);
        }
        fence(this._pager);
        this.page.show();
        area.add_child(this._pager);
        return area;
    }

    /** The header sits in the top bar, so it is exactly as tall. */
    set topInset(height) {
        this._header.height = height;
    }

    /** The open page. */
    get page() {
        return this._pages[this._index];
    }

    /** The width the island should have: the current page's, and never less than the header needs. */
    get preferredWidth() {
        return Math.max(this.page.preferredWidth ?? px(EXPANDED_WIDTH), this._headerWidth());
    }

    // The tabs and the status side by side with room between, so they never overlap,
    // whatever is showing (a call, a recording, a long date).
    _headerWidth() {
        if (!this._header?.get_stage())
            return 0;
        // As wide as with the longest tab name open, so switching tabs never resizes the island. Names
        // are measured in the open one's font: the others, never shown yet, may not be styled.
        const longest = this._longestName();
        // The tabs without their names, whose widths ease while switching, then room for the longest name.
        const shown = this._tabs.reduce((sum, {nameClip}) => sum + nameClip.width, 0);
        const [, tabs] = this._tabsBox.get_preferred_width(-1);
        const [, status] = this._status.get_preferred_width(-1);
        return Math.ceil(tabs - shown + longest + status +
            this._header.get_theme_node().get_horizontal_padding() + px(HEADER_GAP));
    }

    /** The widest tab name with its gap from the icon, measured once per font: names never change. */
    _longestName() {
        const openName = this._tabs[this._index]?.name;
        if (!openName)
            return 0;
        // The scale too: the same font is wider at 2x.
        const font = `${openName.get_theme_node().get_font().to_string()} ${uiScale()}`;
        if (this._names?.font !== font) {
            // The open name's own margin (its gap from the icon), the same for every name.
            const gap = openName.get_preferred_width(-1)[1] - openName.clutter_text.get_preferred_width(-1)[1];
            const widest = Math.max(...this._tabs.map(({name}) =>
                openName.clutter_text.create_pango_layout(name.text).get_pixel_size()[0]));
            this._names = {font, width: gap + widest};
        }
        return this._names.width;
    }

    /** RGB colour to wash the island with, or null. */
    get tint() {
        return this.page.tint ?? null;
    }

    /** How `tint` colours the island; see `Island.setTint`. */
    get tintStyle() {
        return this.page.tintStyle;
    }

    /** The pages, in order. */
    get pages() {
        return this._pages;
    }

    /** While the view is out of sight (see `Island.warmView`), shows `page` for a frame so it is styled
     * and laid out ahead; with `shown` false, hides it again. */
    warmPage(page, shown) {
        if (!shown) {
            page.coolDown();
            if (page !== this.page)
                page.hide();
            return;
        }
        if (!this.mapped)
            return;
        page.show();
        page.warmUp();
        page.cold = false;
    }

    /** Puts away the pages `warmPage` shows. */
    hideWarmPages() {
        for (const page of this._pages)
            this.warmPage(page, false);
    }

    /** Styles each tab open and hovered once, out of sight, for its first time to cost no frame. */
    warmTabs() {
        if (this._tabsWarmed || !this.mapped)
            return;
        this._tabsWarmed = true;
        for (const {tab} of this._tabs) {
            for (const pseudo of ['checked', 'hover']) {
                if (tab.has_style_pseudo_class(pseudo))
                    continue;
                tab.add_style_pseudo_class(pseudo);
                tab.remove_style_pseudo_class(pseudo);
            }
        }
    }

    /** Null if Isle has no such page. */
    pageNamed(name) {
        return this._pages.find(page => page.name === name) ?? null;
    }

    /** Shows the page at `index` (or with `name`), sliding in from its side. */
    showPage(target, {animate = true} = {}) {
        const index = typeof target === 'string'
            ? this._pages.findIndex(page => page.name === target)
            : target;
        if (index < 0 || index >= this._pages.length || index === this._index || !this._pages[index].available)
            return;

        const previous = this.page;
        const direction = index > this._index ? 1 : -1;
        this._index = index;
        const next = this.page;

        previous.setActive(false);
        previous.remove_all_transitions();
        next.remove_all_transitions();
        next.show();

        if (animate && St.Settings.get().enable_animations) {
            const distance = px(SLIDE_DISTANCE);
            // Whole pixels (see `slideBy`), the fades eased as before.
            slideBy(previous, 'x', previous.translation_x, -direction * distance, {duration: SLIDE_DURATION});
            previous.ease({
                opacity: 0,
                duration: SLIDE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: () => {
                    if (previous !== this.page)
                        previous.hide();
                    slideBy(previous, 'x', 0, 0);
                    previous.opacity = 255;
                },
            });
            next.opacity = 0;
            slideBy(next, 'x', direction * distance, 0, {duration: SLIDE_DURATION});
            next.ease({
                opacity: 255,
                duration: SLIDE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => this.emit('page-settled'),
            });
        } else {
            previous.hide();
            slideBy(previous, 'x', 0, 0);
            slideBy(next, 'x', 0, 0);
            next.opacity = 255;
        }

        next.setActive(this._active);
        this._syncPage();
        this._syncWidth();
        this.emit('tint-changed');
        this.emit('page-changed');
    }

    /** Starts or stops everything that ticks while the island is open. */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        this.page.setActive(active);
        if (active) {
            this._updateHeader();
            this._tickClock();
        } else {
            // Closing: only what moves stops. The header is laid out again as it next opens.
            this._headerBars.playing = false;
            this._stopClock();
            this._stopRecordingTick();
        }
    }

    /** Tabs and header after the open page changed. */
    _syncPage() {
        this._syncTabs();
        this._updateHeader();
    }

    /** A page lost its tab: leave it for the next page that has one. */
    _onAvailabilityChanged(page) {
        this._syncTabs();
        // The Music page left out takes the song's bars from the header too.
        this._updateHeader();
        if (page !== this.page || page.available)
            return;
        const index = this._nearestAvailable(this._index, 1) ?? this._nearestAvailable(this._index, -1);
        if (index === null)
            return;
        this._automatic = true;
        this.showPage(index, {animate: this._active});
        this._automatic = false;
    }

    /** Whether the page just shown was picked by the user, not left for another on its own. */
    get pickedByHand() {
        return !this._automatic;
    }

    /** The first page from `index` on in `direction` (±1) that has a tab, or null. */
    _nearestAvailable(index, direction) {
        for (let i = index + direction; i >= 0 && i < this._pages.length; i += direction) {
            if (this._pages[i].available)
                return i;
        }
        return null;
    }

    /** Tells the island when the width it should have changed. */
    _syncWidth() {
        // Compare with the width we set, not `this.width`: reading that makes
        // St style the actor, which fails before it is on the stage.
        const width = this.preferredWidth;
        if (width === this._width)
            return;
        this._width = width;
        this.width = width;
        this.emit('width-changed');
    }

    /** Focus ring, music bars, privacy dots and the recording pill. */
    _updateHeader() {
        const {nowPlaying, pomodoro} = this._daemon.state;
        const timerActive = pomodoro && pomodoro.phase !== 'idle';
        this._headerRing.visible = Boolean(timerActive);
        if (timerActive) {
            const remaining = pomodoro.running ? Math.max(0, pomodoro.ends_at_ms - Format.nowMs()) : pomodoro.remaining_ms;
            this._headerRing.color = timerColor(pomodoro.phase);
            this._headerRing.progress = 1 - remaining / pomodoro.duration_ms;
        }
        const playing = Playback.isPlaying(nowPlaying);
        // There for as long as there is a song, dimmed while paused as on the closed island: play and
        // pause never change the header's width.
        this._headerBars.visible = Playback.hasTrack(nowPlaying) && !this.pageNamed('music')?.hidden;
        this._headerBars.opacity = playing ? 255 : PAUSED_BARS_OPACITY;
        this._headerBars.playing = this._active && playing;

        const privacy = this._settings.get_boolean('privacy-indicators') ? this._privacy : {};
        // On a call the microphone is a given (the green Call tab says so), unless another app records too.
        const microphone = privacy.microphone && (!this._call.active || this._call.othersRecording);
        this._privacyDots.update({camera: privacy.camera, microphone, screenShare: privacy.screenShare});
        this._recordingButton.visible = this._privacy.recording;
        if (this._privacy.recording && this._active)
            this._tickRecording();
        else
            this._stopRecordingTick();
        this._syncWidth();
    }

    /** The recording's length, updated just after each whole second. */
    _tickRecording() {
        const elapsedMs = (GLib.get_monotonic_time() - this._privacy.recordingSince) / 1000;
        this._recordingTime.text = Format.duration(elapsedMs);
        this._stopRecordingTick();
        this._recordingTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000 - (elapsedMs % 1000) + 10, () => {
            this._recordingTimeout = 0;
            this._tickRecording();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** No timer left behind once closed or the recording stops. */
    _stopRecordingTick() {
        if (this._recordingTimeout) {
            GLib.source_remove(this._recordingTimeout);
            this._recordingTimeout = 0;
        }
    }

    /** The header's date and time, kept current by GNOME's clock while the island is open. */
    _tickClock() {
        const now = GLib.DateTime.new_now_local();
        this._date.text = Format.longDate(now);
        this._time.text = Format.clockTime(now);
        this._updateHeader();
        this._unwatchClock ??= watchClock(() => this._tickClock());
    }

    /** Off GNOME's clock while the island is closed. */
    _stopClock() {
        this._unwatchClock?.();
        this._unwatchClock = null;
    }

    /** Sideways scrolls flip pages before any child sees them; vertical ones pass on. */
    _captureScroll(event) {
        if (event.type() !== Clutter.EventType.SCROLL)
            return Clutter.EVENT_PROPAGATE;
        // Smooth scrolls also come as click-style copies (UP, LEFT, ...),
        // not always marked as emulated; counting both flipped two pages.
        const smooth = event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH;
        this._smoothScrolling ||= smooth;
        if (this._isCopy(event))
            return this._overList(event) ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP;
        this._trackGesture(event);
        return this._isSideways(event) ? this._flipFromScroll(event) : Clutter.EVENT_PROPAGATE;
    }

    /** What reaches here bubbled up unused by the page. */
    vfunc_scroll_event(event) {
        // A click-style copy let through for a list flips nothing.
        if (this._isCopy(event))
            return Clutter.EVENT_STOP;
        // An up/down scroll no page part wanted.
        return this._flipFromScroll(event);
    }

    /** Whether `event` is the click-style copy of a smooth scroll. */
    _isCopy(event) {
        return event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH &&
            (this._smoothScrolling || Boolean(event.get_flags() & Clutter.EventFlags.POINTER_EMULATED));
    }

    // Whether a wheel click is over a vertical list. St.ScrollView steps only on
    // the click and ignores its smooth copy, so the click must reach it.
    _overList(event) {
        const direction = event.get_scroll_direction();
        if (direction !== Clutter.ScrollDirection.UP && direction !== Clutter.ScrollDirection.DOWN)
            return false;
        if (event.get_scroll_source() === Clutter.ScrollSource.FINGER)
            return false;
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...event.get_coords());
        for (; actor && actor !== this; actor = actor.get_parent()) {
            if (actor instanceof St.ScrollView)
                return actor.vscrollbar_policy !== St.PolicyType.NEVER;
        }
        return false;
    }

    /** Adds `event` to the gesture in progress, or starts a new one. */
    _trackGesture(event) {
        const now = GLib.get_monotonic_time() / 1000;
        const gesture = this._gesture;
        if (now - gesture.at > GESTURE_GAP_MS)
            Object.assign(gesture, {dx: 0, dy: 0, flipped: false});
        gesture.at = now;
        let stopped = event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE;
        if (event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            gesture.dx += dx;
            gesture.dy += dy;
            // A touchpad ends each swipe with an event that does not move.
            stopped ||= dx === 0 && dy === 0;
        }
        // Fingers lifted: the next touch is a new swipe however soon it comes.
        if (stopped)
            gesture.at = 0;
    }

    /** Whether `event` belongs to a sideways scroll. */
    _isSideways(event) {
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.LEFT:
        case Clutter.ScrollDirection.RIGHT:
            return true;
        case Clutter.ScrollDirection.SMOOTH:
            // The whole gesture decides, so a wobble does not switch axis.
            return Math.abs(this._gesture.dx) > Math.abs(this._gesture.dy);
        default:
            return false;
        }
    }

    /** Flips the page if the scroll so far calls for it. */
    _flipFromScroll(event) {
        const gesture = this._gesture;
        const now = GLib.get_monotonic_time() / 1000;
        let step = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            step = 1;
            break;
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            step = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const travel = this._isSideways(event) ? gesture.dx : gesture.dy;
            const wheel = event.get_scroll_source() === Clutter.ScrollSource.WHEEL;
            if (gesture.flipped || Math.abs(travel) < (wheel ? WHEEL_STEP : SWIPE_STEP))
                return Clutter.EVENT_STOP;
            step = Math.sign(travel);
            if (wheel) {
                // Count afresh, so a long spin flips again.
                gesture.dx = gesture.dy = 0;
            } else {
                // One page a swipe, however far it goes.
                gesture.flipped = true;
            }
            break;
        }
        }
        if (!step)
            return Clutter.EVENT_STOP;
        // Clicks and spins are spaced out; a swipe flips once anyway.
        if (!gesture.flipped && now - this._lastFlip < WHEEL_REPEAT_MS)
            return Clutter.EVENT_STOP;
        this._lastFlip = now;
        // Pages without a tab are skipped.
        const index = this._nearestAvailable(this._index, step);
        if (index !== null)
            this.showPage(index);
        return Clutter.EVENT_STOP;
    }

    /** Lets go of the timers and the signals of objects that outlive the view. */
    _onDestroy() {
        St.ThemeContext.get_for_stage(global.stage).disconnect(this._themeChanged);
        this._stopClock();
        this._stopRecordingTick();
        this._daemon.disconnect(this._daemonChanged);
        this._privacy.disconnect(this._privacyChanged);
        this._call.disconnect(this._callChanged);
    }
});
