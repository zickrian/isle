// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! What isled and the helper say to each other, one JSON object a line: `{"ready", "device"}` once
//! the model is loaded, then for each request `{"audio": path}` a `{"text"}` or an `{"error"}`.

use std::path::PathBuf;

use serde_json::{Value, json};

/// The recording a request names: raw 16 kHz mono s16le, in a private file isled removes after.
pub fn request(line: &str) -> Result<PathBuf, String> {
    let message: Value = serde_json::from_str(line).map_err(|err| format!("bad request: {err}"))?;
    message["audio"]
        .as_str()
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "bad request: no audio".to_owned())
}

/// Little-endian 16-bit samples as Whisper takes them, from -1 to 1. An odd last byte is dropped.
pub fn samples(bytes: &[u8]) -> Vec<f32> {
    let (pairs, _) = bytes.as_chunks::<2>();
    pairs
        .iter()
        .map(|&pair| f32::from(i16::from_le_bytes(pair)) / 32768.0)
        .collect()
}

/// Sent once the model is loaded, naming the device it runs on.
pub fn ready(device: &str) -> String {
    json!({"ready": true, "device": device}).to_string()
}

/// A request's transcript, with how much speech it had and what was not counted as said (isled logs
/// them when no words came).
pub fn text(heard: &crate::speech::Heard) -> String {
    let dropped: Vec<_> = heard
        .dropped
        .iter()
        .map(|(text, no_speech)| json!({"text": text, "no_speech": no_speech}))
        .collect();
    json!({"text": heard.text, "speech_ms": heard.speech_ms, "dropped": dropped}).to_string()
}

/// Why a request or the start failed.
pub fn error(error: &str) -> String {
    json!({"error": error}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_audio_path() {
        let path = request(r#"{"audio": "/run/user/1000/isle-voice-7.pcm"}"#).unwrap();
        assert_eq!(path, PathBuf::from("/run/user/1000/isle-voice-7.pcm"));
    }

    #[test]
    fn refuses_a_request_without_audio() {
        assert!(request("{}").is_err());
        assert!(request(r#"{"audio": ""}"#).is_err());
        assert!(request(r#"{"audio": 3}"#).is_err());
        assert!(request("not json").is_err());
    }

    #[test]
    fn scales_samples() {
        let bytes = [0x00, 0x80, 0x00, 0x00, 0xff, 0x7f, 0x01];
        assert_eq!(samples(&bytes), vec![-1.0, 0.0, 32767.0 / 32768.0]);
    }

    #[test]
    fn answers_one_line_of_json() {
        let ready: Value = serde_json::from_str(&ready("cpu")).unwrap();
        assert_eq!(ready, json!({"ready": true, "device": "cpu"}));
        let heard = |text: &str| crate::speech::Heard {
            text: text.into(),
            speech_ms: 1500,
            dropped: vec![("Terima kasih.".into(), 0.75)],
        };
        let said: Value = serde_json::from_str(&text(&heard("buka \"Files\""))).unwrap();
        assert_eq!(said["text"], "buka \"Files\"");
        assert_eq!(said["speech_ms"], 1500);
        assert_eq!(said["dropped"][0]["text"], "Terima kasih.");
        assert_eq!(
            error("model small not downloaded"),
            r#"{"error":"model small not downloaded"}"#
        );
        assert!(!text(&heard("a\nb")).contains('\n'));
    }
}
