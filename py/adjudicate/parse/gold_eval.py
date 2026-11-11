"""Field-level accuracy of extraction against the hand-labelled gold set.

Fields: outcome, final_merits, and (director, aao) for every criterion in the gold
label OR the prediction. A missed criterion and an invented one both cost fields,
so accuracy cannot be gamed by predicting fewer — or more — criteria.
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import BaseModel, ValidationError

from adjudicate.parse.structure import Criterion, Outcome
from adjudicate.parse.verdicts import DecisionVerdicts, Verdict


class GoldCriterion(BaseModel):
    director: Verdict
    aao: Verdict


class GoldLabel(BaseModel):
    decision_id: str
    outcome: Outcome
    criteria: dict[Criterion, GoldCriterion]
    final_merits: Verdict
    notes: str = ""


@dataclass(frozen=True, slots=True)
class FieldScore:
    decision_id: str
    field: str  # outcome | final_merits | director | aao
    criterion: Criterion | None
    gold: str | None
    predicted: str | None

    @property
    def correct(self) -> bool:
        return self.gold == self.predicted


@dataclass(frozen=True, slots=True)
class AccuracyReport:
    correct: int
    total: int
    by_field: dict[str, tuple[int, int]] = field(default_factory=dict)
    errors: list[FieldScore] = field(default_factory=list)

    @property
    def accuracy(self) -> float:
        return self.correct / self.total


def load_gold(directory: Path) -> list[GoldLabel]:
    labels = []
    for path in sorted(directory.glob("*.json")):
        try:
            labels.append(GoldLabel.model_validate(json.loads(path.read_text())))
        except ValidationError as exc:
            raise ValueError(f"{path.name}: {exc}") from exc
    return labels


def score(gold: GoldLabel, outcome: Outcome, predicted: DecisionVerdicts) -> list[FieldScore]:
    did = gold.decision_id
    pred = {c.criterion: c for c in predicted.criteria}
    fields = [
        FieldScore(did, "outcome", None, gold.outcome.value, outcome.value),
        FieldScore(
            did, "final_merits", None, gold.final_merits.value, predicted.final_merits.value
        ),
    ]
    for criterion in sorted(set(gold.criteria) | set(pred), key=lambda c: c.paragraph):
        g, p = gold.criteria.get(criterion), pred.get(criterion)
        for name in ("director", "aao"):
            fields.append(
                FieldScore(
                    did,
                    name,
                    criterion,
                    getattr(g, name).value if g else None,
                    getattr(p, name).value if p else None,
                )
            )
    return fields


def accuracy_report(per_decision: list[list[FieldScore]]) -> AccuracyReport:
    flat = [f for fields in per_decision for f in fields]
    if not flat:
        raise ValueError("no fields to score")
    tally: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for f in flat:
        tally[f.field][0] += f.correct
        tally[f.field][1] += 1
    return AccuracyReport(
        correct=sum(f.correct for f in flat),
        total=len(flat),
        by_field={k: (v[0], v[1]) for k, v in tally.items()},
        errors=[f for f in flat if not f.correct],
    )
