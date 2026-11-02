// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! What phone sharing knows of files: safe names for what a phone sends, types, and how a file is offered.

use std::io;
use std::path::{Path, PathBuf};

/// The longest name a received file keeps, in bytes: Linux allows 255, and " 999" may be added.
const NAME_BYTES: usize = 200;
/// A name with nothing usable left.
const FALLBACK: &str = "File from phone";

/// A file name from a phone made safe to save: its last part only, no control, invisible or
/// direction-changing characters, no leading dots (no hidden files, no `..`), at most `NAME_BYTES` with
/// its extension kept.
pub fn sanitize(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !is_hidden(*c))
        .collect();
    let name = cleaned.trim().trim_start_matches('.').trim();
    if name.is_empty() {
        return FALLBACK.into();
    }
    if name.len() <= NAME_BYTES {
        return name.into();
    }
    // Long: the stem is cut on a character's edge, the extension (if a short one) kept.
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && ext.len() <= 16 => (stem, Some(ext)),
        _ => (name, None),
    };
    let room = NAME_BYTES - ext.map_or(0, |ext| ext.len() + 1);
    let mut cut = room.min(stem.len());
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    let stem = stem[..cut].trim_end();
    match ext {
        Some(ext) => format!("{stem}.{ext}"),
        None => stem.into(),
    }
}

/// Characters that reorder text on screen ("cod.exe" shown as "exe.doc"), take no room, or break lines.
fn is_hidden(c: char) -> bool {
    matches!(c, '\u{200b}' | '\u{200e}' | '\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'
        | '\u{2066}'..='\u{2069}' | '\u{061c}' | '\u{feff}')
}

/// `name`, or "name 2.ext", "name 3.ext"… for the `n`th try.
pub fn numbered(name: &str, n: u32) -> String {
    if n <= 1 {
        return name.into();
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} {n}.{ext}"),
        _ => format!("{name} {n}"),
    }
}

/// Gives the finished `temp` file its `name` in `dir`, numbered when taken; never replaces a file.
pub fn publish(temp: &Path, dir: &Path, name: &str) -> io::Result<PathBuf> {
    for n in 1..=999 {
        let target = dir.join(numbered(name, n));
        match rename_new(temp, &target) {
            Ok(()) => return Ok(target),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "too many files of that name",
    ))
}

/// Renames `from` to `to` unless `to` exists (RENAME_NOREPLACE); where the file system can't, a link
/// (which fails the same way) and an unlink.
fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let c =
        |path: &Path| std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(io::Error::other);
    let (old, new) = (c(from)?, c(to)?);
    // SAFETY: two valid C strings, paths relative to nothing (both absolute or to the working folder).
    let renamed = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            old.as_ptr(),
            libc::AT_FDCWD,
            new.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if renamed == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    if !matches!(
        err.raw_os_error(),
        Some(libc::EINVAL | libc::ENOSYS | libc::ENOTSUP)
    ) {
        return Err(err);
    }
    std::fs::hard_link(from, to)?;
    std::fs::remove_file(from)
}

/// The lower-case extension of `name`.
fn extension(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

/// The media type a file is sent with, by its extension.
pub fn content_type(name: &str) -> &'static str {
    match extension(name).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "json" => "application/json",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "7z" => "application/x-7z-compressed",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "odp" => "application/vnd.oasis.opendocument.presentation",
        _ => "application/octet-stream",
    }
}

/// What the phone page draws for a file: `image`, `video`, `audio`, `pdf`, `doc`, `archive` or `file`.
pub fn kind(name: &str) -> &'static str {
    let media = content_type(name);
    match media.split('/').next() {
        Some("image") => "image",
        Some("video") => "video",
        Some("audio") => "audio",
        _ if media == "application/pdf" => "pdf",
        _ if media.contains("zip") || media.contains("7z") => "archive",
        _ if media.starts_with("text/") || media.contains("document") || media.contains("ms-") => {
            "doc"
        }
        _ => "file",
    }
}

/// Pictures a browser may show in place: never SVG or HTML, which could run script in the page's origin.
pub fn shows_inline(name: &str) -> bool {
    matches!(
        extension(name).as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp"
    )
}

/// `Content-Disposition` for `name`: an ASCII fallback and the full name in UTF-8 (RFC 6266).
pub fn disposition(name: &str, inline: bool) -> String {
    let fallback: String = name
        .chars()
        .map(|c| {
            if (c.is_ascii_graphic() && c != '"' && c != '\\') || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "{}; filename=\"{fallback}\"; filename*=UTF-8''{}",
        if inline { "inline" } else { "attachment" },
        super::http::percent_encode(name)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_in_their_folder() {
        assert_eq!(sanitize("../../.ssh/authorized_keys"), "authorized_keys");
        assert_eq!(sanitize("..\\..\\boot.ini"), "boot.ini");
        assert_eq!(sanitize("/etc/passwd"), "passwd");
        assert_eq!(sanitize(".."), FALLBACK);
        assert_eq!(sanitize("."), FALLBACK);
        assert_eq!(sanitize(".bashrc"), "bashrc");
        assert_eq!(sanitize("photo.jpg/"), FALLBACK);
        assert_eq!(sanitize(""), FALLBACK);
        assert_eq!(sanitize("   "), FALLBACK);
    }

    #[test]
    fn names_lose_hidden_characters() {
        assert_eq!(sanitize("a\0b\nc\u{7f}.txt"), "abc.txt");
        assert_eq!(sanitize("invoice\u{202e}fdp.exe"), "invoicefdp.exe");
        assert_eq!(
            sanitize("a\u{200b}b\u{2028}c\u{2029}d\u{feff}.jpg"),
            "abcd.jpg"
        );
        assert_eq!(sanitize("\u{feff}.\u{200b}"), FALLBACK);
        assert_eq!(sanitize("IMG 2041.HEIC"), "IMG 2041.HEIC");
        assert_eq!(sanitize("Foto Liburan 🌴.jpg"), "Foto Liburan 🌴.jpg");
    }

    #[test]
    fn long_names_fit_linux() {
        let long = format!("{}.jpeg", "ä".repeat(300));
        let safe = sanitize(&long);
        assert!(
            safe.len() <= NAME_BYTES && safe.len() > NAME_BYTES - 4,
            "{}",
            safe.len()
        );
        assert!(safe.ends_with(".jpeg"));
        // 114 CJK characters are 342 bytes: cut on a character's edge, room left for " 999".
        let cjk = format!("{}.png", "写".repeat(114));
        let safe = sanitize(&cjk);
        assert!(safe.len() <= NAME_BYTES && safe.ends_with(".png"));
        assert!(numbered(&safe, 999).len() <= 255);
        let no_ext = "x".repeat(500);
        assert_eq!(sanitize(&no_ext).len(), NAME_BYTES);
    }

    #[test]
    fn a_long_cjk_name_lands_on_disk() {
        let dir = std::env::temp_dir().join(format!("isle-share-cjk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let temp = dir.join(".part");
        std::fs::write(&temp, b"x").unwrap();
        let name = sanitize(&format!("{}.png", "写".repeat(114)));
        let path = publish(&temp, &dir, &name).unwrap();
        assert!(path.exists());
        std::fs::write(&temp, b"y").unwrap();
        assert!(
            publish(&temp, &dir, &name)
                .unwrap()
                .ends_with(numbered(&name, 2))
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn taken_names_are_numbered() {
        assert_eq!(numbered("image.jpg", 1), "image.jpg");
        assert_eq!(numbered("image.jpg", 2), "image 2.jpg");
        assert_eq!(numbered("README", 3), "README 3");
        let dir = std::env::temp_dir().join(format!("isle-share-names-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("image.jpg"), b"old").unwrap();
        let temp = dir.join(".part");
        std::fs::write(&temp, b"new").unwrap();
        let path = publish(&temp, &dir, "image.jpg").unwrap();
        assert_eq!(path, dir.join("image 2.jpg"));
        assert_eq!(std::fs::read(dir.join("image.jpg")).unwrap(), b"old");
        assert!(!temp.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_plain_pictures_show_inline() {
        assert!(shows_inline("a.JPG"));
        assert!(!shows_inline("a.svg"));
        assert!(!shows_inline("a.html"));
        assert_eq!(content_type("page.html"), "application/octet-stream");
        assert_eq!(kind("IMG.HEIC"), "image");
        assert_eq!(kind("notes.docx"), "doc");
        assert_eq!(kind("x.zip"), "archive");
    }

    #[test]
    fn dispositions_quote_safely() {
        assert_eq!(
            disposition("a \"b\".pdf", false),
            "attachment; filename=\"a _b_.pdf\"; filename*=UTF-8''a%20%22b%22.pdf"
        );
        assert!(disposition("é.png", true).starts_with("inline; filename=\"_.png\""));
    }
}
