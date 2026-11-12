"""The committed Phase-7 results are the regression gate `make verify` runs offline: the split
held, the pipeline produced honest coverage, and the score has not fallen below the baseline."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from adjudicate.eval.score import regression_failures

RESULTS = Path(__file__).resolve().parents[2] / "eval" / "results"
TOLERANCE = 0.05


@pytest.fixture(scope="module")
def report() -> dict[str, object]:
    return json.loads((RESULTS / "phase7_real.json").read_text())  # type: ignore[no-any-return]


def test_the_split_held_on_every_retrieved_passage(report: dict) -> None:  # type: ignore[type-arg]
    # a violation raises inside the run, so a written report means none was found
    guard = report["split_guard"]
    assert guard["checked_chunks"] > 1000
    assert guard["examined_decisions"] == report["facts"]["ok"]
    assert report["test_decisions"] >= 140


def test_coverage_is_honest(report: dict) -> None:  # type: ignore[type-arg]
    facts, counts = report["facts"], report["score"]["counts"]
    assert facts["leaky"] <= 0.10 * report["test_decisions"]
    assert facts["failed"] <= 0.05 * report["test_decisions"]
    assert counts["unpredicted"] <= 0.05 * counts["labelled"]
    # unreviewed criteria score a default 1.0; a sensitivity block reports them excluded
    assert counts["unreviewed"] <= 0.10 * counts["labelled"]


def test_results_carry_no_fact_text(report: dict) -> None:  # type: ignore[type-arg]
    allowed = {"decision_id", "outcome", "status", "leaks", "error", "placeholders", "rfe_risk",
               "complete", "criteria"}  # fmt: skip
    for d in report["decisions"]:
        assert set(d) <= allowed
        assert d["error"] is None or re.fullmatch(r"[A-Za-z]+Error: [a-z_]+", d["error"])
        assert all(re.fullmatch(r"[a-z* ]+", w) for w in d["leaks"])  # lexicon words only


def test_no_regression_against_the_baseline(report: dict) -> None:  # type: ignore[type-arg]
    baseline = json.loads((RESULTS / "phase7_baseline.json").read_text())
    assert regression_failures(report["score"], baseline, tolerance=TOLERANCE) == []
