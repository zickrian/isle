// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Web requests for the lyrics providers (see lyricsProviders.js), over libsoup, off the shell's main loop.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {LyricsFailure} from './lyricsProviders.js';

const TIMEOUT_S = 10;
const USER_AGENT = 'Isle (https://github.com/zickrian/isle)';

/** A session for GETs: `getText(url, {headers})` answers {status, text}, or throws a LyricsFailure('network').
 * `destroy()` ends what is in flight. */
export function createHttp() {
    const session = new Soup.Session({timeout: TIMEOUT_S, idle_timeout: TIMEOUT_S, user_agent: USER_AGENT});
    const cancellable = new Gio.Cancellable();
    return {
        async getText(url, {headers = {}} = {}) {
            const message = Soup.Message.new('GET', url);
            if (!message)
                throw new LyricsFailure('service', `not a web address: ${url}`);
            const request = message.get_request_headers();
            for (const [name, value] of Object.entries(headers))
                request.replace(name, value);
            let bytes;
            try {
                bytes = await new Promise((resolve, reject) => {
                    session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
                        try {
                            resolve(session.send_and_read_finish(result));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
            } catch (e) {
                throw new LyricsFailure('network', e.message);
            }
            return {status: message.get_status(), text: new TextDecoder().decode(bytes.get_data() ?? new Uint8Array())};
        },
        destroy() {
            cancellable.cancel();
            session.abort();
        },
    };
}
