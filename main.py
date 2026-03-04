import os
from datetime import datetime, timedelta

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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
    allow_origins=["https://besa-booking.vercel.app"],
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
    data = await request.json()
    event = createEvent(data, calendar_service)
    
    return calendar_service.events().insert(
        calendarId="primary",
        body=event,
        sendUpdates="all"
    ).execute()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
