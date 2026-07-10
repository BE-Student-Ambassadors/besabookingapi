import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from googleapiclient.errors import HttpError

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

import firebase_admin
from firebase_admin import credentials, firestore

from features import createEvent
app = FastAPI()

FRONTEND = "https://besa-booking-git-backendv5-be-student-ambassadors-projects.vercel.app"
STABLE = "https://besa-booking.vercel.app/"

ALLOWED_ORIGINS = [
    STABLE,
    "https://besa-booking.vercel.app",
    "http://localhost:5173",
]

app.add_middleware(
    CORSMiddleware,
    # allow_origins=["https://besa-booking.vercel.app"],
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://besa-booking.vercel.app",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
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


try:
    firebase_cred = load_firebase_credentials()
    firebase_admin.initialize_app(firebase_cred)
    db = firestore.client()
except Exception:
    db = None


DEFAULT_SCOPES = ["https://www.googleapis.com/auth/calendar"]
CALENDAR_ID = "primary"


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

    try:
        return Credentials.from_authorized_user_file("token.json", scopes)
    except Exception:
        return None


try:
    creds = load_google_calendar_credentials(DEFAULT_SCOPES)
    calendar_service = build(
        "calendar", "v3", credentials=creds, cache_discovery=False
    )
except Exception:
    calendar_service = None


def require_calendar_service():
    if not calendar_service:
        return JSONResponse(
            status_code=503,
            content={"detail": "Google Calendar service is not configured."},
        )
    return None


def get_booking_doc(booking_id):
    if not db or not booking_id:
        return None

    snapshot = db.collection("Bookings").document(booking_id).get()
    if not snapshot.exists:
        return None

    data = snapshot.to_dict() or {}
    data["bookingId"] = snapshot.id
    return data


def update_booking_doc(booking_id, values):
    if not db or not booking_id:
        return

    db.collection("Bookings").document(booking_id).set(values, merge=True)


def delete_calendar_event(event_id):
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


def find_calendar_event_id(booking_id):
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


def find_calendar_event_id_by_details(email, start_iso, end_iso, summary=None):
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


def insert_calendar_event(booking_data):
    event = createEvent(booking_data, calendar_service)
    return calendar_service.events().insert(
        calendarId=CALENDAR_ID,
        body=event,
        sendUpdates="all"
    ).execute()


def resolve_booking_id(payload):
    return payload.get("bookingId") or payload.get("id")


def resolve_event_id(payload, booking_doc=None):
    booking_id = resolve_booking_id(payload)

    event_id = (
        payload.get("calendarEventId")
        or payload.get("previousCalendarEventId")
        or (booking_doc or {}).get("calendarEventId")
        or find_calendar_event_id(booking_id)
    )
    if event_id:
        return event_id

    return find_calendar_event_id_by_details(
        email=payload.get("email") or (booking_doc or {}).get("email"),
        start_iso=payload.get("previousStartTimeISO") or (booking_doc or {}).get("startTimeISO"),
        end_iso=payload.get("previousEndTimeISO") or (booking_doc or {}).get("endTimeISO"),
        summary=payload.get("tourType") or (booking_doc or {}).get("tourType"),
    )




@app.get("/")
def root():
    return {"Hello": "World"}


@app.options("/{path:path}")
async def global_options(path: str):
    return JSONResponse(
        content={"message": "preflight ok"},
        headers={
            "Access-Control-Allow-Origin": FRONTEND,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
    )

@app.post("/test-book")
async def test_book(request: Request):
    data = {
        "attendees": 1,
        "besas": [],
        "date": "2025-12-19",
        "email": "njayasee@ucsc.edu",
        "firstName": "Description",
        "groupSize": 1,
        "interests": ["applied-mathematics"],
        "lastName": "Tester",
        "leadGuide": "",
        "maxAttendees": 3,
        "notes": "",
        "organization": "UCSC",
        "phone": "(626)35012",
        "role": "counselor",
        "status": "",
        "time": "3:30 PM",
        "timeSlot": "",
        "tourId": "FT3xl26IyNDiswRTbInY",
        "tourType": "BESAs Drop In Office Hours"
    }
    


@app.post("/book-tour/")
async def book_tour(request: Request):
    service_error = require_calendar_service()
    if service_error:
        return service_error

    data = await request.json()
    booking_id = resolve_booking_id(data)
    if booking_id and "bookingId" not in data:
        data["bookingId"] = booking_id

    result = insert_calendar_event(data)

    if booking_id:
        update_booking_doc(booking_id, {"calendarEventId": result.get("id")})

    return result


@app.post("/cancel-booking/")
async def cancel_booking(request: Request):
    service_error = require_calendar_service()
    if service_error:
        return service_error

    payload = await request.json()
    booking_id = resolve_booking_id(payload)
    booking_doc = get_booking_doc(booking_id)

    event_id = resolve_event_id(payload, booking_doc)

    deleted = delete_calendar_event(event_id)

    if booking_id:
        update_booking_doc(booking_id, {"calendarEventId": firestore.DELETE_FIELD})

    return {
        "bookingId": booking_id,
        "calendarEventId": event_id,
        "deleted": deleted,
    }


@app.post("/reschedule-booking/")
async def reschedule_booking(request: Request):
    service_error = require_calendar_service()
    if service_error:
        return service_error

    payload = await request.json()
    booking_id = resolve_booking_id(payload)
    if booking_id and "bookingId" not in payload:
        payload["bookingId"] = booking_id

    booking_doc = get_booking_doc(booking_id)
    old_event_id = resolve_event_id(payload, booking_doc)

    deleted = delete_calendar_event(old_event_id)
    new_event = insert_calendar_event(payload)

    if booking_id:
        update_booking_doc(booking_id, {"calendarEventId": new_event.get("id")})

    return {
        "bookingId": booking_id,
        "deletedOriginal": deleted,
        "oldCalendarEventId": old_event_id,
        "newCalendarEventId": new_event.get("id"),
        "newEvent": new_event,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
