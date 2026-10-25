// SPDX-License-Identifier: GPL-3.0-or-later

//! The assistant's app tools: installed apps found by what they do, and what loads the computer now.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long CPU use is measured over, and how many apps each list names.
const SAMPLE: Duration = Duration::from_millis(500);
const MAX_LISTED: usize = 8;

/// Where desktop entries live: the system's, the user's, Flatpak's and Snap's.
fn app_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        "/usr/share/applications".into(),
        "/usr/local/share/applications".into(),
        home.join(".local/share/applications"),
        "/var/lib/flatpak/exports/share/applications".into(),
        home.join(".local/share/flatpak/exports/share/applications"),
        "/var/lib/snapd/desktop/applications".into(),
    ]
}

/// Letters and digits only, lowercased, so "photo editor" matches "Photo-Editor".
fn squash(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Installed apps whose name, kind, description or keywords contain any of `terms`.
pub fn find_apps(terms: &[String], home: &Path) -> String {
    let terms: Vec<String> = terms
        .iter()
        .map(|t| squash(t))
        .filter(|t| !t.is_empty())
        .collect();
    let mut found: Vec<(String, String)> = Vec::new();
    for dir in app_dirs(home) {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.path().extension().is_none_or(|e| e != "desktop") {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()) else {
                continue;
            };
            let Some(app) = DesktopEntry::parse(&text) else {
                continue;
            };
            let haystack = squash(&app.searchable);
            let matched = terms.iter().any(|term| haystack.contains(term.as_str()));
            if matched && !found.iter().any(|(name, _)| *name == app.name) {
                found.push((app.name, app.about));
            }
        }
    }
    found.sort();
    let mut text = format!("find_apps {terms:?}: {} found.", found.len());
    for (name, about) in found.iter().take(MAX_LISTED * 2) {
        text.push_str(&format!(
            "\n- {name}{}",
            if about.is_empty() {
                String::new()
            } else {
                format!(": {about}")
            }
        ));
    }
    text
}

struct DesktopEntry {
    name: String,
    about: String,
    searchable: String,
}

impl DesktopEntry {
    /// An app shown in the app grid, from its [Desktop Entry] group (any language's lines count).
    fn parse(text: &str) -> Option<Self> {
        let group = text.split("\n[").next()?;
        let field = |key: &str| {
            group
                .lines()
                .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
                .unwrap_or_default()
                .trim()
                .to_owned()
        };
        if field("Type") != "Application"
            || field("NoDisplay") == "true"
            || field("Hidden") == "true"
        {
            return None;
        }
        let searchable = group
            .lines()
            .filter(|line| {
                ["Name", "GenericName", "Comment", "Keywords"]
                    .iter()
                    .any(|key| line.starts_with(key))
            })
            .filter_map(|line| line.split_once('=').map(|(_, value)| value))
            .collect::<Vec<_>>()
            .join(" ");
        let about = [field("GenericName"), field("Comment")]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>();
        Some(Self {
            name: field("Name"),
            about: about.join(" — "),
            searchable,
        })
    }
}

/// Per process: its name, CPU time so far (clock ticks) and memory in use (bytes).
fn processes() -> HashMap<u32, (String, u64, u64)> {
    let mut all = HashMap::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return all;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        // The name is in parentheses and may hold spaces; the fields after it are plain.
        let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else {
            continue;
        };
        let name = stat[open + 1..close].to_owned();
        let fields: Vec<&str> = stat[close + 2..].split(' ').collect();
        let ticks = |i: usize| {
            fields
                .get(i)
                .and_then(|f| f.parse::<u64>().ok())
                .unwrap_or(0)
        };
        let cpu = ticks(11) + ticks(12);
        // In kB, so the memory page's size (4 KB, or 16 KB on some ARM machines) never matters.
        let rss = fs::read_to_string(entry.path().join("status"))
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find_map(|line| line.strip_prefix("VmRSS:"))
                    .and_then(|kb| kb.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
            })
            .unwrap_or(0)
            * 1024;
        all.insert(pid, (name, cpu, rss));
    }
    all
}

/// The apps using the most CPU (measured over half a second) and memory right now, by name.
pub fn top_processes() -> String {
    let before = processes();
    std::thread::sleep(SAMPLE);
    let after = processes();
    // Clock ticks per second are 100 on Linux; CPU use is per core, so 100% is one full core.
    let ticks = SAMPLE.as_secs_f64() * 100.0;
    let mut cpu: HashMap<String, f64> = HashMap::new();
    let mut memory: HashMap<String, u64> = HashMap::new();
    for (pid, (name, time, rss)) in &after {
        let used = before
            .get(pid)
            .map_or(0, |(_, then, _)| time.saturating_sub(*then));
        *cpu.entry(name.clone()).or_default() += used as f64 / ticks * 100.0;
        *memory.entry(name.clone()).or_default() += rss;
    }
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    let total: f64 = cpu.values().sum();
    let mut by_cpu: Vec<_> = cpu.into_iter().filter(|(_, used)| *used >= 1.0).collect();
    by_cpu.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut by_memory: Vec<_> = memory.into_iter().collect();
    by_memory.sort_by_key(|(_, rss)| std::cmp::Reverse(*rss));
    let mut text = format!(
        "top_processes: CPU {:.0}% of {cores} cores in use (100% = one core).\nBy CPU:",
        total
    );
    for (name, used) in by_cpu.iter().take(MAX_LISTED) {
        text.push_str(&format!("\n- {name}: {used:.0}%"));
    }
    text.push_str("\nBy memory:");
    for (name, rss) in by_memory.iter().take(MAX_LISTED) {
        text.push_str(&format!("\n- {name}: {} MB", rss >> 20));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_desktop_entries() {
        let viewer = "[Desktop Entry]\nType=Application\nName=Image Viewer\nName[id]=Penampil Citra\n\
                      Comment=Browse and rotate images\nKeywords=Picture;Photo;\n\n[Desktop Action new]\nName=New Window";
        let app = DesktopEntry::parse(viewer).unwrap();
        assert_eq!(
            (app.name.as_str(), app.about.as_str()),
            ("Image Viewer", "Browse and rotate images")
        );
        assert!(
            squash(&app.searchable).contains("photo")
                && squash(&app.searchable).contains("penampil")
        );
        assert!(!squash(&app.searchable).contains("newwindow"));
        assert!(
            DesktopEntry::parse("[Desktop Entry]\nType=Application\nName=X\nNoDisplay=true")
                .is_none()
        );
    }

    #[test]
    #[cfg(unix)]
    fn measures_the_busiest_apps() {
        let text = top_processes();
        assert!(
            text.starts_with("top_processes: CPU") && text.contains("By memory:\n- "),
            "{text}"
        );
    }
}
