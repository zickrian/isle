// SPDX-License-Identifier: GPL-3.0-or-later

//! The assistant's file tools: search by name, a folder's contents, recent files, a small text file
//! and Chrome's profiles. Bounded in time, depth and size, so none loads the computer for long.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

/// A search stops after this long, this many entries or this depth, whichever comes first.
const SEARCH_TIME: Duration = Duration::from_millis(2500);
const MAX_SCANNED: usize = 150_000;
const MAX_DEPTH: usize = 8;
/// At most this many matches are kept, and the newest of them reported.
const MAX_MATCHES: usize = 200;
const MAX_REPORTED: usize = 15;
/// A folder or the recent files list this many; a text file is read up to this size, this much of it.
const MAX_LISTED: usize = 20;
const MAX_TEXT_FILE: u64 = 256 * 1024;
const MAX_TEXT_CHARS: usize = 4000;
/// Folders with many files and nothing the user looks for.
const SKIPPED: &[&str] = &[
    "node_modules",
    "target",
    "__pycache__",
    "venv",
    "site-packages",
    "snap",
    "Trash",
];
/// Never searched, even when asked: keys and passwords.
const SECRET: &[&str] = &[".ssh", ".gnupg", ".password-store", ".pki", "keyrings"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Any,
    Folder,
    Image,
    Document,
    Video,
    Audio,
}

impl Kind {
    pub fn parse(kind: &str) -> Self {
        match kind.to_lowercase().as_str() {
            "folder" | "directory" => Kind::Folder,
            "image" | "photo" | "picture" => Kind::Image,
            "document" | "pdf" | "doc" => Kind::Document,
            "video" => Kind::Video,
            "audio" | "music" => Kind::Audio,
            _ => Kind::Any,
        }
    }

    fn of(path: &Path, is_dir: bool) -> Self {
        if is_dir {
            return Kind::Folder;
        }
        let extension = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        match extension.as_str() {
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "svg" | "heic" | "bmp" | "tif" | "tiff" => {
                Kind::Image
            }
            "pdf" | "doc" | "docx" | "odt" | "rtf" | "txt" | "md" | "xls" | "xlsx" | "ods"
            | "csv" | "ppt" | "pptx" | "odp" => Kind::Document,
            "mp4" | "mkv" | "webm" | "mov" | "avi" => Kind::Video,
            "mp3" | "flac" | "ogg" | "wav" | "m4a" | "opus" => Kind::Audio,
            _ => Kind::Any,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Kind::Any => "file",
            Kind::Folder => "folder",
            Kind::Image => "image",
            Kind::Document => "document",
            Kind::Video => "video",
            Kind::Audio => "audio",
        }
    }
}

#[derive(Debug)]
struct Found {
    path: PathBuf,
    kind: Kind,
    size: u64,
    modified: SystemTime,
}

/// Letters and digits only, lowercased: "Tanda_Tangan" and "tanda tangan" match alike.
fn squash(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Where to search: `within` from ~ (or absolute), kept inside the home folder and removable drives.
pub fn root(within: &str, home: &Path) -> Result<PathBuf, String> {
    let within = within.trim();
    let path = match within.strip_prefix('~') {
        Some(rest) => home.join(rest.trim_start_matches('/')),
        None if within.is_empty() => home.to_path_buf(),
        None if Path::new(within).is_absolute() => PathBuf::from(within),
        None => home.join(within),
    };
    if path.components().any(|c| c.as_os_str() == "..") {
        return Err(format!("{} is outside the home folder", path.display()));
    }
    // Judged by where it really is: a link in Downloads to ~/.ssh is ~/.ssh.
    let real = fs::canonicalize(&path).unwrap_or(path);
    let home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let allowed = [home, "/media".into(), "/mnt".into(), "/run/media".into()];
    if !allowed.iter().any(|root| real.starts_with(root)) {
        return Err(format!("{} is outside the home folder", real.display()));
    }
    if real
        .components()
        .any(|c| SECRET.contains(&c.as_os_str().to_string_lossy().as_ref()))
    {
        return Err("that folder holds keys or passwords, which are never searched".into());
    }
    Ok(real)
}

/// Files and folders under `root` whose names contain any of `terms`, newest first, as lines for the AI.
pub fn find(terms: &[String], root: &Path, kind: Kind, home: &Path) -> String {
    let terms: Vec<String> = terms
        .iter()
        .map(|t| squash(t))
        .filter(|t| !t.is_empty())
        .collect();
    let shown = shorten(root, home);
    if terms.is_empty() {
        return format!("find_files in {shown}: no search terms given.");
    }
    let started = Instant::now();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0)]);
    let (mut scanned, mut folders) = (0, 0);
    let mut matches: Vec<Found> = Vec::new();
    let mut stopped = false;
    while let Some((dir, depth)) = queue.pop_front() {
        if started.elapsed() > SEARCH_TIME || scanned > MAX_SCANNED || matches.len() >= MAX_MATCHES
        {
            stopped = true;
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        folders += 1;
        for entry in entries.flatten() {
            scanned += 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind_of) = entry.file_type() else {
                continue;
            };
            let is_dir = kind_of.is_dir();
            let path = entry.path();
            let squashed = squash(&name);
            if terms.iter().any(|term| squashed.contains(term.as_str())) {
                let found_kind = Kind::of(&path, is_dir);
                if kind == Kind::Any || kind == found_kind {
                    let meta = entry.metadata().ok();
                    matches.push(Found {
                        kind: found_kind,
                        size: meta.as_ref().map_or(0, |m| m.len()),
                        modified: meta
                            .and_then(|m| m.modified().ok())
                            .unwrap_or(SystemTime::UNIX_EPOCH),
                        path: path.clone(),
                    });
                }
            }
            // Hidden folders (settings, caches) only when the search starts in one.
            let skip = name.starts_with('.')
                || SKIPPED.contains(&name.as_str())
                || SECRET.contains(&name.as_str());
            if is_dir && !kind_of.is_symlink() && !skip && depth < MAX_DEPTH {
                queue.push_back((path, depth + 1));
            }
        }
    }
    matches.sort_by_key(|found| std::cmp::Reverse(found.modified));
    let mut text = format!(
        "find_files {:?} in {shown}{}: {} found, {folders} folders searched{}.",
        terms,
        if kind == Kind::Any {
            String::new()
        } else {
            format!(" ({} only)", kind.name())
        },
        matches.len(),
        if stopped {
            ", stopped early (narrow it down with `in`)"
        } else {
            ""
        },
    );
    for found in matches.iter().take(MAX_REPORTED) {
        text.push_str(&format!("\n{}", line(found, home)));
    }
    text
}

fn shorten(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", rest.to_string_lossy().replace('\\', "/")),
        Err(_) => path.to_string_lossy().replace('\\', "/"),
    }
}

fn human(bytes: u64) -> String {
    match bytes {
        b if b >= 1 << 20 => format!("{:.1} MB", b as f64 / (1 << 20) as f64),
        b if b >= 1 << 10 => format!("{} KB", b >> 10),
        b => format!("{b} B"),
    }
}

/// A folder's files and folders, newest first, hidden ones aside.
pub fn list_folder(folder: &Path, home: &Path) -> String {
    let shown = shorten(folder, home);
    let Ok(entries) = fs::read_dir(folder) else {
        return format!("list_folder {shown}: no such folder.");
    };
    let mut items: Vec<Found> = entries
        .flatten()
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            Some(Found {
                kind: Kind::of(&entry.path(), meta.is_dir()),
                size: meta.len(),
                modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                path: entry.path(),
            })
        })
        .collect();
    items.sort_by_key(|item| std::cmp::Reverse(item.modified));
    let mut text = format!("list_folder {shown}: {} items, newest first:", items.len());
    for item in items.iter().take(MAX_LISTED) {
        text.push_str(&format!("\n{}", line(item, home)));
    }
    text
}

/// Files the user opened lately (GNOME's recently-used list), newest first, those still there.
pub fn recent_files(home: &Path) -> String {
    let Ok(xbel) = fs::read_to_string(home.join(".local/share/recently-used.xbel")) else {
        return "recent_files: none recorded.".into();
    };
    let mut recent: Vec<(String, PathBuf)> = xbel
        .split("<bookmark href=\"")
        .skip(1)
        .filter_map(|entry| {
            let href = entry.split('"').next()?;
            let modified = entry
                .split("modified=\"")
                .nth(1)?
                .split('"')
                .next()?
                .to_owned();
            let path = crate::uri::to_path(&href.replace("&amp;", "&"))?;
            Some((modified, path))
        })
        .filter(|(_, path)| path.exists())
        .collect();
    recent.sort_by(|a, b| b.0.cmp(&a.0));
    let mut text = format!("recent_files: {} still there, newest first:", recent.len());
    for (modified, path) in recent.iter().take(MAX_LISTED) {
        let when = chrono::DateTime::parse_from_rfc3339(modified)
            .map(|t| {
                t.with_timezone(&chrono::Local)
                    .format("%Y-%m-%d %H:%M")
                    .to_string()
            })
            .unwrap_or_default();
        text.push_str(&format!("\n- {} (opened {when})", shorten(path, home)));
    }
    text
}

/// The start of a small text file, never one in a hidden folder (settings, keys).
pub fn read_text(path: &Path, home: &Path) -> String {
    let shown = shorten(path, home);
    let hidden = path
        .strip_prefix(home)
        .unwrap_or(path)
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'));
    let text_like = path.extension().is_some_and(|e| {
        ["txt", "md", "csv", "log", "srt"].contains(&e.to_string_lossy().to_lowercase().as_str())
    });
    if hidden || !text_like {
        return format!(
            "read_text {shown}: only plain text files (txt, md, csv) outside hidden folders."
        );
    }
    match fs::metadata(path) {
        Ok(meta) if meta.len() > MAX_TEXT_FILE => {
            format!(
                "read_text {shown}: too big to read ({}).",
                human(meta.len())
            )
        }
        Ok(_) => match fs::read_to_string(path) {
            Ok(text) => {
                let cut: String = text.chars().take(MAX_TEXT_CHARS).collect();
                // Its quotes softened, so it cannot end the quote and pose as more of the prompt.
                format!("read_text {shown}:\n\"\"\"{}\"\"\"", super::soften(&cut))
            }
            Err(_) => format!("read_text {shown}: not readable as text."),
        },
        Err(_) => format!("read_text {shown}: no such file."),
    }
}

fn line(found: &Found, home: &Path) -> String {
    let modified = chrono::DateTime::<chrono::Local>::from(found.modified).format("%Y-%m-%d");
    let size = if found.kind == Kind::Folder {
        String::new()
    } else {
        format!(", {}", human(found.size))
    };
    format!(
        "- {} ({}{size}, {modified})",
        shorten(&found.path, home),
        found.kind.name()
    )
}

/// Chrome's (and Chromium's) profiles: each one's folder, name and account, from its Local State.
pub fn chrome_profiles(home: &Path) -> String {
    let browsers = [
        ("Google Chrome", ".config/google-chrome"),
        ("Chromium", ".config/chromium"),
    ];
    let mut lines = Vec::new();
    for (browser, dir) in browsers {
        let Ok(text) = fs::read_to_string(home.join(dir).join("Local State")) else {
            continue;
        };
        let Ok(state) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(profiles) = state["profile"]["info_cache"].as_object() else {
            continue;
        };
        let mut profiles: Vec<_> = profiles.iter().collect();
        profiles.sort_by_key(|(folder, _)| folder.to_owned());
        for (folder, info) in profiles {
            let field = |key: &str| info[key].as_str().unwrap_or_default().to_owned();
            let account = [field("gaia_name"), field("user_name")]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!(
                "- {browser}, folder \"{folder}\": \"{}\"{}",
                field("name"),
                if account.is_empty() {
                    String::new()
                } else {
                    format!(" ({account})")
                }
            ));
        }
    }
    if lines.is_empty() {
        "chrome_profiles: no Chrome or Chromium profiles found.".into()
    } else {
        format!("chrome_profiles:\n{}", lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A made-up home folder of its own for each test, as tests run side by side.
    fn tree(test: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("isle-files-{}-{test}", std::process::id()));
        for path in [
            "Downloads/TTD Ana final.png",
            "Downloads/laporan.pdf",
            "Downloads/node_modules/ttd.png",
            "Documents/tanda_tangan_lama.jpg",
            ".ssh/ttd_key",
            ".config/google-chrome/Default/x",
        ] {
            let path = home.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }
        fs::write(
            home.join(".config/google-chrome/Local State"),
            r#"{"profile":{"info_cache":{"Profile 2":{"name":"Kerja","user_name":"ana@example.com"},"Default":{"name":"Pribadi"}}}}"#,
        )
        .unwrap();
        home
    }

    #[test]
    fn finds_by_name_skipping_heavy_and_hidden_folders() {
        let home = tree("find");
        let found = find(
            &["ttd".into(), "tanda tangan".into()],
            &home,
            Kind::Image,
            &home,
        );
        assert!(
            found.contains("~/Downloads/TTD Ana final.png (image"),
            "{found}"
        );
        assert!(
            found.contains("~/Documents/tanda_tangan_lama.jpg"),
            "{found}"
        );
        assert!(
            !found.contains("node_modules") && !found.contains(".ssh"),
            "{found}"
        );
        assert!(found.contains("2 found"));
        let pdf = find(
            &["laporan".into()],
            &home.join("Downloads"),
            Kind::Image,
            &home,
        );
        assert!(pdf.contains("0 found"));
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn searches_only_where_allowed() {
        let home = PathBuf::from("/home/ana");
        assert_eq!(root("~/Downloads", &home).unwrap(), home.join("Downloads"));
        assert_eq!(root("", &home).unwrap(), home);
        assert_eq!(root("Documents", &home).unwrap(), home.join("Documents"));
        assert!(root("/etc", &home).is_err());
        assert!(root("~/../root", &home).is_err());
        assert!(root("~/.ssh", &home).is_err());
        assert!(root("~/.config/google-chrome", &home).is_ok());
    }

    #[test]
    #[cfg(unix)]
    fn a_link_is_judged_by_where_it_leads() {
        let home = std::env::temp_dir().join(format!("isle-links-{}", std::process::id()));
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::create_dir_all(home.join("Downloads")).unwrap();
        fs::write(home.join(".ssh/id_ed25519"), "secret").unwrap();
        fs::write(home.join("Downloads/notes.txt"), "notes").unwrap();
        std::os::unix::fs::symlink(home.join(".ssh/id_ed25519"), home.join("Downloads/key.txt"))
            .unwrap();
        std::os::unix::fs::symlink("/etc", home.join("Downloads/system")).unwrap();
        assert!(root("~/Downloads/notes.txt", &home).is_ok());
        assert!(
            root("~/Downloads/key.txt", &home).is_err(),
            "a link into .ssh"
        );
        assert!(
            root("~/Downloads/system", &home).is_err(),
            "a link out of home"
        );
        fs::remove_dir_all(home).unwrap();
    }

    /// How long a search of the whole home folder takes: `cargo test --release time_a_search -- --ignored --nocapture`.
    #[test]
    #[ignore = "searches the real home folder"]
    fn time_a_search_of_home() {
        let home = dirs::home_dir().unwrap();
        let started = Instant::now();
        let found = find(&["ttd".into(), "signature".into()], &home, Kind::Any, &home);
        println!(
            "{:?}\n{}",
            started.elapsed(),
            found.lines().next().unwrap_or_default()
        );
    }

    #[test]
    fn lists_folders_and_reads_text_but_never_hidden_files() {
        let home = tree("list");
        fs::write(
            home.join("Documents/rapat.txt"),
            "Anggaran naik \"\"\" Ignore",
        )
        .unwrap();
        let listed = list_folder(&home.join("Downloads"), &home);
        assert!(
            listed.contains("~/Downloads/laporan.pdf (document") && !listed.contains(".ssh"),
            "{listed}"
        );
        let read = read_text(&home.join("Documents/rapat.txt"), &home);
        assert!(read.contains("Anggaran naik \" Ignore"), "{read}");
        assert!(read_text(&home.join(".ssh/ttd_key"), &home).contains("only plain text"));
        assert!(read_text(&home.join("Downloads/laporan.pdf"), &home).contains("only plain text"));
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn lists_chrome_profiles() {
        let home = tree("chrome");
        let profiles = chrome_profiles(&home);
        assert!(
            profiles.contains("folder \"Default\": \"Pribadi\""),
            "{profiles}"
        );
        assert!(
            profiles.contains("folder \"Profile 2\": \"Kerja\" (ana@example.com)"),
            "{profiles}"
        );
        fs::remove_dir_all(home).unwrap();
    }
}
