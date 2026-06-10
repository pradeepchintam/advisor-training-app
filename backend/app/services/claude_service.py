"""
Claude AI service for client simulation and session analysis.

Uses prompt caching on the large system prompts to reduce latency and cost.

The Anthropic SDK's sync client is used with asyncio.to_thread() so that
blocking HTTP calls do not stall the FastAPI event loop.
"""
import asyncio
import json
import re
from typing import Any

import anthropic

from app.config import settings
from app.schemas import ClientPersona

# Initialise both sync and async Anthropic clients once at module load time.
# Async is used by the streaming endpoint so we can forward tokens to the
# WebSocket without spinning up a thread + queue bridge.
_client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
_async_client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def age_group_from_age(age: int | None) -> str:
    """Derive an age bucket from a numeric age. Mirrors the four ClientPersona
    age_group values so the TTS voice picker has a sensible bucket even when
    the spouse_age_group field is missing on legacy profiles."""
    if age is None:
        return "middle_aged"
    if age < 35:
        return "young_adult"
    if age < 55:
        return "middle_aged"
    if age < 70:
        return "senior"
    return "elderly"


def _format_topics(questionnaire_topics: list[dict]) -> str:
    lines = []
    for i, topic in enumerate(questionnaire_topics, 1):
        importance = topic.get("importance", "medium")
        lines.append(f"  {i}. [{importance.upper()}] {topic.get('topic', '')}")
    return "\n".join(lines)


def _build_conversation_messages(
    conversation_history: list[dict], advisor_message: str
) -> list[dict]:
    """Convert stored conversation history to Anthropic message format."""
    messages: list[dict] = []

    for entry in conversation_history:
        role = entry.get("role", "")
        text = entry.get("text", "")
        if role == "advisor":
            messages.append({"role": "user", "content": text})
        elif role == "client":
            messages.append({"role": "assistant", "content": text})

    # Add the new advisor message
    messages.append({"role": "user", "content": advisor_message})
    return messages


# ---------------------------------------------------------------------------
# Client simulation
# ---------------------------------------------------------------------------

def _is_couple(persona: ClientPersona) -> bool:
    """True when both members of a couple are present on the persona."""
    return (
        getattr(persona, "client_type", "") == "couple"
        and bool(getattr(persona, "spouse_name", None))
        and bool(getattr(persona, "spouse_gender", None))
    )


async def analyze_session(
    session: Any,
    script_content: str | None = None,
    *,
    asr_transcript: str | None = None,
    delivery_metrics: dict | None = None,
) -> dict:
    """Analyse a completed training session using claude-sonnet-4-6.

    Optional enriched signals:
      • `asr_transcript` — verbatim ASR re-transcription of the recording.
        When present, included alongside the live browser transcript so the
        model can spot filler words / hedges / corrections that the live
        Web Speech transcript dropped.
      • `delivery_metrics` — prosody summary from prosody_service.
    """

    persona_data = session.persona if isinstance(session.persona, dict) else session.persona.model_dump()
    persona = ClientPersona(**persona_data)

    # Build transcript
    transcript_lines = []
    for msg in (session.conversation or []):
        role = msg.get("role", "unknown").upper()
        text = msg.get("text", "")
        ts = msg.get("timestamp", "")
        transcript_lines.append(f"[{ts}] {role}: {text}")
    had_live_transcript = bool(transcript_lines)
    if had_live_transcript:
        transcript = "\n".join(transcript_lines)
    elif asr_transcript:
        # One-way practice has no live conversation — the advisor's words come
        # entirely from the post-session ASR re-transcription of the recording.
        transcript = f"ADVISOR (transcribed from the recording):\n{asr_transcript}"
    else:
        transcript = "(No conversation recorded)"

    # Build slide timeline
    slide_events = getattr(session, "slide_events", None) or []
    if slide_events:
        slide_timeline = "\n".join(
            f"[{e.get('timestamp', '')}] Advisor moved to slide {e.get('slide_number')}"
            for e in slide_events
        )
    else:
        slide_timeline = "(No slide changes recorded)"

    persona_summary = f"""
- Name: {persona.name}, Age: {persona.age}, {persona.marital_status}
- Occupation: {persona.occupation} ({", ".join(persona.employment_types) if persona.employment_types else "employed"})
- Financial situation: {persona.financial_situation}, Net worth: {persona.estimated_net_worth}
- Risk tolerance: {persona.risk_tolerance}, Investment experience: {persona.investment_experience}
- Primary concerns: {", ".join(persona.primary_concerns) if persona.primary_concerns else "general financial planning"}
- Personality: {persona.personality_type}, Communication: {persona.communication_style}
- Previous advisor: {"Yes (" + persona.previous_advisor_experience + ")" if persona.previous_advisor else "No"}
""".strip()

    # ---- Scorecard selection by appointment type ---------------------
    from app.services.scorecard_service import (
        scorecards_for_appointment,
        format_scorecard_for_prompt,
        VALUE_ADD_RUBRIC,
        PRE_CLOSE_VERBATIM,
    )

    appointment_type = getattr(session, "appointment_type", None)
    engage_client = bool(getattr(session, "engage_client", False))
    active_scorecards = scorecards_for_appointment(appointment_type)
    scorecards_block = "\n\n".join(
        format_scorecard_for_prompt(sc) for sc in active_scorecards
    )
    expected_types = [sc.type for sc in active_scorecards]

    # One-sided practice mode: the client never spoke. The advisor walked
    # through the deck solo. Items that REQUIRE client interaction
    # (objection handling, question handling, closing-with-silence, reading
    # the room) can't be observed — instruct the model to mark those N/A
    # rather than penalize the advisor for them, and to grade what IS
    # present (delivery, script adherence, verbatim accuracy, slide flow,
    # confidence, value-add framing).
    solo_block = ""
    if not engage_client:
        solo_block = (
            "\nIMPORTANT — ONE-SIDED PRACTICE SESSION:\n"
            "This was a solo deck walkthrough. The CLIENT DID NOT SPEAK at all "
            "(the advisor practiced presenting without an interactive client). "
            "The transcript therefore contains only the advisor's speech.\n"
            "  • Grade items that can be observed from a solo walkthrough: "
            "presentation delivery, verbatim/script adherence, slide flow, "
            "pacing, confidence, clarity, value-add framing, and the pre-close "
            "statement.\n"
            "  • For items that INHERENTLY require a client (objection handling, "
            "question handling, close-and-silence, reading the prospect, "
            "double-confirming the next appointment with the client), set "
            "applicable=false with feedback noting they couldn't be assessed in "
            "a one-sided session — do NOT give a low score for their absence.\n"
        )

    system_prompt = """You are an expert fiduciary advisor trainer and compliance officer at Trajan Wealth, a registered investment advisory firm.

You evaluate recorded training sessions between a Fiduciary Advisor and a simulated prospect/client using the firm's printed scorecards. Each scorecard item is scored on a 1–5 scale (matching the printed scorecards):
  5 = Exceptional — best-in-class delivery
  4 = Strong — minor polish needed
  3 = Adequate — met the bar but missed depth or nuance
  2 = Weak — significant gaps, partial credit only
  1 = Poor or absent

Some items are SCRIPT items — judge them against the active training script / deck PDF and (where given) a verbatim target.
Other items are BEHAVIORAL items — judge them from rapport, confidence, value-add, objection handling, energy, and personality cues in the conversation transcript and any delivery metrics.

Mark an item with `applicable=false` (and `score=null`) ONLY when the item's `skip_when` condition clearly applies. Otherwise always score it.

Always respond with valid JSON only — no markdown fences, no preamble."""

    script_block = (
        f"\nTRAINING SCRIPT / DECK CONTENT (the advisor was expected to follow this):\n{script_content}\n"
        if script_content
        else "\nTRAINING SCRIPT / DECK CONTENT: (no script/deck text available for this session — judge SCRIPT items using your knowledge of standard Trajan Wealth talking points, and call out the absence in feedback.)\n"
    )
    slide_block = (
        f"\nSLIDE TIMELINE (advisor's slide changes during the session):\n{slide_timeline}\n"
        if slide_events
        else "\nSLIDE TIMELINE: (no slides navigated during this session)\n"
    )

    # Optional ASR-derived signals
    asr_block = ""
    if asr_transcript and had_live_transcript:
        # Only add as a SUPPLEMENTARY block when there was a live transcript;
        # for one-way sessions the ASR is already the primary transcript above.
        asr_block = (
            "\nVERBATIM ASR TRANSCRIPT (from the recorded audio — includes filler "
            "words, hedges, and disfluencies the live browser transcript may have "
            "dropped):\n" + asr_transcript + "\n"
        )

    delivery_block = ""
    if delivery_metrics:
        from app.services.prosody_service import format_metrics_for_prompt
        delivery_block = (
            "\nDELIVERY METRICS (objective):\n"
            + format_metrics_for_prompt(delivery_metrics) + "\n"
        )

    pre_close_block = ""
    # The pre-close verbatim target only matters for 1st-meeting evaluations.
    if any(sc.type == "first_meeting" for sc in active_scorecards):
        pre_close_block = (
            "\nPRE-CLOSE VERBATIM TARGET (1st Meeting only — score `pre_close_verbatim` "
            "against this exact text):\n" + PRE_CLOSE_VERBATIM + "\n"
        )

    value_add_block = (
        "\nVALUE-ADD RUBRIC (used for any `value_add` item):\n" + VALUE_ADD_RUBRIC + "\n"
    )

    # JSON shape skeleton — one block per active scorecard, in order.
    sc_json_blocks = []
    for sc in active_scorecards:
        items_json = ",\n        ".join(
            f'{{"key": "{item.key}", "label": "{item.label.replace(chr(34), chr(39))}", '
            f'"kind": "{item.kind}", "applicable": <true|false>, '
            f'"score": <1-5 number or null when applicable=false>, '
            f'"feedback": "<specific, actionable feedback grounded in transcript evidence>"}}'
            for item in sc.items
        )
        sc_json_blocks.append(
            f'    {{\n'
            f'      "type": "{sc.type}",\n'
            f'      "title": "{sc.title}",\n'
            f'      "items": [\n        {items_json}\n      ],\n'
            f'      "summary_score": <mean of applicable item scores, 1-5 float>\n'
            f'    }}'
        )
    scorecards_json_block = ",\n".join(sc_json_blocks)

    user_prompt = f"""Analyze this training session between a Fiduciary Advisor and a simulated client.

APPOINTMENT TYPE: {appointment_type or "unspecified"}
ACTIVE SCORECARD(S): {", ".join(sc.title for sc in active_scorecards)}
{solo_block}
CLIENT PROFILE:
{persona_summary}

FULL CONVERSATION TRANSCRIPT (live, from the browser):
{transcript}
{asr_block}{delivery_block}{script_block}{slide_block}{pre_close_block}{value_add_block}
SCORECARD ITEMS TO GRADE (score every item; respect skip_when conditions):

{scorecards_block}

Return JSON in EXACTLY this shape. The `scorecards` array MUST contain one entry per active scorecard, in this order: {expected_types}. Every item from each scorecard MUST appear in its scorecard's `items` list, keyed by `key` exactly as shown above. When item delivery/pace/fillers are relevant (e.g., `overall_confidence`, `personality_likeability`, `aum_overall`), fold the delivery metrics into the feedback.

{{
  "overall_score": <mean of all scorecard summary_scores, 1-5 float>,
  "scorecards": [
{scorecards_json_block}
  ],
  "strengths": ["<strength 1>", "<strength 2>"],
  "areas_for_improvement": ["<improvement 1>", "<improvement 2>"],
  "compliance_flags": ["<flag if any compliance issues, or empty list>"],
  "transcript_summary": "<2-3 sentence summary of the session>",
  "recommendations": ["<specific actionable recommendation 1>", "<specific actionable recommendation 2>"]
}}"""

    # Run in a thread so we don't block the async event loop.
    def _call() -> str:
        resp = _client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=6144,
            system=[
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_prompt}],
        )
        return resp.content[0].text

    raw_text = (await asyncio.to_thread(_call)).strip()

    # Strip markdown code fences if present
    raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
    raw_text = re.sub(r"\s*```$", "", raw_text)

    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        # Attempt to extract JSON object from the response
        match = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if not match:
            raise ValueError(f"Could not parse analysis JSON from Claude response: {raw_text[:200]}")
        parsed = json.loads(match.group())

    # ---- Deterministic post-processing: recompute summary + overall scores
    #      so the UI never trusts the model's mental arithmetic. -----------
    scorecards_out = parsed.get("scorecards") or []
    sc_summary_scores: list[float] = []
    for sc in scorecards_out:
        items = sc.get("items") or []
        applicable_scores = [
            float(it["score"])
            for it in items
            if it.get("applicable", True) and isinstance(it.get("score"), (int, float))
        ]
        if applicable_scores:
            summary = round(sum(applicable_scores) / len(applicable_scores), 2)
            sc["summary_score"] = summary
            sc_summary_scores.append(summary)
        else:
            sc["summary_score"] = None

    if sc_summary_scores:
        parsed["overall_score"] = round(
            sum(sc_summary_scores) / len(sc_summary_scores), 2
        )

    return parsed
