# Security policy

## Supported versions

Security fixes go into the latest release. Please update to it before
reporting.

| Version | Supported |
|---|---|
| 1.4.x | Yes |
| 1.3.x and older | No |

## Reporting a vulnerability

Please do not report security problems in public issues.

Report them privately instead, through **Security → Report a vulnerability**
on this repository, or by contacting the maintainer,
[@zickrian](https://github.com/zickrian), through the contact details on that
GitHub profile.

Include what you found, how to reproduce it, and what an attacker could do
with it. You will get a reply within 7 days. Once a fix is released, you are
credited in the changelog unless you would rather not be.

## Verifying a release

Each release's tarball, `.deb` and `.rpm` are built by GitHub Actions from
the tagged source and carry a build provenance attestation. With the
[GitHub CLI](https://cli.github.com):

```sh
gh attestation verify isle-<version>-x86_64-linux.tar.gz --repo zickrian/isle
```

`get.sh` also checks each download against the release's `.sha256`, and the
AUR package `isle-bin` checks the same tarball against the SHA-256 in its
`PKGBUILD`.

## What leaves your computer

Isle runs as your user, with no server of its own and no telemetry. It
connects to the network only for these:

| What | Where to | What is sent |
|---|---|---|
| Synced lyrics | [LRCLIB](https://lrclib.net) (`lrclib.net/api`) | The playing song's title, artist, album and length, once per song (then cached) |
| Cover art | The address the music player gives for the song's cover | A plain download of that picture, once per song (then cached) |
| Claude plan usage | `api.anthropic.com/api/oauth/usage` | Claude Code's own sign-in token, read from Claude Code's credentials; Isle never signs in or refreshes it. Off when AI usage, or Claude in it, is turned off |
| ChatGPT plan usage | `chatgpt.com/backend-api/wham/usage` | Codex's own sign-in token and account id, read from Codex's `auth.json`; Isle never signs in or refreshes it. Off when AI usage, or ChatGPT in it, is turned off |
| Grok plan usage | Grok's own billing (`cli-chat-proxy.grok.com/v1`, or the address set in Grok's own config; https only) | Grok's own sign-in token and user id, read from Grok's sign-in; Isle never signs in or refreshes it. Off when AI usage, or Grok in it, is turned off |
| Antigravity plan usage | Antigravity's own quota service, through the official `agy --print /usage --output-format json` (`agy` 1.1.11 or newer) | Antigravity's own sign-in, from its token file or the keyring; Isle never signs in or refreshes it. `agy` runs with Isle's own folder (`~/.local/share/isle/agy`) as its home, which shares your sign-in and its cached project id, nothing else. Off when AI usage, or Antigravity in it, is turned off |
| Voice assistant | The AI command-line app you picked (Claude Code, Codex, Antigravity or Grok), which sends it to its own service under your plan | The text of your request (speech is turned into text on this computer), the context it needs (time, open apps and windows, reminders and events, which Linux and package managers this is), the output of the checks and commands it runs for you (with keys, tokens and passwords blanked), the conversation so far and, only if you allow it, the selected text or your notifications |
| Web search by the assistant | Whatever the AI's own web search and page reading reach | Search words and page addresses the AI chooses for your request |
| Package checks by the assistant | Your package managers' own servers (npm's registry, Snap and Flatpak stores, dnf's mirrors) | Package names it looks up, when a check like `npm view codex` or `snap find vlc` asks them |
| Song check | `open.spotify.com/oembed` | A Spotify link the AI suggested, to check it exists before playing it |
| New versions | `api.github.com` (Isle's latest release) | A plain request, at most once a day; off when New versions is turned off in Settings |
| Speech model | `huggingface.co` (the official whisper.cpp and Silero files) | A plain download, only when you run `isle-setup-voice` (or press Set up); each file's SHA-256 is checked |
| Events you add to an account's calendar | That account's server (Google, or another in Online Accounts), through Evolution Data Server, as any calendar app sends it | The event's title, day and time, once, when you add it to that calendar (picked with the chip in the add field). Just before, isled opens a connection to that server and closes it, sending nothing, to see it is in reach; behind a proxy it skips that |

When ChatGPT can't be asked (offline, signed out), its limits are read from
Codex's own logs on this computer, with no network at all.

## What stays on your computer

- The clipboard history, shelf, reminders, calendar events kept in Isle (with
  Isle picked, with no account, or waiting for their calendar's server to be
  in reach), timer settings and the assistant's conversation, in `~/.local/share/isle`
  (readable by you only). The conversation is deleted, with the AI's own
  copy of it, at midnight at the latest (or after 30 minutes or 2 hours
  quiet, as set in Settings), on **+**, and on **Clear the conversation
  now**.
- Logs of the commands the assistant ran for you, in
  `~/.cache/isle/runs` (readable by you only), deleted once Isle has
  followed each to its end.
- Caches of covers and lyrics, in `~/.cache/isle`.
- What your login shell sets for your AI tools: once at start, isled runs
  your shell as a login shell to read its environment, and keeps only
  `PATH` and the variables those tools read (`CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `ANTHROPIC_*`, `CLAUDE_CODE_*`, `OPENAI_*`, `AWS_*`, proxy
  and certificate settings, where Node managers live). They stay in
  isled's memory and go only to the AI tools it starts.
- Your voice: speech is recognised by whisper.cpp (isle-whisper) on this computer, and
  the recording is never stored or sent.
- The call preview: GNOME Shell draws it from the call's window as it is on
  screen; nothing is recorded, and it hides while you share your screen.
- Meeting links: read from the event in your desktop calendars (Evolution
  Data Server) on this computer, and opened in your browser only when you
  click Join.
- AI agents: for each of Claude Code and Codex it finds (unless turned off
  in Settings), Isle adds its hooks to `~/.claude/settings.json` or
  `~/.codex/hooks.json`, keeping a copy of the file as it was
  (`*.isle-backup`) the first time. The hook runs `isled --agent-hook`,
  which passes what the agent asks (the project's folder name, the tool and
  its command or file) or its last message to the island over the session
  bus, and for a permission waits for your answer and prints it for the
  agent; nothing is sent anywhere. Only GNOME Shell can answer it. A
  command the island cannot show whole (over more lines, longer than 160
  characters, or with hidden characters) is never asked there: the agent
  asks in its terminal. **Always** keeps only the rule the agent suggests
  for that command or folder, never a change of its permission mode. Turning
  the switch off, or uninstalling Isle, removes Isle's entries and leaves
  the rest of the file as it is.

## Clipboard history

The history keeps text, links, images and files you copy, on this computer
only, and can be turned off in Settings. Copies marked as secrets by password
managers (`x-kde-passwordManagerHint`), and every copy from the apps on the
ignore list (KeePassXC, Bitwarden, 1Password, Secrets, Seahorse, Proton Pass
by default; editable in Settings), are never kept. When the password manager
quits, GNOME puts its last copy back without the mark; to leave that out too,
Isle keeps a salted hash of the secret in memory until the next copy, never
the secret itself. Clearing the history deletes its files.

## The voice assistant's safety model

- The AI only answers. It cannot run commands or change files itself: Isle
  runs its actions, and only those it knows (music, apps and windows, files,
  reminders and events, a few system settings, writing text where your
  cursor is).
- Each AI is started with only web search and reading pages: Claude Code with
  just its web tools, Codex with its shell, file, browser and computer-use
  tools off, agy in its own home folder behind a hook that refuses anything
  else, and Grok in its own home folder (sharing only your sign-in) with its
  terminal, file editing, task and image tools refused.
- Files: Isle searches by name for it, within your home folder and removable
  drives, and reads only small plain-text files you ask about. It skips
  hidden folders, never searches those that hold keys or passwords (`.ssh`,
  `.gnupg`, keyrings), judges a link by where it really points (a link to
  `~/.ssh` is `~/.ssh`) and does not follow links while searching. It opens
  documents and media, never programs, scripts or anything executable.
- Checks the AI asks for run at once only when they read, in exact shapes:
  each program on a fixed list with only the subcommands and options listed
  for it, then package names (`uname -a`, `cat /etc/os-release`, `apt-cache
  policy vlc`, `dpkg -s vlc`, `rpm -q vlc`, `dnf info vlc`, `pacman -Qi vlc`,
  `flatpak list --app`, `snap info vlc`, `npm view @openai/codex version`,
  `which node`, `<program> --version`…). Anything else (another file, an
  option that writes, edits or runs something, a path) is refused. They run
  directly with execve and no shell, so `;`, `|`, `&&`, redirects and `$( )`
  cannot add a second command.
- Every other command is shown in full on a card and runs only when you
  press **Run**: one line of at most 400 characters, with no hidden or
  reordering characters, so what you read is all that runs. Run and Deny
  (and Allow on an agent's alert) take no press in the first half second,
  so a click or Enter meant for something else never answers them. isled builds a `systemd-run` call for it; GNOME Shell starts
  it only if it is exactly that: Isle's own options, the log in Isle's
  folder, and the shown command last, unchanged. Root commands go through
  polkit (GNOME's password dialog), get only the system's folders on their
  `PATH` (so a program in your home cannot stand in for `apt`), and have
  their output written to the log by your user, not by root. Commands that
  would wipe the system or a disk are refused before you are asked, and a
  denied command is not tried again.
- Command output is passed to the AI with keys, tokens and passwords
  blanked, and at most its last 4 KB.
- Text from other apps (your selection, notifications, window titles,
  command output, web pages) is passed to the AI as data, never as
  instructions.

## Scope

Areas where a report is especially welcome:

- `isled`'s D-Bus API on the session bus (`docs/dbus-api.md`): input that
  crashes it, or reads or changes data it should not.
- The voice assistant: a way for a request, a web page, a file, a
  notification or other text to make Isle run something you did not ask for
  or did not see on the card, run a check that changes anything, read
  hidden or private files, or gain root without GNOME's password dialog.
- The AI agents' hooks: a way for another program to answer an agent's
  permission, or to read what the agents ask.
- The AI usage page: a sign-in token (Claude Code's, Codex's, Grok's or
  Antigravity's) sent anywhere but its own service, or written anywhere.
- The calendar: an event sent to a calendar you didn't pick, or one you
  deleted in Isle left in your account's calendar.
- The clipboard history in `~/.local/share/isle`: copies kept from apps on
  the ignore list or marked as secrets, or files readable by other users.
- Network requests: anything sent beyond what the table above lists.
- `isle-shelf`: files it opens or exposes that the user did not drop on it.
- The installers and packages (`get.sh`, `install.sh`, the `.deb`, `.rpm`
  and AUR package): files written outside the places they document.
