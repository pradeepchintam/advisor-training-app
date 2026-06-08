import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_advisor, require_advisor_or_admin
from app.database import get_db
from app.models import SessionAssignment, SessionProfile, TrainingSession, User
from app.schemas import ClientPersona, SessionCreate, SessionDetail, SessionPublic
from app.services.persona_service import generate_persona_details
from app.services.storage_service import get_recording_path, get_recording_url, save_recording

router = APIRouter()


def _random_full_name(gender: str, seed: str | None = None) -> str:
    """Pick a random first + last name. If `seed` is provided, the choice is
    deterministic — so the same persona stays the same person across that
    advisor's 1st/2nd/3rd appointments, while still differing per advisor."""
    import random as _random
    from app.services.persona_service import MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES
    rng = _random.Random(seed) if seed else _random
    pool = MALE_FIRST_NAMES if (gender or "").lower() == "male" else FEMALE_FIRST_NAMES
    return f"{rng.choice(pool)} {rng.choice(LAST_NAMES)}"


def _randomize_persona_names(persona, *, seed: str | None) -> None:
    """Mutates the ClientPersona in-place to give it a fresh (or seeded) name.

    The persona's existing name is replaced with a random pick. If the persona
    is a couple, the spouse's name is regenerated too (with a per-spouse seed
    so the pair stays a stable pair, not just a stable individual)."""
    persona.name = _random_full_name(persona.gender, seed=seed)
    if (getattr(persona, "client_type", "") == "couple") or persona.spouse_gender:
        persona.spouse_name = _random_full_name(
            persona.spouse_gender or "female",
            seed=(seed + ":spouse") if seed else None,
        )


def _ensure_persona_has_gender(persona, *, seed: str | None = None) -> None:
    """Defensive guard: every persona MUST have a gender so the TTS picker can
    select a voice. If the stored profile is missing one (legacy data, partial
    builders), assign a random one — seeded when possible so repeat starts of
    the same assignment land on the same gender."""
    import random as _random
    g = (getattr(persona, "gender", None) or "").strip().lower()
    if g in {"male", "female"}:
        # Normalize casing so downstream comparisons are simple.
        persona.gender = g
        return
    rng = _random.Random(seed) if seed else _random
    persona.gender = rng.choice(["male", "female"])
    # Spouse gender mirrors the same defensive guard for couples.
    if getattr(persona, "client_type", "") == "couple":
        sg = (getattr(persona, "spouse_gender", None) or "").strip().lower()
        if sg in {"male", "female"}:
            persona.spouse_gender = sg
        else:
            persona.spouse_gender = rng.choice(["male", "female"])


# randomuser.me's `nat=` parameter is a country code, but its portrait
# library biases the ETHNICITY of the result. We use the country whose
# portrait pool best matches the persona's name. Names not matched here
# fall back to a Western pool (us/gb/au/ca).
#
# Last-name suffixes → nat-code. Order matters (first match wins) so put
# more-specific suffixes before shorter ones.
_NAT_BY_LAST_NAME_SUFFIX: list[tuple[str, str]] = [
    # South Asian (Indian / Pakistani)
    ("patel", "in"), ("singh", "in"), ("kumar", "in"), ("sharma", "in"),
    ("anand", "in"), ("chopra", "in"), ("gupta", "in"), ("malhotra", "in"),
    ("reddy", "in"), ("rao", "in"), ("desai", "in"), ("nair", "in"),
    ("iyer", "in"), ("menon", "in"), ("khanna", "in"), ("kapoor", "in"),
    ("verma", "in"), ("agarwal", "in"), ("bose", "in"),
    # Middle Eastern
    ("hassan", "ir"), ("ahmed", "ir"), ("ali", "ir"), ("khan", "ir"),
    ("rahman", "ir"), ("saleh", "ir"), ("hossein", "ir"), ("malik", "ir"),
    # Hispanic / Latino
    ("rivera", "mx"), ("garcia", "mx"), ("martinez", "mx"), ("hernandez", "mx"),
    ("lopez", "mx"), ("gonzalez", "mx"), ("rodriguez", "mx"), ("perez", "mx"),
    ("sanchez", "mx"), ("ramirez", "mx"), ("torres", "mx"), ("flores", "mx"),
    ("ruiz", "mx"), ("vargas", "mx"), ("castillo", "mx"), ("ortiz", "mx"),
    ("morales", "mx"), ("castellano", "mx"), ("delgado", "mx"),
    # Brazilian-leaning Portuguese
    ("silva", "br"), ("santos", "br"), ("oliveira", "br"), ("souza", "br"),
    # Italian-leaning
    ("rossi", "es"), ("bianchi", "es"), ("ferrari", "es"), ("romano", "es"),
    # Irish
    ("o'connor", "ie"), ("o'brien", "ie"), ("murphy", "ie"), ("kelly", "ie"),
    ("byrne", "ie"), ("ryan", "ie"), ("walsh", "ie"), ("o'sullivan", "ie"),
    # French
    ("dubois", "fr"), ("laurent", "fr"), ("lefebvre", "fr"), ("moreau", "fr"),
    # Northern European
    ("nielsen", "dk"), ("hansen", "dk"), ("andersen", "dk"),
    ("johansson", "fi"), ("eriksson", "fi"), ("lindgren", "fi"),
    ("van der", "nl"), ("de vries", "nl"), ("jansen", "nl"), ("bakker", "nl"),
    # Germanic
    ("müller", "de"), ("schmidt", "de"), ("schneider", "de"), ("fischer", "de"),
]

_WESTERN_NATS = ("us", "gb", "au", "ca")


def _infer_nationality(name: str | None, seed: str = "") -> str:
    """Map persona name → randomuser.me `nat` code so the portrait roughly
    matches the persona's likely ethnicity. East Asian names (Chen, Lin,
    Tanaka, Kim) have no good randomuser.me bucket — we'd rather show a
    generic Western photo than a wildly-wrong stand-in, so those return
    a Western nat. Same for unknown names.
    """
    if not name:
        return _WESTERN_NATS[0]
    parts = name.strip().lower().split()
    last = parts[-1] if parts else ""
    for suffix, nat in _NAT_BY_LAST_NAME_SUFFIX:
        if last.endswith(suffix) or last == suffix:
            return nat
    # Rotate through the Western nat pool by hashing the seed so we don't
    # show 50 identical American faces in a row.
    import hashlib
    digest = hashlib.md5((seed or name).encode("utf-8")).hexdigest()
    return _WESTERN_NATS[int(digest[:4], 16) % len(_WESTERN_NATS)]


async def _fetch_randomuser_portrait(gender: str | None, nat: str) -> str | None:
    """Fetch one portrait URL from randomuser.me matching the requested
    gender + nationality. Returns ``picture.large`` on success, or None
    on any failure so the caller can fall back to the static `/api/portraits/
    {men|women}/N.jpg` library.

    Note: we DON'T pass ``seed=``. randomuser.me's seed mode ignores the
    ``gender`` and ``nat`` parameters — passing ``seed=alice`` always
    returns the same person regardless of other filters. We keep stability
    by persisting the returned URL on the persona instead.

    Defensively verify the returned ``gender`` field matches what we
    asked for; randomuser.me occasionally returns a mismatched record.
    Retry up to 3 times before giving up.
    """
    from urllib.parse import urlencode
    g = (gender or "").strip().lower()
    g = "female" if g == "female" else "male"
    params = {"gender": g, "nat": nat, "inc": "picture,gender", "noinfo": "true"}
    url = f"https://randomuser.me/api/?{urlencode(params)}"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            for _ in range(3):
                resp = await client.get(url)
                if resp.status_code != 200:
                    return None
                rec = (resp.json().get("results") or [{}])[0]
                if rec.get("gender", "").lower() == g:
                    return rec.get("picture", {}).get("large")
                # Mismatched gender — try again. (Rare; randomuser.me
                # honors gender most of the time without a seed.)
            return None
    except Exception:  # noqa: BLE001
        return None


def _deterministic_image_url(gender: str | None, seed: str) -> str:
    """Fallback portrait URL — used when the seeded randomuser.me lookup
    fails (or for legacy code paths that don't have a persona to attach
    ethnicity heuristics to). Same logic as before: hash the seed into a
    0–99 slot of the `/api/portraits/{men|women}/N.jpg` library.
    """
    import hashlib
    g = (gender or "").strip().lower()
    bucket = "women" if g == "female" else "men"
    digest = hashlib.md5(seed.encode("utf-8")).hexdigest()
    idx = int(digest[:8], 16) % 100
    return f"https://randomuser.me/api/portraits/{bucket}/{idx}.jpg"


async def _resolve_persona_image_url(persona, *, spouse: bool = False) -> str:
    """Pick the best portrait URL for `persona`, considering name-based
    nationality + gender. Tries the seeded randomuser.me API first; falls
    back to the legacy `/api/portraits/...` library if the API hiccups.
    """
    if spouse:
        name = getattr(persona, "spouse_name", None)
        gender = getattr(persona, "spouse_gender", None)
        seed_extra = ":spouse"
    else:
        name = getattr(persona, "name", None)
        gender = getattr(persona, "gender", None)
        seed_extra = ""
    base_seed = _persona_image_seed(persona).removeprefix("persona:") + seed_extra
    # For couples, derive nationality from the PRIMARY's name so both
    # partners come from the same randomuser.me pool. Spouses typically
    # share a last name, but for inferred-Western names the rotation could
    # otherwise put husband and wife in different country pools.
    primary_name = getattr(persona, "name", None)
    nat_basis_name = primary_name if (spouse and primary_name) else name
    nat = _infer_nationality(nat_basis_name, _persona_image_seed(persona).removeprefix("persona:"))
    real = await _fetch_randomuser_portrait(gender, nat)
    if real:
        return real
    # Last-resort fallback — never block a stamp on the network being flaky.
    return _deterministic_image_url(gender, base_seed)


def _persona_image_seed(persona) -> str:
    """Seed for the deterministic portrait. Keyed on the persona's NAME
    (lowercased + collapsed whitespace) so Linda Garcia's 1st/2nd/3rd
    appointment profiles — which are separate DB rows but the same person —
    all resolve to the same photo. Falls back to a stable placeholder if
    the persona is somehow nameless."""
    name = (getattr(persona, "name", "") or "").strip().lower()
    name = " ".join(name.split())
    return f"persona:{name}" if name else "persona:unknown"


async def _fetch_client_image(gender: str) -> str:
    """Fetch a profile image URL from randomuser.me."""
    gender_param = "male" if gender.lower() == "male" else "female"
    url = f"https://randomuser.me/api/?gender={gender_param}&nat=us,gb,au&results=1"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                return data["results"][0]["picture"]["large"]
    except Exception:
        pass
    # Fallback placeholder
    return f"https://ui-avatars.com/api/?name=Client&background=random&size=200"


async def _active_decks_for_session(db: AsyncSession, session: "TrainingSession") -> list:
    """Active presentation deck(s) for the session's appointment type.

    first  → [first deck]
    second → [second deck]
    third  → [annuity deck, private-equity deck]
    none   → [first deck]  (fallback)
    """
    from app.models import Presentation
    from app.services.deck_slots import slots_for_appointment

    slots = slots_for_appointment(getattr(session, "appointment_type", None))
    decks = []
    for slot in slots:
        r = await db.execute(
            select(Presentation).where(
                Presentation.is_active == True, Presentation.slot == slot  # noqa: E712
            )
        )
        p = r.scalar_one_or_none()
        if p is not None:
            decks.append(p)
    return decks


async def _load_script_for_session(db: AsyncSession, session: "TrainingSession") -> str | None:
    """Resolve the script(s) the advisor was expected to follow for THIS session.

    Priority:
      1. The PDF script(s) attached to the deck(s) for the session's appointment
         type. For a third appointment, the Annuity and Private-Equity scripts
         are concatenated with labelled headers.
      2. The legacy global active TrainingScript (backward-compat fallback).
    """
    from app.models import TrainingScript
    from app.services.deck_slots import SLOT_LABELS

    decks = await _active_decks_for_session(db, session)
    sections: list[str] = []
    for d in decks:
        if d.script_text:
            label = SLOT_LABELS.get(d.slot, d.title)
            sections.append(f"=== {label} script ===\n{d.script_text}")
    if sections:
        return "\n\n".join(sections)

    # Fallback: legacy standalone active script
    r = await db.execute(select(TrainingScript).where(TrainingScript.is_active == True))
    s = r.scalar_one_or_none()
    return s.content if s else None


async def _primary_presentation_id_for(db: AsyncSession, appointment_type: str | None) -> str | None:
    """The active deck id for the FIRST slot of the appointment type (or fallback)."""
    from app.models import Presentation
    from app.services.deck_slots import slots_for_appointment

    for slot in slots_for_appointment(appointment_type):
        r = await db.execute(
            select(Presentation).where(
                Presentation.is_active == True, Presentation.slot == slot  # noqa: E712
            )
        )
        p = r.scalar_one_or_none()
        if p is not None:
            return p.id
    return None


async def _run_analysis(session_id: str) -> None:
    """Background task: enrich the session with ASR + prosody + vision signals,
    then run the Claude analyzer."""
    import logging
    from pathlib import Path

    from app.database import AsyncSessionLocal
    from app.services.claude_service import analyze_session

    log = logging.getLogger("trajan.analysis")

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(TrainingSession).where(TrainingSession.id == session_id)
        )
        session = result.scalar_one_or_none()
        if session is None:
            return

        # ------------------------------------------------------------------
        # 1) Re-transcribe (best-effort) for an accurate, filler-aware transcript.
        # ------------------------------------------------------------------
        asr_transcript: str | None = None
        delivery_metrics: dict | None = None
        local_path_for_vision: str | None = None
        recording_path = session.recording_path

        if recording_path:
            try:
                from app.services.transcription_service import (
                    transcribe_recording, download_recording_to_tmp,
                    cleanup_analysis_artifacts,
                )
                from app.services.prosody_service import compute_delivery_metrics

                transcription = await transcribe_recording(recording_path, session_id)
                if transcription:
                    asr_transcript = transcription.get("transcript") or None
                    delivery_metrics = compute_delivery_metrics(transcription)

                # Keep a local copy around for the vision pass (avoids two downloads).
                local_path_for_vision = await download_recording_to_tmp(recording_path)
                # Schedule cleanup of staged S3 inputs; non-blocking.
                try:
                    await cleanup_analysis_artifacts(session_id)
                except Exception:
                    pass
            except Exception as e:
                log.warning("Re-transcription failed for %s: %s", session_id, e)

        # ------------------------------------------------------------------
        # 2) Vision pass (best-effort) — soft signal on body language / framing.
        # ------------------------------------------------------------------
        video_analysis: dict | None = None
        try:
            if local_path_for_vision and Path(local_path_for_vision).exists():
                from app.services.vision_service import analyze_video
                video_analysis = await analyze_video(local_path_for_vision)
        except Exception as e:
            log.warning("Vision pass failed for %s: %s", session_id, e)
        finally:
            # If we downloaded to /tmp, clean up.
            if (
                local_path_for_vision
                and local_path_for_vision.startswith("/tmp/")
                and Path(local_path_for_vision).exists()
            ):
                try:
                    Path(local_path_for_vision).unlink()
                except OSError:
                    pass

        # ------------------------------------------------------------------
        # 3) Run Claude analysis with all signals folded in.
        # ------------------------------------------------------------------
        try:
            script_content = await _load_script_for_session(db, session)
            analysis = await analyze_session(
                session,
                script_content=script_content,
                asr_transcript=asr_transcript,
                delivery_metrics=delivery_metrics,
            )
            # Annotate the analysis with the ancillary signals so the UI can
            # render them without re-deriving anything.
            if delivery_metrics is not None:
                analysis["delivery_metrics"] = delivery_metrics
            if video_analysis is not None:
                analysis["video_analysis"] = video_analysis
            if asr_transcript is not None:
                analysis["asr_transcript_used"] = True

            session.analysis = analysis
            await db.commit()
        except Exception as e:
            log.exception("Analysis failed for session %s: %s", session_id, e)
            session.status = "error"
            await db.commit()


@router.get("", response_model=list[SessionPublic])
async def list_sessions(
    advisor_id: str | None = None,
    source: str | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    query = select(TrainingSession).order_by(TrainingSession.started_at.desc())

    if current_user.role == "admin":
        if advisor_id:
            query = query.where(TrainingSession.advisor_id == advisor_id)
    else:
        query = query.where(TrainingSession.advisor_id == current_user.id)

    if source in ("assigned", "self_initiated"):
        query = query.where(TrainingSession.source == source)

    result = await db.execute(query)
    sessions = result.scalars().all()

    # Build advisor name lookup in one query
    advisor_ids = list({s.advisor_id for s in sessions})
    if advisor_ids:
        users_result = await db.execute(select(User).where(User.id.in_(advisor_ids)))
        advisor_map = {u.id: u.name for u in users_result.scalars().all()}
    else:
        advisor_map = {}

    # Resolve profile_name for assigned sessions in one query
    assignment_ids = list({s.assignment_id for s in sessions if s.assignment_id})
    profile_name_by_assignment: dict[str, str] = {}
    if assignment_ids:
        a_result = await db.execute(
            select(SessionAssignment).where(SessionAssignment.id.in_(assignment_ids))
        )
        assignments = a_result.scalars().all()
        profile_ids = list({a.profile_id for a in assignments})
        if profile_ids:
            p_result = await db.execute(
                select(SessionProfile).where(SessionProfile.id.in_(profile_ids))
            )
            profiles_by_id = {p.id: p.name for p in p_result.scalars().all()}
            profile_name_by_assignment = {
                a.id: profiles_by_id.get(a.profile_id) for a in assignments
            }

    return [
        SessionPublic(
            id=s.id,
            advisor_id=s.advisor_id,
            advisor_name=advisor_map.get(s.advisor_id),
            client_name=s.client_name,
            client_image_url=s.client_image_url,
            status=s.status,
            started_at=s.started_at,
            ended_at=s.ended_at,
            persona=ClientPersona(**s.persona),
            overall_score=s.analysis.get("overall_score") if s.analysis else None,
            score_scale=(5 if (s.analysis and s.analysis.get("scorecards")) else 10),
            source=s.source or "self_initiated",
            assignment_id=s.assignment_id,
            profile_name=profile_name_by_assignment.get(s.assignment_id) if s.assignment_id else None,
        )
        for s in sessions
    ]


@router.post("", response_model=SessionPublic, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor),
):
    """Create a training session.

    Two paths:
      • Assigned — payload.assignment_id is provided. Persona is loaded from the
        linked SessionProfile; the advisor cannot override it. source='assigned'.
      • Self-initiated — payload.persona is provided directly. source='self_initiated'.
    """
    profile_name: str | None = None
    source = "self_initiated"
    assignment_id: str | None = None

    if payload.assignment_id:
        # --- Assigned flow ---------------------------------------------------
        a_result = await db.execute(
            select(SessionAssignment).where(SessionAssignment.id == payload.assignment_id)
        )
        assignment = a_result.scalar_one_or_none()
        if assignment is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Assignment not found",
            )
        if assignment.advisor_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This assignment belongs to another advisor",
            )
        if assignment.status == "cancelled":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This assignment was cancelled by the admin",
            )
        # Cannot start a session before its scheduled date.
        from datetime import date as _date
        if assignment.target_date > _date.today():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"This session is scheduled for {assignment.target_date.isoformat()} "
                       f"and can't be started before then.",
            )

        p_result = await db.execute(
            select(SessionProfile).where(SessionProfile.id == assignment.profile_id)
        )
        profile = p_result.scalar_one_or_none()
        if profile is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Linked profile no longer exists",
            )

        persona = ClientPersona(**profile.persona)
        profile_name = profile.name
        source = "assigned"
        assignment_id = assignment.id
        appointment_type = profile.appointment_type

        # Assigned sessions PRESERVE the profile's persona exactly — same name
        # the admin sees in the assignment table, same name the advisor sees
        # when the session starts. The earlier randomization was disorienting
        # ("Margaret Chen" in the table, "Linda Garcia" in the meeting).

        # Guard: the profile MUST have a gender so the TTS voice picker can
        # work. If somehow it's missing, fill in a deterministic one keyed on
        # the profile so repeat starts stay consistent. Persist the inferred
        # gender back to the profile so the assignment table and the session
        # screen agree from this point onward.
        original_gender = (getattr(persona, "gender", None) or "").strip().lower()
        _ensure_persona_has_gender(persona, seed=f"profile:{profile.id}")
        if persona.gender != original_gender:
            profile.persona = persona.model_dump()

        # Persona may be partial (created from picker without name/backstory)
        if not persona.name or not persona.backstory:
            persona = generate_persona_details(persona.model_dump())

        # Mark the assignment as in_progress (idempotent for repeat starts)
        if assignment.status == "pending":
            assignment.status = "in_progress"

    else:
        # --- Self-initiated flow --------------------------------------------
        if payload.persona is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="persona is required when no assignment_id is provided",
            )
        persona = payload.persona
        appointment_type = None  # untyped → falls back to first-appointment deck
        # Ensure gender is set BEFORE name randomization so the right gendered
        # name pool is used. PersonaBuilder may not have populated it for
        # quick-start flows.
        _ensure_persona_has_gender(persona)
        # Self-initiated sessions get a freshly randomized name every time —
        # the advisor shouldn't see the same name twice in a row.
        _randomize_persona_names(persona, seed=None)
        if not persona.name or not persona.backstory:
            persona = generate_persona_details(persona.model_dump())

    # Resolve client image. Prefer the persona's persisted URL (stamped
    # at first read per-persona-name, so all three appointment stages of
    # the same client show the same face). When missing, resolve a fresh
    # persona-aware URL — name-inferred nationality drives randomuser.me's
    # `nat` parameter so e.g. Aisha Patel → an Indian portrait.
    if not getattr(persona, "client_image_url", None):
        persona.client_image_url = await _resolve_persona_image_url(persona)
    if (
        getattr(persona, "client_type", "") == "couple"
        and persona.spouse_gender
        and not getattr(persona, "spouse_image_url", None)
    ):
        persona.spouse_image_url = await _resolve_persona_image_url(persona, spouse=True)
    image_url = persona.client_image_url

    # Snapshot the primary deck for this appointment type (first resolved slot)
    # so recording/analysis linkage stays stable even if the admin swaps decks.
    presentation_id = await _primary_presentation_id_for(db, appointment_type)

    session = TrainingSession(
        id=str(uuid.uuid4()),
        advisor_id=current_user.id,
        persona=persona.model_dump(),
        client_name=persona.name,
        client_image_url=image_url,
        status="active",
        conversation=[],
        started_at=datetime.now(timezone.utc),
        source=source,
        assignment_id=assignment_id,
        presentation_id=presentation_id,
        appointment_type=appointment_type,
    )
    db.add(session)
    await db.flush()
    await db.refresh(session)

    return SessionPublic(
        id=session.id,
        advisor_id=session.advisor_id,
        client_name=session.client_name,
        client_image_url=session.client_image_url,
        status=session.status,
        started_at=session.started_at,
        ended_at=session.ended_at,
        persona=ClientPersona(**session.persona),
        source=session.source,
        assignment_id=session.assignment_id,
        profile_name=profile_name,
    )


@router.get("/{session_id}/presentations", response_model=list)
async def get_session_presentations(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    """Decks the advisor should present for this session, based on its
    appointment type. Third appointments return both Annuity + Private Equity."""
    from app.schemas import PresentationPublic

    result = await db.execute(
        select(TrainingSession).where(TrainingSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    if current_user.role != "admin" and session.advisor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    decks = await _active_decks_for_session(db, session)
    return [PresentationPublic.from_model(d).model_dump() for d in decks]


@router.get("/{session_id}", response_model=SessionDetail)
async def get_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    result = await db.execute(
        select(TrainingSession).where(TrainingSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    if current_user.role != "admin" and session.advisor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    from app.schemas import ConversationMessage

    profile_name: str | None = None
    if session.assignment_id:
        a_result = await db.execute(
            select(SessionAssignment).where(SessionAssignment.id == session.assignment_id)
        )
        a = a_result.scalar_one_or_none()
        if a is not None:
            p_result = await db.execute(
                select(SessionProfile).where(SessionProfile.id == a.profile_id)
            )
            p = p_result.scalar_one_or_none()
            profile_name = p.name if p else None

    return SessionDetail(
        id=session.id,
        advisor_id=session.advisor_id,
        client_name=session.client_name,
        client_image_url=session.client_image_url,
        status=session.status,
        persona=ClientPersona(**session.persona),
        conversation=[ConversationMessage(**m) for m in (session.conversation or [])],
        recording_path=session.recording_path,
        analysis=session.analysis,
        started_at=session.started_at,
        ended_at=session.ended_at,
        source=session.source or "self_initiated",
        assignment_id=session.assignment_id,
        profile_name=profile_name,
    )


@router.post("/{session_id}/end", response_model=dict)
async def end_session(
    session_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    result = await db.execute(
        select(TrainingSession).where(TrainingSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    if current_user.role != "admin" and session.advisor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    # Idempotent: if session is still active, mark it completed.
    # If already completed (e.g. via WebSocket disconnect), just re-trigger analysis.
    if session.status == "active":
        session.status = "completed"
        session.ended_at = datetime.now(timezone.utc)
        await db.commit()
        msg = "Session ended. Analysis will be available shortly."
    elif session.status == "completed":
        msg = "Session was already completed. Re-running analysis."
    else:  # "error" or any other state
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot end session in status '{session.status}'",
        )

    # If this session is fulfilling an admin assignment, mark it complete too.
    if session.assignment_id:
        a_result = await db.execute(
            select(SessionAssignment).where(SessionAssignment.id == session.assignment_id)
        )
        assignment = a_result.scalar_one_or_none()
        if assignment is not None and assignment.status in ("pending", "in_progress"):
            assignment.status = "completed"
            await db.commit()

    # Kick off analysis in background
    background_tasks.add_task(_run_analysis, session_id)

    return {"message": msg, "session_id": session_id}


@router.get("/{session_id}/recording")
async def get_recording(
    session_id: str,
    request: Request,
    token: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    """
    Stream the recording file. Accepts auth via Authorization header OR ?token=<jwt>
    query parameter (since <video src=> tags cannot send custom headers).
    """
    from app.auth import decode_token

    # Resolve auth: prefer Authorization header, fall back to ?token=
    auth_header = request.headers.get("authorization", "")
    bearer_token: str | None = None
    if auth_header.lower().startswith("bearer "):
        bearer_token = auth_header.split(" ", 1)[1].strip()
    if not bearer_token:
        bearer_token = token

    if not bearer_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")

    try:
        payload = decode_token(bearer_token)
        user_id = payload.get("sub")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {e}")

    user_result = await db.execute(select(User).where(User.id == user_id))
    current_user = user_result.scalar_one_or_none()
    if current_user is None or not current_user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    result = await db.execute(
        select(TrainingSession).where(TrainingSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    if current_user.role != "admin" and session.advisor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    # When S3 is enabled, redirect the client to a short-lived presigned URL.
    presigned = get_recording_url(session_id)
    if presigned:
        return RedirectResponse(url=presigned, status_code=status.HTTP_302_FOUND)

    recording_path = get_recording_path(session_id)
    if recording_path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No recording file found for session {session_id}. The advisor may not have uploaded one, or it was lost during a server restart.",
        )

    # Detect media type by sniffing first bytes — WebM video files start with the
    # EBML magic, but we can simplify by checking the filename or file content.
    from pathlib import Path as _P
    fpath = _P(recording_path)
    media_type = "video/webm"
    try:
        with open(recording_path, "rb") as fh:
            head = fh.read(128)
        # Both audio and video WebM share the EBML header; check for the Tracks
        # element with a TrackType of video (0x83 0x81 0x01) for video. Easier
        # heuristic: assume video if file is larger than ~1KB and the recording
        # extension/MIME hint says so.
        if b"V_VP" in head or b"V_AV" in head:
            media_type = "video/webm"
        elif b"A_OPUS" in head or b"A_VORBIS" in head:
            media_type = "audio/webm"
    except OSError:
        pass

    return FileResponse(
        path=recording_path,
        media_type=media_type,
        filename=f"session_{session_id}{fpath.suffix or '.webm'}",
    )


@router.post("/{session_id}/recording", response_model=dict)
async def upload_recording(
    session_id: str,
    recording: UploadFile,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    result = await db.execute(
        select(TrainingSession).where(TrainingSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    if current_user.role != "admin" and session.advisor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    content = await recording.read()
    filename = recording.filename or f"recording_{session_id}.webm"
    path = await save_recording(session_id, content, filename)

    session.recording_path = path
    await db.commit()

    return {"message": "Recording uploaded successfully", "path": path}


@router.get("/{session_id}/analysis", response_model=dict)
async def get_analysis(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    result = await db.execute(
        select(TrainingSession).where(TrainingSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    if current_user.role != "admin" and session.advisor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    if session.analysis:
        return session.analysis

    if session.status == "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Session is still active. End it first.",
        )

    # Run analysis now (synchronously for this request)
    from app.services.claude_service import analyze_session

    try:
        script_content = await _load_script_for_session(db, session)
        analysis = await analyze_session(session, script_content=script_content)
        session.analysis = analysis
        await db.commit()
        return analysis
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Analysis failed: {str(e)}",
        )
