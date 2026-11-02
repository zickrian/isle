// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Decides when a spoken request ends: speech starts above the room's noise,
//! and a pause after it (or a long silence before it) ends the recording.

/// Audio arrives in chunks of this many milliseconds.
pub const CHUNK_MS: u32 = 50;

/// Quietest level (RMS, 0..1) counted as speech, however quiet the room.
const MIN_SPEECH_RMS: f32 = 0.012;
/// Speech must be this much louder than the noise floor.
const SPEECH_OVER_NOISE: f32 = 3.0;
/// Loud chunks in a row that count as speech starting (not a click).
const START_CHUNKS: u32 = 3;
/// Once speaking, softer sound still counts (trailing syllables, a quiet word), in shorter runs.
const KEEP_OVER_NOISE: f32 = 2.0;
const MIN_KEEP_RMS: f32 = 0.008;
const KEEP_CHUNKS: u32 = 2;
/// A pause this long after speech ends the request; longer after only a few words, which is
/// usually someone still thinking of the rest.
const END_SILENCE_MS: u32 = 1600;
const SHORT_SPEECH_MS: u32 = 1200;
const END_SILENCE_SHORT_MS: u32 = 2400;
/// Without any speech for this long, the user said nothing.
const NO_SPEECH_MS: u32 = 7000;
/// The longest request kept.
const MAX_MS: u32 = 30_000;

/// What `push` says after each chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Keep recording.
    Listening,
    /// The user finished speaking.
    Done,
    /// Nothing was said.
    NoSpeech,
}

/// Levels below this are digital silence (a stream starting), not the room.
const SILENT_RMS: f32 = 1e-4;

/// Judges the whole recording so far each chunk, so speech that starts at once (before the room's
/// noise is known) still counts once a pause reveals how quiet the room is.
#[derive(Debug, Clone, Default)]
pub struct Endpointer {
    levels: Vec<f32>,
    speaking: bool,
}

impl Endpointer {
    /// A fresh recording, nothing heard yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether speech has started.
    pub fn heard_speech(&self) -> bool {
        self.speaking
    }

    /// The room's noise so far (RMS, 0..1), for the log when nothing was heard.
    pub fn room(&self) -> f32 {
        self.noise()
    }

    /// The room's noise: the quietest tenth of the recording, digital silence aside.
    fn noise(&self) -> f32 {
        let mut heard: Vec<f32> = self
            .levels
            .iter()
            .copied()
            .filter(|&l| l > SILENT_RMS)
            .collect();
        if heard.is_empty() {
            return 0.0;
        }
        heard.sort_by(f32::total_cmp);
        heard[heard.len() / 10]
    }

    /// Takes the next chunk's RMS level (0..1).
    pub fn push(&mut self, rms: f32) -> Verdict {
        self.levels.push(rms);
        let elapsed_ms = self.levels.len() as u32 * CHUNK_MS;
        let noise = self.noise();
        let start = (noise * SPEECH_OVER_NOISE).max(MIN_SPEECH_RMS);
        let keep = (noise * KEEP_OVER_NOISE).max(MIN_KEEP_RMS);

        // The last chunk of a run long enough to be speech, not a click; once started, a softer one.
        let (mut run, mut last_speech, mut speech_chunks) = (0, None, 0);
        for (index, &level) in self.levels.iter().enumerate() {
            let started = last_speech.is_some();
            run = if level > if started { keep } else { start } {
                run + 1
            } else {
                0
            };
            if run >= if started { KEEP_CHUNKS } else { START_CHUNKS } {
                last_speech = Some(index);
                speech_chunks += 1;
            }
        }
        self.speaking = last_speech.is_some();

        match last_speech {
            Some(last) => {
                let quiet_ms = (self.levels.len() - 1 - last) as u32 * CHUNK_MS;
                let pause_ms = if speech_chunks * CHUNK_MS < SHORT_SPEECH_MS {
                    END_SILENCE_SHORT_MS
                } else {
                    END_SILENCE_MS
                };
                if quiet_ms >= pause_ms || elapsed_ms >= MAX_MS {
                    Verdict::Done
                } else {
                    Verdict::Listening
                }
            }
            None if elapsed_ms >= NO_SPEECH_MS => Verdict::NoSpeech,
            None => Verdict::Listening,
        }
    }
}

/// RMS level (0..1) of 16-bit samples.
pub fn rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum();
    (sum / samples.len() as f64).sqrt() as f32
}

/// A level for meters: RMS mapped from -50..-10 dBFS onto 0..1.
pub fn meter(rms: f32) -> f64 {
    let db = 20.0 * (rms.max(1e-6) as f64).log10();
    ((db + 50.0) / 40.0).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(endpointer: &mut Endpointer, rms: f32, ms: u32) -> Verdict {
        let mut verdict = Verdict::Listening;
        for _ in 0..ms / CHUNK_MS {
            verdict = endpointer.push(rms);
            if verdict != Verdict::Listening {
                break;
            }
        }
        verdict
    }

    #[test]
    fn ends_after_a_pause_following_speech() {
        let mut e = Endpointer::new();
        assert_eq!(feed(&mut e, 0.003, 500), Verdict::Listening);
        assert_eq!(feed(&mut e, 0.1, 2000), Verdict::Listening);
        assert!(e.heard_speech());
        assert_eq!(feed(&mut e, 0.003, 1400), Verdict::Listening);
        assert_eq!(feed(&mut e, 0.003, 300), Verdict::Done);
    }

    #[test]
    fn a_thinking_pause_inside_speech_does_not_end_it() {
        let mut e = Endpointer::new();
        feed(&mut e, 0.003, 300);
        feed(&mut e, 0.1, 2000);
        assert_eq!(feed(&mut e, 0.003, 1400), Verdict::Listening);
        assert_eq!(feed(&mut e, 0.1, 800), Verdict::Listening);
    }

    #[test]
    fn after_a_few_words_it_waits_longer() {
        let mut e = Endpointer::new();
        feed(&mut e, 0.003, 500);
        // "Buka…", then a think.
        feed(&mut e, 0.1, 500);
        assert_eq!(feed(&mut e, 0.003, 2200), Verdict::Listening);
        assert_eq!(feed(&mut e, 0.1, 600), Verdict::Listening);
    }

    #[test]
    fn soft_speech_keeps_it_listening_once_started() {
        let mut e = Endpointer::new();
        feed(&mut e, 0.003, 500);
        feed(&mut e, 0.1, 2000);
        // Quieter than speech starts, louder than the room: still talking.
        assert_eq!(feed(&mut e, 0.01, 1000), Verdict::Listening);
        assert_eq!(feed(&mut e, 0.003, 1700), Verdict::Done);
    }

    #[test]
    fn silence_alone_means_nothing_was_said() {
        let mut e = Endpointer::new();
        assert_eq!(feed(&mut e, 0.003, 10_000), Verdict::NoSpeech);
        assert!(!e.heard_speech());
    }

    #[test]
    fn a_click_is_not_speech() {
        let mut e = Endpointer::new();
        feed(&mut e, 0.003, 300);
        e.push(0.2);
        e.push(0.003);
        assert!(!e.heard_speech());
    }

    #[test]
    fn a_noisy_room_needs_louder_speech() {
        let mut e = Endpointer::new();
        feed(&mut e, 0.03, 1000);
        feed(&mut e, 0.05, 500);
        assert!(!e.heard_speech());
        feed(&mut e, 0.2, 500);
        assert!(e.heard_speech());
    }

    #[test]
    fn speech_right_away_is_heard_once_it_pauses() {
        let mut e = Endpointer::new();
        assert_eq!(feed(&mut e, 0.15, 1600), Verdict::Listening);
        assert_eq!(feed(&mut e, 0.002, 1400), Verdict::Listening);
        assert!(e.heard_speech());
        assert_eq!(feed(&mut e, 0.002, 300), Verdict::Done);
    }

    #[test]
    fn digital_silence_at_the_start_is_not_the_room() {
        let mut e = Endpointer::new();
        feed(&mut e, 0.0, 300);
        feed(&mut e, 0.03, 1000);
        assert!(!e.heard_speech());
    }

    #[test]
    fn long_speech_is_cut_off() {
        let mut e = Endpointer::new();
        feed(&mut e, 0.003, 200);
        let mut verdict = Verdict::Listening;
        while verdict == Verdict::Listening {
            verdict = feed(&mut e, 0.1, 800);
            if verdict == Verdict::Listening {
                verdict = feed(&mut e, 0.003, 300);
            }
        }
        assert_eq!(verdict, Verdict::Done);
        assert!(e.levels.len() as u32 * CHUNK_MS >= MAX_MS);
    }

    #[test]
    fn meter_spans_speech_levels() {
        assert_eq!(meter(0.0), 0.0);
        assert_eq!(meter(1.0), 1.0);
        assert!((meter(0.0316) - 0.5).abs() < 0.01);
        assert_eq!(rms(&[i16::MAX, i16::MIN]).round(), 1.0);
    }
}
