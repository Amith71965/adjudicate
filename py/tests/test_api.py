"""FastAPI retrieval service: contract, validation, and 503-not-empty on DB failure."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

from adjudicate.api.app import create_app
from adjudicate.migrate import apply_migrations
from adjudicate.parse.pipeline import parse_pending
from adjudicate.retrieve.index import build_index
from tests.test_retrieve_index import FIXTURES, FakeEmbedder, decided_on

pytestmark = pytest.mark.db
FIX = Path(__file__).parent / "fixtures" / "decisions"
REPO_MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


@pytest.fixture
def client(scratch_db_url: str) -> Iterator[TestClient]:
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, REPO_MIGRATIONS)
        for did, visa in FIXTURES.items():
            body = (FIX / f"{did}.pdf").read_bytes()
            conn.execute(
                "INSERT INTO raw_decision (url, decision_id, category, visa_type, content, sha256,"
                " byte_size, fetched_at, decision_date)"
                " VALUES (%s, %s, 'c', %s, %s, %s, %s, now(), %s)",
                (
                    f"https://www.uscis.gov/{did}.pdf",
                    did,
                    visa,
                    body,
                    hashlib.sha256(body).hexdigest(),
                    len(body),
                    decided_on(did),
                ),
            )
        parse_pending(conn)
        build_index(conn, FakeEmbedder())
    app = create_app(lambda: psycopg.connect(scratch_db_url, autocommit=True), FakeEmbedder())
    with TestClient(app) as c:
        yield c


def test_health_reports_index_state(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["db"] == "ok" and body["chunks"] > 0 and body["embedded"] == body["chunks"]


def test_search_returns_citable_hits(client: TestClient) -> None:
    r = client.get("/search", params={"q": "sustained acclaim final merits", "k": 3})
    assert r.status_code == 200
    hits = r.json()["results"]
    assert hits and {"decision_id", "chunk_id", "url", "snippet", "section_kind"} <= set(hits[0])


@pytest.mark.parametrize(
    "params", [{"q": "  "}, {"q": "x", "k": 0}, {"q": "x", "k": 51}, {"q": "x", "mode": "bm25"}]
)
def test_bad_search_requests_are_rejected(client: TestClient, params: dict[str, object]) -> None:
    assert client.get("/search", params=params).status_code == 422


def test_search_by_section_returns_only_final_merits_reasoning(client: TestClient) -> None:
    r = client.get("/search", params={"q": "sustained acclaim", "k": 5, "section": "final_merits"})
    hits = r.json()["results"]
    assert r.status_code == 200 and hits
    assert {h["section_kind"] for h in hits} == {"final_merits"}
    # echoed, so a client can tell an applied filter from one an older API ignored
    assert r.json()["filters"] == {
        "visa": None,
        "criterion": None,
        "section": "final_merits",
        "before": None,
    }


def test_search_before_a_date_is_echoed(client: TestClient) -> None:
    r = client.get("/search", params={"q": "acclaim", "before": "2000-01-01"})
    assert r.status_code == 200 and r.json()["results"] == []
    assert r.json()["filters"]["before"] == "2000-01-01"
    assert client.get("/search", params={"q": "x", "before": "June"}).status_code == 422


def test_passage_round_trip(client: TestClient) -> None:
    hit = client.get("/search", params={"q": "distinguished reputation", "k": 1}).json()["results"][
        0
    ]
    p = client.get(f"/passages/{hit['chunk_id']}").json()
    assert p["decision_id"] == hit["decision_id"] and hit["snippet"][:100] in p["body"]
    assert p["url"].startswith("https://www.uscis.gov/")


def test_decision_detail(client: TestClient) -> None:
    d = client.get("/decisions/SEP172026_06B2203").json()
    assert d["outcome"] == "dismissed" and d["kind"] == "merits"
    assert any(s["kind"] == "final_merits" for s in d["sections"])
    assert d["verdicts"] == []  # no extraction in this fixture DB: empty, not invented


@pytest.mark.parametrize("path", ["/decisions/NOPE123", "/passages/999999999"])
def test_unknown_ids_are_404(client: TestClient, path: str) -> None:
    assert client.get(path).status_code == 404


def test_database_outage_is_503_not_an_empty_result() -> None:
    def broken() -> psycopg.Connection[tuple[object, ...]]:
        raise psycopg.OperationalError("connection refused")

    with TestClient(create_app(broken, FakeEmbedder())) as c:
        r = c.get("/search", params={"q": "acclaim"})
        assert r.status_code == 503 and "unavailable" in r.json()["detail"]
        assert c.get("/health").status_code == 503


@pytest.mark.parametrize(
    "params",
    [
        {"q": "x", "visa": "EB-1"},
        {"q": "x", "criterion": "bogus"},
        {"q": "x", "section": "bogus"},
        {"q": "x", "section": "preamble"},  # a real kind, but never chunked: not searchable
    ],
)
def test_unknown_filters_are_rejected_not_silently_empty(
    client: TestClient, params: dict[str, object]
) -> None:
    assert client.get("/search", params=params).status_code == 422


def test_partial_index_is_degraded_and_search_refuses(
    client: TestClient, scratch_db_url: str
) -> None:
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        conn.execute(
            "UPDATE chunk SET embedding = NULL, embed_model = NULL"
            " WHERE id = (SELECT min(id) FROM chunk)"
        )
    h = client.get("/health")
    assert h.status_code == 503 and h.json()["status"] == "degraded"
    r = client.get("/search", params={"q": "acclaim"})
    assert r.status_code == 503 and "index incomplete" in r.json()["detail"]
