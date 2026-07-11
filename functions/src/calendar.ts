import {createHash} from "crypto";

import {google} from "googleapis";
import type {calendar_v3} from "googleapis";

export type CalendarSecrets = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  calendarId?: string;
};

export type BesaRecord = {
  email?: string;
  name?: string;
};

export type BookingRecord = {
  bookingId?: string;
  id?: string;
  tourType?: string;
  location?: string;
  date?: string;
  time?: string;
  startTime?: string;
  endTime?: string;
  startTimeISO?: string;
  endTimeISO?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  status?: string;
  besas?: Array<BesaRecord | string>;
  calendarEventId?: string;
  calendarSyncHash?: string;
  calendarSyncStatus?: string;
  previousCalendarEventId?: string;
  previousStartTimeISO?: string;
  previousEndTimeISO?: string;
  [key: string]: unknown;
};

const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/calendar"];
const SYNC_FIELDS = [
  "bookingId",
  "tourType",
  "location",
  "date",
  "time",
  "startTime",
  "endTime",
  "startTimeISO",
  "endTimeISO",
  "email",
  "firstName",
  "lastName",
  "status",
] as const;

export function resolveBookingId(data: BookingRecord): string | undefined {
  return data.bookingId || data.id;
}

export function canonicalBesas(besas: BookingRecord["besas"]): BesaRecord[] {
  const normalized: BesaRecord[] = [];
  for (const besa of besas || []) {
    if (typeof besa === "string") {
      normalized.push({email: besa, name: ""});
      continue;
    }
    if (besa && typeof besa === "object") {
      normalized.push({
        email: besa.email || "",
        name: besa.name || "",
      });
    }
  }
  return normalized.sort((a, b) =>
    `${a.email ?? ""}:${a.name ?? ""}`.localeCompare(
      `${b.email ?? ""}:${b.name ?? ""}`
    )
  );
}

function bookingSyncPayload(data: BookingRecord): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of SYNC_FIELDS) {
    payload[field] = data[field];
  }
  payload.besas = canonicalBesas(data.besas);
  return payload;
}

export function bookingSyncHash(data: BookingRecord): string {
  const serialized = JSON.stringify(bookingSyncPayload(data));
  return createHash("sha256").update(serialized).digest("hex");
}

export function bookingReadyForCalendar(data: BookingRecord): boolean {
  if (!data.email || !data.date || !data.tourType) {
    return false;
  }
  const startTime = data.startTime || data.time;
  const endTime = data.endTime || data.endTimeISO;
  return Boolean(startTime && endTime);
}

function parseTimeLabel(value: string): {hour: number; minute: number} {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) {
    throw new Error(`Unexpected time format: ${value}`);
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return {hour, minute};
}

function localDateTimeString(date: string, timeLabel: string): string {
  const {hour, minute} = parseTimeLabel(timeLabel);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date}T${pad(hour)}:${pad(minute)}:00`;
}

function resolveStartLabel(data: BookingRecord): string {
  return (data.startTime || data.time || "").toString();
}

function resolveEndLabel(data: BookingRecord): string {
  return (data.endTime || "").toString();
}

export function createCalendarEvent(data: BookingRecord): calendar_v3.Schema$Event {
  const attendees: calendar_v3.Schema$EventAttendee[] = [
    {
      email: data.email,
      displayName: `${data.firstName || ""} ${data.lastName || ""}`.trim(),
    },
  ];

  for (const besa of data.besas || []) {
    if (typeof besa === "string" && besa) {
      attendees.push({email: besa, displayName: ""});
      continue;
    }
    if (besa && typeof besa === "object" && besa.email) {
      attendees.push({
        email: besa.email,
        displayName: besa.name || "",
      });
    }
  }

  const bookingId = resolveBookingId(data) || "";
  const date = data.date || "";
  const startLabel = resolveStartLabel(data);
  const endLabel = resolveEndLabel(data);

  return {
    summary: data.tourType || "Baskin Engineering In-Person Tour",
    location:
      data.location ||
      "Baskin Engineering Courtyard, 606 Engineering Loop, Santa Cruz, CA 95064",
    description: [
      "Thank you for booking a Baskin Engineering Tour. We are excited to have you join us!",
      "",
      "Tour Details:",
      "• Location: Baskin Engineering Courtyard, the brick road area between the two buildings in Baskin.",
      "  This is down the stairs from the Engineering Loop.",
      "• Who to Meet: A Baskin Engineering Tour Guide wearing a name tag.",
      "",
      "Important Information:",
      "• Tour Times: All tours are scheduled in Pacific Time (PT). Your calendar may convert this to your local time zone automatically.",
      "• No Double Booking: This is a small tour (1–3 families). Please avoid double booking.",
      "",
      "Questions?",
      "Email us at ucscbesa@ucsc.edu",
      "",
      "We look forward to seeing you!",
      "",
      "— Baskin Engineering Student Ambassadors",
    ].join("\n"),
    start: {
      dateTime: localDateTimeString(date, startLabel),
      timeZone: "America/Los_Angeles",
    },
    end: {
      dateTime: localDateTimeString(date, endLabel),
      timeZone: "America/Los_Angeles",
    },
    attendees,
    transparency: "opaque",
    visibility: "default",
    reminders: {useDefault: true},
    extendedProperties: {
      private: {
        bookingId,
      },
    },
  };
}

export function getCalendarClient(): calendar_v3.Calendar {
  throw new Error("Use getCalendarClientFromSecrets instead.");
}

export function getCalendarClientFromSecrets(
  secrets: CalendarSecrets
): calendar_v3.Calendar {
  const {clientId, clientSecret, refreshToken, accessToken} = secrets;
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({
    refresh_token: refreshToken,
    access_token: accessToken,
  });
  auth.credentials.scope = DEFAULT_SCOPES.join(" ");

  return google.calendar({version: "v3", auth});
}

export async function insertCalendarEvent(
  calendar: calendar_v3.Calendar,
  booking: BookingRecord,
  calendarId = "primary"
): Promise<calendar_v3.Schema$Event> {
  const response = await calendar.events.insert({
    calendarId,
    requestBody: createCalendarEvent(booking),
    sendUpdates: "all",
  });
  return response.data;
}

export async function deleteCalendarEvent(
  calendar: calendar_v3.Calendar,
  eventId?: string | null,
  calendarId = "primary"
): Promise<boolean> {
  if (!eventId) return false;
  try {
    await calendar.events.delete({
      calendarId,
      eventId,
      sendUpdates: "all",
    });
    return true;
  } catch (error: unknown) {
    const status = (error as {code?: number}).code;
    if (status === 404) {
      return false;
    }
    throw error;
  }
}

export async function findCalendarEventId(
  calendar: calendar_v3.Calendar,
  bookingId?: string,
  calendarId = "primary"
): Promise<string | undefined> {
  if (!bookingId) return undefined;
  let pageToken: string | undefined;
  do {
    const response = await calendar.events.list({
      calendarId,
      privateExtendedProperty: [`bookingId=${bookingId}`],
      singleEvents: true,
      showDeleted: false,
      pageToken,
    } satisfies calendar_v3.Params$Resource$Events$List);
    const eventId = response.data.items?.[0]?.id || undefined;
    if (eventId) return eventId;
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return undefined;
}

export async function findCalendarEventIdByDetails(
  calendar: calendar_v3.Calendar,
  email?: string,
  startIso?: string,
  endIso?: string,
  summary?: string,
  calendarId = "primary"
): Promise<string | undefined> {
  if (!email || !startIso || !endIso) return undefined;
  const response = await calendar.events.list({
    calendarId,
    timeMin: startIso,
    timeMax: endIso,
    singleEvents: true,
    showDeleted: false,
  });

  for (const item of response.data.items || []) {
    const attendees = item.attendees || [];
    const attendeeMatch = attendees.some((attendee) => attendee.email === email);
    if (!attendeeMatch) continue;
    if (summary && item.summary !== summary) continue;
    return item.id || undefined;
  }
  return undefined;
}

export async function resolveEventId(
  calendar: calendar_v3.Calendar,
  payload: BookingRecord,
  existing?: BookingRecord,
  calendarId = "primary"
): Promise<string | undefined> {
  const bookingId = resolveBookingId(payload);
  return (
    existing?.calendarEventId ||
    payload.calendarEventId ||
    payload.previousCalendarEventId ||
    (await findCalendarEventId(calendar, bookingId, calendarId)) ||
    (await findCalendarEventIdByDetails(
      calendar,
      payload.email || existing?.email,
      payload.previousStartTimeISO || existing?.startTimeISO,
      payload.previousEndTimeISO || existing?.endTimeISO,
      payload.tourType || existing?.tourType,
      calendarId
    ))
  );
}
