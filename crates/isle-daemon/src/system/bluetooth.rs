// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use isle_core::battery::DeviceBatteries;
use zbus::fdo::{ObjectManagerProxy, PropertiesProxy};
use zbus::message::Type as MessageType;
use zbus::names::InterfaceName;
use zbus::object_server::InterfaceRef;
use zbus::zvariant::{ObjectPath, OwnedValue};
use zbus::{Connection, MatchRule, MessageStream};

use super::{BluetoothDevice, SystemEvent, SystemService, publish};

const BLUEZ: &str = "org.bluez";
const DEVICE: &str = "org.bluez.Device1";
const BATTERY: &str = "org.bluez.Battery1";
/// Headsets usually report their battery a moment after connecting.
const BATTERY_GRACE: Duration = Duration::from_millis(2500);

/// How often each device's `Connected` changed, by object path. A connection is announced
/// only if nothing changed during [`BATTERY_GRACE`], so a bounced device is not listed.
type Generations = Arc<Mutex<HashMap<String, u64>>>;

/// Follows BlueZ: connected devices and their batteries, with an alert as one connects or goes, and as its
/// battery goes low.
pub async fn watch(system: Connection, iface: InterfaceRef<SystemService>) -> anyhow::Result<()> {
    let manager = ObjectManagerProxy::builder(&system)
        .destination(BLUEZ)?
        .path("/")?
        .build()
        .await?;
    // Only devices' and their batteries' changes: adapters and media transports change often.
    let mut changes = futures_util::stream::select(
        properties_changed(&system, DEVICE).await?,
        properties_changed(&system, BATTERY).await?,
    );
    let mut added = manager.receive_interfaces_added().await?;

    // Devices that were already connected when Isle started.
    let mut connected = Vec::new();
    for (path, interfaces) in manager.get_managed_objects().await? {
        let is_connected = interfaces
            .get(DEVICE)
            .and_then(|props| props.get("Connected"))
            .and_then(|v| bool::try_from(v).ok())
            .unwrap_or(false);
        if is_connected {
            // One device that cannot be read must not cost us the others.
            if let Ok(device) = read_device(&system, &path).await {
                connected.push(device);
            }
        }
    }
    publish(&iface, |state| state.bluetooth = connected, None).await;
    let generations = Generations::default();
    let mut lows = DeviceBatteries::default();

    loop {
        tokio::select! {
            Some(message) = changes.next() => {
                let Ok(message) = message else { continue };
                let header = message.header();
                let Some(path) = header.path() else { continue };
                let Ok((interface, changed, _)) =
                    message.body().deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>()
                else {
                    continue;
                };
                if interface == DEVICE {
                    if let Some(now) = changed.get("Connected").and_then(|v| bool::try_from(v).ok()) {
                        if !now {
                            lows.forget(path.as_str());
                        }
                        connection_changed(&system, &iface, &generations, path.to_owned(), now).await;
                    }
                } else if interface == BATTERY
                    && let Some(percent) = changed.get("Percentage").and_then(|v| u8::try_from(v).ok())
                {
                    set_battery(&iface, &mut lows, path.as_str(), percent).await;
                }
            }
            Some(signal) = added.next() => {
                let Ok(args) = signal.args() else { continue };
                let percent = args
                    .interfaces_and_properties()
                    .get(BATTERY)
                    .and_then(|props| props.get("Percentage"))
                    .and_then(|v| u8::try_from(v).ok());
                if let Some(percent) = percent {
                    set_battery(&iface, &mut lows, args.object_path().as_str(), percent).await;
                }
            }
            else => return Ok(()),
        }
    }
}

/// BlueZ's `PropertiesChanged` signals for `interface`.
async fn properties_changed(system: &Connection, interface: &str) -> zbus::Result<MessageStream> {
    let rule = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .sender(BLUEZ)?
        .interface("org.freedesktop.DBus.Properties")?
        .member("PropertiesChanged")?
        .arg(0, interface)?
        .build();
    MessageStream::for_match_rule(rule, system, None).await
}

/// A device connected or went; a connection is announced once it has held for `BATTERY_GRACE`.
async fn connection_changed(
    system: &Connection,
    iface: &InterfaceRef<SystemService>,
    generations: &Generations,
    path: ObjectPath<'static>,
    now_connected: bool,
) {
    let generation = {
        let mut generations = generations.lock().unwrap_or_else(|e| e.into_inner());
        let generation = generations.entry(path.to_string()).or_default();
        *generation += 1;
        *generation
    };

    if now_connected {
        let generations = generations.clone();
        let still_current = move |path: &ObjectPath<'_>| {
            let generations = generations.lock().unwrap_or_else(|e| e.into_inner());
            generations.get(path.as_str()) == Some(&generation)
        };
        // Wait for the battery level in a separate task, so other devices'
        // updates are not held up.
        let (system, iface) = (system.clone(), iface.clone());
        tokio::spawn(async move {
            tokio::time::sleep(BATTERY_GRACE).await;
            if !still_current(&path) {
                return;
            }
            let Ok(device) = read_device(&system, &path).await else {
                return;
            };
            // Reading the device took a round trip, so check again. From here we queue for the
            // state lock without yielding; a later disconnect queues behind and removes it again.
            if !still_current(&path) {
                return;
            }
            let event = SystemEvent::Bluetooth {
                connected: true,
                device: device.clone(),
            };
            publish(
                &iface,
                |state| {
                    state.bluetooth.retain(|d| d.path != device.path);
                    state.bluetooth.push(device);
                },
                Some(event),
            )
            .await;
        });
    } else {
        let known = iface
            .get()
            .await
            .state
            .bluetooth
            .iter()
            .find(|d| d.path == path.as_str())
            .cloned();
        let Some(device) = known else { return };
        let event = SystemEvent::Bluetooth {
            connected: false,
            device,
        };
        publish(
            iface,
            |state| state.bluetooth.retain(|d| d.path != path.as_str()),
            Some(event),
        )
        .await;
    }
}

/// A connected device's battery, as BlueZ reports it, with an alert as it goes under a low level.
async fn set_battery(
    iface: &InterfaceRef<SystemService>,
    lows: &mut DeviceBatteries,
    path: &str,
    percent: u8,
) {
    let known = iface
        .get()
        .await
        .state
        .bluetooth
        .iter()
        .find(|d| d.path == path)
        .cloned();
    // Its first reading (or one before it is announced) is no way down.
    let event = known.and_then(|device| {
        let before = device.battery?;
        lows.reading(path, before, percent)?;
        Some(SystemEvent::BluetoothLow {
            device: BluetoothDevice {
                battery: Some(percent),
                ..device
            },
        })
    });
    publish(
        iface,
        |state| {
            if let Some(device) = state.bluetooth.iter_mut().find(|d| d.path == path) {
                device.battery = Some(percent);
            }
        },
        event,
    )
    .await;
}

/// A device's name and icon, and its battery if it reports one.
async fn read_device(system: &Connection, path: &ObjectPath<'_>) -> zbus::Result<BluetoothDevice> {
    let properties = PropertiesProxy::builder(system)
        .destination(BLUEZ)?
        .path(path.to_owned())?
        .build()
        .await?;
    let device = properties
        .get_all(InterfaceName::from_static_str_unchecked(DEVICE))
        .await?;
    let text = |key: &str| {
        device
            .get(key)
            .and_then(|v| String::try_from(v.try_clone().ok()?).ok())
    };
    let battery = properties
        .get(
            InterfaceName::from_static_str_unchecked(BATTERY),
            "Percentage",
        )
        .await
        .ok()
        .and_then(|v| u8::try_from(v).ok());

    Ok(BluetoothDevice {
        path: path.to_string(),
        name: text("Alias")
            .or_else(|| text("Name"))
            .unwrap_or_else(|| "Bluetooth device".into()),
        icon: text("Icon").unwrap_or_else(|| "bluetooth".into()),
        battery,
    })
}
