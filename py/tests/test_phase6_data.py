"""Phase-6 data contracts: recommendation-letter packets with sentence labels (mode C:
assertion without mechanism), planted cross-letter boilerplate and planted independence
violations. Ground truth holds by construction; held-out wordings are disjoint from dev."""

from __future__ import annotations

import itertools
import json
from pathlib import Path

import pytest

from adjudicate.hygiene import scan_for_pii
from adjudicate.schemas.letters import LetterReview, MeritsReview
from adjudicate.schemas.petition import export_json_schemas
from adjudicate.synth.letters import LetterCase, generate_letter_set

REPO = Path(__file__).resolve().parents[2]
SEED, HELDOUT_SEED, N = 20261114, 20261115, 16


@pytest.fixture(scope="module")
def dev() -> list[LetterCase]:
    return generate_letter_set(n=N, seed=SEED)


@pytest.fixture(scope="module")
def held() -> list[LetterCase]:
    return generate_letter_set(n=N, seed=HELDOUT_SEED, heldout=True)


@pytest.mark.parametrize("name", ["letter_packet", "letter_review", "merits_review"])
def test_letter_schemas_are_exported_and_committed(tmp_path: Path, name: str) -> None:
    export_json_schemas(tmp_path)
    committed = REPO / "web" / "lib" / "schemas" / f"{name}.schema.json"
    assert (tmp_path / f"{name}.schema.json").read_text() == committed.read_text()


def test_letter_review_rejects_unknown_labels_and_long_reasons() -> None:
    ok = {"sentences": [{"index": 0, "label": "assertion", "reason": "praise, no mechanism"}]}
    LetterReview.model_validate(ok)
    for bad in (
        {"sentences": [{"index": 0, "label": "praise", "reason": "x"}]},
        {"sentences": [{"index": -1, "label": "context", "reason": "x"}]},
        {"sentences": [{"index": 0, "label": "context", "reason": "x" * 400}]},
    ):
        with pytest.raises(ValueError):
            LetterReview.model_validate(bad)


def test_merits_review_needs_a_citation_and_bounded_risk() -> None:
    cite = {"chunk_id": 3, "decision_id": "SEP152026_01B2203", "quote": "y" * 40}
    ok = {
        "sustained_acclaim": False,
        "top_of_field": False,
        "risk": 0.7,
        "reasoning": "The record shows three criteria met by minimal evidence and no acclaim.",
        "citations": [cite],
    }
    MeritsReview.model_validate(ok)
    for bad in ({**ok, "citations": []}, {**ok, "risk": -0.1}):
        with pytest.raises(ValueError):
            MeritsReview.model_validate(bad)


def test_every_sentence_is_labelled_and_the_set_is_large_enough(dev: list[LetterCase]) -> None:
    kinds: list[str] = []
    for case in dev:
        for letter in case.packet.letters:
            assert len(case.kinds[letter.id]) == len(letter.sentences) >= 3
            kinds += case.kinds[letter.id]
    labels = [k.split("_")[0] for k in kinds]
    assert labels.count("assertion") >= 100 and labels.count("mechanism") >= 100
    # the cases a superlative lexicon gets wrong: they make the LLM earn its place
    assert kinds.count("assertion_plain") >= 25  # vague praise, no superlative word
    assert kinds.count("mechanism_superlative") >= 25  # superlative backed by a mechanism


def test_planted_boilerplate_pairs_share_a_block_and_others_share_no_sentence(
    dev: list[LetterCase],
) -> None:
    assert sum(len(c.planted_boilerplate) for c in dev) >= 8
    for case in dev:
        planted = set(case.planted_boilerplate)
        by_id = {lt.id: lt for lt in case.packet.letters}
        for a, b in itertools.combinations(sorted(by_id), 2):
            shared = set(by_id[a].sentences) & set(by_id[b].sentences)
            if (a, b) in planted:
                assert len(shared) >= 1, (case.packet.petition_id, a, b)  # one edited copy
            else:
                assert not shared, (case.packet.petition_id, a, b)


def test_planted_violations_are_claimed_independent_and_near_misses_exist(
    dev: list[LetterCase],
) -> None:
    violations = [v for c in dev for v in c.planted_violations]
    assert {v.kind for v in violations} == {"coauthor", "affiliation"}
    assert len(violations) >= 8
    near = [m for c in dev for m in c.near_misses]
    assert {m.kind for m in near} == {"surname", "organization"}
    for case in dev:
        by_id = {lt.id: lt for lt in case.packet.letters}
        for v in case.planted_violations:
            assert by_id[v.letter_id].author.claimed_independent
        for m in case.near_misses:
            assert by_id[m.letter_id].author.claimed_independent
        assert not {v.letter_id for v in case.planted_violations} & {
            m.letter_id for m in case.near_misses
        }


def test_letter_sets_are_deterministic_and_committed(
    dev: list[LetterCase], held: list[LetterCase]
) -> None:
    assert [c.to_json() for c in dev] == [c.to_json() for c in generate_letter_set(n=N, seed=SEED)]
    for name, cases in (("phase6_letters.json", dev), ("phase6_letters_heldout.json", held)):
        committed = json.loads((REPO / "eval" / "synthetic" / name).read_text())
        assert committed == [c.to_json() for c in cases], f"{name} drifted: run `make synth`"


def test_held_out_sentences_never_appear_in_dev(
    dev: list[LetterCase], held: list[LetterCase]
) -> None:
    def templates(cases: list[LetterCase]) -> set[str]:
        return {t for c in cases for t in c.templates_used}

    assert templates(dev).isdisjoint(templates(held))
    assert sum(len(c.planted_boilerplate) for c in held) >= 8
    assert {v.kind for c in held for v in c.planted_violations} == {"coauthor", "affiliation"}


def test_letter_sets_contain_no_pii(dev: list[LetterCase], held: list[LetterCase]) -> None:
    for case in [*dev, *held]:
        assert scan_for_pii(case.packet.model_dump_json()) == []
