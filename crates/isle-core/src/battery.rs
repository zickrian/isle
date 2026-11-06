// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! When a battery is low enough to say so: the laptop's once per level until it is plugged in, and each
//! connected Bluetooth device's once per level on the way down, until it charges back above that level.

use std::collections::HashMap;

/// Percentages at which a low battery is said, once each, highest first.
pub const LOW_LEVELS: [f64; 3] = [20.0, 10.0, 5.0];

/// A device's level counts as charged back above a low level only this many points over it: a reading that
/// wavers round a level (20, 21, 20), as some devices' do, warns once.
const RECHARGED: f64 = 5.0;

/// The low level the battery just went under, if not warned about yet (`warned`, the lowest so far): a level
/// read a little up and down again, as some batteries are, warns once; asleep past two levels, the lowest.
pub fn low_level(before: f64, now: f64, warned: Option<f64>) -> Option<f64> {
    LOW_LEVELS
        .into_iter()
        .filter(|&level| warned.is_none_or(|warned| level < warned))
        .rfind(|&level| before > level && now <= level)
}

/// Connected Bluetooth devices' low-battery warnings, each device on its own, by its path.
#[derive(Debug, Default)]
pub struct DeviceBatteries {
    /// The lowest level warned about per device, still to be charged back above.
    warned: HashMap<String, f64>,
}

impl DeviceBatteries {
    /// `device`'s battery went from `before` to `now` (percent); the low level to warn about, if any.
    pub fn reading(&mut self, device: &str, before: u8, now: u8) -> Option<u8> {
        let (before, now) = (f64::from(before), f64::from(now));
        // Charged back above a level: it warns again the next time the battery goes under it.
        let warned = self.warned.get(device).and_then(|&warned| {
            LOW_LEVELS
                .into_iter()
                .filter(|&level| level >= warned && now <= level + RECHARGED)
                .reduce(f64::min)
        });
        let level = low_level(before, now, warned);
        match level.or(warned) {
            Some(lowest) => self.warned.insert(device.to_owned(), lowest),
            None => self.warned.remove(device),
        };
        // The levels are whole numbers.
        level.map(|level| level as u8)
    }

    /// Forgets a device that went: connected again, it starts afresh.
    pub fn forget(&mut self, device: &str) {
        self.warned.remove(device);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_low_level_warns_once_until_plugged_in() {
        assert_eq!(low_level(20.3, 19.8, None), Some(20.0));
        // Back over 20% and under again: said already.
        assert_eq!(low_level(20.1, 19.9, Some(20.0)), None);
        assert_eq!(low_level(10.2, 9.9, Some(20.0)), Some(10.0));
        // Asleep past two levels: the lowest.
        assert_eq!(low_level(22.0, 8.0, None), Some(10.0));
        assert_eq!(low_level(30.0, 25.0, None), None);
    }

    #[test]
    fn a_device_warns_once_per_level_on_the_way_down() {
        let mut devices = DeviceBatteries::default();
        assert_eq!(devices.reading("buds", 30, 25), None);
        assert_eq!(devices.reading("buds", 21, 20), Some(20));
        assert_eq!(devices.reading("buds", 20, 15), None);
        assert_eq!(devices.reading("buds", 15, 10), Some(10));
        assert_eq!(devices.reading("buds", 10, 9), None);
        // Several levels at once (a headset that reports in tens, or a gap): the lowest.
        assert_eq!(devices.reading("buds", 9, 4), Some(5));
        assert_eq!(devices.reading("buds", 4, 1), None);
    }

    #[test]
    fn going_up_is_never_a_warning() {
        let mut devices = DeviceBatteries::default();
        assert_eq!(devices.reading("buds", 5, 15), None);
        assert_eq!(devices.reading("buds", 15, 20), None);
    }

    #[test]
    fn a_wavering_reading_warns_once() {
        let mut devices = DeviceBatteries::default();
        assert_eq!(devices.reading("mouse", 21, 20), Some(20));
        assert_eq!(devices.reading("mouse", 20, 21), None);
        assert_eq!(devices.reading("mouse", 21, 20), None);
        assert_eq!(devices.reading("mouse", 20, 25), None);
        assert_eq!(devices.reading("mouse", 25, 20), None);
    }

    #[test]
    fn charged_back_above_a_level_warns_again() {
        let mut devices = DeviceBatteries::default();
        assert_eq!(devices.reading("buds", 21, 20), Some(20));
        assert_eq!(devices.reading("buds", 20, 10), Some(10));
        // Charged to 16: 10% is armed again, 20% not (it hasn't gone back over it).
        assert_eq!(devices.reading("buds", 10, 16), None);
        assert_eq!(devices.reading("buds", 16, 10), Some(10));
        // Charged well over 20%: both again.
        assert_eq!(devices.reading("buds", 10, 60), None);
        assert_eq!(devices.reading("buds", 60, 20), Some(20));
    }

    #[test]
    fn each_device_on_its_own() {
        let mut devices = DeviceBatteries::default();
        assert_eq!(devices.reading("buds", 21, 20), Some(20));
        assert_eq!(devices.reading("mouse", 21, 20), Some(20));
        assert_eq!(devices.reading("buds", 20, 19), None);
    }

    #[test]
    fn a_device_that_went_starts_afresh() {
        let mut devices = DeviceBatteries::default();
        assert_eq!(devices.reading("buds", 21, 20), Some(20));
        devices.forget("buds");
        assert_eq!(devices.reading("buds", 21, 20), Some(20));
    }
}
