import * as logger from "firebase-functions/logger";
import {setGlobalOptions} from "firebase-functions/v2";
import {
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentUpdated,
  onDocumentWritten,
} from "firebase-functions/v2/firestore";
import {onRequest} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {defineSecret, defineString} from "firebase-functions/params";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";

import {
  bookingReadyForCalendar,
  bookingSyncHash,
  BookingRecord,
  deleteCalendarEvent,
  getCalendarClientFromSecrets,
  insertCalendarEvent,
  resolveBookingId,
  resolveEventId,
  updateCalendarEvent,
} from "./calendar";
import {
  OFFICE_HOURS_TIME_ZONE,
  ensureOfficeHoursWatches,
  isKnownOfficeHoursChannel,
  syncOfficeHoursFromCalendar,
} from "./officeHours";
import {syncSiteAdjustmentsToCalendar} from "./siteAdjustments";

initializeApp();
setGlobalOptions({maxInstances: 10});

const db = getFirestore();
const calendarClientId = defineSecret("CALENDAR_CLIENT_ID");
const calendarClientSecret = defineSecret("CALENDAR_CLIENT_SECRET");
const calendarRefreshToken = defineSecret("CALENDAR_REFRESH_TOKEN");
const officeHoursCalendarIds = defineString("OFFICE_HOURS_CALENDAR_IDS", {
  description: "Comma-separated Google Calendar IDs to read BESA availability from " +
    "(the shared BESA calendar, plus \"primary\" for events BESAs invite the account to).",
});
const officeHoursWriteCalendarId = defineString("OFFICE_HOURS_WRITE_CALENDAR_ID", {
  default: "",
  description: "Google Calendar ID where office-hour changes made on the booking site are added as " +
    "\"{Name}'s Availability (Temporary)\" events. Leave empty to use the first non-primary ID in " +
    "OFFICE_HOURS_CALENDAR_IDS.",
});
const officeHoursWebhookUrl = defineString("OFFICE_HOURS_WEBHOOK_URL", {
  default: "",
  description: "Public URL of officeHoursCalendarWebhook. Leave empty to use the default us-central1 URL.",
});

function getCalendarRuntime(calendarId: string) {
  const calendar = getCalendarClientFromSecrets({
    clientId: calendarClientId.value(),
    clientSecret: calendarClientSecret.value(),
    refreshToken: calendarRefreshToken.value(),
    accessToken: process.env.CALENDAR_TOKEN,
    calendarId,
  });
  return {calendar, calendarId};
}

function syncMetadataUpdate(eventId: string, syncHash: string, calendarId: string) {
  return {
    calendarEventId: eventId,
    calendarSyncCalendarId: calendarId,
    calendarSyncHash: syncHash,
    calendarSyncStatus: "synced",
    calendarSyncUpdatedAt: new Date().toISOString(),
  };
}

async function enrichBookingWithTourDefaults(booking: BookingRecord): Promise<BookingRecord> {
  if (!booking.tourId) {
    return booking;
  }

  const tourSnapshot = await db.collection("Tours").doc(booking.tourId).get();
  if (!tourSnapshot.exists) {
    return booking;
  }

  const tourData = tourSnapshot.data() as BookingRecord | undefined;
  if (!tourData) {
    return booking;
  }

  return {
    ...booking,
    calendarInviteLocation:
      booking.calendarInviteLocation ||
      (typeof tourData.calendarInviteLocation === "string" ? tourData.calendarInviteLocation : undefined),
    calendarInviteDetails:
      booking.calendarInviteDetails ||
      (typeof tourData.calendarInviteDetails === "string" ? tourData.calendarInviteDetails : undefined),
    location:
      booking.location ||
      (typeof tourData.location === "string" ? tourData.location : undefined),
    googleCalendarId:
      typeof tourData.googleCalendarId === "string" ? tourData.googleCalendarId : booking.googleCalendarId,
  };
}

function resolveCalendarId(booking: BookingRecord) {
  if (typeof booking.googleCalendarId === "string" && booking.googleCalendarId.trim()) {
    return booking.googleCalendarId.trim();
  }
  return process.env.CALENDAR_ID || "primary";
}

async function writeSyncError(bookingId: string, error: unknown) {
  await db.collection("Bookings").doc(bookingId).set(
    {
      calendarSyncStatus: "error",
      calendarSyncError: error instanceof Error ? error.message : String(error),
      calendarSyncUpdatedAt: new Date().toISOString(),
    },
    {merge: true}
  );
}

async function syncBookingRecord(booking: BookingRecord) {
  const bookingId = resolveBookingId(booking);
  if (!bookingId) {
    logger.warn("Skipping booking without bookingId", {booking});
    return;
  }

  const enrichedBooking = await enrichBookingWithTourDefaults(booking);

  if (!bookingReadyForCalendar(enrichedBooking)) {
    logger.info("Skipping booking not ready for calendar sync", {bookingId});
    return;
  }

  const syncHash = bookingSyncHash(enrichedBooking);
  if (
    enrichedBooking.calendarSyncHash === syncHash &&
    enrichedBooking.calendarSyncStatus === "synced"
  ) {
    logger.debug("Booking already synced", {bookingId});
    return;
  }

  const calendarId = resolveCalendarId(enrichedBooking);
  const existingCalendarId = enrichedBooking.calendarSyncCalendarId || calendarId;
  const {calendar: existingCalendar} = getCalendarRuntime(existingCalendarId);
  const existingEventId = await resolveEventId(
    existingCalendar,
    enrichedBooking,
    enrichedBooking,
    existingCalendarId
  );

  let syncedEvent;
  if (existingEventId && existingCalendarId !== calendarId) {
    await deleteCalendarEvent(existingCalendar, existingEventId, existingCalendarId);
    const {calendar} = getCalendarRuntime(calendarId);
    syncedEvent = await insertCalendarEvent(calendar, enrichedBooking, calendarId);
  } else if (existingEventId) {
    syncedEvent = await updateCalendarEvent(
      existingCalendar,
      existingEventId,
      enrichedBooking,
      calendarId
    );
  } else {
    syncedEvent = await insertCalendarEvent(existingCalendar, enrichedBooking, calendarId);
  }
  const newCalendarEventId = syncedEvent.id || existingEventId || "";

  await db.collection("Bookings").doc(bookingId).set(
    syncMetadataUpdate(newCalendarEventId, syncHash, calendarId),
    {merge: true}
  );

  logger.info("Booking synced to Google Calendar", {
    bookingId,
    operation: existingEventId ? "updated" : "inserted",
    oldCalendarEventId: existingEventId || null,
    newCalendarEventId,
  });
}

async function deleteBookingRecord(booking: BookingRecord) {
  const bookingId = resolveBookingId(booking);
  if (!bookingId) {
    logger.warn("Skipping delete without bookingId", {booking});
    return;
  }

  const enrichedBooking = await enrichBookingWithTourDefaults(booking);
  const calendarId = enrichedBooking.calendarSyncCalendarId || resolveCalendarId(enrichedBooking);
  const {calendar} = getCalendarRuntime(calendarId);
  const eventId = await resolveEventId(calendar, booking, booking, calendarId);
  const deleted = await deleteCalendarEvent(calendar, eventId, calendarId);

  logger.info("Deleted Google Calendar event for booking", {
    bookingId,
    calendarEventId: eventId || null,
    deleted,
  });
}

const bookingTriggerOptions = {
  document: "Bookings/{bookingId}",
  secrets: [
    calendarClientId,
    calendarClientSecret,
    calendarRefreshToken,
  ],
};

export const onBookingCreated = onDocumentCreated(bookingTriggerOptions, async (event) => {
  const data = event.data?.data() as BookingRecord | undefined;
  if (!data) return;

  const bookingId = event.params.bookingId;
  const booking = {...data, bookingId};

  try {
    await syncBookingRecord(booking);
  } catch (error) {
    logger.error("Booking create sync failed", {bookingId, error});
    await writeSyncError(bookingId, error);
    throw error;
  }
});

export const onBookingUpdated = onDocumentUpdated(bookingTriggerOptions, async (event) => {
  const bookingId = event.params.bookingId;
  const beforeData = event.data?.before.data() as BookingRecord | undefined;
  const afterData = event.data?.after.data() as BookingRecord | undefined;
  if (!afterData) return;

  const beforeBooking = beforeData ? {...beforeData, bookingId} : undefined;
  const booking = {...afterData, bookingId};

  if (beforeBooking && bookingSyncHash(beforeBooking) === bookingSyncHash(booking)) {
    logger.debug("Skipping metadata-only booking update", {bookingId});
    return;
  }

  try {
    await syncBookingRecord(booking);
  } catch (error) {
    logger.error("Booking update sync failed", {bookingId, error});
    await writeSyncError(bookingId, error);
    throw error;
  }
});

export const onBookingDeleted = onDocumentDeleted(bookingTriggerOptions, async (event) => {
  const data = event.data?.data() as BookingRecord | undefined;
  const bookingId = event.params.bookingId;
  const booking = {
    ...(data || {}),
    bookingId,
  };

  try {
    await deleteBookingRecord(booking);
  } catch (error) {
    logger.error("Booking delete sync failed", {bookingId, error});
    throw error;
  }
});

// --- Office hours from the shared BESA Google Calendar (see officeHours.ts) ---

const calendarSecrets = [calendarClientId, calendarClientSecret, calendarRefreshToken];

function getOfficeHoursCalendarIds() {
  return officeHoursCalendarIds.value().split(",").map((id) => id.trim()).filter(Boolean);
}

function getOfficeHoursWebhookUrl() {
  const configured = officeHoursWebhookUrl.value().trim();
  if (configured) return configured;
  const projectId = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || "{}").projectId;
  return `https://us-central1-${projectId}.cloudfunctions.net/officeHoursCalendarWebhook`;
}

function getOfficeHoursWriteCalendarId() {
  const configured = officeHoursWriteCalendarId.value().trim();
  if (configured) return configured;
  const ids = getOfficeHoursCalendarIds();
  return ids.find((id) => id !== "primary") || ids[0] || "primary";
}

async function runOfficeHoursSync() {
  const {calendar} = getCalendarRuntime("primary");
  return syncOfficeHoursFromCalendar({db, calendar, calendarIds: getOfficeHoursCalendarIds()});
}

// Google Calendar push notifications land here. They say only that something changed, so
// each one triggers a full recompute. One instance handling one request at a time keeps
// bursts (e.g. editing a whole recurring series) from running syncs in parallel.
export const officeHoursCalendarWebhook = onRequest(
  {secrets: calendarSecrets, maxInstances: 1, concurrency: 1, timeoutSeconds: 300},
  async (req, res) => {
    const channelId = req.get("X-Goog-Channel-ID") || "";
    const token = req.get("X-Goog-Channel-Token") || "";
    if (!(await isKnownOfficeHoursChannel(db, channelId, token))) {
      logger.warn("Ignoring calendar notification from unknown channel", {channelId});
      res.status(200).send("ignored");
      return;
    }
    // Google sends a "sync" message when a channel opens; nothing has changed yet.
    if (req.get("X-Goog-Resource-State") === "sync") {
      res.status(200).send("ok");
      return;
    }

    try {
      await runOfficeHoursSync();
      res.status(200).send("synced");
    } catch (error) {
      logger.error("Office hours sync from calendar notification failed", {error});
      // A non-2xx response makes Google retry the notification with backoff.
      res.status(500).send("sync failed");
    }
  }
);

// Renews the push channels before they expire and runs a full sync, which also rolls the
// date window forward and catches anything a missed notification would have changed.
export const refreshOfficeHoursCalendarSync = onSchedule(
  {schedule: "every 6 hours", timeZone: OFFICE_HOURS_TIME_ZONE, secrets: calendarSecrets, timeoutSeconds: 300},
  async () => {
    const {calendar} = getCalendarRuntime("primary");
    await ensureOfficeHoursWatches({
      db,
      calendar,
      calendarIds: getOfficeHoursCalendarIds(),
      webhookUrl: getOfficeHoursWebhookUrl(),
    });
    await runOfficeHoursSync();

    // Catch up on site changes a failed or missed trigger didn't push to the calendar.
    const besas = await db.collection("Besas").get();
    for (const doc of besas.docs) {
      await syncSiteAdjustmentsToCalendar({
        db, calendar, calendarId: getOfficeHoursWriteCalendarId(), besaId: doc.id, besaData: doc.data(),
      });
    }
  }
);

// Office-hour changes made on the booking site (tempAdjustments without source "calendar")
// are mirrored to Google Calendar as "{Name}'s Availability (Temporary)" events. One run at
// a time, so quick back-to-back saves can't create the same event twice.
export const onBesaWrittenSyncTempAdjustments = onDocumentWritten(
  {document: "Besas/{besaId}", secrets: calendarSecrets, maxInstances: 1, concurrency: 1},
  async (event) => {
    const besaId = event.params.besaId;
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    // Writes that don't touch tempAdjustments (or the name/email on the events) need no calendar work.
    if (
      before && after &&
      JSON.stringify(before.tempAdjustments ?? null) === JSON.stringify(after.tempAdjustments ?? null) &&
      before.name === after.name && before.email === after.email
    ) {
      return;
    }

    const {calendar} = getCalendarRuntime("primary");
    try {
      await syncSiteAdjustmentsToCalendar({
        db, calendar, calendarId: getOfficeHoursWriteCalendarId(), besaId, besaData: after,
      });
    } catch (error) {
      logger.error("Syncing site office-hour changes to Google Calendar failed", {besaId, error});
      throw error;
    }
  }
);
