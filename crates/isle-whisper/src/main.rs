// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! `isle-whisper`: speech to text for isled. Says `{"ready": true, "device": …}` once loaded, then
//! answers each `{"audio": path}` line (raw 16 kHz mono s16le) with `{"text"}` or `{"error"}`.

mod gpu;
mod protocol;
mod speech;
#[cfg(feature = "vulkan")]
mod vulkan;

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
Usage: isle-whisper --model <tiny|base|small|medium> [--language <codes>] [--cpu]
       isle-whisper --probe [--cpu]
  --model     the speech model, downloaded by isle-setup-voice
  --language  the languages spoken, e.g. id,en (the likeliest of them); empty: any
  --cpu       never use the GPU
  --probe     print where speech recognition would run, as JSON, and quit
It reads {\"audio\": \"path\"} lines (raw 16 kHz mono s16le) and answers {\"text\"} or {\"error\"}.
ISLE_WHISPER_THREADS sets the processor threads (default: half the cores).";

/// What to run with, from the command line.
#[derive(Debug, Default, PartialEq)]
struct Args {
    model: String,
    language: String,
    cpu: bool,
    probe: bool,
}

/// What the command line asked for.
enum Parsed {
    Run(Args),
    Help,
    Version,
}

/// Reads the arguments; the model is `small` unless one is named.
fn parse(mut args: impl Iterator<Item = String>) -> Result<Parsed, String> {
    let mut parsed = Args {
        model: "small".into(),
        ..Args::default()
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" => parsed.model = args.next().ok_or("--model needs a name")?,
            "--language" => parsed.language = args.next().ok_or("--language needs codes")?,
            "--cpu" => parsed.cpu = true,
            "--probe" => parsed.probe = true,
            "-h" | "--help" => return Ok(Parsed::Help),
            "-V" | "--version" => return Ok(Parsed::Version),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(Parsed::Run(parsed))
}

/// The threads isled allows (half the cores, so transcribing never takes the whole computer).
fn threads() -> i32 {
    std::env::var("ISLE_WHISPER_THREADS")
        .ok()
        .and_then(|n| n.trim().parse::<i32>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism().map_or(1, |n| (n.get() / 2).max(1) as i32)
        })
}

/// Where `isle-setup-voice` put the models: `$XDG_DATA_HOME`, else `~/.local/share`.
fn models_dir() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_default()
        .join(isle_core::speech::MODELS_DIR)
}

/// ggml is built for processors with AVX2 and FMA (Intel since 2013, AMD since 2015).
#[cfg(target_arch = "x86_64")]
fn processor_supported() -> bool {
    std::arch::is_x86_feature_detected!("avx2")
        && std::arch::is_x86_feature_detected!("fma")
        && std::arch::is_x86_feature_detected!("f16c")
}

/// Other processors: let ggml try.
#[cfg(not(target_arch = "x86_64"))]
fn processor_supported() -> bool {
    true
}

/// One JSON line to isled.
fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    // isled gone: nothing left to tell.
    let _ = writeln!(out, "{line}").and_then(|()| out.flush());
}

/// Loads the model, then transcribes one request per line until isled closes stdin.
fn main() -> ExitCode {
    let args = match parse(std::env::args().skip(1)) {
        Ok(Parsed::Run(args)) => args,
        Ok(Parsed::Help) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Ok(Parsed::Version) => {
            println!("isle-whisper {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Err(err) => {
            eprintln!("isle-whisper: {err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    // whisper.cpp and ggml log every step to stderr; ISLE_WHISPER_DEBUG=1 shows it.
    if std::env::var_os("ISLE_WHISPER_DEBUG").is_none() {
        whisper_rs::install_logging_hooks();
    }
    if !processor_supported() {
        say(&protocol::error(
            "speech recognition needs a processor with AVX2 (Intel since 2013, AMD since 2015)",
        ));
        return ExitCode::FAILURE;
    }
    #[cfg(feature = "vulkan")]
    if args.cpu {
        vulkan::disable();
    }
    let gpus = if args.cpu { Vec::new() } else { gpu::list() };
    let gpu = gpu::choose(&gpus, gpu::pinned());
    let device = gpu.map_or("cpu", |gpu| gpu.name.as_str());
    if args.probe {
        let names: Vec<&str> = gpus.iter().map(|gpu| gpu.name.as_str()).collect();
        say(&serde_json::json!({"device": device, "gpus": names}).to_string());
        return ExitCode::SUCCESS;
    }

    let threads = threads();
    let mut model = match speech::Model::load(&models_dir(), &args.model, gpu, threads) {
        Ok(model) => model,
        Err(err) => {
            say(&protocol::error(&err));
            return ExitCode::FAILURE;
        }
    };
    say(&protocol::ready(device));

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let reply = protocol::request(&line)
            .and_then(|path| {
                std::fs::read(&path).map_err(|err| format!("{}: {err}", path.display()))
            })
            .and_then(|bytes| model.transcribe(&protocol::samples(&bytes), &args.language));
        say(&match reply {
            Ok(heard) => protocol::text(&heard),
            Err(err) => protocol::error(&err),
        });
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> Result<Args, String> {
        match parse(args.iter().map(|arg| arg.to_string()))? {
            Parsed::Run(args) => Ok(args),
            _ => Err("not a run".into()),
        }
    }

    #[test]
    fn reads_what_isled_passes() {
        let args = run(&["--model", "base", "--language", "id,en"]).unwrap();
        assert_eq!(args.model, "base");
        assert_eq!(args.language, "id,en");
        assert!(!args.cpu && !args.probe);
        // An empty language is any language.
        assert_eq!(run(&["--language", ""]).unwrap().language, "");
    }

    #[test]
    fn small_by_default() {
        assert_eq!(run(&[]).unwrap().model, "small");
        assert!(run(&["--probe", "--cpu"]).unwrap().cpu);
    }

    #[test]
    fn refuses_unknown_arguments() {
        assert!(run(&["--gpu"]).is_err());
        assert!(run(&["--model"]).is_err());
    }
}
