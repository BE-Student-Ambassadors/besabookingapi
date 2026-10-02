import type {calendar_v3} from "googleapis";

import {
  DayKey,
  OFFICE_HOURS_TIME_ZONE,
  STOPPED_WEEKLY_PROPERTY,
  WeeklySeries,
  addDays,
  dayKeyOf,
  parseWeeklySeries,
  toLocal,
} from "./officeHours";

// Applies a permanent office-hours change requested from the booking site's calendar view
// (an OfficeHoursChangeRequests doc) to the "{Name}'s Availability" recurring events on
// Google Calendar. The calendar is the source of truth for these BESAs' weekly hours, so
// officeHours.ts picks the change up on its next sync. Actions, all from `date` on:
//   - change: a weekly slot moves from `from` to `to`
//   - remove: the weekly slot `from` stops on that weekday
//   - add:    a new weekly slot `to` on that weekday
//   - removeAll: every weekly slot on every weekday stops (all of the BESA's office hours)
//
// change/remove work like Google's "this and following events": the series that has the
// slot on that weekday ends the day before `date` (and for remove is marked stopped, so the
// sync doesn't carry it forward). Other weekdays that shared the series carry on unchanged
// in a continuation series. Past occurrences are left as they were.

export type PermanentChangeAction = "change" | "remove" | "add" | "removeAll";

export type PermanentChangeRequest = {
  besaId: string;
  email: string;
  name: string;
  date: string; // YYYY-MM-DD, first date with the new hours
  action?: PermanentChangeAction; // missing = "change" (requests made before add/remove existed)
  from?: {start: string; end: string}; // HH:mm, the weekly slot being changed or removed
  to?: {start: string; end: string}; // HH:mm, the new slot for change/add
};

const BYDAY_CODES: Record<DayKey, string> = {
  sunday: "SU", monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA",
};

function rruleFields(rrule: string) {
  return Object.fromEntries(
    rrule.slice("RRULE:".length).split(";").map((pair) => pair.split("=") as [string, string])
  );
}

function buildRrule(fields: Record<string, string>) {
  return "RRULE:" + Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(";");
}

// UTC instant for a Pacific wall-clock time, e.g. the end of a day for RRULE UNTIL.
export function pacificToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm, ss || 0);
  let guess = asUtc;
  for (let i = 0; i < 2; i += 1) {
    const local = toLocal(new Date(guess));
    const [ly, lm, ld] = local.date.split("-").map(Number);
    const [lh, lmin] = local.time.split(":").map(Number);
    const localAsUtc = Date.UTC(ly, lm - 1, ld, lh, lmin, ss || 0);
    guess += asUtc - localAsUtc;
  }
  return new Date(guess);
}

function untilEndOf(date: string) {
  return pacificToUtc(date, "23:59:59").toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// First date on or after `from` that falls on one of `days`.
function firstDateOn(from: string, days: DayKey[]) {
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(from, i);
    if (days.includes(dayKeyOf(date))) return date;
  }
  return from;
}

// `fresh` = a new series copied from `master`; it must not inherit a stopped marker.
function seriesBody(
  master: calendar_v3.Schema$Event,
  date: string,
  slot: {start: string; end: string},
  rrule: string,
  fresh = false
): calendar_v3.Schema$Event {
  const shared = {...master.extendedProperties?.shared};
  delete shared[STOPPED_WEEKLY_PROPERTY];
  return {
    ...(fresh && Object.keys(shared).length > 0 ? {extendedProperties: {shared}} : {}),
    summary: master.summary,
    description: master.description,
    location: master.location,
    attendees: master.attendees,
    transparency: master.transparency,
    visibility: master.visibility,
    reminders: master.reminders,
    colorId: master.colorId,
    start: {dateTime: `${date}T${slot.start}:00`, timeZone: OFFICE_HOURS_TIME_ZONE},
    end: {dateTime: `${date}T${slot.end}:00`, timeZone: OFFICE_HOURS_TIME_ZONE},
    recurrence: [rrule, ...(master.recurrence || []).filter((line) => !line.startsWith("RRULE:"))],
  };
}

type FoundSeries = {calendarId: string; master: calendar_v3.Schema$Event; series: WeeklySeries};

async function listWeeklySeries(calendar: calendar_v3.Calendar, calendarIds: string[], email: string) {
  const found: FoundSeries[] = [];
  for (const calendarId of calendarIds) {
    let pageToken: string | undefined;
    do {
      const response = await calendar.events.list({
        calendarId, singleEvents: false, showDeleted: false, maxResults: 2500, pageToken,
      });
      for (const event of response.data.items || []) {
        const series = parseWeeklySeries(event, new Set());
        if (series && series.emails.includes(email)) found.push({calendarId, master: event, series});
      }
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
  }
  return found;
}

// The series with `slot` on `day` that's in effect on `date` (or starts after it).
function findSlotSeries(all: FoundSeries[], day: DayKey, slot: {start: string; end: string}, date: string) {
  return all.find(({series}) =>
    !series.stopped && series.days.includes(day) &&
    series.slot.start === slot.start && series.slot.end === slot.end &&
    !(series.until && series.until < date)
  ) || null;
}

// An ended series stops counting toward the weekly pattern when a later series for the same
// weekday replaces it (what a "this and following" edit produces). If a removal deletes or
// ends that later series, the older one would count again and bring back hours that were
// changed long ago. Mark those stopped so the removal sticks (marker only; no emails).
function isReplaced(series: WeeklySeries, all: FoundSeries[]) {
  return !!series.until && all.some(({series: other}) =>
    other.eventId !== series.eventId && other.days.some((d) => series.days.includes(d)) && other.from > series.until!
  );
}

async function stopResurrectedSeries(
  calendar: calendar_v3.Calendar,
  calendarIds: string[],
  email: string,
  before: FoundSeries[]
) {
  const after = await listWeeklySeries(calendar, calendarIds, email);
  for (const {calendarId, master, series} of after) {
    if (series.stopped || !series.until) continue;
    const previously = before.find((entry) => entry.series.eventId === series.eventId);
    if (!previously || !isReplaced(previously.series, before) || isReplaced(series, after)) continue;
    await calendar.events.patch({
      calendarId, eventId: master.id as string, sendUpdates: "none",
      requestBody: {extendedProperties: {
        ...master.extendedProperties,
        shared: {...master.extendedProperties?.shared, [STOPPED_WEEKLY_PROPERTY]: "true"},
      }},
    });
  }
}

export async function applyPermanentChange(options: {
  calendar: calendar_v3.Calendar;
  calendarIds: string[];
  writeCalendarId: string; // where a BESA's first weekly series goes when they have none yet
  request: PermanentChangeRequest;
}) {
  const {calendar, calendarIds, writeCalendarId, request} = options;
  const action = request.action || "change";
  const day = dayKeyOf(request.date);
  const email = request.email.trim().toLowerCase();
  const all = await listWeeklySeries(calendar, calendarIds, email);
  const title = `${request.name}'s Availability`;

  if (action === "removeAll") {
    // End every series still running on or after the date (marked stopped so the sync drops
    // them from the weekly pattern); series that haven't started yet are deleted.
    const active = all.filter(({series}) => !series.stopped && !(series.until && series.until < request.date));
    for (const {calendarId, master, series} of active) {
      if (series.from >= request.date) {
        await calendar.events.delete({calendarId, eventId: master.id as string, sendUpdates: "all"});
        continue;
      }
      const rrule = (master.recurrence || []).find((line) => line.startsWith("RRULE:")) || "RRULE:FREQ=WEEKLY";
      const {COUNT: _count, UNTIL: _until, ...fields} = rruleFields(rrule);
      void _count;
      void _until;
      await calendar.events.patch({
        calendarId, eventId: master.id as string, sendUpdates: "all",
        requestBody: {
          recurrence: [
            buildRrule({...fields, UNTIL: untilEndOf(addDays(request.date, -1))}),
            ...(master.recurrence || []).filter((line) => !line.startsWith("RRULE:")),
          ],
          extendedProperties: {
            ...master.extendedProperties,
            shared: {...master.extendedProperties?.shared, [STOPPED_WEEKLY_PROPERTY]: "true"},
          },
        },
      });
    }
    await stopResurrectedSeries(calendar, calendarIds, email, all);
    return {seriesEnded: active.length};
  }

  if (action === "add") {
    if (!request.to) throw new Error("Add needs the new time slot.");
    // Put it next to their other weekly series so the sync reads it, copy their details, and end
    // it when their current series do (e.g. the end of the quarter).
    const running = all.filter(({series}) => !series.stopped && !(series.until && series.until < request.date));
    const sibling = running[0] || all.find(({series}) => !series.stopped) || all[0];
    // The latest end among their running series (none if any of them runs indefinitely)
    const latest = running.some(({series}) => !series.until) ? undefined :
      running.slice().sort((a, b) => (b.series.until || "").localeCompare(a.series.until || ""))[0];
    const latestRrule = (latest?.master.recurrence || []).find((line) => line.startsWith("RRULE:"));
    const siblingUntil = latestRrule ? rruleFields(latestRrule).UNTIL : undefined;
    const calendarId = sibling?.calendarId || writeCalendarId;
    const template: calendar_v3.Schema$Event = sibling?.master || {
      summary: title,
      attendees: [{email, displayName: request.name}],
    };
    const created = await calendar.events.insert({
      calendarId, sendUpdates: "all",
      requestBody: seriesBody(
        {...template, summary: template.summary || title},
        firstDateOn(request.date, [day]),
        request.to,
        `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY_CODES[day]}${siblingUntil ? `;UNTIL=${siblingUntil}` : ""}`,
        true
      ),
    });
    return {calendarId, createdEventId: created.data.id || ""};
  }

  if (!request.from) throw new Error("Change and remove need the current time slot.");
  if (action === "change" && !request.to) throw new Error("Change needs the new time slot.");
  const found = findSlotSeries(all, day, request.from, request.date);
  if (!found) {
    throw new Error(
      `No "${title}" weekly event on Google Calendar has ` +
      `${request.from.start}-${request.from.end} on ${day} for ${request.email}.`
    );
  }

  const {calendarId, master, series} = found;
  const rrule = (master.recurrence || []).find((line) => line.startsWith("RRULE:")) || "RRULE:FREQ=WEEKLY";
  // COUNT can't be split cleanly; the pieces keep the original UNTIL (if any) instead.
  const {COUNT: _count, UNTIL: originalUntil, BYDAY: _byday, ...baseFields} = rruleFields(rrule);
  void _count;
  void _byday;
  const otherDays = series.days.filter((d) => d !== day);
  const withDays = (days: DayKey[], until?: string) => buildRrule({
    ...baseFields,
    BYDAY: days.map((d) => BYDAY_CODES[d]).join(","),
    ...(until ? {UNTIL: until} : {}),
  });
  const otherRecurrence = (master.recurrence || []).filter((line) => !line.startsWith("RRULE:"));
  const masterId = master.id as string;

  if (series.from < request.date) {
    // End the old series the day before, then continue its other weekdays unchanged.
    await calendar.events.patch({
      calendarId, eventId: masterId, sendUpdates: "all",
      requestBody: {
        recurrence: [withDays(series.days, untilEndOf(addDays(request.date, -1))), ...otherRecurrence],
        ...(action === "remove" ? {extendedProperties: {
          ...master.extendedProperties,
          shared: {...master.extendedProperties?.shared, [STOPPED_WEEKLY_PROPERTY]: "true"},
        }} : {}),
      },
    });
    if (otherDays.length > 0) {
      await calendar.events.insert({
        calendarId, sendUpdates: "all",
        requestBody: seriesBody(master, firstDateOn(request.date, otherDays), series.slot, withDays(otherDays, originalUntil), true),
      });
    }
  } else if (otherDays.length > 0) {
    // Series starts on/after the change date: drop this weekday from it.
    await calendar.events.patch({
      calendarId, eventId: masterId, sendUpdates: "all",
      requestBody: seriesBody(master, firstDateOn(series.from, otherDays), series.slot, withDays(otherDays, originalUntil)),
    });
  } else if (action === "remove") {
    // Only this weekday and it hasn't started yet: nothing to keep.
    await calendar.events.delete({calendarId, eventId: masterId, sendUpdates: "all"});
    await stopResurrectedSeries(calendar, calendarIds, email, all);
    return {calendarId, deletedEventId: masterId};
  } else {
    // Only this weekday and it hasn't started yet: just change its times.
    await calendar.events.patch({
      calendarId, eventId: masterId, sendUpdates: "all",
      requestBody: seriesBody(master, series.from, request.to!, withDays([day], originalUntil)),
    });
    return {calendarId, updatedEventId: masterId};
  }

  if (action === "remove") {
    await stopResurrectedSeries(calendar, calendarIds, email, all);
    return {calendarId, updatedEventId: masterId};
  }

  const created = await calendar.events.insert({
    calendarId, sendUpdates: "all",
    requestBody: seriesBody(master, firstDateOn(request.date, [day]), request.to!, withDays([day], originalUntil), true),
  });
  return {calendarId, updatedEventId: masterId, createdEventId: created.data.id || ""};
}
