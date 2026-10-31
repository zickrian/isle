# isled D-Bus API

`isled` owns `io.github.zickrian.isle.Daemon` on the session bus and serves every
interface at `/io/github/zickrian/isle/Daemon`. State is exposed as read-only string
properties holding JSON, with `PropertiesChanged` emitted on every change.
Timestamps are milliseconds since the Unix epoch; durations are
milliseconds unless the name says `_us` (microseconds).

Methods that read what the user copied (`Clipboard1.GetText` and `Search`), steer the
assistant (every `Assistant1` method but `ClearChat`), answer an AI agent
(`Agents1.Resolve` and `SetPresent`) or change an AI's settings (`Agents1.SetHooked`) answer
GNOME Shell only, where the extension runs; any other caller gets
`org.freedesktop.DBus.Error.AccessDenied`.

`isled --version`, `isled --doctor` (what works: the service, speech
recognition, each AI's install and sign-in, and whether its alerts are on) and
`isled --report` (that, the versions and recent logs, for a bug report) print
and exit. `isled --unhook-all` takes Isle's alert hooks out of Claude Code's
and Codex's settings (`uninstall.sh` runs it), one line per AI. A second
`isled` started by hand exits at once ("already running") and leaves the
running one alone.

## io.github.zickrian.isle.Media1

The active MPRIS player: the one picked with `Choose` while it runs, else the one playing, else the one
that played last. Another player starting to play ends the pick.

| Member | Signature | |
|---|---|---|
| `PlayPause()`, `Next()`, `Previous()` | | Control the active player. |
| `SetPosition(x position_us)` | | Seek to an absolute position. |
| `Raise()` | | Bring the player's window to the front. |
| `Choose(s name)` | | Show and control the player `name` (from `Players`). |
| `SetLyrics(b enabled)` | | Look lyrics up online (LRCLIB), or not; off, `Lyrics` says `off`. The extension sends its setting whenever isled appears. |
| `SetWatching(b watching)` | | While on, read the active player at once and then every second it plays (every 0.35 s to confirm a read that fell behind or while it buffers, every 0.5 s after a read that was off or while a new speed is measured, every 10 s after a read failed). The extension turns it on only while the open island shows the position (the player or lyrics), and sends it again whenever isled appears; off, isled sets no timer at all. |
| `NowPlaying` | `s` | `{available, identity, desktop_entry, status, title, artist, album, art_path, length_us, position_us, sampled_at_ms, rate, can_go_next, can_go_previous, can_play_pause, can_seek}` |
| `Lyrics` | `s` | `{track, status, lines: [{time_ms, text}]}`; `status` is `none`, `loading`, `synced`, `plain` (lines have `time_ms` -1), `instrumental`, `not_found`, `error` (LRCLIB could not be reached), `unavailable` (LRCLIB answered but is busy or failing) or `off` (turned off with `SetLyrics`); isled retries `error` and `unavailable` on its own. |
| `Players` | `s` | `[{name, identity, desktop_entry, playing, active}]`, sorted by name; empty unless two or more players run. |

The position is sampled when something changes, and while watched (see
`SetWatching`) every second as well: MPRIS signals no progress, and players
signal stalls, ads and seeks made inside them unreliably. While playing, the
current position is `position_us + (now - sampled_at_ms) * 1000 * rate`.
A player that reports position 0 while it is still playing (Firefox and Zen do)
does not move that sample; a `Seeked` signal does, and its position is the one
kept. A browser's read more than 1.5 s behind the sample is kept only once the
next read moved on from it at a speed a player plays at (a stall, not a stale
read); so is a 0 from any player's poll. Firefox reads whole seconds, cut
down: once three reads in a row are whole seconds, a read moves the sample
only when the sample falls outside the second after it. `rate` is the player's `Rate`, unless
two agreeing steps between reads show another speed (0.25–4, a player that keeps
`Rate` at 1 while it plays faster); that measure ends with a seek, a pause, the
song or a new `Rate`. While two reads in a row stand at the same place though
the player says it plays (buffering), `rate` is 0 until a read moves on. A length that disappears for the same track is kept.
While playing with no length yet, isled reads the player again after 1s and
after 3s. A relative seek, used when the player gives no track id, is measured
from this position when the player's own `Position` read is 0.

The control methods only fail when no player is running. They return
without waiting for the player, so a slow player cannot hold the daemon up;
if the player then rejects the command, isled only logs it.

## io.github.zickrian.isle.Pomodoro1

| Member | Signature | |
|---|---|---|
| `Start()` | | Start a focus session, or resume a paused phase. |
| `StartPhase(s phase)` | | Start `focus`, `short_break` or `long_break` right away (`idle` stops). |
| `Pause()`, `Stop()`, `Skip()` | | `Skip` ends the phase early without counting it. |
| `SetConfig(s json)` | | Replace the configuration (below). |
| `State` | `s` | `{phase, running, ends_at_ms, started_at_ms, remaining_ms, duration_ms, completed_sessions, sessions_before_long_break, today_sessions, today_focus_ms}`; `phase` is `idle`, `focus`, `short_break` or `long_break`; `started_at_ms` is when the phase first ran, null while it waits to be started (a focus session after a break, without `auto_start_focus`). |
| `Config` | `s` | `{focus_minutes, short_break_minutes, long_break_minutes, sessions_before_long_break, auto_start_breaks, auto_start_focus}` |
| `PhaseFinished(s finished, s next)` | signal | A phase ran out (not emitted for `Skip` or `Stop`). |

## io.github.zickrian.isle.Todo1

| Member | Signature | |
|---|---|---|
| `Add(s text) → t id` | | Adds a task; a blank title is refused. |
| `SetDone(t id, b done)`, `Rename(t id, s title)`, `Remove(t id)`, `ClearDone()` | | Finished tasks are cleared at midnight. |
| `Items` | `s` | `[{id, title, done, done_at_ms}]`; `done_at_ms` is when the task was ticked off, or null. |

## io.github.zickrian.isle.Calendar1

Isle's own calendar events, kept in `~/.local/share/isle/calendar.json`.
Times are local wall-clock times. (Events of the desktop's calendars come
from GNOME Shell, not from here.)

| Member | Signature | |
|---|---|---|
| `Add(s date, s text) → t id` | | Adds an event on `date` (`YYYY-MM-DD`) from a line of text, taking its time from it: `Dinner 8:00 pm`, `Standup 9:00-9:15`, `Gym at 7pm`; without a time it lasts all day. A date that does not exist, or no title left, is refused with `InvalidArgs`. |
| `AddTo(s calendar, s date, s text) → s` | | As `Add`, to a desktop calendar: a uid `Calendars` lists, or `"isle"` for Isle's own; `""`, or a uid no longer there, tries each account calendar in order (without waiting on which only read: one that does turns the event down). When none takes it (read only, offline, signed out) the event is kept in Isle's own instead. A calendar out of reach (EDS offline, or its server not taking a TCP connection within 3 seconds; behind a proxy, EDS's word is taken) isn't written to, as EDS would only queue the event: the event waits in Isle's own (its `send`) and isled tries it again every 30 seconds with the same iCalendar uid, so it never lands twice; once there it leaves Isle's own. It stays in Isle's own for good when its calendar goes, or turns it down 10 times running. One its server had, with no answer within 20 seconds, counts as added, so it never shows twice; one still on its way to the server by then waits in Isle's own as above. Returns where it went: the calendar's uid, or `""` for Isle's own. |
| `Calendars() → s` | | The desktop's calendars a new event can go to, `[{uid, name, account, color}]` by account (its own calendar first) and name: those of Online Accounts and other accounts in Evolution Data Server, without the ones that only read (birthdays, weather, web subscriptions, and any EDS reports as not `Writable`, such as a subscribed holiday calendar) nor EDS's own on this computer. `[]` without accounts; fails (Failed) while EDS can't be asked (not running yet), so that is never taken for no accounts. |
| `Colors() → s` | | Every desktop calendar's colour, `{uid: "#rrggbb"}`, read only ones too: GNOME Shell's events name their calendar's uid on the first line of their id. `{}` without EDS. |
| `Parse(s text) → s` | | How `Add` reads `text`, without adding it: `{title, start, end}`, times as `HH:MM` or null. Fails (InvalidArgs) when no title is left. |
| `Remove(t id)` | | One waiting to be sent is taken out of its calendar too, in case a try with no answer got it there. |
| `MeetingLink(s source_uid, s event_uid) → s` | | The meeting link of a desktop calendar's event (the first two lines of the id GNOME Shell's calendar server gives it), or `""`. |
| `Events` | `s` | `[{id, title, date, start, end, send?}]` by day and time; `start` and `end` are `HH:MM` or null (all day; no end given); `send` (`{calendar, uid}`) on one waiting to go to a desktop calendar out of reach (see `AddTo`). Events over 400 days old are forgotten. |

`AddTo` writes through Evolution Data Server: `CalendarFactory.OpenCalendar`,
`Calendar.Open`, `CreateObjects([event], 0)` and `Close`, each step given five
seconds. The event is one `VEVENT` with its times in UTC (an hour long without
an end; a whole day without a time). `Calendars` reads the sources from
`org.gnome.evolution.dataserver.Sources5` (`ObjectManager.GetManagedObjects`),
leaving out those turned off, and those of an account whose calendars are off.
Each one left is opened once (`OpenCalendar`, and `Calendar.Open` when it
reads as read only, then asked again for up to 3 seconds, as a calendar just
opened reads as read only until it has reached its server) for its `Writable`
property. Writable is remembered while isled runs; read only, for an hour, and
only from a server that takes a connection (out of reach, EDS calls a calendar
read only for now).

`MeetingLink` reads the event from Evolution Data Server
(`org.gnome.evolution.dataserver.Calendar8`, else `Calendar7`:
`CalendarFactory.OpenCalendar`, then `Calendar.Open`, `GetObject(uid, "")` and
`Close`) and looks in its `X-GOOGLE-CONFERENCE`, `URL`, `LOCATION` and
`DESCRIPTION`, in that order, for the first `https://` link to Google Meet
(`meet.google.com`), Zoom (`zoom.us` or `*.zoom.us`, `/j/`, `/my/` or `/w/`),
Microsoft Teams (`teams.microsoft.com/l/meetup-join/` or `/meet/`,
`teams.live.com`) or Webex (`*.webex.com`). Answers are kept for six hours (at
most 256 events). Without EDS (not installed, masked or not answering within
five seconds) it is `""`; empty or over-long ids are refused with
`InvalidArgs`.

## io.github.zickrian.isle.Shelf1

| Member | Signature | |
|---|---|---|
| `Add(as uris)` | | Add local `file://` URIs (moved to the front if already there). The shelf holds 6 files: files that do not fit are refused with `LimitsExceeded`. Other URIs are skipped and reported with `InvalidArgs` once the rest are added. |
| `Remove(s uri)`, `Clear()` | | |
| `Refresh()` | | Drop items whose files no longer exist, shortly after it returns. A file that does not answer within two seconds (a network mount gone offline) stays. |
| `Items` | `s` | `[{uri, name, added_at_ms}]`, newest first. |

## io.github.zickrian.isle.Clipboard1

Clipboard history. The extension watches the clipboard and reports each
copy; isled keeps the list in `~/.local/share/isle/clipboard.json` and
images in `~/.local/share/isle/clips` (`<hash>.png` as copied, plus a
`<hash>.thumb.png` that fits in 320×200). `app_id` is the desktop app id
of the app copied from, or `""`.

| Member | Signature | |
|---|---|---|
| `AddText(s text, s app_id) → t id` | | Copied text, at most 512 KiB and not blank. A lone `http://` or `https://` address is a `link`. |
| `AddImage(ay png, s app_id) → t id` | | A copied PNG image, at most 16 MiB. |
| `AddFiles(as uris, s app_id) → t id` | | Copied files; only `file://` URIs. |
| `GetText(t id) → s` | | The full content to copy back: the text, the URIs one per line, or the path of an image's PNG. GNOME Shell only. |
| `Search(s query) → at ids` | | The items whose whole text (or files' names) holds `query`, ignoring case, in the list's order; images match nothing. Only ids, never the text. GNOME Shell only. |
| `Touch(t id)` | | Move to the top, as copied again (e.g. from the history). |
| `SetPinned(t id, b pinned)` | | At most 10 items are pinned; pinning an eleventh fails with `LimitsExceeded`. |
| `Remove(t id)` | | |
| `Clear()` | | Remove every item that is not pinned. |
| `Items` | `s` | `[{id, kind, preview, uris, image, thumb, width, height, app_id, at_ms, pinned}]`, newest first. `kind` is `text`, `link`, `image` or `files`; `preview` is the first 160 characters of a text, or the file names one per line; `uris` is empty except for files; `image` and `thumb` (paths), `width` and `height` are null except for images; `at_ms` is when it was last copied. |

Adding something already in the history (the same text, image or list of
files) moves that item to the top and returns its id; it stays pinned if
it was. Beyond 20 unpinned items the oldest are
dropped; pinned items are only removed by hand. Unknown ids and invalid
content are rejected with `InvalidArgs`.

## io.github.zickrian.isle.Reminders1

Reminders the voice assistant sets ("remind me in ten minutes to…"), kept in
`~/.local/share/isle/reminders.json`. The extension shows each as an alert
when it is due, then dismisses it.

| Member | Signature | |
|---|---|---|
| `Add(t delay_ms, s text) → t id` | | A reminder due `delay_ms` from now. |
| `Dismiss(t id)` | | Forgets one, once shown (or cancelled). |
| `Items` | `s` | `[{id, text, due_ms}]`, soonest first. |

## io.github.zickrian.isle.AppUsage1

Time spent in each application, timed by the extension as GNOME's focus
changes and kept in `~/.local/share/isle/app-usage.json` for 30 days. Only
the application in front is timed, whether or not there is keyboard or
pointer input; it stops when focus moves, when no window is in front, or
when the screen locks. Five minutes without input pause it too, unless a
program holds the session from going idle (a video playing does). The
extension keeps the stretches and reports them at most once a minute, when
the Apps page opens and when timing stops; turning the Apps page or its
switch in Settings off stops the timing.

Every method is GNOME Shell's: the history names every app the user ran.

| Member | Signature | |
|---|---|---|
| `Report(a(ssxx) stretches)` | | Adds timed stretches, each `(app_id, name, start_ms, ms)`: `app_id` is the desktop id (or `window:<wmclass>` when the app has no desktop file), `start_ms` when the stretch began in milliseconds since the Unix epoch, and `ms` how long it lasted. Stretches past local midnight are split between the days. At most 1,000 fit in one call; a blank id, a start before 1970, or a time not between 1 ms and 24 hours refuses the whole batch with `InvalidArgs`. |
| `GetStats() → s` | | `{today: [{id, name, ms}], week: [{id, name, ms}], month: [{id, name, ms}]}`, most used first; `week` is the last seven days including today, and `month` the last 30 (all that is kept). |
| `Clear()` | | Forgets every day. |

## io.github.zickrian.isle.Assistant1

The voice assistant. isled records the microphone, turns speech into text
(whisper.cpp, through `isle-whisper`), asks the AI picked in Settings
(Claude Code, Codex, Grok or agy, with the user's own sign-in), runs the look-up
tools the AI asks for (finding files and apps, reading small text files), and
publishes the answer; the extension runs its actions. It works step by step:
desktop actions the AI takes mid-way go to the extension in the `acting`
phase, and what they did (`Results`) goes back to the AI for its next step.
A request carries on after `End`. The speech model runs only while needed;
the AI starts on `Warm` and quits 3 minutes after the last request.

Checks that only read (`uname`, `apt-cache policy`, `<program> --version`…)
isled runs itself, without a shell. A command that changes the computer is
a `run` action: `{type: "run", id, command, why, detail, risks, spawn}`,
where `spawn` is the `systemd-run` argv that starts it as unit
`isle-run-<id>` (the user's, or the system's for root), its output in
`~/.cache/isle/runs/run-<id>.log`. The extension shows the card, waits for
Run, checks `spawn` starts exactly `command` with Isle's own options, and
starts it; isled follows the log to the end (its last line is
`[isle-exit <code>]`) and, after a restart, finds running ones again in
`tasks.json`.

| Member | Signature | |
|---|---|---|
| `Listen(s context)` | | Records a request until the user pauses, then answers it. `context` is JSON from the extension: `{apps, running, windows, actions, provider, agy_model, claude_model, codex_model, whisper_model, language, keep_chat, selection, notifications}`; `keep_chat` is `day`, `idle-2h` or `idle-30m`; `actions` lists the action types it can run, and the AI is offered only those. |
| `Warm(s context)` | | The island opened on the assistant: starts the AI so the request to come is answered sooner. Asks nothing. |
| `Ask(s text, s context)` | | Answers a typed request, with the same context. |
| `Stop()` | | Stops recording and answers what was said so far. |
| `End()` | | The island closed: listening stops, and the AI and the speech model quit. A request being answered carries on in the background and finishes as a `reply` or `error`. |
| `Results(t step, s results)` | | What the actions handed out as `step` did: JSON `[{type, ok, detail}]`, one per action, in order. Unanswered within 20 s, they count as not done. |
| `Cancel()` | | Stops the request being answered; the AI quits. |
| `NewChat()` | | Starts a new conversation. The old one comes back with `UndoNewChat()` within 5 seconds; after that it is deleted, with the AI's copy. |
| `UndoNewChat()` | | Brings back the conversation `NewChat` put away. |
| `ClearChat()` | | Deletes the conversation now, with the AI's copy. Any caller (Settings asks it). |
| `State` | `s` | `{phase, heard, reply, actions, error, hint, sign_in, provider, set_up, model, listen, heard_nothing, activity, turn, step}`. With `sign_in`, signing in to `provider` fixes the error; with `set_up`, running `isle-setup-voice model` does. `phase` is `idle`, `listening`, `transcribing`, `thinking`, `acting`, `reply` or `error`. In `acting`, `actions` are to run now, once per `step`, and reported with `Results`; in `reply`, they are what the answer asks, run once per `turn`. `activity` says what the AI is doing while it thinks ("Searching ~/Downloads for “ttd”…"); `draft`, its answer so far as it writes it. `card` is the command it asked to run, or null: `{id, command, why, detail, risks, status, output, seconds, exit, stop}`, `risks` some of `root`, `internet`, `removes`, `status` `waiting`, `running`, `done`, `failed`, `denied` or `stopped`, `output` its last lines (secrets blanked), and `stop` the argv that stops it. |
| `History` | `s` | The conversation: `[{role, text, spoken, command, status, at}]`, `role` `user`, `assistant` or `command` (with `command` and its `status`), the newest 50. |
| `Models` | `s` | Each AI installed and signed in, its plan and the models the plan allows: `{claude, codex, grok, agy}`, each `{plan, default, default_name, models: [{id, name}], checked_ms}`. `plan` is as the account has it (`Team`, `Pro`, `Free`; empty for agy, whose plan cannot be read); `default` is what an empty model in the context answers with (empty: the CLI's own choice). Claude's models are its aliases (`opus`, `sonnet`, `haiku`, never Fable), named as the model each means now, from Claude Code's own cached catalog; Codex's from its app server's `model/list`; Grok's from `grok models`; agy's from `agy models`. Kept in `models.json`. Any caller (Settings reads it). |
| `RefreshModels()` | | Looks at `Models` again in the background and returns at once; Codex and agy at most once a minute. Also looked at: Codex's and Claude's when the usage shows another plan, agy's every 6 hours as the assistant opens, and an AI's after it refused a model. Any caller. |
| `ModelSwitched` (signal) | `ssss` | `(provider, plan, picked, used)`, by names: the AI answers with `used` because its plan lacks `picked` (or it refused it, and the request was asked again with `used`). Once per pick; the pick is kept and used again once the plan allows it. |
| `Notice` (signal) | `sb` | `(text, ok)`: a command ended while no request watched it (isled had restarted). |
| `Level` (signal) | `d` | The microphone's level (0..1) while listening, 20 times a second. |

## io.github.zickrian.isle.Usage1

How much of the user's AI plans is used. Claude's numbers come from
`api.anthropic.com/api/oauth/usage` with Claude Code's sign-in (asked every
ten minutes, at most every two when refreshed; offline, again within a
minute; backing off after the server fails; never refreshing the sign-in);
ChatGPT's from `chatgpt.com/backend-api/wham/usage` with Codex's sign-in (as
often as Claude's; when that fails, from Codex's own logs). Turned off,
nothing runs.

| Member | Signature | |
|---|---|---|
| `SetConfig(s config)` | | `{enabled, claude, codex, grok, assistant, warn, critical}`, from Settings; off until set. `assistant` false: a plan seen here starts no AI to list its models. |
| `Refresh()` | | Reads again now (Claude at most every two minutes). |
| `Usage` | `s` | `{providers: [{id, name, plan, windows: [{label, percent, resets_at_ms}], updated_ms, note}]}`; a provider not signed in is left out. |
| `Alert` (signal) | `ssdx` | `(provider, window, percent, resets_at_ms)`: a limit passed the warning or the critical share, once per window. |

## io.github.zickrian.isle.Agents1

AI coding agents on the island: Claude Code and Codex ask their permissions
there (`Decide`), and say when they are waiting or done (`Report`). The
extension turns each on for an agent it finds (Settings can turn it off),
which puts hooks in that AI's own config, running isled as a client
(`isled --agent-hook claude|codex`).

| Member | Signature | |
|---|---|---|
| `SetHooked(s provider, b on)` | | Puts Isle's hook in `claude`'s or `codex`'s config, or takes it out (below). GNOME Shell only. Fails with `Failed` and a message to show (`Codex already sends its notifications to another program`, a config that does not parse); an unknown `provider` is `InvalidArgs`. |
| `Decide(s json)` | `s` | From the hook: `{provider, project, cwd, session, tool, input, always, pids}` (`input` the command or file exactly as the AI would run it, cut to 300 characters, `InvalidArgs` with a line break or a character that hides or reorders text; `always` whether the AI offers to keep a rule, which only Claude Code and Grok do; `pids` the hook's parent processes, nearest first, at most 32, so the island can tell the agent's own window by its process). Emits `Asking` and waits, at most 9½ minutes, for `Resolve`: returns `allow`, `always` or `deny`, or `""` when the island will not answer (the AI then asks in its own terminal). Returns `""` at once with 8 already waiting, or while the island is away (`SetPresent`). When the caller leaves the bus first (the user answered in the terminal), it ends and emits `Withdrawn`. |
| `Resolve(s id, s decision)` | | The island's answer to `Asking` `id`. GNOME Shell only. |
| `SetPresent(b present)` | | Whether the island is there to answer `Asking`: the extension says `true` once it is built and whenever isled appears, `false` as it is turned off (the screen locks too). Away, every `Decide` waiting returns `""` at once, and new ones do too until it is back; the caller leaving the bus (GNOME Shell stopping or restarting) counts as away, seen within 2 s. Never told (an older extension never says), isled takes the island as there. GNOME Shell only. |
| `Asking` (signal) | `s` | The `Decide` JSON with its `id`. |
| `Withdrawn` (signal) | `s` | `id` needs no answer any more. |
| `Report(s json)` | | From the hook: `{provider, kind, project, cwd, message, session, pids}`. Unknown providers or kinds are `InvalidArgs`. Texts are put on one line and cut (`message` to 160 characters, `project` to 60, `session` to 100); a `cwd` that is not absolute is dropped, and `project` defaults to its last folder. An event follows another of the same `provider` and `kind` by at least 300 ms, or is dropped. |
| `Agents` | `s` | `{claude: {found, hooked}, codex: {found, hooked}}`: `found`, the CLI is installed; `hooked`, Isle's hook is in its config. Read afresh on each `Get`, and published again after `SetHooked` and whenever either config file changes. |
| `Event(s json)` | signal | `{provider, kind, project, cwd, message, session, pids}`; `provider` is `claude` or `codex`, `kind` is `permission`, `waiting` or `done`, `project` the name of the folder it works in, `session` its session (Codex: thread) id or `""`. |

The hooks, put in idempotently; taking them out removes only Isle's, and a
file is copied to `<name>.isle-backup` once, before Isle first changes it.
Each is rewritten whole and moved into place, keeping its permissions; a
file that does not parse is never written.

- **Claude Code**: `$CLAUDE_CONFIG_DIR/settings.json`, else
  `~/.claude/settings.json`, gets
  `{"hooks": [{"type": "command", "command": "<isled> --agent-hook claude"}]}`
  under `hooks.Notification` and `hooks.Stop`, and with `"timeout": 600`
  under `hooks.PermissionRequest`, beside the user's own hooks (every other
  key keeps its place). Lists and `hooks` that only Isle's hook was in go
  again with it.
- **Codex** 0.124 and newer: `$CODEX_HOME/hooks.json`, else
  `~/.codex/hooks.json`, gets the same for `PermissionRequest` (timeout 600)
  and `Stop`; Codex asks the user to trust them once. An older Codex gets
  `notify = ["<isled>", "--agent-hook", "codex"]` in its `config.toml` (made
  if missing), with its comments and layout kept; a `notify` that runs
  another program is left alone, and `SetHooked` fails.

`<isled>` is the running isled's own path (`~/.local/bin/isled` or
`/usr/bin/isled`). The client reads the hook JSON from standard input (at
most 1 MB). A `PermissionRequest` goes to `Decide` (without starting isled)
and the answer is printed as the hook's decision,
`{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision":
{"behavior": "allow" | "deny", …}}}`, with Claude's own suggested rule as
`updatedPermissions` for `always`; no answer prints nothing. Claude Code
asks in its terminal at the same time, and leaves the hook waiting when
answered there, so the client watches its `transcript_path` for the call's
result and ends then. Otherwise: Claude's `Notification` is `waiting`,
with its message (one about a permission is left out: `PermissionRequest`
asked already); `Stop`, Claude's or Codex's, is `done`, with the first line
of `last_assistant_message`. An older Codex's `agent-turn-complete` JSON,
its last argument, is `done`, with the first line of
`last-assistant-message`. It calls `Report` with a one-second limit and
without starting isled, prints nothing and always exits 0.

## io.github.zickrian.isle.Updates1

Whether a newer Isle is out: GitHub's latest release, looked up at most once a day while enabled.

| Member | Signature | |
|---|---|---|
| `SetEnabled(b enabled)` | | Look, or not (Settings → New versions); off until set. |
| `Latest` | `s` | The latest release's version (`0.8.0`) when it is newer than this isled; empty otherwise. |

## io.github.zickrian.isle.System1

| Member | Signature | |
|---|---|---|
| `State` | `s` | `{battery: {percent (a whole number), plugged, charging} or null, network: {connected, connection, name}, bluetooth: [{path, name, icon, battery}], camera_in_use}` |
| `Event(s json)` | signal | One of `{kind: "power", plugged, percent}`, `{kind: "battery_low", percent}`, `{kind: "battery_full"}`, `{kind: "network", connected, connection, name}`, `{kind: "bluetooth", connected, device}`. |

## io.github.zickrian.isle.ShelfWindow1

Served by `isle-shelf` (not `isled`) as `io.github.zickrian.isle.ShelfWindow` at
`/io/github/zickrian/isle/ShelfWindow`.

| Member | | |
|---|---|---|
| `Show(i x, i y, i width, i height)` | | Show the shelf window over this area, in logical pixels. |
| `ShowOver(i x, i y, i width, i height, i ax, i ay, i awidth, i aheight)` | | While a file is dragged in: the window covers the whole island (the first four), so a drop lands anywhere on it, with the files in the tab's area inside it (the last four). |
| `Hide()` | | |
| `Scale()` | → `i` | The scale GTK draws the window at: X pixels per logical one. |
| `SetScale(i scale)` | | Draw at this scale (1 to 4) from now on: the extension sets it when the window comes out another size than asked, as when GTK started before GNOME told X11 apps the display's scale. |
| `SetDropping(b dropping)` | | A file is being dragged towards the island: show where it will land. |
| `Hovering` | signal `as uris` | The files dragged over the window, for the island to light in their colours; empty once they leave. |
