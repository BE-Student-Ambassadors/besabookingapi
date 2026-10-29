import random
from typing import Any, Dict, List, Optional

from services.availability_service import besa_supports_tour, is_besa_available


def normalize_role(role: Optional[str]) -> str:
    return (role or "").lower()


def get_auto_assigned_besas(
    besas: List[Dict[str, Any]],
    tour_id: str,
    booking_date: str,
    booking_time_label: str,
    duration_minutes: int = 0,
    assignment_counts: Optional[Dict[str, int]] = None,
) -> List[Dict[str, str]]:
    if not booking_date or not booking_time_label:
        return []

    available = [
        b for b in besas
        if b.get("status") == "active"
        and besa_supports_tour(b, tour_id)
        and is_besa_available(b, booking_date, booking_time_label, duration_minutes)
    ]

    primary = [b for b in available if normalize_role(b.get("role")) in ("besa", "besa lead")]
    on_call = [b for b in available if normalize_role(b.get("role")) == "besa on-call"]

    counts = assignment_counts or {}
    primary = _least_loaded_first(primary, counts)
    on_call = _least_loaded_first(on_call, counts)

    selected = (primary[:2] + on_call[: max(0, 2 - len(primary))])[:2]
    return [{"name": b.get("name", ""), "email": b.get("email", "")} for b in selected]


def besa_key(besa: Any) -> str:
    """Stable identifier for a BESA: email if present, else name."""
    if isinstance(besa, dict):
        return (besa.get("email") or besa.get("name") or "").strip().lower()
    return str(besa or "").strip().lower()


def count_assignments(bookings: List[Dict[str, Any]]) -> Dict[str, int]:
    """How many of the given bookings each BESA is already assigned to."""
    counts: Dict[str, int] = {}
    for booking in bookings:
        for assigned in booking.get("besas") or []:
            key = besa_key(assigned)
            if key:
                counts[key] = counts.get(key, 0) + 1
    return counts


def _least_loaded_first(besas: List[Dict[str, Any]], counts: Dict[str, int]) -> List[Dict[str, Any]]:
    """Fewest existing assignments first; ties are broken randomly."""
    shuffled = list(besas)
    random.shuffle(shuffled)  # sorted() is stable, so the shuffle randomizes ties
    return sorted(shuffled, key=lambda b: counts.get(besa_key(b), 0))
