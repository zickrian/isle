// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Battery, network and Bluetooth status from the system bus, and events
//! when they change (charger plugged in, Wi-Fi lost, earbuds connected...).

mod bluetooth;
mod camera;
mod network;
mod power;
pub mod sleep;

use std::time::Duration;

use futures_util::{Stream, StreamExt};
use log::{debug, warn};
use serde::Serialize;
use tokio::time::Instant;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{Connection, interface};

pub use sleep::locked;

/// Changes arriving within this window are handled together, so a burst of
/// property updates (or a network briefly reconnecting) yields one event.
const SETTLE: Duration = Duration::from_millis(800);

/// First wait before restarting a watcher that stopped; it doubles with
/// every failure in a row, up to [`RESTART_MAX`].
const RESTART_MIN: Duration = Duration::from_secs(1);
const RESTART_MAX: Duration = Duration::from_secs(60);
/// A watcher that ran at least this long was healthy, so the next restart
/// after it stops is quick again.
const HEALTHY_AFTER: Duration = Duration::from_secs(60);

/// Everything the island shows about the machine, published as one JSON property.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SystemState {
    pub battery: Option<Battery>,
    pub network: Network,
    pub bluetooth: Vec<BluetoothDevice>,
    /// A camera is open in some app (privacy indicator).
    pub camera_in_use: bool,
}

/// The laptop's own battery, from UPower's display device.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Battery {
    /// A whole number, so the state only changes when the shown level does.
    pub percent: f64,
    /// Connected to power, whether or not it is currently charging.
    pub plugged: bool,
    pub charging: bool,
}

/// NetworkManager's primary connection.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Network {
    pub connected: bool,
    /// "wifi", "ethernet", "other", or empty when disconnected. (Not called
    /// `kind`: events are tagged with a `kind` field of their own.)
    pub connection: String,
    /// Connection name; the network name (SSID) for Wi-Fi.
    pub name: String,
}

/// A connected Bluetooth device; `path` is its BlueZ object.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BluetoothDevice {
    pub path: String,
    pub name: String,
    /// Freedesktop icon name, e.g. "audio-headphones".
    pub icon: String,
    pub battery: Option<u8>,
}

/// A change worth an alert on the island.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SystemEvent {
    Power {
        plugged: bool,
        percent: f64,
    },
    BatteryLow {
        percent: f64,
    },
    BatteryFull,
    Network(Network),
    Bluetooth {
        connected: bool,
        device: BluetoothDevice,
    },
}

/// isled's `System1` D-Bus object.
#[derive(Default)]
pub struct SystemService {
    state: SystemState,
}

#[interface(name = "io.github.zickrian.isle.System1")]
impl SystemService {
    /// JSON `SystemState`.
    #[zbus(property)]
    fn state(&self) -> String {
        serde_json::to_string(&self.state).unwrap_or_default()
    }

    /// JSON `SystemEvent`, tagged by its "kind" field.
    #[zbus(signal)]
    async fn event(emitter: &SignalEmitter<'_>, event: &str) -> zbus::Result<()>;
}

/// Starts every system watcher. Missing services (no battery, no BlueZ) are
/// logged and retried now and then.
pub fn spawn_watchers(system: Connection, iface: InterfaceRef<SystemService>) {
    let on_bus = |name| Some((system.clone(), name));
    let (bus, state) = (system.clone(), iface.clone());
    supervise("battery", on_bus(UPOWER), move || {
        power::watch(bus.clone(), state.clone())
    });
    let (bus, state) = (system.clone(), iface.clone());
    supervise("network", on_bus(NETWORK_MANAGER), move || {
        network::watch(bus.clone(), state.clone())
    });
    let bus = system.clone();
    supervise("sleep", on_bus(LOGIND), move || sleep::watch(bus.clone()));
    let bus = system.clone();
    supervise("screen lock", on_bus(LOGIND), move || {
        sleep::watch_lock(bus.clone())
    });
    let (bus, state) = (system.clone(), iface.clone());
    supervise("bluetooth", on_bus(BLUEZ), move || {
        bluetooth::watch(bus.clone(), state.clone())
    });
    supervise("camera", None, move || camera::watch(iface.clone()));
}

/// The system services the watchers follow, on the system bus.
const UPOWER: &str = "org.freedesktop.UPower";
const NETWORK_MANAGER: &str = "org.freedesktop.NetworkManager";
const LOGIND: &str = "org.freedesktop.login1";
const BLUEZ: &str = "org.bluez";

/// Waits until `name` has an owner on `bus`: a service this machine lacks (no BlueZ) costs no
/// wakeups, and one started later is followed at once.
async fn owned(bus: &Connection, name: &'static str) -> zbus::Result<()> {
    let dbus = zbus::fdo::DBusProxy::new(bus).await?;
    let mut changes = dbus
        .receive_name_owner_changed_with_args(&[(0, name)])
        .await?;
    if dbus.name_has_owner(name.try_into()?).await? {
        return Ok(());
    }
    while let Some(change) = changes.next().await {
        if change.args()?.new_owner().is_some() {
            return Ok(());
        }
    }
    Ok(())
}

/// Keeps a watcher running, since UPower, NetworkManager and BlueZ can restart under us; backs off
/// between tries, and while `service` (bus and name) has no owner, waits for one instead.
fn supervise<F, W>(name: &'static str, service: Option<(Connection, &'static str)>, start: F)
where
    F: Fn() -> W + Send + 'static,
    W: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    tokio::spawn(async move {
        let mut delay = RESTART_MIN;
        loop {
            let started = Instant::now();
            let result = start().await;
            if started.elapsed() >= HEALTHY_AFTER {
                delay = RESTART_MIN;
            }
            let reason = match result {
                Ok(()) => "its events ended".to_owned(),
                Err(err) => err.to_string(),
            };
            // Only the first failure in a row is worth a warning; repeats
            // (e.g. no BlueZ on this machine) would just fill the journal.
            if delay == RESTART_MIN {
                warn!("{name} monitoring stopped ({reason}); restarting in {delay:?}");
            } else {
                debug!("{name} monitoring stopped ({reason}); restarting in {delay:?}");
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(RESTART_MAX);
            if let Some((bus, service)) = &service
                && let Err(err) = owned(bus, service).await
            {
                debug!("could not wait for {service}: {err}");
            }
        }
    });
}

/// Applies `update` to the state, publishes it if it changed, and emits `event`.
async fn publish(
    iface: &InterfaceRef<SystemService>,
    update: impl FnOnce(&mut SystemState),
    event: Option<SystemEvent>,
) {
    let mut service = iface.get_mut().await;
    let before = service.state.clone();
    update(&mut service.state);
    let emitter = iface.signal_emitter();
    let result = async {
        if service.state != before {
            service.state_changed(emitter).await?;
        }
        if let Some(event) = event {
            let json = serde_json::to_string(&event).unwrap_or_default();
            SystemService::event(emitter, &json).await?;
        }
        zbus::Result::Ok(())
    };
    if let Err(err) = result.await {
        warn!("could not publish system state: {err}");
    }
}

/// Waits for the next item, then for the stream to stay quiet for [`SETTLE`].
/// Returns `false` once the stream has ended.
async fn settled<S: Stream + Unpin>(stream: &mut S) -> bool {
    if stream.next().await.is_none() {
        return false;
    }
    while let Ok(item) = tokio::time::timeout(SETTLE, stream.next()).await {
        if item.is_none() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_tagged_without_clashing_fields() {
        let event = SystemEvent::Network(Network {
            connected: true,
            connection: "wifi".into(),
            name: "Home".into(),
        });
        let json: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(json["kind"], "network");
        assert_eq!(json["connection"], "wifi");
    }
}
