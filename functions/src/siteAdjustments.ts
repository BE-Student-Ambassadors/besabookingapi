import {createHash} from "crypto";

import * as logger from "firebase-functions/logger";
import type {Firestore} from "firebase-admin/firestore";
import type {calendar_v3} from "googleapis";

import {OFFICE_HOURS_TIME_ZONE} from "./officeHours";

// Pushes temporary office-hour changes made on the booking site to Google Calendar, the
// reverse of officeHours.ts. Every tempAdjustment on a Besas doc that didn't come from the
// calendar (no source: "calendar") gets one "{Name}'s Availability (Temporary)" event per
// time slot, with the BESA invited.
//
// The events carry SITE_ADJUSTMENT_PROPERTY so the calendar -> Firestore sync ignores them;
// otherwise each change would come back as a second, calendar-sourced tempAdjustment.
//
// Like officeHours.ts, each run reconciles the whole doc rather than diffing before/after,
// so a missed or out-of-order trigger is fixed by the next write. Event ids are derived from
// the adjustment id, which makes inserts idempotent. What was pushed is recorded in
// CalendarSyncState (not on the Besas doc) so the admin page's saves can't clobber it.

// Must match SITE_ADJUSTMENT_PROPERTY in officeHours.ts.
const SITE_ADJUSTMENT_PROPERTY = "besaSiteAdjustmentId";
const STATE_COLLECTION = "CalendarSyncState";
const STATE_KIND = "siteAdjustmentEvents";

type Slot = {start: string; end: string};

type SiteAdjustment = {
  id: string;
  date: string;
  timeSlots: Slot[];
  reason: string;
};

type SyncedState = {
  kind: typeof STATE_KIND;
  besaId: string;
  adjustmentId: string;
  date: string;
  calendarId: string;
  eventCount: number;
  hash: string;
};

const HHMM = /^\d{2}:\d{2}$/;

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

function readSiteAdjustments(raw: unknown): SiteAdjustment[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const entry = (value || {}) as Record<string, unknown>;
    if (entry.source === "calendar") return [];
    if (typeof entry.id !== "string" || typeof entry.date !== "string") return [];
    const timeSlots = (Array.isArray(entry.timeSlots) ? entry.timeSlots : []).flatMap((slot: unknown) => {
      const s = (slot || {}) as Record<string, unknown>;
      return typeof s.start === "string" && typeof s.end === "string" && HHMM.test(s.start) && HHMM.test(s.end) &&
        s.start < s.end ? [{start: s.start, end: s.end}] : [];
    }).sort((a, b) => a.start.localeCompare(b.start));
    if (timeSlots.length === 0) return [];
    return [{
      id: entry.id,
      date: entry.date,
      timeSlots,
      reason: typeof entry.reason === "string" ? entry.reason.trim() : "",
    }];
  });
}

function buildEvent(
  besa: {id: string; name: string; email: string},
  adjustment: SiteAdjustment,
  slot: Slot
): calendar_v3.Schema$Event {
  const description = [
    adjustment.reason,
    "Temporary office hours set on the BESA booking site (Office Hours page). " +
      "Change or remove them there; edits made to this event aren't read back.",
  ].filter(Boolean).join("\n\n");
  return {
    summary: `${besa.name || "BESA"}'s Availability (Temporary)`,
    description,
    start: {dateTime: `${adjustment.date}T${slot.start}:00`, timeZone: OFFICE_HOURS_TIME_ZONE},
    end: {dateTime: `${adjustment.date}T${slot.end}:00`, timeZone: OFFICE_HOURS_TIME_ZONE},
    attendees: besa.email ? [{email: besa.email, displayName: besa.name, responseStatus: "accepted"}] : [],
    transparency: "transparent",
    status: "confirmed",
    extendedProperties: {
      shared: {[SITE_ADJUSTMENT_PROPERTY]: adjustment.id, besaId: besa.id},
      private: {[SITE_ADJUSTMENT_PROPERTY]: adjustment.id, besaId: besa.id},
    },
  };
}

function errorCode(error: unknown) {
  return (error as {code?: number}).code;
}

// Insert with a fixed id; if it already exists (or was deleted before), patch it instead.
async function upsertEvent(calendar: calendar_v3.Calendar, calendarId: string, eventId: string, body: calendar_v3.Schema$Event) {
  try {
    await calendar.events.insert({calendarId, sendUpdates: "all", requestBody: {...body, id: eventId}});
  } catch (error) {
    if (errorCode(error) !== 409) throw error;
    await calendar.events.patch({calendarId, eventId, sendUpdates: "all", requestBody: body});
  }
}

async function deleteEvent(calendar: calendar_v3.Calendar, calendarId: string, eventId: string) {
  try {
    await calendar.events.delete({calendarId, eventId, sendUpdates: "all"});
  } catch (error) {
    const code = errorCode(error);
    if (code !== 404 && code !== 410) throw error;
  }
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
  const besa = {
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

  let created = 0;
  let removed = 0;

  // Today and later: make the calendar match. Past adjustments are left as they were.
  for (const adjustment of adjustments) {
    if (adjustment.date < today) continue;
    const hash = createHash("sha1")
      .update(JSON.stringify([besa.name, besa.email, adjustment.date, adjustment.timeSlots, adjustment.reason]))
      .digest("hex");
    const existing = stateById.get(adjustment.id)?.data() as SyncedState | undefined;
    if (existing && existing.hash === hash && existing.calendarId === calendarId) continue;

    // Moved to a different calendar since last time: clear the old events first.
    const previousCount = existing?.eventCount || 0;
    if (existing && existing.calendarId !== calendarId) {
      for (let i = 0; i < previousCount; i += 1) {
        await deleteEvent(calendar, existing.calendarId, eventIdFor(besaId, adjustment.id, i));
      }
    }
    for (const [index, slot] of adjustment.timeSlots.entries()) {
      await upsertEvent(calendar, calendarId, eventIdFor(besaId, adjustment.id, index), buildEvent(besa, adjustment, slot));
    }
    if (existing && existing.calendarId === calendarId) {
      for (let i = adjustment.timeSlots.length; i < previousCount; i += 1) {
        await deleteEvent(calendar, calendarId, eventIdFor(besaId, adjustment.id, i));
      }
    }

    const state: SyncedState = {
      kind: STATE_KIND,
      besaId,
      adjustmentId: adjustment.id,
      date: adjustment.date,
      calendarId,
      eventCount: adjustment.timeSlots.length,
      hash,
    };
    await db.collection(STATE_COLLECTION).doc(stateDocId(besaId, adjustment.id)).set(state);
    created += 1;
  }

  // Adjustments removed on the site: delete their events unless the date has already passed.
  for (const [adjustmentId, doc] of stateById) {
    if (byId.has(adjustmentId)) continue;
    const state = doc.data() as SyncedState;
    if (state.date >= today) {
      for (let i = 0; i < state.eventCount; i += 1) {
        await deleteEvent(calendar, state.calendarId, eventIdFor(besaId, adjustmentId, i));
      }
      removed += 1;
    }
    await doc.ref.delete();
  }

  if (created || removed) {
    logger.info("Synced site office-hour changes to Google Calendar", {besaId, calendarId, created, removed});
  }
  return {created, removed};
}
