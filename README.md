<div align="center">

# Isle

**A notch-style island for the GNOME desktop.**

Music with synced lyrics, calls, notifications, a focus timer, reminders, a
calendar that tells you when to join a meeting, a clipboard shelf, app usage,
Claude Code and Codex asking you right there, and an assistant that installs and
fixes things with the AI you already use, living in a notch at the top of
your screen.

[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
![GNOME Shell 46–51](https://img.shields.io/badge/GNOME%20Shell-46%E2%80%9351-4a86cf.svg)
![Rust 1.92+](https://img.shields.io/badge/Rust-1.92%2B-orange.svg)
[![Buy me a coffee](https://img.shields.io/badge/support-buy%20me%20a%20coffee-ffdd00.svg)](https://sociabuzz.com/zickrian/tribe)

<img src="docs/images/demo.webp" alt="Isle on a GNOME desktop: the assistant playing music when asked, a command waiting for Run, every page of the island one hover away, and Claude Code asking for permission" width="800">

[![Watch the full demo on YouTube](https://img.shields.io/badge/Watch%20the%20full%20demo-2%20min%2C%20with%20sound-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://youtu.be/D65nLECDgOo)

</div>

Isle turns the centre of the top bar into a black notch.
At rest it shows the time and what is going on (a song, a timer, a
recording, or two of them at once). Rest the pointer on it and it opens with spring physics into a
small panel with tabs for each page; passing over it on the way elsewhere
leaves it closed. Alerts for volume, charging, Caps Lock and notifications
appear in the same place instead of in the middle of the screen.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Settings](#settings)
- [Voice assistant](#voice-assistant)
  - [The conversation](#the-conversation)
- [AI usage](#ai-usage)
- [Resource usage](#resource-usage)
- [Data & network](#data--network)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)
- [How it works](#how-it-works)
- [Contributing](#contributing)
- [Support](#support)
- [License](#license)

## Features

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/images/music.png" alt="Music page" width="100%"><br>
<b>Music.</b> Spotify, YouTube in your browser, or any MPRIS player: cover art with the playing app's icon, a scrubber and controls. Volume and output switching are one click away.
</td>
<td width="50%" valign="top">
<img src="docs/images/lyrics.png" alt="Synced lyrics" width="100%"><br>
<b>Synced lyrics</b> from <a href="https://lrclib.net">LRCLIB</a>: the line being sung large and bright, pauses as breathing dots. The island widens and takes the cover's colour; click a line to jump to it.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/call.png" alt="A Google Meet call in the island: its length, mute and open" width="100%"><br>
<b>Calls</b> in WhatsApp, Telegram, Meet or any app or browser: the closed island shows a green phone beside the time, and the Call page how long the call has lasted. Open it to see the call live (you and whoever you call) while you work in other windows, mute your microphone, or jump back to the call.
</td>
<td width="50%" valign="top">
<img src="docs/images/focus.png" alt="Timer page: the timer's ring, the work and break lengths, and Start" width="100%"><br>
<b>Timer.</b> A Pomodoro timer with breaks and Do Not Disturb while you focus: a ring with the time left, the work and break lengths to type or change with − and + (they hold still from Start until Reset), and Start. Its time left stays in the closed island; beside a song or a call, it shows as a small ring on the other side of the clock.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/reminders.png" alt="Reminders page: four reminders, one of them long" width="100%"><br>
<b>Reminders</b>, a plain list: add, rename in place, tick one off and it is struck through, then goes. A long one wraps over as many lines as it needs.
</td>
<td width="50%" valign="top">
<img src="docs/images/clipboard.png" alt="Clipboard history" width="100%"><br>
<b>Shelf.</b> A clipboard history of text, links, images and files (search, filter, pin; Super+V to paste), and a files tray: drop files on the island, then drag them into any app or click one to copy it, ready to paste into a chat.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/files.png" alt="The files tray with three pictures and a PDF" width="100%"><br>
<b>Files tray.</b> Files dropped on the island wait here, with their thumbnails, until you drag them into an app or click one to copy it.
</td>
<td width="50%" valign="top">
<img src="docs/images/calendar.png" alt="Calendar: the month beside the day's two events, and the time in New York, London and Tokyo under them" width="100%"><br>
<b>Calendar.</b> The month beside the chosen day's events. Shows your desktop calendars (Google and others through Online Accounts) and events you add in a line: "Dinner 8:00 pm". Five minutes before an event, the island reminds you, with <b>Join</b> when it has a Google Meet, Zoom, Teams or Webex link. Under them, the time in other cities: GNOME's world clocks.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/notifications.png" alt="The notifications page" width="100%"><br>
<b>Notifications.</b> GNOME's notifications collect here as a plain list, newest first, with their buttons ("Reply", "Mark as read") under the pointer, Clear, and Do Not Disturb a click away.
</td>
<td width="50%" valign="top">
<img src="docs/images/voice.png" alt="The voice assistant at work: what it heard, and the step it is on, finding jazz on Spotify" width="100%"><br>
<b>Voice assistant.</b> Press Super+I and ask, in English or Indonesian: play a song, find a file, put windows side by side, add a reminder, explain why the laptop is slow. It works as an agent: a request with several steps is done one after another, each step checked, with the AI you already use (Claude Code, Codex, Grok or Antigravity).
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/command.png" alt="The assistant's card for sudo apt install -y vlc: Needs your password, Deny and Run; then running, with its last lines and Stop" width="100%"><br>
<b>Installs and fixes things.</b> "Install LibreOffice", "pasang codex": it checks what your Linux has, searches the web when unsure, and shows the one command it wants to run, with what to know (your password, a script from the web, removing files). Press <b>Run</b> or <b>Deny</b>. It runs in the background while you carry on, and the assistant checks it worked before saying so.
</td>
<td width="50%" valign="top">
<img src="docs/images/conversation.png" alt="The conversation: install vlc, the command that ran with its time, and the answer" width="100%"><br>
<b>Speak or type, and talk it through.</b> It listens as soon as it opens; start typing to type instead. Scroll up for the conversation so far; select text to copy it, + for a new one. The bot turns to the pointer, blinks, bounces with your voice and changes expression as it thinks and answers, and the light round the edge rises as you speak. Close the island and it carries on in the background.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/bot-looks.png" alt="The bot in eight shapes and several colours, with matching glows" width="100%"><br>
<b>A bot of your own.</b> Eight shapes, from a circle to a cloud or a ghost, eleven colours or your own, softly shaded, and a glow round the island that matches it.
</td>
<td width="50%" valign="top">
<img src="docs/images/usage.png" alt="Claude plan usage: a bar for the 5-hour limit and one for the week" width="100%"><br>
<b>AI usage.</b> How much of your Claude and ChatGPT plans' limits is used: one plan at a time with its logo, a bar per limit it has (5 hours, the week) and when each resets; scroll up or down, or click the dots, to switch. A warning comes as one nears its end. Only the ones you are signed in to show.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/alerts.png" alt="The closed island with a song and the focus timer, then alerts for a meeting with Join, Claude Code asking to run a command, a notification with Reply, and charging" width="100%"><br>
<b>Alerts</b> for volume, brightness, Caps Lock, charging, low battery, Bluetooth devices with their battery, going offline, reminders, meetings about to start, AI plan limits and GNOME notifications with their buttons, in the same place instead of the middle of the screen. Hold the pointer on one to keep it, with a × on its icon to put it away (or swipe up). Isle's own icons move once as they appear: the bolt pulses, the bell sways, rings sweep and count up.
</td>
<td width="50%" valign="top">
<img src="docs/images/approvals.png" alt="Claude Code asking to run npm run build, with Deny, Allow and Always; then Allowed" width="100%"><br>
<b>AI agents.</b> When Claude Code or Codex asks permission to run something, answer from the island: <b>Deny</b>, <b>Allow</b> or, for Claude Code, <b>Always</b>. When one is done, the island says what it did. Nothing shows while you are in its window, and answering in its terminal works as before.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/apps.png" alt="Apps page: Brave Web Browser, Visual Studio Code, Ghostty and Discord with their times today" width="100%"><br>
<b>App usage.</b> Where your time goes: the application in front today, over the last seven days, or the last 30, with its icon, a bar and its time. Off until you turn it on, it times the app in front even when you are not typing or clicking; five idle minutes pause it unless a video holds the session awake, and locking the screen stops it. Kept on this computer for 30 days.
</td>
<td width="50%" valign="top">
<img src="docs/images/glass.png" alt="The music page in the glass island, the wallpaper behind it showing through, blurred" width="100%"><br>
<b>Glass.</b> The island in clear dark glass instead of black, if you prefer: what is behind it shows through, blurred, as you work. Choose it in Settings → Island → Appearance.
</td>
</tr>
</table>

Also: privacy dots while the camera, microphone or screen sharing is in use,
a recording timer with a stop button, and a slim glass top bar that leaves
your windows uncovered.

## Requirements

- **GNOME Shell 46 to 51** (Ubuntu 24.04 to 26.10, Fedora 40 to 45,
  Debian 13, …), on a 64-bit Intel or AMD PC (x86_64). Check with
  `gnome-shell --version`.
- `curl`, which most systems have. Install as yourself, not with `sudo`.
- For the voice assistant (optional): a microphone and
  one of Claude Code, Codex, Grok or Antigravity signed in (Codex and the npm
  install of Claude Code need Node.js 18 or newer); see
  [Voice assistant](#voice-assistant).

## Installation

1. Run this in a terminal:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/zickrian/isle/main/get.sh | bash
   ```

2. **Log out and back in**: GNOME Shell on Wayland only loads a new
   extension at login (on GNOME 46 to 48 with X11, press Alt+F2, type `r`
   and press Enter instead).

That's all. The script downloads the latest release, checks it, and installs
it for your user only: no root, no compiler and no cloning needed. Run the
same command again to update; your settings stay as you set them.

The [installation guide](docs/install.md) goes through it step by step, with
updating, uninstalling, installing offline and what to do if the island does
not appear.

> [!NOTE]
> The installer never changes other extensions. When one would fight with
> the island (Blur my Shell's top bar blur, or an extension that takes the
> same place in the top bar), it says so and how to turn that off. Isle's
> look is the same on every desktop: a slim top bar with no colour of its
> own, and the island as a black notch.

### Other ways to install

**Ubuntu and Debian (.deb), Fedora (.rpm).** Each
[release](../../releases) also has a system-wide package, for every user of
the computer. Install it, log out and back in (GNOME Shell only finds a new
extension at login), then turn Isle on once as each user, in the Extensions
app or with `gnome-extensions enable`:

```sh
sudo apt install ./isle_*_amd64.deb        # Ubuntu 24.04 and newer, Debian 13
sudo dnf install ./isle-*.x86_64.rpm       # Fedora 40 and newer
# Log out and back in, then:
gnome-extensions enable isle@zickrian.github.io
```

**Arch Linux.** Isle is not in the AUR yet (`yay -S isle-bin` finds
nothing). Build its package from the `PKGBUILD` in
[`packaging/aur`](packaging/aur), made from the release tarball, or use the
one-line install above:

```sh
sudo pacman -S --needed base-devel git
git clone --depth 1 https://github.com/zickrian/isle.git
cd isle/packaging/aur
makepkg -si
# Log out and back in, then:
gnome-extensions enable isle@zickrian.github.io
```

To update a package, install the new release's package the same way (or run
`makepkg -si` again with the updated `PKGBUILD`); don't also run the command
above, which would add a second copy in your home folder.

A copy installed with the command above, in your home folder, takes
precedence over a system-wide package; `isle-uninstall` removes it and the
package's takes over. Releases can be checked with
`gh attestation verify <file> --repo zickrian/isle` (see
[SECURITY.md](SECURITY.md#verifying-a-release)).

<details>
<summary><b>From the release tarball, or from source</b></summary>

**From a release package.** Download `isle-<version>-x86_64-linux.tar.gz`
from [Releases](../../releases), then:

```sh
tar -xzf isle-*-x86_64-linux.tar.gz
cd isle-*-x86_64-linux
./install.sh
```

**From source**, for development or other architectures. You need Rust 1.92
or newer (1.88 without the shelf helper) ([rustup](https://rustup.rs); Ubuntu 24.04's own `cargo` is too
old), for the shelf's drag and drop the GTK 4 development files, and for the
voice assistant's speech recognition (whisper.cpp) cmake, libclang, and for
the GPU the Vulkan headers and glslc:

```sh
sudo apt install git build-essential pkg-config libgtk-4-dev cmake libclang-dev libvulkan-dev glslc
# Fedora: git gcc-c++ pkgconf gtk4-devel cmake clang-devel vulkan-loader-devel glslc
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
git clone https://github.com/zickrian/isle.git
cd isle
./install.sh
```

</details>

## Usage

| Do this | To |
|---|---|
| Rest the pointer on the notch | Open the island (or click it, if Settings say so) |
| Click a tab, or scroll or swipe over the tabs | Switch pages (scrolling a page's own content never does) |
| Move the pointer away, or press Esc | Close it |
| Click the notch | Open it now; on an alert, open what it is about |
| Middle-click the notch | Play or pause |
| Rest the pointer on an alert | Keep it until the pointer leaves |
| Swipe up or down on an alert (touchpad) | Put it away, or open it |
| Right-click the notch | Put an alert away; else bring the call, or the music player, to the front |
| Super+V | Open the clipboard history with search ready; Enter pastes |
| Drag a file towards the notch | Open the files tray to drop it |
| Super+I | Ask the voice assistant; press again to finish speaking, or after an answer to ask more. Start typing (or click the keyboard) to type the request instead |
| Enter or Esc on the assistant's card | Run or Deny the command it shows |

The island reopens on the page you picked last (for five minutes), or on
what is live: a call, unseen notifications, music, a running timer. With two
music players running, the music page shows the other one's icon to switch
to it.

While a window is fullscreen (a video, a game), the island stays out of the
way: alerts, notifications and reminders wait and show once it is gone, and
a burst of notifications comes as one ("6 new notifications"), each still
unread in the list. A reminder stays until you are back at the computer.
While you share or record the screen, alerts leave out what notifications
say, and the clipboard history stays hidden. If Isle's background service
stops, a warning shows in the closed island; click it to start it again.

## Settings

Click the gear right of the clock in the open island (or Isle's gear in the
**Extensions** app):

- **Island:** Isle's own black island, or Glass, clear dark glass that shows what
  is behind it (windows and wallpaper) blurred, with a slider from clear to dark smoked glass; the top bar on a slider from glass (default) to black;
  a little space below the island inside the bar (on by default); privacy dots; which pages the open island has (Music,
  Notifications, Timer, Reminders, Shelf, Calendar, Apps, AI Usage) and whether it
  has the AI assistant at all; world clocks, and their cities;
  the closed island inside the bar or hanging below it; with more than one
  display, on the main one or the one you are using; opening when the
  pointer rests on it (and for how long) or only on a click.
- **Alerts:** apps' notifications in the island (or GNOME's own banners
  instead); volume and brightness; charging, network, Bluetooth and Caps
  Lock, each on its own; new songs, sounds; lyrics online;
  a reminder before calendar events, and how many minutes before.
  Alerts other than a low battery are not shown while Do Not Disturb is on.
- **Calls:** show calls in the island, and the live preview of the call.
- **Clipboard:** turn the history on or off, clear it, what Super+V opens (the
  clipboard history, or GNOME's calendar), and choose apps whose copies are never
  kept (password managers are on the list from the start).
- **Timer:** session and break lengths, Do Not Disturb while focusing.
- **Assistant:** the bot's look (shape, colour, glow, with a live
  preview); the assistant on or off, its shortcut, which AI answers and with
  which model (only those your plan includes, with your plan's name), speech recognition, language, and whether it may use the text
  you selected (off by default) or read your notifications; how long a quiet
  conversation is kept, and clearing it now.
- **AI Usage:** on or off, which plans to show, and when to warn; and
  under **AI Agents**, a switch for each of Claude Code and Codex that is
  installed (on by default; none listed when neither is).
- **About:** the version and whether it is up to date (with how to update,
  and the switch for asking GitHub once a day), help, a bug report to copy
  (`isled --report`), and resetting every setting.

## Voice assistant

Press **Super+I** (or the mic in the open island) and speak. The island
listens until you pause, turns your words into text **on this computer**,
then asks the AI you picked; it shows each step ("Searching ~/Downloads for
“signature”…") and does what the answer asks.

It works as an **agent**: a request with several steps ("open Firefox, then
put it on the left", "find my CV and open it", "open Spotify, play some
jazz and turn the volume down to 30") is done one step after another, each
step seeing what the last one did (whether the app opened, which windows
are there). You can **close the island while it works**: it carries on in
the background, with a small mic in the closed island, and the answer comes
as an alert; click the island or press Super+I to watch it, and **Stop** to
end it. Its answer's own actions run before it answers, so it never
says "done" when a step failed: it tries another way, or says what did not
work.

**What it does:** music (play, pause, a given song on Spotify), apps and
windows (open, switch to, close, minimize, fullscreen, put side by side or
in a 2×2 grid: "split Chrome and VS Code 50/50"), files and folders
(find, open, show in Files), reminders, to-dos and calendar events (add,
change, remove), Wi-Fi, Bluetooth, Do Not Disturb, volume, brightness, dark
mode, Night Light, settings panels, screenshots, writing text where your
cursor is, answering questions (with a web search when it needs fresh
facts), telling you what makes the computer slow, and installing, removing
or fixing software with a command you approve. Ask a follow-up while the
answer shows, or later the same day: it remembers the conversation (see
[the conversation](#the-conversation)).

**Installing and fixing things.** Ask "install LibreOffice" and it looks
first: which Linux this is, which ways to install it has (apt, dnf, pacman,
zypper, Flatpak, Snap, npm), whether the app is already there, and when
unsure, the vendor's own instructions on the web. Then the island shows a
card with the one command it proposes, why, and what to know about it:
**Needs your password** (it runs as root), **Runs a script from the web**,
or **Removes files or apps**. Press **Run** (Enter) or **Deny** (Esc); with
the island closed, the card comes as an alert. A command runs in the
background as a systemd unit of its own, so you can close the island or
lock the screen, and Isle follows it to its end, even after isled restarts
(a command still running when you log out ends with your session); the card
shows how long it has run and its last lines, and **Stop** ends it (for a
package manager, press it twice: stopping one halfway can leave things half
done). When it ends, the assistant checks that it worked (`libreoffice
--version`) before saying so; denied, it does not try again. One command
runs at a time, and nothing waits forever: an unanswered card is denied
after 10 minutes, and a command is stopped after 30.

**Set up:**

1. Install and sign in to one AI command-line app (it uses your own plan):

   | AI | Install | Sign in | Notes |
   |---|---|---|---|
   | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `curl -fsSL https://claude.ai/install.sh \| bash` (or `npm i -g @anthropic-ai/claude-code`) | run `claude` | Uses your Claude plan; Sonnet by default; Haiku is the fastest but follows the request's language and tools less reliably |
   | [Codex](https://github.com/openai/codex) (ChatGPT) | `npm i -g @openai/codex` | `codex login` | How Isle uses ChatGPT: your ChatGPT plan (Free works too, with lower limits), with the model your Codex uses |
   | [Grok](https://x.ai/build) | `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` | Uses your Grok plan (Free works too); Isle runs it in its own folder, kept to answering |
   | [Antigravity](https://antigravity.google) | its installer | run `agy` | Its terms bar third-party tools from the service; Isle only runs the official `agy`, at your own risk |

   Settings → Assistant lists only the models your plan includes, by their full names, with your plan's
   name. If your plan stops including the one you picked (a subscription that lapsed), Isle answers with
   the plan's default and says so once, then goes back to your pick when the plan includes it again.
   Claude's Fable models are not offered: in the assistant they would use your usage credits without asking.

2. Set up speech recognition, once: press **Set up** when the assistant asks
   for it, or run `~/.local/bin/isle-setup-voice` in a terminal (`isle-setup-voice` with a .deb,
   .rpm or AUR package; from the source folder: `scripts/setup-voice.sh`). It downloads the speech
   model chosen in Settings, `small` by default (265 MB; `tiny` 44 MB, `base`
   82 MB, `medium` 823 MB; `isle-setup-voice base` names one and picks it in
   Settings), which `isle-whisper` runs with
   [whisper.cpp](https://github.com/ggml-org/whisper.cpp): nothing else to
   install. On a computer with a graphics card (NVIDIA, AMD or Intel Arc,
   through Vulkan) it runs there, in about a second; otherwise on the
   processor, in several seconds (it needs AVX2: Intel since 2013, AMD since
   2015). An older Isle's Python environment (up to 3 GB) is no longer
   needed: updating Isle moves you over and deletes it by itself, or run
   `isle-setup-voice --remove-old`.
3. Pick the AI in **Settings → Assistant**, or leave it on Automatic, which
   uses the first one you are signed in to: Claude Code, then Codex, then
   Grok, then Antigravity. An AI installed later is found by itself.
4. Check with `~/.local/bin/isled --doctor` (`isled --doctor` with a
   package): it lists speech recognition (the models
   downloaded, and the GPU or processor it runs on) and each AI, where it is
   installed and whether you are signed in, as Isle itself sees them.
   Isle finds AIs installed with npm (also a prefix of your own), nvm,
   volta, fnm, pnpm, bun, Homebrew, mise, asdf, Nix or their own installers,
   and takes what your login shell sets for them (`CLAUDE_CONFIG_DIR`,
   `CODEX_HOME`, an API key, a proxy), as code editors do.

Without any of them, Super+I says what to install, and the rest of Isle works
as before.

**Safety:** the AI only answers. It cannot run commands or change files
itself: Isle runs its actions, which are limited to the ones above. Each AI
is started with only web search and reading pages: Claude Code with just its
web tools, Codex with its shell, file, browser and computer-use tools off,
and agy behind a hook that refuses anything else.

- **Looking** runs at once, without asking, but only programs on a fixed
  list that only read (`uname`, `cat /etc/os-release`, `apt-cache policy`,
  `dpkg -s`, `rpm -q`, `dnf info`, `pacman -Qi`, `flatpak list`, `snap
  info`, `npm view`, `which`, `<program> --version`, `df`, `free`…), each run
  directly with its arguments, never through a shell, and never with an
  option that would install, remove or change anything.
- **Changing** anything is a command you see in full and run yourself with
  **Run**. Isle starts exactly the command on the card and nothing else
  (GNOME Shell checks this before starting it); one that needs root asks
  with GNOME's password dialog, gets only the system's own folders on its
  `PATH`, and its output is written to its log as you, not as root. Commands
  that would wipe the system (`rm -rf /` or your home folder, `mkfs`, `dd`
  onto a disk, a fork bomb) are refused before you are even asked.
- **Files:** Isle searches your files by name for it, reads small text
  files you ask about, opens documents and media but never programs, and
  never looks in hidden folders that hold keys or passwords (`.ssh`,
  `.gnupg`, keyrings), even through a link. Secrets in a command's output
  (keys, tokens, passwords) are blanked before the AI sees it.
- Text from other apps (your selection, notifications, window titles, a
  command's output, web pages) is passed as data, never as instructions.

**Resources:** the speech model runs only while you speak (on at most half
the processor's cores) and quits once your words are text. The AI starts as
you open the assistant, so it answers sooner, and quits 3 minutes after
your last request, taking anything it started with it. Both run at a lower
priority than your apps, so the desktop stays smooth while they work.

### The conversation

What you said and what it answered show as a conversation: scroll up on
the assistant, or click the line above the field. Select text to copy it,
click a command to copy that. **+** starts a new conversation; **Undo**
brings the last one back for 5 seconds. A conversation is kept until
midnight at the latest, or until it has been quiet for 30 minutes or 2
hours if you choose so in Settings; then it is deleted, with the AI's own
copy of it. **Settings → Assistant → Clear the conversation now** deletes it
at once. Your voice is never kept: the recording lives in memory only until
it is text. The conversation is kept in `~/.local/share/isle/chat.json`,
readable by you alone, and the AI's copy apart from your own chats with it.

## AI usage

Isle finds your plans from the apps you are signed in to: **Claude** with
Claude Code's sign-in, and **ChatGPT** with Codex's.
It shows each limit your plan has (a 5-hour window, the week, a model's
week), when it resets, and warns at 80% and 95% (set in Settings). A plan
you are not signed in to does not show at all.

Claude's numbers come from the same page Claude Code's `/usage` reads, and
ChatGPT's from the one Codex's `/status` reads; neither is a documented API,
so they may change. Isle asks each every ten minutes (at
most every two while the Usage page is open), and not while the screen is
locked. Offline, as at login before the
network is up, it tries again within a minute; when Claude's server fails it
waits longer each time. It never signs in or refreshes a sign-in itself, and
with usage turned off it asks nothing at all. When ChatGPT can't be asked
(offline, or Codex's sign-in ran out), its numbers come from Codex's own
logs, as of your last use of Codex.

**AI agents.** Isle connects to Claude Code and Codex when it finds them,
also when you install one later, and says so once. It adds its hooks to
`~/.claude/settings.json` (PermissionRequest, Notification and Stop) and to
`~/.codex/hooks.json` (PermissionRequest and Stop); Codex asks once, at its
next start, whether to trust them (or trust them in `/hooks`), and a Codex
older than 0.124 gets `notify` in its `config.toml` instead, for done
alerts only. Each hook runs `isled --agent-hook`, which asks the island and
waits for your answer. With no answer (the alert put away, the agent's
window in front, Do Not Disturb, isled not running) it says nothing, and the
agent asks in its terminal as it would without Isle; answering in Claude
Code's terminal first takes the alert away. **Always** keeps the rule
Claude Code itself suggests, where it suggests it (usually the project's
`.claude/settings.local.json`). Your own hooks and settings are kept as they
are; turning a switch off in **Settings → AI Usage → AI Agents**, or
uninstalling Isle, takes out Isle's entries only. Nothing leaves the
computer.

## Resource usage

Isle is built to run all day unnoticed. Measured on Ubuntu 24.04 with
GNOME 46 (version 1.0.0):

| Part | Memory | CPU when idle |
|---|---|---|
| `isled` (background service) | about 10 MB resident, of which under 1 MB its own | 0% (no polling: it wakes for real events and deadlines only) |
| Extension, inside GNOME Shell | about 10 MB more for the shell, flat over hours of use | 0% when nothing moves |
| `isle-shelf` (drag and drop) | about 43 MB (GTK 4, drawn on the CPU, no GPU driver loaded); only while the files tray is open, and 20 seconds after | 0% |
| Voice assistant | the AI only while it works and for 3 minutes after, so a follow-up starts at once (Claude Code about 290 MB, Codex about 160 MB); speech recognition only while the island listens | 0% between requests |

| On disk | Size |
|---|---|
| Programs (`isled` 6.8 MB, `isle-shelf` 0.7 MB) | 7.5 MB |
| Speech recognition (`isle-whisper` 29 MB, most of it GPU code; the `small` model 265 MB), only once set up | 294 MB |
| Extension | 0.8 MB |
| Inter typeface | 0.9 MB |
| Cache (`~/.cache/isle`) | about 100 KB per song's cover and 6 KB per lyrics |

Animations run on the display's frame clock only while a spring moves and
stop when it settles: closed and idle, Isle draws no frames at all, and over 40
openings, page changes, lyrics and alerts 99.8% of frames came in time for 60 Hz. The clock wakes once a minute, lyrics exactly when the
next line starts, and pages only tick while they are open; only while the
music page shows does Isle ask the player where it is, once a second. The call preview
reuses the window's picture already on the graphics card, so it costs about
nothing, and only exists while the Call page is open; Isle never opens the
camera or the microphone itself.

## Data & network

Isle has no server and no telemetry; your clipboard history, reminders,
events, timer, app usage and the assistant's chats stay in
`~/.local/share/isle`, and speech is recognised on this computer. It goes
online only for synced lyrics ([LRCLIB](https://lrclib.net)) and cover art,
once per song (lyrics can be turned off in Settings); your Claude plan's
usage (`api.anthropic.com`, with
Claude Code's own sign-in); a look for a newer Isle on GitHub at most once a
day (also in Settings); the speech model, downloaded once from Hugging Face
when you set up voice; and the voice assistant, whose requests go to the AI
you picked and may include a web search by it. A meeting's link is read
from the event on this computer, and only opened when you click Join.
Copies from password managers
are never kept, and only GNOME Shell may read the clipboard history from
Isle's service or steer its assistant. The call preview is drawn by GNOME
Shell from what is on screen and never recorded.
[SECURITY.md](SECURITY.md#what-leaves-your-computer) lists exactly what is
sent where, and the assistant's safety rules.

## Troubleshooting

**The island does not appear after installing.** Log out and back in (on
Wayland this is required once). Then check that it is enabled:
`gnome-extensions info isle@zickrian.github.io`.

**Music or lyrics do not show.** Check that the background service runs:
`systemctl --user status isled`, and read its log with
`journalctl --user -u isled -f`. Songs LRCLIB does not know show "No lyrics
found"; a busy service retries on its own.

**Files cannot be dragged in or out.** The release package includes the
drag-and-drop helper; when building from source, install `libgtk-4-dev`
(Fedora: `gtk4-devel`) and run `./install.sh` again.

**Another extension covers the island.** Extensions that restyle or move the
top bar (Dash to Panel, Hide Top Bar, other islands) can get in the way;
turn them off in the Extensions app.

**The voice assistant does not answer.** Run `~/.local/bin/isled --doctor`: it says what
is missing (speech recognition, an AI, or its sign-in) and what to run.

**Something else.** Run `~/.local/bin/isled --report` (or Settings → About → Copy a bug
report): it gathers the versions, what works and recent logs, without your
data. Please [open an issue](../../issues) and paste it there.

With a .deb, .rpm or AUR package, Isle's commands are in `/usr/bin`: run
them by name alone (`isled --doctor`, `isled --report`).

## Uninstalling

```sh
~/.local/bin/isle-uninstall
```

(or `./uninstall.sh` from the release package or the source folder). This
removes the extension, the programs, the service, the font, the voice
assistant's speech recognition and Isle's caches, and lifts a battery charge
limit Isle set; it also takes Isle's hooks out of Claude Code's and Codex's
settings. Your tasks, calendar events, clipboard history, shelf and
timer settings stay in `~/.local/share/isle` until you delete them.

Remove Isle this way, not with the Extensions app's Remove button, which
deletes only the extension and leaves `isled` and its hooks behind. For a
system-wide package, each user runs `isled --unhook-all` first (and
`isle-charge-limit 100` if the assistant set a battery charge limit), then
remove it with `sudo apt remove isle`, `sudo dnf remove isle` or
`sudo pacman -R isle-bin`.

## How it works

```
┌────────────────── isled (Rust) ──────────────────┐
│ MPRIS · lyrics · timer · tasks · calendar · shelf│
│ UPower · NetworkManager · BlueZ                  │
│ voice assistant · AI usage · AI agents · meetings│
│            exposed on D-Bus (zbus)               │
└────────────────────────┬─────────────────────────┘
           ┌─────────────┴──────────────┐
  GNOME Shell extension (JS)      isle-shelf (Rust, GTK 4)
  draws the island and its        drag-and-drop window laid
  animations                      over the files tray
```

GNOME Shell extensions are written in JavaScript, and on Wayland only the
shell can draw into the top bar. So the extension only draws, and everything
else lives in Rust behind a D-Bus API.

| Path | Contents |
|---|---|
| `crates/isle-core` | Platform-independent logic: LRC parsing, track-title clean-up, Pomodoro, tasks, calendar, shelf, clipboard history. Unit tested. |
| `crates/isle-daemon` | `isled`, the D-Bus service; `src/assistant` is the voice assistant (speech, the three AIs, the agent loop, its tools), `src/usage.rs` the AI usage, `src/agents` the AI agents' hooks, `src/meeting.rs` meeting links, `src/updates.rs` the look for new versions, and `src/caller.rs` who may call what. |
| `crates/isle-shelf` | `isle-shelf`, the files tray's drag-and-drop window. |
| `crates/isle-whisper` | `isle-whisper`, the voice assistant's speech recognition: whisper.cpp, on the GPU through Vulkan or on the processor. |
| `gnome-extension` | The GNOME Shell extension; `src/actionRules.js` holds the assistant's rules that need no GNOME, so they are tested anywhere. |
| `tests/extension` | Tests of the extension's GNOME-free parts (`node --test`, and `gjs -m` for those that use GLib). |
| `data` | systemd and D-Bus activation files, and the Inter typeface. |
| `scripts` | `setup-voice.sh` (installed as `isle-setup-voice`), `isle-charge-limit`, and `package.sh`, which makes a release. |
| `docs/product-spec.md` | How the island looks and behaves: sizes, motion, pages, alerts. |
| `docs/dbus-api.md` | The D-Bus interfaces of `isled` and `isle-shelf`. |

## Contributing

Bug reports, ideas and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to build, test and send changes,
and [CHANGELOG.md](CHANGELOG.md) for what changed. Everyone taking part
follows the [Code of Conduct](CODE_OF_CONDUCT.md); please report security
problems privately as described in [SECURITY.md](SECURITY.md).

### Contributors

Thanks to everyone who has made Isle better:

- [@caffeinepx](https://github.com/caffeinepx): Grok in the voice assistant
  and on the AI usage page; music from Zen and Firefox that keeps its place;
  a sun or a moon by each World Clock.
- [@Ashishranjan980](https://github.com/Ashishranjan980): the Apps page, where
  your time in each app goes.

## Support

Isle is free and always will be. If it makes your desktop nicer, you can
[buy me a coffee](https://sociabuzz.com/zickrian/tribe). A star, a bug report
or telling a friend helps just as much.

## License

Copyright © 2026 zickrian

Isle is free software: you can redistribute it and/or modify it under the
terms of the [GNU General Public License](LICENSE) as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the [GNU General Public License](LICENSE)
for more details.

The bundled [Inter](https://rsms.me/inter/) typeface (`data/fonts`) is under
the [SIL Open Font License 1.1](data/fonts/Inter-LICENSE.txt). Lyrics come
from [LRCLIB](https://lrclib.net). The Claude and OpenAI logos on the AI usage page
come from [Simple Icons](https://simpleicons.org) (CC0); they are trademarks of
Anthropic and OpenAI, shown only to name their plans. The assistant's face
takes its expressions from [bloub](https://github.com/jeremy-prt/bloub) by
Jérémy Perret, under the MIT License
([notice](gnome-extension/NOTICE-bloub.txt)). The calendar icon takes its shape
from [Lucide](https://lucide.dev)'s "calendar-days", under the ISC License
([notice](gnome-extension/NOTICE-lucide.txt)).

The demo video shows "Clouds" by Tibor Mokanszki from the Ubuntu 24.04
wallpapers, under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/);
the video is shared under the same licence. Its songs, lyrics, notifications
and events are made up.
