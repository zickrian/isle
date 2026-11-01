// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The assistant's "brain": whichever AI CLI the user has and picked (agy, Claude Code, Codex or Grok), behind one
//! face. Each runs with the user's own sign-in, kept to answering; isled runs the tools and actions itself.

use std::path::{Path, PathBuf};

use tokio::sync::mpsc::UnboundedSender;

use super::agy::{self, Agy};
use super::answer::Answer;
use super::claude::Claude;
use super::codex::Codex;
use super::grok::Grok;

/// An AI CLI the assistant can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Agy,
    Claude,
    Codex,
    Grok,
}

/// Tried in this order when the user picked "auto", signed-in ones first. agy comes last: its terms bar
/// third-party tools, so it answers only when it is all there is, or picked.
const AUTO: [Provider; 4] = [
    Provider::Claude,
    Provider::Codex,
    Provider::Grok,
    Provider::Agy,
];

impl Provider {
    /// Its id in Settings and in saved state.
    pub fn id(self) -> &'static str {
        match self {
            Provider::Agy => "agy",
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Grok => "grok",
        }
    }

    /// The name the island shows ("Sign in to Claude Code").
    pub fn name(self) -> &'static str {
        match self {
            Provider::Agy => "Antigravity",
            Provider::Claude => "Claude Code",
            Provider::Codex => "Codex",
            Provider::Grok => "Grok",
        }
    }

    /// The program's file name.
    fn command(self) -> &'static str {
        match self {
            Provider::Agy => "agy",
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Grok => "grok",
        }
    }

    /// The CLI on the PATH, else where an installer or Node version manager puts it: isled starts from
    /// systemd, whose PATH lacks what a shell's profile adds (~/.local/bin, nvm's current Node…).
    pub fn program(self) -> Option<PathBuf> {
        let name = self.command();
        let home = dirs::home_dir().unwrap_or_default();
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
            .chain(install_dirs(&home))
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    }

    /// Whether the user signed in to it, as far as its sign-in file tells.
    pub fn signed_in(self) -> bool {
        match self {
            Provider::Agy => agy::signed_in(),
            Provider::Claude => super::claude::signed_in(),
            Provider::Codex => {
                super::codex::user_auth().exists()
                    || std::env::var_os("OPENAI_API_KEY").is_some_and(|key| !key.is_empty())
            }
            Provider::Grok => super::grok::signed_in(),
        }
    }

    /// How to sign in to it, in a terminal.
    pub fn sign_in_command(self) -> &'static str {
        match self {
            Provider::Agy => "agy",
            Provider::Claude => "claude",
            Provider::Codex => "codex login",
            Provider::Grok => "grok login",
        }
    }

    /// The provider with id `id` ("agy", "claude", "codex", "grok").
    pub fn from_id(id: &str) -> Option<Provider> {
        AUTO.into_iter().find(|p| p.id() == id)
    }

    /// Whether it takes Isle's job as its own instructions (a system prompt), once per conversation;
    /// agy gets it with the conversation's first request instead.
    pub fn takes_instructions(self) -> bool {
        self != Provider::Agy
    }

    /// Every provider, in "auto" order.
    pub fn all() -> [Provider; 4] {
        AUTO
    }

    /// `wanted` ("agy", "claude", "codex", "grok" or "auto"), if installed; for "auto", the first installed and
    /// signed in, else the first installed (which then asks to sign in).
    pub fn pick(wanted: &str) -> Option<Provider> {
        let installed = |p: &Provider| p.program().is_some();
        match AUTO.into_iter().find(|p| p.id() == wanted) {
            Some(provider) => installed(&provider).then_some(provider),
            None => AUTO
                .into_iter()
                .find(|p| installed(p) && p.signed_in())
                .or_else(|| AUTO.into_iter().find(installed)),
        }
    }
}

/// Where installers and Node version managers put CLIs, beyond the PATH: the newest of nvm's Nodes first.
pub fn install_dirs(home: &Path) -> Vec<PathBuf> {
    dirs_in(home, |name| {
        std::env::var_os(name)
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
    })
}

/// `install_dirs`, with `env_dir` for the variables that move them (NVM_DIR…).
fn dirs_in(home: &Path, env_dir: impl Fn(&str) -> Option<PathBuf>) -> Vec<PathBuf> {
    let nvm_dir = env_dir("NVM_DIR").unwrap_or_else(|| {
        // nvm's installer puts it under XDG_CONFIG_HOME when that is set.
        let xdg = env_dir("XDG_CONFIG_HOME").map(|dir| dir.join("nvm"));
        xdg.filter(|dir| dir.is_dir())
            .unwrap_or_else(|| home.join(".nvm"))
    });
    let mut nvm: Vec<PathBuf> = std::fs::read_dir(nvm_dir.join("versions/node"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path().join("bin"))
        .collect();
    // "v22.11.0" after "v9.0.0": by each number, not by text.
    let version = |path: &PathBuf| -> Vec<u64> {
        let name = path.parent().and_then(Path::file_name).unwrap_or_default();
        name.to_string_lossy()
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    };
    nvm.sort_by_key(|path| std::cmp::Reverse(version(path)));
    [
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        env_dir("BUN_INSTALL")
            .map_or_else(|| home.join(".bun"), PathBuf::from)
            .join("bin"),
        env_dir("VOLTA_HOME")
            .map_or_else(|| home.join(".volta"), PathBuf::from)
            .join("bin"),
        env_dir("PNPM_HOME").unwrap_or_else(|| home.join(".local/share/pnpm")),
        home.join(".local/share/fnm/aliases/default/bin"),
        home.join(".fnm/aliases/default/bin"),
        // Claude Code's own older install, mise and asdf, yarn, Homebrew on Linux, Nix.
        home.join(".claude/local"),
        home.join(".grok/bin"),
        home.join(".local/share/mise/shims"),
        home.join(".asdf/shims"),
        home.join(".yarn/bin"),
        PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
        home.join(".linuxbrew/bin"),
        home.join(".nix-profile/bin"),
        PathBuf::from("/run/current-system/sw/bin"),
    ]
    .into_iter()
    .chain(npm_prefix(home, env_dir("NPM_CONFIG_PREFIX")))
    .chain(nvm)
    .chain([PathBuf::from("/usr/local/bin")])
    .collect()
}

/// The `bin` of the global npm folder set in `~/.npmrc` (`prefix=~/.npm-packages`), if any.
fn npm_prefix(home: &Path, from_env: Option<PathBuf>) -> Option<PathBuf> {
    let set = from_env.or_else(|| {
        let npmrc = std::fs::read_to_string(home.join(".npmrc")).ok()?;
        npmrc.lines().find_map(|line| {
            let value = line
                .trim()
                .strip_prefix("prefix")?
                .trim_start()
                .strip_prefix('=')?
                .trim();
            let value = value.trim_matches('"');
            Some(match value.strip_prefix("~/") {
                Some(rest) => home.join(rest),
                None => PathBuf::from(value.replace("${HOME}", &home.to_string_lossy())),
            })
        })
    })?;
    set.is_absolute().then(|| set.join("bin"))
}

/// The running CLI behind the assistant, whichever it is.
pub enum Brain {
    Agy(Agy),
    Claude(Claude),
    Codex(Codex),
    Grok(Grok),
}

impl Brain {
    /// Starts `provider`'s CLI, resuming conversation `resume` or starting one with `instructions` as its
    /// job (see `Provider::takes_instructions`). It stays up for the next turns until dropped.
    pub async fn start(
        provider: Provider,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
        instructions: &str,
    ) -> anyhow::Result<Self> {
        let program = provider.program().ok_or_else(|| {
            anyhow::anyhow!("could not start {}: no such file", provider.command())
        })?;
        Ok(match provider {
            Provider::Agy => Brain::Agy(Agy::start_program(&program, model, resume, workspace)?),
            Provider::Claude => Brain::Claude(Claude::start(
                &program,
                model,
                resume,
                workspace,
                instructions,
            )?),
            Provider::Codex => {
                Brain::Codex(Codex::start(&program, model, resume, workspace, instructions).await?)
            }
            Provider::Grok => {
                Brain::Grok(Grok::start(&program, model, resume, workspace, instructions).await?)
            }
        })
    }

    /// Gets ready for the first turn, so it need not wait: Codex opens its conversation now.
    pub async fn warm(&mut self) -> anyhow::Result<()> {
        match self {
            Brain::Codex(codex) => codex.warm().await,
            Brain::Agy(_) | Brain::Claude(_) | Brain::Grok(_) => Ok(()),
        }
    }

    /// Which CLI this is.
    pub fn provider(&self) -> Provider {
        match self {
            Brain::Agy(_) => Provider::Agy,
            Brain::Claude(_) => Provider::Claude,
            Brain::Codex(_) => Provider::Codex,
            Brain::Grok(_) => Provider::Grok,
        }
    }

    /// One turn; `activity` hears what it does meanwhile ("Searching the web for …"), and `draft` what it
    /// has said so far, as it writes (Claude and Codex).
    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        match self {
            Brain::Agy(agy) => agy.ask(prompt, activity).await,
            Brain::Claude(claude) => claude.ask(prompt, activity, draft).await,
            Brain::Codex(codex) => codex.ask(prompt, activity, draft).await,
            Brain::Grok(grok) => grok.ask(prompt, activity, draft).await,
        }
    }

    /// The conversation's id, to resume it once the process had to go.
    pub fn conversation(&self) -> Option<String> {
        match self {
            Brain::Agy(agy) => agy.conversation.clone(),
            Brain::Claude(claude) => claude.conversation.clone(),
            Brain::Codex(codex) => codex.conversation.clone(),
            Brain::Grok(grok) => grok.conversation.clone(),
        }
    }

    /// Deletes the conversation `id` had with `provider` now: a chat that ended, or the eval's.
    pub fn forget(provider: Provider, id: &str) {
        match provider {
            Provider::Agy => agy::forget(id),
            Provider::Claude => super::claude::forget(id),
            Provider::Codex => super::codex::forget(id),
            Provider::Grok => super::grok::forget(id),
        }
    }

    /// Deletes every provider's conversations last used before `today` (Isle's own, never the user's).
    pub fn prune(today: chrono::NaiveDate) {
        agy::prune(today);
        super::claude::prune(today);
        super::codex::prune(today);
        super::grok::prune(today);
    }
}

/// A failure as the island shows it: what went wrong, what to do, and whether signing in fixes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub error: String,
    pub hint: String,
    pub sign_in: bool,
    /// Running isle-setup-voice with `model` would fix it (speech recognition, or its model, missing).
    pub set_up: bool,
    pub model: String,
}

impl From<(&str, &str)> for Failure {
    /// Just words: nothing to sign in to or set up.
    fn from((error, hint): (&str, &str)) -> Self {
        Self {
            error: error.into(),
            hint: hint.into(),
            sign_in: false,
            set_up: false,
            model: String::new(),
        }
    }
}

/// `error` from `provider`, as the user sees it.
pub fn explain(provider: Provider, error: &str) -> Failure {
    let name = provider.name();
    let error = error.to_lowercase();
    // Codes and short words count only whole ("401" in a request id says nothing); longer ones are
    // stems too ("eligib", "credential").
    let says = |words: &[&str]| {
        words.iter().any(|word| {
            if word.len() <= 3 || word.chars().all(|c| c.is_ascii_digit()) {
                has_word(&error, word)
            } else {
                error.contains(word)
            }
        })
    };
    // Its script found no Node to run on (`#!/usr/bin/env node`).
    if says(&[
        "env: 'node'",
        "env: node",
        "node: not found",
        "node: no such file",
    ]) {
        return Failure::from((
            &*format!("{name} needs Node.js"),
            "Reinstall it with its own installer, then ask again.",
        ));
    }
    if says(&["could not start"]) {
        return Failure::from((
            &*format!("{name} isn’t installed"),
            "Install it, or pick another in Settings.",
        ));
    }
    // Older than the options and calls Isle uses.
    if says(&[
        "unknown option",
        "unrecognized option",
        "unexpected argument",
        "unknown flag",
        "unknown method",
        "method not found",
        "unknown variant",
    ]) {
        return Failure::from((
            &*format!("Update {name}"),
            "This version is too old for Isle; update it, then ask again.",
        ));
    }
    if error.contains("model")
        && says(&[
            "not found",
            "does not exist",
            "not exist",
            "invalid",
            "not supported",
            "unsupported",
            "unknown",
            "no access",
            "does not have access",
        ])
    {
        return Failure {
            error: format!("{name} can’t use that model"),
            hint: "Pick another model in Settings → Assistant.".into(),
            sign_in: false,
            set_up: false,
            model: String::new(),
        };
    }
    if says(&[
        "log in",
        "login",
        "sign in",
        "signin",
        "sign-in",
        "unauthenticated",
        "unauthorized",
        "credential",
        "authentication",
        "oauth",
        "401",
        "reauth",
        "not authenticated",
        "invalid api key",
        "/login",
    ]) {
        return Failure {
            error: format!("Sign in to {name}"),
            hint: "Sign in, then ask again.".into(),
            sign_in: true,
            set_up: false,
            model: String::new(),
        };
    }
    // Its own files it may not write (a folder left to root by running it with sudo once): not its plan.
    if says(&["eacces", "os error 13"]) || (says(&["permission denied"]) && error.contains('/')) {
        return Failure::from((
            &*format!("{name} can’t write its own files"),
            "Reinstalling it with its own installer usually puts this right.",
        ));
    }
    if says(&[
        "quota",
        "rate limit",
        "rate_limit",
        "429",
        "exhausted",
        "usage limit",
        "eligib",
        "permission denied",
        "403",
        "subscription",
        "not entitled",
        "not available in your",
        "limit reached",
        "overloaded",
    ]) {
        return Failure::from((
            &*format!("{name} isn’t available"),
            "Its limit may be used up for now; try again later, or pick another in Settings.",
        ));
    }
    if says(&[
        "network",
        "dial tcp",
        "no such host",
        "connection refused",
        "unreachable",
        "offline",
        "dns",
    ]) {
        return Failure::from((
            "You’re offline",
            "Check the internet connection and try again.",
        ));
    }
    Failure::from((
        UNKNOWN,
        &*format!("{name} could not answer this time; try again."),
    ))
}

/// Whether `word` (or phrase) is in `text` with no letter or digit right before or after it.
fn has_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + word.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

/// A failure `explain` has no better words for.
pub const UNKNOWN: &str = "Something went wrong";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explains_each_providers_failures() {
        // A folder it may not write (after `sudo claude` once) is not a used-up plan; a refusal from the
        // service still is.
        assert_eq!(
            explain(
                Provider::Claude,
                "EACCES: permission denied, mkdir '/home/a/.claude/projects'"
            )
            .error,
            "Claude Code can’t write its own files"
        );
        assert_eq!(
            explain(Provider::Claude, "API Error: 403 permission denied").error,
            "Claude Code isn’t available"
        );
        assert_eq!(
            explain(
                Provider::Agy,
                "could not start agy: No such file or directory"
            )
            .error,
            "Antigravity isn’t installed"
        );
        // Installed, but with no Node to run it: not "isn't installed".
        assert_eq!(
            explain(
                Provider::Claude,
                "exit 127: /usr/bin/env: 'node': No such file or directory"
            )
            .error,
            "Claude Code needs Node.js"
        );
        assert_eq!(
            explain(Provider::Claude, "error: unknown option '--json-schema'").error,
            "Update Claude Code"
        );
        assert_eq!(
            explain(
                Provider::Codex,
                "The model `gpt-9` does not exist or you do not have access to it."
            )
            .error,
            "Codex can’t use that model"
        );
        let signed_out = explain(Provider::Claude, "Invalid API key · Please run /login");
        assert!(signed_out.sign_in && signed_out.error == "Sign in to Claude Code");
        assert!(
            explain(
                Provider::Agy,
                "Error: authentication required. Run 'agy' to log in"
            )
            .sign_in
        );
        assert_eq!(
            explain(Provider::Codex, "You've hit your usage limit").error,
            "Codex isn’t available"
        );
        assert_eq!(
            explain(Provider::Agy, "dial tcp: lookup example.com: no such host").error,
            "You’re offline"
        );
        assert_eq!(
            explain(Provider::Codex, "weird").error,
            "Something went wrong"
        );
        // A number or word inside another says nothing.
        assert_eq!(
            explain(Provider::Codex, "request req_4012 failed").error,
            "Something went wrong"
        );
        assert_eq!(
            explain(Provider::Claude, "HTTP 429 Too Many Requests").error,
            "Claude Code isn’t available"
        );
        assert!(explain(Provider::Claude, "No credentials found").sign_in);
        assert_eq!(
            explain(Provider::Codex, "account not eligible").error,
            "Codex isn’t available"
        );
    }

    #[test]
    fn finds_the_newest_nvm_node_first() {
        let home = std::env::temp_dir().join(format!("isle-nvm-{}", std::process::id()));
        for version in ["v9.0.0", "v22.11.0", "v18.2.1"] {
            std::fs::create_dir_all(home.join(".nvm/versions/node").join(version).join("bin"))
                .unwrap();
        }
        std::fs::write(
            home.join(".npmrc"),
            "fund=false\nprefix = ~/.npm-packages\n",
        )
        .unwrap();
        let dirs = dirs_in(&home, |_| None);
        assert!(dirs.contains(&home.join(".npm-packages/bin")));
        let nvm: Vec<_> = dirs
            .iter()
            .filter(|d| d.starts_with(home.join(".nvm")))
            .map(|d| {
                d.parent()
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(nvm, ["v22.11.0", "v18.2.1", "v9.0.0"]);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn picks_only_installed_providers() {
        assert!(Provider::pick("no-such-provider").is_none_or(|p| p.program().is_some()));
        for provider in AUTO {
            assert!(Provider::pick(provider.id()).is_none_or(|p| p == provider));
        }
    }
}
