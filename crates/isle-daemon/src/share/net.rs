// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Where phone sharing listens: one address on the local network (never every interface), how far
//! that network looks to be trusted, and whether ufw may block it.

use std::collections::HashMap;
use std::ffi::CStr;
use std::net::{IpAddr, Ipv4Addr};

use serde::Serialize;
use zbus::fdo::PropertiesProxy;
use zbus::names::InterfaceName;
use zbus::proxy::CacheProperties;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

/// One IPv4 network the computer is on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lan {
    pub ip: Ipv4Addr,
    pub prefix: u8,
    pub interface: String,
}

impl Lan {
    /// Whether `peer` is on this network (a phone on the same Wi-Fi), or is this computer.
    pub fn contains(&self, peer: IpAddr) -> bool {
        let IpAddr::V4(peer) = peer.to_canonical() else {
            return false;
        };
        let mask = u32::MAX
            .checked_shl(32 - u32::from(self.prefix))
            .unwrap_or(0);
        u32::from(peer) & mask == u32::from(self.ip) & mask
    }
}

/// Interfaces of containers, VMs and VPNs: a phone is never on these.
const VIRTUAL: &[&str] = &[
    "docker",
    "br-",
    "veth",
    "virbr",
    "vnet",
    "vboxnet",
    "vmnet",
    "lxc",
    "lxd",
    "podman",
    "cni",
    "flannel",
    "tun",
    "tap",
    "wg",
    "tailscale",
    "zt",
    "ppp",
];

/// The address a phone on the same network reaches this computer at: on the interface with the default
/// route first, a private address first, Wi-Fi first. None without a network.
pub fn lan() -> Option<Lan> {
    let default = default_route_interface();
    let mut found: Vec<Lan> = interfaces()
        .into_iter()
        .filter(|lan| {
            !VIRTUAL
                .iter()
                .any(|prefix| lan.interface.starts_with(prefix))
        })
        .filter(|lan| !lan.ip.is_loopback() && !lan.ip.is_unspecified() && lan.prefix > 0)
        .collect();
    found.sort_by_key(|lan| {
        (
            Some(&lan.interface) != default.as_ref(),
            !is_private(lan.ip),
            !std::path::Path::new("/sys/class/net")
                .join(&lan.interface)
                .join("wireless")
                .exists(),
        )
    });
    found.into_iter().next()
}

/// Resolves once sharing's network is not the one it started on: its address gone from its interface, or
/// the connection on that interface another (a new network, even with the same address). Another device
/// taking the default route, a VPN, NetworkManager restarting change nothing. Looked at as
/// NetworkManager says a device or the connection changed (no polling); never without NetworkManager.
pub async fn network_changed(lan: Lan) {
    use futures_util::StreamExt;
    let Ok(bus) = zbus::Connection::system().await else {
        return std::future::pending().await;
    };
    let rule = |member: &'static str| {
        zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender(NM)
            .and_then(|rule| rule.member(member))
            .map(|rule| rule.build())
    };
    let (Ok(states), Ok(properties)) = (rule("StateChanged"), rule("PropertiesChanged")) else {
        return std::future::pending().await;
    };
    let (Ok(states), Ok(properties)) = (
        zbus::MessageStream::for_match_rule(states, &bus, None).await,
        zbus::MessageStream::for_match_rule(properties, &bus, None).await,
    ) else {
        return std::future::pending().await;
    };
    let started = device_connection(&bus, &lan.interface).await;
    // Only the manager's own properties: an access point's signal strength changes all the time.
    let properties = properties.filter(|message| {
        let manager = message.as_ref().ok().and_then(|m| {
            m.header()
                .path()
                .map(|p| p.as_str() == "/org/freedesktop/NetworkManager")
        });
        std::future::ready(manager == Some(true))
    });
    let mut changes = futures_util::stream::select(states, properties);
    while changes.next().await.is_some() {
        let now = device_connection(&bus, &lan.interface).await;
        if !same_network(&lan, &interfaces(), started.as_deref(), now.as_deref()) {
            return;
        }
    }
    std::future::pending().await
}

/// Whether `lan` is still the network it was: its address on its interface among `now`, and the connection on
/// that interface the same as `then`. No answer either time is unknown, never another network.
pub fn same_network(lan: &Lan, now: &[Lan], then: Option<&str>, connection: Option<&str>) -> bool {
    let address = now
        .iter()
        .any(|other| other.ip == lan.ip && other.interface == lan.interface);
    let other = matches!((then, connection), (Some(then), Some(now)) if then != now);
    address && !other
}

/// The uuid of the connection active on `interface` (a profile: the same network again has the same one).
async fn device_connection(bus: &zbus::Connection, interface: &str) -> Option<String> {
    let device: OwnedObjectPath = bus
        .call_method(
            Some(NM),
            "/org/freedesktop/NetworkManager",
            Some(NM),
            "GetDeviceByIpIface",
            &(interface,),
        )
        .await
        .ok()?
        .body()
        .deserialize()
        .ok()?;
    let device = get_all(
        &properties(bus, device.as_str()).await.ok()?,
        "org.freedesktop.NetworkManager.Device",
    )
    .await
    .ok()?;
    let active = path(&device, "ActiveConnection")?;
    let active = get_all(
        &properties(bus, active.as_str()).await.ok()?,
        "org.freedesktop.NetworkManager.Connection.Active",
    )
    .await
    .ok()?;
    Some(text(&active, "Uuid")).filter(|uuid| !uuid.is_empty())
}

/// This computer's own IPv4 addresses, on every interface: a connection from one of them comes from a
/// program here, not a phone.
pub fn own_addresses() -> Vec<IpAddr> {
    interfaces()
        .into_iter()
        .map(|lan| IpAddr::V4(lan.ip))
        .collect()
}

/// Every IPv4 address of an interface that is up.
fn interfaces() -> Vec<Lan> {
    let mut found = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills `list` with a linked list that freeifaddrs releases below.
    if unsafe { libc::getifaddrs(&mut list) } != 0 {
        return found;
    }
    let mut entry = list;
    while !entry.is_null() {
        // SAFETY: `entry` is a node of the list getifaddrs returned, alive until freeifaddrs.
        let ifa = unsafe { &*entry };
        entry = ifa.ifa_next;
        let up = ifa.ifa_flags & (libc::IFF_UP as u32) != 0;
        if !up || ifa.ifa_addr.is_null() || ifa.ifa_netmask.is_null() || ifa.ifa_name.is_null() {
            continue;
        }
        // SAFETY: checked non-null; the family says which sockaddr it is.
        if i32::from(unsafe { (*ifa.ifa_addr).sa_family }) != libc::AF_INET {
            continue;
        }
        // SAFETY: AF_INET addresses and masks are sockaddr_in; the name is a C string.
        let (addr, mask, name) = unsafe {
            (
                &*(ifa.ifa_addr as *const libc::sockaddr_in),
                &*(ifa.ifa_netmask as *const libc::sockaddr_in),
                CStr::from_ptr(ifa.ifa_name),
            )
        };
        found.push(Lan {
            ip: Ipv4Addr::from(u32::from_be(addr.sin_addr.s_addr)),
            prefix: u32::from_be(mask.sin_addr.s_addr).count_ones() as u8,
            interface: name.to_string_lossy().into_owned(),
        });
    }
    // SAFETY: the list from getifaddrs, freed once; no reference to it outlives this.
    unsafe { libc::freeifaddrs(list) };
    found
}

/// The interface of the IPv4 default route, from the kernel's routing table.
fn default_route_interface() -> Option<String> {
    let table = std::fs::read_to_string("/proc/net/route").ok()?;
    table.lines().skip(1).find_map(|line| {
        let mut fields = line.split_whitespace();
        let (interface, destination) = (fields.next()?, fields.next()?);
        (destination == "00000000").then(|| interface.to_owned())
    })
}

/// An address only a local network uses (RFC 1918, shared or link-local).
pub fn is_private(ip: Ipv4Addr) -> bool {
    let shared = ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1]);
    ip.is_private() || ip.is_link_local() || shared
}

/// How far the network looks to be trusted, as the island says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    /// A private address on a protected Wi-Fi or a cable.
    Home,
    /// Wi-Fi without a password (or one anyone may join, as OWE): others nearby can listen in.
    Open,
    /// A public address: a phone would reach it from anywhere.
    Public,
    /// NetworkManager could not say.
    Unknown,
}

/// What NetworkManager says of its main connection, for `ip` on it.
pub async fn trust(ip: Ipv4Addr) -> Trust {
    if !is_private(ip) {
        return Trust::Public;
    }
    match wifi_security().await {
        Ok(Some(true)) | Ok(None) => Trust::Home,
        Ok(Some(false)) => Trust::Open,
        Err(err) => {
            log::debug!("could not ask NetworkManager about the network: {err}");
            Trust::Unknown
        }
    }
}

const NM: &str = "org.freedesktop.NetworkManager";
/// NM_802_11_AP_FLAGS_PRIVACY, and NM_802_11_AP_SEC_KEY_MGMT_OWE (encrypted, but open to anyone).
const AP_PRIVACY: u32 = 0x1;
const KEY_MGMT_OWE: u32 = 0x800;

/// Whether the main connection's Wi-Fi asks for a password; None when it is not Wi-Fi.
async fn wifi_security() -> zbus::Result<Option<bool>> {
    let bus = zbus::Connection::system().await?;
    let manager = properties(&bus, "/org/freedesktop/NetworkManager").await?;
    let all = get_all(&manager, NM).await?;
    if text(&all, "PrimaryConnectionType") != "802-11-wireless" {
        return Ok(None);
    }
    let Some(active) = path(&all, "PrimaryConnection") else {
        return Ok(None);
    };
    let active = get_all(
        &properties(&bus, active.as_str()).await?,
        "org.freedesktop.NetworkManager.Connection.Active",
    )
    .await?;
    // For Wi-Fi, the access point in use.
    let Some(point) = path(&active, "SpecificObject") else {
        return Ok(None);
    };
    let point = get_all(
        &properties(&bus, point.as_str()).await?,
        "org.freedesktop.NetworkManager.AccessPoint",
    )
    .await?;
    let number = |key: &str| {
        point
            .get(key)
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(0)
    };
    let (flags, wpa, rsn) = (number("Flags"), number("WpaFlags"), number("RsnFlags"));
    let open = (flags & AP_PRIVACY == 0 && wpa == 0 && rsn == 0) || rsn & KEY_MGMT_OWE != 0;
    Ok(Some(!open))
}

async fn properties<'a>(
    bus: &zbus::Connection,
    path: &'a str,
) -> zbus::Result<PropertiesProxy<'a>> {
    PropertiesProxy::builder(bus)
        .destination(NM)?
        .path(path)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
}

async fn get_all(
    proxy: &PropertiesProxy<'_>,
    interface: &'static str,
) -> zbus::Result<HashMap<String, OwnedValue>> {
    Ok(proxy
        .get_all(InterfaceName::from_static_str_unchecked(interface))
        .await?)
}

fn text(all: &HashMap<String, OwnedValue>, key: &str) -> String {
    all.get(key)
        .and_then(|v| String::try_from(v.try_clone().ok()?).ok())
        .unwrap_or_default()
}

/// An object path property; None for none or "/".
fn path(all: &HashMap<String, OwnedValue>, key: &str) -> Option<OwnedObjectPath> {
    all.get(key)
        .and_then(|v| OwnedObjectPath::try_from(v.try_clone().ok()?).ok())
        .filter(|path| path.as_str() != "/")
}

/// The command that lets phones in, when ufw is on and drops what it is not told to let in. Its rules
/// are root's to read, so whether one already allows `ports` can't be known; the island says it only
/// until a phone gets through.
pub fn ufw_hint(lan: &Lan, ports: (u16, u16)) -> Option<String> {
    let config = std::fs::read_to_string("/etc/ufw/ufw.conf").ok()?;
    let enabled = config
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("ENABLED=yes"));
    let policy = std::fs::read_to_string("/etc/default/ufw").unwrap_or_default();
    let open = policy
        .lines()
        .any(|line| line.trim().replace('"', "") == "DEFAULT_INPUT_POLICY=ACCEPT");
    if !enabled || open {
        return None;
    }
    let mask = u32::MAX
        .checked_shl(32 - u32::from(lan.prefix))
        .unwrap_or(0);
    let network = Ipv4Addr::from(u32::from(lan.ip) & mask);
    Some(format!(
        "sudo ufw allow from {network}/{} to any port {}:{} proto tcp",
        lan.prefix, ports.0, ports.1
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_network_holds_its_own_addresses_only() {
        let lan = Lan {
            ip: Ipv4Addr::new(192, 168, 1, 23),
            prefix: 24,
            interface: "wlan0".into(),
        };
        assert!(lan.contains("192.168.1.40".parse().unwrap()));
        assert!(lan.contains("::ffff:192.168.1.40".parse().unwrap()));
        assert!(!lan.contains("192.168.2.40".parse().unwrap()));
        assert!(!lan.contains("8.8.8.8".parse().unwrap()));
        assert!(!lan.contains("fe80::1".parse().unwrap()));
    }

    #[test]
    fn another_network_is_not_the_same_one() {
        let lan = Lan {
            ip: Ipv4Addr::new(192, 168, 1, 23),
            prefix: 24,
            interface: "wlan0".into(),
        };
        let other = |ip: [u8; 4], interface: &str| Lan {
            ip: Ipv4Addr::from(ip),
            prefix: 24,
            interface: interface.into(),
        };
        let here = [other([192, 168, 1, 23], "wlan0")];
        assert!(same_network(&lan, &here, Some("home"), Some("home")));
        assert!(same_network(&lan, &here, None, None));
        // The same address from another Wi-Fi network (a café's router hands out the same range).
        assert!(!same_network(&lan, &here, Some("home"), Some("cafe")));
        // No answer from NetworkManager (restarting): unknown, not another network.
        assert!(same_network(&lan, &here, Some("home"), None));
        assert!(same_network(&lan, &here, None, Some("home")));
        // The address now on the cable, or gone.
        assert!(!same_network(
            &lan,
            &[other([192, 168, 1, 23], "eth0")],
            None,
            None
        ));
        assert!(!same_network(
            &lan,
            &[other([192, 168, 1, 40], "wlan0")],
            None,
            None
        ));
    }

    #[test]
    fn private_addresses() {
        for ip in [
            "10.1.2.3",
            "172.20.0.5",
            "192.168.0.9",
            "169.254.1.1",
            "100.80.1.1",
        ] {
            assert!(is_private(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "100.200.1.1", "172.40.0.1"] {
            assert!(!is_private(ip.parse().unwrap()), "{ip}");
        }
    }
}
