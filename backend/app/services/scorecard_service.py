"""Scorecard definitions for the post-session analyzer.

Mirrors the printed Trajan Wealth scorecards (1st Meeting, AUM, Annuity)
plus a new Alternatives scorecard, all scored 1–5 per item. Each item is
either:

  • behavioral — judged from rapport / value / objection-handling /
    confidence / personality cues in the transcript + recording.
  • script    — judged against the deck's PDF script and (where applicable)
    verbatim cues.

The analyzer in claude_service.py loads the relevant scorecard(s) based on
the session's appointment_type, embeds the items + value-add rubric in the
Claude prompt, and asks the model to return a per-item score + feedback.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

ItemKind = Literal["script", "behavioral"]
ScorecardType = Literal["first_meeting", "aum", "annuity", "alternatives"]


@dataclass(frozen=True)
class ScorecardItem:
    key: str               # stable id for the item across versions
    label: str             # human-readable label, shown verbatim in UI
    kind: ItemKind         # script vs behavioral
    # Optional extras the analyzer prompt uses:
    verbatim_target: str | None = None   # exact text to compare against
    skip_when: str | None = None         # natural-language condition for N/A
    rubric_hint: str | None = None       # extra coaching context for this item


@dataclass(frozen=True)
class Scorecard:
    type: ScorecardType
    title: str
    items: tuple[ScorecardItem, ...]


# ---------------------------------------------------------------------------
# Value-add rubric (sourced from Value_Add_Session_One_Page_Handout.docx +
# Value_Add_1st_Appointments_Summary.docx). Embedded verbatim into the
# analyzer prompt so Claude grades the "Found opportunities to add value"
# item against the same criteria the live coach uses.
# ---------------------------------------------------------------------------
VALUE_ADD_RUBRIC = """\
What counts as a Value-Add Session (3–5 minute educational mini-session,
tied directly to facts the advisor uncovered):
  • Educational, not a sales pitch ("we have the best team to do this for you" is NOT value-add).
  • Robust — fully explains a concept; a one-liner or quick tip doesn't count.
  • Selfless in tone — no strings attached.
  • Tied to the prospect's specific situation (e.g., don't discuss Roth contributions with a 73-year-old taking RMDs).
  • Common topics: Traditional vs. Roth IRAs & 401(k); Social Security timing; emergency-fund planning;
    the 4% safe-withdrawal rule; cap rates on rentals; rate-of-savings vs. rate-of-return; tax tactics
    (Roth conversions, withdrawal sequencing); basic estate planning (probate, wills vs. trusts).
  • Timing: don't jump in the moment an opening appears — gather full context first, then teach
    BEFORE the final goals question. 1–2 per meeting is enough; never more than 3.
  • Delivery: jargon-free, structured (like training a new advisor), 3–5 minutes.
  • End with a check for understanding ("Does this make sense?"), NOT a call to action.
  • Goal: prospect leaves thinking "Nobody has explained it to me like that before."

Score 1 = no value-add attempted, or attempts were generic / sales-pitchy / off-topic.
Score 3 = at least one value-add attempt was made, tied loosely to the prospect.
Score 5 = 1–2 well-timed, deep, fact-tied value-add sessions that visibly land with the prospect.
"""


# ---------------------------------------------------------------------------
# The verbatim pre-close statement required at the end of the 1st Meeting.
# ---------------------------------------------------------------------------
PRE_CLOSE_VERBATIM = (
    "However, by the end of our next meeting, our plan will take shape and "
    "you'll learn everything you need to know to figure out if you want us "
    "to manage your investments; I feel confident you will like what you see "
    "and if you're comfortable with my recommendations, on that same meeting "
    "we will do paperwork to transfer your accounts over and start "
    "implementing the plan. Sound reasonable?"
)


# ---------------------------------------------------------------------------
# 1st Meeting scorecard
# ---------------------------------------------------------------------------
FIRST_MEETING_SCORECARD = Scorecard(
    type="first_meeting",
    title="1st Meeting Scorecard",
    items=(
        ScorecardItem(
            key="friendly_greeting",
            label="Friendly greeting and set expectations for time and thoroughness",
            kind="behavioral",
        ),
        ScorecardItem(
            key="fact_finding",
            label="Robust fact-finding questions",
            kind="behavioral",
        ),
        ScorecardItem(
            key="value_add",
            label="Found opportunities to add value based on prospect's situation",
            kind="behavioral",
            rubric_hint=VALUE_ADD_RUBRIC,
        ),
        ScorecardItem(
            key="prospect_focus",
            label="Focused on prospect and presented without thinking of the script",
            kind="behavioral",
        ),
        ScorecardItem(
            key="presentation_verbatim",
            label="Delivered presentation points verbatim",
            kind="script",
        ),
        ScorecardItem(
            key="family_office_under_one_roof",
            label='Emphasized "Family Office" / "Under One Roof"',
            kind="script",
            rubric_hint=(
                'Credit if the advisor used either phrase ("Family Office" or '
                '"Under One Roof") or both. The "Family Office" framing is preferred '
                'going forward but either earns the point.'
            ),
        ),
        ScorecardItem(
            key="pre_close_verbatim",
            label="Confident pre-close statement (verbatim)",
            kind="script",
            verbatim_target=PRE_CLOSE_VERBATIM,
            rubric_hint=(
                "This is a category on its own. Score against the verbatim target: "
                "5 = essentially word-for-word; 4 = minor paraphrase preserving every "
                "concept; 3 = covers most concepts but loses key phrasing; 2 = covers "
                "less than half; 1 = absent."
            ),
        ),
        ScorecardItem(
            key="double_confirm_next_appt",
            label="Double-confirmed next appointment time and date",
            kind="script",
        ),
        ScorecardItem(
            key="objection_handling",
            label="Objection and question handling",
            kind="behavioral",
        ),
        ScorecardItem(
            key="overall_confidence",
            label="Overall confidence",
            kind="behavioral",
        ),
        ScorecardItem(
            key="personality_likeability",
            label="Overall personality, likeability, excitement, and motivation",
            kind="behavioral",
        ),
    ),
)


# ---------------------------------------------------------------------------
# AUM Meeting scorecard — items 1-2 behavioral, 3-8 script, 9-14 behavioral.
# ---------------------------------------------------------------------------
AUM_SCORECARD = Scorecard(
    type="aum",
    title="AUM Meeting Scorecard",
    items=(
        ScorecardItem(key="aum_greeting",        label="Initial greeting and set expectations",                                  kind="behavioral"),
        ScorecardItem(key="aum_handle_qs",       label="Handled questions and points of clarification before going into presentation", kind="behavioral"),
        ScorecardItem(key="aum_team_approach",   label="Team Approach",                                                           kind="script"),
        ScorecardItem(key="aum_broker_vs_fid",   label="Broker vs. Fiduciary / Gave the importance of fee as a percentage",       kind="script"),
        ScorecardItem(key="aum_risk",            label="Risk / Assessed risk tolerance",                                          kind="script"),
        ScorecardItem(key="aum_invest_options",  label="Investment Options / Importance of expense ratios / Gave recommendation", kind="script"),
        ScorecardItem(key="aum_invest_mgmt",     label="Investment Management / Set right expectations / Custodian",              kind="script"),
        ScorecardItem(key="aum_last_thing",      label='Emphasized "The Last thing…"',                                            kind="script"),
        ScorecardItem(key="aum_portfolios",      label="Portfolios / Concise and to the point",                                   kind="behavioral"),
        ScorecardItem(key="aum_close_silence",   label="Close and silence",                                                       kind="behavioral"),
        ScorecardItem(key="aum_close_questions", label="Closing questions & transition statements",                               kind="behavioral"),
        ScorecardItem(key="aum_objections",      label="Objection and question handling",                                         kind="behavioral"),
        ScorecardItem(key="aum_stay_on_topic",   label="Kept meeting strictly within the AUM topic",                              kind="behavioral"),
        ScorecardItem(key="aum_overall",         label="Overall confidence, personality, likeability, excitement, and motivation",kind="behavioral"),
    ),
)


# ---------------------------------------------------------------------------
# Annuity scorecard — item 1 behavioral, 2-4 script, 5-9 behavioral.
# Income Rider auto-marked N/A when the conversation focused on protected
# growth only (no income rider needed for those clients).
# ---------------------------------------------------------------------------
ANNUITY_SCORECARD = Scorecard(
    type="annuity",
    title="Annuity Meeting Scorecard",
    items=(
        ScorecardItem(key="ann_greeting",   label="Initial greeting, set expectations, quick review",                        kind="behavioral"),
        ScorecardItem(key="ann_3_types",    label="3 Types of Annuities",                                                    kind="script"),
        ScorecardItem(key="ann_indexing",   label="Indexing",                                                                kind="script"),
        ScorecardItem(
            key="ann_income_rider",
            label="Income Rider / Set right expectations / clarified death benefit",
            kind="script",
            skip_when=(
                "The advisor and client established this is a PROTECTED GROWTH ONLY "
                "use case — no lifetime income is being recommended or requested. "
                "Indicators include the advisor explicitly framing the annuity as "
                "growth-only / accumulation-only, the persona stating they don't "
                "need additional income, or no mention of income / withdrawals in "
                "the conversation despite the topic being covered elsewhere. "
                "If applicable, mark this item N/A (applicable=false) rather than "
                "docking the advisor."
            ),
        ),
        ScorecardItem(key="ann_illustration",label="Illustration / concise and to the point",                                 kind="behavioral"),
        ScorecardItem(key="ann_close_reco",  label="Close & Recommendation",                                                  kind="behavioral"),
        ScorecardItem(key="ann_objections",  label="Objection and question handling",                                         kind="behavioral"),
        ScorecardItem(key="ann_confidence",  label="Overall confidence",                                                      kind="behavioral"),
        ScorecardItem(key="ann_personality", label="Overall personality, likeability, excitement, and motivation",            kind="behavioral"),
    ),
)


# ---------------------------------------------------------------------------
# Alternatives scorecard (new — script items derived from the attached deck's
# PDF script; behavioral items mirror Annuity per user spec).
# ---------------------------------------------------------------------------
ALTERNATIVES_SCORECARD = Scorecard(
    type="alternatives",
    title="Alternatives Meeting Scorecard",
    items=(
        ScorecardItem(key="alt_greeting",     label="Initial greeting, set expectations, quick review",                        kind="behavioral"),
        ScorecardItem(
            key="alt_pe_overview",
            label="Private Equity / Private Markets overview",
            kind="script",
            rubric_hint="Score against the alternatives deck's PDF script section covering Private Equity / Private Markets.",
        ),
        ScorecardItem(
            key="alt_diversification",
            label="Diversification rationale (why alternatives in a portfolio)",
            kind="script",
            rubric_hint="Score against the alternatives deck's PDF script section on diversification + illiquidity premium.",
        ),
        ScorecardItem(
            key="alt_risk_suitability",
            label="Risk, liquidity profile, and suitability for the client",
            kind="script",
            rubric_hint="Score against the alternatives deck's PDF script section on risks + suitability fit.",
        ),
        ScorecardItem(key="alt_illustration", label="Illustration / concise and to the point",                                kind="behavioral"),
        ScorecardItem(key="alt_close_reco",   label="Close & Recommendation",                                                 kind="behavioral"),
        ScorecardItem(key="alt_objections",   label="Objection and question handling",                                        kind="behavioral"),
        ScorecardItem(key="alt_confidence",   label="Overall confidence",                                                     kind="behavioral"),
        ScorecardItem(key="alt_personality",  label="Overall personality, likeability, excitement, and motivation",           kind="behavioral"),
    ),
)


SCORECARDS_BY_TYPE: dict[ScorecardType, Scorecard] = {
    "first_meeting": FIRST_MEETING_SCORECARD,
    "aum":           AUM_SCORECARD,
    "annuity":       ANNUITY_SCORECARD,
    "alternatives":  ALTERNATIVES_SCORECARD,
}


# ---------------------------------------------------------------------------
# Mapping session.appointment_type → which scorecards to run
# ---------------------------------------------------------------------------

def scorecards_for_appointment(appointment_type: str | None) -> list[Scorecard]:
    """Return the scorecards to evaluate for a given appointment type.

    Mapping:
      • "first"  → 1st Meeting scorecard
      • "second" → AUM scorecard
      • "third"  → BOTH Annuity AND Alternatives scorecards
                   (3rd appts currently show both decks; alternatives will
                    merge into a single meeting with annuity later)
      • None / unknown → default to 1st Meeting (matches the deck fallback)
    """
    if appointment_type == "first":
        return [FIRST_MEETING_SCORECARD]
    if appointment_type == "second":
        return [AUM_SCORECARD]
    if appointment_type == "third":
        return [ANNUITY_SCORECARD, ALTERNATIVES_SCORECARD]
    # Self-initiated or untyped — grade against the 1st Meeting scorecard
    # since that's also where the deck fallback lands.
    return [FIRST_MEETING_SCORECARD]


def format_scorecard_for_prompt(sc: Scorecard) -> str:
    """Render a scorecard as a numbered list block for the analyzer prompt."""
    lines = [f"=== {sc.title} (type: {sc.type}) ===\n"]
    for i, item in enumerate(sc.items, start=1):
        lines.append(f"{i}. [{item.kind.upper()}] {item.label}")
        lines.append(f"   key: {item.key}")
        if item.verbatim_target:
            lines.append(f"   verbatim_target: {item.verbatim_target!r}")
        if item.skip_when:
            lines.append(f"   skip_when: {item.skip_when}")
        if item.rubric_hint:
            lines.append(f"   rubric: {item.rubric_hint}")
        lines.append("")
    return "\n".join(lines)
