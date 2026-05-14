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

# Initialise the Anthropic client once at module load time.
_client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)


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

    system_prompt = f"""You are roleplaying as {persona.name}, a {persona.age}-year-old {persona.marital_status} {persona.occupation} seeking wealth management advice.

PERSONALITY: You are {persona.personality_type} and {persona.communication_style} in communication.
FINANCIAL PROFILE: {persona.financial_situation} financial situation, {persona.estimated_net_worth} net worth, {persona.risk_tolerance} risk tolerance.
PRIMARY GOALS: {", ".join(persona.primary_concerns) if persona.primary_concerns else "general financial planning"}
BACKSTORY: {persona.backstory}

BEHAVIOR GUIDELINES:
- Stay in character at ALL times as this specific client
- Your responses should be 1-4 sentences typically, natural conversational length
- Show personality: if anxious, express worry; if skeptical, push back; if analytical, ask detailed questions
- Gradually reveal financial information as trust builds - don't dump everything upfront
- If the advisor asks about topics you haven't mentioned, react naturally based on your personality
- You may occasionally go off-script with natural follow-up questions based on the conversation
- Never break character or mention you are an AI
- Reference your backstory naturally in conversation

CONVERSATION TOPICS TO COVER (work through these naturally):
{topics_formatted}

Current progress: You have covered approximately {covered_count} exchanges so far."""

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
# Session analysis
# ---------------------------------------------------------------------------

async def analyze_session(session: Any) -> dict:
    """Analyse a completed training session using claude-sonnet-4-6."""

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

    user_prompt = f"""Analyze this training session between a Fiduciary Advisor and a simulated client.

CLIENT PROFILE:
{persona_summary}

FULL CONVERSATION TRANSCRIPT:
{transcript}

Provide a comprehensive evaluation in the following JSON format exactly:
{{
  "overall_score": <float 1-10>,
  "categories": {{
    "rapport_building": {{"score": <1-10>, "feedback": "<specific feedback>"}},
    "financial_discovery": {{"score": <1-10>, "feedback": "<specific feedback>"}},
    "needs_analysis": {{"score": <1-10>, "feedback": "<specific feedback>"}},
    "product_knowledge": {{"score": <1-10>, "feedback": "<specific feedback>"}},
    "compliance_adherence": {{"score": <1-10>, "feedback": "<specific feedback>"}},
    "communication_skills": {{"score": <1-10>, "feedback": "<specific feedback>"}},
    "closing_skills": {{"score": <1-10>, "feedback": "<specific feedback>"}}
  }},
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
