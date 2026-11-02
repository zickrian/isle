// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Speech to text with whisper.cpp: Silero finds where someone speaks, Whisper writes it down in
//! the language it sounds most like among those allowed, and phrases made up from noise are dropped.

use std::path::Path;

use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
    WhisperVadContext, WhisperVadContextParams, WhisperVadParams,
};

use whisper_rs::whisper_rs_sys as sys;

use crate::gpu::Gpu;

const SAMPLE_RATE: usize = 16_000;
/// Whisper skips anything shorter than a second, so a short "yes" is padded to this.
const MIN_SAMPLES: usize = SAMPLE_RATE * 3 / 2;

/// Phrases Whisper makes up from noise (it learnt them from video subtitles).
const HALLUCINATIONS: [&str; 8] = [
    "terima kasih",
    "thank you",
    "thanks for watching",
    "terima kasih kerana menonton",
    "terima kasih telah menonton",
    "sampai jumpa",
    "subtitle",
    "selamat menonton",
];

/// Whisper hears Indonesian as Malay at times; both mean Indonesian here.
const ALIASES: [(&str, &str); 1] = [("ms", "id")];

/// Whether a segment was really said. Noise has a high no-speech score (~0.9) and real speech a
/// low one (~0.02); a usual made-up phrase must sound clearly like speech to count.
pub fn heard(text: &str, no_speech: f32) -> bool {
    let words = text.trim().to_lowercase();
    let words = words.trim_matches(['.', '!', '?', ',']);
    let made_up = HALLUCINATIONS
        .iter()
        .any(|phrase| words.starts_with(phrase));
    no_speech < if made_up { 0.2 } else { 0.5 }
}

/// The languages a setting allows: "id,en" is either, "id" only that, "" any.
pub fn allowed(language: &str) -> Vec<&str> {
    language
        .split(',')
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .collect()
}

/// The language a detected code counts as, per [`ALIASES`].
fn alias(code: &str) -> &str {
    ALIASES
        .iter()
        .find(|(from, _)| *from == code)
        .map_or(code, |(_, to)| to)
}

/// Of the allowed languages, the one the speech sounds most like, given each language's
/// probability; the first allowed wins a tie.
pub fn likeliest<'a>(allowed: &[&'a str], probabilities: &[(&str, f32)]) -> Option<&'a str> {
    let score = |code: &str| -> f32 {
        probabilities
            .iter()
            .filter(|(language, _)| alias(language) == code)
            .map(|(_, p)| p)
            .sum()
    };
    let mut best: Option<(&str, f32)> = None;
    for &code in allowed {
        let p = score(code);
        if best.is_none_or(|(_, top)| p > top) {
            best = Some((code, p));
        }
    }
    best.map(|(code, _)| code)
}

/// Encoder frames for language detection: the speech plus a second, far quicker than the 30 s
/// window. Transcribing still needs the whole window, or Whisper repeats itself on a short clip.
pub fn detection_frames(samples: usize) -> i32 {
    // The encoder takes 50 frames a second.
    (samples / 320 + 64).min(1500) as i32
}

/// Only the stretches with speech (in centiseconds, as Silero gives them), joined, and padded
/// with silence to the shortest Whisper hears.
pub fn speech_only(samples: &[f32], stretches: &[(f32, f32)]) -> Vec<f32> {
    // A float to integer cast saturates, so a stretch "to the end" (f32::MAX) is safe.
    let at = |cs: f32| ((cs.max(0.0) / 100.0 * SAMPLE_RATE as f32) as usize).min(samples.len());
    let mut speech: Vec<f32> = stretches
        .iter()
        .flat_map(|&(start, end)| &samples[at(start)..at(end).max(at(start))])
        .copied()
        .collect();
    if !speech.is_empty() && speech.len() < MIN_SAMPLES {
        speech.resize(MIN_SAMPLES, 0.0);
    }
    speech
}

/// What a recording held: the words, how much of it was speech, and the segments not counted as said.
#[derive(Debug, Default, PartialEq)]
pub struct Heard {
    pub text: String,
    pub speech_ms: usize,
    /// Each as (text, no-speech score), for isled's log when no words came of it.
    pub dropped: Vec<(String, f32)>,
}

/// A loaded Whisper model, with Silero when its file is there.
pub struct Model {
    state: WhisperState,
    vad: Option<WhisperVadContext>,
    threads: i32,
}

impl Model {
    /// Loads `name` from `dir`, onto `gpu` if one is given.
    pub fn load(dir: &Path, name: &str, gpu: Option<&Gpu>, threads: i32) -> Result<Self, String> {
        let file = isle_core::speech::model_file(name)
            .ok_or_else(|| format!("unknown speech model {name}"))?;
        let path = dir.join(file);
        if !path.is_file() {
            // isled matches "not downloaded" to tell the user to run isle-setup-voice.
            return Err(format!("model {name} not downloaded"));
        }
        let params = WhisperContextParameters {
            use_gpu: gpu.is_some(),
            gpu_device: gpu.map_or(0, |gpu| gpu.index),
            // Faster on a GPU; on the processor it only helps big models.
            flash_attn: gpu.is_some(),
            ..WhisperContextParameters::default()
        };
        let context = WhisperContext::new_with_params(&path, params)
            .map_err(|err| format!("could not load the speech model: {err}"))?;
        let state = context
            .create_state()
            .map_err(|err| format!("could not load the speech model: {err}"))?;
        let vad = dir.join(isle_core::speech::VAD_FILE);
        // Without it (an older download) Whisper hears everything, as whisper.cpp does by default.
        let vad = vad.is_file().then(|| {
            let mut params = WhisperVadContextParams::new();
            params.set_n_threads(threads.min(4));
            params.set_use_gpu(false);
            WhisperVadContext::new(&vad.to_string_lossy(), params).ok()
        });
        Ok(Self {
            state,
            vad: vad.flatten(),
            threads,
        })
    }

    /// What was said in `samples` (16 kHz mono), in one of the `language` setting's languages.
    pub fn transcribe(&mut self, samples: &[f32], language: &str) -> Result<Heard, String> {
        let speech = match &mut self.vad {
            Some(vad) => {
                // faster-whisper's settings, which the assistant was tuned with.
                let mut params = WhisperVadParams::new();
                params.set_threshold(0.5);
                params.set_min_speech_duration(0);
                params.set_min_silence_duration(2000);
                params.set_speech_pad(400);
                let segments = vad
                    .segments_from_samples(params, samples)
                    .map_err(|err| format!("could not find speech: {err}"))?;
                let stretches: Vec<(f32, f32)> = segments.map(|s| (s.start, s.end)).collect();
                speech_only(samples, &stretches)
            }
            None => speech_only(samples, &[(0.0, f32::MAX)]),
        };
        if speech.is_empty() {
            return Ok(Heard::default());
        }
        let speech_ms = speech.len() * 1000 / SAMPLE_RATE;

        let allowed = allowed(language);
        let language = match allowed.as_slice() {
            [only] => *only,
            [] => {
                let heard = self.detect(&speech)?;
                let top = heard.iter().max_by(|a, b| a.1.total_cmp(&b.1));
                top.map_or("en", |(code, _)| code)
            }
            _ => likeliest(&allowed, &self.detect(&speech)?).unwrap_or(allowed[0]),
        };
        let mut params = FullParams::new(SamplingStrategy::BeamSearch {
            beam_size: 5,
            patience: -1.0,
        });
        params.set_n_threads(self.threads);
        params.set_language(Some(language));
        params.set_no_context(true);
        params.set_suppress_nst(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        self.state
            .full(params, &speech)
            .map_err(|err| format!("speech recognition failed: {err}"))?;
        let (mut said, mut dropped) = (Vec::new(), Vec::new());
        for segment in self.state.as_iter() {
            let text = segment.to_str_lossy().map_err(|err| err.to_string())?;
            let no_speech = segment.no_speech_probability();
            if heard(&text, no_speech) {
                said.push(text.trim().to_owned());
            } else {
                dropped.push((text.trim().to_owned(), no_speech));
            }
        }
        Ok(Heard {
            text: said.join(" ").trim().to_owned(),
            speech_ms,
            dropped,
        })
    }

    /// How likely `speech` is in each language Whisper knows.
    fn detect(&mut self, speech: &[f32]) -> Result<Vec<(&'static str, f32)>, String> {
        // Telling the language encodes as much audio as the last run did: a run stopped before
        // encoding sets that to the speech alone (not 30 seconds), and computes its spectrogram.
        let mut prepare = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        prepare.set_n_threads(self.threads);
        prepare.set_audio_ctx(detection_frames(speech.len()));
        prepare.set_language(Some("en"));
        prepare.set_print_progress(false);
        // SAFETY: a callback that touches nothing.
        unsafe { prepare.set_start_encoder_callback(Some(stop_before_encoding)) };
        self.state
            .full(prepare, speech)
            .and_then(|()| self.state.lang_detect(0, self.threads.max(1) as usize))
            .map(|(_, probabilities)| {
                probabilities
                    .iter()
                    .enumerate()
                    .filter_map(|(id, &p)| Some((whisper_rs::get_lang_str(id as i32)?, p)))
                    .collect()
            })
            .map_err(|err| format!("could not tell the language: {err}"))
    }
}

/// Returning false stops the run once the spectrogram is ready, before the encoder.
unsafe extern "C" fn stop_before_encoding(
    _: *mut sys::whisper_context,
    _: *mut sys::whisper_state,
    _: *mut std::ffi::c_void,
) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_speech() {
        assert!(heard(" Buka Firefox.", 0.02));
        assert!(heard("Open the files", 0.4));
        assert!(!heard("Open the files", 0.6));
    }

    #[test]
    fn made_up_phrases_must_sound_clearly_like_speech() {
        assert!(!heard(" Terima kasih.", 0.3));
        assert!(!heard("Thanks for watching!", 0.25));
        assert!(heard("Terima kasih.", 0.1));
        assert!(heard("thank you, that's all", 0.05));
        // Only at the start: a request that ends in thanks is kept.
        assert!(heard("Open Files, thank you", 0.3));
    }

    #[test]
    fn reads_the_language_setting() {
        assert_eq!(allowed("id,en"), vec!["id", "en"]);
        assert_eq!(allowed("en"), vec!["en"]);
        assert!(allowed("").is_empty());
        assert_eq!(allowed(" id, ,en "), vec!["id", "en"]);
    }

    #[test]
    fn picks_the_likeliest_allowed_language() {
        let heard = [("en", 0.2), ("id", 0.1), ("ja", 0.6)];
        assert_eq!(likeliest(&["id", "en"], &heard), Some("en"));
        assert_eq!(likeliest(&[], &heard), None);
    }

    #[test]
    fn malay_counts_as_indonesian() {
        let heard = [("en", 0.3), ("ms", 0.25), ("id", 0.2)];
        assert_eq!(likeliest(&["id", "en"], &heard), Some("id"));
        assert_eq!(likeliest(&["en", "id"], &[]), Some("en"));
    }

    #[test]
    fn keeps_only_speech_and_pads_it() {
        let samples: Vec<f32> = (0..SAMPLE_RATE * 4).map(|i| i as f32).collect();
        // 0.5–1.0 s and 2.0–3.0 s.
        let speech = speech_only(&samples, &[(50.0, 100.0), (200.0, 300.0)]);
        assert_eq!(speech.len(), SAMPLE_RATE * 3 / 2);
        assert_eq!(speech[0], (SAMPLE_RATE / 2) as f32);
        assert_eq!(speech[SAMPLE_RATE / 2], (2 * SAMPLE_RATE) as f32);

        let short = speech_only(&samples, &[(100.0, 120.0)]);
        assert_eq!(short.len(), MIN_SAMPLES);
        assert_eq!(short[MIN_SAMPLES - 1], 0.0);
    }

    #[test]
    fn no_speech_stays_empty() {
        let samples = vec![0.0; SAMPLE_RATE];
        assert!(speech_only(&samples, &[]).is_empty());
        // Stretches past the end, or backwards, take nothing out of bounds.
        assert_eq!(speech_only(&samples, &[(50.0, 900.0)]).len(), MIN_SAMPLES);
        assert!(speech_only(&samples, &[(80.0, 20.0)]).is_empty());
    }
}
