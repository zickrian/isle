// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Looks a song's lyrics up with the providers Settings turn on, in the order Settings give, going on to the next
// provider whenever one has none (or cannot be reached). LRCLIB is still looked up by isled (the daemon): the
// engine asks it when its turn comes. With LRCLIB the only provider on, the engine does nothing: isled's own lyrics
// go to the page as they always did.

import {DEFAULT_ORDER, LyricsFailure, PROVIDERS} from './lyricsProviders.js';

/** What isled's `Lyrics` says once it has an answer for a song. */
const TERMINAL = new Set(['synced', 'plain', 'instrumental', 'not_found', 'error', 'unavailable']);
/** Waits before asking again after every provider failed (not "no lyrics": a failure), then the last again. */
const RETRY_MS = [15000, 45000, 120000, 300000];
/** isled gets this long to answer for LRCLIB, and a provider this long in all. */
const DAEMON_TIMEOUT_MS = 30000;
const PROVIDER_TIMEOUT_MS = 25000;
/** A song nobody had lyrics for is not asked about again for this long (Musixmatch counts every call). */
const MISS_MS = 10 * 60 * 1000;
/** Songs kept answered while Isle runs. */
const MEMORY_MAX = 40;

/** How good a result is: synced words and an instrumental are final; whole plain words beat part of them. */
function rank(result) {
    if (!result)
        return 0;
    if (result.status === 'synced' || result.status === 'instrumental')
        return 3;
    return result.partial ? 1 : 2;
}

/** What a lookup needs of the playing song, from isled's `NowPlaying`. */
export function trackQuery(nowPlaying) {
    return {
        title: String(nowPlaying?.title ?? ''),
        artist: String(nowPlaying?.artist ?? ''),
        album: String(nowPlaying?.album ?? ''),
        lengthS: (nowPlaying?.length_us ?? 0) / 1e6,
    };
}

/** One string per song, as isled's `Lyrics.track`: what the page tells songs apart by. */
export function trackKey(query) {
    return `${query.artist}\u001f${query.title}\u001f${query.album}\u001f${Math.round(query.lengthS)}`;
}

/** The providers to ask, in order: those in Settings' order that are on, and (Musixmatch) have their key. Providers
 * Settings do not know about yet (a new one in a later version) go last, in the default order. */
export function providerPlan({order = [], off = [], keys = {}} = {}) {
    const known = [...new Set(order)].filter(id => id in PROVIDERS);
    const all = [...known, ...DEFAULT_ORDER.filter(id => !known.includes(id))];
    return all.filter(id => !off.includes(id) && (!PROVIDERS[id].needsKey || Boolean(keys[id]?.trim())));
}

/** Whether the engine has anything to do: with only LRCLIB left, isled's lyrics are the page's own. */
export function needsEngine(plan) {
    return !(plan.length === 1 && plan[0] === 'lrclib');
}

export class LyricsEngine {
    /**
     * `daemon`: Isle's Daemon (state, 'changed', `call`, and `interceptLyrics`, `publishLyrics`, `republishLyrics`).
     * `settings`: Isle's GSettings. `http`: `getText(url, {headers})`. `schedule(ms, fn)` runs `fn` once after `ms` and
     * returns the function that cancels it. `cache`: {get(key), set(key, result)} for found lyrics, or null.
     */
    constructor({daemon, settings, http, schedule, cache = null, now = () => Date.now()}) {
        this._daemon = daemon;
        this._settings = settings;
        this._http = http;
        this._schedule = schedule;
        this._cache = cache;
        this._now = now;
        this._wanted = false;
        /** Not told isled anything until the controller says whether lyrics are wanted (see `setWanted`). */
        this._told = false;
        this._engineOn = false;
        this._planSignature = null;
        /** The song being looked up: {key, query, retries}; and a count that ends lookups that were left behind. */
        this._current = null;
        this._token = 0;
        /** isled's latest `Lyrics`, kept while the engine stands between it and the page. */
        this._daemonRaw = null;
        this._waiter = null;
        /** What the page was last told, so that the same is not said again. */
        this._published = null;
        this._daemonOn = undefined;
        this._cancelRetry = null;
        this._answers = new Map();
        this._misses = new Map();
        this._destroyed = false;

        this._ids = [
            daemon.connect('changed', (_daemon, key) => {
                if (key === 'nowPlaying')
                    this._onNowPlaying();
            }),
        ];
        this._settingIds = ['lyrics-provider-order', 'lyrics-providers-off', 'musixmatch-api-key']
            .map(key => settings.connect(`changed::${key}`, () => this._configure()));
        this._configure();
    }

    /** Whether lyrics are looked up now (Settings turn them on, and the page that shows them is in the island). */
    setWanted(wanted) {
        this._wanted = wanted;
        this._told = true;
        // isled forgets it when it restarts: said again whenever this is.
        this._daemonOn = undefined;
        this._applyDaemon();
        if (this._engineOn)
            this._begin(false);
    }

    destroy() {
        this._destroyed = true;
        this._token++;
        this._cancelRetry?.();
        this._waiter?.cancel();
        for (const id of this._ids)
            this._daemon.disconnect(id);
        for (const id of this._settingIds)
            this._settings.disconnect(id);
        this._ids = [];
        this._settingIds = [];
        // Isle is going: nothing left to tell the page.
        this._daemon.interceptLyrics = null;
    }

    // ---- Settings ------------------------------------------------------------------------------------------

    _keys() {
        return {musixmatch: this._settings.get_string('musixmatch-api-key')};
    }

    _plan() {
        return providerPlan({
            order: this._settings.get_strv('lyrics-provider-order'),
            off: this._settings.get_strv('lyrics-providers-off'),
            keys: this._keys(),
        });
    }

    /** The plan or the keys changed: engine on or off, and a new look for the song playing. */
    _configure() {
        if (this._destroyed)
            return;
        const plan = this._plan();
        const signature = plan.join(',');
        const wasOn = this._engineOn;
        this._engineOn = needsEngine(plan);
        if (this._engineOn) {
            this._daemon.interceptLyrics = raw => this._onDaemonLyrics(raw);
        } else {
            this._daemon.interceptLyrics = null;
            this._cancelRun();
            this._current = null;
            this._applyDaemon();
            // What isled said meanwhile, for the page.
            if (wasOn)
                this._daemon.republishLyrics();
            this._planSignature = signature;
            return;
        }
        const changed = signature !== this._planSignature || !wasOn;
        this._planSignature = signature;
        this._applyDaemon();
        if (changed)
            this._begin(true);
    }

    // ---- isled (LRCLIB) --------------------------------------------------------------------------------------

    /** Tells isled whether to look lyrics up. With the engine on: while LRCLIB is the first provider, always (it looks
     * each new song up at once); otherwise only when its turn comes. */
    _applyDaemon() {
        if (!this._told)
            return;
        const plan = this._plan();
        const on = this._engineOn ? this._wanted && plan[0] === 'lrclib' : this._wanted;
        this._setDaemon(on);
    }

    _setDaemon(on) {
        if (this._daemonOn === on)
            return;
        this._daemonOn = on;
        this._daemon.call('media', 'SetLyrics', on);
    }

    /** isled's `Lyrics` changed: not for the page; for the engine, when it waits for LRCLIB. */
    _onDaemonLyrics(raw) {
        this._daemonRaw = raw;
        this._waiter?.check();
    }

    /** Waits for isled's answer for `query`'s song, or its failure. Resolves to its `Lyrics`. */
    _waitDaemon(query) {
        const prefix = `${query.artist}\u001f${query.title}\u001f`;
        const ready = raw => typeof raw?.track === 'string' && raw.track.startsWith(prefix) && TERMINAL.has(raw.status);
        return new Promise((resolve, reject) => {
            let cancelTimer = null;
            const finish = () => {
                cancelTimer?.();
                this._waiter = null;
            };
            const check = () => {
                if (ready(this._daemonRaw)) {
                    finish();
                    resolve(this._daemonRaw);
                }
            };
            // Called off (another song, or Settings changed): the one waiting hears of it, and finds its lookup is over.
            this._waiter = {check, cancel: () => {
                finish();
                reject(new LyricsFailure('service', 'lookup called off'));
            }};
            cancelTimer = this._schedule(DAEMON_TIMEOUT_MS, () => {
                finish();
                reject(new LyricsFailure('service', 'isled did not answer for LRCLIB'));
            });
            check();
        });
    }

    async _askDaemon(query) {
        this._setDaemon(true);
        try {
            const raw = await this._waitDaemon(query);
            switch (raw.status) {
            case 'synced':
            case 'plain':
                return {status: raw.status, lines: raw.lines ?? []};
            case 'instrumental':
                return {status: 'instrumental', lines: []};
            case 'not_found':
                return null;
            case 'error':
                throw new LyricsFailure('network', 'LRCLIB could not be reached');
            default:
                throw new LyricsFailure('service', 'LRCLIB could not serve the lyrics');
            }
        } finally {
            // Only while its turn lasts, unless it is the first (see `_applyDaemon`).
            this._applyDaemon();
        }
    }

    // ---- Looking songs up ------------------------------------------------------------------------------------

    _onNowPlaying() {
        if (this._engineOn)
            this._begin(false);
    }

    /** Tells the page; not again what it was told last. */
    _publish(key, status, lines = []) {
        const last = this._published;
        if (last && last.key === key && last.status === status && (last.lines === lines || (!last.lines.length && !lines.length)))
            return;
        this._published = {key, status, lines};
        this._daemon.publishLyrics({track: key, status, lines});
    }

    _cancelRun() {
        this._token++;
        this._cancelRetry?.();
        this._cancelRetry = null;
        this._waiter?.cancel();
    }

    /** Starts on the playing song if it is a new one (or `force`). */
    _begin(force) {
        // Until it is said whether lyrics are wanted, the page is left as it is.
        if (!this._told)
            return;
        const nowPlaying = this._daemon.state.nowPlaying;
        if (!nowPlaying?.available || !nowPlaying.title) {
            if (this._current) {
                this._cancelRun();
                this._current = null;
            }
            this._publish('', 'none');
            return;
        }
        const query = trackQuery(nowPlaying);
        const key = trackKey(query);
        if (!this._wanted) {
            // Nothing is looked up; the song is looked at afresh once lyrics are wanted again.
            this._cancelRun();
            this._current = null;
            this._publish(key, 'off');
            return;
        }
        if (!force && this._current?.key === key)
            return;
        this._cancelRun();
        const current = {key, query, retries: 0};
        this._current = current;
        const signature = `${key}\u001e${this._planSignature}`;
        const known = this._answers.get(signature) ?? this._cache?.get(signature) ?? null;
        if (known) {
            this._publish(key, known.status, known.lines);
            return;
        }
        const missedAt = this._misses.get(signature);
        if (missedAt !== undefined && this._now() - missedAt < MISS_MS) {
            this._publish(key, 'not_found');
            return;
        }
        this._publish(key, 'loading');
        this._run(current, signature).catch(error => console.warn(`Isle: lyrics lookup failed: ${error.message}`));
    }

    /** One provider's answer: null, a result, or a LyricsFailure. */
    async _ask(id, query) {
        if (id === 'lrclib')
            return this._askDaemon(query);
        const timeout = new Promise((_resolve, reject) => {
            const cancel = this._schedule(PROVIDER_TIMEOUT_MS, () => reject(new LyricsFailure('network', `${id} took too long`)));
            this._timeouts ??= new Set();
            this._timeouts.add(cancel);
        });
        const lookup = PROVIDERS[id].fetch(query, {http: this._http, key: this._keys()[id]?.trim() ?? ''});
        try {
            return await Promise.race([lookup, timeout]);
        } finally {
            for (const cancel of this._timeouts ?? [])
                cancel();
            this._timeouts?.clear();
        }
    }

    /** Asks each provider in turn until one has synced lyrics (or the song is an instrumental); a plain answer is shown
     * at once, and the rest asked for something better. */
    async _run(current, signature) {
        const token = ++this._token;
        const {key, query} = current;
        let best = null;
        // The worst thing that went wrong, if nothing was found.
        let failure = null;
        for (const id of this._plan()) {
            if (token !== this._token)
                return;
            let result;
            try {
                result = await this._ask(id, query);
            } catch (error) {
                if (token !== this._token)
                    return;
                if (!(error instanceof LyricsFailure)) {
                    console.warn(`Isle: ${id} lyrics failed: ${error.message}`);
                    failure ??= 'service';
                } else if (error.kind !== 'auth') {
                    console.warn(`Isle: ${id} lyrics: ${error.message}`);
                    failure = failure === 'service' ? failure : error.kind;
                }
                continue;
            }
            if (token !== this._token)
                return;
            if (result && rank(result) > rank(best)) {
                best = result;
                this._publish(key, best.status, best.lines);
            }
            if (rank(best) === 3)
                break;
        }
        if (token !== this._token)
            return;
        if (best) {
            this._remember(signature, best);
            return;
        }
        if (failure) {
            this._publish(key, failure === 'network' ? 'error' : 'unavailable');
            this._retryLater(current, signature);
        } else {
            this._misses.set(signature, this._now());
            this._publish(key, 'not_found');
        }
    }

    _remember(signature, result) {
        const kept = {status: result.status, lines: result.lines};
        this._answers.set(signature, kept);
        if (this._answers.size > MEMORY_MAX)
            this._answers.delete(this._answers.keys().next().value);
        this._cache?.set(signature, kept);
    }

    /** Every provider failed (not "no lyrics"): asks again after a growing delay while this song is still the one. */
    _retryLater(current, signature) {
        const delay = RETRY_MS[Math.min(current.retries, RETRY_MS.length - 1)];
        current.retries++;
        this._cancelRetry?.();
        this._cancelRetry = this._schedule(delay, () => {
            this._cancelRetry = null;
            if (this._destroyed || !this._wanted || this._current !== current)
                return;
            this._run(current, signature).catch(error => console.warn(`Isle: lyrics lookup failed: ${error.message}`));
        });
    }
}
