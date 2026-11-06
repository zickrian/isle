// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

use std::collections::HashMap;
use std::time::Duration;

use futures_util::StreamExt;
use isle_core::battery::low_level;
use tokio::time::Instant;

use zbus::Connection;
use zbus::fdo::PropertiesProxy;
use zbus::names::InterfaceName;
use zbus::object_server::InterfaceRef;
use zbus::proxy::CacheProperties;
use zbus::zvariant::OwnedValue;

use super::{Battery, SystemEvent, SystemService, publish, settled};

const DESTINATION: &str = "org.freedesktop.UPower";
/// UPower's combined view of all batteries.
const PATH: &str = "/org/freedesktop/UPower/devices/DisplayDevice";
const INTERFACE: &str = "org.freedesktop.UPower.Device";

/// Plugged in and out again within this, as a charge limit can make the battery seem to (pending-charge,
/// discharging, pending-charge…), alerts only once.
const FLAP_WINDOW: Duration = Duration::from_secs(30);

/// The properties read; a change to any other (the energy, the rate, the time it was measured) is not.
const READ: [&str; 4] = ["IsPresent", "Type", "State", "Percentage"];

// UPower device types and states.
const TYPE_BATTERY: u32 = 2;
const STATE_CHARGING: u32 = 1;
const STATE_FULLY_CHARGED: u32 = 4;
const STATE_PENDING_CHARGE: u32 = 5;

/// Follows UPower's battery for the state and the plugged, full and low alerts, until the bus closes.
pub async fn watch(system: Connection, iface: InterfaceRef<SystemService>) -> anyhow::Result<()> {
    let properties = PropertiesProxy::builder(&system)
        .destination(DESTINATION)?
        .path(PATH)?
        .cache_properties(CacheProperties::No)
        .build()
        .await?;
    // UPower says what changed every few seconds while on battery, mostly figures never shown.
    let mut changes = properties
        .receive_properties_changed_with_args(&[(0, INTERFACE)])
        .await?
        .filter(|signal| {
            let read = signal.args().is_ok_and(|args| {
                !args.invalidated_properties().is_empty()
                    || args
                        .changed_properties()
                        .keys()
                        .any(|key| READ.contains(key))
            });
            std::future::ready(read)
        });
    let mut previous: Option<(Reading, bool)> = None;
    let mut last_power_alert: Option<Instant> = None;
    // The lowest level warned about since the charger was unplugged.
    let mut warned: Option<f64> = None;

    loop {
        let all = properties
            .get_all(InterfaceName::from_static_str_unchecked(INTERFACE))
            .await?;
        let current = read(&all);

        let event = match (&previous, &current) {
            (Some((before, _)), Some((now, _))) if before.plugged != now.plugged => {
                let flapping = last_power_alert.is_some_and(|at| at.elapsed() < FLAP_WINDOW);
                last_power_alert = Some(Instant::now());
                (!flapping).then_some(SystemEvent::Power {
                    plugged: now.plugged,
                    percent: now.percent,
                })
            }
            (Some((_, was_full)), Some((now, true))) if !was_full && now.plugged => {
                Some(SystemEvent::BatteryFull)
            }
            (Some((before, _)), Some((now, _))) if !now.plugged => {
                low_level(before.percent, now.percent, warned).map(|level| {
                    warned = Some(level);
                    SystemEvent::BatteryLow {
                        percent: now.percent,
                    }
                })
            }
            _ => None,
        };
        if current.as_ref().is_some_and(|(now, _)| now.plugged) {
            warned = None;
        }

        let battery = current.as_ref().map(|(reading, _)| reading.shown());
        publish(&iface, |state| state.battery = battery, event).await;
        previous = current;

        if !settled(&mut changes).await {
            return Ok(());
        }
    }
}

/// The battery as read, its exact level for the alerts.
#[derive(Debug, Clone, PartialEq)]
struct Reading {
    percent: f64,
    plugged: bool,
    charging: bool,
}

impl Reading {
    /// The battery as the state shows it.
    fn shown(&self) -> Battery {
        Battery {
            percent: self.percent.round(),
            plugged: self.plugged,
            charging: self.charging,
        }
    }
}

/// The battery and whether it is fully charged, or `None` without a battery.
fn read(all: &HashMap<String, OwnedValue>) -> Option<(Reading, bool)> {
    let u32_of = |key: &str| all.get(key).and_then(|v| u32::try_from(v).ok());

    let present = all
        .get("IsPresent")
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(false);
    if !present || u32_of("Type") != Some(TYPE_BATTERY) {
        return None;
    }
    let state = u32_of("State").unwrap_or(0);
    let battery = Reading {
        percent: all
            .get("Percentage")
            .and_then(|v| f64::try_from(v).ok())
            .unwrap_or(0.0),
        plugged: matches!(
            state,
            STATE_CHARGING | STATE_FULLY_CHARGED | STATE_PENDING_CHARGE
        ),
        charging: state == STATE_CHARGING,
    };
    Some((battery, state == STATE_FULLY_CHARGED))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_shows_whole_percents() {
        let reading = |percent| Reading {
            percent,
            plugged: false,
            charging: false,
        };
        assert_eq!(reading(57.4).shown().percent, 57.0);
        assert_eq!(reading(57.5).shown().percent, 58.0);
        // Small changes leave the state as it was.
        assert_eq!(reading(57.31).shown(), reading(56.9).shown());
    }
}
