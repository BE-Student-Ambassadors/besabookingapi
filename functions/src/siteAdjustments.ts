import {createHash} from "crypto";

import * as logger from "firebase-functions/logger";
import type {Firestore} from "firebase-admin/firestore";
import type {calendar_v3} from "googleapis";

import {OFFICE_HOURS_TIME_ZONE, toLocal} from "./officeHours";

// Pushes one-day office-hour changes made on the booking site (tempAdjustments without
// source: "calendar") to Google Calendar, the reverse of officeHours.ts.
//
// An adjustment is the BESA's full hours for that date. `temporarySlots` says which of them
// are temporary; the rest are their usual events that day, left as they are. The push edits
// that day's existing availability events rather than adding new ones: a replaced event gets
// the temporary time and is renamed "... (Temporary)", replaced events that aren't needed are
// deleted, and a new event is only created when there's nothing left to edit. What it changed
// is recorded (CalendarSyncState) so removing the adjustment restores those events exactly.
//
// Events it edits or creates carry SITE_ADJUSTMENT_PROPERTY so the calendar -> Firestore sync
// doesn't import them as a second adjustment. Edits made to that day in Google Calendar are
// pulled back by pullSiteAdjustmentEdits (run with every calendar sync).

// Must match SITE_ADJUSTMENT_PROPERTY in officeHours.ts.
const SITE_ADJUSTMENT_PROPERTY = "besaSiteAdjustmentId";
const STATE_COLLECTION = "CalendarSyncState";
const STATE_KIND = "siteAdjustmentEvents";
const HHMM = /^\d{2}:\d{2}$/;
const AVAILABILITY_TITLE = /['’]s\s+avail\w*/i;
const TEMPORARY_SUFFIX = /\s*\(\s*temp\w*\s*\)\s*$/i;

type Slot = {start: string; end: string};

type SiteAdjustment = {
  id: string;
  date: string;
  timeSlots: Slot[];
  temporarySlots: Slot[];
  reason: string;
};

type EventRecord = {
  eventId: string;
  created: boolean; // made by this sync; deleted on revert
  // For an existing event this sync edited or deleted: how it was, to restore on revert
  original?: {
    summary: string;
    description?: string;
    start: calendar_v3.Schema$EventDateTime;
    end: calendar_v3.Schema$EventDateTime;
    attendees?: calendar_v3.Schema$EventAttendee[];
    recurring: boolean;
    shared?: Record<string, string>;
  };
};

type SyncedState = {
  kind: typeof STATE_KIND;
  besaId: string;
  adjustmentId: string;
  date: string;
  calendarId: string;
  hash: string;
  records?: EventRecord[];
  temporaryCount?: number;
  eventCount?: number; // legacy: states written before records existed
};

type Besa = {id: string; name: string; email: string};

type DayEvent = {event: calendar_v3.Schema$Event; id: string; date: string; slot: Slot; tag: string};

const slotKey = (slot: Slot) => `${slot.start}-${slot.end}`;

function todayInPacific(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OFFICE_HOURS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

// Google event ids allow a-v and 0-9; hex is a subset.
function eventIdFor(besaId: string, adjustmentId: string, index: number) {
  return "besaadj" + createHash("sha1").update(`${besaId}|${adjustmentId}|${index}`).digest("hex");
}

function stateDocId(besaId: string, adjustmentId: string) {
  return "siteAdjustment_" + createHash("sha1").update(`${besaId}|${adjustmentId}`).digest("hex").slice(0, 24);
}

function readSlots(raw: unknown): Slot[] {
  return (Array.isArray(raw) ? raw : []).flatMap((slot: unknown) => {
    const s = (slot || {}) as Record<string, unknown>;
    return typeof s.start === "string" && typeof s.end === "string" && HHMM.test(s.start) && HHMM.test(s.end) &&
      s.start < s.end ? [{start: s.start, end: s.end}] : [];
  }).sort((a, b) => a.start.localeCompare(b.start));
}

function readSiteAdjustments(raw: unknown): SiteAdjustment[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const entry = (value || {}) as Record<string, unknown>;
    if (entry.source === "calendar") return [];
    if (typeof entry.id !== "string" || typeof entry.date !== "string" || !Array.isArray(entry.timeSlots)) return [];
    const timeSlots = readSlots(entry.timeSlots);
    const keys = new Set(timeSlots.map(slotKey));
    const temporarySlots = Array.isArray(entry.temporarySlots) ?
      readSlots(entry.temporarySlots).filter((slot) => keys.has(slotKey(slot))) :
      timeSlots;
    return [{
      id: entry.id,
      date: entry.date,
      timeSlots,
      temporarySlots,
      reason: typeof entry.reason === "string" ? entry.reason.trim() : "",
    }];
  });
}

// What was last pushed for an adjustment; unchanged means no calendar calls are needed.
function adjustmentHash(besa: {name: string; email: string}, adjustment: Omit<SiteAdjustment, "id">) {
  return createHash("sha1")
    .update(JSON.stringify([
      besa.name, besa.email, adjustment.date, adjustment.timeSlots, adjustment.temporarySlots, adjustment.reason,
    ]))
    .digest("hex");
}

function errorCode(error: unknown) {
  return (error as {code?: number}).code;
}

const isGone = (error: unknown) => errorCode(error) === 404 || errorCode(error) === 410;

function eventTag(event: calendar_v3.Schema$Event) {
  return event.extendedProperties?.shared?.[SITE_ADJUSTMENT_PROPERTY] ||
    event.extendedProperties?.private?.[SITE_ADJUSTMENT_PROPERTY] || "";
}

function toDayEvent(event: calendar_v3.Schema$Event): DayEvent | null {
  if (!event.id || event.status === "cancelled" || !event.start?.dateTime || !event.end?.dateTime) return null;
  const start = toLocal(event.start.dateTime);
  const end = toLocal(event.end.dateTime);
  if (start.date !== end.date || start.time >= end.time) return null;
  return {event, id: event.id, date: start.date, slot: {start: start.time, end: end.time}, tag: eventTag(event)};
}

async function listEvents(calendar: calendar_v3.Calendar, calendarId: string, timeMin: Date, timeMax: Date) {
  const events: DayEvent[] = [];
  let pageToken: string | undefined;
  do {
    const response = await calendar.events.list({
      calendarId, singleEvents: true, showDeleted: false, maxResults: 2500, pageToken,
      timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
    });
    for (const event of response.data.items || []) {
      const parsed = toDayEvent(event);
      if (parsed) events.push(parsed);
    }
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return events;
}

// A BESA's own availability events (not ones this sync tagged): invited, titled "...'s Availability"
function isTheirs(dayEvent: DayEvent, email: string) {
  return !dayEvent.tag && AVAILABILITY_TITLE.test(dayEvent.event.summary || "") &&
    (dayEvent.event.attendees || []).some((attendee) => attendee.email?.toLowerCase() === email);
}

function slotDateTime(date: string, time: string): calendar_v3.Schema$EventDateTime {
  return {dateTime: `${date}T${time}:00`, timeZone: OFFICE_HOURS_TIME_ZONE};
}

function temporaryTitle(summary: string) {
  return `${summary.replace(TEMPORARY_SUFFIX, "").trim()} (Temporary)`;
}

function recordsOf(state: SyncedState | undefined): EventRecord[] {
  if (!state) return [];
  if (state.records) return state.records;
  // Before records existed, every pushed slot was its own created event
  return Array.from({length: state.eventCount || 0}, (_, index) => ({
    eventId: eventIdFor(state.besaId, state.adjustmentId, index), created: true,
  }));
}

async function deleteEvent(calendar: calendar_v3.Calendar, calendarId: string, eventId: string) {
  try {
    await calendar.events.delete({calendarId, eventId, sendUpdates: "all"});
  } catch (error) {
    if (!isGone(error)) throw error;
  }
}

// Put an event this sync edited or deleted back the way it was.
async function restoreEvent(calendar: calendar_v3.Calendar, calendarId: string, record: EventRecord) {
  const original = record.original;
  if (!original) return;
  const body: calendar_v3.Schema$Event = {
    summary: original.summary,
    start: original.start,
    end: original.end,
    status: "confirmed",
    extendedProperties: {shared: {...original.shared, [SITE_ADJUSTMENT_PROPERTY]: ""}},
  };
  try {
    await calendar.events.patch({calendarId, eventId: record.eventId, sendUpdates: "all", requestBody: body});
  } catch (error) {
    if (!isGone(error)) throw error;
    // A one-off event that was deleted for good: put a copy back. (An occurrence that's gone
    // means its series no longer covers that date, so there's nothing to restore.)
    if (!original.recurring) {
      await calendar.events.insert({
        calendarId, sendUpdates: "all",
        requestBody: {...body, description: original.description, attendees: original.attendees},
      });
    }
  }
}

async function revertAll(calendar: calendar_v3.Calendar, calendarId: string, records: EventRecord[]) {
  for (const record of records) {
    if (record.created) await deleteEvent(calendar, calendarId, record.eventId);
    else await restoreEvent(calendar, calendarId, record);
  }
}

function originalOf(dayEvent: DayEvent): EventRecord["original"] {
  const event = dayEvent.event;
  return {
    summary: event.summary || "",
    ...(event.description ? {description: event.description} : {}),
    start: {dateTime: event.start?.dateTime, timeZone: event.start?.timeZone || OFFICE_HOURS_TIME_ZONE},
    end: {dateTime: event.end?.dateTime, timeZone: event.end?.timeZone || OFFICE_HOURS_TIME_ZONE},
    ...(event.attendees ? {attendees: event.attendees} : {}),
    recurring: !!event.recurringEventId,
    ...(event.extendedProperties?.shared ? {shared: event.extendedProperties.shared} : {}),
  };
}

// Makes the calendar match one adjustment for that date. Returns the updated records.
async function pushAdjustment(
  calendar: calendar_v3.Calendar,
  calendarId: string,
  besa: Besa,
  adjustment: SiteAdjustment,
  previous: EventRecord[]
): Promise<{records: EventRecord[]; temporaryCount: number}> {
  const dayStart = new Date(`${adjustment.date}T00:00:00Z`);
  const dayEvents = (await listEvents(
    calendar, calendarId, new Date(dayStart.getTime() - 14 * 3600e3), new Date(dayStart.getTime() + 38 * 3600e3)
  )).filter((dayEvent) => dayEvent.date === adjustment.date);
  const ours = dayEvents.filter((dayEvent) => dayEvent.tag === adjustment.id);
  const theirs = dayEvents.filter((dayEvent) => isTheirs(dayEvent, besa.email));

  const records = new Map(previous.map((record) => [record.eventId, record]));
  const used = new Set<string>();
  const temporary = [...adjustment.temporarySlots];
  const temporaryKeys = new Set(temporary.map(slotKey));

  // Usual events the BESA keeps that day: leave them, or restore one this sync took away
  for (const slot of adjustment.timeSlots.filter((entry) => !temporaryKeys.has(slotKey(entry)))) {
    const existing = theirs.find((dayEvent) => !used.has(dayEvent.id) && slotKey(dayEvent.slot) === slotKey(slot));
    if (existing) {
      used.add(existing.id);
      continue;
    }
    const restorable = [...records.values()].find((record) =>
      !record.created && record.original?.start.dateTime && !used.has(record.eventId) &&
      slotKey({start: toLocal(record.original.start.dateTime).time, end: toLocal(record.original.end.dateTime!).time}) === slotKey(slot)
    );
    if (restorable) {
      await restoreEvent(calendar, calendarId, restorable);
      records.delete(restorable.eventId);
      used.add(restorable.eventId);
      continue;
    }
    temporary.push(slot); // nothing to keep, so it needs its own event
  }

  // Temporary slots: reuse this sync's events first, then edit the BESA's replaced events
  const baseTitle = (theirs[0] || ours[0])?.event.summary?.replace(TEMPORARY_SUFFIX, "").trim() ||
    [...records.values()].find((record) => record.original)?.original?.summary.replace(TEMPORARY_SUFFIX, "").trim() ||
    `${besa.name || "BESA"}'s Availability`;
  const pool = [...ours, ...theirs].filter((dayEvent) => !used.has(dayEvent.id));
  let createdIndex = previous.filter((record) => record.created).length;
  for (const slot of temporary) {
    const available = pool.filter((dayEvent) => !used.has(dayEvent.id));
    const candidate = available.find((dayEvent) => dayEvent.tag && slotKey(dayEvent.slot) === slotKey(slot)) ||
      available.find((dayEvent) => slotKey(dayEvent.slot) === slotKey(slot)) ||
      available[0];
    const tag = {[SITE_ADJUSTMENT_PROPERTY]: adjustment.id, besaId: besa.id};

    if (candidate) {
      used.add(candidate.id);
      if (!candidate.tag && !records.has(candidate.id)) {
        records.set(candidate.id, {eventId: candidate.id, created: false, original: originalOf(candidate)});
      }
      const title = temporaryTitle(candidate.event.summary || baseTitle);
      // Already exactly right: don't patch (each patch emails the BESA)
      if (candidate.tag === adjustment.id && slotKey(candidate.slot) === slotKey(slot) && candidate.event.summary === title) continue;
      await calendar.events.patch({
        calendarId, eventId: candidate.id, sendUpdates: "all",
        requestBody: {
          summary: title,
          start: slotDateTime(adjustment.date, slot.start),
          end: slotDateTime(adjustment.date, slot.end),
          extendedProperties: {shared: {...candidate.event.extendedProperties?.shared, ...tag}},
        },
      });
      continue;
    }

    // Nothing to edit: create one (fixed id, so a retry can't make two)
    const eventId = eventIdFor(besa.id, adjustment.id, createdIndex);
    createdIndex += 1;
    const body: calendar_v3.Schema$Event = {
      summary: temporaryTitle(baseTitle),
      description: [
        adjustment.reason,
        "Temporary office hours set on the BESA booking site (Office Hours page).",
      ].filter(Boolean).join("\n\n"),
      start: slotDateTime(adjustment.date, slot.start),
      end: slotDateTime(adjustment.date, slot.end),
      attendees: besa.email ? [{email: besa.email, displayName: besa.name, responseStatus: "accepted"}] : [],
      status: "confirmed",
      extendedProperties: {shared: tag},
    };
    try {
      await calendar.events.insert({calendarId, sendUpdates: "all", requestBody: {...body, id: eventId}});
    } catch (error) {
      if (errorCode(error) !== 409) throw error;
      await calendar.events.patch({calendarId, eventId, sendUpdates: "all", requestBody: body});
    }
    records.set(eventId, {eventId, created: true});
  }

  // Whatever's left on that day isn't part of the BESA's hours anymore: delete it
  for (const dayEvent of [...ours, ...theirs]) {
    if (used.has(dayEvent.id)) continue;
    const record = records.get(dayEvent.id);
    if (record?.created) {
      await deleteEvent(calendar, calendarId, dayEvent.id);
      records.delete(dayEvent.id);
      continue;
    }
    if (!record) records.set(dayEvent.id, {eventId: dayEvent.id, created: false, original: originalOf(dayEvent)});
    await deleteEvent(calendar, calendarId, dayEvent.id);
  }

  return {records: [...records.values()], temporaryCount: temporary.length};
}

export async function syncSiteAdjustmentsToCalendar(options: {
  db: Firestore;
  calendar: calendar_v3.Calendar;
  calendarId: string;
  besaId: string;
  besaData: Record<string, unknown> | undefined; // undefined when the Besas doc was deleted
  now?: Date;
}) {
  const {db, calendar, calendarId, besaId, besaData} = options;
  const today = todayInPacific(options.now);
  const besa: Besa = {
    id: besaId,
    name: typeof besaData?.name === "string" ? besaData.name.trim() : "",
    email: typeof besaData?.email === "string" ? besaData.email.trim().toLowerCase() : "",
  };
  const adjustments = readSiteAdjustments(besaData?.tempAdjustments);
  const byId = new Map(adjustments.map((adjustment) => [adjustment.id, adjustment]));

  const stateSnapshot = await db.collection(STATE_COLLECTION)
    .where("kind", "==", STATE_KIND)
    .where("besaId", "==", besaId)
    .get();
  const stateById = new Map(stateSnapshot.docs.map((doc) => [doc.get("adjustmentId") as string, doc]));

  let pushed = 0;
  let reverted = 0;

  // Today and later: make the calendar match. Past adjustments are left as they were.
  for (const adjustment of adjustments) {
    if (adjustment.date < today) continue;
    const hash = adjustmentHash(besa, adjustment);
    let state = stateById.get(adjustment.id)?.data() as SyncedState | undefined;
    if (state && state.hash === hash && state.calendarId === calendarId) continue;

    // Different calendar or date than last time: undo that first, then start fresh
    if (state && (state.calendarId !== calendarId || state.date !== adjustment.date)) {
      await revertAll(calendar, state.calendarId, recordsOf(state));
      state = undefined;
    }

    const {records, temporaryCount} = await pushAdjustment(calendar, calendarId, besa, adjustment, recordsOf(state));
    const next: SyncedState = {
      kind: STATE_KIND, besaId, adjustmentId: adjustment.id, date: adjustment.date, calendarId, hash, records, temporaryCount,
    };
    await db.collection(STATE_COLLECTION).doc(stateDocId(besaId, adjustment.id)).set(next);
    pushed += 1;
  }

  // Adjustments removed on the site: restore that day unless it has already passed.
  for (const [adjustmentId, doc] of stateById) {
    if (byId.has(adjustmentId)) continue;
    const state = doc.data() as SyncedState;
    if (state.date >= today) {
      await revertAll(calendar, state.calendarId, recordsOf(state));
      reverted += 1;
    }
    await doc.ref.delete();
  }

  if (pushed || reverted) {
    logger.info("Synced site office-hour changes to Google Calendar", {besaId, calendarId, pushed, reverted});
  }
  return {pushed, reverted};
}

// Pulls edits made in Google Calendar on dates the site manages back into the site's
// tempAdjustments: the date's hours become the BESA's availability events that day (their
// own plus this sync's), and the sync's events are the temporary ones. If every temporary
// event was deleted in Google Calendar, the adjustment is removed. The pushed-state hash is
// updated first, so the write below doesn't make syncSiteAdjustmentsToCalendar push back.
export async function pullSiteAdjustmentEdits(options: {
  db: Firestore;
  calendar: calendar_v3.Calendar;
  calendarId: string;
  now?: Date;
}) {
  const {db, calendar, calendarId} = options;
  const now = options.now || new Date();
  const today = todayInPacific(now);
  const dayMs = 24 * 60 * 60 * 1000;

  const stateSnapshot = await db.collection(STATE_COLLECTION).where("kind", "==", STATE_KIND).get();
  const statesByBesa = new Map<string, typeof stateSnapshot.docs>();
  for (const doc of stateSnapshot.docs) {
    const state = doc.data() as SyncedState;
    if (state.calendarId !== calendarId || state.date < today) continue;
    statesByBesa.set(state.besaId, [...(statesByBesa.get(state.besaId) || []), doc]);
  }
  if (statesByBesa.size === 0) return {updated: 0, removed: 0};

  const events = await listEvents(
    calendar, calendarId, new Date(now.getTime() - dayMs), new Date(now.getTime() + 190 * dayMs)
  );

  let updated = 0;
  let removed = 0;
  for (const [besaId, stateDocs] of statesByBesa) {
    const besaRef = db.collection("Besas").doc(besaId);
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(besaRef);
      if (!snapshot.exists) return;
      const data = snapshot.data() || {};
      const besa = {
        name: typeof data.name === "string" ? data.name.trim() : "",
        email: typeof data.email === "string" ? data.email.trim().toLowerCase() : "",
      };
      const raw: Array<Record<string, unknown>> = Array.isArray(data.tempAdjustments) ? data.tempAdjustments : [];
      const siteById = new Map(readSiteAdjustments(raw).map((adjustment) => [adjustment.id, adjustment]));
      let next = raw;
      let changed = false;

      for (const stateDoc of stateDocs) {
        const state = stateDoc.data() as SyncedState;
        const adjustment = siteById.get(state.adjustmentId);
        if (!adjustment) continue; // removed on the site; the push trigger restores that day

        const ours = events.filter((dayEvent) => dayEvent.tag === state.adjustmentId);
        const temporaryCount = state.temporaryCount ?? state.eventCount ?? 0;
        if (temporaryCount > 0 && ours.length === 0) {
          // Every temporary event for it was deleted in Google Calendar
          next = next.filter((entry) => entry.id !== state.adjustmentId);
          tx.delete(stateDoc.ref);
          changed = true;
          removed += 1;
          continue;
        }

        // Temporary events moved to another day take the adjustment with them
        const date = ours[0]?.date || state.date;
        const sorted = (slots: Slot[]) => [...new Map(slots.map((slot) => [slotKey(slot), slot])).values()]
          .sort((a, b) => a.start.localeCompare(b.start));
        const temporarySlots = sorted(ours.map((dayEvent) => dayEvent.slot));
        const timeSlots = sorted([
          ...temporarySlots,
          ...events.filter((dayEvent) => dayEvent.date === date && isTheirs(dayEvent, besa.email)).map((dayEvent) => dayEvent.slot),
        ]);
        const pulled = {date, timeSlots, temporarySlots, reason: adjustment.reason};
        const hash = adjustmentHash(besa, pulled);
        if (hash === state.hash) continue;

        next = next.map((entry) => entry.id === state.adjustmentId ? {
          ...entry,
          date,
          timeSlots: timeSlots.map((slot, index) => ({id: String(index), ...slot})),
          temporarySlots,
        } : entry);
        tx.update(stateDoc.ref, {date, hash});
        changed = true;
        updated += 1;
      }

      if (changed) tx.update(besaRef, {tempAdjustments: next});
    });
  }

  if (updated || removed) {
    logger.info("Pulled Google Calendar edits to site office-hour changes", {calendarId, updated, removed});
  }
  return {updated, removed};
}
