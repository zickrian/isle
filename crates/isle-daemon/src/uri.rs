// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The local path a `file://` URI names (RFC 8089), its `%XX` escapes decoded.

use std::ffi::OsString;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

/// The `file://` URI of an absolute path, escaped as GLib's `g_filename_to_uri` escapes it.
pub fn from_path(path: &Path) -> String {
    let mut uri = String::from("file://");
    for &byte in path.as_os_str().as_bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/!$&'()*+,;=:@".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

/// The path of `file:///…`, `file://localhost/…` or `file:/…`; `None` for any other URI or host.
/// A query or fragment is not part of the path, so a `#` or `?` in a name must come escaped.
pub fn to_path(uri: &str) -> Option<PathBuf> {
    let scheme = uri.get(..5)?;
    if !scheme.eq_ignore_ascii_case("file:") {
        return None;
    }
    let rest = uri[5..].split(['?', '#']).next().unwrap_or_default();
    let path = match rest.strip_prefix("//") {
        Some(authority) => {
            let at = authority.find('/')?;
            let host = &authority[..at];
            if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
                return None;
            }
            &authority[at..]
        }
        None if rest.starts_with('/') => rest,
        None => return None,
    };
    let bytes = decode(path);
    // No path holds a NUL byte.
    if bytes.contains(&0) {
        return None;
    }
    Some(PathBuf::from(OsString::from_vec(bytes)))
}

/// Decodes `%XX` escapes into bytes; invalid escapes are kept as they are.
fn decode(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = match bytes.get(i..i + 3) {
            Some([b'%', high, low]) => hex_digit(*high).zip(hex_digit(*low)),
            _ => None,
        };
        match escaped {
            Some((high, low)) => {
                decoded.push(high << 4 | low);
                i += 3;
            }
            None => {
                decoded.push(bytes[i]);
                i += 1;
            }
        }
    }
    decoded
}

/// The value of one hex digit, either case.
fn hex_digit(byte: u8) -> Option<u8> {
    char::from(byte).to_digit(16).map(|digit| digit as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_round_trip() {
        let path = Path::new("/home/a/.local/share/isle/shelf/Foto 2 #1 100%.jpg");
        let uri = from_path(path);
        assert_eq!(
            uri,
            "file:///home/a/.local/share/isle/shelf/Foto%202%20%231%20100%25.jpg"
        );
        assert_eq!(to_path(&uri).as_deref(), Some(path));
        let odd = Path::new("/tmp/caf\u{e9}?.txt");
        assert_eq!(to_path(&from_path(odd)).as_deref(), Some(odd));
    }

    fn path(uri: &str) -> Option<String> {
        to_path(uri).map(|path| path.to_string_lossy().into_owned())
    }

    #[test]
    fn decodes_escaped_names() {
        assert_eq!(
            path("file:///home/me/My%20notes.txt").as_deref(),
            Some("/home/me/My notes.txt")
        );
        assert_eq!(
            path("file:///tmp/caf%C3%A9/%E6%97%A5%E6%9C%AC.png").as_deref(),
            Some("/tmp/café/日本.png")
        );
        // GLib leaves non-ASCII escaped, but a raw one is read all the same.
        assert_eq!(path("file:///tmp/café").as_deref(), Some("/tmp/café"));
        assert_eq!(
            path("file:///a/%23one%25%3Ftwo").as_deref(),
            Some("/a/#one%?two")
        );
    }

    #[test]
    fn a_raw_hash_or_question_mark_ends_the_path() {
        assert_eq!(path("file:///a/b#c").as_deref(), Some("/a/b"));
        assert_eq!(path("file:///a/b?c=d").as_deref(), Some("/a/b"));
    }

    #[test]
    fn invalid_escapes_stay_as_they_are() {
        assert_eq!(path("file:///a/100%zz%4").as_deref(), Some("/a/100%zz%4"));
    }

    #[test]
    fn only_local_files() {
        assert_eq!(path("file://localhost/a").as_deref(), Some("/a"));
        assert_eq!(path("FILE://LocalHost/a").as_deref(), Some("/a"));
        assert_eq!(path("file:/a").as_deref(), Some("/a"));
        assert_eq!(path("file://server/a"), None);
        assert_eq!(path("file://"), None);
        assert_eq!(path("file:a"), None);
        assert_eq!(path("https://example.com/a"), None);
        assert_eq!(path("/home/me/a"), None);
        assert_eq!(path("file:///a%00b"), None);
    }

    #[test]
    fn keeps_bytes_that_are_not_utf8() {
        let raw = to_path("file:///tmp/%FF").unwrap();
        assert_eq!(raw.into_os_string().into_vec(), b"/tmp/\xff");
    }
}
