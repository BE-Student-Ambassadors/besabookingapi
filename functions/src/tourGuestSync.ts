import type {Firestore} from "firebase-admin/firestore";
import type {calendar_v3} from "googleapis";
import * as logger from "firebase-functions/logger";

import {BookingRecord, canonicalBesas} from "./calendar";

type BesaDoc = {name?: string; email?: string; active?: boolean};

export type TourGuestSyncDeps = {
  db: Firestore;
  /** Calendar client for a given calendar id. */
  getCalendar: (calendarId: string) => calendar_v3.Calendar;
  /** Same hash the booking->calendar sync uses (must be computed on the enriched booking). */
  hashFor: (booking: BookingRecord) => Promise<string>;
  /** "log" = only log what would change. "apply" = write to Firestore. */
  mode: "log" | "apply";
};

const norm = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");

function sameBesas(a: BookingRecord["besas"], b: BookingRecord["besas"]) {
  const key = (list: BookingRecord["besas"]) =>
    canonicalBesas(list).map((x) => norm(x.email)).sort().join("|");
  return key(a) === key(b);
}

/**
 * Google Calendar wins for who is on a tour. For every upcoming booking that has a Google event,
 * keep only the event's guests who are BESAs (families / other guests are ignored), skip those who
 * declined, and write that list to the booking. The sync hash is updated in the same write so the
 * booking->calendar sync does NOT see a change and does not touch the event again.
 */
export async function reconcileTourGuests(deps: TourGuestSyncDeps) {
  const {db, getCalendar, hashFor, mode} = deps;

  const besaSnap = await db.collection("Besas").get();
  const besaByEmail = new Map<string, BesaDoc>();
  for (const doc of besaSnap.docs) {
    const data = doc.data() as BesaDoc;
    if (norm(data.email)) besaByEmail.set(norm(data.email), data);
  }

  // Date strings are YYYY-MM-DD; only look at today onward (past tours don't matter)
  const today = new Date().toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"});
  const bookingSnap = await db.collection("Bookings").where("date", ">=", today).get();

  const stats = {checked: 0, changed: 0, missingEvent: 0, skipped: 0, errors: 0};

  for (const doc of bookingSnap.docs) {
    const booking = {...(doc.data() as BookingRecord), bookingId: doc.id};
    const eventId = booking.calendarEventId;
    if (!eventId || booking.status === "cancelled") {
      stats.skipped++;
      continue;
    }
    stats.checked++;

    try {
      const calendarId = booking.calendarSyncCalendarId || (booking.googleCalendarId as string) || "primary";
      const calendar = getCalendar(calendarId);

      let event: calendar_v3.Schema$Event;
      try {
        event = (await calendar.events.get({calendarId, eventId})).data;
      } catch (error) {
        const code = (error as {code?: number}).code;
        if (code === 404 || code === 410) event = {status: "cancelled"};
        else throw error;
      }

      if (event.status === "cancelled") {
        // Never auto-delete a booking; just flag it so it shows up for a human
        stats.missingEvent++;
        logger.warn("Booking's Google event was deleted", {bookingId: doc.id});
        if (mode === "apply" && (booking as Record<string, unknown>).calendarEventMissing !== true) {
          await doc.ref.set({calendarEventMissing: true}, {merge: true});
        }
        continue;
      }

      const googleBesas = (event.attendees || [])
        .filter((guest) => guest.email && besaByEmail.has(norm(guest.email)))
        .filter((guest) => guest.responseStatus !== "declined")
        .map((guest) => {
          const record = besaByEmail.get(norm(guest.email))!;
          return {name: (record.name || guest.displayName || "").trim(), email: (record.email || guest.email || "").trim()};
        });

      // If Google shows no BESAs at all, don't wipe the booking (could be a calendar permissions issue)
      if (googleBesas.length === 0) {
        stats.skipped++;
        continue;
      }
      if (sameBesas(booking.besas, googleBesas)) continue;

      stats.changed++;
      logger.info("Tour guests differ from site", {
        bookingId: doc.id,
        site: canonicalBesas(booking.besas).map((x) => x.email),
        google: googleBesas.map((x) => x.email),
        mode,
      });
      if (mode !== "apply") continue;

      const updated = {...booking, besas: googleBesas};
      await doc.ref.set(
        {
          besas: googleBesas,
          calendarSyncHash: await hashFor(updated),
          calendarSyncStatus: "synced",
          calendarSyncUpdatedAt: new Date().toISOString(),
          calendarEventMissing: false,
          besasSource: "google-calendar",
        },
        {merge: true}
      );
    } catch (error) {
      stats.errors++;
      logger.error("Tour guest reconcile failed for booking", {bookingId: doc.id, error});
    }
  }

  logger.info("Tour guest reconcile finished", {...stats, mode});
  return stats;
}
