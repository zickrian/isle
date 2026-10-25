// SPDX-License-Identifier: GPL-3.0-or-later

//! `check`: commands that only look (which Linux, what is installed, the battery, power mode, network,
//! sound, logs, hardware, what runs), run at once for the AI without asking the user, so it can find out
//! what is wrong before it says. Only the shapes listed here run, as a program with its arguments, never
//! through a shell, so nothing in them can chain another command, write or change anything.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::chat::mask_secrets;
use super::child;

/// A look taking longer than this is stopped.
const TIMEOUT: Duration = Duration::from_secs(20);
/// What the AI gets of the output, at most (the end of it, where the answer usually is).
const MAX_OUTPUT: usize = 8000;

/// What a word after the first may be, for each program `check` runs.
#[derive(Clone, Copy)]
enum Rest {
    /// Nothing more.
    None,
    /// Package, app or unit names (see `is_name`), and these options.
    Names(&'static [&'static str]),
    /// Only these options.
    Options(&'static [&'static str]),
    /// Names, paths (`~`, `~/x` or `/x`, never going up a folder) and these options.
    Paths(&'static [&'static str]),
}

/// The programs `check` runs: the first word that keeps each to looking (empty: none needed), then what
/// may follow. Exact shapes only, so no option can make one write, run or read anything else.
const ALLOWED: &[(&str, &[&str], Rest)] = &[
    ("uname", &["", "-a", "-r", "-m", "-s", "-o"], Rest::None),
    (
        "lsb_release",
        &["-a", "-d", "-r", "-c", "-ds", "-rs", "-cs", "-is"],
        Rest::None,
    ),
    ("cat", &["/etc/os-release", "/etc/lsb-release"], Rest::None),
    (
        "apt-cache",
        &["policy", "show", "search", "madison", "showpkg"],
        Rest::Names(&["--names-only", "--full"]),
    ),
    (
        "apt",
        &["list", "show", "search", "policy"],
        Rest::Names(&["--installed", "--upgradable", "-a", "--all-versions"]),
    ),
    (
        "dpkg",
        &["-s", "-l", "-L", "--status", "--list", "--listfiles"],
        Rest::Names(&[]),
    ),
    (
        "dpkg-query",
        &["-W", "-s", "-l", "--show", "--status", "--list"],
        Rest::Names(&["-f", "--showformat"]),
    ),
    (
        "rpm",
        &["-q", "-qi", "-qa", "-ql", "--query"],
        Rest::Names(&["--qf", "--queryformat", "-i", "--info"]),
    ),
    (
        "dnf",
        &["info", "list", "search", "provides", "repolist"],
        Rest::Names(&[
            "--installed",
            "--available",
            "-q",
            "--quiet",
            "-C",
            "--cacheonly",
        ]),
    ),
    (
        "pacman",
        &["-Si", "-Qi", "-Ss", "-Q", "-Qs", "-Ql"],
        Rest::Names(&[]),
    ),
    (
        "zypper",
        &["info", "se", "search", "if", "lr", "repos"],
        Rest::Names(&["--installed-only"]),
    ),
    (
        "flatpak",
        &["search", "info", "list", "remote-ls", "remotes"],
        Rest::Names(&[
            "--app",
            "--runtime",
            "--user",
            "--system",
            "--updates",
            "--columns",
        ]),
    ),
    (
        "snap",
        &["find", "info", "list", "version"],
        Rest::Names(&[]),
    ),
    (
        "npm",
        &["view", "ls", "list", "-v", "--version"],
        Rest::Names(&["-g", "--global", "--depth", "--json"]),
    ),
    ("pipx", &["list"], Rest::Options(&["--short"])),
    ("node", &["-v", "--version"], Rest::None),
    ("python3", &["--version", "-V"], Rest::None),
    (
        "systemctl",
        &[
            "status",
            "is-active",
            "is-enabled",
            "list-units",
            "list-unit-files",
            "list-timers",
            "is-failed",
            "show",
            "--failed",
        ],
        Rest::Names(&["--user", "--no-pager", "--type", "--state", "--all"]),
    ),
    (
        "df",
        &["", "-h", "-H", "-T", "-hT", "-l"],
        Rest::Options(&["-h", "-T", "-l", "--total"]),
    ),
    (
        "free",
        &["", "-h", "-m", "-g", "--si"],
        Rest::Options(&["-h", "-t", "--si"]),
    ),
    ("lscpu", &[""], Rest::None),
    (
        "lspci",
        &["", "-k", "-nn", "-v"],
        Rest::Options(&["-k", "-nn"]),
    ),
    ("lsusb", &["", "-t"], Rest::None),
    (
        "nvidia-smi",
        &["", "-q", "-L", "--query-gpu"],
        Rest::Options(&["--format"]),
    ),
    ("which", &[], Rest::Names(&[])),
    // Power and battery.
    (
        "powerprofilesctl",
        &["", "get", "list", "version"],
        Rest::None,
    ),
    (
        "upower",
        &["-d", "--dump", "-e", "--enumerate", "--version"],
        Rest::None,
    ),
    ("tlp-stat", &["-s", "-b", "-p"], Rest::None),
    ("cpupower", &["frequency-info", "idle-info"], Rest::None),
    // Hardware and drivers.
    ("sensors", &[""], Rest::None),
    (
        "lsblk",
        &["", "-f", "-a", "-o"],
        Rest::Options(&["-f", "-a", "-o"]),
    ),
    ("lsmod", &[""], Rest::None),
    ("modinfo", &[], Rest::Names(&[])),
    (
        "lshw",
        &["-short", "-businfo"],
        Rest::Names(&["-C", "-class", "-sanitize"]),
    ),
    (
        "inxi",
        &[
            "", "-b", "-F", "-Fxz", "-Fz", "-G", "-Gxx", "-N", "-Nxx", "-A", "-Axx", "-B", "-Bxx",
            "-S", "-M", "-C", "-Cxx", "-D", "-Dxx", "-n", "-nxx", "-m", "-I", "-E", "-R",
        ],
        Rest::Options(&["-z", "-x", "-xx", "-xxx", "-c0"]),
    ),
    ("glxinfo", &["-B"], Rest::None),
    ("vulkaninfo", &["--summary"], Rest::None),
    ("mokutil", &["--sb-state"], Rest::None),
    ("ubuntu-drivers", &["list", "devices"], Rest::None),
    ("prime-select", &["query"], Rest::None),
    ("dkms", &["status"], Rest::None),
    ("rfkill", &["", "list"], Rest::None),
    ("iw", &["dev"], Rest::None),
    // The system.
    ("uptime", &["", "-p", "-s"], Rest::None),
    ("hostnamectl", &["", "status"], Rest::None),
    ("timedatectl", &["", "status", "show"], Rest::None),
    ("localectl", &["", "status"], Rest::None),
    (
        "loginctl",
        &[
            "list-sessions",
            "show-session",
            "session-status",
            "list-users",
        ],
        Rest::Names(&["--no-pager"]),
    ),
    ("journalctl", &[], Rest::Names(JOURNAL)),
    (
        "dmesg",
        &["", "-T"],
        Rest::Options(&["-T", "-k", "--level"]),
    ),
    (
        "ps",
        &["aux", "-ef", "-e", "-A", "-eo", "axo"],
        Rest::Options(&["--sort", "--no-headers", "-o"]),
    ),
    (
        "ss",
        &["-tuln", "-tunl", "-s", "-tulpn", "-tunlp", "-ltn", "-lun"],
        Rest::None,
    ),
    ("findmnt", &["", "-D", "--df", "-l"], Rest::None),
    ("swapon", &["--show", "-s"], Rest::None),
    ("zramctl", &[""], Rest::None),
    (
        "du",
        &[],
        Rest::Paths(&["-sh", "-h", "-s", "-d", "--max-depth", "-c"]),
    ),
    ("nproc", &[""], Rest::None),
    ("whoami", &[""], Rest::None),
    ("id", &[""], Rest::None),
    ("groups", &[""], Rest::None),
    ("ping", &["-c"], Rest::Names(&["-W", "-4", "-6", "-q"])),
    // What the desktop and apps are set to.
    ("xdg-settings", &["get"], Rest::Names(&[])),
    ("xdg-mime", &["query"], Rest::Names(&[])),
    (
        "update-alternatives",
        &["--display", "--query"],
        Rest::Names(&[]),
    ),
    ("fwupdmgr", &["get-devices"], Rest::None),
    (
        "docker",
        &["ps", "images", "info", "version"],
        Rest::Options(&["-a", "--all"]),
    ),
    (
        "pip",
        &["list", "show", "--version"],
        Rest::Names(&["--user", "--outdated"]),
    ),
    (
        "pip3",
        &["list", "show", "--version"],
        Rest::Names(&["--user", "--outdated"]),
    ),
];

/// What journalctl may be told: which logs, how many lines, since when, how bad. Never a file, a folder,
/// another machine, following on, or anything that writes (vacuum, rotate, flush, a cursor file).
const JOURNAL: &[&str] = &[
    "-b",
    "--boot",
    "-0",
    "-1",
    "-2",
    "-3",
    "-k",
    "--dmesg",
    "-p",
    "--priority",
    "-u",
    "--unit",
    "--user-unit",
    "--user",
    "--system",
    "-n",
    "--lines",
    "--since",
    "--until",
    "-S",
    "-U",
    "--no-pager",
    "-r",
    "--reverse",
    "-x",
    "-o",
    "--output",
    "-g",
    "--grep",
    "-q",
    "--no-hostname",
];

/// Commands of several words (`nmcli radio wifi`): the program, the words it starts with, and what may
/// follow them. The longest start that fits counts, so `nmcli radio wifi off` is `radio wifi` and a word
/// more, which `Rest::None` refuses.
const SHAPES: &[(&str, &str, Rest)] = &[
    ("nmcli", "", Rest::None),
    ("nmcli", "general", Rest::None),
    ("nmcli", "general status", Rest::None),
    ("nmcli", "general permissions", Rest::None),
    ("nmcli", "device", Rest::None),
    ("nmcli", "device status", Rest::None),
    ("nmcli", "device show", Rest::Names(&[])),
    ("nmcli", "device wifi", Rest::None),
    ("nmcli", "device wifi list", Rest::None),
    ("nmcli", "dev", Rest::None),
    ("nmcli", "dev status", Rest::None),
    ("nmcli", "dev show", Rest::Names(&[])),
    ("nmcli", "dev wifi", Rest::None),
    ("nmcli", "dev wifi list", Rest::None),
    ("nmcli", "connection", Rest::None),
    ("nmcli", "connection show", Rest::Names(&["--active"])),
    ("nmcli", "con", Rest::None),
    ("nmcli", "con show", Rest::Names(&["--active"])),
    ("nmcli", "radio", Rest::None),
    ("nmcli", "radio all", Rest::None),
    ("nmcli", "radio wifi", Rest::None),
    ("nmcli", "radio wwan", Rest::None),
    ("nmcli", "networking", Rest::None),
    ("nmcli", "networking connectivity", Rest::None),
    ("ip", "a", Rest::None),
    ("ip", "addr", Rest::None),
    ("ip", "address", Rest::None),
    ("ip", "addr show", Rest::Names(&[])),
    ("ip", "address show", Rest::Names(&[])),
    ("ip", "link", Rest::None),
    ("ip", "link show", Rest::Names(&[])),
    ("ip", "route", Rest::None),
    ("ip", "route show", Rest::None),
    ("ip", "r", Rest::None),
    ("ip", "-br a", Rest::None),
    ("ip", "-br addr", Rest::None),
    ("ip", "-br link", Rest::None),
    ("ip", "-4 addr", Rest::None),
    ("ip", "-6 addr", Rest::None),
    ("resolvectl", "", Rest::None),
    ("resolvectl", "status", Rest::Names(&[])),
    ("resolvectl", "dns", Rest::None),
    ("resolvectl", "domain", Rest::None),
    ("resolvectl", "statistics", Rest::None),
    ("wpctl", "status", Rest::None),
    ("wpctl", "inspect", Rest::Names(&[])),
    ("wpctl", "get-volume", Rest::Names(&[])),
    ("pactl", "info", Rest::None),
    ("pactl", "list", Rest::None),
    ("pactl", "list short", Rest::None),
    ("pactl", "list sinks", Rest::None),
    ("pactl", "list sources", Rest::None),
    ("pactl", "list cards", Rest::None),
    ("pactl", "list short sinks", Rest::None),
    ("pactl", "list short sources", Rest::None),
    ("pactl", "list short cards", Rest::None),
    ("pactl", "get-default-sink", Rest::None),
    ("pactl", "get-default-source", Rest::None),
    ("pactl", "get-sink-volume", Rest::Names(&[])),
    ("pactl", "get-sink-mute", Rest::Names(&[])),
    ("pactl", "get-source-volume", Rest::Names(&[])),
    ("pactl", "get-source-mute", Rest::Names(&[])),
    ("bluetoothctl", "show", Rest::Names(&[])),
    ("bluetoothctl", "list", Rest::None),
    ("bluetoothctl", "devices", Rest::Names(&[])),
    ("bluetoothctl", "paired-devices", Rest::None),
    ("bluetoothctl", "info", Rest::Names(&[])),
    ("bluetoothctl", "--version", Rest::None),
    ("gsettings", "get", Rest::Names(&[])),
    ("gsettings", "list-recursively", Rest::Names(&[])),
    ("gsettings", "list-keys", Rest::Names(&[])),
    ("gsettings", "range", Rest::Names(&[])),
    ("gsettings", "describe", Rest::Names(&[])),
    ("gsettings", "list-schemas", Rest::None),
    (
        "gnome-extensions",
        "list",
        Rest::Options(&[
            "--enabled",
            "--disabled",
            "--active",
            "--inactive",
            "--user",
            "--system",
            "--details",
            "-d",
        ]),
    ),
    ("gnome-extensions", "info", Rest::Names(&[])),
    ("gnome-extensions", "show", Rest::Names(&[])),
    ("gnome-extensions", "version", Rest::None),
    ("systemd-analyze", "", Rest::None),
    ("systemd-analyze", "time", Rest::None),
    (
        "systemd-analyze",
        "blame",
        Rest::Options(&["--no-pager", "--user"]),
    ),
    (
        "systemd-analyze",
        "critical-chain",
        Rest::Names(&["--no-pager", "--user"]),
    ),
];

/// Files `cat` may show: the system's own, never the user's or a secret.
const CAT_FILES: &[&str] = &[
    "/etc/os-release",
    "/etc/lsb-release",
    "/etc/hostname",
    "/etc/fstab",
    "/etc/default/grub",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/apt/sources.list",
    "/proc/cpuinfo",
    "/proc/meminfo",
    "/proc/loadavg",
    "/proc/uptime",
    "/proc/version",
    "/proc/swaps",
    "/proc/cmdline",
    "/proc/pressure/cpu",
    "/proc/pressure/memory",
    "/proc/pressure/io",
    "/proc/asound/cards",
    "/sys/power/mem_sleep",
];

/// Folders whose files `cat` may show: the hardware's own state (battery, temperatures, brightness, CPU speed).
const CAT_FOLDERS: &[&str] = &[
    "/sys/class/power_supply/",
    "/sys/class/thermal/",
    "/sys/class/backlight/",
    "/sys/class/drm/",
    "/sys/class/net/",
    "/sys/class/hwmon/",
    "/sys/devices/system/cpu/",
    "/sys/module/",
    "/sys/firmware/acpi/platform_profile",
];

/// Options whose value may follow an `=` (and only a plain one: letters, digits, `,.:_-${}%`).
const VALUED: &[&str] = &[
    "-f",
    "--showformat",
    "--qf",
    "--queryformat",
    "--columns",
    "--depth",
    "--type",
    "--state",
    "--query-gpu",
    "--format",
    "-eo",
    "axo",
    "-o",
    "--sort",
    "--level",
    "--max-depth",
];

/// journalctl's options that take a value (`-p err`); for other programs they may be flags (`uptime -p`).
const JOURNAL_VALUED: &[&str] = &[
    "-o",
    "--output",
    "-p",
    "--priority",
    "-u",
    "--unit",
    "--user-unit",
    "-n",
    "--lines",
    "--since",
    "--until",
    "-S",
    "-U",
    "-g",
    "--grep",
];

/// `VALUED` options that are only a flag for this program (lsblk's -f is filesystems, not a format).
const PLAIN: &[(&str, &str)] = &[("lsblk", "-f")];

/// Whether `option` of `program` takes a value as its next word.
fn takes_value(program: &str, option: &str) -> bool {
    if program == "journalctl" {
        return JOURNAL_VALUED.contains(&option);
    }
    VALUED.contains(&option) && !PLAIN.contains(&(program, option))
}

/// Programs that are never asked their version: what they do, they may do whatever the word.
const NEVER_RUN: &[&str] = &[
    "reboot",
    "poweroff",
    "shutdown",
    "halt",
    "rm",
    "rmdir",
    "dd",
    "mkfs",
    "kill",
    "pkill",
    "killall",
    "sudo",
    "pkexec",
    "su",
    "systemctl",
    "loginctl",
    "shred",
    "truncate",
    "mv",
    "cp",
    "chmod",
    "chown",
];

/// A package, app, unit or command name: letters, digits and `@._+:*~/-`, never starting with `-` or `/`,
/// nor going up a folder.
fn is_name(word: &str) -> bool {
    word.chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '@')
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@._+:*~/-".contains(c))
        && !word.contains("..")
}

/// Whether `word` is one of `options`, alone or (for `VALUED` ones) with a plain value.
fn is_option(word: &str, options: &[&str]) -> bool {
    let (name, value) = word
        .split_once('=')
        .map_or((word, None), |(n, v)| (n, Some(v)));
    options.contains(&name)
        && match value {
            None => true,
            Some(value) => {
                (VALUED.contains(&name) || JOURNAL_VALUED.contains(&name))
                    && !value.contains("%(")
                    && value
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || " ,.:_-${}%@\\t\\n".contains(c))
            }
        }
}

/// `command` as a program and its arguments if it may run as a check, else why not.
pub fn parse(command: &str) -> Result<Vec<String>, String> {
    // It runs without a shell, so `$`, quotes and globs are only letters; what would chain or redirect
    // commands in a shell is refused, so the AI learns a check is one command.
    if command.chars().any(|c| ";|&<>`\n".contains(c)) {
        return Err("a check is one command, without pipes, redirects or a second command".into());
    }
    let words = split(command)?;
    let Some((program, args)) = words.split_first() else {
        return Err("the check is empty".into());
    };
    if !is_name(program) || program.contains('/') {
        return Err("a check names a program, not a path".into());
    }
    // "command -v x" is how scripts ask whether x is installed; `which` answers the same.
    if program == "command" && args.first().map(String::as_str) == Some("-v") {
        let names = &args[1..];
        return if !names.is_empty()
            && names
                .iter()
                .all(|name| is_name(name) && !name.contains('/'))
        {
            Ok(std::iter::once("which".to_owned())
                .chain(names.iter().cloned())
                .collect())
        } else {
            Err("command -v takes program names".into())
        };
    }
    if program == "cat" {
        return cat(&words);
    }
    let shapes: Vec<_> = SHAPES.iter().filter(|(name, ..)| name == program).collect();
    if !shapes.is_empty() {
        let shown = || {
            let all: Vec<String> = shapes
                .iter()
                .map(|(_, start, _)| format!("{program} {start}").trim_end().to_owned())
                .collect();
            format!("{program} may only run as: {}", all.join(" | "))
        };
        // The longest start that fits: `nmcli radio wifi off` is `radio wifi` and a word more.
        let fits = shapes
            .iter()
            .filter(|(_, start, _)| {
                let start: Vec<&str> = start.split_whitespace().collect();
                args.len() >= start.len() && args.iter().zip(&start).all(|(a, s)| a == s)
            })
            .max_by_key(|(_, start, _)| start.split_whitespace().count());
        let Some((_, start, rest)) = fits else {
            return Err(shown());
        };
        let taken = start.split_whitespace().count();
        return if rest_fits(program, &args[taken..], *rest) {
            Ok(words)
        } else {
            Err(shown())
        };
    }
    let Some((_, first, rest)) = ALLOWED.iter().find(|(name, ..)| name == program) else {
        // Any program may say its version, but only that.
        return if args.len() == 1
            && args[0] == "--version"
            && !NEVER_RUN.contains(&program.as_str())
        {
            Ok(words)
        } else {
            Err(format!(
                "{program} is not one of the commands a check may run; `{program} --version` is"
            ))
        };
    };
    let shape = || {
        let firsts = first
            .iter()
            .filter(|word| !word.is_empty())
            .copied()
            .collect::<Vec<_>>();
        format!(
            "{program} may only run as: {program} {}",
            firsts.join(" | ")
        )
    };
    // The first word, unless the program needs none (`which`) or may run bare ("").
    let mut rest_args = args;
    if !first.is_empty() {
        match args.first() {
            Some(arg) if is_option(arg, first) => {
                rest_args = &args[1..];
                // `ps -eo pid,comm`: its value as the next word.
                if takes_value(program, arg) {
                    let Some(value) = rest_args.first() else {
                        return Err(shape());
                    };
                    if !is_option(&format!("{arg}={value}"), first) {
                        return Err(shape());
                    }
                    rest_args = &rest_args[1..];
                }
            }
            None if first.contains(&"") => {}
            _ => return Err(shape()),
        }
    }
    if rest_fits(program, rest_args, *rest) {
        Ok(words)
    } else {
        Err(shape())
    }
}

/// Whether `args` are what `rest` lets follow (see `Rest`).
fn rest_fits(program: &str, args: &[String], rest: Rest) -> bool {
    let (options, names, paths) = match rest {
        Rest::None => (&[][..], false, false),
        Rest::Options(options) => (options, false, false),
        Rest::Names(options) => (options, true, false),
        Rest::Paths(options) => (options, true, true),
    };
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if is_option(arg, options) {
            // `--qf '%{VERSION}'`: the value as the next word.
            if takes_value(program, arg) {
                let Some(value) = args.next() else {
                    return false;
                };
                if !is_option(&format!("{arg}={value}"), options) {
                    return false;
                }
            }
        } else if !((names && is_name(arg) && (program != "which" || !arg.contains('/')))
            || (paths && is_path(arg)))
        {
            return false;
        }
    }
    true
}

/// A folder or file by its path, from home (`~`, `~/Videos`) or the root, never going up a folder.
fn is_path(word: &str) -> bool {
    (word == "~" || word.starts_with("~/") || word.starts_with('/'))
        && !word.contains("..")
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+@~ ".contains(c))
}

/// `cat` of the system's own files only (see `CAT_FILES` and `CAT_FOLDERS`); the user's go through read_text.
fn cat(words: &[String]) -> Result<Vec<String>, String> {
    let files = &words[1..];
    let shown = |file: &str| {
        CAT_FILES.contains(&file)
            || (CAT_FOLDERS.iter().any(|folder| file.starts_with(folder))
                && !file.contains("..")
                && file
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "/._-:+@".contains(c)))
    };
    if !files.is_empty() && files.len() <= 8 && files.iter().all(|file| shown(file)) {
        Ok(words.to_vec())
    } else {
        Err("cat may only show the system's own files (/etc/os-release, /proc/meminfo, /proc/cpuinfo, \
             /sys/class/power_supply/…, /sys/class/thermal/…); the user's files go through read_text"
            .into())
    }
}

/// Words of `command`, with '…' and "…" quoting kept together.
fn split(command: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    for c in command.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => word.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started || !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            (None, c) => word.push(c),
        }
    }
    if quote.is_some() {
        return Err("a quote is left open".into());
    }
    if started || !word.is_empty() {
        words.push(word);
    }
    Ok(words)
}

/// Where a program for a check is looked for: the system's folders, then where the user's own programs
/// are (as the AI CLIs are looked for: npm, nvm, Homebrew…).
fn find(program: &str) -> Option<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    [
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/usr/local/bin",
        "/snap/bin",
    ]
    .iter()
    .map(PathBuf::from)
    .chain(super::install_dirs(&home))
    .map(|dir| dir.join(program))
    .find(|path| path.is_file())
}

/// Runs the check `command`: its output (the end of it, secrets hidden) and exit code, as text for the AI.
pub async fn run(command: &str) -> String {
    let words = match parse(command) {
        Ok(words) => words,
        Err(why) => {
            return format!(
                "check `{command}` did not run: {why}. Propose it with run instead if it is needed."
            );
        }
    };
    if words[0] == "which" {
        let found: Vec<String> = words[1..]
            .iter()
            .map(|name| match find(name) {
                Some(path) => path.display().to_string(),
                None => format!("{name}: not installed"),
            })
            .collect();
        return format!("check `{command}`:\n{}", found.join("\n"));
    }
    let Some(program) = find(&words[0]) else {
        return format!("check `{command}`: {} is not installed", words[0]);
    };
    // No shell to expand `~` (du ~/Videos).
    let home = dirs::home_dir().unwrap_or_default();
    let args: Vec<String> = words[1..]
        .iter()
        .map(|word| match word.strip_prefix('~') {
            Some(rest) if rest.is_empty() || rest.starts_with('/') => {
                format!("{}{rest}", home.display())
            }
            _ => word.clone(),
        })
        .collect();
    match output(&program, &args).await {
        Ok((code, text)) => format!("check `{command}` (exit {code}):\n{text}"),
        Err(why) => format!("check `{command}` failed: {why}"),
    }
}

async fn output(program: &Path, args: &[String]) -> anyhow::Result<(i32, String)> {
    let mut command = Command::new(program);
    // A Node program (npm, codex) finds the Node installed beside it.
    if let Some(path) = super::child::path_for(program) {
        command.env("PATH", path);
    }
    command
        .args(args)
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("PAGER", "cat")
        .env("SYSTEMD_PAGER", "")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = child::spawn(&mut command)?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let read = async {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        a?;
        b?;
        let status = child.wait().await?;
        out.extend(err);
        anyhow::Ok((status.code().unwrap_or(-1), out))
    };
    let (code, bytes) = tokio::time::timeout(TIMEOUT, read)
        .await
        .map_err(|_| anyhow::anyhow!("it took longer than {} s", TIMEOUT.as_secs()))??;
    Ok((
        code,
        tail(&mask_secrets(&String::from_utf8_lossy(&bytes)), MAX_OUTPUT),
    ))
}

/// The last `max` bytes of `text`, cut at a line where it can be.
pub fn tail(text: &str, max: usize) -> String {
    let text = text.trim_end();
    if text.len() <= max {
        return text.to_owned();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let cut = &text[start..];
    let cut = cut.find('\n').map_or(cut, |at| &cut[at + 1..]);
    format!("…\n{cut}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lets_only_looking_through() {
        for ok in [
            "apt-cache policy libreoffice",
            "dpkg -s libreoffice-core",
            "flatpak search libreoffice",
            "uname -a",
            "cat /etc/os-release",
            "libreoffice --version",
            "codex --version",
            "snap info code",
            "npm view @openai/codex version",
            "pacman -Qi firefox",
            "dnf info 'libreoffice-writer'",
            "dpkg-query -W -f='${Status} ${Version}' libreoffice",
            "apt list --installed vlc",
            "flatpak list --app --columns=application",
            "rpm -q --qf '%{VERSION}' firefox",
            "uname",
            "df -h",
            "free -h",
            "nvidia-smi --query-gpu=name,memory.total --format=csv",
            "systemctl status --user isled",
            "which node npm",
            "lsb_release -ds",
            "npm ls -g --depth=0",
            // Finding out what is wrong: power, battery, network, sound, logs, hardware, what runs.
            "powerprofilesctl get",
            "powerprofilesctl",
            "upower -d",
            "cat /sys/class/power_supply/BAT0/capacity /sys/class/power_supply/BAT0/status",
            "cat /proc/meminfo",
            "cat /sys/firmware/acpi/platform_profile",
            "nmcli device status",
            "nmcli radio wifi",
            "nmcli connection show --active",
            "nmcli dev wifi list",
            "ip -br addr",
            "resolvectl status",
            "ping -c 3 1.1.1.1",
            "ping -c 2 -W 2 google.com",
            "wpctl status",
            "pactl list short sinks",
            "pactl get-sink-volume @DEFAULT_SINK@",
            "bluetoothctl devices Connected",
            "bluetoothctl info AA:BB:CC:DD:EE:FF",
            "journalctl -b -p err --no-pager -n 50",
            "journalctl -b -1 -p warning --no-pager",
            "journalctl -u NetworkManager --since '1 hour ago' --no-pager",
            "journalctl --user -u isled -n 30",
            "journalctl -k -g iwlwifi -n 40",
            "journalctl --unit=user@1000.service -n 10",
            "sensors",
            "lsblk -f",
            "lsblk -o NAME,SIZE,MOUNTPOINT",
            "ps aux --sort=-%cpu",
            "ps -eo pid,comm,%cpu,%mem --sort=-%mem",
            "du -sh ~/Downloads",
            "du -h --max-depth=1 ~",
            "systemctl --failed",
            "systemctl list-unit-files --state=enabled",
            "systemd-analyze blame --no-pager",
            "gsettings get org.gnome.desktop.interface color-scheme",
            "gnome-extensions list --enabled",
            "inxi -Fxz",
            "lshw -short -C network",
            "mokutil --sb-state",
            "ubuntu-drivers devices",
            "uptime -p",
            "dmesg -T",
            "xdg-settings get default-web-browser",
            "ss -tuln",
        ] {
            assert!(parse(ok).is_ok(), "{ok}: {:?}", parse(ok));
        }
        assert_eq!(parse("command -v node").unwrap(), ["which", "node"]);
        for refused in [
            "apt install libreoffice",
            "apt-cache policy x; rm -rf ~",
            "cat ~/.ssh/id_rsa",
            "dpkg -i evil.deb",
            "flatpak install flathub org.libreoffice.LibreOffice",
            "sh -c 'echo hi'",
            "dpkg -s x -i y.deb",
            "rpm -q x --erase y",
            "npm config set prefix /tmp",
            "apt-cache policy x | head",
            "/tmp/evil --version",
            "rm --version x",
            "snap find x && reboot",
            "npm install -g x",
            "systemctl stop gdm",
            "echo $HOME",
            "dnf info x --setopt=y",
            // Read another file, run a program, write a file, act on a word, reach another host.
            "cat /etc/os-release /home/ana/.git-credentials",
            "cat /etc/os-release ../../etc/shadow",
            "npm config edit --editor=sh",
            "npm config get prefix",
            "rpm -q x --pipe sh",
            "rpm -q --qf '%(id)' x",
            "rpm -q -E '%(touch /tmp/x)'",
            "nvidia-smi -f /home/ana/.bashrc",
            "rm version",
            "reboot --version",
            "rm --version",
            "systemctl status -H evil.example x",
            "which /home/ana/.ssh/id_rsa",
            "dpkg -L ../../etc",
            "apt show -o Dir::Etc=/tmp x",
            "flatpak list --columns=$(id)",
            "uname -a extra",
            // Anything that changes something, reads the user's secrets, or never ends.
            "powerprofilesctl set performance",
            "powerprofilesctl launch -p performance sh",
            "nmcli radio wifi off",
            "nmcli connection up home",
            "nmcli connection delete home",
            "nmcli connection show --show-secrets home",
            "nmcli -s connection show home",
            "nmcli general hostname evil",
            "nmcli networking off",
            "nmcli device disconnect wlan0",
            "nmcli dev wifi connect x password y",
            "ip addr add 10.0.0.1/24 dev eth0",
            "ip link set wlan0 down",
            "ip route del default",
            "resolvectl dns wlan0 1.2.3.4",
            "wpctl set-volume @DEFAULT_SINK@ 0",
            "pactl set-sink-mute @DEFAULT_SINK@ 1",
            "pactl load-module x",
            "bluetoothctl remove AA:BB",
            "bluetoothctl power off",
            "gsettings set org.gnome.desktop.interface color-scheme default",
            "gsettings reset-recursively org.gnome.shell",
            "gnome-extensions disable isle@zickrian.github.io",
            "journalctl --vacuum-size=1M",
            "journalctl -f",
            "journalctl --file=/home/ana/.ssh/x",
            "journalctl -D /home/ana",
            "journalctl --rotate",
            "journalctl --cursor-file=/tmp/x",
            "cat /etc/shadow",
            "cat /proc/self/environ",
            "cat /sys/class/power_supply/../../../home/ana/x",
            "cat ~/.bashrc",
            "du -sh ~/../root",
            "ps aux; reboot",
            "ping 1.1.1.1",
            "ping -c 3 1.1.1.1 -i 0.001",
            "systemctl restart NetworkManager",
            "systemctl disable gdm",
            "systemd-analyze plot",
            "inxi -U",
            "inxi -W jakarta",
            "upower --monitor",
            "docker rm x",
            "docker run alpine",
            "pip install x",
            "rfkill block wifi",
            "iw dev wlan0 set power_save off",
            "dmesg -C",
            "lsblk -p",
        ] {
            assert!(parse(refused).is_err(), "{refused} was let through");
        }
    }

    #[test]
    fn keeps_the_end_of_long_output() {
        let long: String = (0..2000).map(|n| format!("line {n}\n")).collect();
        let cut = tail(&long, 100);
        assert!(cut.starts_with("…\nline ") && cut.ends_with("line 1999") && cut.len() <= 110);
        assert_eq!(tail("short\n", 100), "short");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn runs_a_check_and_says_what_is_missing() {
        let said = run("uname -s").await;
        assert!(
            said.starts_with("check `uname -s` (exit 0):\nLinux"),
            "{said}"
        );
        assert!(
            run("command -v no-such-program-isle")
                .await
                .contains("not installed")
        );
        assert!(run("apt install x").await.contains("did not run"));
    }
}
