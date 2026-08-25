from typing import List, Optional
from pydantic import BaseModel, EmailStr, Field, field_validator


class TimeSlotOption(BaseModel):
    time: str
    remainingSpots: int


class AvailabilityResponse(BaseModel):
    tourId: str
    date: Optional[str] = None
    available: bool
    reason: Optional[str] = None
    times: List[TimeSlotOption] = Field(default_factory=list)
    dates: Optional[dict] = None
    minDate: Optional[str] = None
    maxDate: Optional[str] = None


class BookingCreateRequest(BaseModel):
    tourId: str
    date: str
    startTime: str

    firstName: str
    lastName: str
    email: EmailStr
    phone: str
    organization: str
    role: str

    maxAttendees: int = 1
    interests: List[str] = Field(default_factory=list)
    accommodations: Optional[str] = ""
    largeTourDetails: Optional[str] = ""
    notes: Optional[str] = ""

    @field_validator("maxAttendees")
    @classmethod
    def attendees_at_least_one(cls, v: int) -> int:
        if v < 1:
            raise ValueError("maxAttendees must be at least 1")
        return v

    @field_validator("phone")
    @classmethod
    def phone_has_digits(cls, v: str) -> str:
        digits = "".join(ch for ch in v if ch.isdigit())
        if len(digits) < 10:
            raise ValueError("phone must contain at least 10 digits")
        return v


class BookingResponse(BaseModel):
    bookingId: str
    tourId: str
    tourType: str
    date: str
    startTime: str
    endTime: str
    startTimeISO: str
    endTimeISO: str
    maxAttendees: int
    firstName: str
    lastName: str
    email: str
    phone: str
    organization: str
    role: str
    interests: List[str]
    accommodations: Optional[str] = ""
    largeTourDetails: Optional[str] = ""
    location: Optional[str] = ""
    besas: List[dict] = Field(default_factory=list)
    calendarEventId: Optional[str] = None
    createdAt: str