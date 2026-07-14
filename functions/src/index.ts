import * as logger from "firebase-functions/logger";
import {setGlobalOptions} from "firebase-functions/v2";
import {
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentUpdated,
} from "firebase-functions/v2/firestore";
import {defineSecret} from "firebase-functions/params";
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

initializeApp();
setGlobalOptions({maxInstances: 10});

const db = getFirestore();
const calendarClientId = defineSecret("CALENDAR_CLIENT_ID");
const calendarClientSecret = defineSecret("CALENDAR_CLIENT_SECRET");
const calendarRefreshToken = defineSecret("CALENDAR_REFRESH_TOKEN");

function getCalendarRuntime() {
  const calendarId = process.env.CALENDAR_ID || "primary";
  const calendar = getCalendarClientFromSecrets({
    clientId: calendarClientId.value(),
    clientSecret: calendarClientSecret.value(),
    refreshToken: calendarRefreshToken.value(),
    accessToken: process.env.CALENDAR_TOKEN,
    calendarId,
  });
  return {calendar, calendarId};
}

function syncMetadataUpdate(eventId: string, syncHash: string) {
  return {
    calendarEventId: eventId,
    calendarSyncHash: syncHash,
    calendarSyncStatus: "synced",
    calendarSyncUpdatedAt: new Date().toISOString(),
  };
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

  if (!bookingReadyForCalendar(booking)) {
    logger.info("Skipping booking not ready for calendar sync", {bookingId});
    return;
  }

  const syncHash = bookingSyncHash(booking);
  if (
    booking.calendarSyncHash === syncHash &&
    booking.calendarSyncStatus === "synced"
  ) {
    logger.debug("Booking already synced", {bookingId});
    return;
  }

  const {calendar, calendarId} = getCalendarRuntime();
  const existingEventId = await resolveEventId(calendar, booking, booking, calendarId);
  const syncedEvent = existingEventId ?
    await updateCalendarEvent(calendar, existingEventId, booking, calendarId) :
    await insertCalendarEvent(calendar, booking, calendarId);
  const newCalendarEventId = syncedEvent.id || existingEventId || "";

  await db.collection("Bookings").doc(bookingId).set(
    syncMetadataUpdate(newCalendarEventId, syncHash),
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

  const {calendar, calendarId} = getCalendarRuntime();
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
