// SPDX-License-Identifier: GPL-3.0-or-later

//! `isled`: the Isle background service, on the session bus as `io.github.zickrian.isle.Daemon`.
//! See `docs/dbus-api.md` for the interfaces.

mod agents;
mod assistant;
mod calendar;
mod caller;
mod clipboard;
mod clock;
mod http;
mod login_env;
mod media;
mod meeting;
mod pomodoro;
mod reminders;
mod shelf;
mod store;
mod system;
mod todo;
mod updates;
mod uri;
mod usage;

use anyhow::{Context, bail};
use futures_util::StreamExt;
use log::{info, warn};
#[cfg(unix)]
use tokio::signal::unix::{SignalKind, signal};
use zbus::connection;
use zbus::fdo::{DBusProxy, RequestNameFlags, RequestNameReply};

use crate::agents::AgentsService;
use crate::assistant::AssistantService;
use crate::calendar::CalendarService;
use crate::clipboard::ClipboardService;
use crate::media::MediaService;
use crate::pomodoro::PomodoroService;
use crate::reminders::RemindersService;
use crate::shelf::ShelfService;
use crate::system::SystemService;
use crate::todo::TodoService;
use crate::updates::UpdatesService;
use crate::usage::UsageService;

const BUS_NAME: &str = "io.github.zickrian.isle.Daemon";
const OBJECT_PATH: &str = "/io/github/zickrian/isle/Daemon";
/// Songs whose cover and lyrics stay cached.
const CACHED_SONGS: usize = 500;

const HELP: &str = "isled: the Isle background service (started by systemd or D-Bus, not by hand)

Usage: isled [--version | --doctor | --report | --unhook-all | --help]
  --version     print the version
  --doctor      check the service, speech recognition, each AI's install and sign-in, and its alerts
  --report      everything a bug report needs: versions, the doctor's check and recent logs
  --unhook-all  take Isle's alert hooks out of Claude Code's and Codex's settings
  --help        print this

Claude Code and Codex run `isled --agent-hook claude|codex` themselves, once their alerts are on.";

async fn open_session() -> anyhow::Result<zbus::Connection> {
    #[cfg(unix)]
    if let Ok(builder) = connection::Builder::session() {
        if let Ok(conn) = builder.build().await {
            return Ok(conn);
        }
    }
    #[cfg(windows)]
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some() {
        if let Ok(builder) = connection::Builder::session() {
            if let Ok(conn) = builder.build().await {
                return Ok(conn);
            }
        }
    }
    // Standalone fallback: runs a local lightweight connection when no D-Bus daemon is available
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let p1 = tokio::net::TcpStream::connect(addr).await?;
    let (p0, _) = listener.accept().await?;
    let guid = zbus::Guid::generate();
    let server = connection::Builder::tcp_stream(p0).server(guid)?.p2p();
    let client = connection::Builder::tcp_stream(p1).p2p();
    let (conn, client_conn) = tokio::try_join!(server.build(), client.build())?;
    tokio::spawn(async move {
        let _keep_alive = client_conn;
        std::future::pending::<()>().await;
    });
    Ok(conn)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    match args.get(1).map(String::as_str) {
        None => {}
        // Run by an AI's hook: says nothing and always succeeds.
        Some("--agent-hook") => {
            agents::hook::run(&args[2..]).await;
            return Ok(());
        }
        Some("--unhook-all") => {
            agents::unhook_all();
            return Ok(());
        }
        Some("--version" | "-V") => {
            println!("isled {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some("--help" | "-h") => {
            println!("{HELP}");
            return Ok(());
        }
        Some("--doctor") => {
            doctor().await;
            return Ok(());
        }
        Some("--report") => {
            report().await;
            return Ok(());
        }
        Some(other) => bail!("unknown option {other}; see isled --help"),
    }
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    // Before anything reads the environment or starts a thread.
    login_env::import();
    let session = open_session().await?;
    // A second isled (started by hand) leaves the running one alone, before it opens or prunes anything.
    if session.is_bus() && running(&session).await {
        bail!("isled is already running");
    }
    // The clipboard history lives here; keep it from other users, including
    // folders made by older versions.
    if let Err(err) = store::create_private_dir(&store::data_dir()) {
        warn!(
            "could not make {} private: {err}",
            store::data_dir().display()
        );
    }

    // One cover and one lyrics file per song: only the latest few hundred are kept.
    tokio::task::spawn_blocking(|| {
        for kind in ["art", "lyrics"] {
            store::prune_newest(&store::cache_dir().join(kind), CACHED_SONGS);
        }
    });
    let (assistant, assistant_commands) = AssistantService::new();
    let (usage, usage_refresh) = UsageService::new();
    let (updates, updates_wake) = UpdatesService::new();
    let server = session.object_server();
    server.at(OBJECT_PATH, MediaService::default()).await?;
    server.at(OBJECT_PATH, PomodoroService::load()).await?;
    server.at(OBJECT_PATH, TodoService::load()).await?;
    server.at(OBJECT_PATH, ShelfService::load()).await?;
    server.at(OBJECT_PATH, ClipboardService::load()).await?;
    server.at(OBJECT_PATH, CalendarService::load()).await?;
    server.at(OBJECT_PATH, RemindersService::load()).await?;
    server.at(OBJECT_PATH, SystemService::default()).await?;
    server.at(OBJECT_PATH, assistant).await?;
    server.at(OBJECT_PATH, usage).await?;
    server.at(OBJECT_PATH, updates).await?;
    server.at(OBJECT_PATH, AgentsService::default()).await?;

    let media = server.interface::<_, MediaService>(OBJECT_PATH).await?;
    let pomodoro = server.interface::<_, PomodoroService>(OBJECT_PATH).await?;
    let todo = server.interface::<_, TodoService>(OBJECT_PATH).await?;
    let system = server.interface::<_, SystemService>(OBJECT_PATH).await?;
    let assistant = server.interface::<_, AssistantService>(OBJECT_PATH).await?;
    let usage = server.interface::<_, UsageService>(OBJECT_PATH).await?;
    tokio::spawn(usage::run(usage, usage_refresh));
    let updates = server.interface::<_, UpdatesService>(OBJECT_PATH).await?;
    tokio::spawn(updates::run(updates, updates_wake));
    let agents = server.interface::<_, AgentsService>(OBJECT_PATH).await?;
    tokio::spawn(agents::watch(agents));
    let own_data = assistant::Sources {
        todo: todo.clone(),
        calendar: server.interface::<_, CalendarService>(OBJECT_PATH).await?,
        reminders: server.interface::<_, RemindersService>(OBJECT_PATH).await?,
    };

    let session_for_media = session.clone();
    tokio::spawn(async move {
        if let Err(err) = media::watch(session_for_media, media).await {
            warn!("media monitoring stopped: {err}");
        }
    });
    tokio::spawn(todo::run(todo));
    tokio::spawn(assistant::run(assistant, own_data, assistant_commands));

    match zbus::Connection::system().await {
        Ok(bus) => system::spawn_watchers(bus, system),
        Err(err) => warn!("no system bus, so no battery, network or Bluetooth status: {err}"),
    }

    // Claim the name last, so callers never see a half-initialised service; never taking it from another.
    if session.is_bus() {
        let claimed = session
            .request_name_with_flags(BUS_NAME, RequestNameFlags::DoNotQueue.into())
            .await
            .with_context(|| format!("could not own {BUS_NAME}"))?;
        if claimed != RequestNameReply::PrimaryOwner {
            bail!("isled is already running");
        }
        info!("isled is running as {BUS_NAME}");
    } else {
        println!("isled {} is running in standalone mode (ready, press Ctrl+C to stop)", env!("CARGO_PKG_VERSION"));
        info!("isled is running in standalone local mode (ready, press Ctrl+C to stop)");
    }
    // Started only now: a restored phase that ran out while isled was down finishes at once,
    // and clients only see its PhaseFinished signal if it comes from the claimed name.
    tokio::spawn(pomodoro::run(pomodoro));

    // Runs until the session bus goes (the session ended) or the name is lost; never outlives its
    // session, which would leave it polling with nobody to tell.
    if session.is_bus() {
        let lost = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender("org.freedesktop.DBus")?
            .interface("org.freedesktop.DBus")?
            .member("NameLost")?
            .build();
        let mut events = zbus::MessageStream::for_match_rule(lost, &session, None).await?;
        // systemd stops it with SIGTERM (at logout too); on Windows, Ctrl+C.
        #[cfg(unix)]
        let mut terminate = signal(SignalKind::terminate())?;
        tokio::select! {
            event = events.next() => match event {
                Some(Ok(_)) => info!("lost {BUS_NAME}; stopping"),
                Some(Err(err)) => info!("the session bus went away ({err}); stopping"),
                None => info!("the session bus went away; stopping"),
            },
            _ = async {
                #[cfg(unix)]
                {
                    terminate.recv().await
                }
                #[cfg(not(unix))]
                {
                    tokio::signal::ctrl_c().await.ok();
                    Some(())
                }
            } => {
                info!("asked to stop");
                store::flush();
                // At once, as the signal itself did: a download or helper still running goes with it.
                std::process::exit(0);
            }
        }
    } else {
        tokio::signal::ctrl_c().await.ok();
        info!("asked to stop");
        store::flush();
        std::process::exit(0);
    }
    store::flush();
    Ok(())
}

/// Hands memory freed after big, passing work (an image, an assistant's turn) back to the system.
fn trim_memory() {
    // SAFETY: malloc_trim only walks the allocator's own free lists.
    #[cfg(all(unix, target_env = "gnu"))]
    unsafe {
        libc::malloc_trim(0);
    }
}

/// Whether an isled already owns the name on this session's bus.
async fn running(bus: &zbus::Connection) -> bool {
    let Ok(dbus) = DBusProxy::new(bus).await else {
        return false;
    };
    match BUS_NAME.try_into() {
        Ok(name) => dbus.name_has_owner(name).await.unwrap_or(false),
        Err(_) => false,
    }
}

/// Whether an isled runs, from a connection of its own.
async fn is_running() -> bool {
    match zbus::Connection::session().await {
        Ok(bus) => running(&bus).await,
        Err(_) => false,
    }
}

/// `isled --doctor`: what works and what to do about what does not.
async fn doctor() {
    println!("isled {}", env!("CARGO_PKG_VERSION"));
    println!(
        "Service: {}",
        if is_running().await {
            "running"
        } else {
            "not running (systemctl --user restart isled)"
        }
    );
    println!("Voice assistant:\n{}", assistant::report());
    println!("AI alerts:\n{}", agents::report());
}

/// `isled --report`: what a bug report needs, to paste whole; it holds no clipboard, tasks or chats.
/// Printed as it goes; a reader that stops early (`| head`) just ends it.
async fn report() {
    // Rust's println! panics on a closed pipe; quitting quietly is what a shell tool does.
    // SAFETY: restores SIGPIPE's default disposition; no handler of ours is involved.
    #[cfg(unix)]
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
    let run = |program: &str, args: &[&str]| -> String {
        std::process::Command::new(program)
            .args(args)
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
            .unwrap_or_else(|err| format!("({program} failed: {err})"))
    };
    let env = |name: &str| std::env::var(name).unwrap_or_else(|_| "(unset)".into());
    let distro = std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("PRETTY_NAME="))
                .map(|name| name.trim_matches('"').to_owned())
        })
        .unwrap_or_default();
    println!("## Isle report\n");
    println!("- isled: {}", env!("CARGO_PKG_VERSION"));
    println!("- {}", run("gnome-shell", &["--version"]));
    println!("- System: {distro} ({})", run("uname", &["-m"]));
    println!(
        "- Session: {} on {}",
        env("XDG_SESSION_TYPE"),
        env("XDG_CURRENT_DESKTOP")
    );
    println!(
        "\n### Extension\n\n```\n{}\n```",
        run("gnome-extensions", &["info", "isle@zickrian.github.io"])
    );
    println!("\n### Doctor\n\n```");
    doctor().await;
    println!("```");
    println!(
        "\n### isled's log\n\n```\n{}\n```",
        run(
            "journalctl",
            &[
                "--user",
                "-u",
                "isled",
                "-n",
                "60",
                "--no-pager",
                "-o",
                "cat"
            ]
        )
    );
    let shell_log = run(
        "journalctl",
        &[
            "-b",
            "-n",
            "4000",
            "--no-pager",
            "-o",
            "cat",
            "/usr/bin/gnome-shell",
        ],
    );
    let isle_lines: Vec<&str> = shell_log
        .lines()
        .filter(|line| line.contains("Isle") || line.contains("isle@zickrian"))
        .collect();
    let recent = &isle_lines[isle_lines.len().saturating_sub(40)..];
    println!(
        "\n### GNOME Shell's log about Isle\n\n```\n{}\n```",
        recent.join("\n")
    );
}
