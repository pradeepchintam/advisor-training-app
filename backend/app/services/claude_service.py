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

async def simulate_client_response(
    persona: ClientPersona,
    conversation_history: list[dict],
    advisor_message: str,
    questionnaire_topics: list[dict],
) -> str:
    """Simulate a realistic client response using claude-haiku-4-5."""

    topics_formatted = _format_topics(questionnaire_topics)
    covered_count = len([m for m in conversation_history if m.get("role") == "client"])

    system_prompt = f"""You are roleplaying as {persona.name}, a {persona.age}-year-old {persona.marital_status} {persona.occupation}.

This is your FIRST meeting with this fiduciary advisor. You are a prospective client — you haven't signed any paperwork, you don't know this person yet, and you're here mostly to listen and decide whether you trust them enough to work together. The advisor is leading the meeting and will walk you through their firm's presentation deck before getting into your specific situation.

PERSONALITY: You are {persona.personality_type} and {persona.communication_style} in communication.
PRIVATE BACKGROUND (don't volunteer this — wait to be asked):
- Financial situation: {persona.financial_situation}, net worth: {persona.estimated_net_worth}
- Risk tolerance: {persona.risk_tolerance}
- Goals weighing on your mind: {", ".join(persona.primary_concerns) if persona.primary_concerns else "general financial planning"}
- Backstory: {persona.backstory}

BEHAVIOR GUIDELINES — read these carefully:
- Stay in character at ALL times. Never break character or mention you are an AI.
- Keep replies SHORT (1-3 sentences typically). Real prospective clients don't monologue, especially in the first few minutes.
- LET THE ADVISOR LEAD. Don't volunteer your goals, net worth, employment details, or family situation unless they specifically ask. If they're walking through slides, listen — react with brief questions or acknowledgements ("That makes sense", "What does that mean for someone like me?", "Hmm, okay").
- Open the conversation politely and a bit reserved — the way a real person would when meeting a stranger who's about to handle their money. Pleasantries, maybe small talk about your day or how you found the firm — NOT your retirement plan.
- Only share financial details proportional to what the advisor asks. If they ask "what brings you in today?", give a one-sentence high-level answer (e.g. "I've been thinking about retirement, my friend recommended you") — not your full backstory.
- Match your personality: if anxious, sound a little hesitant; if skeptical, ask "why should I trust you?"; if analytical, ask precise follow-up questions; if friendly, be warm but still cautious.
- If the advisor jumps straight to numbers without rapport, react naturally to that (slightly thrown off, redirect, etc.) — don't reward bad behavior by immediately complying.
- You may glance at the slides they show and react ("That's a useful framework", "Can you explain that point again?") but you don't see the slides directly — judge from what they describe.

TOPICS THE ADVISOR IS EXPECTED TO COVER OVER THE FULL CONVERSATION (this is for context — don't bring them up yourself):
{topics_formatted}

Current progress: This is exchange #{covered_count + 1}. Early exchanges should be light/relational; financial depth comes later as the advisor earns it."""

    messages = _build_conversation_messages(conversation_history, advisor_message)

    # Use prompt caching on the system prompt (it's large and static per session).
    # Run in a thread so we don't block the async event loop.
    def _call() -> str:
        resp = _client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            system=[
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=messages,
        )
        return resp.content[0].text

    return await asyncio.to_thread(_call)


# ---------------------------------------------------------------------------
# Streaming variant — yields tokens as they arrive so the UI can render the
# client's response incrementally and start TTS sentence-by-sentence.
# ---------------------------------------------------------------------------

from typing import Awaitable, Callable  # noqa: E402  (deliberate late import)


def _build_simulate_system_prompt(
    persona: ClientPersona, conversation_history: list[dict], topics_formatted: str
) -> str:
    """Same prompt used by simulate_client_response. Extracted so the streaming
    variant doesn't drift from the non-streaming one."""
    covered_count = len([m for m in conversation_history if m.get("role") == "client"])
    return f"""You are roleplaying as {persona.name}, a {persona.age}-year-old {persona.marital_status} {persona.occupation}.

This is your FIRST meeting with this fiduciary advisor. You are a prospective client — you haven't signed any paperwork, you don't know this person yet, and you're here mostly to listen and decide whether you trust them enough to work together. The advisor is leading the meeting and will walk you through their firm's presentation deck before getting into your specific situation.

PERSONALITY: You are {persona.personality_type} and {persona.communication_style} in communication.
PRIVATE BACKGROUND (don't volunteer this — wait to be asked):
- Financial situation: {persona.financial_situation}, net worth: {persona.estimated_net_worth}
- Risk tolerance: {persona.risk_tolerance}
- Goals weighing on your mind: {", ".join(persona.primary_concerns) if persona.primary_concerns else "general financial planning"}
- Backstory: {persona.backstory}

BEHAVIOR GUIDELINES — read these carefully:
- Stay in character at ALL times. Never break character or mention you are an AI.
- Keep replies SHORT (1-3 sentences typically). Real prospective clients don't monologue, especially in the first few minutes.
- LET THE ADVISOR LEAD. Don't volunteer your goals, net worth, employment details, or family situation unless they specifically ask. If they're walking through slides, listen — react with brief questions or acknowledgements ("That makes sense", "What does that mean for someone like me?", "Hmm, okay").
- Open the conversation politely and a bit reserved — the way a real person would when meeting a stranger who's about to handle their money. Pleasantries, maybe small talk about your day or how you found the firm — NOT your retirement plan.
- Only share financial details proportional to what the advisor asks. If they ask "what brings you in today?", give a one-sentence high-level answer (e.g. "I've been thinking about retirement, my friend recommended you") — not your full backstory.
- Match your personality: if anxious, sound a little hesitant; if skeptical, ask "why should I trust you?"; if analytical, ask precise follow-up questions; if friendly, be warm but still cautious.
- If the advisor jumps straight to numbers without rapport, react naturally to that (slightly thrown off, redirect, etc.) — don't reward bad behavior by immediately complying.
- You may glance at the slides they show and react ("That's a useful framework", "Can you explain that point again?") but you don't see the slides directly — judge from what they describe.

TOPICS THE ADVISOR IS EXPECTED TO COVER OVER THE FULL CONVERSATION (this is for context — don't bring them up yourself):
{topics_formatted}

Current progress: This is exchange #{covered_count + 1}. Early exchanges should be light/relational; financial depth comes later as the advisor earns it."""


async def stream_client_response(
    persona: ClientPersona,
    conversation_history: list[dict],
    advisor_message: str,
    questionnaire_topics: list[dict],
    on_chunk: Callable[[str], Awaitable[None]],
) -> str:
    """Stream the simulated client's reply token-by-token.

    `on_chunk(text)` is awaited for each incremental text fragment. Returns
    the full concatenated text so the caller can persist it.
    """
    topics_formatted = _format_topics(questionnaire_topics)
    system_prompt = _build_simulate_system_prompt(persona, conversation_history, topics_formatted)
    messages = _build_conversation_messages(conversation_history, advisor_message)

    full: list[str] = []
    async with _async_client.messages.stream(
        model="claude-haiku-4-5-20251001",
        max_tokens=512,
        system=[
            {
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=messages,
    ) as stream:
        async for text in stream.text_stream:
            if not text:
                continue
            full.append(text)
            await on_chunk(text)
    return "".join(full)


# ---------------------------------------------------------------------------
# Session analysis
# ---------------------------------------------------------------------------

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
    transcript = "\n".join(transcript_lines) if transcript_lines else "(No conversation recorded)"

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

    system_prompt = """You are an expert fiduciary advisor trainer and compliance officer at Trajan Wealth, a registered investment advisory firm.

Analyze recorded training sessions between a Fiduciary Advisor and a simulated client. Provide objective, actionable feedback that helps advisors improve their client engagement, financial discovery, and compliance adherence.

Always respond with valid JSON only — no markdown fences, no preamble."""

    # Script adherence and slide walkthrough are FIRST-CLASS criteria. We
    # always ask the model to score them — when there is no active script or
    # no slide events, the model returns score=null and a feedback string
    # explaining the absence (so the UI can render an "N/A" state).
    script_block = (
        f"\nTRAINING SCRIPT (markdown — the advisor was expected to follow this):\n{script_content}\n"
        if script_content
        else "\nTRAINING SCRIPT: (no active script — score script_adherence as null with feedback 'No active training script for this session')\n"
    )
    slide_block = (
        f"\nSLIDE WALKTHROUGH TIMELINE (advisor's slide changes during the session):\n{slide_timeline}\n"
        if slide_events
        else "\nSLIDE WALKTHROUGH TIMELINE: (no slides shown — score slide_walkthrough as null with feedback 'No slides were navigated during this session')\n"
    )

    # Optional ASR-derived signals
    asr_block = ""
    if asr_transcript:
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

    user_prompt = f"""Analyze this training session between a Fiduciary Advisor and a simulated client.

CLIENT PROFILE:
{persona_summary}

FULL CONVERSATION TRANSCRIPT (live, from the browser):
{transcript}
{asr_block}{delivery_block}{script_block}{slide_block}

Provide a comprehensive evaluation in the following JSON format exactly. The
fields `script_adherence` and `slide_walkthrough` are MANDATORY top-level keys
— set their `score` to null (not zero) when the underlying artifact is absent,
but always include the key with a feedback string. When delivery metrics are
provided, fold pace / filler-word density / talk-time ratio into the
`communication_skills` score and reference the numeric metrics in its
feedback.

{{
  "overall_score": <float 1-10>,
  "categories": {{
    "rapport_building": {{"score": <1-10>, "feedback": "<specific feedback>"}},
    "financial_discovery": {{"score": <1-10>, "feedback": "<specific feedback>"}},
    "needs_analysis": {{"score": <1-10>, "feedback": "<specific feedback>"}},
    "product_knowledge": {{"score": <1-10>, "feedback": "<specific feedback>"}},
    "compliance_adherence": {{"score": <1-10>, "feedback": "<specific feedback>"}},
    "communication_skills": {{"score": <1-10>, "feedback": "<specific feedback grounded in pace/fillers if available>"}},
    "closing_skills": {{"score": <1-10>, "feedback": "<specific feedback>"}}
  }},
  "script_adherence": {{"score": <1-10 or null>, "feedback": "<how closely the advisor followed the active training script — cite specific deviations or wins; if no script say so>"}},
  "slide_walkthrough": {{"score": <1-10 or null>, "feedback": "<did the advisor present the slides in the right order, dwell appropriately on each, and reference them in the conversation? Use the slide timeline timestamps to ground your judgement. If no slides were shown say so.>"}},
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
            max_tokens=2048,
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
        return json.loads(raw_text)
    except json.JSONDecodeError:
        # Attempt to extract JSON object from the response
        match = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise ValueError(f"Could not parse analysis JSON from Claude response: {raw_text[:200]}")
