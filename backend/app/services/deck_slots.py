"""Shared constants + mapping for appointment-type deck slots."""
from __future__ import annotations

# Deck slots (one active presentation per slot)
SLOT_FIRST = "first"
SLOT_SECOND = "second"
SLOT_THIRD_ANNUITY = "third_annuity"
SLOT_THIRD_PE = "third_private_equity"

ALL_SLOTS = [SLOT_FIRST, SLOT_SECOND, SLOT_THIRD_ANNUITY, SLOT_THIRD_PE]

SLOT_LABELS = {
    SLOT_FIRST: "First Appointment",
    SLOT_SECOND: "Second Appointment",
    SLOT_THIRD_ANNUITY: "Annuity",
    SLOT_THIRD_PE: "Private Equity",
}

# Appointment types (carried by profiles + sessions)
APPT_FIRST = "first"
APPT_SECOND = "second"
APPT_THIRD = "third"
ALL_APPT_TYPES = [APPT_FIRST, APPT_SECOND, APPT_THIRD]

# Which deck slot(s) an appointment type maps to, in display order.
APPT_TO_SLOTS = {
    APPT_FIRST: [SLOT_FIRST],
    APPT_SECOND: [SLOT_SECOND],
    APPT_THIRD: [SLOT_THIRD_ANNUITY, SLOT_THIRD_PE],
}

# Fallback slot for sessions with no appointment type (self-initiated, etc.)
FALLBACK_SLOTS = [SLOT_FIRST]


def slots_for_appointment(appointment_type: str | None) -> list[str]:
    if appointment_type in APPT_TO_SLOTS:
        return APPT_TO_SLOTS[appointment_type]
    return FALLBACK_SLOTS
