from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from pydantic import BaseModel, EmailStr, Field, field_validator


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    email: str
    password: str


class UserPublic(BaseModel):
    id: str
    email: str
    name: str
    role: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserPublic


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

class UserCreate(BaseModel):
    email: str
    name: str
    password: str
    role: str = "advisor"


class UserUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    is_active: Optional[bool] = None
    password: Optional[str] = None  # if set, replaces the hashed password


class UserWithSessionCount(UserPublic):
    session_count: int = 0


class AdvisorWithStats(UserPublic):
    total_sessions: int = 0
    avg_score: Optional[float] = None
    sessions_this_month: int = 0


# ---------------------------------------------------------------------------
# Client Persona
# ---------------------------------------------------------------------------

def _ensure_list(v):
    """Coerce a string or list-of-strings into a non-empty list[str]."""
    if v is None:
        return []
    if isinstance(v, str):
        return [v] if v else []
    if isinstance(v, list):
        return [str(x) for x in v if x]
    return [str(v)]


class ClientPersona(BaseModel):
    # Client composition
    client_type: str = "individual"  # individual / couple

    # Primary person
    name: str
    age: int
    age_group: str  # young_adult / middle_aged / senior / elderly
    gender: str  # male / female
    marital_status: str  # single / married / divorced / widowed / domestic_partner
    has_children: bool
    num_children: int  # 0-5

    # Employment — now a list to support multiple roles
    employment_types: list[str] = Field(default_factory=list)
    occupation: str

    # Financial profile
    financial_situation: str
    estimated_net_worth: str
    estimated_income: str
    has_debt: str
    risk_tolerance: str
    investment_experience: str

    # Concerns — now a list of multiple concerns
    primary_concerns: list[str] = Field(default_factory=list)
    secondary_concern: Optional[str] = None

    # Personality
    personality_type: str
    communication_style: str
    previous_advisor: bool
    previous_advisor_experience: str = "none"
    urgency: str
    referral_source: str
    backstory: str

    # Visual identity — stamped deterministically per profile so the
    # assignment table, the start-session preview, and the live session
    # all show the same face. See sessions_router._deterministic_image_url.
    client_image_url: Optional[str] = None

    # Spouse / partner — populated when client_type == "couple"
    spouse_name: Optional[str] = None
    spouse_age: Optional[int] = None
    spouse_age_group: Optional[str] = None  # young_adult / middle_aged / senior / elderly
    spouse_gender: Optional[str] = None
    spouse_occupation: Optional[str] = None
    spouse_employment_types: list[str] = Field(default_factory=list)
    spouse_personality_type: Optional[str] = None
    spouse_image_url: Optional[str] = None

    # Backward-compat normalizers — accept old single-string values too
    @field_validator("employment_types", "primary_concerns", "spouse_employment_types", mode="before")
    @classmethod
    def _normalize_list_fields(cls, v):
        return _ensure_list(v)


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

class SessionCreate(BaseModel):
    """Body for POST /api/sessions.

    Two flavors:
      • Self-initiated — advisor provides a persona; assignment_id is omitted.
      • Assigned — advisor provides assignment_id; persona is loaded server-side
        from the profile and any persona in the payload is ignored.
    """
    persona: Optional[ClientPersona] = None
    assignment_id: Optional[str] = None
    # When False (default), the simulated client stays silent — a one-sided
    # deck-walkthrough practice. When True, the client engages interactively.
    engage_client: bool = False


class ConversationMessage(BaseModel):
    role: str  # client / advisor
    text: str
    timestamp: str


class SessionPublic(BaseModel):
    id: str
    advisor_id: str
    advisor_name: Optional[str] = None
    client_name: str
    client_image_url: Optional[str]
    status: str
    started_at: datetime
    ended_at: Optional[datetime]
    persona: ClientPersona
    overall_score: Optional[float] = None
    # Scale of overall_score: 5 for new scorecard-shape analyses, 10 for legacy
    # 7-category analyses. Lets the UI color/scale the score correctly.
    score_scale: int = 10
    source: str = "self_initiated"
    assignment_id: Optional[str] = None
    profile_name: Optional[str] = None  # populated when source == "assigned"
    engage_client: bool = False

    model_config = {"from_attributes": True}


class SessionDetail(BaseModel):
    id: str
    advisor_id: str
    client_name: str
    client_image_url: Optional[str]
    status: str
    persona: ClientPersona
    conversation: list[ConversationMessage]
    recording_path: Optional[str]
    analysis: Optional[dict]
    started_at: datetime
    ended_at: Optional[datetime]
    source: str = "self_initiated"
    assignment_id: Optional[str] = None
    profile_name: Optional[str] = None
    engage_client: bool = False

    model_config = {"from_attributes": True}


class WSMessage(BaseModel):
    type: str  # advisor_message / end_session
    text: Optional[str] = None


# ---------------------------------------------------------------------------
# Questionnaire
# ---------------------------------------------------------------------------

class QuestionnaireContent(BaseModel):
    version: str
    title: str
    description: str
    categories: list[dict]


class QuestionnairePublic(BaseModel):
    id: str
    version: int
    content: dict
    created_at: datetime
    is_active: bool

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Presentation (PPT)
# ---------------------------------------------------------------------------

class PresentationPublic(BaseModel):
    id: str
    version: int
    title: str
    slide_count: int
    is_active: bool
    uploaded_by: Optional[str] = None
    created_at: datetime
    # Attached PDF script (optional). has_script lets the UI show a badge
    # without exposing the full extracted text.
    has_script: bool = False
    script_filename: Optional[str] = None
    # Appointment-type deck slot + its human label.
    slot: str = "first"
    slot_label: Optional[str] = None

    model_config = {"from_attributes": True}

    @classmethod
    def from_model(cls, p) -> "PresentationPublic":
        from app.services.deck_slots import SLOT_LABELS
        slot = getattr(p, "slot", None) or "first"
        return cls(
            id=p.id,
            version=p.version,
            title=p.title,
            slide_count=p.slide_count,
            is_active=p.is_active,
            uploaded_by=p.uploaded_by,
            created_at=p.created_at,
            has_script=bool(getattr(p, "script_pdf_path", None)),
            script_filename=getattr(p, "script_filename", None),
            slot=slot,
            slot_label=SLOT_LABELS.get(slot, slot),
        )


# ---------------------------------------------------------------------------
# Training script
# ---------------------------------------------------------------------------

class ScriptCreate(BaseModel):
    title: str
    content: str  # markdown


class ScriptPublic(BaseModel):
    id: str
    version: int
    title: str
    content: str
    is_active: bool
    uploaded_by: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

class AnalysisScore(BaseModel):
    score: float  # 1-10  (legacy shape — kept for backward-compat with old sessions)
    feedback: str


class ScorecardItemResult(BaseModel):
    """One item on a Trajan Wealth scorecard, scored 1–5 (matches the
    printed scorecards). `applicable=False` means the item was N/A for
    this session (e.g., Income Rider on a protected-growth-only annuity)."""
    key: str
    label: str
    kind: str  # "script" | "behavioral"
    applicable: bool = True
    score: Optional[float] = None  # 1–5 when applicable
    feedback: str


class ScorecardResult(BaseModel):
    """A complete scorecard for one appointment type. 3rd appointments
    return two — one for Annuity, one for Alternatives."""
    type: str  # "first_meeting" | "aum" | "annuity" | "alternatives"
    title: str
    items: list[ScorecardItemResult]
    summary_score: Optional[float] = None  # mean of applicable item scores


class SessionAnalysis(BaseModel):
    overall_score: float  # 1–5 in the new shape, 1–10 in legacy sessions
    # NEW shape — one or two scorecards per session, replacing the old
    # 7-category dict. Legacy sessions don't have this field.
    scorecards: Optional[list[ScorecardResult]] = None
    # LEGACY — kept Optional so old sessions still deserialize.
    categories: Optional[dict[str, AnalysisScore]] = None
    strengths: list[str]
    areas_for_improvement: list[str]
    compliance_flags: list[str]
    transcript_summary: str
    recommendations: list[str]
    # Legacy standalone fields — new analyzer puts these inside the scorecard
    # items, but old sessions keep them at the top level.
    script_adherence: Optional[AnalysisScore] = None
    slide_walkthrough: Optional[AnalysisScore] = None


# ---------------------------------------------------------------------------
# Session profiles (reusable persona templates)
# ---------------------------------------------------------------------------

class SessionProfileCreate(BaseModel):
    name: str
    description: Optional[str] = None
    persona: ClientPersona


class SessionProfileUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    persona: Optional[ClientPersona] = None
    is_active: Optional[bool] = None


class SessionProfilePublic(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    persona: ClientPersona
    created_by: Optional[str] = None
    is_active: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Session assignments (admin → advisor)
# ---------------------------------------------------------------------------

class AssignmentCreate(BaseModel):
    """Admin assigns a profile to one or more advisors. Server fans out one
    SessionAssignment row per advisor_id."""
    profile_id: str
    advisor_ids: list[str] = Field(min_length=1)
    assigned_date: date
    target_date: date


class AssignmentUpdate(BaseModel):
    assigned_date: Optional[date] = None
    target_date: Optional[date] = None
    status: Optional[str] = None  # pending | in_progress | completed | cancelled


class AssignmentPublic(BaseModel):
    id: str
    profile_id: str
    profile_name: str
    profile_description: Optional[str] = None
    persona: ClientPersona
    advisor_id: str
    advisor_name: Optional[str] = None
    assigned_by: Optional[str] = None
    assigned_by_name: Optional[str] = None
    assigned_date: date
    target_date: date
    status: str
    created_at: datetime
    session_id: Optional[str] = None  # most recent linked session, if any

    model_config = {"from_attributes": True}


class MyAssignmentsResponse(BaseModel):
    """Advisor-facing grouping for the dashboard."""
    today: list[AssignmentPublic]
    upcoming: list[AssignmentPublic]
    past: list[AssignmentPublic]
