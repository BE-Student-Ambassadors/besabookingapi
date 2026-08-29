from datetime import datetime
from zoneinfo import ZoneInfo


PACIFIC_TZ = ZoneInfo("America/Los_Angeles")

FALLBACK_TOUR_CONFIG = {
    "location": "Baskin Engineering Courtyard, 606 Engineering Loop, Santa Cruz, CA 95064",
}

LEGACY_DEFAULT_INVITE_DESCRIPTION = (
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
)

TOUR_TYPE_CONFIGS = {
    "baskin engineering in-person tour": FALLBACK_TOUR_CONFIG,
    "baskin engineering virtual tour": {
        "location": "Zoom",
    },
    "baskin engineering transfer tour": {
        "location": "Baskin Engineering Courtyard, 606 Engineering Loop, Santa Cruz, CA 95064",
    },
}


def parse_pacific_datetime(date_str, time_label):
    time_text = time_label.strip()
    parsed = datetime.strptime(time_text, "%I:%M %p")
    year, month, day = map(int, date_str.split("-"))
    return datetime(
        year,
        month,
        day,
        parsed.hour,
        parsed.minute,
        0,
        tzinfo=PACIFIC_TZ,
    )


def parse_booking_datetime(data, iso_key, date_key, time_key):
    date_str = data.get(date_key)
    time_label = data.get(time_key)
    if date_str and time_label:
        return parse_pacific_datetime(date_str, time_label)

    iso_value = data.get(iso_key)
    if not iso_value:
        raise KeyError(iso_key)

    parsed = datetime.fromisoformat(iso_value)
    return datetime(
        parsed.year,
        parsed.month,
        parsed.day,
        parsed.hour,
        parsed.minute,
        parsed.second,
        parsed.microsecond,
        tzinfo=PACIFIC_TZ,
    )


def resolve_tour_invite_config(data):
    normalized_tour_type = (data.get("tourType") or "").strip().lower()
    return TOUR_TYPE_CONFIGS.get(normalized_tour_type, FALLBACK_TOUR_CONFIG)


def createEvent(data, calendar_service):
    if not calendar_service:
        return None

    start_dt = parse_booking_datetime(data, "startTimeISO", "date", "startTime")
    end_dt = parse_booking_datetime(data, "endTimeISO", "date", "endTime")

    attendees = [
        {
            "email": data["email"],
            "displayName": f"{data.get('firstName', '')} {data.get('lastName', '')}".strip(),
        }
    ]

    for besa in data.get("besas", []):
        if isinstance(besa, dict):
            email = besa.get("email")
            if email:
                attendees.append(
                    {
                        "email": email,
                        "displayName": besa.get("name", ""),
                    }
                )
        elif isinstance(besa, str) and besa:
            attendees.append(
                {
                    "email": besa,
                    "displayName": "",
                }
            )

    tour_config = resolve_tour_invite_config(data)

    event = {
        "summary": data.get("tourType", "Baskin Engineering In-Person Tour"),
        "location": data.get(
            "calendarInviteLocation",
            data.get("location", tour_config["location"]),
        ),
        "description": data.get(
            "calendarInviteDetails",
            data.get(
            "inviteDetails",
            data.get("description", LEGACY_DEFAULT_INVITE_DESCRIPTION),
            ),
        ),
        "start": {
            "dateTime": start_dt.isoformat(),
            "timeZone": "America/Los_Angeles",
        },
        "end": {
            "dateTime": end_dt.isoformat(),
            "timeZone": "America/Los_Angeles",
        },
        "attendees": attendees,
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
