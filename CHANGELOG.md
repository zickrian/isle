# Changelog

All notable changes to Isle are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.5.1] - 2026-10-31

A tidier closed island that fits what it shows, Glass made new with a slider from clear to dark,
lyrics that stay in time for the whole song, a smoother and lighter island, typed timer lengths (thanks
to @Ashishranjan980), and many fixes. To update from 1.5: click Update on the new-version alert (or
Settings → About → Update), then log out and back in.

### Added

- With the island inside the top bar, a little space now stays below it, so it no longer touches
  maximised windows (#14). It is on by default; Settings → Appearance → Space below the island
  turns it off for the earlier look.
- Scrolling or swiping over the open island's tabs changes the page again: one page a swipe or wheel
  click, stopping at the first and last page. Scrolling over a page's own content (lists, lyrics,
  calendar) still never changes the page (#13).
- The timer's Work and Break lengths can be typed: click the minutes, type a number, and Enter or a
  click elsewhere keeps it (Esc restores the old length). Thanks to @Ashishranjan980.
- With the timer as the closed island's only activity, it shows its time left beside the clock:
  dimmed while paused, green on a break (#17).
- With two activities at once, the closed island shows each as one small sign, one on each side of
  the clock (a song's cover, a call's phone, the timer's ring), with the privacy dots beside them, all
  in the one island; anything more is in the open island.

### Changed

- The closed island is as wide as what it shows: its signs sit evenly at both ends, as far in as from
  its top, the clock stays exactly centred (the Do Not Disturb moon sits before it), and it grows or
  shrinks with its content instead of stretching to a fixed width.
- During a call the closed island shows the green phone and the time; the call's length is on the
  Call page.
- The Focus page is called Timer, in its tab, in Settings and in the Pages list; the phase inside it
  still reads Focus (#17). Its lengths hold still from Start until Reset, so a session can't change
  part way.
- Glass is new: clearer and calmer, an even frosted look over light pages, gentle colour over bright
  wallpapers, a clean dark closed island, a soft lit edge, and every button, row, field and alert made
  of the same glass. Toggles that are on take your accent colour; grey text reads better over bright
  windows. Glows follow the island's shape on Black and Glass alike. Your Glass setting from 1.5
  carries over.
- A Glass slider in Settings → Appearance runs from clear glass to dark smoked glass, as GNOME's own
  blurred menus: what is behind dimmed, its colour kept, never a flat grey. Its buttons, rows and
  fields follow it. Rows, cards and fields are plain fills, never outlined boxes, on Black and Glass
  alike.
- The open island's pages have the same room on every side, rows and columns line up across each
  page, and buttons and switches come in one size each. Super+V moved to Clipboard History and the
  privacy dots to Appearance in Settings.

### Performance

Smoother and lighter. The island's shape and the assistant's light are drawn on the graphics card
rather than redrawn each frame, the island widens in whole pixels so text stays sharp, lyrics draw
only the lines in view, the Shelf and Notifications are ready before you switch to them, and isled
sleeps while nothing needs it. Measured on GNOME 51 with an Intel GPU, before and after:

| | 1.5.0 | 1.5.1 |
|---|---|---|
| Opening lyrics, slowest first frame | 47–50 ms | 14–16 ms |
| GNOME Shell CPU while a song plays | 15–17 % | 13–14 % |
| Opening the Shelf or Notifications the first time | 40–54 ms | 7–20 ms |
| Missed frames at 144 Hz (Glass, one set of actions) | 45–55 | 20–35 |
| Drawing work per frame while the island animates | 0.5–0.75 ms | 0.18–0.29 ms |
| Music bars, drawing per frame | 1.35 ms | 0.9 ms |
| GNOME Shell CPU with the assistant open | 24–32 % | 15–20 % |
| Frames that shimmer while the island widens | 21–36 | 0 |
| isled wake-ups a minute while idle | 6–16 | 0 |
| Memory after 200 opens and closes | no leak | no leak |

### Fixed

- Lyrics stay in time for the whole song: while the island shows the music, Isle checks with the
  player every second, so buffering, ads, seeks made inside the player and speed changes no longer
  leave them ahead or behind, also when a player changes speed without saying so. With the island
  closed, Isle checks nothing (#15).
- The top bar no longer flickers beside the island when Blur my Shell 76 or later is on, and Isle's
  top bar colour works beside it again: Isle now keeps its colour alongside other extensions that
  style the top bar.
- Typing in the island's fields works on GNOME 50 and 51: a click into a field gets the keyboard.
  On GNOME 46, a click outside the island ends typing without opening it again.
- The timer's Resume button is no longer cut to "Resu…", and a typed "180" shows in full.
- The calendar's six-week months fit their page.
- The open tab's name is no longer cut after changing the display's scale while Isle runs.
- A player that stops answering no longer holds up the music in the island, and Isle stops asking a
  player for its position if GNOME Shell goes away.
- The island announces a new version again (since 0.7.0 only Settings → About did).
- Uninstalling stops Isle's background service even where no user service manager runs.

## [1.5.0] - 2026-10-29

A glass look for the island, an Apps page for your screen time (thanks to @Ashishranjan980), events
that go to your real calendar, smoother page switches, and many fixes, among them Zen and Firefox
music keeping its place and a sun or moon on each world clock (thanks to @caffeinepx). To update from
1.4: click Update on the new-version alert (or Settings → About → Update), then log out and back in.

### Added

- Events you add on the Calendar page, or ask the assistant for, go to your real calendar: Google or any
  account in Settings → Online Accounts. A chip in the add field shows which calendar; click it to pick
  another (each account's calendars, or Isle on this computer). Offline or signed out, the event stays in
  Isle instead of being lost.
- World Clocks show by each city whether it is day, evening or night there: a sun, a setting sun or a
  moon, in Isle's own icons. Thanks to @caffeinepx.
- Glass: Settings → Appearance → Island can make the island dark glass instead of black, showing what is
  behind it (windows and wallpaper) blurred, as GNOME's menus look with Blur my Shell, cut cleanly to the
  island's shape. On glass its buttons are see-through, an answer (Allow, Run) takes GNOME's accent colour,
  and the assistant's and the alerts' light keeps to the edge without burning to white. Black stays the
  default, and as it was.
- App usage: an Apps page shows how long each application was in front today, over the last seven days
  or the last 30, most used first. Off until its switch in Settings → Pages is turned on; only then is
  the app in front timed, and its tab shown. Five minutes without input pause it, unless a video keeps
  the screen awake, and locking the screen stops it. Kept only on this computer, for 30 days; Settings
  can clear it. With every page on, the open island grows evenly on both sides to fit its tabs. Thanks
  to @Ashishranjan980.

### Fixed

- Switching pages in the open island no longer stutters the first time after changing the island's
  look, accent colour or text size: the pages are laid out again ahead, out of sight, as after a login.
  A switch now only touches the two tabs that change.
- With Codex as the AI, a request no longer fails with "failed to initialize sqlite state runtime" when
  Isle started two Codexes at once (an answer and the model list) on a new day. And a short command
  ("kunci layar") no longer sometimes waits two minutes to fail: Codex could get stuck writing only
  blank space after the action; Isle now stops it there and runs the answer it wrote.
- The Shelf's Files tab no longer keeps a file's tile after it is removed quickly, nor shows a black box
  the first time it opens: its drag-and-drop window now always draws.
- Music from Zen and Firefox keeps its place: the bar no longer jumps back to the start when they report
  0 while playing, a seek lands where it was made, and a length they drop after a seek is kept. Thanks
  to @caffeinepx. A player that starts the same song over (repeat one), or goes back to its start, is
  followed there, and the next video in Firefox starts from its own start, not where the last one was.
- A call in Google Meet no longer shows as WhatsApp when WhatsApp Web is open in another window: of the
  windows naming a call service, the one showing a call under way (a meeting's code, "call", "meeting")
  comes first, then the one in front.
- Notifications show their app's own colour icon at full size (Ghostty, Chrome), rather than shrunk
  onto a grey badge as if it were a one-colour icon.
- A reminder added with Enter keeps a sharp tick ring: opening, its row no longer squeezes the ring,
  which left it a blurred blob.
- Adding an event: Enter clears the field and shows the event at once, faint until its calendar lists
  it, so a slow server no longer invites a second Enter that added it twice. A line refused (a time
  alone) comes back to the field.
- New events no longer offer, or try, calendars that only read, such as a subscribed holiday calendar.
- An event added while its account's calendar is out of reach (offline, or the network up but the
  server not) is kept in Isle with a ring for its dot, "Offline · syncs once online", and sent there
  once in reach, never twice; before, it could sit in Evolution's own queue and never be sent.
  Deleted in Isle while it was being sent, it is taken out of the calendar too.
- An account's calendar no longer goes missing from the choice for the session when isled asked
  about it while offline, or just as it was opening.
- A time written in four digits, last ("Dinner 1930") or after "jam", "at" ("jam 1800"), is read as
  one; a year ("Reunion 2015") stays in the title.
- As an event is typed, the field shows when it takes place, as it will be read ("8:00 PM",
  "All day"), so a 12-hour clock's "8:00" is seen to be the morning's before Enter. A range on a
  12-hour clock says AM or PM once when both share it ("9:00 – 10:00 AM").
- An empty Shelf says one thing as the island opens, "No files on the shelf", in the island and in
  the drag-and-drop helper alike. The island's own words said the helper was missing (it had
  answered before the island listened) until the helper's other words took over: a blink. Its icon
  and words no longer turn bolder a moment after it opens either: the island alone draws them.
- The Shelf's files grow in with the island as it opens: the drag-and-drop window drawing them came
  in whole while the rest still faded in, and a one-line name and the × moved as it took over. It now
  waits for the island, fades in over the island's own tiles, which match it.
- A video with no title tag (in VLC, for one) shows in the island under its file name, rather than
  "Nothing playing"; and a player stopped since no longer hides a paused song in another.
- Isle says things in plain words: no program names, commands, exit codes or raw errors on screen.
  Voice that isn't set up points to Set up; the assistant's steps name folders and what it checks
  ("Checking what's installed…"), not paths and command lines; a command that didn't finish says so;
  and Settings' update, bug report and AI alert messages say what happened and what to do.
- Logging out on GNOME 51 with alerts waiting no longer leaves errors in the log.
- The Shelf's dashed outline stays the same wide dashes as its drag-and-drop window comes over it (it
  turned to fine dots, a flicker), and flashes as a file lands.
- In the island's fields, the cursor no longer runs into the placeholder's first letter.
- A call in the Discord app shows as Discord, with its window in the preview and Open: its microphone
  goes by its voice engine's name, so it showed as "WEBRTC VoiceEngine" with nothing to open. Isle now
  asks the sound server which app holds the microphone, and never shows an engine's name. A call
  keeps its own app when another app opens the microphone too.
- The Calendar page shows every month's events, keeps today's loaded for the event alerts however
  long the session runs, and opens without reloading: GNOME's own calendar and Isle kept asking for
  different dates, each dropping the other's.
- Claude Code and Codex ask in their terminals at once while Isle can't answer (the screen locked,
  Isle off), rather than waiting minutes for it; Always is offered only where it is kept.
- When Codex turns a request down, the assistant says why rather than waiting until it times out.
- An event, task or reminder the assistant adds is added even when the AI splits its title and time
  (Grok did): it said it was noted, and nothing was.
- Do Not Disturb follows a focus session only while it runs (not while the next one waits to start),
  and stays off for the session once you turn it off.
- A notification that comes while you are away waits on screen, unread, until you are back; an
  "Offline" alert no longer shows after the connection is back.
- Pausing and resuming a video in Zen or Firefox, or changing its speed, keeps its place; the player
  switch offers only players with something to show; lyrics are looked up only when turned on.
- A password stays out of the clipboard history when its password manager quits before clearing it.
- Isle keeps running when a Shelf file sits on a network drive that went offline, and the Shelf keeps
  its files in view while Isle restarts.

### Changed

- While Isle's event alert is on, GNOME's own calendar reminder for the same event no longer comes
  too: it showed as a second alert, and clicked, opened a cramped Reminders window with Dismiss and
  Dismiss All. Only a reminder of the very occurrence Isle alerts of, or did alert of, goes; others
  (an all-day event, a task, a day ahead, a meeting under way, one Do Not Disturb kept quiet) come as
  before.
- The day's events are grey rows with a dot of their own calendar's colour (Google's, holidays'),
  rather than every one tinted blue with a bar down its side.
- isled holds about 10 MB, and no longer grows over hours (it reached 16 MB): big blocks it frees
  (a cover, a download) go back to the system, and its libraries are built for size, as isled
  itself is (isle-whisper's keep full speed).
- The open island changes page only by its tabs: a sideways swipe, or a scroll over a page with no list,
  no longer turns the page by surprise. Lists and lyrics scroll as before.
- Alerts fit what they say, with the same room on every side (12 px round the icon, its corners curved
  round it), rather than a short one sitting in a wide island. Off a black bar they no longer leave more
  room above than below.
- The assistant at work in the closed island is as far from its edge as the song's cover on the other
  side, and a little smaller (17.5 px in the top bar, 19.5 below it), as a solid shape looks bigger than
  a picture.
- Alerts with buttons (a call's Accept and Decline, an agent's Allow) fit what they say too, from a short
  one to 440 px, with small buttons under the words; no more wide empty space beside them.
- The Notifications list shows each notification as a card of its own, its buttons on a line under its
  words rather than crowding them when the pointer is over it.
- Buttons are never cut short: an alert widens for them (up to 560 px), and those that still don't fit go
  on to a line below, in the alert and in the Notifications list. A single button beside words that
  would be cut moves under them, and a notification's words take up to two lines.
- Alerts lit along their edges (an agent's ask, a command to run) keep their buttons clear of the light.
- The island sits centred on its display to the pixel, on every display.
- Lighter: a song playing under the closed island costs GNOME Shell about a sixth of the CPU it did (the
  bars move as before, on a timer rather than through every frame of the display), and so does the
  recording dot.
- The open island's tabs show their icon in lines, and filled for the page that is open; icons are the same
  weight and look the same size side by side, drawn sharp at their own size, and light up more calmly under
  the pointer. The calendar's icon is new, after Lucide's (ISC; see gnome-extension/NOTICE-lucide.txt).
- The button to press is the right one: Allow (not Always) on an agent's ask, and a notification's last
  button only when it doesn't turn something down (Accept, not Decline).
- Shelf files look as they do in Files: a PDF or other document shows its first page whole, made as Files
  makes it when there is no thumbnail yet; files without one keep the theme's icon.
- Bluetooth speakers, game controllers, laptops and tablets get icons of their own; other devices show the
  Bluetooth icon.
- The assistant's light tells what it is doing: while it works, the light running round its edge shines
  brighter, and it brightens a moment as the answer arrives; at rest it glows as before. An agent's ask
  breathes gently a few times while it waits for you, and a done alert lights up once as it shows. A file
  landing on the Shelf flares a little longer.

## [1.4.0] - 2026-10-27

### Added

- Updating takes a click: when a new Isle is out, its alert's Update opens Settings → About, where Update
  downloads it, checks it and installs it (no terminal, no password), then Log Out finishes it. If it
  can't, it says why and offers the terminal command. It goes on if Settings is closed. A .deb, .rpm or
  Arch package install says how to update its package.
- Settings → Island → Pages turns each tab of the open island on or off: Music, Notifications, Focus,
  Reminders, Shelf, Calendar and AI Usage. A page turned off takes what goes with it: Music its song in the
  closed island, its bars and the new-song alerts; Notifications the unread dot; Shelf gives Super+V back
  to GNOME. One page always stays on.
- The AI assistant can be turned off in the same place (and first thing on Settings → Assistant): the ✦
  and Super+I go, and Isle never asks an AI.
- World clocks: the time in other cities, under the day's events on the Calendar page; click them (or the
  globe) for how far ahead or behind each is, and its day when it isn't yours. It's GNOME's own list, the
  one in its calendar menu and the Clocks app; add and remove cities in Settings → Island → World Clocks.
- The top bar beside the island goes from glass to black on a slider, rather than a choice of the two;
  the island itself stays black. Your choice carries over.
- The assistant offers only the models your plan includes, by their full names (Opus 5.5, GPT-6.1-Sol,
  Gemini 3.8 Flash), read from your own account, with your plan's name in Settings. When a plan no
  longer includes the model you picked (a subscription that lapsed), the assistant uses your plan's
  default and says so once; your pick comes back by itself when the plan allows it again. A request
  refused for its model is answered with the default rather than failing.
- Grok (xAI's `grok`) as a fourth AI for the assistant, found by itself once installed and signed in,
  with your plan's models, and its plan on the Usage page (a Free plan's week, though Grok doesn't say
  how much of it is used). It runs in Isle's own folder, kept to answering: no commands or files of its
  own, and none of your Claude Code setup. Thanks to @caffeinepx.
- A notification's alert shows all of its buttons, as GNOME's banner does ("Decline" and "Accept", not
  just the first), and a click does what GNOME's would: the app is told, and the notification goes,
  unless it is one that updates itself.

### Changed

- Codex is listed as "Codex (ChatGPT)": it is how Isle uses ChatGPT, with your ChatGPT plan.
- Plans are named as the apps name them: ChatGPT "Pro" (was "Pro Lite"), as Codex does.
- Claude's Fable models are not offered: in the assistant they would use your usage credits without asking.
- The open island's tabs and its pages line up: the open tab's pill, each page's first and last items
  and the settings icon sit on the same left and right edges.
- Settings → Island → Alerts starts with a Notifications switch, on: apps' notifications in the island.
  Turned off, GNOME shows its own banners (it was "GNOME's notification banners", off).
- Opening, closing and switching tabs do less work: the island's shape is drawn once a frame instead of
  twice, and a tab's name is measured once, so the motion stutters less, most of all on fast displays.

### Fixed

- In GNOME's light style the top bar's icons and text turned dark on Isle's black or glass bar; they stay
  white.
- With the top bar hidden by another extension (Hide Top Bar, Just Perfection), or on a display without
  one, a maximized window such as Firefox covered the whole screen and GNOME stopped drawing the island
  over it: it vanished while still taking the pointer, came back with a website's menu or tooltip, and
  flickered. It is drawn now, as GNOME's own menus and notifications are, while such a window is there.
- Hide Top Bar turned on (or updated) while Isle ran put the bar over the island, so hovering it didn't
  open it while the bar showed. The bar goes back below the island.
- An update that fails part way (a full disk) leaves the installed programs and extension whole, and two
  installs at once (Settings and a terminal) can't mix: the second says so and stops.
- Hovering or clicking a notification alert opens the Notifications page; with that page turned off, it
  opened another one.
- A call's preview showed another window of the browser when the call's tab was in, or moved to, a window
  of its own: it follows the window that shows the call.
- The first Codex request of a day could fail: the daily clean-up could delete Codex's databases while
  Codex was starting.
- Settings listed Codex's models as saved under an earlier plan, offering models the plan no longer (or
  not yet) included; picking one made every request fail.

## [1.3.1] - 2026-10-26

### Fixed

- The Usage page shows your ChatGPT plan and limits as they are now, as Codex's /status does, rather than
  as Codex last logged them: after an upgrade or downgrade it said the old plan (and its old limits) until
  Codex was used again. It asks at most every 10 minutes, or when the page opens, as for Claude.
- Settings → AI Usage lists ChatGPT as soon as Codex is signed in, even before Codex was first used.

## [1.3.0] - 2026-10-25

### Changed

- Alerts go sooner: a notification after 4 seconds, as GNOME's own banner does, and a passing one such as
  "Screenshot captured" after 2.5. Once the pointer leaves an alert it goes 1.5 seconds later, its button
  included, rather than starting its time over. An answer from the assistant stays at most 8 seconds.
- Under the pointer, an alert that the pointer doesn't open (one with a button, such as "Show in Files")
  and an answer from the assistant show a small × on their icon to put them away. It closes them while the keys are with another app, where Esc can't reach the island.
- Do Not Disturb shows as a moon before the time (or a call's or recording's length), whatever the island
  holds beside it. Before, music, a timer or the unread dot hid the moon. The Notifications page says what
  still gets through while it is on.
- An answer from the assistant cut short in its alert says "Click to read more".
- The music bars move about 60 times a second on any display. On a 144 Hz one, music playing costs GNOME
  Shell a third less; everything else moves at the display's own rate.
- Settings → About shows whether Isle is up to date ("You're up to date · Checked today"), or which newer
  version is out, with How to update and Copy command. The switch for checking moved there from Alerts.

### Fixed

- A file on the shelf no longer widens its tile to take up the rest of the row (seen after dropping a
  file in). Every tile keeps its own width, as in the island.
- Resting the pointer on an answer from the assistant holds it to read, with its ×. Before, the island
  opened on its pages (often Music) and the answer was gone.
- With the assistant at work in the background, resting the pointer on the island shows its progress, and
  the island goes back to the background when the pointer leaves. Before, it stayed open and kept the
  keyboard from the app. A click still keeps it open, and Esc puts it back.
- After typing in the island (to the assistant, a to-do), alerts and answers go on time again. If the
  pointer left the island while it had the keyboard, Isle went on thinking the pointer was there, and
  alerts waited for it to leave.
- The Caps Lock arrow comes in smoothly with its alert, rising as it fades in. Before, the badge showed
  empty for a moment, and the arrow then blinked out and back as it settled.
- On GNOME 46, a long answer from the assistant in the background shows again. Cutting it to three lines
  failed there, so the answer never showed and later alerts waited behind it.
- An alert that fails to show no longer holds up the alerts behind it, and if Isle's volume or brightness
  alert fails, GNOME's own shows instead.
- After a fullscreen window, alerts go on time again. As with typing, a pointer on the island when it hid
  was still counted as there.
- Closing the island just as you finish speaking no longer loses the request. It carries on in the
  background, its actions run and its answer comes as an alert. Before, the assistant waited unseen.
- The assistant says "Getting ready…" until the microphone really records, rather than "Listening…" while
  the AI or the speech model is still starting: words said then were lost.
- Asked to switch the power mode, the assistant uses Isle's own switch, and only where power-profiles-daemon
  is missing offers a command that works (`sudo tee`, as sudo does not reach a `>` redirect).
- Asking while the assistant is still answering says so, rather than showing "Listening…" until the last
  request ends. A microphone that sends nothing says so after 4 seconds, rather than listening forever.
- Turning the assistant off while it works in the background stops the request. Before, clicking the
  island did nothing until it ended, up to 10 minutes with a command waiting for Run.
- Updating without a user service manager (no `systemctl --user`) now runs the new isled within seconds.
  Before, the old one went on running until the next restart.
- If part of Isle fails to start, it takes away what it had set up, so GNOME's volume pop-up and the
  assistant's shortcut keep working. Turning Isle off also stops watching notifications it showed.

## [1.2.1] - 2026-10-25

### Fixed

- With Codex, the assistant answers an English request in English: it often replied in Indonesian.
- With Codex, asking for a file to be made ("make notes.txt saying hello") offers a command to run, rather
  than saying it cannot write files.
- When the assistant says it cannot look at the computer or find something without having tried, Isle
  tells it that it can, and it looks before it answers.
- "Switch to Chrome" brings Chrome's window up with Codex, rather than going to the focus timer.

### Changed

- The README shows a new demo of the assistant, a command waiting for Run, the island's pages and an agent
  asking, with a link to the full video.
- The installation guide shows how to install on Arch Linux step by step, and says Isle is not in the
  AUR yet.

## [1.2.0] - 2026-10-24

### Added

- The assistant finds out what is wrong with the computer before it answers, as an expert would: it looks
  at the power mode, battery and its health, Wi-Fi and the network, sound, Bluetooth, logs, temperatures,
  drivers, disks and what is running (only commands that look, run at once; anything that changes the
  computer still waits for Run), then says what it found and offers the fix.
- It can switch the power mode (power saver, balanced, performance).

### Changed

- The assistant talks things through: explanations, discussions, research and what it found out get a full
  answer (with short lists, **bold** and `code`) instead of one or two sentences, it gives its own opinion
  when asked, and it never says it may not look at the computer.
- The assistant's pill moves more smoothly: what comes into it (its steps, a command card, a hint) fades
  in as the island grows to it instead of showing cut off by the edge, and the answer fades in where its
  steps were rather than replacing them in one frame.

## [1.1.0] - 2026-10-24

### Changed

- The Files tab always takes dropped files: when it settled without a later change (its fade cut short),
  its drop window could stay away until the island was opened again.
- With AI usage on, Isle's service no longer reads Codex's logs every minute while the screen is locked;
  it reads them again as it unlocks.
- A typed request that cuts listening short lets the speech model go at once, rather than keeping it in
  memory until the island closes.
- While the assistant runs a command, Isle's service sends its state to GNOME Shell only when something
  shows differently: about once a second instead of two or three times, and never the same state twice.
- Opening the island on a song with synced lyrics no longer eases each lyric line behind the player
  before its first frame, and lyrics out of sight no longer wake Isle at every line: they are set as
  they show.
- The closed island no longer runs fades to the opacity its music bars and clock already have each time
  a song, the timer or a call changes.

### Fixed

- Ticking a reminder off no longer drops a frame as its strike draws: only its title and tick box are
  restyled, not every part of its row.
- Super+I starts listening at once even while the AI is still starting (Codex from cold): the AI starts
  as you speak, so the first words are no longer lost.
- Installing Isle again after uninstalling it keeps the top bar look chosen before, instead of resetting it.
- A new version alert tells those who installed a .deb, .rpm or AUR package to install its new package,
  not to run the install command, and the install guide says how.
- Two clipboard images put in Files within the same second both stay: the second no longer replaces the first.
- On a 200% display without fractional scaling (GNOME 46–49), the island, its pages, the assistant and
  alerts are drawn at the right size.
- Dragging files onto the shelf is smooth: the Files tab no longer blinks while the island opens on it
  (its window went away and came back about ten times), nor jumps as a file comes near (the window grew
  over the whole island and back), and the "Drop here" tile no longer pushes the files aside. A file let
  go anywhere on the island still lands on the shelf, and the island's tabs keep their clicks.
- In the Activities overview the Files tab shows its files instead of an empty tray.
- Maximizing and arranging windows by voice no longer logs warnings on GNOME 49 and later.
- The .deb, .rpm and AUR instructions turn Isle on after logging out and back in, not before: until
  then GNOME Shell does not know the new extension, so `gnome-extensions enable` failed and Isle stayed off.
- Installing Isle again after uninstalling it turns it on: the uninstaller left it on GNOME's list of
  turned-off extensions, which outranks the list of turned-on ones, so it stayed off with no word why.
- `isle-setup-voice base` (or another model named) also picks that model in Settings: before, it was
  downloaded but the assistant went on asking for the one chosen there. Settings offer Tiny (44 MB) too.
- The guide says to run `isled --unhook-all` before removing a .deb, .rpm or AUR package (the AUR
  package says so too), so Claude Code and Codex are not left calling a removed `isled`, and to remove
  Isle with `isle-uninstall` rather than the Extensions app's Remove button.
- With the assistant's AI on Automatic, Settings list the models of the AI it answers with (the first
  you are signed in to), not of the first one installed.
- Settings → AI Usage finds Claude Code and Codex where Isle does: in `CLAUDE_CONFIG_DIR` and
  `CODEX_HOME` when set, and Codex's sessions in Isle's assistant, so "Show AI usage" is no longer
  greyed out while the island shows the usage.
- The installer says when `~/.local/bin` is not on the PATH, and the guide gives Isle's commands
  with that folder (`~/.local/bin/isled --doctor`), so they run where their names alone are not found.
- The one-line install works where `/tmp` is mounted `noexec`: it ran the package's installer from
  there directly, which such a system refuses.
- Installing from source goes on without the shelf's drag-and-drop helper when it does not build (it
  needs Rust 1.92), instead of stopping the whole install.
- The installer no longer stops without a word when isled cannot be set to start with the session; it
  says so and finishes.
- The installation guide and settings descriptions are up to date: the installer's last lines, a
  current version to pin, an `ERROR` state as a bug to report, the link for building from source, and
  the voice assistant's AI as Claude Code, Codex or Antigravity rather than only agy.
- An alert that asks (Allow or Deny from Claude or Codex, Run or Deny from the assistant) or has a button
  (Join, a critical notification's) no longer goes 1.5 seconds after the pointer leaves it: it keeps its
  own time. An agent's ask went back to its terminal, and the assistant's command waited unseen.
- Closing the assistant while its command waits for Run or Deny no longer puts an alert that waited in
  place of that ask: the ask was gone, and the command waited unseen for ten minutes.
- Opening the assistant over an alert puts the alert back in line without answering it: Claude's or
  Codex's ask no longer went to the terminal and then came back with Allow and Deny that did nothing. An
  alert already answered is not shown again when another one replaces it.
- Showing the assistant at work again (a click, or its shortcut, while it answers in the background) no
  longer leaves the alert under it to run out unseen; it shows once the assistant closes.
- When a fullscreen window hides the island, the alert on screen waits until it shows again instead of
  running out unseen (a critical notification was marked read, a reminder gone), and Claude's or Codex's
  asks go to their terminals at once, as asks that come while it is hidden do.
- Locking the screen or turning Isle off sends Claude's and Codex's waiting asks to their terminals at
  once; Codex waited nearly ten minutes.
- A notification keeps text in angle brackets, as GNOME shows it: "Ann <ann@example.com>",
  "Vec<String>" and "a < b > c" lost those words in the island.
- A calendar event's alert that waited (the island open, or a fullscreen window) says how many minutes
  are left when it shows, not "in 5 min" from when it was due, and no longer shows once the event is over.
- Do Not Disturb also holds back the AI plan usage warnings, new song alerts and the new version alert,
  as it does the island's other alerts.
- A notification its app takes back goes from the island at once, also while the screen is shared, rather
  than staying for its whole time.
- A notification updated while it waited its turn shows its new words, not the first ones.
- Run or Deny on the assistant's command alert answers that command only, never a newer one, and Run shows
  "Running" for its moment before the alert goes. A notification's title on several lines shows on one.
- Closing the assistant (Esc, or an answer that types or takes a screenshot) right after an answer in the
  conversation no longer leaves the keyboard taken by a closed island.
- The assistant opened with the shortcut listens in the pill again instead of showing the conversation
  left open last time, and no longer switches to typing once it answers.
- The assistant reopened at work from the closed island closes again with Esc or a click elsewhere, and
  Enter or Esc answer a command waiting there for Run or Deny.
- With Isle's service stopped or refusing a request, the assistant says so and closes instead of showing
  "Listening…" or "Thinking…" forever with the keyboard taken.
- Typing right after pressing the shortcut, before the assistant has started listening, stops the
  listening, so the typed request is answered and "Didn't catch that" no longer replaces the field.
- The mic in the open island shows a request still at work instead of starting one that was lost, and a
  request at work when the screen locks carries on afterwards: its answer comes as an alert, and a command
  it waits on asks again.
- Once a command it ran has ended, the assistant keeps its Stop button while it still works on the
  request, instead of offering to type a new one.
- An error no longer shows with the command card of an earlier request, and the assistant's face no longer
  looks glad over an error that came after its command.
- A typed request starts its steps and "Still working" time afresh even when the field opened while an
  earlier request was at work.
- Undo after starting a new chat no longer pops the conversation open on a later change when the old one
  did not come back, nor while the island is closed.
- After Isle's service restarts, the assistant's first answer does what it says (opening an app, say)
  instead of sometimes skipping it.
- A command card that comes after one put away while it waited takes no Enter or click in its first half
  second either, so a key meant for something else never runs it.
- Opening the island (Super+V, say) while the assistant waits for Run or Deny keeps the question: it shows
  as an alert once the island closes, instead of going and leaving the command to wait ten minutes.
- A long answer is cut at the end of a word, never through an emoji or leaving stray bold or code marks;
  the answer as it is written is cut the same way instead of running past the pill; and a cut answer
  always has the chevron to read it whole in the conversation.
- Browsing the calendar to another month no longer empties today's events or stops the "starts soon"
  alerts; a meeting alert still comes after the computer sleeps, and not a second time after unlocking.
- The calendar writes the month as it stands alone, tells weekdays apart in every language ("CN T2"
  in Vietnamese), gives its example time as "8:00 PM" whatever the locale, shows an evening event's end
  on the day clocks go back, and redraws its times when the clock switches between 12 and 24 hours.
- A reminder renamed and left by closing the island shows its title again, not an empty field.
- Scrolling on the volume slider over 100% no longer drops the volume to 100%.
- Previous, Next and Play are dimmed when the player can't do them.
- A song's new cover (and lyrics colour) shows when its player saves it under the last one's name.
- A usage limit's colour follows the percent it shows; a notification's title stays on one line.
- An agent's alert wraps its title at its full width, with the assistant level with it.
- Tidier pages: every page's content starts and ends on the same edges, secondary buttons share one
  grey, placeholders one brightness and no indent, empty lists one style, the Focus buttons one height;
  calendar times, usage percents and header icons line up, and a song counts down with a minus sign.
- A command's output with a letter such as "İ" no longer stops the assistant until Isle restarts, and
  a secret on such a line is still hidden.
- Isle starts even when the login shell leaves a job running (an agent started in `.bashrc`) that kept
  its output open, which left the island without its service.
- Taking a file off the shelf never deletes a file outside the shelf's own folder.
- An AI that hangs as it starts gives up after 20 seconds instead of leaving Super+I doing nothing.
- A quick command the assistant ran is no longer reported as interrupted the next time Isle starts.
- New chat, Undo, Clear conversation and a command's end that come while a request is answered are
  carried out once it is answered instead of being lost, and a request typed while listening is answered.
- An error such as "Didn't catch that" no longer shows the last request's command card under it.
- A command still running when its request is cancelled or runs out of time is followed to its end and
  told, and one running across two restarts of Isle is no longer lost.
- The assistant offers a command only through Isle's own checks, also in the answer it gives once its
  steps run out.
- AI limit warnings at 80% and 95% come once per window, not again when the reset time is read a moment
  off.
- Claude Code gets the sign-in from its settings in a file only you can read, no longer on its command
  line, where other users could see an API key.
- A quiet conversation is cleared when its 30 minutes, 2 hours or day are over even while nothing is
  asked, and at midnight even after the computer slept.
- Moving a browser's tabs, or text, near the island no longer opens the shelf and takes the drop:
  only a drag of files (or links) does.
- If the shelf's drag-and-drop helper crashes, the Files tab shows its files again instead of staying
  blank, and a new helper starts; one that quits just as a file is dragged in no longer misses the drag.
- Cells copied from a spreadsheet are kept in the clipboard history as their text, not as a picture of
  them (a browser's Copy Image still keeps the picture).
- A very large copy is no longer read whole into GNOME Shell only to be turned away; reading stops at
  the history's size limit.
- A password a password manager copies, and clears again soon after, now leaves the clipboard history
  too, unless pinned.
- Dropping more files than the shelf has room for is turned away as you hover, with "Only 2 more fit",
  instead of some of them going missing while the island showed them landing.
- Dropping only links or files online on the shelf says "Only files on this computer" instead of
  lighting up as if they landed.
- The clipboard history's list, which any program can read, now gives only the 160 characters of
  each text a card shows, not 400.
- With the island following the display in use, it no longer stays hidden after moving off a display
  with a fullscreen window (alerts waited forever and Super+V did nothing), nor shows over a fullscreen
  video on the display it moves to.
- A screen share that began before Isle started (turned on again after unlocking, or updated during
  a call) now keeps notification text, the clipboard and the shelf hidden as one begun later does.
- An alert growing under a pointer that rests at the top of the screen no longer opens the island
  (with "open on hover"), nor stays on screen until the pointer moves: it counts once the pointer moves.
- Notifications opened by asking the assistant close with Esc or a click elsewhere, as with Super+V,
  instead of staying open until the pointer went over the island and away.
- On a touchscreen a tap on the island does what a click does (opens it, or an alert's notification),
  and a tap elsewhere closes it; before, taps did nothing and the clock under it could not be reached.
- With the island on another display, GNOME's clock in the top bar opens its calendar again instead of
  closing it the moment it opens.
- Turning Isle off, or leaving Super+V to GNOME, no longer undoes another extension's own Super+V calendar.
- The next alert after one that grew under a resting pointer, or one updated in place under it, runs out
  as it should instead of staying until the pointer moves (or for good, once the island shrank from under
  it), and the assistant's answer closes on its own when the pill grew under a pointer that never moved.
- With animations turned off, and when Isle starts again after unlocking, an island that appears or grows
  under a resting pointer no longer counts as hovered: an alert no longer opened the island ("open on
  hover") or stayed until the pointer moved. A pointer resting on the island as Isle starts again after
  unlocking opens it once it moves, instead of only after leaving it and coming back.
- Notifications still waiting their turn (behind an alert, or while the island was open) no longer pop up
  once Do Not Disturb is on, as when a focus session starts from the open island; they stay unread in the
  list, as those that come in Do Not Disturb do.
- With animations turned off, the open island no longer closes when it narrows from under a resting
  pointer (leaving the music page's lyrics for the Call tab); it waits for the pointer to move, as with
  animations on.
- Clicking the alert with the assistant's answer (or "Isle restarted", or a command's end) opens the
  assistant without that alert coming back once the assistant closes.
- Locking the screen while the assistant's command waits for Run or Deny in an alert no longer shows the
  notification waiting behind it as the screen locks, marking it read with its sound, unseen.
- On a 200% display, the Files tab's drag-and-drop window no longer comes out half the island's size
  when the shelf's helper starts before GNOME has told it the display's scale: it is set to match.
- On a 200% display without fractional scaling, the calendar writes the month whole ("OCTOBER", not
  "OCTOB…").
- A password a password manager clears again also leaves the clipboard history when you pasted it into
  another app (the manager clears it on a timer, with that app in front), and copying blank text no
  longer takes the last copy out of the history.
- Opening the Usage page asks Claude for new numbers at most every two minutes, as the guide says (every
  half minute only while offline); it asked every half minute, four times what the guide promises of an
  endpoint Claude does not document.
- isled no longer keeps a note of every Claude Code and Codex session it ever heard from, which grew
  for as long as it ran.
- isled no longer wakes every minute to check whether the assistant's conversation is over: it waits
  for the end of its quiet time or for midnight, and looks again on waking from sleep.
- The guides give the commands of a .deb, .rpm or AUR install by name (`isled --doctor`,
  `isle-setup-voice`): the `~/.local/bin/…` they gave is only there with the one-line install.
- The installation guide's .deb and .rpm commands match any release's file, not only 1.0.0's.
- A battery whose level reads a little up and down around 20%, 10% or 5% warns once at each, as
  meant, until the charger is plugged in; it warned again at every dip.
- Waking the computer no longer brings an "Offline" alert while Wi-Fi reconnects (with the screen not
  locked on suspend): the connection going with sleep is not one lost.
- The guides say to lift a battery charge limit the assistant set (`isle-charge-limit 100`) before
  removing a .deb, .rpm or AUR package: the limit stayed, with nothing of Isle left to lift it.
- Searching the clipboard history finds words anywhere in a copied text, not only near its start.
- The assistant opened (Super+I) over its answer's alert no longer brings that alert back once it closes,
  and clicking an answer that is over opens the conversation instead of an empty assistant that never
  closed.
- A request typed and sent just before the assistant was closed (its AI still starting) is answered as
  an alert and its actions run, instead of being worked on unseen and its answer dropped.
- Closing the assistant while it turns what was said into text no longer brings a "Didn't catch that"
  alert when nothing was said.
- "Still working" under a request opened again from the closed island counts from when it began,
  instead of showing late and short of the time it has taken.
- While the assistant works step by step, each step shows as it happens ("Searching ~ for “cv”…")
  instead of the words of its last answer staying until the next one starts.

## [1.0.6] - 2026-10-24

### Fixed

- A request typed in the conversation starts its list of steps afresh: the previous request's steps
  (and words it said on the way) no longer show under "Thinking…" for the new one.

## [1.0.5] - 2026-10-24

### Fixed

- Claude Code's and Codex's alerts no longer go missing when another window (an editor on the same
  project) names the project: the agent's own window is found by its process, and a title only counts
  as a whole word ("app" no longer matches "WhatsApp"). A terminal or editor with several windows is
  told apart too.
- A Claude Code permission the island could not ask itself (a long or many-line command) now gets an
  alert instead of nothing.
- The assistant's answers show their Markdown as formatting in the pill and as plain words in alerts,
  never as `**`; an answer with only actions no longer breaks the conversation.
- Stop while a command card waits drops the command for good; a card left unanswered is told to the AI
  as not run, not as denied.
- `sudo` is taken off only where a command starts (`grep sudo log` keeps its word), and a sudo run as
  another user is refused with why.
- Music, reminders, volume, Bluetooth and brightness say when they did not work, with the reason,
  instead of reporting success; a window named by its title is the frontmost, closest match.
- Hints name your own shortcut, Codex gets its approval hooks after an upgrade, a folder an AI cannot
  write is no longer called a used-up plan, and done alerts keep underscores in names.
- A shelf file's name takes two lines, so "Alex Morgan CV.pdf" shows whole; a charging alert never
  shows "0%" before it counts up; a finished command's step reads "Asked to run it".
- The hidden warm-up alert can no longer appear as "Charging · Isle · 0%".
- The conversation stays at its end as a command card below it grows, so the latest message stays in
  sight; an answer gets three lines in its alert, and a reminder and an agent's summary two.

## [1.0.4] - 2026-10-24

### Changed

- Isle speaks for itself: its settings, its description and its documents
  no longer compare it to other companies' products, and the README says
  who holds its copyright under the GPL.
- Isle is always set in Inter, the typeface it installs; it no longer
  switches to another company's font when that one is installed.

### Fixed

- When the password dialog for a command is closed, the assistant says so,
  instead of saying you pressed Deny.

## [1.0.3] - 2026-10-24

### Fixed

- Commands the assistant runs after you press Run (and, for root, enter
  your password) are followed to the end again: Isle told the AI each one
  had failed as soon as it started, so it never saw the result and said
  the password dialog was cancelled, with every AI.
- The battery charge limit can be set by the assistant on an Isle installed
  with the one-line installer: it now runs Isle's helper by its whole path,
  since root's PATH leaves out `~/.local/bin`.
- The assistant no longer says the terminal, Wi-Fi, Settings, a Chrome
  profile or music was opened when the app needed was missing.

## [1.0.2] - 2026-10-24

### Fixed

- Claude Code or Codex installed after logging in now gets its approvals on
  the island at once, as its switch in Settings says; before, it only did
  after the next login.

## [1.0.1] - 2026-10-24

### Changed

- The assistant's answers and the conversation are as wide as the open
  island (600 px instead of 460), with wider bubbles.
- A song and the focus timer together: the closed island keeps the music
  bars on the right, with the timer's time beside them as large as the
  clock and level with it, instead of a small ring.

### Fixed

- Pictures and text no longer shiver as the island opens, closes or shows
  an alert, as pages change, as AI usage switches plans or as messages
  come into the conversation: they slide by whole pixels instead of
  scaling or resting between pixels.
- Smoother assistant: its glow is drawn at most once a frame, which halves
  the frames that came late while it opens and closes.
- Files dragged onto the island land wherever they are let go on it, not
  only over the tray, and the drop light no longer blinks as the pointer
  moves across the island.
- Clicking an event from the desktop's calendars (Google and others) no
  longer opens another app, such as a text editor, when GNOME Calendar is
  not installed: those events are there to read.

## [1.0.0] - 2026-10-24

The first stable release: the assistant can install and fix things for
you, Claude Code and Codex ask you on the island, and the bot is yours to
shape and colour.

### Added

- **The assistant does things on the computer.** Ask it to install
  LibreOffice or the Codex CLI and it first checks what is already there
  (which Linux, which package managers, whether it is installed), searches
  the web when unsure, then shows the command it wants to run on a card:
  what it is for, the command, and what to know (it needs your password,
  it runs a script from the web, it removes files), with **Run** (Enter)
  and **Deny** (Esc). It runs in the background as a systemd unit of its
  own, so closing the island, locking the screen or restarting isled
  leaves it running; the card shows how long it has been at it and its last
  lines, and **Stop** ends it (a package manager asks twice, since stopping
  one halfway can leave things half installed). When it ends, the
  assistant checks it worked before saying so. Commands that need root ask
  with GNOME's own password dialog. Checks that only look run at once;
  anything that changes the computer waits for you, and clearly
  destructive commands are refused outright.
- **Answer Claude Code and Codex from the island.** When one asks
  permission to run something, an alert at the top shows the project and
  the command with **Deny**, **Allow** and, for Claude Code, **Always**
  (the rule Claude Code itself suggests). When one is done, an alert shows
  the first line of its answer. Answered in the agent's terminal instead,
  put away, or with the agent's window in front, it asks in its terminal
  as before. On by default for each agent found, also one installed later,
  with a one-time alert that it is connected; Settings → AI Usage → AI
  Agents turns each one off. Codex needs 0.124 or later, and asks once at
  its next start to trust Isle's hook.
- **The conversation.** The sparkle (or scrolling up) grows the pill into
  the conversation so far, with a field to type in and the mic beside it.
  Select text to copy it; click a command to copy it. **+** starts a new
  one, with **Undo** for 5 seconds. Settings → Assistant sets how long a
  quiet conversation is kept (until midnight, the default, 2 hours or 30
  minutes) and has **Clear the conversation now**; the AI's own copy goes
  with it. Your voice is never kept, only the words recognised.
- **A bot of your own.** Settings → Assistant → Look: eight shapes
  (circle, pebble, squircle, capsule, cloud, hexagon, drop, ghost), eleven
  colours or your own, shaded rather than flat, and a glow that matches the
  bot, the classic violet and blue, or a colour you pick, with a live
  preview.
- **The shelf lights up as you drop files.** A dashed drop zone brightens
  in the dragged files' colours as they come over it and flares as they
  land; a full shelf turns red and the island shakes; new tiles pop into
  place.

### Changed

- The bot has real eyelids, glances about on a spring, perks up and
  bounces with your voice, reads its answer along, nods at a yes, shakes
  at a no, and looks pleased, focused, puzzled or sleepy.
- The glow around the island is livelier: two highlights travel round the
  rim, and it brightens as you speak.
- The assistant answers sooner: its AI starts as the island opens and
  stays ready for 3 minutes after, Codex runs as an app server, and the
  answer shows as it is written. "Still working · 0:12" shows when a step
  takes a while, and the closed island's bot moves while it works.
- The assistant's page in Settings is named Assistant.
- Automatic uses the first AI you are signed in to, in the order Claude
  Code, Codex, Antigravity.
- Your own AI setup is followed: Isle finds the AI tools wherever npm (with
  a prefix of your own), nvm, volta, fnm, pnpm, bun, Homebrew, mise, asdf
  or Nix put them, and takes what your login shell sets for them (another
  config folder, an API key, a proxy). Claude Code signed in through an API
  key helper, Bedrock or Vertex works; Codex with `CODEX_HOME` or a
  provider of your own works; signing out of Codex or agy is no longer
  undone by Isle's copy.
- A model the AI cannot use (not on your plan, renamed) gives way to its
  own default, and a too-old AI tool or a missing Node.js says so.
- Sign in finds the AI tool where Isle found it, and opens Kitty,
  Alacritty, Konsole, Ghostty, WezTerm, foot and others too.

### Removed

- Alerts from Antigravity (agy), whose hooks never ran. agy still answers
  as the assistant's AI.

### Fixed

- An AI tool that runs on Node.js installed as a snap no longer fails to
  start.

## [0.9.0] - 2026-10-23

### Added

- Two things at once in the closed island: with music playing and the
  focus timer running, the cover stays on the left and the timer's ring and
  time left take the right; on a call, the song's bars or the timer do. The
  island widens only as much as they need, and the clock stays centred.
- A reminder before each event with a time in your desktop calendars
  (Google and others through Online Accounts), 5 minutes ahead by default.
  When the event has a Google Meet, Zoom, Teams or Webex link, **Join**
  opens it. Turned on or off, and how long before, under Alerts in Settings.
- Alerts from AI agents: when Claude Code needs your OK, waits for you or
  is done, and when Codex is done, with the project and what it asks for or
  did. **Show** brings its terminal or editor to the front, and nothing
  shows while that window is already in front. Off by default; Settings →
  AI Usage has a switch for each one installed on the computer, and none
  when there is none. Turning one on adds Isle's hook to that AI's own
  settings, and turning it off (or uninstalling Isle) takes it out again,
  leaving yours as they were.
- Reminders have their own tab, as wide as the island, and a long reminder
  wraps over as many lines as it needs.
- An alert waits while the pointer rests on it; on a touchpad, swipe up to
  put it away or down to open it.

### Changed

- The Focus page is a ring with the time left, the work and break lengths
  to change with − and +, and a Start button.
- Notifications are a plain list, newest first, one line each, with Clear;
  their buttons and × show as the pointer passes over.
- What the island shows grows and shrinks with its shape as it opens and
  closes.
- The assistant's button in the open island is a sparkle, not a microphone.
- Only numbers that change or line up (clocks, timers, percentages) keep
  their figures the same width; others read as ordinary text, and larger
  labels are set a little tighter.
- The closed island's signs sit as far in from each end, and the open
  island's tabs and gear line up with its pages.

### Fixed

- Lyrics of songs over an hour long (mixes, podcasts) are no longer asked
  of LRCLIB again and again: it refuses them.
- Clicking a reminder's or an event's × twice no longer asks isled to
  delete it twice.
- A clipboard card shows its text over all the lines it has room for.

## [0.8.1] - 2026-10-23

Lighter and smoother all round, with nothing changed in how Isle looks.

### Changed

- Logging in and unlocking no longer hold the screen still for a tenth of a
  second: Isle builds itself a part at a time, frames drawn in between.
- `isled` is 42% smaller (6.1 MB) and uses about a quarter less memory;
  the files tray's helper is 0.7 MB, loads no OpenGL or Vulkan driver, and
  quits 20 seconds after the tray closes instead of a minute.
- Claude's usage is not asked for while the screen is locked, and isled
  wakes for it only when it is due.
- A computer without Bluetooth, NetworkManager or a battery costs isled no
  wakeups: it waits for the service to appear.
- Speech recognition remembers a computer has no usable GPU and starts on
  the processor straight away.

### Fixed

- The one-line install works when GitHub's API has had enough questions
  from the address for the hour (an office or campus network): it finds
  the latest release from its page instead.
- Lyrics ease only the lines that change; opening the island on
  notifications, the clipboard, usage, the calendar or reminders keeps what
  is already drawn instead of building it again in the frames that animate.
- Searching the clipboard filters the cards it has instead of rebuilding
  them at each key; the music bars, the assistant's glow and the face leave no
  garbage behind each frame, so the shell pauses less to collect it.
- The island's shape is only redrawn when its size changes; the closed
  island's timers tick only while it is on screen.
- Lyrics a song has none of are looked up again after a week, not each time
  it plays; isled shares one connection for its web requests.
- isled saves its state off its event loop and flushes it when stopped.

## [0.8.0] - 2026-10-23

### Added

- Isle draws the island's icons itself, in one rounded style (volume,
  brightness, keyboard light, touchpad, airplane mode, camera, Bluetooth,
  Wi-Fi, display, warning, update, recording), with the system colours;
  a battery on its side replaces GNOME's upright one.
- Each alert's icon moves once as it appears: charging pulses the bolt, a
  reminder sways the bell, Caps Lock lifts its arrow, a stopped service
  shakes, and new notifications, versions and answers bounce. None with
  animations turned off.
- A ring alert (charging, battery, Bluetooth, AI limits) sweeps from empty
  as its badge pops in and its percentage counts up; a volume or brightness
  bar grows from empty; the speaker's waves come and go one by one with the
  volume, and muting fades to the slashed speaker.
- The assistant's face has expressions that morph into one another, after
  [bloub](https://github.com/jeremy-prt/bloub)'s: attentive, surprised at
  the first word, curious while it thinks, happy with an answer, confused
  when it heard nothing, sad on an error, sleepy when left alone. Its eyes
  sit on a ball that turns to the pointer.
- An assistant answer may take two lines in its alert.

### Changed

- Reminders' header and rows are 24 px, so five fit beside the timer.
- A running timer says when it ends ("Ends at 23:56").
- A notification's icon sits beside its text when it has buttons.
- Brightness and the keyboard light say where they apply.
- The assistant's messages and Isle's alerts use the typographic
  apostrophe ("Didn’t catch that").

### Fixed

- A reminder's row kept growing while it was renamed; its selection took
  the theme's orange.
- Long words (an e-mail address, a link) broke with a hyphen added.
- A queued alert is checked again when its turn comes: none for one read
  or withdrawn meanwhile, and only who it is from if the screen is now
  shared. A critical notification interrupted by another alert comes back.
- "N new notifications" counts each notification once, and plays one sound
  when it shows.
- Off states (Bluetooth off, no Wi-Fi, the camera switched off) no longer
  show the "on" icon.
- An alert that follows one of its kind (a second "Charging") animates in
  again, and an update to a ring alert mid-sweep no longer restarts it.
- Opening the island cancels a close still pending; "Isle restarted" no
  longer shows the first time isled starts; Reset all settings keeps focus
  mode's Do Not Disturb.
- The first alert after login is laid out ahead, so it doesn't drop a
  frame; the face draws each frame without leaving garbage to collect.

## [0.7.3] - 2026-10-22

### Changed

- The top bar is glass or black; the theme's own colour is no longer offered
  (a bar set to it before reads as glass).

### Fixed

- Antigravity's logs (one per request) are deleted at the end of the day,
  with its conversations, instead of piling up in Isle's folder.

## [0.7.2] - 2026-10-22

### Fixed

- The files tray's helper (`isle-shelf`) stayed in memory, about 130 MB,
  when something other than opening the tray started it (a drag passing
  the island, at login): it now quits a minute after starting unless the
  tray is shown, as it does after the tray closes.

## [0.7.1] - 2026-10-22

### Changed

- The assistant's steps read as what it does ("Setting the volume to
  30%…", "Turning Wi-Fi off…"), with each step done ticked on a line of its
  own; a long answer is set smaller and lighter, as a paragraph.
- New screenshots in the README: the notifications page, the files tray,
  the assistant at work and its three ways in, and the alerts.

### Fixed

- Alerts with nothing on the right (a reminder, a new song, a summary of
  notifications) sat off-centre; the alert's sides are now even.
- "5-hour limit" and other text in alerts and the assistant no longer has
  the clock's wide digits and dashes.

## [0.7.0] - 2026-10-22

### Added

- **The voice assistant works as an agent, in the background.** A request
  with several steps ("open Firefox, then put it on the left", "find my CV
  and open it") is done one step after another, each step seeing what the
  last one did. Close the island while it works: it carries on, with a small
  mic in the closed island, and the answer comes as an alert. Click the
  island or press Super+I to watch it, and Stop to end it.
- `isled --doctor` checks speech recognition and each AI: where it is
  installed and whether you are signed in, as Isle itself sees them.
  `isle-setup-voice` runs it at the end. Also `isled --version` and `--help`.
- **Type a request instead of saying it**: start typing while the assistant
  listens, or click the keyboard in its panel. No speech recognition runs.
- A Set up button when speech recognition or the model chosen in Settings is
  missing: it opens a terminal that downloads it, with no command to type.
- **Multiple displays**: the island can follow the display you are using
  (Settings), hanging from its top edge there; GNOME's own volume pop-up
  shows on a display the island is not on.
- **Privacy while sharing the screen**: alerts leave out what notifications
  say, and the clipboard history stays hidden, while the screen is shared or
  recorded.
- Notifications keep their buttons ("Mark as read", "Join") on the alert and
  in the list; critical ones and reminders wait until you are back at the
  computer; right-clicking an alert puts it away.
- A switch to another music player when two run, and lyrics online can be
  turned off.
- Settings: open on a click or after a chosen rest; each system alert on its
  own; GNOME's own banners or calendar menu instead of the island's; the
  assistant's shortcut; an About page with the version, help, a bug report
  to copy and a reset of every setting.
- The island says when a newer Isle is out (GitHub, at most once a day; can
  be turned off), and warns, with a Restart button, when its service stops.
- `isled --report` gathers what a bug report needs: versions, what works and
  recent logs.
- Packages: `.deb`, `.rpm` and an AUR `PKGBUILD`, each attested with build
  provenance, besides the one-line install.

### Changed

- **Speech recognition without Python.** The voice assistant now hears you
  with `isle-whisper`, built on whisper.cpp: no Python environment, and about
  a tenth of the space (the program 29 MB and the `small` model 265 MB,
  instead of up to 3 GB). On an NVIDIA, AMD or Intel Arc graphics card it
  runs through Vulkan, in about a second and with a third of the memory; on
  the processor it is about half as fast as before. Integrated graphics are
  not used (Intel UHD crashed). Updating moves a voice set up before over
  by itself: the installer downloads the new model and deletes the old
  Python environment and model (`isle-setup-voice --remove-old` does the
  same by hand). `isled --doctor` shows the models and where speech runs.
- **A calmer voice panel.** Light rises from the panel's edge and flows
  along the bottom, instead of drifting blobs of colour; it follows your
  voice, and your keys as you type. One round button sits at the end: the
  keyboard, Stop while it works, and Send inside the field as you type. The
  face's eyes read along as you type.
- **The assistant checks its work.** An answer's own actions run before it
  answers, so a step that failed is never answered as done: it tries
  another way or says what did not work. Closing an app counts once its
  windows are gone (one asking to save stays open, and you hear so). Out of
  steps, it says where it got to. Slow steps (opening an app, starting a
  player) get the time they need, and an answer in a code block or in plain
  words is read alike from all three AIs.
- Buttons in the island are translucent grey, and alerts take
  the island's own colours: the Claude and ChatGPT plans their own, red when
  nearly used up; reminders and Caps Lock neutral.
- **Nothing of the assistant runs while you are not asking.** The AI quits
  as soon as a request is done (it used to stay ten minutes) and speech
  recognition once your words are text; both run at a lower priority, take
  everything they started with them when they quit, and transcribing uses at
  most half the processor's cores.
- **Lighter when idle.** `isled` sleeps until its next real deadline instead
  of waking every 30 seconds, checks the clock again on waking from
  suspend, and asks nothing about AI usage while that is turned off; the
  files tray's helper quits a minute after the tray closes; on battery the
  music bars rest after 15 seconds without input.
- Updating keeps your top bar settings: the installer sets Isle's look only
  on a first install. It refuses to run as root, stops before changing
  anything on an unsupported GNOME Shell, and says what went wrong when
  GitHub cannot be reached.
- Uninstalling also removes speech recognition and Isle's caches, and lifts
  a battery charge limit Isle set.
- The installer no longer turns other extensions off (Blur my Shell's top
  bar blur, Hide Top Bar, other islands); it says which to turn off and how.
- Sharing the selected text with the assistant is off by default, and the
  spoken language is detected unless you pick one.
- The clock follows GNOME's own (right after waking from suspend and on a
  time-zone change), and times of day follow the 12/24-hour setting
  everywhere.
- `isled` keeps restarting after repeated crashes instead of giving up, and
  can never gain privileges.
- Building from source needs Rust 1.88 (1.92 with the shelf helper).

### Fixed

- **Smoother opening, closing and switching tabs.** The island no longer
  restyles every page whenever the pointer enters or leaves it, or as one
  page takes over from another. While it rests closed, the pages are
  prepared ahead, including any that changed meanwhile, so the frames that
  animate them only draw.
- **New songs no longer stall the island**: covers are decoded once, off
  the main thread, at the size they are shown, however big the cover a
  browser sends.
- Switching between the player, lyrics and outputs no longer restyles the
  whole music page.
- Opening the calendar or notifications no longer rebuilds them unless
  something changed.
- The assistant finds AIs installed with nvm, volta, fnm or pnpm, and the
  Node.js beside them.
- AI usage shows up soon after login: offline at first, Claude is asked
  again within a minute instead of 20; the Usage tab no longer goes
  missing when Isle starts before GNOME Shell asks for it.
- A second `isled` started by hand (`isled --version` did) no longer takes
  over the running one.
- Plugging in at a battery charge limit no longer repeats the Charging and
  On Battery alerts.
- **Nothing is lost behind a fullscreen window**: alerts, notifications and
  reminders wait and show once it is gone, instead of being thrown away; a
  burst of notifications comes as one; a notification counts as seen only
  once it was on screen. Super+I and Super+V do nothing while the island is
  hidden, so nothing listens unseen.
- A login renewed by Codex or agy inside Isle goes back to your own CLI, so
  neither is signed out.
- Reading files in the shell (thumbnails, clipboard images, covers) no
  longer blocks it.
- A song's cover could stay blank after logging in, deleted with the last
  session's covers as it was saved.
- The AI Usage page of Settings had no icon on GNOME's own theme, and the
  typed request's field took the theme's accent ring.

### Security

- Only GNOME Shell may read the clipboard history from Isle's service or
  steer its assistant; other programs on the session bus are refused.

## [0.5.0] - 2026-10-22

### Added

- **A voice assistant.** Press Super+I (or the mic in the open island) and
  ask, in English or Indonesian: play a song, find a file, open or close an
  app, put windows side by side or in a 2×2 grid, add a reminder or an event,
  change the volume, brightness or dark style, write where your cursor is,
  or ask a question. It works as an agent, looking things up on your computer
  and on the web and showing each step, with the AI you already use: Claude
  Code, Codex or Antigravity, picked in Settings → Voice. Speech is
  recognised on your computer; set it up once with `isle-setup-voice`.
- **AI usage**: how much of your Claude and ChatGPT plans' limits is used,
  one plan at a time with its logo, with a warning as a limit nears its end.
  Only the plans you are signed in to show.
- Reminders the assistant sets show as alerts when due.

### Security

- Each AI is started with only web search and reading pages; Isle runs the
  actions it answers with, opens documents and media but never programs,
  never reads folders that hold keys or passwords, even through a link, and
  treats text from other apps and the web as data, never as instructions.

## [0.4.1] - 2026-10-22

### Fixed

- **GNOME Shell could crash** when the island closed in the moment a ticked
  reminder folded away, or when renaming one reminder and then another.
- The island **no longer shakes by a pixel** while it grows and shrinks:
  its contents stay put on screen, and its edges no longer step back.
- **Switching tabs** no longer makes the tabs jump: names open and close
  smoothly, and the Focus page now fits the same width as the others, so
  the island keeps its size from tab to tab.
- One alert replacing another fades over instead of swapping in a frame,
  and an alert shown again while fading out no longer blinks.
- After adding a reminder with Enter, the field keeps the keyboard, ready
  for the next one.
- `isled` stops when its session ends instead of lingering in the
  background.
- Less work while music plays: synced lyrics no longer retry scrolling
  sixty times a second while hidden, the music bars animate without
  re-laying out the island, the output list is not rebuilt as the volume
  moves, and a cover is decoded once.
- Cached covers and lyrics are trimmed to the latest 500 songs.

### Changed

- The Focus page's Break and Focus are round buttons, lit in the phase's
  colour, so the timer and today's reminders share the usual width.

## [0.4.0] - 2026-10-22

### Added

- A **settings gear** in the open island's header, beside the clock.

### Changed

- **Focus and Reminders share one page**: the timer on the left, today's
  reminders on the right, so what to work on sits beside the time to work
  on it. The header has one tab fewer; this page is a little wider than the
  others to fit both.
- **Reminders** look cleaner: an orange title with the number
  still open, a thin ring per reminder that fills with an orange dot when
  ticked, the title struck through at once, then the row folds away; a
  last "New Reminder" row to add one. Four whole rows show before the list
  scrolls.
- **Alerts are slimmer**: as tall as their text (one line or two), with a
  smaller badge and tighter type, so a short alert wastes no room.
- The island opens when the pointer **rests** on it; passing over it on the
  way to the clock or a menu leaves it closed.

### Fixed

- The island no longer flickers open and closed when the pointer passes
  over the top bar, or when it shrinks under a still pointer after
  switching to a narrower page.
- Opening, closing and resizing settle cleanly, with no one-pixel wobble at
  the end, and stop drawing sooner.
- Closing the island right after ticking a reminder no longer leaves the
  list frozen; the reminder stays done.
- The volume alert no longer repeats "Volume" under its title.

## [0.3.0] - 2026-10-21

### Added

- **Calls** in the island, from any app or browser (WhatsApp, Telegram,
  Meet, Zoom, Discord…): the closed island shows a green phone and how long
  the call has lasted, and a **Call** page appears for as long as the call
  lasts. It shows the call live, so you see yourself and whoever you call
  while you work in other windows, with **Mute** and **Open** to go back to
  the call. The preview is drawn by GNOME Shell from the window already on
  screen, so it costs about nothing and records nothing; it hides while you
  share your screen. Both can be turned off in Settings → Calls.
- Right-clicking the closed island during a call brings the call to the
  front.

### Changed

- **Tasks are now Reminders**, laid out as a reminders list: an orange title
  and count, a round tick box, plain rows under hairlines and a New
  Reminder row last (Enter adds one and leaves the field ready for the
  next). A ticked reminder is struck through and folds away a moment later;
  tapping it again in that moment undoes it. Finished ones are no longer
  listed, and the progress ring is gone.
- The shelf holds six files, which still fit the open island's width.
- A file on its way to the shelf lights the drop area with a dashed, tinted
  outline, brighter under the pointer.
- On-screen displays that come with only an icon (touchpad, airplane mode,
  camera) get a title and an On/Off state in the alert.
- During a call the closed island stays slim: the camera and screen-sharing
  dots sit beside the activity, and the open island's header no longer
  repeats the call.

### Fixed

- Typing into the island (Super+V, a new reminder) works on GNOME Shell 50
  and later.
- The first paste from the clipboard history after logging in is no longer
  lost, and pasting works on every keyboard layout (Dvorak, Colemak, a
  Ctrl/Caps swap, Russian, Greek…) and in the Ptyxis terminal.
- A call's preview and Open stay with the window the call is in, and never
  pick another window of the same browser or an unrelated app.
- The microphone dot still shows when another app records during a call.
- The empty shelf shows the same icon in the island and in the shelf
  helper, whatever the icon theme.
- No more warnings in the log when Isle starts while the microphone is in
  use.

## [0.2.0] - 2026-10-21

### Added

- A **Calendar** page, as a calendar widget: the month on the left
  (today in red, a dot under days with events) and the chosen day's events
  on the right. It shows the desktop's calendars (Google and others through
  Online Accounts) and events written in one line on the island, such as
  "Dinner 8:00 pm" or "Standup 9:00-9:15". isled keeps them
  (`Calendar1` on D-Bus).
- Files on the shelf can be copied with a click: a picture as the image
  itself, so it pastes straight into WhatsApp, an AI chat or any web page,
  and other files as files. Double-click opens a file.
- When a file lands on the shelf, the island glows in its colour from its
  bottom corners.

### Changed

- The lyrics: the line being sung large and bright,
  the others smaller and dimmer, faded edges, breathing dots for pauses and
  a long intro, a clearer column for the player with the music bars by the
  title, and proper states for loading, no lyrics and the service being
  unreachable.
- Dropping a file on the island is much quicker: the shelf helper starts as
  soon as a drag begins and takes the drop as soon as the island opens over
  it (about 0.25 s, from over a second), showing where the file will land.
  A drag that goes off elsewhere closes the island again.
- The cover's colour for the lyrics wash is its main hue, not an average
  that could turn two colours into grey.
- The open island lays its pages out at full size from the start and
  reveals them as it grows, so nothing reflows during the animation.

### Fixed

- Files on the shelf keep their × to remove them: a picture's thumbnail
  made its tile grow until the × was pushed out of sight. Tiles now all
  have one size, the same in the helper's window and on the island.
- The island stays steady when a browser moves on to the next video: the
  song, its cover and the dancing music bars no longer drop out for a
  moment between songs.
- Big photos on the shelf no longer make the island stutter as it opens;
  previews are made off the shell's main thread.
- Lyrics opened on a song already playing scroll to the right line.
- No more warnings in the log when the island starts.

## [0.1.2] - 2026-10-20

### Added

- Support for GNOME Shell 47, 48, 49, 50 and 51 besides 46, so Isle installs
  on Ubuntu 24.04 up to 26.10 and the Fedora releases with those versions,
  looking and moving the same on each. Volume and brightness alerts follow
  GNOME 49's new way of showing them, per monitor.
- An [installation guide](docs/install.md): checking the desktop, installing,
  updating, uninstalling, installing offline and troubleshooting.

### Fixed

- Lists scroll with a mouse wheel again: notifications, sound outputs and
  tasks only followed a touchpad.
- The music bars in the closed island keep dancing when the song changes;
  players that drop the title for a moment between songs (Spotify) froze
  them until the island was opened and closed.
- The playing app's badge stays on the cover's corner: with Spotify the
  cover drifted left, leaving a gap before the title, and the badge sat
  apart from it. The same in the song alert.
- `install.sh` finishes without a user service manager (over SSH, say);
  isled then starts when the extension first calls it.

## [0.1.1] - 2026-10-20

### Added

- A one-line install that needs no compiler or cloning:
  `curl -fsSL https://raw.githubusercontent.com/zickrian/isle/main/get.sh | bash`.
  It downloads the latest release package, checks its checksum and installs
  it, leaving an `isle-uninstall` command.
- Release packages with the programs ready-built
  (`isle-<version>-x86_64-linux.tar.gz`), made by a Release workflow for
  every version tag; `install.sh` uses ready-built programs when present.
- Notifications from one app fold into a stack: the newest
  card, the next one's edge under it and "+2 more from Chrome", which
  unfolds them under the app's name with "Show less".

### Changed

- A paused song keeps its cover in the closed island, with the music bars
  resting and dimmed, until the player closes.
- `isle-shelf` draws on the CPU (GTK's cairo renderer): about 28 MB instead
  of 40. A renderer set with `GSK_RENDERER` is kept.
- D-Bus names move to the project's own namespace,
  `io.github.zickrian.isle.*` (`/io/github/zickrian/isle/…`).
  `./install.sh` removes the activation files of the old names.

## [0.1.0] - 2026-10-20

The first release.

### Added

- A code of conduct (Contributor Covenant 2.1) and a security policy.
- A README with a demo, screenshots, installation steps for Ubuntu and
  Fedora, usage, measured resource use, privacy notes and troubleshooting.
- One look across every page: Isle's own solid icons for
  play, pause, skip, close, check, add and the folding arrows instead of
  the theme's; controls are pills and cards share a 12 px corner; the
  Clipboard / Files switch is a segmented control whose chosen segment is
  raised.
- Music laid out as a now-playing card: a large cover beside the title,
  the scrubber and the controls, with lyrics and output as small buttons
  at the top right. Tasks stack today's progress under the ring, drop the
  repeated empty message, and scroll to the finished tasks when unfolded.
- Alerts: the first one shown measures its width right (Volume read
  "Vol…"); focus alerts tint their icon; a critical notification is red; a
  new song carries the playing app's icon; battery and Bluetooth rings hold
  a lit badge; "Keyboard brightness" reads "Keyboard light".
- The closed island keeps the clock centred and whole next to the privacy
  dots. Shelf files that are gone show a plain file icon.
- Tidier pages: Notifications fill the width under a slim row with the
  count and round Do Not Disturb and Clear All buttons; Focus shows the
  time inside its ring with the phase, today's total and one row of
  controls beside it; the clipboard search is a round button that opens
  into a field.
- Notification cards: the app's icon (a system one on a grey
  tile), the title with its time on the right, and a close button in the
  time's place under the pointer. Lists fade out at an edge that scrolls
  on instead of being cut.
- Alerts look cleaner: icon badges lit in the alert's colour with a soft
  gradient, and Caps Lock as its own icon with an "On" / "Off" pill.
- Type set in Inter, which the installer
  now puts in `~/.local/share/fonts/isle`; semibold titles, tighter
  tracking on large figures, medium-weight top bar text instead of the
  theme's bold, and the date without the year ("Tue 20 Oct"). The shelf's
  drag-and-drop window uses the same type.
- Tabs in the open island's header: one per page, the open
  one named on a dark grey pill, and a red dot while notifications are unseen.
  They replace the side arrows and page dots. The island
  reopens on the page picked last (for 5 minutes), and stays on the Shelf
  after a file was dragged onto it.
- The playing app's icon on the cover's corner, found by name when the
  player gives no desktop entry (Chrome).
- A glass top bar, the new default: see-through with no colour of its own,
  and the island as a black notch hanging from the top of the screen.
  "Top bar" in the settings picks glass,
  black (the island blends in) or the theme's colour.
- The closed island sits inside the top bar (32 px), like a notch:
  maximised windows start right below it and the island never covers an
  app. Alerts and the open island still hang below
  for as long as they are shown. "Island inside the top bar" in the settings
  turns it off.

- The island in the GNOME top bar: compact, alert and open presentations
  with spring-driven morphs and a black top bar it blends into.
- Music with cover art, scrubber, controls and synced lyrics (LRCLIB).
- GNOME notifications in the island, a Notifications page and Do Not Disturb.
- Pomodoro focus timer with phase chips.
- Tasks as a plain list with a daily reset of finished tasks: a progress
  ring, an always-ready add field, rename by clicking a title, and finished
  tasks folded under "Completed".
- File shelf with drag and drop through the `isle-shelf` helper.
- Alerts for charging, battery, losing the connection, Bluetooth, volume,
  brightness and Caps Lock.
- Privacy dots for the camera, microphone and screen sharing; a screen
  recording timer with a stop button.
- Volume and output device switching on the music page.
- Daily focus totals and Do Not Disturb during focus sessions.
- Rubber-band stretch when the volume is pressed past its limit.
- Clipboard history on the Shelf page (Clipboard · Files): the 20 latest
  copies plus up to 10 pinned, as cards with search and type filters; click
  to copy, Super+V and Enter to paste, hand-offs to Tasks and Files;
  password managers and chosen apps are ignored.
- The Files tab holds up to 5 files with no scrolling; dragging a file
  towards the island opens it and says whether the file can land, and the
  island stays open while a file is dragged out.
- Right-click brings the music player to the front.
- GNOME's calendar drop-down no longer appears alongside the island.
- Shelf files can be removed with × even without the `isle-shelf` helper.
- The focus timer, and Do Not Disturb during focus, survive the lock screen
  and an `isled` restart.
- `isled` D-Bus service, install and uninstall scripts, product spec and
  D-Bus API docs.

### Changed

- The extension's id is `isle@zickrian.github.io`. `./install.sh` replaces
  an install under the development id `isle@isle.github.io`, keeping its
  settings.

### Fixed

- Lyrics no longer say "Check your connection" when LRCLIB is only busy:
  busy answers are retried at once, and the island tells a busy service
  from being offline. Lookups for YouTube titles are more robust, and media
  without an artist (an Instagram reel) is no longer matched to a random
  song.
- Files can be dragged onto the shelf again: its drop window appeared in the
  middle of the screen instead of over the island.
- An app's logo sent in place of a cover (Chrome does when a page has none)
  is shown on its own, without a dark tile behind it.
- Swiping between pages no longer skips a page or stalls: each swipe was
  counted twice (as a smooth scroll and as clicks), and the leftover of one
  swipe carried into the next. Sideways swipes now turn pages even over
  lists and lyrics.
- Alerts on a glass bar no longer start with an empty black band, and fit
  their content instead of always being 380 px wide.
- With Blur my Shell's popup blur on, the Tasks and clipboard search fields
  were black on black: it restyles every text field in the shell.
- Lyrics over a grey cover are readable: neutral covers now tint the island
  dark, vivid ones bright.
- Text is at least 12 px throughout.

[Unreleased]: https://github.com/zickrian/isle/compare/v1.5.1...HEAD
[1.5.1]: https://github.com/zickrian/isle/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/zickrian/isle/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/zickrian/isle/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/zickrian/isle/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/zickrian/isle/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/zickrian/isle/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/zickrian/isle/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/zickrian/isle/compare/v1.0.6...v1.1.0
[1.0.6]: https://github.com/zickrian/isle/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/zickrian/isle/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/zickrian/isle/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/zickrian/isle/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/zickrian/isle/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/zickrian/isle/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/zickrian/isle/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/zickrian/isle/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/zickrian/isle/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/zickrian/isle/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/zickrian/isle/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/zickrian/isle/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/zickrian/isle/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/zickrian/isle/compare/v0.5.0...v0.7.0
[0.5.0]: https://github.com/zickrian/isle/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/zickrian/isle/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/zickrian/isle/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zickrian/isle/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/zickrian/isle/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/zickrian/isle/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zickrian/isle/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zickrian/isle/releases/tag/v0.1.0
