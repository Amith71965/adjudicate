"""Phase-7 harness: the real TypeScript examiner is called over HTTP as a black box, every
retrieved passage is checked against the split, and failures surface instead of scoring."""

from __future__ import annotations

import json
from datetime import date

import httpx
import pytest

from adjudicate.eval.facts import FactsOutcome
from adjudicate.eval.harness import HarnessError, examine, rows_for, run, split_guard
from adjudicate.eval.realset import CriterionTruth, Label, Split, TestDecision
from adjudicate.schemas.petition import Artifact, EvidenceKind, Petition

CUT = date(2026, 6, 1)


def decision(did: str, crits: list[tuple[str, str | None]]) -> TestDecision:
    truth = tuple(
        CriterionTruth(c, "not_met", "not_met", Label(lab, "aao" if lab else None))
        for c, lab in crits
    )
    return TestDecision(did, date(2026, 7, 1), "dismissed", None, "text", truth)


def petition(crits: list[str]) -> Petition:
    arts = [
        Artifact(id=f"A{i + 1:02d}", kind=EvidenceKind.RECORD, title="t", description="d",
                 claimed_criterion=c)  # type: ignore[arg-type]
        for i, c in enumerate(crits)
    ]  # fmt: skip
    return Petition(id="P0001", visa="EB-1A", field="f", beneficiary="the beneficiary",
                    artifacts=arts)  # fmt: skip


RESULT = {
    "petition_id": "P0001",
    "criterion_risk": {"judging": 0.2, "awards": 0.9},
    "rfe_risk": 0.95,
    "reviews": [{"retrieved_chunk_ids": [1, 2],
                 "review": {"citations": [{"chunk_id": 2, "decision_id": "OLD1"}]}}],
    "dropped": [{"retrieved_chunk_ids": [3]}],
}  # fmt: skip


def test_examine_posts_the_petition_with_the_cutoff() -> None:
    seen: list[dict[str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(json.loads(req.content))
        return httpx.Response(200, json={"result": RESULT, "llm": {"calls": 4}})

    http = httpx.Client(base_url="http://web", transport=httpx.MockTransport(handler))
    out = examine(http, petition(["judging"]), CUT)
    assert out == ({"result": RESULT, "llm": {"calls": 4}})
    assert seen[0]["before"] == "2026-06-01"
    assert seen[0]["petition"]["id"] == "P0001"  # type: ignore[index]


@pytest.mark.parametrize("status", [400, 429, 500, 503])
def test_examine_raises_on_any_non_200(status: int) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": "boom"})

    http = httpx.Client(base_url="http://web", transport=httpx.MockTransport(handler))
    with pytest.raises(HarnessError, match=f"{status}.*boom"):
        examine(http, petition(["judging"]), CUT)


def test_split_guard_checks_every_retrieved_and_cited_passage() -> None:
    lookup = {1: "OLD1", 2: "OLD1", 3: "NEW9"}
    checked, violations = split_guard(
        RESULT, lambda ids: {i: lookup[i] for i in ids if i in lookup},
        index_ids=frozenset({"OLD1"}), test_ids=frozenset({"NEW9"}),
    )  # fmt: skip
    assert checked == 3
    assert violations == ["chunk 3 is from NEW9, a test decision"]
    _, unknown = split_guard(RESULT, lambda ids: {}, index_ids=frozenset(), test_ids=frozenset())
    assert "chunk 1 has no known decision" in unknown


def test_rows_carry_labels_risks_and_placeholders() -> None:
    d = decision("D1", [("awards", "not_met"), ("judging", "met")])
    facts = FactsOutcome("D1", "ok", 1, petition(["awards", "judging"]), placeholders=["awards"])
    rows = rows_for(d, facts, RESULT)
    assert [(r.criterion, r.label, r.risk, r.placeholder) for r in rows] == [
        ("awards", "not_met", 0.9, True),
        ("judging", "met", 0.2, False),
    ]
    assert all(r.risk is None for r in rows_for(d, facts, None))


def test_run_scores_examined_decisions_and_counts_leaky_ones_as_unpredicted() -> None:
    tests = (decision("D1", [("awards", "not_met")]), decision("D2", [("judging", "met")]))
    split = Split(CUT, tests, frozenset({"OLD1"}))

    def facts(d: TestDecision, i: int) -> FactsOutcome:
        if d.decision_id == "D2":
            return FactsOutcome("D2", "leaky", 2, None, ["the director"])
        return FactsOutcome("D1", "ok", 1, petition(["awards"]))

    calls: list[str] = []

    def exam(p: Petition, before: date) -> dict[str, object]:
        calls.append(p.id)
        return {"result": {**RESULT, "criterion_risk": {"awards": 0.9}}, "llm": {"calls": 1}}

    report = run(
        split, facts=facts, examine=exam, chunk_decisions=lambda ids: {i: "OLD1" for i in ids}
    )
    assert calls == ["P0001"]
    assert report["facts"]["ok"] == 1 and report["facts"]["leaky"] == 1
    assert report["split_guard"] == {"checked_chunks": 3, "violations": []}
    assert report["score"]["counts"]["unpredicted"] == 1
    assert [d["status"] for d in report["decisions"]] == ["examined", "leaky"]


def test_run_stops_on_a_split_guard_violation() -> None:
    split = Split(CUT, (decision("D1", [("awards", "not_met")]),), frozenset({"OLD1"}))
    with pytest.raises(HarnessError, match="split guard"):
        run(
            split,
            facts=lambda d, i: FactsOutcome("D1", "ok", 1, petition(["awards"])),
            examine=lambda p, b: {"result": RESULT, "llm": {}},
            chunk_decisions=lambda ids: {i: "D1" for i in ids},  # a test decision leaked in
        )


def test_run_fits_the_threshold_on_decisions_before_the_calibration_end() -> None:
    awards = CriterionTruth("awards", "not_met", "not_met", Label("not_met", "aao"))
    judging = CriterionTruth("judging", "met", "met", Label("met", "aao"))
    june = TestDecision("J1", date(2026, 6, 10), "dismissed", None, "t", (awards, judging))
    july = TestDecision("J2", date(2026, 7, 10), "dismissed", None, "t", (awards,))
    split = Split(CUT, (june, july), frozenset({"OLD1"}))
    risks = {"awards": 0.9, "judging": 0.6}
    report = run(
        split,
        facts=lambda d, i: FactsOutcome(d.decision_id, "ok", 1, petition(["awards", "judging"])),
        examine=lambda p, b: {"result": {**RESULT, "criterion_risk": risks}, "llm": {}},
        chunk_decisions=lambda ids: {i: "OLD1" for i in ids},
        calibration_end=date(2026, 7, 1),
    )
    cal = report["score"]["calibrated"]  # type: ignore[index]
    assert cal["fit_decisions"] == 1 and cal["test_decisions"] == 1 and cal["threshold"] == 0.9
    assert report["calibration_end"] == "2026-07-01"


def test_a_failed_extraction_is_counted_and_scored_as_unpredicted() -> None:
    split = Split(CUT, (decision("D1", [("awards", "not_met")]),), frozenset({"OLD1"}))
    report = run(
        split,
        facts=lambda d, i: FactsOutcome("D1", "failed", 1, None, error="invalid output"),
        examine=lambda p, b: pytest.fail("a failed extraction must not be examined"),
        chunk_decisions=lambda ids: {},
    )
    assert report["facts"]["failed"] == 1 and report["facts"]["ok"] == 0
    assert report["score"]["counts"]["unpredicted"] == 1
    assert report["decisions"][0]["status"] == "failed"
    assert report["decisions"][0]["error"] == "invalid output"
