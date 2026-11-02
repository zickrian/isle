// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Mic, camera (from isled), screen sharing and recording; all event driven.
// Mic streams that only meter input (sound settings) are ignored, as GNOME does, and so are those that record
// a speaker's sound rather than a microphone (an app's equaliser or visualizer).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {sinkCaptures, streamOwner} from './callServices.js';
import {isWayland} from './compat.js';

/** Apps that open the microphone only to show its level. */
export const LEVEL_METERS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

/** Signals: `changed` (any state), `recording-started` (GNOME's screen recorder), `streams-changed` (what each
 * recording records and who holds it: see `isSpeakerCapture`, `ownerOf`). */
export class PrivacyMonitor extends Signals.EventEmitter {
    /** Starts from what is in use now and follows each source's own signals. */
    constructor(daemon) {
        super();
        this._daemon = daemon;
        /** Screen-sharing handles and their `stopped` handler ids. */
        this._shares = new Map();
        this.microphone = false;
        this.camera = false;
        this.screenShare = false;
        this.recording = false;
        /** GLib monotonic time (µs) when the current recording started. */
        this.recordingSince = 0;

        this._mixer = getMixerControl();
        /** The recordings that record a speaker (by index), and the recordings they were found among. */
        this._sinkCaptures = new Set();
        /** Who holds each recording, by index (see `ownerOf`). */
        this._owners = new Map();
        this._noPactl = false;
        this._outputs = '';
        this._cancellable = new Gio.Cancellable();
        this._mixerIds = ['stream-added', 'stream-removed'].map(signal =>
            this._mixer.connect(signal, () => this._syncMicrophone()));

        this._daemonId = daemon.connect('changed', (_daemon, key) => {
            if (key === 'system')
                this._syncCamera();
        });

        this._screenshotUI = Main.screenshotUI;
        this._recordingId = this._screenshotUI.connect('notify::screencast-in-progress',
            () => this._syncRecording());

        // Screen sharing is only reliably known on Wayland, where Mutter
        // does the sharing itself; GNOME makes the same choice.
        this._remote = isWayland() ? global.backend.get_remote_access_controller() : null;
        this._remoteId = this._remote?.connect('new-handle', (_controller, handle) => this._onHandle(handle));
        this._seedShares();

        this._syncMicrophone();
        this._syncCamera();
        this._syncRecording();
    }

    /** Whether anything at all is in use, for showing indicators. */
    get any() {
        return this.microphone || this.camera || this.screenShare;
    }

    /** Stops GNOME's screen recording, from the island's stop button. */
    stopRecording() {
        this._screenshotUI.stopScreencast();
    }

    /** Any app recording a microphone, level meters aside; a new recording only once the sound server has said
     * what it records, so an equaliser never lights the dot for a moment. */
    _syncMicrophone() {
        this._lookAtOutputs();
        const inUse = this._mixer.get_source_outputs().some(stream => !LEVEL_METERS.includes(stream.get_application_id()) &&
            !this.isSpeakerCapture(stream) && this.ownerOf(stream.get_index()) !== undefined);
        this._set('microphone', inUse);
    }

    /** Whether recording `stream` records a speaker's sound, not a microphone: no call, no microphone in use. */
    isSpeakerCapture(stream) {
        return this._sinkCaptures.has(stream.get_index());
    }

    /** The process holding recording `index` ({pid, binary}), as the sound server last said; null when it can't
     * say (no pactl), undefined while it is still asked. */
    ownerOf(index) {
        if (this._noPactl)
            return null;
        return this._owners.has(index) ? this._owners.get(index) : undefined;
    }

    /** Asks the sound server what each recording records and who holds it, only when the recordings change (a
     * song or a sound playing changes none); the answer comes as `streams-changed`. */
    _lookAtOutputs() {
        const indices = this._mixer.get_source_outputs().map(stream => stream.get_index());
        const outputs = [...indices].sort().join();
        if (outputs === this._outputs)
            return;
        this._outputs = outputs;
        if (!outputs) {
            this._sinkCaptures.clear();
            this._owners.clear();
            return;
        }
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE});
            launcher.setenv('LC_ALL', 'C', true);
            const process = launcher.spawnv(['pactl', 'list', 'source-outputs']);
            process.communicate_utf8_async(null, this._cancellable, (_process, result) => {
                let text;
                try {
                    [, text] = process.communicate_utf8_finish(result);
                } catch {
                    if (this._cancellable.is_cancelled())
                        return;
                    text = '';
                }
                // Changed again meanwhile: the newer answer counts.
                if (this._outputs !== outputs)
                    return;
                this._sinkCaptures = sinkCaptures(text);
                this._owners = new Map(indices.map(index => [index, streamOwner(text, index)]));
                this._syncMicrophone();
                this.emit('streams-changed');
            });
        } catch {
            // No pactl: every recording counts, as before.
            this._noPactl = true;
        }
    }

    /** The camera as isled sees it. */
    _syncCamera() {
        this._set('camera', Boolean(this._daemon.state.system?.camera_in_use));
    }

    /** Notes when a screen recording starts or stops, and when it began. */
    _syncRecording() {
        const recording = this._screenshotUI.screencast_in_progress;
        if (recording === this.recording)
            return;
        this.recording = recording;
        this.recordingSince = recording ? GLib.get_monotonic_time() : 0;
        this.emit('changed');
        if (recording)
            this.emit('recording-started');
    }

    // A share started before Isle (turned on again after unlocking, or updated mid-call) came as no
    // `new-handle`: GNOME's sharing indicator knows it (private: its `_handles`, else its being shown).
    _seedShares() {
        const indicator = Main.panel.statusArea.screenSharing;
        if (!this._remote || !indicator)
            return;
        if (indicator._handles instanceof Set) {
            indicator._handles.forEach(handle => this._onHandle(handle));
        } else if (indicator.visible) {
            this._indicator = indicator;
            this._indicatorId = indicator.connect('notify::visible', () => this._syncShares());
            this._syncShares();
        }
    }

    /** Shares known by handle, plus one only GNOME's indicator knows about, until it hides. */
    _syncShares() {
        const unknown = Boolean(this._indicator?.visible);
        if (this._indicator && !unknown) {
            this._indicator.disconnect(this._indicatorId);
            this._indicator = null;
        }
        this._set('screenShare', this._shares.size > 0 || unknown);
    }

    /** Counts a new screen share until it stops. */
    _onHandle(handle) {
        // Recordings are covered by the screen recorder state above.
        if (handle.is_recording)
            return;
        this._shares.set(handle, handle.connect('stopped', () => {
            handle.disconnect(this._shares.get(handle));
            this._shares.delete(handle);
            this._syncShares();
        }));
        this._set('screenShare', true);
    }

    /** Sets one state, emitting `changed` only on a real change. */
    _set(key, value) {
        if (this[key] === value)
            return;
        this[key] = value;
        this.emit('changed');
    }

    /** Disconnects from every source. */
    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._cancellable.cancel();
        this._mixerIds.forEach(id => this._mixer.disconnect(id));
        this._daemon.disconnect(this._daemonId);
        this._screenshotUI.disconnect(this._recordingId);
        if (this._remoteId)
            this._remote.disconnect(this._remoteId);
        this._shares.forEach((id, handle) => handle.disconnect(id));
        this._indicator?.disconnect(this._indicatorId);
    }
}
