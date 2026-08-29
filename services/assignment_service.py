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

    selected = (primary[:2] + on_call[: max(0, 2 - len(primary))])[:2]
    return [{"name": b.get("name", ""), "email": b.get("email", "")} for b in selected]