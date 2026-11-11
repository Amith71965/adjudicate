"""The Phase-3 query set is well-formed, and the evaluator's metrics are correct."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from adjudicate.retrieve.evaluate import QUERIES, load_queries, mrr, score_mode

REPO = Path(__file__).resolve().parents[2]


def test_query_set_is_large_enough_and_well_formed() -> None:
    queries = load_queries(QUERIES)
    assert len(queries) >= 40
    assert len({q.id for q in queries}) == len(queries)
    assert all(q.query.strip() and q.relevant for q in queries)


def test_every_relevant_decision_is_a_hand_labelled_gold_decision() -> None:
    gold = set(json.loads((REPO / "py/tests/golden/selection.json").read_text())["decision_ids"])
    assert {d for q in load_queries(QUERIES) for d in q.relevant} <= gold


def test_queries_are_paraphrases_not_copies_of_the_decision_text() -> None:
    # Guard against a trivially lexical benchmark: no query may appear verbatim in its source.
    for q in load_queries(QUERIES):
        for did in q.relevant:
            text = " ".join((REPO / f"py/tests/golden/texts/{did}.txt").read_text().split()).lower()
            assert q.query.lower() not in text, q.id


def test_mrr() -> None:
    assert mrr(
        {"a": ["x", "d1"], "b": ["d2"], "c": ["y"]}, {"a": {"d1"}, "b": {"d2"}, "c": {"d3"}}
    ) == (pytest.approx((0.5 + 1.0 + 0.0) / 3))


def test_score_mode_reports_recall_at_several_cutoffs() -> None:
    results = {"a": ["d1"], "b": ["x"] * 9 + ["d2"]}
    relevant = {"a": {"d1"}, "b": {"d2"}}
    s = score_mode(results, relevant)
    assert s["recall@1"] == pytest.approx(0.5) and s["recall@10"] == pytest.approx(1.0)
    assert set(s) == {"recall@1", "recall@5", "recall@10", "mrr"}
