from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from firebase_admin import firestore
from google.cloud.firestore_v1 import Client as FirestoreClient
from google.cloud.firestore_v1.transaction import Transaction


class BookingConflictError(Exception):
    pass


def get_tour(db: FirestoreClient, tour_id: str) -> Optional[Dict[str, Any]]:
    snap = db.collection("Tours").document(tour_id).get()
    if not snap.exists:
        return None
    data = snap.to_dict() or {}
    data["tourId"] = snap.id
    return data


def get_all_tours(db: FirestoreClient) -> List[Dict[str, Any]]:
    docs = db.collection("Tours").stream()
    out = []
    for d in docs:
        data = d.to_dict() or {}
        data["tourId"] = d.id
        out.append(data)
    return out


def get_active_besas(db: FirestoreClient) -> List[Dict[str, Any]]:
    docs = db.collection("Besas").stream()
    out = []
    for d in docs:
        data = d.to_dict() or {}
        data["id"] = d.id
        out.append(data)
    return out


def get_bookings_for_tour(
    db: FirestoreClient, tour_id: str, date: Optional[str] = None
) -> List[Dict[str, Any]]:
    query = db.collection("Bookings").where("tourId", "==", tour_id)
    if date:
        query = query.where("date", "==", date)
    docs = query.stream()
    out = []
    for d in docs:
        data = d.to_dict() or {}
        data["bookingId"] = d.id
        out.append(data)
    return out


def get_bookings_for_date_range(
    db: FirestoreClient, start_date: str, end_date: str
) -> List[Dict[str, Any]]:
    docs = (
        db.collection("Bookings")
        .where("date", ">=", start_date)
        .where("date", "<=", end_date)
        .stream()
    )
    out = []
    for d in docs:
        data = d.to_dict() or {}
        data["bookingId"] = d.id
        out.append(data)
    return out


def create_booking_transactional(
    db: FirestoreClient,
    booking_payload: Dict[str, Any],
    max_bookings_for_slot: int,
) -> Dict[str, str]:
    bookings_ref = db.collection("Bookings")
    new_doc_ref = bookings_ref.document()
    booking_id = new_doc_ref.id
    created_at = datetime.now(timezone.utc).isoformat()

    tour_id = booking_payload["tourId"]
    date = booking_payload["date"]
    time_label = booking_payload["startTime"]

    transaction: Transaction = db.transaction()

    @firestore.transactional
    def _run(transaction: Transaction):
        existing = (
            bookings_ref.where("tourId", "==", tour_id)
            .where("date", "==", date)
            .where("startTime", "==", time_label)
            .get(transaction=transaction)
        )
        if len(existing) >= max_bookings_for_slot:
            raise BookingConflictError(
                "This time slot was just filled by another booking."
            )

        payload = dict(booking_payload)
        payload["bookingId"] = booking_id
        payload["createdAt"] = created_at
        transaction.set(new_doc_ref, payload)

    _run(transaction)
    return {"bookingId": booking_id, "createdAt": created_at}


def update_booking(db: FirestoreClient, booking_id: str, values: Dict[str, Any]) -> None:
    db.collection("Bookings").document(booking_id).set(values, merge=True)