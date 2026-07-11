import hashlib
import json
import os
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import credentials, firestore
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from features import createEvent

DEFAULT_SCOPES = ["https://www.googleapis.com/auth/calendar"]
CALENDAR_ID = "primary"
SYNC_FIELDS = (
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
)


def load_firebase_credentials():
    private_key = os.getenv("FIREBASE_PRIVATE_KEY")
    service_account_type = os.getenv("FIREBASE_TYPE")

    if private_key and service_account_type:
        service_account_info = {
            "type": service_account_type,
            "project_id": os.getenv("FIREBASE_PROJECT_ID"),
            "private_key_id": os.getenv("FIREBASE_PRIVATE_KEY_ID"),
            "private_key": private_key.replace("\\n", "\n"),
            "client_email": os.getenv("FIREBASE_CLIENT_EMAIL"),
            "client_id": os.getenv("FIREBASE_CLIENT_ID"),
            "auth_uri": os.getenv("FIREBASE_AUTH_URI"),
            "token_uri": os.getenv("FIREBASE_TOKEN_URI"),
            "auth_provider_x509_cert_url": os.getenv("FIREBASE_AUTH_PROVIDER_X509_CERT_URL"),
            "client_x509_cert_url": os.getenv("FIREBASE_CLIENT_X509_CERT_URL"),
            "universe_domain": os.getenv("FIREBASE_UNIVERSE_DOMAIN"),
        }
        return credentials.Certificate(service_account_info)

    return credentials.Certificate("./serviceAccountKey.json")


def get_db():
    if not firebase_admin._apps:
        firebase_cred = load_firebase_credentials()
        firebase_admin.initialize_app(firebase_cred)
    return firestore.client()


def load_google_calendar_credentials(scopes):
    token = os.getenv("CALENDAR_TOKEN")
    refresh_token = os.getenv("CALENDAR_REFRESH_TOKEN")
    token_uri = os.getenv("CALENDAR_TOKEN_URI")
    client_id = os.getenv("CALENDAR_CLIENT_ID")
    client_secret = os.getenv("CALENDAR_CLIENT_SECRET")

    if token and refresh_token and token_uri and client_id and client_secret:
        token_info = {
            "token": token,
            "refresh_token": refresh_token,
            "token_uri": token_uri,
            "client_id": client_id,
            "client_secret": client_secret,
            "scopes": scopes,
            "universe_domain": os.getenv("CALENDAR_UNIVERSE_DOMAIN"),
            "account": os.getenv("CALENDAR_ACCOUNT", ""),
        }
        expiry = os.getenv("CALENDAR_EXPIRY")
        if expiry:
            token_info["expiry"] = expiry
        return Credentials.from_authorized_user_info(token_info, scopes)

    return Credentials.from_authorized_user_file("token.json", scopes)


def get_calendar_service():
    creds = load_google_calendar_credentials(DEFAULT_SCOPES)
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


def resolve_booking_id(payload):
    return payload.get("bookingId") or payload.get("id")


def get_booking_doc(db, booking_id):
    if not db or not booking_id:
        return None

    snapshot = db.collection("Bookings").document(booking_id).get()
    if not snapshot.exists:
        return None

    data = snapshot.to_dict() or {}
    data["bookingId"] = snapshot.id
    return data


def update_booking_doc(db, booking_id, values):
    if not db or not booking_id:
        return

    db.collection("Bookings").document(booking_id).set(values, merge=True)


def delete_calendar_event(calendar_service, event_id):
    if not event_id:
        return False

    try:
        calendar_service.events().delete(
            calendarId=CALENDAR_ID,
            eventId=event_id,
            sendUpdates="all",
        ).execute()
        return True
    except HttpError as err:
        if getattr(err, "resp", None) and err.resp.status == 404:
            return False
        raise


def find_calendar_event_id(calendar_service, booking_id):
    if not booking_id or not calendar_service:
        return None

    page_token = None
    while True:
        response = calendar_service.events().list(
            calendarId=CALENDAR_ID,
            privateExtendedProperty=f"bookingId={booking_id}",
            singleEvents=True,
            showDeleted=False,
            pageToken=page_token,
        ).execute()

        items = response.get("items", [])
        if items:
            return items[0].get("id")

        page_token = response.get("nextPageToken")
        if not page_token:
            return None


def find_calendar_event_id_by_details(calendar_service, email, start_iso, end_iso, summary=None):
    if not calendar_service or not email or not start_iso or not end_iso:
        return None

    response = calendar_service.events().list(
        calendarId=CALENDAR_ID,
        timeMin=start_iso,
        timeMax=end_iso,
        singleEvents=True,
        showDeleted=False,
    ).execute()

    for item in response.get("items", []):
        attendees = item.get("attendees", [])
        attendee_match = any(att.get("email") == email for att in attendees)
        if not attendee_match:
            continue

        if summary and item.get("summary") != summary:
            continue

        return item.get("id")

    return None


def resolve_event_id(calendar_service, payload, booking_doc=None):
    booking_id = resolve_booking_id(payload)

    event_id = (
        (booking_doc or {}).get("calendarEventId")
        or payload.get("calendarEventId")
        or payload.get("previousCalendarEventId")
        or find_calendar_event_id(calendar_service, booking_id)
    )
    if event_id:
        return event_id

    return find_calendar_event_id_by_details(
        calendar_service,
        email=payload.get("email") or (booking_doc or {}).get("email"),
        start_iso=payload.get("previousStartTimeISO") or (booking_doc or {}).get("startTimeISO"),
        end_iso=payload.get("previousEndTimeISO") or (booking_doc or {}).get("endTimeISO"),
        summary=payload.get("tourType") or (booking_doc or {}).get("tourType"),
    )


def insert_calendar_event(calendar_service, booking_data):
    event = createEvent(booking_data, calendar_service)
    return calendar_service.events().insert(
        calendarId=CALENDAR_ID,
        body=event,
        sendUpdates="all",
    ).execute()


def canonical_besas(besas):
    normalized = []
    for besa in besas or []:
        if isinstance(besa, dict):
            normalized.append(
                {
                    "email": besa.get("email", ""),
                    "name": besa.get("name", ""),
                }
            )
        elif isinstance(besa, str):
            normalized.append(
                {
                    "email": besa,
                    "name": "",
                }
            )
    return sorted(normalized, key=lambda item: (item["email"], item["name"]))


def booking_sync_payload(data):
    payload = {field: data.get(field) for field in SYNC_FIELDS}
    payload["besas"] = canonical_besas(data.get("besas"))
    return payload


def booking_sync_hash(data):
    serialized = json.dumps(booking_sync_payload(data), sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def booking_ready_for_calendar(data):
    required = ("email", "date", "tourType")
    if any(not data.get(field) for field in required):
        return False

    start_time = data.get("startTime") or data.get("time")
    end_time = data.get("endTime") or data.get("endTimeISO")
    return bool(start_time and end_time)


def sync_metadata_update(event_id, sync_hash, status="synced"):
    return {
        "calendarEventId": event_id,
        "calendarSyncHash": sync_hash,
        "calendarSyncStatus": status,
        "calendarSyncUpdatedAt": datetime.now(timezone.utc).isoformat(),
    }


def sync_booking_record(db, calendar_service, booking_data):
    booking_id = resolve_booking_id(booking_data)
    if booking_id and "bookingId" not in booking_data:
        booking_data = {**booking_data, "bookingId": booking_id}

    if not booking_ready_for_calendar(booking_data):
        return {"status": "skipped", "reason": "booking_not_ready", "bookingId": booking_id}

    sync_hash = booking_sync_hash(booking_data)
    if (
        booking_data.get("calendarSyncHash") == sync_hash
        and booking_data.get("calendarSyncStatus") == "synced"
    ):
        return {"status": "noop", "reason": "already_synced", "bookingId": booking_id}

    existing_doc = get_booking_doc(db, booking_id) if booking_id else booking_data
    old_event_id = resolve_event_id(calendar_service, booking_data, existing_doc)
    deleted_original = delete_calendar_event(calendar_service, old_event_id)

    new_event = insert_calendar_event(calendar_service, booking_data)

    if booking_id:
        update_booking_doc(
            db,
            booking_id,
            sync_metadata_update(new_event.get("id"), sync_hash),
        )

    return {
        "status": "synced",
        "bookingId": booking_id,
        "deletedOriginal": deleted_original,
        "oldCalendarEventId": old_event_id,
        "newCalendarEventId": new_event.get("id"),
    }


def delete_booking_record(db, calendar_service, booking_data):
    booking_id = resolve_booking_id(booking_data)
    event_id = resolve_event_id(calendar_service, booking_data, booking_data)
    deleted = delete_calendar_event(calendar_service, event_id)

    return {
        "status": "deleted",
        "bookingId": booking_id,
        "calendarEventId": event_id,
        "deleted": deleted,
    }
