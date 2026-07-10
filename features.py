from datetime import datetime


def createEvent(data, calendar_service):
    if not calendar_service:
        return None

    start_dt = datetime.fromisoformat(data["startTimeISO"])
    end_dt = datetime.fromisoformat(data["endTimeISO"])

    event = {
        "summary": data.get("tourType", "Baskin Engineering In-Person Tour"),
        "location": data.get(
            "location",
            "Baskin Engineering Courtyard, 606 Engineering Loop, Santa Cruz, CA 95064",
        ),
        "description": (
            "Thank you for booking a Baskin Engineering Tour. We are excited to have you join us!\n\n"
            "Tour Details:\n"
            "• Location: Baskin Engineering Courtyard, the brick road area between the two buildings in Baskin.\n"
            "  This is down the stairs from the Engineering Loop.\n"
            "• Who to Meet: A Baskin Engineering Tour Guide wearing a name tag.\n\n"
            "Important Information:\n"
            "• Tour Times: All tours are scheduled in Pacific Time (PT). Your calendar may convert this "
            "to your local time zone automatically.\n"
            "• No Double Booking: This is a small tour (1–3 families). Please avoid double booking.\n\n"
            "Questions?\n"
            "Email us at ucscbesa@ucsc.edu\n\n"
            "We look forward to seeing you!\n\n"
            "— Baskin Engineering Student Ambassadors"
        ),
        "start": {
            "dateTime": start_dt.isoformat(),
            "timeZone": "America/Los_Angeles",
        },
        "end": {
            "dateTime": end_dt.isoformat(),
            "timeZone": "America/Los_Angeles",
        },
        "attendees": [
            {
                "email": data["email"],
                "displayName": f"{data.get('firstName', '')} {data.get('lastName', '')}".strip(),
            },
            *[
                {
                    "email": besa["email"],
                    "displayName": besa["name"],
                }
                for besa in data.get("besas", [])
            ],
        ],
        "transparency": "opaque",
        "visibility": "default",
        "reminders": {"useDefault": True},
        "extendedProperties": {
            "private": {
                "bookingId": data.get("bookingId", data.get("id", "")),
            }
        },
    }

    return event


def assignBESA():
    pass


def modifyBooking():
    pass
