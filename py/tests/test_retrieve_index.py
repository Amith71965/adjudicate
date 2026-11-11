"""Chunk index + hybrid search against parsed fixture decisions in a scratch DB."""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from adjudicate.migrate import apply_migrations
from adjudicate.parse.pipeline import parse_pending
from adjudicate.retrieve.index import build_index
from adjudicate.retrieve.search import SearchMode, search

pytestmark = pytest.mark.db

FIX = Path(__file__).parent / "fixtures" / "decisions"
REPO_MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
FIXTURES = {
    "SEP152026_01B2203": "EB-1A",
    "SEP172026_06B2203": "EB-1A",
    "JUN092025_02B5203": "EB-2/NIW",  # motion: must never be indexed
}

type Conn = psycopg.Connection[tuple[object, ...]]


class FakeEmbedder:
    """Deterministic hashed bag-of-words, unit-normalised: similarity ≈ word overlap."""

    name = "fake-bow-384"
    dim = 384

    def _vec(self, text: str) -> list[float]:
        v = [0.0] * self.dim
        for w in re.findall(r"[a-z]{3,}", text.lower()):
            v[int(hashlib.sha256(w.encode()).hexdigest(), 16) % self.dim] += 1.0
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / norm for x in v]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vec(text)


@pytest.fixture
def db(scratch_db_url: str) -> Iterator[Conn]:
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, REPO_MIGRATIONS)
        for did, visa in FIXTURES.items():
            body = (FIX / f"{did}.pdf").read_bytes()
            conn.execute(
                "INSERT INTO raw_decision (url, decision_id, category, visa_type, content, sha256,"
                " byte_size, fetched_at) VALUES (%s, %s, 'c', %s, %s, %s, %s, now())",
                (
                    f"https://www.uscis.gov/{did}.pdf",
                    did,
                    visa,
                    body,
                    hashlib.sha256(body).hexdigest(),
                    len(body),
                ),
            )
        parse_pending(conn)
        yield conn


def _scalar(conn: Conn, sql: str) -> int:
    row = conn.execute(sql).fetchone()
    assert row is not None
    return int(str(row[0]))


def test_index_chunks_and_embeds_only_merits_reasoning(db: Conn) -> None:
    stats = build_index(db, FakeEmbedder())
    assert stats.chunks > 0 and stats.embedded == stats.chunks
    kinds = {
        str(k)
        for (k,) in db.execute(
            "SELECT DISTINCT s.kind FROM chunk c JOIN decision_section s"
            " ON s.decision_id = c.decision_id AND s.ordinal = c.section_ordinal"
        )
    }
    assert "law" not in kinds and "preamble" not in kinds
    assert (
        _scalar(
            db,
            "SELECT count(*) FROM chunk c JOIN decision d ON d.id = c.decision_id"
            " WHERE d.kind <> 'merits'",
        )
        == 0
    )


def test_chunk_bodies_are_exact_slices_of_the_decision(db: Conn) -> None:
    build_index(db, FakeEmbedder())
    rows = db.execute(
        "SELECT c.body, c.start_char, c.end_char, d.text FROM chunk c"
        " JOIN decision d ON d.id = c.decision_id"
    ).fetchall()
    assert rows and all(str(t)[int(str(s)) : int(str(e))] == b for b, s, e, t in rows)


def test_index_is_idempotent_and_records_the_model(db: Conn) -> None:
    build_index(db, FakeEmbedder())
    again = build_index(db, FakeEmbedder())
    assert (again.chunks, again.embedded) == (0, 0)
    assert {str(m) for (m,) in db.execute("SELECT DISTINCT embed_model FROM chunk")} == {
        "fake-bow-384"
    }


def test_changing_the_model_re_embeds(db: Conn) -> None:
    build_index(db, FakeEmbedder())

    class Other(FakeEmbedder):
        name = "fake-bow-384-v2"

    stats = build_index(db, Other())
    assert stats.chunks == 0 and stats.embedded > 0


@pytest.mark.parametrize("mode", list(SearchMode))
def test_search_finds_the_stage_two_decision(db: Conn, mode: SearchMode) -> None:
    build_index(db, FakeEmbedder())
    hits = search(
        db,
        FakeEmbedder(),
        "sustained national acclaim final merits determination totality",
        k=5,
        mode=mode,
    )
    assert hits, mode
    assert hits[0].decision_id in {"SEP172026_06B2203", "SEP152026_01B2203"}
    top = hits[0]
    assert top.url.startswith("https://www.uscis.gov/") and top.snippet and top.section_kind


def test_results_are_one_per_decision(db: Conn) -> None:
    build_index(db, FakeEmbedder())
    hits = search(db, FakeEmbedder(), "criterion evidence record petitioner", k=10)
    ids = [h.decision_id for h in hits]
    assert len(ids) == len(set(ids)) <= 2


def test_visa_filter(db: Conn) -> None:
    build_index(db, FakeEmbedder())
    assert search(db, FakeEmbedder(), "acclaim", k=5, visa="O-1") == []


def test_empty_query_is_rejected(db: Conn) -> None:
    with pytest.raises(ValueError, match="query"):
        search(db, FakeEmbedder(), "   ", k=5)


def test_reparse_drops_stale_chunks_and_rebuild_restores_them(
    db: Conn, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = build_index(db, FakeEmbedder()).chunks
    monkeypatch.setattr("adjudicate.parse.pipeline.PARSER_VERSION", "test-bump")
    parse_pending(db)
    assert _scalar(db, "SELECT count(*) FROM chunk") == 0  # sections replaced → chunks gone
    assert build_index(db, FakeEmbedder()).chunks == first
