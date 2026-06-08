"""Pre-built onboarding curriculum for advisors.

20 client personas (8 easy, 8 medium, 4 difficult), each met across three
appointments (1st AUM, 2nd AUM, 3rd Annuity/PE) — 60 reusable SessionProfiles.
A newly created advisor is auto-assigned all 60 across the next 15 weekdays
(4/day, weekends skipped), following this grid:

  Days 1-2  : 1st appts, easy   (E1-E4, then E5-E8)
  Days 3-4  : 2nd appts, easy   (same)
  Days 5-6  : 3rd appts, easy   (same)
  Days 7-8  : 1st appts, medium (M1-M4, then M5-M8)
  Days 9-10 : 2nd appts, medium (same)
  Days 11-12: 3rd appts, medium (same)
  Day 13    : 1st appts, hard   (D1-D4)
  Day 14    : 2nd appts, hard   (same)
  Day 15    : 3rd appts, hard   (same)

Profiles use deterministic UUID5 ids so re-running is idempotent.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SessionAssignment, SessionProfile
from app.schemas import ClientPersona

logger = logging.getLogger("trajan.curriculum")

_NS = uuid.uuid5(uuid.NAMESPACE_DNS, "trajan-advisor.curriculum")

NET_WORTH_MAP = {
    "struggling": "$0 – $50,000",
    "stable": "$50,000 – $250,000",
    "comfortable": "$250,000 – $1M",
    "affluent": "$1M – $5M",
    "wealthy": "$5M – $25M",
    "ultra_wealthy": "$25M+",
}
INCOME_MAP = {
    "struggling": "$0 – $40,000",
    "stable": "$40,000 – $80,000",
    "comfortable": "$80,000 – $200,000",
    "affluent": "$200,000 – $500,000",
    "wealthy": "$500,000 – $2M",
    "ultra_wealthy": "$2M+",
}
AGE_BY_GROUP = {"young_adult": 30, "middle_aged": 45, "senior": 63, "elderly": 76}
OCCUPATION_BY_EMPLOYMENT = {
    "employed": "Professional",
    "executive": "Executive",
    "retired": "Retired",
    "business_owner": "Business Owner",
    "self_employed": "Self-Employed Consultant",
    "part_time": "Part-Time Worker",
    "unemployed": "Between Jobs",
}

# Appointment stage context. Persona identity stays identical across stages;
# only this framing is appended so the simulated client behaves stage-aware.
STAGE_META = {
    1: (
        "1st AUM Appointment",
        "First AUM appointment — the advisor is meeting this client for the first "
        "time to build rapport, understand goals, and gather their financial picture.",
        " This is your FIRST meeting with this advisor; you have not shared your "
        "detailed financials yet and are still forming an impression of them.",
    ),
    2: (
        "2nd AUM Appointment",
        "Second AUM appointment — the advisor presents a proposed allocation and "
        "addresses objections, moving toward funding the account.",
        " This is your SECOND meeting; you already had an intro session and shared "
        "your basic situation. You expect the advisor to present a concrete plan.",
    ),
    3: (
        "3rd Appointment · Annuity & Private Equity",
        "Third appointment — the advisor introduces annuity and private-equity "
        "options suited to the client's profile.",
        " This is your THIRD meeting; your AUM account is established and you are "
        "now hearing about annuity and private-equity options.",
    ),
}

DIFFICULTY_LABEL = {"easy": "Easy", "medium": "Medium", "hard": "Difficult"}


# ---------------------------------------------------------------------------
# 20 persona definitions
# ---------------------------------------------------------------------------
# Each entry is the differentiating data; the builder fills the rest.
_PERSONAS: list[dict] = [
    # ---- EASY (trusting / confident / agreeable, low urgency) ----
    dict(key="easy-01", difficulty="easy", name="Margaret Chen", gender="female",
         age_group="senior", marital_status="widowed", children=2, employment="retired",
         financial="comfortable", debt="none", risk="conservative", experience="beginner",
         concerns=["Retirement Planning", "Income Generation"], personality="trusting",
         comms="chatty", prev="good", urgency="low", referral="Existing Client Referral",
         story="Margaret is a retired schoolteacher who recently lost her husband and is "
               "managing the household finances on her own for the first time."),
    dict(key="easy-02", difficulty="easy", name="David Thompson", gender="male",
         age_group="middle_aged", marital_status="married", children=2, employment="employed",
         financial="comfortable", debt="manageable", risk="moderate", experience="beginner",
         concerns=["Retirement Planning", "College Funding"], personality="confident",
         comms="direct", prev="none", urgency="low", referral="Friend/Family",
         story="David is a mid-career engineer with two teenagers, focused on balancing "
               "college savings with his own retirement."),
    dict(key="easy-03", difficulty="easy", name="Aisha Patel", gender="female",
         age_group="young_adult", marital_status="single", children=0, employment="employed",
         financial="stable", debt="manageable", risk="moderate", experience="beginner",
         concerns=["Wealth Growth", "Retirement Planning"], personality="trusting",
         comms="chatty", prev="none", urgency="low", referral="Online Search",
         story="Aisha is an early-career marketing manager starting to invest seriously "
               "and eager to learn."),
    dict(key="easy-04", difficulty="easy", name="Robert Williams", gender="male",
         age_group="senior", marital_status="married", children=3, employment="retired",
         financial="affluent", debt="none", risk="conservative", experience="intermediate",
         concerns=["Estate Planning", "Retirement Planning"], personality="confident",
         comms="direct", prev="good", urgency="low", referral="Existing Client Referral",
         story="Robert is a comfortably retired former sales director who wants to "
               "organize his estate for his children and grandchildren."),
    dict(key="easy-05", difficulty="easy", name="Linda Garcia", gender="female",
         age_group="middle_aged", marital_status="divorced", children=1, employment="employed",
         financial="stable", debt="manageable", risk="moderate", experience="beginner",
         concerns=["Retirement Planning", "Debt Reduction"], personality="trusting",
         comms="chatty", prev="none", urgency="low", referral="Seminar",
         story="Linda recently divorced and is rebuilding her financial independence "
               "while raising her young son."),
    dict(key="easy-06", difficulty="easy", name="James Kim", gender="male",
         age_group="middle_aged", marital_status="married", children=2, employment="business_owner",
         financial="affluent", debt="manageable", risk="moderate", experience="intermediate",
         concerns=["Wealth Growth", "Tax Optimization"], personality="confident",
         comms="direct", prev="good", urgency="low", referral="Friend/Family",
         story="James owns a small but thriving restaurant group and wants to put his "
               "growing profits to work."),
    dict(key="easy-07", difficulty="easy", name="Patricia Johnson", gender="female",
         age_group="senior", marital_status="widowed", children=2, employment="retired",
         financial="comfortable", debt="none", risk="very_conservative", experience="beginner",
         concerns=["Income Generation", "Estate Planning"], personality="trusting",
         comms="formal", prev="good", urgency="low", referral="Existing Client Referral",
         story="Patricia is a retired nurse living on a fixed income who wants dependable "
               "monthly cash flow and a simple estate plan."),
    dict(key="easy-08", difficulty="easy", name="Carlos Rivera", gender="male",
         age_group="young_adult", marital_status="domestic_partner", children=0, employment="employed",
         financial="stable", debt="manageable", risk="aggressive", experience="beginner",
         concerns=["Wealth Growth", "Retirement Planning"], personality="confident",
         comms="chatty", prev="none", urgency="low", referral="Online Search",
         story="Carlos is a software developer who just bought a home with his partner "
               "and is ready to start building long-term wealth."),

    # ---- MEDIUM (analytical / skeptical / detail-oriented, medium urgency) ----
    dict(key="med-01", difficulty="medium", name="Steven Brooks", gender="male",
         age_group="middle_aged", marital_status="married", children=2, employment="executive",
         financial="wealthy", debt="none", risk="moderate", experience="experienced",
         concerns=["Tax Optimization", "Estate Planning"], personality="analytical",
         comms="formal", prev="mixed", urgency="medium", referral="Friend/Family",
         story="Steven is a corporate VP who reads the fine print and expects data to "
               "back up every recommendation."),
    dict(key="med-02", difficulty="medium", name="Mei Lin", gender="female",
         age_group="middle_aged", marital_status="single", children=0, employment="self_employed",
         financial="affluent", debt="none", risk="moderate", experience="intermediate",
         concerns=["Wealth Growth", "Tax Optimization"], personality="skeptical",
         comms="reserved", prev="mixed", urgency="medium", referral="Online Search",
         story="Mei is a self-employed consultant who has been burned by vague advice "
               "before and asks pointed questions."),
    dict(key="med-03", difficulty="medium", name="Daniel O'Connor", gender="male",
         age_group="senior", marital_status="married", children=3, employment="retired",
         financial="affluent", debt="none", risk="conservative", experience="experienced",
         concerns=["Estate Planning", "Income Generation"], personality="detail_oriented",
         comms="formal", prev="good", urgency="medium", referral="Existing Client Referral",
         story="Daniel is a retired accountant who tracks every basis point and wants "
               "a meticulous plan for his estate."),
    dict(key="med-04", difficulty="medium", name="Fatima Hassan", gender="female",
         age_group="middle_aged", marital_status="married", children=2, employment="executive",
         financial="wealthy", debt="manageable", risk="aggressive", experience="experienced",
         concerns=["Wealth Growth", "College Funding"], personality="analytical",
         comms="direct", prev="mixed", urgency="medium", referral="Seminar",
         story="Fatima is a tech executive juggling equity comp and college costs who "
               "wants a clear, optimized strategy."),
    dict(key="med-05", difficulty="medium", name="Gregory Pierce", gender="male",
         age_group="middle_aged", marital_status="divorced", children=1, employment="business_owner",
         financial="affluent", debt="significant", risk="moderate", experience="intermediate",
         concerns=["Business Succession", "Tax Optimization"], personality="skeptical",
         comms="reserved", prev="bad", urgency="medium", referral="Cold Outreach",
         story="Gregory owns a contracting firm, carries business debt, and is wary after "
               "a prior advisor over-promised returns."),
    dict(key="med-06", difficulty="medium", name="Sofia Martinez", gender="female",
         age_group="young_adult", marital_status="single", children=0, employment="self_employed",
         financial="stable", debt="manageable", risk="aggressive", experience="intermediate",
         concerns=["Wealth Growth", "Debt Reduction"], personality="analytical",
         comms="direct", prev="none", urgency="medium", referral="Online Search",
         story="Sofia is a freelance designer with irregular income who wants to grow "
               "wealth while paying down student loans."),
    dict(key="med-07", difficulty="medium", name="Richard Tanaka", gender="male",
         age_group="senior", marital_status="widowed", children=2, employment="retired",
         financial="wealthy", debt="none", risk="conservative", experience="experienced",
         concerns=["Estate Planning", "Charitable Giving"], personality="detail_oriented",
         comms="formal", prev="mixed", urgency="medium", referral="Existing Client Referral",
         story="Richard is a widowed retiree with significant assets who wants a careful "
               "legacy and charitable-giving plan."),
    dict(key="med-08", difficulty="medium", name="Angela Davis", gender="female",
         age_group="middle_aged", marital_status="married", children=3, employment="executive",
         financial="affluent", debt="manageable", risk="moderate", experience="intermediate",
         concerns=["Retirement Planning", "Tax Optimization"], personality="skeptical",
         comms="reserved", prev="mixed", urgency="medium", referral="Friend/Family",
         story="Angela is a hospital administrator who is cautious with new advisors and "
               "wants proof before committing."),

    # ---- DIFFICULT (skeptical / emotional / impulsive, high urgency, bad history) ----
    dict(key="hard-01", difficulty="hard", name="Victor Castellano", gender="male",
         age_group="middle_aged", marital_status="divorced", children=2, employment="business_owner",
         financial="wealthy", debt="significant", risk="aggressive", experience="experienced",
         concerns=["Business Succession", "Tax Optimization"], personality="skeptical",
         comms="direct", prev="bad", urgency="high", referral="Cold Outreach",
         story="Victor built a logistics company from scratch, lost money with a previous "
               "advisor, and now distrusts the industry and challenges every claim."),
    dict(key="hard-02", difficulty="hard", name="Eleanor Whitfield", gender="female",
         age_group="senior", marital_status="widowed", children=1, employment="retired",
         financial="wealthy", debt="none", risk="very_conservative", experience="beginner",
         concerns=["Estate Planning", "Income Generation"], personality="emotional",
         comms="reserved", prev="bad", urgency="high", referral="Existing Client Referral",
         story="Eleanor recently inherited her late husband's portfolio, is anxious about "
               "losing it, and gets emotional when markets are discussed."),
    dict(key="hard-03", difficulty="hard", name="Marcus Bennett", gender="male",
         age_group="middle_aged", marital_status="married", children=3, employment="executive",
         financial="ultra_wealthy", debt="manageable", risk="very_aggressive", experience="expert",
         concerns=["Wealth Growth", "Tax Optimization"], personality="impulsive",
         comms="direct", prev="bad", urgency="high", referral="Seminar",
         story="Marcus is a hard-charging executive who wants outsized returns immediately, "
               "interrupts often, and threatens to walk if he's not impressed."),
    dict(key="hard-04", difficulty="hard", name="Priya Anand", gender="female",
         age_group="middle_aged", marital_status="single", children=0, employment="self_employed",
         financial="affluent", debt="none", risk="moderate", experience="experienced",
         concerns=["Wealth Growth", "Estate Planning"], personality="skeptical",
         comms="formal", prev="bad", urgency="high", referral="Online Search",
         story="Priya is a successful consultant who has been let down by two prior "
               "advisors and demands documented evidence for every recommendation."),

    # ---- Couples (client_type=couple). Index 20-22, appended after the
    # 20 individual personas so the existing day grid is unaffected.
    dict(key="couple-01", difficulty="easy",
         name="Margaret Smith", gender="female", age_group="senior",
         marital_status="married", children=2, employment="retired",
         financial="comfortable", debt="none", risk="conservative", experience="beginner",
         concerns=["Retirement Income", "Healthcare Costs"], personality="anxious",
         comms="reserved", prev="none", urgency="medium", referral="Friend",
         story="Margaret and Tom recently retired and are nervous about whether their savings "
               "will last. Margaret defers to Tom on numbers; Tom is analytical but "
               "uncertain about market volatility.",
         spouse_name="Tom Smith", spouse_gender="male", spouse_age_group="senior",
         spouse_employment="retired", spouse_personality="analytical"),

    dict(key="couple-02", difficulty="medium",
         name="Aaron Patel", gender="male", age_group="middle_aged",
         marital_status="married", children=2, employment="employed",
         financial="affluent", debt="manageable", risk="moderate", experience="intermediate",
         concerns=["College Funding", "Tax Optimization"], personality="detail_oriented",
         comms="direct", prev="none", urgency="medium", referral="Coworker",
         story="Aaron and Priya are dual-income parents juggling 529 plans, RSU vesting, "
               "and an aging parent. They disagree on risk tolerance — Aaron is moderate, "
               "Priya is conservative — and want a neutral planner to mediate.",
         spouse_name="Priya Patel", spouse_gender="female", spouse_age_group="middle_aged",
         spouse_employment="self_employed", spouse_personality="skeptical"),

    dict(key="couple-03", difficulty="hard",
         name="Linda Castellano", gender="female", age_group="senior",
         marital_status="married", children=3, employment="employed",
         financial="ultra_wealthy", debt="none", risk="aggressive", experience="experienced",
         concerns=["Estate Planning", "Business Succession"], personality="confident",
         comms="formal", prev="bad", urgency="high", referral="Attorney",
         story="Linda and Victor own a successful manufacturing business and are evaluating "
               "succession + estate plans. Victor is impulsive and dominates conversations; "
               "Linda is the steady operational mind who actually controls the finances. "
               "They've been burned by a previous advisor's high-fee recommendations.",
         spouse_name="Victor Castellano", spouse_gender="male", spouse_age_group="senior",
         spouse_employment="business_owner", spouse_personality="impulsive"),
]


def _build_persona(spec: dict, stage: int) -> ClientPersona:
    employment = spec["employment"]
    fin = spec["financial"]
    _, _, stage_story = STAGE_META[stage]
    is_couple = "spouse_name" in spec
    spouse_kwargs: dict[str, object] = {}
    if is_couple:
        spouse_emp = spec.get("spouse_employment", employment)
        spouse_age_group = spec.get("spouse_age_group", spec["age_group"])
        spouse_kwargs = {
            # client_type is set on the ClientPersona() call below; don't
            # duplicate it here or we get "multiple values for keyword".
            "spouse_name": spec["spouse_name"],
            "spouse_age": AGE_BY_GROUP[spouse_age_group],
            "spouse_age_group": spouse_age_group,
            "spouse_gender": spec["spouse_gender"],
            "spouse_occupation": OCCUPATION_BY_EMPLOYMENT.get(spouse_emp, "Professional"),
            "spouse_employment_types": [spouse_emp],
            "spouse_personality_type": spec.get("spouse_personality", spec["personality"]),
        }
    return ClientPersona(
        client_type="couple" if is_couple else "individual",
        name=spec["name"],
        age=AGE_BY_GROUP[spec["age_group"]],
        age_group=spec["age_group"],
        gender=spec["gender"],
        marital_status=spec["marital_status"],
        has_children=spec["children"] > 0,
        num_children=spec["children"],
        employment_types=[employment],
        occupation=OCCUPATION_BY_EMPLOYMENT.get(employment, "Professional"),
        financial_situation=fin,
        estimated_net_worth=NET_WORTH_MAP[fin],
        estimated_income=INCOME_MAP[fin],
        has_debt=spec["debt"],
        risk_tolerance=spec["risk"],
        investment_experience=spec["experience"],
        primary_concerns=spec["concerns"],
        secondary_concern=None,
        personality_type=spec["personality"],
        communication_style=spec["comms"],
        previous_advisor=spec["prev"] != "none",
        previous_advisor_experience=spec["prev"],
        urgency=spec["urgency"],
        referral_source=spec["referral"],
        backstory=spec["story"] + stage_story,
        **spouse_kwargs,
    )


def _profile_id(persona_key: str, stage: int) -> str:
    return str(uuid.uuid5(_NS, f"{persona_key}:{stage}"))


def curriculum_profile_ids() -> list[str]:
    return [_profile_id(p["key"], stage) for p in _PERSONAS for stage in (1, 2, 3)]


def _build_grid() -> list[list[tuple[int, int]]]:
    """18 days, each a list of (persona_index, stage).

    Layout:
      • Days 1-6 — easy individuals (8 personas across 2 batches × 3 stages)
      • Days 7-12 — medium individuals (8 personas across 2 batches × 3 stages)
      • Days 13-15 — hard individuals (4 personas × 3 stages)
      • Days 16-18 — couples (3 personas × 3 stages) appended as a final
        "couple practice" block. Indices 20-22 in _PERSONAS.
    """
    easy = [list(range(0, 4)), list(range(4, 8))]
    medium = [list(range(8, 12)), list(range(12, 16))]
    hard = [list(range(16, 20))]
    couples = [list(range(20, 23))]

    grid: list[list[tuple[int, int]]] = []
    for tier_batches in (easy, medium):
        for stage in (1, 2, 3):
            for batch in tier_batches:
                grid.append([(i, stage) for i in batch])
    for stage in (1, 2, 3):
        for batch in hard:
            grid.append([(i, stage) for i in batch])
    for stage in (1, 2, 3):
        for batch in couples:
            grid.append([(i, stage) for i in batch])
    return grid  # 6 + 6 + 3 + 3 = 18 days


def _weekday_dates(start: date, count: int) -> list[date]:
    """`count` consecutive weekdays starting on/after `start` (skip Sat/Sun)."""
    out: list[date] = []
    d = start
    while len(out) < count:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d)
        d += timedelta(days=1)
    return out


_STAGE_TO_APPOINTMENT = {1: "first", 2: "second", 3: "third"}


async def ensure_curriculum_profiles(db: AsyncSession, created_by: str | None = None) -> int:
    """Idempotently create the 60 curriculum profiles. Returns count created.

    Also backfills appointment_type on any pre-existing curriculum profiles that
    were created before that column existed.
    """
    existing_q = await db.execute(
        select(SessionProfile).where(SessionProfile.id.in_(curriculum_profile_ids()))
    )
    existing = {p.id: p for p in existing_q.scalars().all()}

    created = 0
    now = datetime.now(timezone.utc)
    for spec in _PERSONAS:
        diff_label = DIFFICULTY_LABEL[spec["difficulty"]]
        for stage in (1, 2, 3):
            pid = _profile_id(spec["key"], stage)
            appt = _STAGE_TO_APPOINTMENT[stage]
            if pid in existing:
                # Backfill appointment_type on older rows.
                ep = existing[pid]
                if ep.appointment_type != appt:
                    ep.appointment_type = appt
                continue
            stage_label, stage_desc, _ = STAGE_META[stage]
            persona = _build_persona(spec, stage)
            profile = SessionProfile(
                id=pid,
                name=f"{spec['name']} · {stage_label} ({diff_label})",
                description=f"[Curriculum · {diff_label}] {stage_desc}",
                persona=persona.model_dump(),
                appointment_type=appt,
                created_by=created_by,
                is_active=True,
                created_at=now,
                updated_at=now,
            )
            db.add(profile)
            created += 1
    await db.flush()
    return created


async def advisor_has_curriculum(db: AsyncSession, advisor_id: str) -> bool:
    q = await db.execute(
        select(SessionAssignment.id)
        .where(SessionAssignment.advisor_id == advisor_id)
        .where(SessionAssignment.profile_id.in_(curriculum_profile_ids()))
        .limit(1)
    )
    return q.first() is not None


async def assign_curriculum_to_advisor(
    db: AsyncSession,
    advisor_id: str,
    *,
    assigned_by: str | None = None,
    start: date | None = None,
) -> int:
    """Create the curriculum assignments for an advisor across the day grid.

    Idempotent at the per-assignment level — only creates assignments for
    (advisor, profile) pairs that don't already exist. This lets us extend
    the curriculum later (e.g., add couples) and have existing advisors
    pick up the new days on the next run.

    Returns the number of NEW assignments created.
    """
    await ensure_curriculum_profiles(db, created_by=assigned_by)

    # Discover which curriculum profiles this advisor is already assigned to,
    # so we skip re-creating duplicates but still add any NEW profiles.
    existing_q = await db.execute(
        select(SessionAssignment.profile_id)
        .where(SessionAssignment.advisor_id == advisor_id)
        .where(SessionAssignment.profile_id.in_(curriculum_profile_ids()))
    )
    already_assigned: set[str] = {row[0] for row in existing_q.all()}

    grid = _build_grid()
    start = start or date.today()
    days = _weekday_dates(start, len(grid))

    created = 0
    for day_index, entries in enumerate(grid):
        target = days[day_index]
        for persona_index, stage in entries:
            spec = _PERSONAS[persona_index]
            profile_id = _profile_id(spec["key"], stage)
            if profile_id in already_assigned:
                continue
            db.add(
                SessionAssignment(
                    id=str(uuid.uuid4()),
                    profile_id=profile_id,
                    advisor_id=advisor_id,
                    assigned_by=assigned_by,
                    assigned_date=start,
                    target_date=target,
                    status="pending",
                )
            )
            created += 1
    await db.flush()
    logger.info("Assigned %d curriculum assignments to advisor %s", created, advisor_id)
    return created
