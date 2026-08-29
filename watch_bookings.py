from threading import Event

from calendar_sync import delete_booking_record, get_calendar_service, get_db, sync_booking_record


def watch_bookings():
    db = get_db()
    calendar_service = get_calendar_service()
    stop_event = Event()

    def on_snapshot(col_snapshot, changes, read_time):
        del col_snapshot, read_time

        for change in changes:
            document = change.document
            booking_data = document.to_dict() or {}
            booking_data["bookingId"] = document.id

            try:
                if change.type.name == "REMOVED":
                    result = delete_booking_record(db, calendar_service, booking_data)
                else:
                    result = sync_booking_record(db, calendar_service, booking_data)
                print(result)
            except Exception as err:
                print(
                    {
                        "status": "error",
                        "bookingId": document.id,
                        "changeType": change.type.name,
                        "error": str(err),
                    }
                )

    query_watch = db.collection("Bookings").on_snapshot(on_snapshot)
    print("Watching Firestore Bookings collection for calendar sync changes...")

    try:
        stop_event.wait()
    except KeyboardInterrupt:
        print("Stopping Firestore watcher...")
    finally:
        query_watch.unsubscribe()


if __name__ == "__main__":
    watch_bookings()
