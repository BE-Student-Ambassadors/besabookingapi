from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from schemas.booking import AvailabilityResponse, BookingCreateRequest, BookingResponse
from services import booking_service

router = APIRouter()


def _get_db():
    from main import db

    if db is None:
        raise HTTPException(status_code=503, detail="Database is not configured.")
    return db


@router.get("/availability", response_model=AvailabilityResponse)
def get_availability(
    tourId: str = Query(...),
    date: Optional[str] = Query(None, description="YYYY-MM-DD, for a single day's time slots"),
    rangeStart: Optional[str] = Query(None, description="YYYY-MM-DD, for a calendar date-range view"),
    rangeEnd: Optional[str] = Query(None, description="YYYY-MM-DD, for a calendar date-range view"),
):
    db = _get_db()

    if date:
        result = booking_service.get_availability_for_date(db, tourId, date)
        return AvailabilityResponse(**result)

    if rangeStart and rangeEnd:
        result = booking_service.get_availability_for_range(db, tourId, rangeStart, rangeEnd)
        return AvailabilityResponse(tourId=tourId, available=True, dates=result["dates"])

    raise HTTPException(
        status_code=400,
        detail="Provide either `date`, or both `rangeStart` and `rangeEnd`.",
    )


@router.post("", response_model=BookingResponse)
@router.post("/", response_model=BookingResponse)
def create_booking(payload: BookingCreateRequest):
    db = _get_db()
    booking = booking_service.create_booking(db, payload)
    return BookingResponse(**booking)