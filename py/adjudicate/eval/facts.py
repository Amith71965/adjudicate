"""Facts-only extraction: an AAO decision turned back into the evidence inventory the
petitioner filed, before anyone judged it. This is the leakage point of the whole eval — the
decision describes the evidence through an adjudicator who already knows the answer — so:
- the schema has no verdict field;
- a hard-leak lexicon (verdicts, procedure, sufficiency) rejects the extraction: one retry
  naming the words, then the decision is dropped and counted, never scored with a leak;
- weight words ("only", "merely") are counted and reported, not rejected.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel, Field, field_validator

from adjudicate.eval.realset import TestDecision
from adjudicate.llm.client import BudgetExceededError, LlmError, TruncatedError
from adjudicate.parse.structure import Criterion
from adjudicate.schemas.petition import Artifact, EvidenceKind, Petition

MODEL = "anthropic/claude-haiku-5.5"
PLACEHOLDER = "Not described in the decision."
FIELD_MAX = 120

# Whole words unless they end in "*" (stems). USCIS's Director is "the director", not a job title
# ("Director of Engineering") or a "Directory" printout — both seen in pilot extractions.
HARD = (
    "the director", "aao", "appeal", "appellate", "rfe", "request for evidence", "we find",
    "we agree", "we conclude", "we note", "not established", "did not establish",
    "does not establish", "has not established", "did not demonstrate", "does not demonstrate",
    "has not demonstrated", "insufficient", "sufficient", "deficien*", "persuasive", "probative",
    "fails to", "failed to", "fail to", "does not meet", "did not meet", "not met", "meets the",
    "satisfies", "satisfied", "denied", "denial", "remand*", "the record does not",
    "the record lacks", "lacks", "lacking", "credibility", "weight",
)  # fmt: skip
SOFT = ("only", "merely", "solely", "minimal", "limited", "little", "few", "generic", "routine")


def _hits(terms: tuple[str, ...], text: str) -> list[str]:
    def term(t: str) -> str:
        if t.endswith("*"):
            return re.escape(t[:-1])
        tail = r"(?![a-z])(?! of\b)" if t == "the director" else r"(?![a-z])"
        return re.escape(t) + tail

    pattern = re.compile(r"(?<![a-z])(" + "|".join(term(t) for t in terms) + r")", re.I)
    out: list[str] = []
    for m in pattern.finditer(text):
        word = m.group(1).lower()
        if word not in out:
            out.append(word)
    return out


def hard_leaks(text: str) -> list[str]:
    """Verdict, procedure or sufficiency language, in order of first appearance."""
    return _hits(HARD, text)


def soft_hits(text: str) -> list[str]:
    return _hits(SOFT, text)


class ExtractedArtifact(BaseModel):
    criterion: Criterion
    kind: EvidenceKind
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=1200)


def clip_words(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[: limit + 1].rsplit(" ", 1)[0]
    return (cut if cut else text[:limit]).rstrip(" ,;:(-")


class ExtractedFacts(BaseModel):
    field: str = Field(min_length=1, max_length=FIELD_MAX)
    artifacts: list[ExtractedArtifact] = Field(min_length=1, max_length=60)

    # a label, not evidence: an overlong one is clipped rather than failing the decision. A
    # validator, not a wider max_length, so the JSON schema (and every cache key) is unchanged.
    @field_validator("field", mode="before")
    @classmethod
    def _clip_field(cls, v: object) -> object:
        return clip_words(v, FIELD_MAX) if isinstance(v, str) else v


SYSTEM = """You turn a USCIS AAO decision on an EB-1A petition back into the evidence inventory the
petitioner's attorney filed, before anyone judged it. For each criterion listed, list the
documents filed under it: kind, a short title, and a neutral description of what the document is
and what it says on its face (who issued it, what it states, figures, dates, outlets, roles).
Write as the attorney listing exhibits, never as the adjudicator. Do not include any judgment of
whether evidence meets a criterion or of its weight, sufficiency or credibility; anything the
Director, the AAO or a request for evidence said; the appeal or its outcome; and words such as
insufficient, did not establish, fails, lacks, persuasive, only, merely. If the decision does not
describe the evidence for a listed criterion, give one artifact for it whose description is
exactly "Not described in the decision." Also give the beneficiary's field of endeavor."""


class JsonCompleter(Protocol):
    def complete_json[T: BaseModel](
        self, model: str, *, system: str, user: str, schema: type[T], max_tokens: int
    ) -> T: ...


@dataclass(slots=True)
class FactsOutcome:
    decision_id: str
    status: str  # ok | leaky | failed
    attempts: int
    petition: Petition | None
    leaks: list[str] = field(default_factory=list)
    soft: list[str] = field(default_factory=list)
    placeholders: list[str] = field(default_factory=list)  # criteria with nothing described
    error: str | None = None  # why a "failed" extraction failed


def _text(facts: ExtractedFacts) -> str:
    return "\n".join([facts.field, *(f"{a.title}. {a.description}" for a in facts.artifacts)])


def extract_facts(
    client: JsonCompleter, decision: TestDecision, *, index: int, model: str = MODEL
) -> FactsOutcome:
    claimed = [c.criterion for c in decision.criteria]
    user = (
        f"Criteria claimed: {', '.join(claimed)}\n\n"
        f"Decision {decision.decision_id}:\n{decision.text}"
    )

    def ask(feedback: str) -> tuple[ExtractedFacts, list[str], list[str]]:
        try:
            facts = client.complete_json(
                model, system=SYSTEM, user=user + feedback, schema=ExtractedFacts, max_tokens=6000
            )
        except TruncatedError:
            # long decisions can exhaust the budget on hidden reasoning: one larger try; the
            # default stays 6000 so already-cached extractions keep their cache keys
            facts = client.complete_json(
                model, system=SYSTEM, user=user + feedback, schema=ExtractedFacts, max_tokens=16000
            )
        given = {a.criterion.value for a in facts.artifacts if a.criterion.value in claimed}
        return facts, hard_leaks(_text(facts)), [c for c in claimed if c not in given]

    attempts = 1
    try:
        facts, leaks, missing = ask("")
        if leaks or missing:
            problems = []
            if leaks:
                problems.append(f"it used adjudication language: {', '.join(leaks)}")
            if missing:
                problems.append(f"it gave nothing for: {', '.join(missing)}")
            attempts = 2
            facts, leaks, missing = ask(
                f"\n\nYour previous answer was rejected because {'; and '.join(problems)}. "
                "Answer again following every rule."
            )
        if leaks:
            # the attempts above are unchanged so their cache keys hold; this one runs only for
            # decisions still leaking, and names the rule the system prompt left implicit
            attempts = 3
            facts, leaks, missing = ask(
                f"\n\nYour previous answers were rejected twice for adjudication language: "
                f"{', '.join(leaks)}. Do not say at what stage any document was filed or "
                "submitted (initially, in response to a request for evidence, on appeal or on "
                "motion), and do not mention any finding or conclusion. Describe each document "
                "only by what it is and what it says. Answer again following every rule."
            )
    except BudgetExceededError:
        raise  # the spend cap stops the run; it is not one decision's problem
    except LlmError as exc:
        # one unparseable answer must not abort 145 decisions: recorded, counted, gated
        # a fixed vocabulary: error messages can echo the model's (real-decision) text
        msg = str(exc)
        kind = ("invalid_output" if msg.startswith("invalid output")
                else "http" if msg.startswith("HTTP") else "other")  # fmt: skip
        return FactsOutcome(decision.decision_id, "failed", attempts, None,
                            error=f"{type(exc).__name__}: {kind}")  # fmt: skip
    if leaks:
        return FactsOutcome(decision.decision_id, "leaky", attempts, None, leaks)
    artifacts = [a for a in facts.artifacts if a.criterion.value in claimed]
    artifacts += [
        ExtractedArtifact(criterion=Criterion(c), kind=EvidenceKind.OTHER, title="Evidence",
                          description=PLACEHOLDER)
        for c in missing
    ]  # fmt: skip
    # the model is told to write PLACEHOLDER itself when nothing is described: those count too
    blank = PLACEHOLDER.lower().rstrip(".")
    placeholders = [
        c for c in claimed
        if all(a.description.strip().lower().rstrip(".") == blank
               for a in artifacts if a.criterion.value == c)
    ]  # fmt: skip
    petition = Petition(
        id=f"P{index:04d}",
        visa="EB-1A",
        field=facts.field,
        beneficiary="the beneficiary",
        artifacts=[
            Artifact(
                id=f"A{i + 1:02d}",
                kind=a.kind,
                title=a.title,
                description=a.description,
                claimed_criterion=a.criterion,
            )
            for i, a in enumerate(artifacts[:99])
        ],
    )
    return FactsOutcome(
        decision.decision_id,
        "ok",
        attempts,
        petition,
        soft=soft_hits(_text(facts)),
        placeholders=placeholders,
    )
