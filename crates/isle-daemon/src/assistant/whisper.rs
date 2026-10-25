// SPDX-License-Identifier: GPL-3.0-or-later

//! Speech to text: `isle-whisper` (whisper.cpp, on the GPU through Vulkan or on the processor).

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::Context;
use isle_core::speech::{MODELS, MODELS_DIR, model_file};
use log::{info, warn};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};

use super::child::{self, Group};
use crate::store::{data_dir, write_private};

const NATIVE: &str = "isle-whisper";
/// Set, the user picked the GPUs (by their Vulkan numbers) the helper may use.
const PINNED: &str = "GGML_VK_VISIBLE_DEVICES";
/// How long `isled --doctor` waits for the helper to say where it runs.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Set once the GPU failed (a driver that crashes): the processor from then on, until isled restarts.
static GPU_FAILED: AtomicBool = AtomicBool::new(false);
/// Set once the helper found no GPU to use: later ones skip loading Vulkan, until isled restarts.
static NO_GPU: AtomicBool = AtomicBool::new(false);

/// `isle-whisper` beside isled (both go in ~/.local/bin), else on the PATH.
fn native() -> Option<PathBuf> {
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join(NATIVE)));
    let path = std::env::var_os("PATH").unwrap_or_default();
    beside
        .into_iter()
        .chain(std::env::split_paths(&path).map(|dir| dir.join(NATIVE)))
        .find(|path| path.is_file())
}

fn models_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join(MODELS_DIR)
}

/// The models `isle-setup-voice` downloaded for `isle-whisper`.
fn downloaded(dir: &Path) -> Vec<&'static str> {
    MODELS
        .into_iter()
        .filter(|model| model_file(model).is_some_and(|file| dir.join(file).is_file()))
        .collect()
}

/// Whether speech recognition is set up: `isle-whisper` and a model for it.
pub fn installed() -> bool {
    native().is_some() && !downloaded(&models_dir()).is_empty()
}

/// What `isled --doctor` says about speech recognition.
pub fn report() -> String {
    let models = downloaded(&models_dir());
    match native() {
        Some(native) if !models.is_empty() => format!(
            "  Speech recognition: {} (models: {}), on {}",
            native.display(),
            models.join(", "),
            probe(&native)
        ),
        Some(_) => "  Speech recognition: no speech model yet (run isle-setup-voice)".to_owned(),
        None => "  Speech recognition: isle-whisper is missing (install Isle again)".to_owned(),
    }
}

/// Where `isle-whisper` would run, as it finds when asked: the GPU's name, or the processor.
fn probe(native: &Path) -> String {
    let child = std::process::Command::new(native)
        .arg("--probe")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return "nothing: it does not start".to_owned();
    };
    let started = Instant::now();
    // Polled: a GPU driver that hangs must not hang the check.
    while child.try_wait().ok().flatten().is_none() {
        if started.elapsed() > PROBE_TIMEOUT {
            child.kill().ok();
            child.wait().ok();
            return "the processor (the GPU did not answer)".to_owned();
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut output = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        std::io::Read::read_to_string(&mut stdout, &mut output).ok();
    }
    device_name(&output)
}

/// How the doctor names the device in the helper's `--probe` answer.
fn device_name(probe: &str) -> String {
    let probe: Value = serde_json::from_str(probe.trim()).unwrap_or_default();
    let integrated = probe["gpus"]
        .as_array()
        .is_some_and(|gpus| !gpus.is_empty());
    match (probe["device"].as_str(), probe["error"].as_str()) {
        // An integrated GPU is not faster than the processor's own cores.
        (Some("cpu"), _) if integrated => {
            "the processor (integrated graphics are not used)".to_owned()
        }
        (Some("cpu"), _) => "the processor (no graphics card found)".to_owned(),
        (Some(gpu), _) => format!("the GPU ({gpu})"),
        (None, Some(error)) => format!("nothing: {error}"),
        (None, None) => "the processor (the GPU check failed)".to_owned(),
    }
}

/// The threads speech recognition may use: half the cores, at least one.
fn threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| (n.get() / 2).max(1))
}

/// An error the helper answered with, as opposed to the helper stopping.
#[derive(Debug)]
struct Answered(String);

impl fmt::Display for Answered {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Answered {}

pub struct Whisper {
    _child: Group,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    ready: bool,
    /// What it was started with, to start again on the processor.
    helper: PathBuf,
    model: String,
    language: String,
    /// `isle-whisper` free to use the GPU, so falling back to the processor is still possible.
    on_gpu: bool,
    /// Where a recording waits for the helper; removed after each one, and on drop.
    audio: PathBuf,
}

impl Whisper {
    /// Starts the helper; it loads the model while the user is still speaking. Without the model it
    /// starts all the same, and answers that the model is not downloaded.
    pub fn start(model: &str, language: &str) -> anyhow::Result<Self> {
        let helper = native().context("speech recognition is not set up")?;
        let cpu = GPU_FAILED.load(Ordering::Relaxed) || NO_GPU.load(Ordering::Relaxed);
        Self::start_with(helper, model, language, cpu)
    }

    fn start_with(helper: PathBuf, model: &str, language: &str, cpu: bool) -> anyhow::Result<Self> {
        let mut command = Command::new(&helper);
        if cpu {
            command.arg("--cpu");
        }
        command
            .args(["--model", model, "--language", language])
            // Half the cores at most: transcribing never takes the whole computer.
            .env("ISLE_WHISPER_THREADS", threads().to_string())
            // isled's own allocator limit would slow its threads down.
            .env_remove("MALLOC_ARENA_MAX")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = child::spawn(&mut command).context("could not start speech recognition")?;
        let stdin = child.stdin.take().expect("piped stdin");
        let lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        // A private folder: the session's runtime directory, else Isle's own data folder.
        let audio = dirs::runtime_dir()
            .unwrap_or_else(data_dir)
            .join(format!("isle-voice-{}.pcm", std::process::id()));
        Ok(Self {
            _child: child,
            stdin,
            lines,
            ready: false,
            helper,
            model: model.to_owned(),
            language: language.to_owned(),
            on_gpu: !cpu,
            audio,
        })
    }

    async fn read(&mut self) -> anyhow::Result<Value> {
        let line = self
            .lines
            .next_line()
            .await?
            .context("speech recognition stopped")?;
        let message: Value = serde_json::from_str(&line)?;
        if let Some(error) = message["error"].as_str() {
            return Err(Answered(error.to_owned()).into());
        }
        Ok(message)
    }

    pub async fn transcribe(&mut self, audio: &[i16]) -> anyhow::Result<String> {
        let mut result = self.attempt(audio).await;
        let stopped = match &result {
            Err(err) if self.on_gpu && err.downcast_ref::<Answered>().is_none() => {
                Some(format!("{err:#}"))
            }
            _ => None,
        };
        if let Some(err) = stopped {
            // It stopped on the GPU (a driver crash): the same words again, on the processor.
            warn!("speech recognition stopped on the GPU ({err}); using the processor from now on");
            GPU_FAILED.store(true, Ordering::Relaxed);
            let cpu = Self::start_with(self.helper.clone(), &self.model, &self.language, true);
            result = match cpu {
                Ok(mut cpu) => {
                    cpu.audio = self.audio.clone();
                    // The old helper (and its recording, removed on drop) goes.
                    *self = cpu;
                    self.attempt(audio).await
                }
                Err(err) => Err(err),
            };
        }
        // What was said is not left on disk, whatever happened.
        tokio::fs::remove_file(&self.audio).await.ok();
        result
    }

    async fn attempt(&mut self, audio: &[i16]) -> anyhow::Result<String> {
        if !self.ready {
            let ready = self.read().await?;
            let device = ready["device"].as_str();
            info!(
                "speech recognition runs on {}",
                device.unwrap_or("an unknown device")
            );
            // No GPU to use, and none picked by hand: the next helpers start on the processor.
            if self.on_gpu && device == Some("cpu") && std::env::var_os(PINNED).is_none() {
                NO_GPU.store(true, Ordering::Relaxed);
            }
            self.ready = true;
        }
        self.ask(audio).await
    }

    async fn ask(&mut self, audio: &[i16]) -> anyhow::Result<String> {
        let bytes: Vec<u8> = audio.iter().flat_map(|s| s.to_le_bytes()).collect();
        write_private(&self.audio, &bytes)?;
        let request = serde_json::json!({"audio": self.audio});
        self.stdin
            .write_all(format!("{request}\n").as_bytes())
            .await?;
        Ok(self.read().await?["text"]
            .as_str()
            .unwrap_or_default()
            .to_owned())
    }
}

impl Drop for Whisper {
    // Dropped mid-way (the user closed the island), the recording is still removed.
    fn drop(&mut self) {
        std::fs::remove_file(&self.audio).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(models: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "isle-whisper-test-{}-{}",
            std::process::id(),
            models.join("-")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for model in models {
            std::fs::write(dir.join(model_file(model).unwrap()), b"").unwrap();
        }
        dir
    }

    #[test]
    fn lists_the_downloaded_models() {
        let dir = folder(&["small", "base"]);
        assert_eq!(downloaded(&dir), vec!["base", "small"]);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A stand-in for `isle-whisper` that crashes on the GPU, as a broken driver makes it.
    #[cfg(unix)]
    fn crashing_helper() -> (PathBuf, PathBuf) {
        let dir = folder(&["tiny"]);
        let script = dir.join("isle-whisper");
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             case \" $* \" in *\" --cpu \"*) ;; *) kill -ABRT $$ ;; esac\n\
             echo '{\"ready\":true,\"device\":\"cpu\"}'\n\
             read line && echo '{\"text\":\"buka Files\"}'\n",
        )
        .unwrap();
        let executable = std::os::unix::fs::PermissionsExt::from_mode(0o755);
        std::fs::set_permissions(&script, executable).unwrap();
        (dir, script)
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn falls_back_to_the_processor_when_the_gpu_crashes() {
        let (dir, script) = crashing_helper();
        let mut whisper = Whisper::start_with(script, "tiny", "id", false).unwrap();
        whisper.audio = dir.join("voice.pcm");
        let text = whisper.transcribe(&[0; 1600]).await.unwrap();
        assert_eq!(text, "buka Files");
        assert!(GPU_FAILED.load(Ordering::Relaxed));
        assert!(!whisper.on_gpu);
        // The recording is gone once heard.
        assert!(!dir.join("voice.pcm").exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn names_where_it_runs() {
        assert_eq!(
            device_name(r#"{"device":"Intel(R) UHD Graphics 630 (CFL GT2)","gpus":[]}"#),
            "the GPU (Intel(R) UHD Graphics 630 (CFL GT2))"
        );
        assert_eq!(
            device_name("{\"device\":\"cpu\",\"gpus\":[]}\n"),
            "the processor (no graphics card found)"
        );
        assert_eq!(
            device_name(r#"{"device":"cpu","gpus":["Intel(R) UHD Graphics 630 (CFL GT2)"]}"#),
            "the processor (integrated graphics are not used)"
        );
        assert!(device_name(r#"{"error":"needs AVX2"}"#).contains("needs AVX2"));
        assert!(device_name("").contains("processor"));
    }
}
