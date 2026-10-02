import {createHash, randomBytes, randomUUID} from "crypto";

import * as logger from "firebase-functions/logger";
import {FieldValue} from "firebase-admin/firestore";
import type {DocumentReference, Firestore} from "firebase-admin/firestore";
import type {calendar_v3} from "googleapis";

// Kept here (not imported from siteAdjustments.ts) to avoid a circular import.
const SITE_ADJUSTMENT_PROPERTY = "besaSiteAdjustmentId";

// Derives BESA office hours from the shared BESA Google Calendar and writes them onto the
// Besas docs that the booking site's availability code reads:
//   - Recurring "{Name}'s Availability" series      -> officeHours (weekly pattern; keeps
//     going after the series ends, since tour end dates are what stop bookings)
//   - "{Name}'s Availability (Temporary)" events     -> tempAdjustments for that date
//   - Any other event that isn't a tour              -> tempUnavailability for that window
// Temporary and other events only count for BESAs who are invited AND accepted; the weekly
// series don't need a response. BESAs are matched by attendee email, never by the title.
//
// Every run recomputes everything from the calendar (no incremental diffing), so a
// reschedule or cancellation is handled the same way as a new event, and a missed
// notification is fixed by the next run. Entries written here are tagged
// source: "calendar"; entries added by hand on the admin page are left alone.

export const OFFICE_HOURS_TIME_ZONE = "America/Los_Angeles";
const WINDOW_DAYS = 180;
const SERIES_LOOKBACK_DAYS = 365;
const CALENDAR_SOURCE = "calendar";
const STATE_COLLECTION = "CalendarSyncState";

const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
type DayKey = typeof DAY_KEYS[number];
const RRULE_DAYS: Record<string, DayKey> = {
  SU: "sunday", MO: "monday", TU: "tuesday", WE: "wednesday", TH: "thursday", FR: "friday", SA: "saturday",
};

// "Jasmine's Availability" / "Jasmine's Availability (Temporary)". Tolerates curly
// apostrophes and misspellings like "Availiabilty" or "(Temp)".
const AVAILABILITY_TITLE = /['’]s\s+avail\w*\s*(\(\s*temp\w*\s*\))?\s*$/i;

type Slot = {start: string; end: string}; // HH:mm, Pacific time
type TimeSlot = Slot & {id: string};
type DayHours = {available: boolean; timeSlots: TimeSlot[]};

type CalendarAdjustment = {
  id: string;
  date: string;
  timeSlots: TimeSlot[];
  reason: string;
  source: typeof CALENDAR_SOURCE;
};

type CalendarUnavailability = {
  id: string;
  date: string;
  allDay: boolean;
  start?: string;
  end?: string;
  reason: string;
  source: typeof CALENDAR_SOURCE;
  calendarEventId?: string;
};

// "site" = a temporary change the booking site pushed to the calendar (siteAdjustments.ts);
// it's already a tempAdjustment, so it's ignored here like tours are.
type EventKind = "tour" | "site" | "weekly" | "temporary" | "other";

type ParsedInstance = {
  eventId: string;
  title: string;
  kind: EventKind;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string; // exclusive for all-day events, like Google's end.date
  endTime: string;
  attendees: Array<{email: string; accepted: boolean}>;
};

type WeeklySeries = {
  eventId: string;
  emails: string[];
  days: DayKey[];
  slot: Slot;
  from: string;
  until?: string;
};

export type DerivedSchedule = {
  officeHours: Record<DayKey, DayHours> | null; // null = no weekly series for this BESA
  tempAdjustments: CalendarAdjustment[];
  tempUnavailability: CalendarUnavailability[];
};

// --- Dates and times (all Pacific) ---

const localFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: OFFICE_HOURS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function toLocal(value: string | Date): {date: string; time: string} {
  const parts: Record<string, string> = {};
  for (const part of localFormatter.formatToParts(new Date(value))) {
    parts[part.type] = part.value;
  }
  return {date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`};
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function dayKeyOf(date: string): DayKey {
  const [y, m, d] = date.split("-").map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// RRULE UNTIL is either a date (20261205) or a UTC timestamp (20261206T075959Z).
function untilToLocalDate(until: string): string {
  const match = until.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!match) return "";
  const [, y, m, d, hh, mm, ss] = match;
  if (!hh) return `${y}-${m}-${d}`;
  return toLocal(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`).date;
}

// --- Parsing calendar events ---

function normalizeTitle(title: string) {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function classifyEvent(event: calendar_v3.Schema$Event, tourTitles: Set<string>): EventKind {
  // Events the booking sync created carry the booking id.
  if (event.extendedProperties?.private?.bookingId) return "tour";
  if (
    event.extendedProperties?.shared?.[SITE_ADJUSTMENT_PROPERTY] ||
    event.extendedProperties?.private?.[SITE_ADJUSTMENT_PROPERTY]
  ) return "site";
  const title = event.summary || "";
  if (tourTitles.has(normalizeTitle(title))) return "tour";
  const match = title.trim().match(AVAILABILITY_TITLE);
  if (!match) return "other";
  return match[1] ? "temporary" : "weekly";
}

function parseAttendees(event: calendar_v3.Schema$Event) {
  return (event.attendees || []).flatMap((attendee) =>
    attendee.email ?
      [{email: attendee.email.toLowerCase(), accepted: attendee.responseStatus === "accepted"}] :
      []
  );
}

function parseInstance(event: calendar_v3.Schema$Event, tourTitles: Set<string>): ParsedInstance | null {
  if (!event.id || event.status === "cancelled") return null;
  const base = {
    eventId: event.recurringEventId || event.id,
    title: (event.summary || "").trim(),
    kind: classifyEvent(event, tourTitles),
    attendees: parseAttendees(event),
  };
  if (event.start?.date && event.end?.date) {
    return {
      ...base, allDay: true,
      startDate: event.start.date, startTime: "00:00", endDate: event.end.date, endTime: "00:00",
    };
  }
  if (!event.start?.dateTime || !event.end?.dateTime) return null;
  const start = toLocal(event.start.dateTime);
  const end = toLocal(event.end.dateTime);
  return {
    ...base, allDay: false,
    startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time,
  };
}

function parseWeeklySeries(event: calendar_v3.Schema$Event, tourTitles: Set<string>): WeeklySeries | null {
  if (!event.id || !event.recurrence || event.status === "cancelled") return null;
  if (classifyEvent(event, tourTitles) !== "weekly") return null;
  if (!event.start?.dateTime || !event.end?.dateTime) return null;

  const rrule = event.recurrence.find((line) => line.startsWith("RRULE:"));
  if (!rrule) return null;
  const fields = Object.fromEntries(
    rrule.slice("RRULE:".length).split(";").map((pair) => pair.split("=") as [string, string])
  );
  if (fields.FREQ !== "WEEKLY") return null;

  const start = toLocal(event.start.dateTime);
  const end = toLocal(event.end.dateTime);
  if (start.date !== end.date || start.time >= end.time) return null;

  const days = fields.BYDAY ?
    fields.BYDAY.split(",").flatMap((code) => RRULE_DAYS[code.slice(-2)] ? [RRULE_DAYS[code.slice(-2)]] : []) :
    [dayKeyOf(start.date)];
  const until = fields.UNTIL ? untilToLocalDate(fields.UNTIL) : "";

  return {
    eventId: event.id,
    emails: parseAttendees(event).map((attendee) => attendee.email),
    days,
    slot: {start: start.time, end: end.time},
    from: start.date,
    ...(until ? {until} : {}),
  };
}

// --- Deriving one BESA's schedule ---

function stableId(...parts: string[]) {
  return "cal_" + createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function sortSlots(slots: Slot[]): Slot[] {
  const unique = new Map(slots.map((slot) => [`${slot.start}-${slot.end}`, slot]));
  return [...unique.values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

function slotsKey(slots: Slot[]) {
  return sortSlots(slots).map((slot) => `${slot.start}-${slot.end}`).join(",");
}

function withSlotIds(slots: Slot[]): TimeSlot[] {
  return sortSlots(slots).map((slot, index) => ({id: String(index), ...slot}));
}

// The series that define a weekday's pattern. A series is superseded when another one for
// the same weekday starts after it ends, which is what a "this and following events" edit
// produces. The rest count even if they start later or have already ended (the pattern
// keeps going past a series' end; tour end dates are what stop bookings).
function seriesForPattern(series: WeeklySeries[], day: DayKey): WeeklySeries[] {
  const forDay = series.filter((s) => s.days.includes(day));
  return forDay.filter((s) => !forDay.some((t) => s.until && t.from > s.until));
}

// Dates up to the last series end for that weekday follow the actual occurrences. That
// includes dates before a newer series starts, where the old series' occurrences apply.
function isCoveredBySeries(series: WeeklySeries[], date: string) {
  const day = dayKeyOf(date);
  return series.some((s) => s.days.includes(day) && (!s.until || date <= s.until));
}

// Splits a timed or all-day event into one entry per Pacific date.
function unavailabilityEntries(instance: ParsedInstance, today: string, windowEnd: string): CalendarUnavailability[] {
  const entries: CalendarUnavailability[] = [];
  const lastDate = instance.allDay ? addDays(instance.endDate, -1) : instance.endDate;
  for (let date = instance.startDate; date <= lastDate; date = addDays(date, 1)) {
    if (date < today || date > windowEnd) continue;
    const base = {date, reason: instance.title || "Calendar event", source: CALENDAR_SOURCE, calendarEventId: instance.eventId} as const;
    if (instance.allDay) {
      entries.push({...base, id: stableId("out", instance.eventId, date, "allDay"), allDay: true});
      continue;
    }
    const start = date === instance.startDate ? instance.startTime : "00:00";
    const end = date === instance.endDate ? instance.endTime : "23:59";
    if (start >= end) continue;
    entries.push({...base, id: stableId("out", instance.eventId, date, start, end), allDay: false, start, end});
  }
  return entries;
}

export function deriveBesaSchedule(
  email: string,
  allSeries: WeeklySeries[],
  allInstances: ParsedInstance[],
  today: string,
  windowEnd: string
): DerivedSchedule {
  const series = allSeries.filter((s) => s.emails.includes(email));
  const invitedTo = allInstances.filter(
    (instance) => instance.kind !== "tour" && instance.kind !== "site" && instance.attendees.some((attendee) => attendee.email === email)
  );
  const acceptedBy = (instance: ParsedInstance) =>
    instance.attendees.some((attendee) => attendee.email === email && attendee.accepted);

  const pattern = Object.fromEntries(
    DAY_KEYS.map((day) => [day, sortSlots(seriesForPattern(series, day).map((s) => s.slot))])
  ) as Record<DayKey, Slot[]>;

  const tempAdjustments: CalendarAdjustment[] = [];
  const tempUnavailability: CalendarUnavailability[] = [];

  for (let date = today; date <= windowEnd; date = addDays(date, 1)) {
    const timedOnDate = (kind: EventKind) =>
      invitedTo.filter((i) => i.kind === kind && !i.allDay && i.startDate === date && i.endDate === date);

    const temporary = timedOnDate("temporary").filter(acceptedBy);
    if (temporary.length > 0) {
      const timeSlots = withSlotIds(temporary.map((i) => ({start: i.startTime, end: i.endTime})));
      tempAdjustments.push({
        id: stableId("adj", email, date, slotsKey(timeSlots)),
        date,
        timeSlots,
        reason: [...new Set(temporary.map((i) => i.title))].join(", "),
        source: CALENDAR_SOURCE,
      });
      continue;
    }

    // Where the weekly series runs (or a single occurrence was moved onto this date), the
    // actual occurrences are the truth. If someone moved, shortened, or deleted just one
    // occurrence, that date gets its own entry instead of changing the weekly pattern.
    const weekly = timedOnDate("weekly");
    if (!isCoveredBySeries(series, date) && weekly.length === 0) continue;
    const actual = weekly.map((i) => ({start: i.startTime, end: i.endTime}));
    if (slotsKey(actual) === slotsKey(pattern[dayKeyOf(date)])) continue;
    if (actual.length > 0) {
      const timeSlots = withSlotIds(actual);
      tempAdjustments.push({
        id: stableId("adj", email, date, slotsKey(timeSlots)),
        date,
        timeSlots,
        reason: "Office hours changed for this date on the calendar",
        source: CALENDAR_SOURCE,
      });
    } else {
      tempUnavailability.push({
        id: stableId("out", email, date, "noHours"),
        date,
        allDay: true,
        reason: "Office hours removed for this date on the calendar",
        source: CALENDAR_SOURCE,
      });
    }
  }

  for (const instance of invitedTo) {
    if (instance.kind === "other" && acceptedBy(instance)) {
      tempUnavailability.push(...unavailabilityEntries(instance, today, windowEnd));
    }
  }

  const officeHours = series.length === 0 ? null : (Object.fromEntries(
    DAY_KEYS.map((day) => [day, {available: pattern[day].length > 0, timeSlots: withSlotIds(pattern[day])}])
  ) as Record<DayKey, DayHours>);

  return {officeHours, tempAdjustments, tempUnavailability};
}

// --- Writing to Firestore ---

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Keeps hand-added entries and past calendar entries (the admin page's log), and replaces
// today-and-later calendar entries with the freshly derived ones.
function mergeTempEntries(
  existing: unknown,
  derived: Array<{id: string; date: string}>,
  today: string,
  now: string
): Array<Record<string, unknown>> {
  const current = (Array.isArray(existing) ? existing : []).filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object"
  );
  const isReplaced = (entry: Record<string, unknown>) =>
    entry.source === CALENDAR_SOURCE && typeof entry.date === "string" && entry.date >= today;
  const createdAtById = new Map(
    current.filter(isReplaced).map((entry) => [entry.id, entry.createdAt])
  );
  return [
    ...current.filter((entry) => !isReplaced(entry)),
    ...derived.map((entry) => ({...entry, createdAt: createdAtById.get(entry.id) || now})),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

async function applyScheduleToBesa(
  db: Firestore,
  ref: DocumentReference,
  derived: DerivedSchedule,
  today: string,
  now: string
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const data = snapshot.data() || {};
    const updates: Record<string, unknown> = {};

    const tempAdjustments = mergeTempEntries(data.tempAdjustments, derived.tempAdjustments, today, now);
    if (stableStringify(tempAdjustments) !== stableStringify(data.tempAdjustments || [])) {
      updates.tempAdjustments = tempAdjustments;
    }
    // `adjustments` was the field name before tempUnavailability existed.
    const existingUnavailability = data.tempUnavailability ?? data.adjustments;
    const tempUnavailability = mergeTempEntries(existingUnavailability, derived.tempUnavailability, today, now);
    if (stableStringify(tempUnavailability) !== stableStringify(existingUnavailability || [])) {
      updates.tempUnavailability = tempUnavailability;
    }

    if (derived.officeHours) {
      if (stableStringify(derived.officeHours) !== stableStringify(data.officeHours || {})) {
        updates.officeHours = derived.officeHours;
      }
      if (data.officeHoursSource !== CALENDAR_SOURCE) updates.officeHoursSource = CALENDAR_SOURCE;
    } else if (data.officeHoursSource === CALENDAR_SOURCE) {
      // Every weekly series for this BESA was deleted from the calendar.
      updates.officeHours = Object.fromEntries(DAY_KEYS.map((day) => [day, {available: false, timeSlots: []}]));
      updates.officeHoursSource = FieldValue.delete();
    }

    if (Object.keys(updates).length === 0) return false;
    tx.update(ref, updates);
    return true;
  });
}

// --- Reading the calendar ---

async function listAllEvents(
  calendar: calendar_v3.Calendar,
  params: calendar_v3.Params$Resource$Events$List
): Promise<calendar_v3.Schema$Event[]> {
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const response = await calendar.events.list({...params, maxResults: 2500, pageToken});
    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return events;
}

// The same event can be on several watched calendars (e.g. the BESA calendar and the
// account's primary calendar, where invites land).
function dedupeEvents(events: calendar_v3.Schema$Event[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.iCalUID || event.id}|${event.originalStartTime?.dateTime || event.originalStartTime?.date || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function syncOfficeHoursFromCalendar(options: {
  db: Firestore;
  calendar: calendar_v3.Calendar;
  calendarIds: string[];
  now?: Date;
}) {
  const {db, calendar, calendarIds} = options;
  const now = options.now || new Date();
  const today = toLocal(now).date;
  const windowEnd = addDays(today, WINDOW_DAYS);
  const dayMs = 24 * 60 * 60 * 1000;

  const [besasSnapshot, toursSnapshot] = await Promise.all([
    db.collection("Besas").get(),
    db.collection("Tours").get(),
  ]);
  const tourTitles = new Set(
    toursSnapshot.docs.flatMap((doc) => {
      const title = doc.get("title");
      return typeof title === "string" && title.trim() ? [normalizeTitle(title)] : [];
    })
  );

  const masterEvents: calendar_v3.Schema$Event[] = [];
  const instanceEvents: calendar_v3.Schema$Event[] = [];
  for (const calendarId of calendarIds) {
    const [masters, instances] = await Promise.all([
      listAllEvents(calendar, {
        calendarId,
        singleEvents: false,
        showDeleted: false,
        timeMin: new Date(now.getTime() - SERIES_LOOKBACK_DAYS * dayMs).toISOString(),
      }),
      listAllEvents(calendar, {
        calendarId,
        singleEvents: true,
        showDeleted: false,
        timeMin: new Date(now.getTime() - dayMs).toISOString(),
        timeMax: new Date(now.getTime() + (WINDOW_DAYS + 2) * dayMs).toISOString(),
      }),
    ]);
    masterEvents.push(...masters);
    instanceEvents.push(...instances);
  }

  const series = dedupeEvents(masterEvents).flatMap((event) => {
    const parsed = parseWeeklySeries(event, tourTitles);
    return parsed ? [parsed] : [];
  });
  const instances = dedupeEvents(instanceEvents).flatMap((event) => {
    const parsed = parseInstance(event, tourTitles);
    return parsed ? [parsed] : [];
  });

  const nowIso = now.toISOString();
  let updatedBesas = 0;
  for (const doc of besasSnapshot.docs) {
    const email = doc.get("email");
    if (typeof email !== "string" || !email.trim()) continue;
    const derived = deriveBesaSchedule(email.trim().toLowerCase(), series, instances, today, windowEnd);
    if (await applyScheduleToBesa(db, doc.ref, derived, today, nowIso)) updatedBesas += 1;
  }

  logger.info("Office hours synced from Google Calendar", {
    calendarIds,
    weeklySeries: series.length,
    instances: instances.length,
    updatedBesas,
  });
  return {weeklySeries: series.length, instances: instances.length, updatedBesas};
}

// --- Push notification channels ---

const WATCH_TTL_SECONDS = 7 * 24 * 60 * 60;
const RENEW_WITHIN_MS = 36 * 60 * 60 * 1000;

function watchDocId(calendarId: string) {
  return "officeHoursWatch_" + createHash("sha1").update(calendarId).digest("hex").slice(0, 20);
}

async function stopChannel(calendar: calendar_v3.Calendar, channelId: unknown, resourceId: unknown) {
  if (typeof channelId !== "string" || typeof resourceId !== "string") return;
  try {
    await calendar.channels.stop({requestBody: {id: channelId, resourceId}});
  } catch (error) {
    logger.warn("Could not stop old calendar watch channel", {channelId, error});
  }
}

// Google push channels expire, so this runs on a schedule: it opens a channel for each
// watched calendar that has none (or one expiring soon) and closes channels for calendars
// that are no longer watched.
export async function ensureOfficeHoursWatches(options: {
  db: Firestore;
  calendar: calendar_v3.Calendar;
  calendarIds: string[];
  webhookUrl: string;
  now?: Date;
}) {
  const {db, calendar, calendarIds, webhookUrl} = options;
  const now = (options.now || new Date()).getTime();
  const collection = db.collection(STATE_COLLECTION);

  for (const calendarId of calendarIds) {
    const ref = collection.doc(watchDocId(calendarId));
    const existing = (await ref.get()).data();
    if (existing && existing.address === webhookUrl && Number(existing.expiration) - now > RENEW_WITHIN_MS) {
      continue;
    }

    const channelId = randomUUID();
    const token = randomBytes(24).toString("hex");
    const response = await calendar.events.watch({
      calendarId,
      requestBody: {
        id: channelId,
        type: "web_hook",
        address: webhookUrl,
        token,
        params: {ttl: String(WATCH_TTL_SECONDS)},
      },
    });
    await ref.set({
      kind: "officeHoursWatch",
      calendarId,
      channelId,
      resourceId: response.data.resourceId || "",
      token,
      address: webhookUrl,
      expiration: Number(response.data.expiration) || now + WATCH_TTL_SECONDS * 1000,
    });
    if (existing) await stopChannel(calendar, existing.channelId, existing.resourceId);
    logger.info("Opened calendar watch channel for office hours", {calendarId, channelId});
  }

  const stale = await collection.where("kind", "==", "officeHoursWatch").get();
  for (const doc of stale.docs) {
    if (calendarIds.includes(doc.get("calendarId"))) continue;
    await stopChannel(calendar, doc.get("channelId"), doc.get("resourceId"));
    await doc.ref.delete();
  }
}

export async function isKnownOfficeHoursChannel(db: Firestore, channelId: string, token: string) {
  if (!channelId || !token) return false;
  const matches = await db.collection(STATE_COLLECTION)
    .where("kind", "==", "officeHoursWatch")
    .where("channelId", "==", channelId)
    .limit(1)
    .get();
  return !matches.empty && matches.docs[0].get("token") === token;
}
