"""Amazon Nova Sonic — native speech-to-speech session wrapper.

Nova Sonic is a bidirectional streaming model on Bedrock: you stream raw
microphone PCM in and it streams the agent's *spoken* reply back, with the
LLM, ASR and TTS all inside one model. This replaces the STT -> Claude -> TTS
cascade with a single low-latency hop.

This wrapper owns ONE per-conversation bidirectional stream and exposes a
small queue-based interface the WebSocket handler drives:

    nova = NovaSonicSession(voice_id="tiffany", system_prompt=...)
    await nova.start()
    # writer task feeds raw mic PCM (16kHz mono LE16):
    await nova.send_audio(pcm_chunk)
    # reader task consumes typed events:
    async for ev in nova.events():
        ev.type in {"user_transcript","assistant_text","audio","interrupted","turn_complete","error"}
    await nova.close()

Protocol notes (validated against amazon.nova-sonic-v1:0, SDK 0.6.0):
  • promptStart MUST include toolUseOutputConfiguration + toolConfiguration.
  • the SYSTEM content block needs interactive=true.
  • input audio: audio/lpcm, 16kHz, 16-bit, mono, base64.
  • output audio: audio/lpcm, 24kHz, 16-bit, mono, base64.
  • a single long-lived AUDIO content block is opened once; Nova uses its own
    VAD to segment turns and to handle barge-in (it emits a contentEnd with
    stopReason=INTERRUPTED when the user talks over the agent).

Lazily imports the SDK so a missing dep never breaks app startup.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import uuid
from dataclasses import dataclass
from typing import AsyncIterator, Optional

from app.config import settings

logger = logging.getLogger("trajan.nova_sonic")


# Persona gender -> preset Nova voice. Nova has no age dial, so age/temperament
# is steered through the system prompt; gender maps to the closest preset.
_VOICE_BY_GENDER = {
    "female": "tiffany",
    "male": "matthew",
}
_DEFAULT_VOICE = "matthew"


def pick_voice(gender: str | None) -> str:
    g = (gender or "").strip().lower()
    return _VOICE_BY_GENDER.get(g, settings.NOVA_SONIC_VOICE_ID or _DEFAULT_VOICE)


def _pace_hint(age_group: str | None) -> str:
    if (age_group or "").strip().lower() in ("senior", "elderly"):
        return (" Speak a little slowly and deliberately, the way an older "
                "person often does, and take your time.")
    return ""


def build_nova_persona_prompt(persona) -> str:
    """Build a Nova Sonic system prompt from a ClientPersona.

    Mirrors the persona facts used by claude_service._build_simulate_system_prompt
    but framed for spoken speech-to-speech: the model voices the client(s) aloud,
    so we do NOT use the [primary]/[spouse] bracket tags (Nova would read them
    out loud). For couples, Nova voices both partners in one voice and signals
    who is speaking by name. Nova has no age dial, so age is steered behaviourally.
    """
    name = getattr(persona, "name", "the client")
    age = getattr(persona, "age", None)
    gender = getattr(persona, "gender", "")
    occupation = getattr(persona, "occupation", "") or "(occupation unspecified)"
    personality = getattr(persona, "personality_type", "") or "thoughtful"
    comm = getattr(persona, "communication_style", "") or "conversational"
    concerns = getattr(persona, "primary_concerns", None) or []
    concerns_str = ", ".join(concerns) if concerns else "general financial planning"
    backstory = (getattr(persona, "backstory", "") or "").strip()
    age_group = getattr(persona, "age_group", None)

    is_couple = (
        getattr(persona, "client_type", "") == "couple"
        and bool(getattr(persona, "spouse_name", None))
        and bool(getattr(persona, "spouse_gender", None))
    )

    # Hard role rules — repeated and explicit. Nova Sonic (like most assistant
    # models) has a strong prior to "be the helpful advisor"; in a financial
    # context it will start giving advice / running the meeting unless this is
    # forcefully suppressed. We anchor the CLIENT role at the top, restate the
    # DO-NOTs here, and close with it again (primacy + recency).
    role_rules = (
        "\n\nABSOLUTE ROLE RULES — these override everything else and never change:\n"
        "• YOU are the CLIENT/customer. The HUMAN speaking to you is the financial ADVISOR. "
        "They are the professional; you came to them for help.\n"
        "• NEVER act as the advisor. Do NOT give financial advice, recommend products, "
        "explain strategies, or 'walk through' anything — that is the advisor's job.\n"
        "• Do NOT run or lead the meeting and do NOT ask 'how can I help you?'. The advisor "
        "leads; you respond as their client.\n"
        "• If there is a silence or you happen to speak first, speak only as a client would "
        "when arriving for a meeting (a brief hello and maybe why you came in) — never as a "
        "host or professional welcoming them.\n"
        "• You are a real person seeking guidance, not an AI assistant. Don't be eager to "
        "'assist' or 'help' — you're the one who wants help."
    )

    common_tail = (
        f"\n\nPERSONALITY: {personality}; {comm} in communication."
        f"\nWhat's weighing on your mind: {concerns_str}."
        f"{(' Background: ' + backstory) if backstory else ''}"
        f"\n\nStay fully in character. Be realistic — warm but appropriately "
        f"cautious about money, ask the kinds of questions a real client would, "
        f"share concerns, and react naturally to what the advisor says. Keep "
        f"replies short and conversational, the way people actually talk out "
        f"loud — usually one to three sentences. Never break character, never "
        f"narrate actions, and never mention that you are an AI."
        f"{_pace_hint(age_group)}"
        f"{role_rules}"
        f"\n\nReminder: you are {name}, the CLIENT. The human is your ADVISOR. "
        f"Wait for them to lead, and respond as their client."
    )

    if not is_couple:
        age_str = f"a {age}-year-old " if age else ""
        return (
            f"You are role-playing ONLY as the wealth-management CLIENT named "
            f"{name}, {age_str}{gender} who works as {occupation}. The HUMAN you "
            f"are talking to is a financial ADVISOR you have come to see for help "
            f"with your money. You are the client/customer — you are NOT the "
            f"advisor and must never take the advisor's role." + common_tail
        )

    spouse_name = getattr(persona, "spouse_name", "your spouse")
    spouse_age = getattr(persona, "spouse_age", None)
    spouse_gender = getattr(persona, "spouse_gender", "")
    spouse_occupation = getattr(persona, "spouse_occupation", "") or "(occupation unspecified)"
    spouse_personality = getattr(persona, "spouse_personality_type", None) or personality
    sp_age_str = f"{spouse_age}-year-old " if spouse_age else ""
    age_str = f"{age}-year-old " if age else ""
    return (
        f"You are role-playing ONLY as a MARRIED COUPLE who are the CLIENTS, "
        f"meeting a financial ADVISOR (the human you are talking to) for help "
        f"with their money. You are the clients/customers — never the advisor. "
        f"You voice BOTH partners out loud in this one voice, so make it clear "
        f"who is speaking by using their name (e.g. start a line with their name "
        f"when the speaker changes).\n\n"
        f"PARTNER 1 — {name}: {age_str}{gender}, works as {occupation}. "
        f"Personality: {personality}.\n"
        f"PARTNER 2 — {spouse_name}: {sp_age_str}{spouse_gender}, works as "
        f"{spouse_occupation}. Personality: {spouse_personality}.\n"
        f"They sometimes agree, sometimes have slightly different worries, and "
        f"talk to each other as well as to the advisor." + common_tail
    )


@dataclass
class NovaEvent:
    """One event surfaced to the WS handler."""
    type: str               # user_transcript | assistant_text | audio | interrupted | turn_complete | error
    text: str = ""
    audio: bytes = b""      # raw PCM16 @24kHz for type == "audio"


def is_available() -> bool:
    """True if the bidirectional SDK is importable. Used to 502 cleanly."""
    try:
        import aws_sdk_bedrock_runtime.client  # noqa: F401
        return True
    except ImportError:
        return False


class NovaSonicSession:
    def __init__(
        self,
        *,
        system_prompt: str,
        voice_id: str | None = None,
        region: str | None = None,
        model_id: str | None = None,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        top_p: float = 0.9,
    ):
        self._system_prompt = system_prompt
        self._voice_id = voice_id or (settings.NOVA_SONIC_VOICE_ID or _DEFAULT_VOICE)
        self._region = region or settings.NOVA_SONIC_REGION or "us-east-1"
        self._model_id = model_id or settings.NOVA_SONIC_MODEL_ID
        self._max_tokens = max_tokens
        self._temperature = temperature
        self._top_p = top_p

        self._prompt_name = str(uuid.uuid4())
        self._sys_content = str(uuid.uuid4())
        self._audio_content = str(uuid.uuid4())

        self._stream = None
        self._send_lock = asyncio.Lock()
        self._queue: asyncio.Queue[NovaEvent] = asyncio.Queue()
        self._reader_task: Optional[asyncio.Task] = None
        self._closed = False

    # ------------------------------------------------------------------ #
    # lifecycle
    # ------------------------------------------------------------------ #
    async def start(self) -> None:
        from aws_sdk_bedrock_runtime.client import (
            BedrockRuntimeClient,
            InvokeModelWithBidirectionalStreamOperationInput,
        )
        from aws_sdk_bedrock_runtime.config import Config
        from smithy_aws_core.identity import AWSCredentialsIdentity
        from smithy_aws_core.identity.static import StaticCredentialsResolver

        # Resolve AWS credentials via boto3's default provider chain: environment
        # variables locally, and the EC2 instance role (IMDS) in production —
        # where AWS_ACCESS_KEY_ID/SECRET are NOT set. This is why Nova works both
        # on a laptop (env keys) and on EC2 (instance role) unchanged.
        import boto3  # already a dependency; battle-tested credential chain
        botocreds = boto3.Session(region_name=self._region).get_credentials()
        if botocreds is None:
            raise RuntimeError(
                "No AWS credentials available for Nova Sonic (checked env vars, "
                "shared profile, container, and EC2 instance role)."
            )
        frozen = botocreds.get_frozen_credentials()
        ak, sk, st = frozen.access_key, frozen.secret_key, frozen.token

        # The stock StaticCredentialsResolver reads keys from identity
        # *properties* (which the client never populates), so resolve directly.
        class _Resolver(StaticCredentialsResolver):
            def __init__(self):
                self._id = AWSCredentialsIdentity(
                    access_key_id=ak, secret_access_key=sk, session_token=st
                )

            async def get_identity(self, *, properties=None):
                return self._id

        config = Config(
            endpoint_uri=f"https://bedrock-runtime.{self._region}.amazonaws.com",
            region=self._region,
            aws_credentials_identity_resolver=_Resolver(),
        )
        client = BedrockRuntimeClient(config=config)
        self._stream = await client.invoke_model_with_bidirectional_stream(
            InvokeModelWithBidirectionalStreamOperationInput(model_id=self._model_id)
        )

        # Init sequence: sessionStart -> promptStart -> system prompt -> open
        # the long-lived audio content block.
        await self._send({"event": {"sessionStart": {"inferenceConfiguration": {
            "maxTokens": self._max_tokens, "topP": self._top_p,
            "temperature": self._temperature}}}})
        await self._send({"event": {"promptStart": {
            "promptName": self._prompt_name,
            "textOutputConfiguration": {"mediaType": "text/plain"},
            "audioOutputConfiguration": {
                "mediaType": "audio/lpcm", "sampleRateHertz": 24000,
                "sampleSizeBits": 16, "channelCount": 1,
                "voiceId": self._voice_id, "encoding": "base64",
                "audioType": "SPEECH"},
            "toolUseOutputConfiguration": {"mediaType": "application/json"},
            "toolConfiguration": {"tools": []},
        }}})
        await self._send({"event": {"contentStart": {
            "promptName": self._prompt_name, "contentName": self._sys_content,
            "type": "TEXT", "role": "SYSTEM", "interactive": True,
            "textInputConfiguration": {"mediaType": "text/plain"}}}})
        await self._send({"event": {"textInput": {
            "promptName": self._prompt_name, "contentName": self._sys_content,
            "content": self._system_prompt}}})
        await self._send({"event": {"contentEnd": {
            "promptName": self._prompt_name, "contentName": self._sys_content}}})
        await self._send({"event": {"contentStart": {
            "promptName": self._prompt_name, "contentName": self._audio_content,
            "type": "AUDIO", "interactive": True, "role": "USER",
            "audioInputConfiguration": {
                "mediaType": "audio/lpcm", "sampleRateHertz": 16000,
                "sampleSizeBits": 16, "channelCount": 1,
                "audioType": "SPEECH", "encoding": "base64"}}}})

        self._reader_task = asyncio.create_task(self._read_loop())
        logger.info("Nova Sonic session started voice=%s region=%s",
                    self._voice_id, self._region)

    async def _send(self, payload: dict) -> None:
        from aws_sdk_bedrock_runtime.models import (
            InvokeModelWithBidirectionalStreamInputChunk,
            BidirectionalInputPayloadPart,
        )
        if self._stream is None or self._closed:
            return
        chunk = InvokeModelWithBidirectionalStreamInputChunk(
            value=BidirectionalInputPayloadPart(
                bytes_=json.dumps(payload).encode("utf-8"))
        )
        async with self._send_lock:
            await self._stream.input_stream.send(chunk)

    async def send_audio(self, pcm_chunk: bytes) -> None:
        """Forward one raw PCM16 @16kHz mic chunk to Nova."""
        if not pcm_chunk or self._closed:
            return
        try:
            await self._send({"event": {"audioInput": {
                "promptName": self._prompt_name,
                "contentName": self._audio_content,
                "content": base64.b64encode(pcm_chunk).decode("utf-8")}}})
        except Exception as e:  # noqa: BLE001
            logger.warning("Nova send_audio failed: %s", e)

    # ------------------------------------------------------------------ #
    # reader
    # ------------------------------------------------------------------ #
    async def _read_loop(self) -> None:
        try:
            output = await self._stream.await_output()
            while not self._closed:
                result = await output[1].receive()
                if result is None:
                    continue
                if result.value is None or result.value.bytes_ is None:
                    continue
                data = json.loads(result.value.bytes_.decode("utf-8"))
                ev = data.get("event", {})
                key = next(iter(ev), None)
                if key == "textOutput":
                    role = ev["textOutput"].get("role", "")
                    content = ev["textOutput"].get("content", "")
                    # Nova marks barge-in inside textOutput content as a JSON
                    # sentinel on some versions; otherwise via contentEnd below.
                    if role == "USER":
                        await self._queue.put(NovaEvent("user_transcript", text=content))
                    elif role == "ASSISTANT":
                        await self._queue.put(NovaEvent("assistant_text", text=content))
                elif key == "audioOutput":
                    pcm = base64.b64decode(ev["audioOutput"]["content"])
                    await self._queue.put(NovaEvent("audio", audio=pcm))
                elif key == "contentEnd":
                    stop = ev["contentEnd"].get("stopReason", "")
                    if stop == "INTERRUPTED":
                        await self._queue.put(NovaEvent("interrupted"))
                    elif stop in ("END_TURN", "PARTIAL_TURN"):
                        await self._queue.put(NovaEvent("turn_complete"))
                elif key in ("modelStreamErrorException", "internalServerException",
                             "validationException", "throttlingException"):
                    msg = json.dumps(ev[key])[:300]
                    logger.warning("Nova error event %s: %s", key, msg)
                    await self._queue.put(NovaEvent("error", text=f"{key}: {msg}"))
                # completionStart / completionEnd / usageEvent / contentStart are
                # informational; we don't forward them.
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.info("Nova reader stopped: %s: %s", type(e).__name__, e)
            try:
                await self._queue.put(NovaEvent("error", text=str(e)))
            except Exception:
                pass

    async def events(self) -> AsyncIterator[NovaEvent]:
        while not self._closed:
            try:
                ev = await asyncio.wait_for(self._queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            yield ev

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._stream is not None:
            try:
                await self._send({"event": {"contentEnd": {
                    "promptName": self._prompt_name,
                    "contentName": self._audio_content}}})
                await self._send({"event": {"promptEnd": {
                    "promptName": self._prompt_name}}})
                await self._send({"event": {"sessionEnd": {}}})
                await self._stream.input_stream.close()
            except Exception:
                pass
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
