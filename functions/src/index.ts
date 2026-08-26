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
  const eventId = await resolveEventId(calendar, booking, booking, calendarId, true);
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
