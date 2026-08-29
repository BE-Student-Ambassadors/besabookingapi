from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

from repositories import bookings_repository as repo
from services import availability_service as avail
from services import assignment_service as assign
from schemas.booking import BookingCreateRequest


class BookingValidationError(HTTPException):
    def __init__(self, detail: str):
        super().__init__(status_code=400, detail=detail)


def _combine_start_end(date_str: str, time_label: str, duration_mins: int) -> Tuple[datetime, datetime]:
    t24 = avail.parse_time_12h(time_label)
    if not t24:
        raise BookingValidationError(f"Unrecognized time format: {time_label}")
    hh, mm = map(int, t24.split(":"))
    d = avail.parse_date(date_str)
    start = datetime(d.year, d.month, d.day, hh, mm)
    end = start + timedelta(minutes=duration_mins)
    return start, end


def get_availability_for_date(db, tour_id: str, date_str: str) -> Dict[str, Any]:
    tour = repo.get_tour(db, tour_id)
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    all_tours = repo.get_all_tours(db)
    available, reason = avail.is_date_available(date_str, tour, all_tours)
    if not available:
        return {"tourId": tour_id, "date": date_str, "available": False, "reason": reason, "times": []}

    besas = repo.get_active_besas(db)
    bookings_for_tour = repo.get_bookings_for_tour(db, tour_id, date_str)
    bookings_on_date = repo.get_bookings_for_date_range(db, date_str, date_str)

    times = avail.get_available_times(tour, date_str, all_tours, bookings_for_tour, bookings_on_date, besas)

    return {
        "tourId": tour_id,
        "date": date_str,
        "available": len(times) > 0,
        "reason": None if times else "No available time slots for this date",
        "times": times,
    }


def get_availability_for_range(db, tour_id: str, start_date: str, end_date: str) -> Dict[str, Any]:
    tour = repo.get_tour(db, tour_id)
    if not tour:
        raise HTTPException(status_code=404, detail="Tour not found")

    all_tours = repo.get_all_tours(db)
    besas = repo.get_active_besas(db)
    bookings_on_range = repo.get_bookings_for_date_range(db, start_date, end_date)
    bookings_for_tour_on_range = [b for b in bookings_on_range if b.get("tourId") == tour_id]

    dates: Dict[str, bool] = {}
    current = avail.parse_date(start_date)
    end = avail.parse_date(end_date)
    while current <= end:
        date_str = current.isoformat()
        date_ok, _ = avail.is_date_available(date_str, tour, all_tours)
        if date_ok:
            bookings_for_tour_on_date = [b for b in bookings_for_tour_on_range if b.get("date") == date_str]
            bookings_on_date = [b for b in bookings_on_range if b.get("date") == date_str]
            date_ok = avail.has_available_time_slots(
                tour, date_str, all_tours, bookings_for_tour_on_date, bookings_on_date, besas
            )
        dates[date_str] = date_ok
        current += timedelta(days=1)

    return {"tourId": tour_id, "dates": dates}


def create_booking(db, payload: BookingCreateRequest) -> Dict[str, Any]:
    tour = repo.get_tour(db, payload.tourId)
    if not tour:
        raise BookingValidationError("Selected tour not found.")

    all_tours = repo.get_all_tours(db)

    date_ok, date_reason = avail.is_date_available(payload.date, tour, all_tours)
    if not date_ok:
        raise BookingValidationError(date_reason or "Selected date is not available.")

    max_attendees_per_booking = tour.get("maxAttendeesPerBooking") or tour.get("maxAttendees") or 15
    if payload.maxAttendees > max_attendees_per_booking:
        raise BookingValidationError(
            f"Group size exceeds the maximum of {max_attendees_per_booking} for this tour."
        )

    besas = repo.get_active_besas(db)
    bookings_for_tour = repo.get_bookings_for_tour(db, payload.tourId, payload.date)
    bookings_on_date = repo.get_bookings_for_date_range(db, payload.date, payload.date)

    available_times = avail.get_available_times(
        tour, payload.date, all_tours, bookings_for_tour, bookings_on_date, besas
    )
    matching_slot = next((t for t in available_times if t["time"] == payload.startTime), None)
    if not matching_slot:
        raise BookingValidationError(
            "That time slot is no longer available. Please choose another time."
        )

    duration_mins = avail.duration_in_minutes(tour.get("duration", 0), tour.get("durationUnit", "minutes"))
    start_dt, end_dt = _combine_start_end(payload.date, payload.startTime, duration_mins)

    assigned_besas = assign.get_auto_assigned_besas(
        besas, payload.tourId, payload.date, payload.startTime, duration_mins
    )

    booking_payload = {
        "tourId": payload.tourId,
        "tourType": tour.get("title", ""),
        "date": payload.date,
        "startTime": payload.startTime,
        "time": payload.startTime,
        "endTime": end_dt.strftime("%-I:%M %p") if hasattr(end_dt, "strftime") else "",
        "startTimeISO": start_dt.isoformat(),
        "endTimeISO": end_dt.isoformat(),
        "maxAttendees": payload.maxAttendees,
        "firstName": payload.firstName,
        "lastName": payload.lastName,
        "email": payload.email,
        "phone": payload.phone,
        "organization": payload.organization,
        "role": payload.role,
        "interests": payload.interests,
        "accommodations": payload.accommodations or "",
        "largeTourDetails": payload.largeTourDetails or "",
        "notes": payload.notes or "",
        "location": tour.get("location", "Not specified"),
        "besas": assigned_besas,
        "status": "",
        "leadGuide": "",
    }

    max_bookings_for_slot = tour.get("maxBookings") or 1
    try:
        result = repo.create_booking_transactional(db, booking_payload, max_bookings_for_slot)
    except repo.BookingConflictError as exc:
        raise BookingValidationError(str(exc))

    booking_payload["bookingId"] = result["bookingId"]
    booking_payload["createdAt"] = result["createdAt"]

    return booking_payload
