"""Phase-4 data contracts: shared schemas (Pydantic → JSON Schema → Zod) and the seeded
synthetic petition set whose ground truth holds by construction."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from adjudicate.hygiene import scan_for_pii
from adjudicate.parse.structure import Criterion
from adjudicate.schemas.petition import Petition, PetitionMapping, export_json_schemas
from adjudicate.synth.petitions import generate_set

REPO = Path(__file__).resolve().parents[2]
SCHEMA_DIR = REPO / "web" / "lib" / "schemas"


def test_json_schema_export_is_deterministic_and_committed(tmp_path: Path) -> None:
    export_json_schemas(tmp_path)
    for name in ("petition.schema.json", "petition_mapping.schema.json"):
        fresh = (tmp_path / name).read_text()
        assert fresh == (SCHEMA_DIR / name).read_text(), f"{name} drifted: run `make schemas`"


def test_set_is_deterministic_per_seed() -> None:
    a, b = generate_set(n=3, seed=1), generate_set(n=3, seed=1)
    assert [p.petition.model_dump() for p in a] == [p.petition.model_dump() for p in b]
    assert generate_set(n=3, seed=2)[0].petition != a[0].petition


def test_every_petition_is_valid_and_has_planted_mode_a_mismatches() -> None:
    for case in generate_set(n=20, seed=20261111):
        Petition.model_validate(case.petition.model_dump())
        assert 6 <= len(case.petition.artifacts) <= 10
        assert case.planted_mismatches, case.petition.id
        for art in case.petition.artifacts:
            truth = case.truth[art.id]
            if art.id in case.planted_mismatches:
                assert art.claimed_criterion is not None and art.claimed_criterion != truth
            else:
                assert art.claimed_criterion == truth


def test_the_set_covers_every_criterion_and_includes_decoys() -> None:
    cases = generate_set(n=20, seed=20261111)
    truths = [t for c in cases for t in c.truth.values()]
    assert set(Criterion) <= set(truths)
    assert None in truths  # artifacts that support no criterion at all


def test_synthetic_petitions_contain_no_pii() -> None:
    for case in generate_set(n=20, seed=20261111):
        assert scan_for_pii(case.petition.model_dump_json()) == []


def test_mapping_schema_requires_all_ten_scores_per_artifact() -> None:
    bad = {
        "petition_id": "P01",
        "mappings": [
            {
                "artifact_id": "A01",
                "best_criterion": "judging",
                "strength": 0.9,
                "rationale": "r",
                "scores": [{"criterion": "judging", "strength": 0.9}],
            }
        ],
    }
    with pytest.raises(ValueError):
        PetitionMapping.model_validate(bad)


def test_committed_synthetic_set_matches_the_generator() -> None:
    committed = json.loads((REPO / "eval" / "synthetic" / "phase4_petitions.json").read_text())
    fresh = [c.to_json() for c in generate_set(n=20, seed=20261111)]
    assert committed == fresh, "synthetic set drifted: run `make synth`"
