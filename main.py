from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from calendar_sync import get_db
from routers.bookings import router as bookings_router

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

app.include_router(bookings_router, prefix="/api/bookings", tags=["bookings"])

try:
    db = get_db()
except Exception:
    db = None

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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
