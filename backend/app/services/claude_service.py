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

async def simulate_client_response(
    persona: ClientPersona,
    conversation_history: list[dict],
    advisor_message: str,
    questionnaire_topics: list[dict],
) -> str:
    """Simulate a realistic client response using claude-haiku-4-5."""

    topics_formatted = _format_topics(questionnaire_topics)
    system_prompt = _build_simulate_system_prompt(persona, conversation_history, topics_formatted)
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


def _is_couple(persona: ClientPersona) -> bool:
    """True when both members of a couple are present on the persona."""
    return (
        getattr(persona, "client_type", "") == "couple"
        and bool(getattr(persona, "spouse_name", None))
        and bool(getattr(persona, "spouse_gender", None))
    )


def _build_simulate_system_prompt(
    persona: ClientPersona, conversation_history: list[dict], topics_formatted: str
) -> str:
    """Build the client-roleplay system prompt. Two flavors:
      • individual — single persona, no speaker tags expected.
      • couple — both members present; Claude prefixes every reply with
        ``[primary]`` or ``[spouse]`` so the backend can route TTS to the
        correct voice.
    """
    covered_count = len([m for m in conversation_history if m.get("role") == "client"])
    common_behavior = """\
BEHAVIOR GUIDELINES — read these carefully:
- Stay in character at ALL times. Never break character or mention you are an AI.
- Keep replies SHORT (1-3 sentences typically). Real prospective clients don't monologue, especially in the first few minutes.
- LET THE ADVISOR LEAD. Don't volunteer your goals, net worth, employment details, or family situation unless they specifically ask. If they're walking through slides, listen — react with brief questions or acknowledgements ("That makes sense", "What does that mean for someone like me?", "Hmm, okay").
- Open the conversation politely and a bit reserved — the way a real person would when meeting a stranger who's about to handle their money. Pleasantries, maybe small talk about your day or how you found the firm — NOT your retirement plan.
- Only share financial details proportional to what the advisor asks. If they ask "what brings you in today?", give a one-sentence high-level answer (e.g. "I've been thinking about retirement, my friend recommended you") — not your full backstory.
- Match your personality precisely.
- If the advisor jumps straight to numbers without rapport, react naturally to that (slightly thrown off, redirect, etc.) — don't reward bad behavior by immediately complying.
- You may glance at the slides they show and react ("That's a useful framework", "Can you explain that point again?") but you don't see the slides directly — judge from what they describe.

OUTPUT FORMAT — CRITICAL:
- Output ONLY what the client SAYS OUT LOUD. Plain spoken words.
- NEVER write stage directions, narration, emotes, or action descriptions of ANY kind. Do not use asterisks (*pauses briefly*), underscores (_smiles_), brackets ([sighs]), parentheses with non-speech ((nervously)), or any "tone:" / "action:" prefixes.
- No "I would say..." framing. Just say it directly.
- If you want to convey hesitation, write the spoken hesitation itself ("Well... um, yeah, I've thought about that") — never narrate it (NOT "*hesitates*").
"""

    progress = (
        f"Current progress: This is exchange #{covered_count + 1}. "
        "Early exchanges should be light/relational; financial depth comes "
        "later as the advisor earns it."
    )

    if not _is_couple(persona):
        # ---------- Single client -----------------------------------------
        return f"""You are roleplaying as {persona.name}, a {persona.age}-year-old {persona.marital_status} {persona.occupation}.

This is your FIRST meeting with this fiduciary advisor. You are a prospective client — you haven't signed any paperwork, you don't know this person yet, and you're here mostly to listen and decide whether you trust them enough to work together. The advisor is leading the meeting and will walk you through their firm's presentation deck before getting into your specific situation.

PERSONALITY: You are {persona.personality_type} and {persona.communication_style} in communication.
PRIVATE BACKGROUND (don't volunteer this — wait to be asked):
- Financial situation: {persona.financial_situation}, net worth: {persona.estimated_net_worth}
- Risk tolerance: {persona.risk_tolerance}
- Goals weighing on your mind: {", ".join(persona.primary_concerns) if persona.primary_concerns else "general financial planning"}
- Backstory: {persona.backstory}

{common_behavior}
TOPICS THE ADVISOR IS EXPECTED TO COVER OVER THE FULL CONVERSATION (this is for context — don't bring them up yourself):
{topics_formatted}

{progress}"""

    # ---------- Couple ----------------------------------------------------
    spouse_age = persona.spouse_age or "(unspecified)"
    spouse_personality = persona.spouse_personality_type or persona.personality_type
    spouse_occupation = persona.spouse_occupation or "(occupation unspecified)"
    return f"""You are roleplaying a COUPLE who has come together to this first meeting with a fiduciary advisor. They are a {persona.marital_status} couple. Speak for ONE of them per reply — choose whichever member would naturally speak next given the topic.

PRIMARY ({persona.name}): {persona.age}-year-old {persona.gender}, {persona.occupation}.
  Personality: {persona.personality_type}, {persona.communication_style}.
SPOUSE ({persona.spouse_name}): {spouse_age}-year-old {persona.spouse_gender}, {spouse_occupation}.
  Personality: {spouse_personality}.

This is your FIRST meeting with this fiduciary advisor. You haven't signed paperwork; you're listening and deciding whether to trust them. The advisor is leading and will walk you through their deck.

PRIVATE BACKGROUND (shared by the couple — don't volunteer; wait to be asked):
- Financial situation: {persona.financial_situation}, net worth: {persona.estimated_net_worth}
- Risk tolerance: {persona.risk_tolerance}
- Goals weighing on you: {", ".join(persona.primary_concerns) if persona.primary_concerns else "general financial planning"}
- Backstory: {persona.backstory}

COUPLE TURN-TAKING — CRITICAL:
- Each reply is from EXACTLY ONE speaker. Never write dialogue from both in a single reply.
- BEGIN every reply with a speaker tag on its own at the very start of the message:
    [primary]   if {persona.name} is speaking
    [spouse]    if {persona.spouse_name} is speaking
- The tag is NOT spoken aloud — it's metadata for the system. Put it as the very first thing in the reply, before any actual speech.
- Choose the speaker naturally: the more financially-engaged partner answers money questions; the more cautious/anxious partner asks worried questions; they alternate so neither dominates. If the advisor addresses someone by name, that person speaks. If unclear, alternate from the last speaker.
- Each reply is still SHORT (1-3 sentences) — the speaker isn't both the wife AND the husband.

EXAMPLES of correct couple replies:
    [primary] Honestly we've been worried about whether we have enough saved.
    [spouse] My biggest concern is that we don't have time to recover if the market drops.

{common_behavior}
TOPICS THE ADVISOR IS EXPECTED TO COVER OVER THE FULL CONVERSATION (this is for context — don't bring them up yourself):
{topics_formatted}

{progress}"""


class _StageDirectionStripper:
    """Streaming filter that drops stage-direction segments from the model's
    output before they reach the frontend (transcript + TTS).

    Drops any text wrapped in *...*, _..._, [...], or ((...)) — even when the
    opening and closing delimiter arrive in different stream chunks. Whatever
    can be definitively classified as 'inside' or 'outside' is flushed; bytes
    that could go either way (e.g., a lone trailing `*`) are buffered until
    the next chunk resolves them. The final `flush()` releases any remaining
    buffered text as plain speech (defensive — if the model never closed the
    direction, we'd rather speak it than swallow real content silently).
    """

    # Each entry: (opening char, closing char). Brackets and parens use single
    # chars; asterisks/underscores use the same char to open and close.
    _PAIRS = {"*": "*", "_": "_", "[": "]", "(": ")"}

    def __init__(self) -> None:
        self._buffer = ""
        # When inside a direction, this is the closer we're waiting for.
        self._waiting_close: str | None = None
        # Tracks "((" double-paren openings so we don't strip ordinary parens
        # (which legitimately appear in speech like "I (Pradeep) think...").
        self._double_paren = False

    def feed(self, text: str) -> str:
        if not text:
            return ""
        out: list[str] = []
        s = self._buffer + text
        self._buffer = ""
        i = 0
        n = len(s)
        while i < n:
            ch = s[i]
            if self._waiting_close is not None:
                # Inside a direction — discard characters until the closer.
                close = self._waiting_close
                if self._double_paren:
                    # Look for "))" specifically.
                    if ch == ")" and i + 1 < n and s[i + 1] == ")":
                        i += 2
                        self._waiting_close = None
                        self._double_paren = False
                        continue
                    if ch == ")" and i + 1 >= n:
                        # Can't tell if next char is ')' — buffer and wait.
                        self._buffer = s[i:]
                        return "".join(out)
                    i += 1
                    continue
                if ch == close:
                    i += 1
                    self._waiting_close = None
                    continue
                i += 1
                continue

            # Outside a direction — check for an opener.
            if ch == "*" or ch == "_":
                # Need next char to decide bold/italic block vs end of stream.
                # If end-of-stream, buffer the lone delimiter.
                if i + 1 >= n:
                    self._buffer = s[i:]
                    return "".join(out)
                self._waiting_close = self._PAIRS[ch]
                i += 1
                continue
            if ch == "[":
                self._waiting_close = "]"
                i += 1
                continue
            if ch == "(":
                # Only treat as direction when DOUBLED — ordinary single parens
                # are legitimate speech.
                if i + 1 >= n:
                    self._buffer = s[i:]
                    return "".join(out)
                if s[i + 1] == "(":
                    self._waiting_close = ")"
                    self._double_paren = True
                    i += 2
                    continue
                # Single paren — pass through.
                out.append(ch)
                i += 1
                continue
            out.append(ch)
            i += 1
        return "".join(out)

    def flush(self) -> str:
        """Release any remaining buffered text. Called at end of stream."""
        if self._waiting_close is not None:
            # Unclosed direction — discard everything left.
            self._buffer = ""
            self._waiting_close = None
            self._double_paren = False
            return ""
        leftover = self._buffer
        self._buffer = ""
        return leftover


_SPEAKER_TAG_RE = re.compile(r"^\s*\[(primary|spouse)\]\s*", re.IGNORECASE)


class _SpeakerTagParser:
    """Extract the leading ``[primary]`` / ``[spouse]`` tag from a streamed
    couple reply. The tag is buffered until enough characters have arrived
    to either match it or decide there isn't one — then either the speaker
    is detected (and stripped) or the buffered text is released verbatim.
    """

    def __init__(self) -> None:
        self._buffer = ""
        self._decided = False
        self.speaker: str | None = None  # "primary" | "spouse" | None

    def feed(self, text: str) -> str:
        if self._decided:
            return text
        self._buffer += text
        m = _SPEAKER_TAG_RE.match(self._buffer)
        if m:
            self.speaker = m.group(1).lower()
            self._decided = True
            remainder = self._buffer[m.end():]
            self._buffer = ""
            return remainder
        # No match yet — keep buffering only while a partial tag is still
        # plausible. The longest valid leading prefix of a tag is "[spouse]"
        # (8 chars including brackets). Anything past 16 chars without a
        # complete tag means there isn't one.
        if len(self._buffer) >= 16:
            self._decided = True
            out = self._buffer
            self._buffer = ""
            return out
        return ""

    def flush(self) -> str:
        if self._decided:
            return ""
        self._decided = True
        out = self._buffer
        self._buffer = ""
        return out


async def stream_client_response(
    persona: ClientPersona,
    conversation_history: list[dict],
    advisor_message: str,
    questionnaire_topics: list[dict],
    on_chunk: Callable[[str], Awaitable[None]],
    on_speaker: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    """Stream the simulated client's reply token-by-token, with stage
    directions filtered out before they reach the frontend.

    `on_chunk(text)` is awaited for each incremental text fragment. Returns
    the full concatenated (filtered) text so the caller can persist it.

    For couple personas, the LLM emits a leading ``[primary]`` / ``[spouse]``
    tag indicating which partner is speaking. We strip the tag, then fire
    ``on_speaker(speaker)`` so the WebSocket handler can tell the frontend
    which voice to use for this turn. Default speaker is ``primary``.
    """
    topics_formatted = _format_topics(questionnaire_topics)
    system_prompt = _build_simulate_system_prompt(persona, conversation_history, topics_formatted)
    messages = _build_conversation_messages(conversation_history, advisor_message)

    is_couple = _is_couple(persona)
    speaker_parser = _SpeakerTagParser() if is_couple else None
    stripper = _StageDirectionStripper()
    speaker_announced = False
    full: list[str] = []

    async def _emit(text: str) -> None:
        nonlocal speaker_announced
        if not text:
            return
        if is_couple and not speaker_announced and on_speaker is not None:
            # Default to primary if the model didn't tag the reply.
            who = (speaker_parser.speaker if speaker_parser else None) or "primary"
            await on_speaker(who)
            speaker_announced = True
        full.append(text)
        await on_chunk(text)

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
            # Layer 1: pull off the leading speaker tag (couples only).
            after_tag = speaker_parser.feed(text) if speaker_parser else text
            if not after_tag:
                continue
            # Layer 2: strip stage directions / asterisk narration.
            cleaned = stripper.feed(after_tag)
            await _emit(cleaned)
        trailing_tag = speaker_parser.flush() if speaker_parser else ""
        if trailing_tag:
            trailing = stripper.feed(trailing_tag)
            await _emit(trailing)
        trailing = stripper.flush()
        await _emit(trailing)

    # If we never emitted (e.g., empty model output for a couple), still
    # send the speaker so the frontend doesn't time out on a missing signal.
    if is_couple and not speaker_announced and on_speaker is not None:
        await on_speaker((speaker_parser.speaker if speaker_parser else None) or "primary")

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
