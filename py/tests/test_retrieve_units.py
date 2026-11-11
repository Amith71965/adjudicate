"""Chunking and reciprocal-rank fusion: pure functions, no DB, no model."""

from __future__ import annotations

import itertools

import pytest

from adjudicate.retrieve.chunk import CHUNKABLE_KINDS, chunk_section
from adjudicate.retrieve.rrf import recall_at_k, rrf


def _words(n: int) -> str:
    return " ".join(f"w{i}" for i in range(n))


class TestChunking:
    def test_short_section_is_one_chunk_with_exact_offsets(self) -> None:
        body = _words(50)
        chunks = chunk_section(body, section_start=1000)
        assert len(chunks) == 1
        assert (chunks[0].start_char, chunks[0].end_char) == (1000, 1000 + len(body))
        assert chunks[0].body == body

    def test_long_section_overlaps_and_covers_everything(self) -> None:
        body = _words(700)
        chunks = chunk_section(body, section_start=0, max_words=220, overlap=40)
        assert len(chunks) >= 4
        assert chunks[0].start_char == 0 and chunks[-1].end_char == len(body)
        for a, b in itertools.pairwise(chunks):
            assert b.start_char < a.end_char  # overlap, no gaps
        for c in chunks:
            assert body[c.start_char : c.end_char] == c.body
            assert len(c.body.split()) <= 220

    def test_empty_or_whitespace_section_yields_nothing(self) -> None:
        assert chunk_section("   \n ", section_start=5) == []

    def test_overlap_must_be_smaller_than_the_window(self) -> None:
        with pytest.raises(ValueError, match="overlap"):
            chunk_section(_words(10), section_start=0, max_words=20, overlap=20)

    def test_boilerplate_sections_are_not_chunked(self) -> None:
        assert "law" not in CHUNKABLE_KINDS and "preamble" not in CHUNKABLE_KINDS
        assert {"criterion", "final_merits", "reserved"} <= CHUNKABLE_KINDS


class TestRrf:
    def test_agreement_beats_a_single_first_place(self) -> None:
        fused = rrf([["a", "b", "c"], ["b", "a", "d"]])
        assert fused[:2] == ["a", "b"] or fused[:2] == ["b", "a"]
        assert fused.index("a") < fused.index("c") and fused.index("b") < fused.index("d")

    def test_item_in_both_lists_outranks_item_in_one(self) -> None:
        fused = rrf([["x", "shared"], ["shared", "y"]])
        assert fused[0] == "shared"

    def test_ties_are_broken_stably_by_first_appearance(self) -> None:
        assert rrf([["a"], ["b"]]) == ["a", "b"]

    def test_empty_lists(self) -> None:
        assert rrf([[], []]) == []

    def test_k_must_be_positive(self) -> None:
        with pytest.raises(ValueError):
            rrf([["a"]], k=0)


class TestRecall:
    def test_recall_at_k_over_queries(self) -> None:
        results = {"q1": ["d1", "d9"], "q2": ["d7", "d8", "d2"], "q3": []}
        relevant = {"q1": {"d1"}, "q2": {"d2"}, "q3": {"d3"}}
        assert recall_at_k(results, relevant, k=2) == pytest.approx(1 / 3)
        assert recall_at_k(results, relevant, k=3) == pytest.approx(2 / 3)

    def test_queries_without_relevance_labels_are_an_error(self) -> None:
        with pytest.raises(ValueError, match="q9"):
            recall_at_k({"q9": ["d1"]}, {}, k=10)
