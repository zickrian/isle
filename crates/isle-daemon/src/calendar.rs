// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Utc};
use isle_core::calendar::{AddError, Calendar, Event, Parsed, Send, format_time, parse};
use log::warn;
use tokio::sync::Notify;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface};

use crate::clock::today;
use crate::eds;
use crate::meeting::MeetingLinks;
use crate::store::Store;

/// Longest calendar or event id `MeetingLink` and `AddTo` take.
const MAX_UID: usize = 1024;
/// `AddTo`'s name for Isle's own calendar.
const OWN: &str = "isle";
/// `AddTo` answers within this, inside the extension's 25 s for a D-Bus call: one that gave up first
/// would leave the event to be added again.
const ADD_WITHIN: std::time::Duration = std::time::Duration::from_secs(20);
/// Events kept here while their calendar was out of reach are tried again this often.
const SEND_EVERY: std::time::Duration = std::time::Duration::from_secs(30);
/// A calendar in reach that turns an event down this many times running keeps it here for good.
const MAX_REFUSALS: u32 = 10;

/// The D-Bus calendar: Isle's own events, saved to disk, plus meeting links of desktop events.
pub struct CalendarService {
    /// Under a lock of its own, held for a moment: zbus's lock on the service is only ever read, so a
    /// slow `AddTo` never holds up the rest (the preview of a line typed, a ×).
    calendar: Mutex<Calendar>,
    store: Store<Calendar>,
    links: MeetingLinks,
    /// Told when an event starts waiting for its calendar: `send_waiting` sleeps on it while none waits.
    waiting: Arc<Notify>,
}

impl CalendarService {
    /// Loads the saved events, dropping past ones.
    pub fn load() -> Self {
        let mut store = Store::new("calendar");
        let mut calendar: Calendar = store.load();
        if calendar.forget_old(&today()) {
            store.save(&calendar);
        }
        Self {
            calendar: Mutex::new(calendar),
            store,
            links: MeetingLinks::default(),
            waiting: Arc::default(),
        }
    }

    /// The events, for the assistant and the agenda; let go of before any wait.
    pub fn calendar(&self) -> MutexGuard<'_, Calendar> {
        self.calendar.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Saves the events and tells the extension they changed.
    async fn changed(&self, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        self.store.save(&self.calendar());
        self.events_changed(emitter).await
    }

    /// Adds an event (see `add`), waiting to be sent where `send` says, if anywhere.
    async fn keep(
        &self,
        date: &str,
        text: &str,
        send: Option<Send>,
        emitter: &SignalEmitter<'_>,
    ) -> fdo::Result<u64> {
        let id = {
            let mut calendar = self.calendar();
            let id = calendar.add(date, text).map_err(|err| {
                fdo::Error::InvalidArgs(match err {
                    AddError::BadDate => format!("`{date}` is not a date (YYYY-MM-DD)"),
                    AddError::NoTitle => "an event needs a title".into(),
                })
            })?;
            if send.is_some() {
                calendar.set_send(id, send);
                self.waiting.notify_one();
            }
            calendar.forget_old(&today());
            id
        };
        self.changed(emitter).await?;
        Ok(id)
    }
}

#[interface(name = "io.github.zickrian.isle.Calendar1")]
impl CalendarService {
    /// Adds an event on `date` ("YYYY-MM-DD") from a line of text such as
    /// "Lunch 12:30" or "Standup 9:00-9:15"; returns its id.
    async fn add(
        &self,
        date: &str,
        text: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<u64> {
        self.keep(date, text, None, &emitter).await
    }

    /// Adds an event to `calendar` ("isle" for Isle's own, "" for the first that takes it), else keeps it in
    /// Isle's own, waiting to be sent if its calendar is out of reach. Returns the calendar's uid, or "".
    async fn add_to(
        &self,
        calendar: &str,
        date: &str,
        text: &str,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> fdo::Result<String> {
        if calendar.len() > MAX_UID {
            return Err(fdo::Error::InvalidArgs("no such calendar".into()));
        }
        let day = NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| fdo::Error::InvalidArgs(format!("`{date}` is not a date (YYYY-MM-DD)")))?;
        let parsed =
            parse(text).ok_or_else(|| fdo::Error::InvalidArgs("an event needs a title".into()))?;
        // One iCalendar uid for every calendar tried, and every later try: it never lands twice.
        let uid = new_uid(Utc::now());
        // None for a time that day doesn't have (a daylight saving gap): kept in Isle's own.
        let ical = ical_event(day, &parsed, &Local, Utc::now(), &uid);
        // How far it got, for when time runs out mid-way.
        let progress = Mutex::new(Progress::default());
        let progress = || progress.lock().unwrap_or_else(PoisonError::into_inner);
        // Where it went, or the first calendar out of reach (where it waits to go), if any.
        let attempt = async {
            // Not waiting on whether each is read only: the one picked is tried, and turns it down if so;
            // among the rest, one already known to (a holiday calendar) is passed over.
            let mut targets = if calendar == OWN {
                Vec::new()
            } else {
                eds::accounts_calendars(connection)
                    .await
                    .unwrap_or_default()
            };
            if let Some(picked) = targets.iter().position(|target| target.uid == calendar) {
                targets = vec![targets.swap_remove(picked)];
            } else {
                targets.retain(|target| !eds::known_read_only(&target.uid));
            }
            let Some(ical) = ical.as_deref() else {
                return Err(None);
            };
            place(&targets, |target| {
                let target = target.clone();
                async move {
                    {
                        let mut now = progress();
                        now.trying = Some(target.uid.clone());
                        now.sending = false;
                    }
                    let sending = || progress().sending = true;
                    let created = eds::create_event(connection, &target, ical, sending).await;
                    let mut now = progress();
                    if !matches!(created, eds::Created::Yes | eds::Created::Unsure) {
                        now.trying = None;
                    }
                    if matches!(created, eds::Created::Offline) {
                        now.out_of_reach.get_or_insert_with(|| target.uid.clone());
                    }
                    created
                }
            })
            .await
        };
        let send = match tokio::time::timeout(ADD_WITHIN, attempt).await {
            Ok(Ok(uid)) => return Ok(uid),
            Ok(Err(out_of_reach)) => out_of_reach.map(|calendar| Send { calendar, uid }),
            Err(_) => match out_of_time(std::mem::take(&mut *progress()), uid) {
                Ok(calendar) => return Ok(calendar),
                Err(send) => send,
            },
        };
        // Kept in Isle's own, once this call lets go: it waited on EDS without holding up the calendar.
        let (bus, date, text) = (connection.clone(), date.to_owned(), text.to_owned());
        tokio::spawn(async move {
            let added = async {
                let own = bus
                    .object_server()
                    .interface::<_, CalendarService>(crate::OBJECT_PATH)
                    .await?;
                let emitter = own.signal_emitter().clone();
                own.get().await.keep(&date, &text, send, &emitter).await
            };
            if let Err(err) = added.await {
                warn!("could not keep the event in Isle's own calendar: {err}");
            }
        });
        Ok(String::new())
    }

    /// JSON `[{uid, name, account, color}]` of the calendars that take new events, by account and name.
    /// Fails while Evolution Data Server can't be asked, so that is never taken for no accounts.
    async fn calendars(
        &self,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> fdo::Result<String> {
        let found = eds::calendars(connection)
            .await
            .ok_or_else(|| fdo::Error::Failed("Evolution Data Server can't be asked yet".into()))?;
        Ok(serde_json::to_string(&found).unwrap_or_else(|_| "[]".into()))
    }

    /// JSON object of every desktop calendar's colour ("#rrggbb") by uid, read only ones too.
    async fn colors(&self, #[zbus(connection)] connection: &zbus::Connection) -> String {
        serde_json::to_string(&eds::colors(connection).await).unwrap_or_else(|_| "{}".into())
    }

    /// How `Add` reads a line of text, without adding it: JSON `{title, start, end}`, times as "HH:MM" or
    /// null (all day; no end). Fails when no title is left.
    fn parse(&self, text: &str) -> fdo::Result<String> {
        let parsed =
            parse(text).ok_or_else(|| fdo::Error::InvalidArgs("an event needs a title".into()))?;
        Ok(serde_json::json!({
            "title": parsed.title,
            "start": parsed.start.map(format_time),
            "end": parsed.end.map(format_time),
        })
        .to_string())
    }

    /// Deletes one of Isle's own events.
    async fn remove(
        &self,
        id: u64,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let send = {
            let mut calendar = self.calendar();
            let send = (calendar.events().iter())
                .find(|event| event.id == id)
                .and_then(|event| event.send.clone());
            if !calendar.remove(id) {
                return Err(fdo::Error::InvalidArgs(format!("no event with id {id}")));
            }
            send
        };
        // One waiting to be sent may have got there on a try that had no word back: out of there too.
        if let Some(to) = send {
            let bus = connection.clone();
            tokio::spawn(async move { eds::remove_event(&bus, &to.calendar, &to.uid).await });
        }
        Ok(self.changed(&emitter).await?)
    }

    /// The meeting link (Meet, Zoom, Teams, Webex) of a desktop calendar's event, or "".
    /// Calls here wait for a lookup in Evolution Data Server, at most a few seconds.
    async fn meeting_link(
        &self,
        source_uid: &str,
        event_uid: &str,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> fdo::Result<String> {
        let fits = |uid: &str| !uid.is_empty() && uid.len() <= MAX_UID;
        if !fits(source_uid) || !fits(event_uid) {
            return Err(fdo::Error::InvalidArgs(
                "a calendar and an event id are needed".into(),
            ));
        }
        Ok(self.links.get(connection, source_uid, event_uid).await)
    }

    /// JSON array of `Event`, by day and start time.
    #[zbus(property)]
    fn events(&self) -> String {
        serde_json::to_string(self.calendar().events()).unwrap_or_default()
    }
}

/// How far `AddTo` got: the calendar being sent to, whether its server has the event in hand, and the
/// first calendar found out of reach.
#[derive(Default)]
struct Progress {
    trying: Option<String>,
    sending: bool,
    out_of_reach: Option<String>,
}

/// Where event `uid` goes when `AddTo` runs out of time: the calendar whose server had it in hand, or else
/// (the error) Isle's own, waiting for the calendar it was going to or found out of reach.
fn out_of_time(progress: Progress, uid: String) -> Result<String, Option<Send>> {
    match progress.trying {
        Some(calendar) if progress.sending => Ok(calendar),
        trying => Err(trying
            .or(progress.out_of_reach)
            .map(|calendar| Send { calendar, uid })),
    }
}

/// Every [`SEND_EVERY`] while any wait, sends the events waiting for their calendar, with their first uid so
/// none lands twice; one that got there leaves Isle's own, one whose calendar went or keeps refusing stays.
pub async fn send_waiting(own: InterfaceRef<CalendarService>, bus: zbus::Connection) {
    let mut refusals: HashMap<u64, u32> = HashMap::new();
    let wake = own.get().await.waiting.clone();
    loop {
        // No timer while none waits: the first to start waiting wakes this.
        if own.get().await.calendar().waiting().next().is_none() {
            wake.notified().await;
        }
        tokio::time::sleep(SEND_EVERY).await;
        let waiting: Vec<Event> = own.get().await.calendar().waiting().cloned().collect();
        if waiting.is_empty() {
            continue;
        }
        // Evolution Data Server not there (yet): no word on any calendar. One read only (not just
        // seeming so while signing in) turns each try down, until it stays in Isle's own.
        let Some(targets) = eds::accounts_calendars(&bus).await else {
            continue;
        };
        let send = |target: &eds::Target, ical: String| {
            let (bus, target) = (bus.clone(), target.clone());
            async move { eds::create_event(&bus, &target, &ical, || ()).await }
        };
        for (id, sent) in send_round(&waiting, &targets, &mut refusals, send).await {
            let emitter = own.signal_emitter().clone();
            let service = own.get().await;
            let there = {
                let mut calendar = service.calendar();
                if sent {
                    calendar.remove(id)
                } else {
                    calendar.set_send(id, None)
                }
            };
            if there && let Err(err) = service.changed(&emitter).await {
                warn!("could not save the calendar: {err}");
            }
            drop(service);
            // Deleted in Isle while it went: out of its calendar too.
            let sent_to = waiting.iter().find(|event| event.id == id);
            if sent
                && !there
                && let Some(to) = sent_to.and_then(|event| event.send.as_ref())
            {
                eds::remove_event(&bus, &to.calendar, &to.uid).await;
            }
        }
    }
}

/// Sends an event to `targets` in turn with `send`, until one has it: that one's uid, or else (as the
/// error) the first one out of reach, where it is to wait to go, if any.
async fn place<F, Fut>(targets: &[eds::Target], mut send: F) -> Result<String, Option<String>>
where
    F: FnMut(&eds::Target) -> Fut,
    Fut: Future<Output = eds::Created>,
{
    let mut out_of_reach = None;
    for target in targets {
        match send(target).await {
            eds::Created::Yes | eds::Created::Unsure => return Ok(target.uid.clone()),
            eds::Created::Offline => {
                out_of_reach.get_or_insert_with(|| target.uid.clone());
            }
            // Read only, signed out: the next, or Isle's own.
            eds::Created::No(err) => {
                warn!("could not add the event to calendar {}: {err}", target.uid)
            }
        }
    }
    Err(out_of_reach)
}

/// One round of sending `waiting`: each settled event's id and whether it got there, or stays for good
/// (its calendar gone, or refused `MAX_REFUSALS` times running); the rest wait for the next round.
async fn send_round<F, Fut>(
    waiting: &[Event],
    targets: &[eds::Target],
    refusals: &mut HashMap<u64, u32>,
    mut send: F,
) -> Vec<(u64, bool)>
where
    F: FnMut(&eds::Target, String) -> Fut,
    Fut: Future<Output = eds::Created>,
{
    let mut settled = Vec::new();
    for event in waiting {
        let Some(to) = &event.send else {
            continue;
        };
        let sent = match targets.iter().find(|target| target.uid == to.calendar) {
            // Its account removed, or the calendar read only now.
            None => Some(false),
            Some(target) => match ical_of(event, &to.uid) {
                None => Some(false),
                Some(ical) => match send(target, ical).await {
                    eds::Created::Yes => Some(true),
                    // Its uid makes the next try say whether it got there.
                    eds::Created::Offline | eds::Created::Unsure => None,
                    eds::Created::No(err) => {
                        warn!("could not send event {} to {}: {err}", event.id, target.uid);
                        let refused = refusals.entry(event.id).or_default();
                        *refused += 1;
                        (*refused >= MAX_REFUSALS).then_some(false)
                    }
                },
            },
        };
        if let Some(sent) = sent {
            refusals.remove(&event.id);
            settled.push((event.id, sent));
        }
    }
    settled
}

/// A new event's iCalendar uid.
fn new_uid(now: DateTime<Utc>) -> String {
    format!(
        "isle-{}-{}",
        now.timestamp_nanos_opt().unwrap_or_default(),
        std::process::id()
    )
}

/// One of Isle's own events as iCalendar with `uid`, as `ical_event` makes it from its line of text.
fn ical_of(event: &Event, uid: &str) -> Option<String> {
    let day = NaiveDate::parse_from_str(&event.date, "%Y-%m-%d").ok()?;
    let minutes = |time: &String| {
        let (hours, minutes) = time.split_once(':')?;
        Some(hours.parse::<u32>().ok()? * 60 + minutes.parse::<u32>().ok()?)
    };
    let parsed = Parsed {
        title: event.title.clone(),
        start: event.start.as_ref().and_then(minutes),
        end: event.end.as_ref().and_then(minutes),
    };
    ical_event(day, &parsed, &Local, Utc::now(), uid)
}

/// An event as iCalendar for a desktop calendar: all day, or from its start in `zone` to its end (an
/// hour on without one), in UTC. `None` for a time that doesn't exist that day.
fn ical_event<Tz: TimeZone>(
    day: NaiveDate,
    event: &Parsed,
    zone: &Tz,
    now: DateTime<Utc>,
    uid: &str,
) -> Option<String> {
    let stamp = |at: DateTime<Utc>| at.format("%Y%m%dT%H%M%SZ").to_string();
    let at = |minutes: u32| {
        let local = day.and_hms_opt(minutes / 60, minutes % 60, 0)?;
        // `earliest` resolves times made ambiguous by daylight saving changes.
        Some(
            zone.from_local_datetime(&local)
                .earliest()?
                .with_timezone(&Utc),
        )
    };
    let when = match event.start {
        Some(start) => {
            let from = at(start)?;
            let to = event.end.and_then(at).unwrap_or(from + Duration::hours(1));
            format!("DTSTART:{}\r\nDTEND:{}", stamp(from), stamp(to))
        }
        None => format!(
            "DTSTART;VALUE=DATE:{}\r\nDTEND;VALUE=DATE:{}",
            day.format("%Y%m%d"),
            day.succ_opt()?.format("%Y%m%d")
        ),
    };
    Some(format!(
        "BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:{}\r\n{when}\r\nSUMMARY:{}\r\nEND:VEVENT\r\n",
        stamp(now),
        escape(&event.title)
    ))
}

/// Text as an iCalendar value: backslashes, commas, semicolons and line breaks escaped.
fn escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use chrono::FixedOffset;

    use super::*;

    #[test]
    fn out_of_time_an_event_is_kept_unless_its_server_had_it() {
        let at = |trying: Option<&str>, sending, out_of_reach: Option<&str>| Progress {
            trying: trying.map(str::to_owned),
            sending,
            out_of_reach: out_of_reach.map(str::to_owned),
        };
        let send = |calendar: &str| {
            Some(Send {
                calendar: calendar.into(),
                uid: "u".into(),
            })
        };
        assert_eq!(
            out_of_time(at(Some("work"), true, None), "u".into()),
            Ok("work".into())
        );
        // Still asking whether its server is there: it waits to go there.
        let progress = at(Some("work"), false, Some("home"));
        assert_eq!(out_of_time(progress, "u".into()), Err(send("work")));
        assert_eq!(
            out_of_time(at(None, false, Some("home")), "u".into()),
            Err(send("home"))
        );
        assert_eq!(out_of_time(at(None, false, None), "u".into()), Err(None));
    }

    fn event(text: &str) -> String {
        let jakarta = FixedOffset::east_opt(7 * 3600).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 10, 27, 2, 0, 0).unwrap();
        let day = NaiveDate::from_ymd_opt(2026, 10, 28).unwrap();
        ical_event(day, &parse(text).unwrap(), &jakarta, now, "isle-test").unwrap()
    }

    fn target(uid: &str) -> eds::Target {
        eds::Target {
            uid: uid.into(),
            name: uid.into(),
            account: "me".into(),
            color: String::new(),
            server: None,
        }
    }

    fn refused() -> eds::Created {
        eds::Created::No(zbus::Error::Failure("read only".into()))
    }

    /// Where an event goes among calendars "a" and "b", each answering as `outcome` says.
    async fn place_with(outcome: fn(&str) -> eds::Created) -> Result<String, Option<String>> {
        let targets = [target("a"), target("b")];
        place(&targets, |target| std::future::ready(outcome(&target.uid))).await
    }

    #[tokio::test]
    async fn an_event_goes_to_the_first_calendar_that_takes_it() {
        assert_eq!(place_with(|_| eds::Created::Yes).await, Ok("a".into()));
        // Sent with no answer in time: most likely there, never sent twice.
        assert_eq!(place_with(|_| eds::Created::Unsure).await, Ok("a".into()));
        let a_refuses = |uid: &str| {
            if uid == "a" {
                refused()
            } else {
                eds::Created::Yes
            }
        };
        assert_eq!(place_with(a_refuses).await, Ok("b".into()));
        // Out of reach: it waits to go to the first one out of reach.
        assert_eq!(
            place_with(|_| eds::Created::Offline).await,
            Err(Some("a".into()))
        );
        let a_refuses_b_offline = |uid: &str| {
            if uid == "a" {
                refused()
            } else {
                eds::Created::Offline
            }
        };
        assert_eq!(place_with(a_refuses_b_offline).await, Err(Some("b".into())));
        assert_eq!(place_with(|_| refused()).await, Err(None));
        let none = place(&[], |_| std::future::ready(eds::Created::Yes)).await;
        assert_eq!(none, Err(None));
    }

    /// One round of sending `waiting` to `targets`, each send answering `outcome`.
    async fn round(
        waiting: &[Event],
        targets: &[eds::Target],
        refusals: &mut HashMap<u64, u32>,
        outcome: fn() -> eds::Created,
    ) -> Vec<(u64, bool)> {
        send_round(waiting, targets, refusals, |_, _| {
            std::future::ready(outcome())
        })
        .await
    }

    #[tokio::test]
    async fn waiting_events_are_sent_once_in_reach_and_given_up_on_for_cause() {
        let mut calendar = Calendar::default();
        let id = calendar.add("2026-10-28", "Lunch 12:00").unwrap();
        let send = Send {
            calendar: "a".into(),
            uid: "isle-1".into(),
        };
        calendar.set_send(id, Some(send));
        let waiting: Vec<Event> = calendar.waiting().cloned().collect();
        let targets = [target("a")];
        let mut refusals = HashMap::new();
        // Still out of reach, or no word back: tried again next round.
        let offline = round(&waiting, &targets, &mut refusals, || eds::Created::Offline).await;
        assert_eq!(offline, []);
        let unsure = round(&waiting, &targets, &mut refusals, || eds::Created::Unsure).await;
        assert_eq!(unsure, []);
        let sent = round(&waiting, &targets, &mut refusals, || eds::Created::Yes).await;
        assert_eq!(sent, [(id, true)]);
        // Turned down: given up on only after MAX_REFUSALS times running.
        for _ in 1..MAX_REFUSALS {
            assert_eq!(round(&waiting, &targets, &mut refusals, refused).await, []);
        }
        let given_up = round(&waiting, &targets, &mut refusals, refused).await;
        assert_eq!(given_up, [(id, false)]);
        // Its calendar gone (account removed, read only now): kept here for good, nothing sent.
        let calls = std::cell::Cell::new(0);
        let gone = send_round(&waiting, &[target("b")], &mut HashMap::new(), |_, _| {
            calls.set(calls.get() + 1);
            std::future::ready(eds::Created::Yes)
        })
        .await;
        assert_eq!((gone, calls.get()), (vec![(id, false)], 0));
    }

    #[test]
    fn a_kept_event_is_sent_as_its_line_was_read() {
        let mut calendar = Calendar::default();
        let id = calendar.add("2026-10-28", "Shift 1800 - 2200").unwrap();
        let event = calendar.events().iter().find(|e| e.id == id).unwrap();
        let ical = ical_of(event, "isle-1").unwrap();
        assert!(ical.contains("UID:isle-1\r\n"), "{ical}");
        assert!(ical.contains("SUMMARY:Shift\r\n"), "{ical}");
        let day = calendar.add("2026-10-28", "Holiday").unwrap();
        let event = calendar.events().iter().find(|e| e.id == day).unwrap();
        assert!(
            ical_of(event, "isle-2")
                .unwrap()
                .contains("DTSTART;VALUE=DATE:20261028\r\n")
        );
    }

    #[test]
    fn a_timed_event_is_in_utc() {
        let ical = event("Standup 9:00-9:15");
        assert!(
            ical.contains("DTSTART:20261028T020000Z\r\nDTEND:20261028T021500Z"),
            "{ical}"
        );
        assert!(ical.contains("SUMMARY:Standup\r\n"), "{ical}");
        assert!(ical.contains("UID:isle-test\r\n"), "{ical}");
    }

    #[test]
    fn without_an_end_it_lasts_an_hour() {
        assert!(
            event("Dinner 8:00 pm").contains("DTSTART:20261028T130000Z\r\nDTEND:20261028T140000Z")
        );
    }

    #[test]
    fn without_a_time_it_takes_the_day() {
        let ical = event("Holiday");
        assert!(
            ical.contains("DTSTART;VALUE=DATE:20261028\r\nDTEND;VALUE=DATE:20261029"),
            "{ical}"
        );
    }

    #[test]
    fn the_title_is_escaped() {
        assert!(event("Lunch; Raka, Dina 12:00").contains("SUMMARY:Lunch\\; Raka\\, Dina\r\n"));
    }
}
