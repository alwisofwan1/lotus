//! Enumerates the addresses the host runtime may bind to, classified by who can
//! reach them.
//!
//! Exists because a free-text bind address is a footgun with two sharp edges:
//! `0.0.0.0` exposes the machine to every network it is attached to, and a typo
//! silently falls back to loopback, producing the "I paired but my phone cannot
//! connect" dead end. Offering only addresses that actually exist, each labelled
//! with its blast radius, removes both.

use std::net::{IpAddr, Ipv4Addr};

use serde::{Deserialize, Serialize};

/// Who can reach an address. Ordered by how far it reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reach {
    /// Only this machine.
    Loopback,
    /// Devices on the operator's tailnet (Tailscale's 100.64.0.0/10 range).
    Tailnet,
    /// Anything on the local network — a shared office Wi-Fi included.
    Lan,
    /// Routable from the internet. Never offered as a default.
    Public,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindCandidate {
    /// Interface name as the OS reports it, e.g. `en0`, `utun4`.
    pub interface: String,
    pub address: String,
    pub reach: Reach,
    /// True for the address the operator should pick unless they know better.
    pub recommended: bool,
}

/// The wildcard address, refused everywhere in this module.
const WILDCARD_V4: &str = "0.0.0.0";
const WILDCARD_V6: &str = "::";

/// Classifies an already-parsed address.
pub fn classify(ip: IpAddr) -> Reach {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        // Link-local (fe80::/10) is LAN-scoped; unique-local (fc00::/7) is a
        // private site. Everything else routable is treated as public.
        IpAddr::V6(v6) if v6.is_loopback() => Reach::Loopback,
        IpAddr::V6(v6) => {
            let seg = v6.segments()[0];
            if (seg & 0xffc0) == 0xfe80 || (seg & 0xfe00) == 0xfc00 {
                Reach::Lan
            } else {
                Reach::Public
            }
        }
    }
}

fn classify_v4(v4: Ipv4Addr) -> Reach {
    if v4.is_loopback() {
        return Reach::Loopback;
    }
    let [a, b, ..] = v4.octets();
    // Tailscale hands out CGNAT space, 100.64.0.0/10.
    if a == 100 && (64..128).contains(&b) {
        return Reach::Tailnet;
    }
    if v4.is_private() || v4.is_link_local() {
        return Reach::Lan;
    }
    Reach::Public
}

/// Rejects the wildcard and anything that is not a literal address.
///
/// Hostnames are refused on purpose: the picker offers concrete addresses, so a
/// hostname here means the operator hand-edited the file, and a name that
/// resolves differently later would change the blast radius without warning.
pub fn validate_bind_host(host: &str) -> Result<IpAddr, String> {
    let trimmed = host.trim().trim_start_matches('[').trim_end_matches(']');
    if trimmed == WILDCARD_V4 || trimmed == WILDCARD_V6 {
        return Err(
            "0.0.0.0 binds every interface, which exposes this machine to every network it \
             is attached to. Pick a specific address instead."
                .into(),
        );
    }
    trimmed
        .parse::<IpAddr>()
        .map_err(|_| format!("`{host}` is not an IP address. Pick one of the listed interfaces."))
}

/// Reads this machine's interfaces and returns the pickable candidates.
///
/// Separated from `candidates` so the classification and ordering stay unit
/// testable without depending on whatever interfaces the test host happens to
/// have.
pub fn enumerate() -> Vec<BindCandidate> {
    let found: Vec<(String, IpAddr)> = match if_addrs::get_if_addrs() {
        Ok(list) => list.into_iter().map(|i| (i.name, i.addr.ip())).collect(),
        Err(_) => Vec::new(),
    };
    candidates(&found)
}

/// Candidates for the picker, most-recommended first.
///
/// The tailnet address is recommended when present because it is the only one
/// that reaches a phone without also reaching everyone on the café Wi-Fi.
pub fn candidates(interfaces: &[(String, IpAddr)]) -> Vec<BindCandidate> {
    let has_tailnet = interfaces
        .iter()
        .any(|(_, ip)| classify(*ip) == Reach::Tailnet);

    let mut out: Vec<BindCandidate> = interfaces
        .iter()
        .filter(|(_, ip)| {
            let s = ip.to_string();
            s != WILDCARD_V4 && s != WILDCARD_V6
        })
        .map(|(name, ip)| {
            let reach = classify(*ip);
            BindCandidate {
                interface: name.clone(),
                address: ip.to_string(),
                reach,
                recommended: match reach {
                    Reach::Tailnet => true,
                    Reach::Loopback => !has_tailnet,
                    _ => false,
                },
            }
        })
        .collect();

    out.sort_by_key(|c| match c.reach {
        Reach::Tailnet => 0,
        Reach::Loopback => 1,
        Reach::Lan => 2,
        Reach::Public => 3,
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn classifies_reach_by_range() {
        assert_eq!(classify(ip("127.0.0.1")), Reach::Loopback);
        assert_eq!(classify(ip("::1")), Reach::Loopback);
        assert_eq!(classify(ip("100.64.0.2")), Reach::Tailnet);
        assert_eq!(classify(ip("100.127.255.254")), Reach::Tailnet);
        assert_eq!(classify(ip("192.168.1.42")), Reach::Lan);
        assert_eq!(classify(ip("10.0.0.7")), Reach::Lan);
        assert_eq!(classify(ip("169.254.1.1")), Reach::Lan);
        assert_eq!(classify(ip("fe80::1")), Reach::Lan);
        assert_eq!(classify(ip("93.184.216.34")), Reach::Public);
    }

    /// 100.64/10 is CGNAT, not private space — a naive `is_private()` check
    /// would file Tailscale addresses as public and warn about the safest option.
    #[test]
    fn tailnet_range_is_not_mistaken_for_public() {
        assert_eq!(classify(ip("100.63.255.255")), Reach::Public);
        assert_eq!(classify(ip("100.64.0.0")), Reach::Tailnet);
        assert_eq!(classify(ip("100.128.0.1")), Reach::Public);
    }

    #[test]
    fn refuses_the_wildcard_with_a_reason_the_operator_can_act_on() {
        for wildcard in ["0.0.0.0", "::", "[::]"] {
            let err = validate_bind_host(wildcard).unwrap_err();
            assert!(err.contains("exposes this machine"), "{wildcard}: {err}");
        }
    }

    #[test]
    fn refuses_a_hostname() {
        assert!(validate_bind_host("my-mac.ts.net").is_err());
    }

    #[test]
    fn accepts_a_literal_address_in_either_family() {
        assert_eq!(validate_bind_host("100.64.0.2").unwrap(), ip("100.64.0.2"));
        assert_eq!(validate_bind_host("[::1]").unwrap(), ip("::1"));
    }

    #[test]
    fn recommends_the_tailnet_address_when_one_exists() {
        let list = candidates(&[
            ("lo0".into(), ip("127.0.0.1")),
            ("en0".into(), ip("192.168.1.42")),
            ("utun4".into(), ip("100.64.0.2")),
        ]);

        assert_eq!(list[0].address, "100.64.0.2");
        assert!(list[0].recommended);
        assert!(!list
            .iter()
            .any(|c| c.reach == Reach::Loopback && c.recommended));
    }

    /// With no tailnet, loopback is the honest recommendation: it does not work
    /// from a phone, and saying so beats nudging the operator onto shared Wi-Fi.
    #[test]
    fn recommends_loopback_when_there_is_no_tailnet() {
        let list = candidates(&[
            ("en0".into(), ip("192.168.1.42")),
            ("lo0".into(), ip("127.0.0.1")),
        ]);

        let loopback = list.iter().find(|c| c.reach == Reach::Loopback).unwrap();
        assert!(loopback.recommended);
        assert!(!list.iter().any(|c| c.reach == Reach::Lan && c.recommended));
    }

    #[test]
    fn never_offers_the_wildcard_even_if_the_os_reports_it() {
        let list = candidates(&[
            ("any".into(), ip("0.0.0.0")),
            ("lo0".into(), ip("127.0.0.1")),
        ]);

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].address, "127.0.0.1");
    }

    /// Exercises the real OS enumeration, not just the pure classifier. Every
    /// machine has a loopback interface, so that is a safe invariant to assert;
    /// anything beyond it varies by host and is deliberately not asserted.
    #[test]
    fn enumerate_reads_this_machine_and_always_finds_loopback() {
        let list = enumerate();

        assert!(
            list.iter().any(|c| c.reach == Reach::Loopback),
            "expected a loopback candidate, got {list:?}"
        );
        assert!(
            !list
                .iter()
                .any(|c| c.address == "0.0.0.0" || c.address == "::"),
            "the wildcard must never survive enumeration: {list:?}"
        );
        assert_eq!(
            list.iter().filter(|c| c.recommended).count().min(1),
            1,
            "at least one candidate must be recommended"
        );
    }

    #[test]
    fn orders_candidates_from_narrowest_reach_outward() {
        let list = candidates(&[
            ("x".into(), ip("93.184.216.34")),
            ("en0".into(), ip("192.168.1.42")),
            ("lo0".into(), ip("127.0.0.1")),
            ("utun4".into(), ip("100.64.0.2")),
        ]);

        let reaches: Vec<_> = list.iter().map(|c| c.reach).collect();
        assert_eq!(
            reaches,
            vec![Reach::Tailnet, Reach::Loopback, Reach::Lan, Reach::Public]
        );
    }
}
