from __future__ import annotations

from datetime import datetime
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

    # Spouse / partner — populated when client_type == "couple"
    spouse_name: Optional[str] = None
    spouse_age: Optional[int] = None
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
    persona: ClientPersona


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

    model_config = {"from_attributes": True}


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
    score: float  # 1-10
    feedback: str


class SessionAnalysis(BaseModel):
    overall_score: float
    categories: dict[str, AnalysisScore]
    strengths: list[str]
    areas_for_improvement: list[str]
    compliance_flags: list[str]
    transcript_summary: str
    recommendations: list[str]
    script_adherence: Optional[AnalysisScore] = None
    slide_walkthrough: Optional[AnalysisScore] = None
