from datetime import datetime, timedelta, date as date_cls
from typing import Any, Dict, List, Optional, Tuple

DAYS_OF_WEEK = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
]


def to_minutes(time_str: str) -> int:
    hours, minutes = time_str.split(":")
    return int(hours) * 60 + int(minutes)


def to_display_time(mins: int) -> str:
    hours24 = mins // 60
    minutes = mins % 60
    ampm = "PM" if hours24 >= 12 else "AM"
    hours12 = ((hours24 + 11) % 12) + 1
    return f"{hours12}:{minutes:02d} {ampm}"


def parse_time_12h(time12: str) -> Optional[str]:
    import re

    match = re.match(r"(\d{1,2}):(\d{2})\s*(AM|PM)", time12.strip(), re.IGNORECASE)
    if not match:
        return None
    hour = int(match.group(1))
    minute = match.group(2)
    ampm = match.group(3).upper()
    if ampm == "PM" and hour != 12:
        hour += 12
    elif ampm == "AM" and hour == 12:
        hour = 0
    return f"{hour:02d}:{minute}"


def minutes_from_label(label: Optional[str]) -> Optional[int]:
    if not label:
        return None
    t24 = parse_time_12h(label) or label
    if ":" not in t24:
        return None
    try:
        return to_minutes(t24)
    except ValueError:
        return None


def generate_time_slots(start: str, end: str, duration: int, frequency: int) -> List[str]:
    start_mins = to_minutes(start)
    end_mins = to_minutes(end)
    slots = []
    mins = start_mins
    while mins + duration <= end_mins:
        slots.append(to_display_time(mins))
        mins += frequency
    return slots


def duration_in_minutes(duration: float, duration_unit: str) -> int:
    if duration_unit in ("hours", "hour"):
        return int(duration * 60)
    return int(duration)


def parse_date(date_str: str) -> date_cls:
    return datetime.strptime(date_str, "%Y-%m-%d").date()


def is_date_in_range(date_str: str, start: Optional[str], end: Optional[str] = None) -> bool:
    if not start:
        return False
    d = parse_date(date_str)
    start_d = parse_date(start)
    end_d = parse_date(end) if end else start_d
    return start_d <= d <= end_d


def get_matching_availability_range(date_str: str, tour: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    ranges = tour.get("availabilityRanges") or []
    if not ranges:
        ranges = [{
            "startDate": tour.get("startDate", ""),
            "endDate": tour.get("endDate", ""),
            "weeklyHours": tour.get("weeklyHours", {}),
        }]
    for r in ranges:
        if is_date_in_range(date_str, r.get("startDate"), r.get("endDate")):
            return r
    return None


def find_date_override(date_str: str, tour: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    for override in tour.get("dateSpecificBlockDays") or []:
        if is_date_in_range(date_str, override.get("startDate"), override.get("endDate")):
            return override
    return None


def get_blocked_slot_rules(
    date_str: str, selected_tour: Optional[Dict[str, Any]], all_tours: List[Dict[str, Any]]
) -> Tuple[set, List[Tuple[int, int]]]:
    blocked_times: set = set()
    blocked_ranges: List[Tuple[int, int]] = []

    def add_rules(override: Optional[Dict[str, Any]]):
        if not override:
            return
        for t in override.get("blockedTimes") or []:
            if t:
                blocked_times.add(to_minutes(t))
        for r in override.get("blockedRanges") or []:
            if not r.get("start") or not r.get("end"):
                continue
            start = to_minutes(r["start"])
            end = to_minutes(r["end"])
            if start < 0 or end < 0 or start >= end:
                continue
            blocked_ranges.append((start, end))

    if selected_tour:
        add_rules(find_date_override(date_str, selected_tour))

    for tour in all_tours:
        for override in tour.get("dateSpecificBlockDays") or []:
            if override.get("appliesToAllTours") and is_date_in_range(
                date_str, override.get("startDate"), override.get("endDate")
            ):
                add_rules(override)

    return blocked_times, blocked_ranges


def is_slot_blocked(
    slot_start: int, slot_end: int, rules: Tuple[set, List[Tuple[int, int]]]
) -> bool:
    blocked_times, blocked_ranges = rules
    if slot_start in blocked_times:
        return True
    return any(slot_start < r_end and r_start < slot_end for r_start, r_end in blocked_ranges)


DAY_INDEX_TO_KEY = {
    0: "monday", 1: "tuesday", 2: "wednesday", 3: "thursday",
    4: "friday", 5: "saturday", 6: "sunday",
}


def besa_supports_tour(besa: Dict[str, Any], tour_id: Optional[str]) -> bool:
    if not tour_id:
        return True
    supported = besa.get("supportedTourIds") or []
    if not supported:
        return True
    return tour_id in supported


def _normalize_office_hours_day(hours: Any) -> Dict[str, Any]:
    if isinstance(hours, dict) and "start" in hours and "end" in hours:
        return {
            "available": True,
            "timeSlots": [{"start": hours.get("start", "09:00"), "end": hours.get("end", "17:00")}],
        }
    if isinstance(hours, dict) and "available" in hours and "timeSlots" in hours:
        return {
            "available": bool(hours.get("available")),
            "timeSlots": hours.get("timeSlots") or [],
        }
    return {"available": False, "timeSlots": []}


def is_besa_available(
    besa: Dict[str, Any], booking_date: str, booking_time_label: str, duration_minutes: int = 0
) -> bool:
    if not booking_date or not booking_time_label:
        return False
    d = parse_date(booking_date)
    day_key = DAY_INDEX_TO_KEY[d.weekday()]
    raw_office_hours = besa.get("officeHours") or {}
    day_hours = _normalize_office_hours_day(raw_office_hours.get(day_key))
    if not day_hours["available"] or not day_hours["timeSlots"]:
        return False

    booking_time_24 = parse_time_12h(booking_time_label)
    if not booking_time_24:
        return False
    booking_start = to_minutes(booking_time_24)
    booking_end = booking_start + duration_minutes

    for slot in day_hours["timeSlots"]:
        slot_start = to_minutes(slot["start"])
        slot_end = to_minutes(slot["end"])
        if slot_start <= booking_start and booking_end <= slot_end:
            return True
    return False


def is_date_available(
    date_str: str, tour: Dict[str, Any], all_tours: List[Dict[str, Any]]
) -> Tuple[bool, Optional[str]]:
    if not date_str:
        return False, "Please select a date"

    selected_date = parse_date(date_str)
    today = date_cls.today()
    if selected_date < today:
        return False, "Cannot book past dates"

    globally_blocked = any(
        override.get("appliesToAllTours")
        and override.get("unavailable")
        and is_date_in_range(date_str, override.get("startDate"), override.get("endDate"))
        for t in all_tours
        for override in (t.get("dateSpecificBlockDays") or [])
    )
    if globally_blocked:
        return False, "This date is blocked for all tours (holiday/closure)."

    tour_start = tour.get("startDate")
    tour_end = tour.get("endDate")
    if tour_start and selected_date < parse_date(tour_start):
        return False, f"Tour starts on {tour_start}"
    if tour_end and selected_date > parse_date(tour_end):
        return False, f"Tour ends on {tour_end}"

    day_name = DAYS_OF_WEEK[(selected_date.weekday() + 1) % 7]
    matching_range = get_matching_availability_range(date_str, tour)
    has_range_hours = bool((matching_range or {}).get("weeklyHours", {}).get(day_name))
    has_legacy_hours = bool((tour.get("weeklyHours") or {}).get(day_name))

    if not has_range_hours and not has_legacy_hours:
        return False, "Unable to book on this day. Please select an available date."

    override = find_date_override(date_str, tour)
    if override and override.get("unavailable"):
        return False, "This date is unavailable for bookings."

    return True, None


def has_cross_tour_conflict(
    date_str: str,
    time_label: str,
    duration_mins: int,
    tour_id: str,
    bookings_on_date: List[Dict[str, Any]],
) -> bool:
    candidate_start = minutes_from_label(time_label)
    if candidate_start is None:
        return False
    candidate_end = candidate_start + duration_mins

    for booking in bookings_on_date:
        booking_label = booking.get("startTime") or booking.get("time")
        if not booking_label:
            continue
        booking_start = minutes_from_label(booking_label)
        if booking_start is None:
            continue
        booking_end = minutes_from_label(booking.get("endTime")) or (booking_start + 60)
        overlaps = candidate_start < booking_end and booking_start < candidate_end
        if booking.get("tourId") != tour_id and overlaps:
            return True
    return False


def get_available_times(
    tour: Dict[str, Any],
    date_str: str,
    all_tours: List[Dict[str, Any]],
    bookings_for_tour_on_date: List[Dict[str, Any]],
    bookings_on_date_all_tours: List[Dict[str, Any]],
    besas: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    duration_mins = duration_in_minutes(tour.get("duration", 0), tour.get("durationUnit", "minutes"))
    frequency_mins = duration_in_minutes(tour.get("frequency", 60), tour.get("frequencyUnit", "minutes"))

    override = find_date_override(date_str, tour)
    all_slots: List[str] = []

    if override and override.get("slots"):
        for slot in override["slots"]:
            all_slots.extend(generate_time_slots(slot["start"], slot["end"], duration_mins, frequency_mins))
    else:
        day_name = DAYS_OF_WEEK[parse_date(date_str).isoweekday() % 7]
        matching_range = get_matching_availability_range(date_str, tour)
        weekly = (matching_range or {}).get("weeklyHours", {}).get(day_name) or (tour.get("weeklyHours") or {}).get(day_name)
        if weekly:
            for slot in weekly:
                all_slots.extend(generate_time_slots(slot["start"], slot["end"], duration_mins, frequency_mins))

    blocked_rules = get_blocked_slot_rules(date_str, tour, all_tours)
    min_datetime = datetime.now() + timedelta(hours=24)
    max_bookings = tour.get("maxBookings") or 1

    def booking_count_for(time_label: str) -> int:
        return sum(
            1 for b in bookings_for_tour_on_date
            if (b.get("startTime") or b.get("time")) == time_label
        )

    def has_besa_coverage(time_label: str) -> bool:
        return any(
            b.get("status") == "active"
            and besa_supports_tour(b, tour.get("tourId"))
            and is_besa_available(b, date_str, time_label, duration_mins)
            for b in besas
        )

    def slot_datetime(time_label: str) -> Optional[datetime]:
        t24 = parse_time_12h(time_label)
        if not t24:
            return None
        hh, mm = map(int, t24.split(":"))
        d = parse_date(date_str)
        return datetime(d.year, d.month, d.day, hh, mm)

    results = []
    for time_label in all_slots:
        slot_start = minutes_from_label(time_label)
        if slot_start is None:
            continue
        if is_slot_blocked(slot_start, slot_start + duration_mins, blocked_rules):
            continue
        if not has_besa_coverage(time_label):
            continue
        count = booking_count_for(time_label)
        if count >= max_bookings:
            continue
        dt = slot_datetime(time_label)
        if dt is None or dt < min_datetime:
            continue
        if has_cross_tour_conflict(date_str, time_label, duration_mins, tour.get("tourId"), bookings_on_date_all_tours):
            continue
        results.append({"time": time_label, "remainingSpots": max(0, max_bookings - count)})

    return results


def has_available_time_slots(
    tour: Dict[str, Any],
    date_str: str,
    all_tours: List[Dict[str, Any]],
    bookings_for_tour_on_date: List[Dict[str, Any]],
    bookings_on_date_all_tours: List[Dict[str, Any]],
    besas: List[Dict[str, Any]],
) -> bool:
    globally_blocked = any(
        override.get("appliesToAllTours")
        and override.get("unavailable")
        and is_date_in_range(date_str, override.get("startDate"), override.get("endDate"))
        for t in all_tours
        for override in (t.get("dateSpecificBlockDays") or [])
    )
    if globally_blocked:
        return False
    return len(
        get_available_times(
            tour, date_str, all_tours, bookings_for_tour_on_date, bookings_on_date_all_tours, besas
        )
    ) > 0