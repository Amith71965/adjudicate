"""Phase-5 data contracts: the examiner's per-prong review schema and the seeded petition set
with planted mode-B halves (one prong of a two-part criterion unproven) and mode-D waivers
(evidence for a criterion nobody claims). Ground truth holds by construction."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from adjudicate.hygiene import scan_for_pii
from adjudicate.parse.structure import Criterion
from adjudicate.schemas.examiner import ProngReview
from adjudicate.schemas.petition import export_json_schemas
from adjudicate.synth.examiner import PRONG_IDS, generate_examiner_set

REPO = Path(__file__).resolve().parents[2]
SEED = 20261112
N = 16


def test_prong_review_schema_is_exported_and_committed(tmp_path: Path) -> None:
    export_json_schemas(tmp_path)
    committed = REPO / "web" / "lib" / "schemas" / "prong_review.schema.json"
    assert (tmp_path / "prong_review.schema.json").read_text() == committed.read_text()


def test_prong_review_requires_a_real_quote_and_at_least_one_citation() -> None:
    ok = {
        "established": False,
        "risk": 0.8,
        "objection": "The record does not show the organization's distinguished reputation.",
        "citations": [{"chunk_id": 7, "decision_id": "SEP152026_01B2203", "quote": "x" * 40}],
    }
    ProngReview.model_validate(ok)
    for bad in (
        {**ok, "citations": []},
        {**ok, "citations": [{**ok["citations"][0], "quote": "too short"}]},  # type: ignore[dict-item]
        {**ok, "risk": 1.2},
    ):
        with pytest.raises(ValueError):
            ProngReview.model_validate(bad)


def test_prong_ids_cover_exactly_the_two_part_criteria() -> None:
    assert set(PRONG_IDS) == {c for c in Criterion if c.two_part}
    assert PRONG_IDS[Criterion.LEADING_ROLE] == ("role", "reputation")


def test_each_petition_files_one_artifact_per_claimed_criterion_with_no_misfiles() -> None:
    for case in generate_examiner_set(n=N, seed=SEED):
        claimed = [a.claimed_criterion for a in case.petition.artifacts if a.claimed_criterion]
        assert 5 <= len(claimed) <= 7, case.petition.id
        assert len(claimed) == len(set(claimed)), case.petition.id
        for a in case.petition.artifacts:
            if a.claimed_criterion is not None:
                assert case.truth[a.id] == a.claimed_criterion  # mode A is Phase 4's job


def test_planted_halves_name_a_claimed_two_part_criterion_and_real_prongs() -> None:
    for case in generate_examiner_set(n=N, seed=SEED):
        assert case.planted_halves, case.petition.id
        by_id = {a.id: a for a in case.petition.artifacts}
        for half in case.planted_halves:
            art = by_id[half.artifact_id]
            assert art.claimed_criterion == half.criterion and half.criterion.two_part
            prongs = set(PRONG_IDS[half.criterion])
            assert half.missing_prongs and set(half.missing_prongs) <= prongs


def test_each_petition_plants_one_supported_but_unclaimed_criterion() -> None:
    for case in generate_examiner_set(n=N, seed=SEED):
        assert len(case.planted_unclaimed) == 1
        (u,) = case.planted_unclaimed
        art = next(a for a in case.petition.artifacts if a.id == u.artifact_id)
        assert art.claimed_criterion is None and case.truth[art.id] == u.criterion
        assert all(a.claimed_criterion != u.criterion for a in case.petition.artifacts)


def test_set_covers_every_two_part_half_and_keeps_full_controls() -> None:
    cases = generate_examiner_set(n=N, seed=SEED)
    halves = {h.criterion for c in cases for h in c.planted_halves}
    assert halves == set(PRONG_IDS)
    planted = {(c.petition.id, h.artifact_id) for c in cases for h in c.planted_halves}
    full = [
        a
        for c in cases
        for a in c.petition.artifacts
        if a.claimed_criterion in PRONG_IDS and (c.petition.id, a.id) not in planted
    ]
    assert len(full) >= 10  # fully evidenced two-part claims: the false-flag control


def test_set_yields_at_least_100_prong_reviews() -> None:
    reviews = sum(
        len(PRONG_IDS.get(a.claimed_criterion, ("whole",)))
        for c in generate_examiner_set(n=N, seed=SEED)
        for a in c.petition.artifacts
        if a.claimed_criterion is not None
    )
    assert reviews >= 100


def test_examiner_set_is_deterministic_and_committed() -> None:
    fresh = [c.to_json() for c in generate_examiner_set(n=N, seed=SEED)]
    assert fresh == [c.to_json() for c in generate_examiner_set(n=N, seed=SEED)]
    committed = json.loads((REPO / "eval" / "synthetic" / "phase5_petitions.json").read_text())
    assert committed == fresh, "phase-5 set drifted: run `make synth`"


def test_examiner_set_contains_no_pii() -> None:
    for case in generate_examiner_set(n=N, seed=SEED):
        assert scan_for_pii(case.petition.model_dump_json()) == []
