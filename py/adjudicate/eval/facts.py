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

from pydantic import BaseModel, Field

from adjudicate.eval.realset import TestDecision
from adjudicate.parse.structure import Criterion
from adjudicate.schemas.petition import Artifact, EvidenceKind, Petition

MODEL = "anthropic/claude-haiku-5.5"
PLACEHOLDER = "Not described in the decision."

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


class ExtractedFacts(BaseModel):
    field: str = Field(min_length=1, max_length=120)
    artifacts: list[ExtractedArtifact] = Field(min_length=1, max_length=60)


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
    status: str  # ok | leaky
    attempts: int
    petition: Petition | None
    leaks: list[str] = field(default_factory=list)
    soft: list[str] = field(default_factory=list)
    placeholders: list[str] = field(default_factory=list)  # criteria with nothing described


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
        facts = client.complete_json(
            model, system=SYSTEM, user=user + feedback, schema=ExtractedFacts, max_tokens=6000
        )
        given = {a.criterion.value for a in facts.artifacts if a.criterion.value in claimed}
        return facts, hard_leaks(_text(facts)), [c for c in claimed if c not in given]

    attempts = 1
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
        return FactsOutcome(decision.decision_id, "leaky", attempts, None, leaks)
    artifacts = [a for a in facts.artifacts if a.criterion.value in claimed]
    artifacts += [
        ExtractedArtifact(criterion=Criterion(c), kind=EvidenceKind.OTHER, title="Evidence",
                          description=PLACEHOLDER)
        for c in missing
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
        placeholders=missing,
    )
