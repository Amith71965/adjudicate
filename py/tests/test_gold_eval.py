"""Field-level accuracy against hand-labelled gold verdicts (metric maths on synthetic data)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from adjudicate.parse.gold_eval import GoldLabel, accuracy_report, load_gold, score
from adjudicate.parse.structure import Criterion, Outcome
from adjudicate.parse.verdicts import CriterionVerdict, DecisionVerdicts, Verdict

GOLD = GoldLabel.model_validate(
    {
        "decision_id": "X",
        "outcome": "dismissed",
        "criteria": {
            "judging": {"director": "met", "aao": "met"},
            "leading_role": {"director": "not_met", "aao": "waived"},
        },
        "final_merits": "not_reached",
    }
)


def _pred(*rows: tuple[str, str, str], final: str = "not_reached") -> DecisionVerdicts:
    return DecisionVerdicts(
        criteria=[
            CriterionVerdict(
                criterion=Criterion(c), director=Verdict(d), aao=Verdict(a), quote="q" * 12
            )
            for c, d, a in rows
        ],
        final_merits=Verdict(final),
    )


def test_waived_is_a_valid_verdict() -> None:
    assert Verdict("waived") is Verdict.WAIVED


def test_perfect_prediction_scores_every_field() -> None:
    fields = score(
        GOLD,
        Outcome.DISMISSED,
        _pred(("judging", "met", "met"), ("leading_role", "not_met", "waived")),
    )
    # outcome + final_merits + 2 criteria x (director, aao)
    assert len(fields) == 6
    assert all(f.correct for f in fields)


def test_missing_criterion_counts_both_its_fields_wrong() -> None:
    fields = score(GOLD, Outcome.DISMISSED, _pred(("judging", "met", "met")))
    wrong = [f for f in fields if not f.correct]
    assert {(f.criterion, f.field) for f in wrong} == {
        (Criterion.LEADING_ROLE, "director"),
        (Criterion.LEADING_ROLE, "aao"),
    }


def test_extra_predicted_criterion_is_penalised() -> None:
    fields = score(
        GOLD,
        Outcome.DISMISSED,
        _pred(
            ("judging", "met", "met"),
            ("leading_role", "not_met", "waived"),
            ("awards", "not_met", "not_met"),
        ),
    )
    assert len(fields) == 8
    assert sum(not f.correct for f in fields) == 2


def test_wrong_outcome_and_final_merits_are_scored() -> None:
    fields = score(
        GOLD,
        Outcome.REMANDED,
        _pred(("judging", "met", "met"), ("leading_role", "not_met", "waived"), final="not_met"),
    )
    assert {f.field for f in fields if not f.correct} == {"outcome", "final_merits"}


def test_report_aggregates_accuracy_and_breakdown() -> None:
    a = score(GOLD, Outcome.DISMISSED, _pred(("judging", "met", "met")))  # 4/6
    b = score(
        GOLD,
        Outcome.DISMISSED,
        _pred(("judging", "met", "met"), ("leading_role", "not_met", "waived")),
    )  # 6/6
    report = accuracy_report([a, b])
    assert report.total == 12 and report.correct == 10
    assert report.accuracy == pytest.approx(10 / 12)
    assert report.by_field["aao"] == (3, 4)  # (correct, total)
    assert report.by_field["outcome"] == (2, 2)


def test_empty_report_is_an_error_not_a_perfect_score() -> None:
    with pytest.raises(ValueError, match="no fields"):
        accuracy_report([])


def test_load_gold_reads_the_committed_labels() -> None:
    labels = load_gold(Path(__file__).parent / "golden" / "labels")
    assert len(labels) == 25
    assert all(label.criteria for label in labels)


def test_load_gold_rejects_unknown_verdicts(tmp_path: Path) -> None:
    (tmp_path / "bad.json").write_text(
        json.dumps(
            {
                "decision_id": "B",
                "outcome": "dismissed",
                "criteria": {"judging": {"director": "maybe", "aao": "met"}},
                "final_merits": "not_reached",
            }
        )
    )
    with pytest.raises(ValueError, match="maybe"):
        load_gold(tmp_path)
