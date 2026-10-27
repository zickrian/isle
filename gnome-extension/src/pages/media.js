// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Now playing: cover on the left; title, artist, scrubber and controls beside it.
// With lyrics on, a wider island with synced lyrics on the right. See docs/product-spec.md, section 5.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {vividColorOfFile} from '../colors.js';
import {VERTICAL, iconSize, onUiScale, px} from '../compat.js';
import * as Format from '../format.js';
import * as Playback from '../playback.js';
import {Art, Bars, Slider, fence, icon, iconButton, label, ownIcon, restsAt, setButtonIcon, setEnabled, smallCover, coverKey} from '../widgets.js';
import {LyricsPane} from './lyrics.js';
import {Page} from './page.js';

/** The cover beside the player: as tall as its column. Sizes in CSS pixels (see `px`). */
const ART_SIZE = 104;
/** The island widens to this while lyrics are shown. */
const LYRICS_WIDTH = 720;
/** How often the elapsed time and scrubber move while playing. */
const PROGRESS_REFRESH_MS = 250;
/** The music bars' opacity while the song is paused, as on the closed island. */
const PAUSED_BARS_OPACITY = 110;

/** The music page: the player, with lyrics or volume and outputs as its other modes. */
export const MediaPage = GObject.registerClass(
class MediaPage extends Page {
    /** Builds all three layouts up front; only the mode's is shown. */
    _init(daemon, audio, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-media',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'music';
        this._audio = audio;
        /** 'player', 'lyrics' or 'audio' (volume and outputs). */
        this._mode = 'player';
        this._tint = null;
        this._tintPath = null;
        // Each layout has its own copy of these; they update together.
        this._arts = [];
        this._badges = [];
        this._titles = [];
        this._artists = [];
        this._elapsed = [];
        this._remaining = [];
        this._scrubbers = [];
        this._playButtons = [];
        this._transports = [];

        this._player = this._buildPlayer();
        this._lyricsLayout = this._buildLyricsLayout();
        this._audioLayout = this._buildAudioLayout();
        this._empty = this._buildEmpty();
        for (const child of [this._player, this._lyricsLayout, this._audioLayout, this._empty])
            this.add_child(child);
        fence(this);

        this.watch(['nowPlaying', 'lyrics'], () => this._update());
        // Left out of the island, it follows the songs again once it is back.
        this.connect('availability-changed', () => !this.hidden && this._update());
        this.watch(['players'], () => this._syncPlayers());
        this._audioIds = [
            audio.connect('changed', () => this._updateVolume()),
            audio.connect('outputs-changed', () => this._updateOutputs()),
        ];
        this._update();
        this._updateVolume();
        this._updateOutputs();
        this.connect('destroy', () => this._onDestroy());
    }

    /** A track, playing or paused. */
    get relevant() {
        return Playback.hasTrack(this.daemon.state.nowPlaying);
    }

    /** Wider only with the lyrics open. */
    get preferredWidth() {
        return this._shown('lyrics') ? px(LYRICS_WIDTH) : null;
    }

    /** The cover's colour, behind the lyrics only. */
    get tint() {
        return this._shown('lyrics') ? this._tint : null;
    }

    /** Whether `mode` is on screen (the special modes need a track). */
    _shown(mode) {
        return this._mode === mode && Playback.hasTrack(this.daemon.state.nowPlaying);
    }

    // Building blocks; each layout has its own copy.

    /** Cover art with the playing app's icon on its corner. */
    _art(size, radius) {
        const art = new Art({size, radius});
        art.connect('shown', () => this._syncBadges());
        art.reactive = true;
        art.connect('button-release-event', () => {
            this.daemon.call('media', 'Raise');
            return Clutter.EVENT_STOP;
        });
        this._arts.push(art);

        const badgeIcon = new St.Icon({icon_size: iconSize(Math.min(22, Math.round(size * 0.3)))});
        const badge = new St.Bin({
            style_class: 'isle-app-badge',
            child: badgeIcon,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            visible: false,
        });
        // Sits over the corner, half outside it, like on a Mac.
        onUiScale(badge, scale => badge.set_translation(5 * scale, 5 * scale, 0));
        this._badges.push({badge, icon: badgeIcon});

        // The badge expands to reach the corner; kept from spreading to the box, which would then take a
        // share of the row and pull the art and badge apart.
        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: false,
            y_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(art);
        box.add_child(badge);
        return box;
    }

    /** Title over artist, each cut short with an ellipsis. */
    _texts(titleClass, artistClass) {
        const box = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'isle-player-texts'});
        const title = label('', titleClass);
        const artist = label('', artistClass);
        for (const text of [title, artist]) {
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(text);
        }
        this._titles.push(title);
        this._artists.push(artist);
        return box;
    }

    /** Elapsed time, scrubber and time left; letting go of the scrubber seeks. */
    _progress() {
        const row = new St.BoxLayout({style_class: 'isle-player-progress'});
        const elapsed = label('0:00', 'isle-time');
        const remaining = label('\u22120:00', 'isle-time isle-time-end');
        const scrubber = new Slider();
        scrubber.connect('released', (_slider, fraction) => {
            const length = this.daemon.state.nowPlaying?.length_us ?? 0;
            if (length > 0)
                this.daemon.call('media', 'SetPosition', Math.round(fraction * length));
        });
        row.add_child(elapsed);
        row.add_child(scrubber);
        row.add_child(remaining);
        this._elapsed.push(elapsed);
        this._remaining.push(remaining);
        this._scrubbers.push(scrubber);
        return row;
    }

    /** Previous, play or pause, and next. */
    _transport() {
        const row = new St.BoxLayout({style_class: 'isle-transport', y_align: Clutter.ActorAlign.CENTER});
        const play = iconButton('isle-play-symbolic', 'isle-button-flat isle-play',
            () => this.daemon.call('media', 'PlayPause'), {size: 22, accessibleName: 'Play or pause'});
        const previous = iconButton('isle-backward-symbolic', 'isle-button-flat',
            () => this.daemon.call('media', 'Previous'), {size: 18, accessibleName: 'Previous'});
        const next = iconButton('isle-forward-symbolic', 'isle-button-flat',
            () => this.daemon.call('media', 'Next'), {size: 18, accessibleName: 'Next'});
        for (const button of [previous, play, next])
            row.add_child(button);
        this._playButtons.push(play);
        this._transports.push({previous, play, next});
        return row;
    }

    /** A button switching to `mode` and back; while its mode is shown it is lit and its icon fills in. */
    _modeButton(mode, iconName, accessibleName, on) {
        return iconButton(on ? `${iconName}-fill` : iconName, `isle-button-flat isle-mode-toggle${on ? ' on' : ''}`,
            () => this._toggleMode(mode), {size: 18, accessibleName});
    }

    // Layouts.

    /** The standard view: cover beside title, mode buttons, progress and controls. */
    _buildPlayer() {
        const player = new St.BoxLayout({style_class: 'isle-player', x_expand: true, y_expand: true});
        player.add_child(this._art(ART_SIZE, 16));

        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'isle-player-column'});
        // Title and artist, with lyrics and output as small buttons at the right.
        const head = new St.BoxLayout({style_class: 'isle-player-head'});
        const texts = this._texts('isle-track-title', 'isle-track-subtitle');
        texts.y_align = Clutter.ActorAlign.START;
        head.add_child(texts);
        const modes = new St.BoxLayout({style_class: 'isle-player-modes', y_align: Clutter.ActorAlign.START});
        // With more than one player running: switch to the next, shown by its app's icon.
        this._playerIcon = new St.Icon({icon_size: iconSize(16)});
        this._playerSwitch = new St.Button({style_class: 'isle-button isle-button-flat isle-player-switch', child: this._playerIcon,
            can_focus: true, visible: false});
        this._playerSwitch.connect('clicked', () => {
            if (this._nextPlayer)
                this.daemon.call('media', 'Choose', this._nextPlayer.name);
        });
        modes.add_child(this._playerSwitch);
        modes.add_child(this._modeButton('lyrics', 'isle-lyrics', 'Show lyrics', false));
        modes.add_child(this._modeButton('audio', 'isle-output', 'Volume and output', false));
        // The last icon on the page's right edge, as the header's settings; its padding hangs past it.
        onUiScale(modes, scale => (modes.translation_x = 5 * scale));
        head.add_child(modes);
        column.add_child(head);
        column.add_child(this._progress());
        const transport = this._transport();
        transport.x_align = Clutter.ActorAlign.CENTER;
        column.add_child(transport);
        player.add_child(column);
        return player;
    }

    /** The player in a column beside the lyrics. */
    _buildLyricsLayout() {
        const layout = new St.BoxLayout({style_class: 'isle-lyrics-layout', x_expand: true, y_expand: true, visible: false});

        const side = new St.BoxLayout({...VERTICAL, style_class: 'isle-lyrics-side', y_align: Clutter.ActorAlign.CENTER});
        const top = new St.BoxLayout({style_class: 'isle-player-top'});
        top.add_child(this._art(64, 12));
        const texts = this._texts('isle-side-title', 'isle-side-artist');
        this._lyricsBars = new Bars({height: 11});
        this._lyricsBars.x_align = Clutter.ActorAlign.START;
        this._lyricsBars.add_style_class_name('isle-side-bars');
        texts.add_child(this._lyricsBars);
        top.add_child(texts);
        side.add_child(top);
        side.add_child(this._progress());

        const controls = new St.BoxLayout({style_class: 'isle-lyrics-controls'});
        controls.add_child(this._modeButton('lyrics', 'isle-lyrics', 'Hide lyrics', true));
        const transport = this._transport();
        transport.set({x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        controls.add_child(transport);
        controls.add_child(this._modeButton('audio', 'isle-output', 'Volume and output', false));
        side.add_child(controls);

        this._lyricsPane = new LyricsPane(this);
        layout.add_child(side);
        layout.add_child(this._lyricsPane);
        return layout;
    }

    /** Volume, then the outputs to choose from. */
    _buildAudioLayout() {
        const layout = new St.BoxLayout({...VERTICAL, style_class: 'isle-audio-layout', x_expand: true, y_expand: true, visible: false});

        const volume = new St.BoxLayout({style_class: 'isle-volume-row'});
        this._muteButton = iconButton('audio-volume-high-symbolic', 'isle-button-flat',
            () => this._audio.toggleMuted(), {size: 18, accessibleName: 'Mute'});
        this._volumeSlider = new Slider({scrollStep: 0.05});
        this._volumeSlider.connect('value-changed', (_slider, value) => {
            // Over 100% (boosted in Settings) the slider stays full: its end leaves the boost be.
            if (value >= 1 && this._audio.volume > 1)
                return;
            this._audio.volume = value;
        });
        this._volumeText = label('', 'isle-volume-text');
        volume.add_child(this._muteButton);
        volume.add_child(this._volumeSlider);
        volume.add_child(this._volumeText);
        volume.add_child(this._modeButton('audio', 'isle-output', 'Back to the player', true));
        layout.add_child(volume);

        this._outputList = new St.BoxLayout({...VERTICAL, style_class: 'isle-output-list'});
        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the rows.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        scroll.set_child(this._outputList);
        layout.add_child(scroll);
        return layout;
    }

    /** Shown when no player has a track. */
    _buildEmpty() {
        const box = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'isle-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Icon({gicon: icon('isle-music'), icon_size: iconSize(28), style_class: 'isle-empty-icon'}));
        box.add_child(label('Nothing playing', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(label('Play something in Spotify or on YouTube', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));
        return box;
    }

    /** Opens `mode`, or goes back to the player if it is open already. */
    _toggleMode(mode) {
        this._mode = this._mode === mode ? 'player' : mode;
        this._update();
        this.emit('width-changed');
        this.emit('tint-changed');
    }

    /** Shows the lyrics and the outputs too, out of sight, so opening them costs no frames (see `coolDown`). */
    warmUp() {
        if (!Playback.hasTrack(this.daemon.state.nowPlaying))
            return;
        this._lyricsLayout.show();
        this._audioLayout.show();
    }

    /** Hides again whatever the mode doesn't show. */
    coolDown() {
        this._syncMode();
    }

    /** Shows the layout for the mode; returns whether there is a song. */
    _syncMode() {
        const hasTrack = Playback.hasTrack(this.daemon.state.nowPlaying);
        this._empty.visible = !hasTrack;
        this._player.visible = hasTrack && this._mode === 'player';
        this._lyricsLayout.visible = this._shown('lyrics');
        this._audioLayout.visible = this._shown('audio');
        return hasTrack;
    }

    /** Fills every layout from `nowPlaying`. */
    _update() {
        // Left out in Settings: no covers loaded or tinted for a page that can't be shown.
        if (this.hidden)
            return;
        const {nowPlaying} = this.daemon.state;
        if (!this._syncMode())
            return;
        // A new song changes the layouts not shown too: they are laid out ahead (see `Page.markCold`).
        const track = [nowPlaying.title, nowPlaying.artist, nowPlaying.album, nowPlaying.identity, nowPlaying.art_path].join('\u001f');
        if (track !== this._track) {
            this._track = track;
            this.markCold({force: true});
        }

        const [playerTitle, sideTitle] = this._titles;
        const [playerArtist, sideArtist] = this._artists;
        playerTitle.text = sideTitle.text = nowPlaying.title;
        playerArtist.text = [nowPlaying.artist, nowPlaying.album].filter(Boolean).join(' — ') || nowPlaying.identity;
        sideArtist.text = nowPlaying.artist || nowPlaying.identity;
        for (const art of this._arts)
            art.setPath(nowPlaying.art_path);
        this._updateTint(nowPlaying.art_path);

        const playIcon = nowPlaying.status === 'Playing' ? 'isle-pause-symbolic' : 'isle-play-symbolic';
        for (const button of this._playButtons)
            setButtonIcon(button, playIcon);
        // Dimmed where the player can't (no next song, a stream that can't pause).
        for (const {previous, play, next} of this._transports) {
            setEnabled(previous, nowPlaying.can_go_previous);
            setEnabled(play, nowPlaying.can_play_pause);
            setEnabled(next, nowPlaying.can_go_next);
        }

        this._syncBadges();

        for (const scrubber of this._scrubbers)
            scrubber.reactive = nowPlaying.can_seek && nowPlaying.length_us > 0;
        this._lyricsPane.update();
        this._syncBars();
        this._tickProgress();
    }

    /** The switch to the next running player, after the one shown; hidden with only one. */
    _syncPlayers() {
        const players = this.daemon.state.players ?? [];
        const index = players.findIndex(player => player.active);
        this._nextPlayer = players.length > 1 ? players[(index + 1) % players.length] : null;
        this._playerSwitch.visible = Boolean(this._nextPlayer);
        if (!this._nextPlayer)
            return;
        this._playerIcon.gicon = Playback.playerApp(this._nextPlayer)?.get_icon() ?? icon('isle-music');
        this._playerSwitch.accessible_name = `Switch to ${this._nextPlayer.identity}`;
    }

    /** Which app plays it, unless the cover already is that app's logo. */
    _syncBadges() {
        const nowPlaying = this.daemon.state.nowPlaying;
        const appIcon = nowPlaying ? Playback.playerApp(nowPlaying)?.get_icon() ?? null : null;
        for (const {badge, icon: badgeIcon} of this._badges) {
            badgeIcon.gicon = appIcon;
            badge.visible = Boolean(appIcon) && !this._arts[0].showsIcon;
        }
    }

    /** Mute icon, slider and percentage, from the default output. */
    _updateVolume() {
        const audio = this._audio;
        setButtonIcon(this._muteButton, audio.iconName);
        this._volumeSlider.value = audio.muted ? 0 : audio.volume;
        this._volumeText.text = audio.muted ? 'Muted' : `${Math.round(audio.volume * 100)}%`;
    }

    /** One row per output, the current one checked; a click switches to it. */
    _updateOutputs() {
        const audio = this._audio;
        const outputs = audio.outputs;
        // The mixer reports more than the rows show (its state); they are built again only when theirs differ.
        const key = JSON.stringify(outputs.map(({id, name, detail, active}) => [id, name, detail, active]));
        if (key === this._outputsKey)
            return;
        this._outputsKey = key;
        this._outputList.destroy_all_children();
        for (const output of outputs) {
            const row = new St.BoxLayout({style_class: 'isle-output-row', x_expand: true, x_align: Clutter.ActorAlign.FILL});
            row.add_child(new St.Icon({gicon: output.gicon ? ownIcon(output.gicon) : icon('audio-speakers-symbolic'), fallback_icon_name: 'audio-speakers-symbolic', icon_size: iconSize(18), y_align: Clutter.ActorAlign.CENTER}));
            const texts = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            texts.add_child(label(output.name, 'isle-output-name'));
            if (output.detail)
                texts.add_child(label(output.detail, 'isle-output-detail'));
            row.add_child(texts);
            // The current output is marked with a check.
            const check = new St.Icon({gicon: icon('isle-check-symbolic'), icon_size: iconSize(14), opacity: output.active ? 255 : 0, y_align: Clutter.ActorAlign.CENTER});
            row.add_child(check);

            const button = new St.Button({
                style_class: `isle-output-button${output.active ? ' active' : ''}`,
                child: row,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                can_focus: true,
            });
            button.connect('clicked', () => audio.activate(output.id));
            this._outputList.add_child(button);
        }
        if (!this._outputList.mapped)
            this.markCold({force: true});
    }

    /** Takes the lyrics' tint from the cover at `path`, once per cover. */
    _updateTint(path) {
        // A player may write the next song's cover under the same name: its time tells them apart.
        const key = coverKey(path);
        if (key === this._tintPath)
            return;
        this._tintPath = key;
        // From the small copy the art shows: the cover itself may be big.
        smallCover(path).then(cover => {
            if (key !== this._tintPath || this._destroyed)
                return;
            this._tint = vividColorOfFile(cover ?? path);
            if (this._shown('lyrics'))
                this.emit('tint-changed');
        });
    }

    /** Moves the times and scrubbers, and again shortly while playing on an open page. */
    _tickProgress() {
        const {nowPlaying} = this.daemon.state;
        if (!Playback.hasTrack(nowPlaying))
            return;
        const position = Playback.positionMs(nowPlaying);
        const length = Playback.lengthMs(nowPlaying);
        const elapsed = Format.duration(position);
        // A minus sign, not a hyphen, as a Mac's player shows it.
        const remaining = length > 0 ? `\u2212${Format.duration(length - position)}` : '';
        this._elapsed.forEach(text => (text.text = elapsed));
        this._remaining.forEach(text => (text.text = remaining));
        for (const scrubber of this._scrubbers)
            scrubber.value = length > 0 ? position / length : 0;

        if (this.active && Playback.isPlaying(nowPlaying))
            this.later('progress', PROGRESS_REFRESH_MS, () => this._tickProgress());
    }

    /** The bars by the title dance while the song plays and the page is open. */
    _syncBars() {
        const playing = Playback.isPlaying(this.daemon.state.nowPlaying);
        this._lyricsBars.playing = this.active && playing;
        const opacity = playing ? 255 : PAUSED_BARS_OPACITY;
        if (!restsAt(this._lyricsBars, 'opacity', opacity))
            this._lyricsBars.ease({opacity, duration: 200});
    }

    /** Starts the bars, the clock and the lyrics' scrolling. */
    onActivate() {
        this._syncBars();
        this._tickProgress();
        this._lyricsPane.follow();
    }

    /** Stops the bars and leaves the audio view. */
    onDeactivate() {
        this._lyricsBars.playing = false;
        // Reopening the island starts on the player, not a sub-view.
        if (this._mode === 'audio')
            this._toggleMode('audio');
    }

    /** Stops listening to the audio outputs. */
    _onDestroy() {
        this._audioIds.forEach(id => this._audio.disconnect(id));
    }
});
