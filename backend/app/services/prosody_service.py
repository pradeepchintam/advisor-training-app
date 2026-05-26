"""Compute prosody / delivery metrics from a transcription_service result.

These are crisp, objective signals that complement Claude's qualitative
feedback: speaking pace (WPM), filler-word density, long-pause count, and
talk-time ratio. Returned as a dict ready to be persisted on
session.analysis["delivery_metrics"] and rendered in the UI.
"""
from __future__ import annotations

import re
from collections import Counter
from typing import Iterable

# Filler words to count. The browser-side ASR usually omits these but AWS
# Transcribe preserves them verbatim, which is exactly the signal we want.
FILLER_WORDS = {
    "um", "uh", "uhh", "umm", "ah", "er", "erm",
    "like", "basically", "literally", "actually", "honestly",
    "you know", "i mean", "kind of", "sort of",
}


def _is_filler(text: str) -> bool:
    return text.lower().strip(".,!?") in FILLER_WORDS


def _word_count_for(items: list[dict], speaker_label: str | None = None) -> int:
    if speaker_label is None:
        return len(items)
    return sum(1 for it in items if it.get("speaker") == speaker_label)


def _filler_counts(items: list[dict], speaker_label: str | None = None) -> Counter:
    c: Counter = Counter()
    for it in items:
        if speaker_label and it.get("speaker") != speaker_label:
            continue
        word = it.get("text", "").lower().strip(".,!?")
        if word in FILLER_WORDS:
            c[word] += 1
    return c


def _long_pauses(items: list[dict], speaker_label: str | None, threshold_s: float = 2.0) -> list[float]:
    """Pause lengths (seconds) within the speaker's own turns that exceed threshold."""
    speaker_items = (
        [it for it in items if it.get("speaker") == speaker_label]
        if speaker_label
        else items
    )
    pauses: list[float] = []
    for prev, cur in zip(speaker_items, speaker_items[1:]):
        gap = cur["start"] - prev["end"]
        if gap >= threshold_s:
            pauses.append(round(gap, 2))
    return pauses


def compute_delivery_metrics(transcription: dict) -> dict:
    """Return a prosody summary dict. Tolerant of empty input."""
    items: list[dict] = transcription.get("items", []) or []
    duration = float(transcription.get("duration_seconds") or 0.0)
    speakers = transcription.get("speakers", {}) or {}

    advisor_label = next((spk for spk, role in speakers.items() if role == "advisor"), None)
    client_label = next((spk for spk, role in speakers.items() if role == "client"), None)

    total_words = _word_count_for(items)
    advisor_words = _word_count_for(items, advisor_label) if advisor_label else 0
    client_words = _word_count_for(items, client_label) if client_label else 0

    # Speaking pace — words-per-minute over the advisor's spoken time only.
    advisor_spoken_seconds = 0.0
    if advisor_label:
        advisor_spoken_seconds = sum(
            (it["end"] - it["start"]) for it in items if it.get("speaker") == advisor_label
        )
    advisor_wpm = (
        advisor_words / (advisor_spoken_seconds / 60.0)
        if advisor_spoken_seconds > 0
        else None
    )

    fillers = _filler_counts(items, advisor_label)
    filler_total = sum(fillers.values())
    filler_per_min = (
        filler_total / (advisor_spoken_seconds / 60.0)
        if advisor_spoken_seconds > 0
        else None
    )

    long_pauses = _long_pauses(items, advisor_label)

    talk_time_ratio = (
        advisor_words / total_words if total_words > 0 else None
    )

    return {
        "duration_seconds": round(duration, 1),
        "advisor_words": advisor_words,
        "client_words": client_words,
        "advisor_spoken_seconds": round(advisor_spoken_seconds, 1),
        "advisor_wpm": round(advisor_wpm, 1) if advisor_wpm is not None else None,
        "talk_time_ratio_advisor": (
            round(talk_time_ratio, 2) if talk_time_ratio is not None else None
        ),
        "fillers_total": filler_total,
        "fillers_per_minute": (
            round(filler_per_min, 2) if filler_per_min is not None else None
        ),
        "fillers_top": fillers.most_common(5),
        "long_pauses_seconds": long_pauses,
        "long_pause_count": len(long_pauses),
    }


def format_metrics_for_prompt(metrics: dict) -> str:
    """Render a compact bullet list that the analyzer prompt can ingest."""
    lines = []
    if metrics.get("advisor_wpm") is not None:
        lines.append(f"- Advisor speaking pace: {metrics['advisor_wpm']} words per minute")
    if metrics.get("talk_time_ratio_advisor") is not None:
        pct = round(metrics["talk_time_ratio_advisor"] * 100)
        lines.append(
            f"- Talk-time split: advisor {pct}% / client {100 - pct}%"
        )
    if metrics.get("fillers_per_minute") is not None:
        lines.append(
            f"- Filler words: {metrics['fillers_total']} total "
            f"({metrics['fillers_per_minute']}/min); top: "
            f"{', '.join(f'{w}×{n}' for w, n in (metrics.get('fillers_top') or []))}"
        )
    if metrics.get("long_pause_count"):
        lines.append(
            f"- Long pauses (>2s): {metrics['long_pause_count']} "
            f"(lengths: {', '.join(str(s) for s in metrics['long_pauses_seconds'][:5])}s…)"
        )
    if not lines:
        return "(no delivery metrics available)"
    return "\n".join(lines)
