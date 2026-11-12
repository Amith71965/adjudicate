"""The real held-out set: a temporal split over EB-1A merits decisions.

Test = decided on or after the cutoff; the retrieval index used while examining them may only
contain decisions before it (the split guard checks every retrieved passage). Labels per
claimed criterion: the AAO's verdict where it decided the criterion; otherwise the Director's
finding stands (not reached, not addressed, waived on appeal); otherwise no label.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import psycopg

type Conn = psycopg.Connection[tuple[object, ...]]
CUTOFF = date(2026, 6, 1)
DECIDED = frozenset({"met", "not_met"})


@dataclass(frozen=True, slots=True)
class Label:
    label: str | None  # met | not_met | None (nobody decided it)
    source: str | None  # aao | director | None


@dataclass(frozen=True, slots=True)
class CriterionTruth:
    criterion: str
    director: str
    aao: str
    label: Label


@dataclass(frozen=True, slots=True)
class TestDecision:
    decision_id: str  # public id, e.g. JUL302026_01B2203
    decided: date
    outcome: str | None
    final_merits: str | None
    text: str
    criteria: tuple[CriterionTruth, ...]


@dataclass(frozen=True, slots=True)
class Split:
    cutoff: date
    test: tuple[TestDecision, ...]
    index_decision_ids: frozenset[str]  # every decision the index may draw on


def criterion_label(director: str, aao: str) -> Label:
    if aao in DECIDED:
        return Label(aao, "aao")
    if director in DECIDED:
        return Label(director, "director")
    return Label(None, None)


def load_split(conn: Conn, *, cutoff: date = CUTOFF) -> Split:
    rows = conn.execute(
        "SELECT d.id, r.decision_id, r.decision_date, d.outcome, e.final_merits, d.text"
        " FROM decision d JOIN raw_decision r ON r.id = d.raw_decision_id"
        " LEFT JOIN decision_extraction e ON e.decision_id = d.id"
        " WHERE r.visa_type = 'EB-1A' AND d.kind = 'merits' AND r.decision_date >= %s"
        " ORDER BY r.decision_date, r.decision_id",
        (cutoff,),
    ).fetchall()
    test: list[TestDecision] = []
    for db_id, did, decided, outcome, final_merits, text in rows:
        verdicts = conn.execute(
            "SELECT criterion::text, director::text, aao::text FROM criterion_verdict"
            " WHERE decision_id = %s ORDER BY criterion::text",
            (db_id,),
        ).fetchall()
        if not verdicts:
            raise ValueError(f"test decision {did} has no criterion verdicts: extract it first")
        criteria = tuple(
            CriterionTruth(str(c), str(d), str(a), criterion_label(str(d), str(a)))
            for c, d, a in verdicts
        )
        if not isinstance(decided, date):
            raise TypeError(f"{did}: decision_date is {decided!r}")
        test.append(
            TestDecision(
                decision_id=str(did),
                decided=decided,
                outcome=None if outcome is None else str(outcome),
                final_merits=None if final_merits is None else str(final_merits),
                text=str(text or ""),
                criteria=criteria,
            )
        )
    index = conn.execute(
        "SELECT r.decision_id FROM decision d JOIN raw_decision r ON r.id = d.raw_decision_id"
        " WHERE r.decision_date < %s",
        (cutoff,),
    ).fetchall()
    return Split(cutoff, tuple(test), frozenset(str(r[0]) for r in index))
