from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from calendar_sync import delete_booking_record, get_booking_doc, get_calendar_service, get_db, sync_booking_record

app = FastAPI()

FRONTEND = "https://besa-booking-git-backendv5-be-student-ambassadors-projects.vercel.app"
STABLE = "https://besa-booking.vercel.app/"

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://besa-booking.vercel.app",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

try:
    db = get_db()
except Exception:
    db = None

try:
    calendar_service = get_calendar_service()
except Exception:
    calendar_service = None


def require_services():
    if not db:
        return JSONResponse(
            status_code=503,
            content={"detail": "Firestore is not configured."},
        )
    if not calendar_service:
        return JSONResponse(
            status_code=503,
            content={"detail": "Google Calendar service is not configured."},
        )
    return None


@app.get("/")
def root():
    return {"Hello": "World"}


@app.options("/{path:path}")
async def global_options(path: str):
    del path
    return JSONResponse(
        content={"message": "preflight ok"},
        headers={
            "Access-Control-Allow-Origin": FRONTEND,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
    )


@app.post("/book-tour/")
async def book_tour(request: Request):
    del request
    return {
        "status": "accepted",
        "mode": "firestore-driven",
        "message": "Booking documents should be written to Firestore. Calendar sync now runs from Firestore changes, not browser-triggered API calls.",
    }


@app.post("/cancel-booking/")
async def cancel_booking(request: Request):
    del request
    return {
        "status": "accepted",
        "mode": "firestore-driven",
        "message": "Delete the booking document in Firestore. Calendar sync now runs from Firestore changes.",
    }


@app.post("/reschedule-booking/")
async def reschedule_booking(request: Request):
    del request
    return {
        "status": "accepted",
        "mode": "firestore-driven",
        "message": "Update the booking document in Firestore. Calendar sync now runs from Firestore changes.",
    }


@app.post("/sync-booking/{booking_id}")
async def sync_booking(booking_id: str):
    service_error = require_services()
    if service_error:
        return service_error

    booking_doc = get_booking_doc(db, booking_id)
    if not booking_doc:
        raise HTTPException(status_code=404, detail="Booking not found.")

    return sync_booking_record(db, calendar_service, booking_doc)


@app.post("/delete-booking-sync/{booking_id}")
async def delete_booking_sync(booking_id: str):
    service_error = require_services()
    if service_error:
        return service_error

    booking_doc = get_booking_doc(db, booking_id)
    if not booking_doc:
        raise HTTPException(status_code=404, detail="Booking not found.")

    return delete_booking_record(db, calendar_service, booking_doc)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
