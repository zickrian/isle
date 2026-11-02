// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Sharing the shelf with a phone: a QR code on the island opens a page in the phone's browser that
//! lists the shelf's files and sends files to it. A small web server runs only while sharing, on the
//! local network alone, behind a secret token and an Allow on the island. See SECURITY.md.

mod files;
mod http;
mod net;
mod server;
mod session;

use std::path::PathBuf;
use std::sync::Arc;

use futures_util::StreamExt;
use isle_core::shelf::ShelfItem;
use log::warn;
use qrcode::{Color, EcLevel, QrCode};
use serde_json::json;
use tokio::sync::watch;
use zbus::message::Header;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{Connection, fdo, interface};

use self::net::Trust;
use self::server::Host;
use self::session::{Config, Ended, Limits, Session, Status};
use crate::shelf::{ShelfService, owned_dir};
use crate::system::sleep;

/// The ports sharing listens on, one at random: a single firewall rule lets them all in.
const PORTS: (u16, u16) = (47830, 47839);

/// Phone sharing on the bus; nothing runs until `Start`.
#[derive(Default)]
pub struct ShareService {
    session: Option<Arc<Session>>,
    trust: Option<Trust>,
    firewall: Option<String>,
    /// The QR code of the session's address, a string of 0s and 1s per row.
    qr: Vec<String>,
    /// Why the last session ended.
    ended: Option<Ended>,
    /// Counts sessions, so the island knows when to ask for a new code.
    count: u64,
}

#[interface(name = "io.github.zickrian.isle.Share1")]
impl ShareService {
    /// Starts sharing (or keeps the session already running). GNOME Shell only.
    async fn start(
        &mut self,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        crate::caller::shell_only(connection, &header).await?;
        if let Some(session) = self
            .session
            .as_ref()
            .filter(|session| session.ended().is_none())
        {
            session.touch();
            return Ok(());
        }
        let lan = net::lan().ok_or_else(|| {
            fdo::Error::Failed("Not on a network · connect to Wi-Fi first".into())
        })?;
        let trust = net::trust(lan.ip).await;
        let firewall = net::ufw_hint(&lan, PORTS);
        let host = BusHost {
            shelf: connection
                .object_server()
                .interface(crate::OBJECT_PATH)
                .await?,
            bus: connection.clone(),
        };
        let config = Config {
            lan,
            own: net::own_addresses(),
            ports: PORTS,
            dir: owned_dir(),
            previews: crate::store::cache_dir().join("shelf"),
            limits: Limits::default(),
        };
        let session = server::start(config, host).await.map_err(|err| {
            fdo::Error::Failed(if err.kind() == std::io::ErrorKind::AddrInUse {
                format!(
                    "Ports {}–{} are all in use · try again later",
                    PORTS.0, PORTS.1
                )
            } else {
                format!("Couldn't start sharing: {err}")
            })
        })?;
        self.count += 1;
        self.qr = qr_rows(&session.url);
        self.session = Some(session.clone());
        self.trust = Some(trust);
        self.firewall = firewall;
        self.ended = None;
        let starter = header.sender().map(|name| name.to_string());
        tokio::spawn(guard(session, starter, connection.clone()));
        self.state_changed(&emitter).await?;
        Ok(())
    }

    /// Stops sharing: the server closes, transfers under way end. GNOME Shell only.
    async fn stop(
        &mut self,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        crate::caller::shell_only(connection, &header).await?;
        if let Some(session) = self.session.take() {
            session.end(Ended::Stopped);
            self.forget(Ended::Stopped);
            self.state_changed(&emitter).await?;
        }
        Ok(())
    }

    /// Allows or turns down the phone `id` asking to connect. GNOME Shell only.
    async fn answer(
        &mut self,
        id: &str,
        allow: bool,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        crate::caller::shell_only(connection, &header).await?;
        let answered = self
            .session
            .as_ref()
            .is_some_and(|session| session.answer(id, allow));
        if !answered {
            return Err(fdo::Error::InvalidArgs("no such phone is asking".into()));
        }
        self.state_changed(&emitter).await?;
        Ok(())
    }

    /// Takes the allowed phone `id` off: it sees nothing more, and can't ask again this session. GNOME
    /// Shell only.
    async fn remove(
        &mut self,
        id: &str,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        crate::caller::shell_only(connection, &header).await?;
        let removed = self
            .session
            .as_ref()
            .is_some_and(|session| session.remove(id));
        if !removed {
            return Err(fdo::Error::InvalidArgs("no such phone is connected".into()));
        }
        self.state_changed(&emitter).await?;
        Ok(())
    }

    /// The session's address with its token, and its QR code: `{url, qr}`. Not in `State`, which any
    /// program on the bus can read. GNOME Shell only.
    async fn code(
        &self,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
    ) -> fdo::Result<String> {
        crate::caller::shell_only(connection, &header).await?;
        let Some(session) = &self.session else {
            return Err(fdo::Error::Failed("not sharing".into()));
        };
        Ok(json!({ "url": session.url, "qr": self.qr }).to_string())
    }

    /// See docs/dbus-api.md. Holds no secret: neither the token nor a phone's cookie.
    #[zbus(property)]
    fn state(&self) -> String {
        let Some(session) = &self.session else {
            return json!({ "active": false, "ended": self.ended }).to_string();
        };
        json!({
            "active": true,
            "session": self.count,
            "network": self.trust,
            // Said only until a phone gets through: then nothing blocks it.
            "firewall": if session.has_been_reached() { None } else { self.firewall.as_deref() },
            "asking": session.phones(Status::Asking),
            "phones": session.phones(Status::Allowed),
            "idle_minutes": session.config.limits.idle.as_secs() / 60,
        })
        .to_string()
    }

    /// A file arrived from a phone and is on the shelf, under `name`.
    #[zbus(signal)]
    async fn received(emitter: &SignalEmitter<'_>, name: &str) -> zbus::Result<()>;
}

impl ShareService {
    fn forget(&mut self, why: Ended) {
        self.session = None;
        self.qr.clear();
        self.firewall = None;
        self.trust = None;
        self.ended = Some(why);
    }
}

/// Ends the session when the screen locks, the computer sleeps or GNOME Shell (which started it) leaves
/// the bus; once it ends, however it ends, the island hears of it.
async fn guard(session: Arc<Session>, starter: Option<String>, bus: Connection) {
    let mut locked = sleep::locked();
    let mut sleeps = sleep::sleeps();
    sleeps.mark_unchanged();
    let mut version = session.version();
    let gone = starter_gone(bus.clone(), starter);
    tokio::pin!(gone);
    let moved = net::network_changed(session.config.lan.clone());
    tokio::pin!(moved);
    if *locked.borrow_and_update() {
        session.end(Ended::Locked);
    }
    let why = loop {
        if let Some(why) = session.ended() {
            break why;
        }
        tokio::select! {
            changed = locked.changed() => {
                if changed.is_ok() && *locked.borrow_and_update() {
                    session.end(Ended::Locked);
                }
            }
            changed = sleeps.changed() => {
                if changed.is_ok() {
                    session.end(Ended::Asleep);
                }
            }
            () = &mut gone => {
                session.end(Ended::Gone);
            }
            () = &mut moved => {
                session.end(Ended::Network);
            }
            changed = version.changed() => {
                if changed.is_err() {
                    break Ended::Stopped;
                }
            }
        }
    };
    let Some(share) = own(&bus).await else {
        return;
    };
    let mut service = share.get_mut().await;
    let current = service
        .session
        .as_ref()
        .is_some_and(|running| Arc::ptr_eq(running, &session));
    if current {
        service.forget(why);
        if let Err(err) = service.state_changed(share.signal_emitter()).await {
            warn!("could not tell that phone sharing ended: {err}");
        }
    }
}

/// Resolves once the bus name `starter` has gone; never without one.
async fn starter_gone(bus: Connection, starter: Option<String>) {
    let Some(starter) = starter else {
        return std::future::pending().await;
    };
    let Ok(dbus) = fdo::DBusProxy::new(&bus).await else {
        return std::future::pending().await;
    };
    let Ok(mut changes) = dbus
        .receive_name_owner_changed_with_args(&[(0, starter.as_str())])
        .await
    else {
        return std::future::pending().await;
    };
    while let Some(change) = changes.next().await {
        if change.args().is_ok_and(|args| args.new_owner().is_none()) {
            return;
        }
    }
    std::future::pending().await
}

/// The QR code of `url`, a row of 0s and 1s (1 dark) per line, without its quiet zone. Level L: drawn
/// on a screen nothing smudges it, and every address fits version 3, big enough to read at four pixels a module.
fn qr_rows(url: &str) -> Vec<String> {
    let Ok(code) = QrCode::with_error_correction_level(url.as_bytes(), EcLevel::L) else {
        return Vec::new();
    };
    code.to_colors()
        .chunks(code.width())
        .map(|row| {
            row.iter()
                .map(|color| if *color == Color::Dark { '1' } else { '0' })
                .collect()
        })
        .collect()
}

/// This service on the bus; looked up only once a call to it is over, as the lookup reads it.
async fn own(bus: &Connection) -> Option<InterfaceRef<ShareService>> {
    bus.object_server()
        .interface(crate::OBJECT_PATH)
        .await
        .inspect_err(|err| warn!("phone sharing lost its own service: {err}"))
        .ok()
}

/// The server's view of isled: the shelf on the bus, and this service to tell the island.
#[derive(Clone)]
struct BusHost {
    shelf: InterfaceRef<ShelfService>,
    bus: Connection,
}

impl Host for BusHost {
    async fn items(&self) -> Vec<ShelfItem> {
        self.shelf.get().await.answering()
    }

    async fn shelve(&self, path: PathBuf) -> bool {
        let emitter = self.shelf.signal_emitter();
        self.shelf
            .get_mut()
            .await
            .add_received(&path, emitter)
            .await
    }

    async fn shelf_changes(&self) -> watch::Receiver<u64> {
        self.shelf.get().await.changes()
    }

    fn changed(&self) {
        let bus = self.bus.clone();
        tokio::spawn(async move {
            let Some(share) = own(&bus).await else {
                return;
            };
            let service = share.get().await;
            if let Err(err) = service.state_changed(share.signal_emitter()).await {
                warn!("could not tell of a phone: {err}");
            }
        });
    }

    fn received(&self, name: String) {
        let bus = self.bus.clone();
        tokio::spawn(async move {
            let Some(share) = own(&bus).await else {
                return;
            };
            if let Err(err) = ShareService::received(share.signal_emitter(), &name).await {
                warn!("could not tell of a file from a phone: {err}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_code_is_square_and_small() {
        // The longest address there is: version 3, 29 modules a side.
        let rows = qr_rows("http://255.255.255.255:47839/AAAAAAAAAAAAAAAAAAAAAA");
        assert_eq!(rows.len(), 29);
        assert!(rows.iter().all(|row| row.len() == 29));
        // A finder pattern's top row.
        assert!(rows[0].starts_with("1111111"));
    }

    #[test]
    fn the_state_holds_no_secret() {
        let config = Config {
            lan: net::Lan {
                ip: "192.168.1.2".parse().unwrap(),
                prefix: 24,
                interface: "wlan0".into(),
            },
            own: Vec::new(),
            ports: (0, 0),
            dir: std::env::temp_dir(),
            previews: std::env::temp_dir(),
            limits: Limits::default(),
        };
        let session = Arc::new(Session::new(config, "192.168.1.2:47830".parse().unwrap()));
        let (asking, _) = session
            .hello(
                None,
                "192.168.1.9".parse().unwrap(),
                "iPhone · Safari".into(),
            )
            .unwrap();
        let service = ShareService {
            qr: qr_rows(&session.url),
            session: Some(session.clone()),
            ..ShareService::default()
        };
        let state = service.state();
        assert!(!state.contains(&session.token), "{state}");
        assert!(!state.contains(&asking.secret), "{state}");
        assert!(
            state.contains(&asking.id) && state.contains(&asking.code),
            "{state}"
        );
        assert!(!state.contains("\"qr\""), "{state}");
    }
}
