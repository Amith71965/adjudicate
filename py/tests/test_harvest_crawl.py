"""End-to-end harvest against a scratch Postgres and a fake uscis.gov (no network)."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import psycopg
import pytest
from adjudicate.harvest.crawl import HarvestStats, harvest

from adjudicate.harvest.http import PoliteClient
from adjudicate.migrate import apply_migrations

pytestmark = pytest.mark.db

FIX = Path(__file__).parent / "fixtures" / "listing"
REPO_MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
PAGE0 = (FIX / "eb1a_page0.html").read_text()
PAST_END = (FIX / "eb1a_page_past_end.html").read_text()


def fake_pdf(url: str) -> bytes:
    return b"%PDF-1.4\n% synthetic test body for " + url.encode() + b"\n%%EOF\n"


class FakeUscis:
    """Serves the committed listing fixtures and synthetic PDF bodies."""

    def __init__(self) -> None:
        self.listing_requests: list[dict[str, list[str]]] = []
        self.pdf_requests: list[str] = []
        self.broken: set[str] = set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith(".pdf"):
            self.pdf_requests.append(url)
            if url in self.broken:
                # A soft-error page with HTTP 200: must not be stored as a decision.
                return httpx.Response(
                    200, headers={"content-type": "text/html"}, content=b"<html>Oops</html>"
                )
            return httpx.Response(
                200, headers={"content-type": "application/pdf"}, content=fake_pdf(url)
            )
        query = parse_qs(urlsplit(url).query)
        self.listing_requests.append(query)
        page = int(query.get("page", ["0"])[0])
        return httpx.Response(200, text=PAGE0 if page == 0 else PAST_END)


@pytest.fixture
def db(scratch_db_url: str) -> Iterator[psycopg.Connection[tuple[object, ...]]]:
    with psycopg.connect(scratch_db_url) as conn:
        apply_migrations(conn, REPO_MIGRATIONS)
        yield conn


@pytest.fixture
def site() -> FakeUscis:
    return FakeUscis()


@pytest.fixture
def run(site: FakeUscis, db: psycopg.Connection[tuple[object, ...]]) -> Callable[..., HarvestStats]:
    def _run(**kwargs: object) -> HarvestStats:
        client = PoliteClient(
            transport=httpx.MockTransport(site), min_interval=0.0, sleep=lambda s: None
        )
        try:
            return harvest(client, db, topic=19, **kwargs)  # type: ignore[arg-type]
        finally:
            client.close()

    return _run


def _count(db: psycopg.Connection[tuple[object, ...]], sql: str) -> int:
    row = db.execute(sql).fetchone()
    assert row is not None
    return int(str(row[0]))


def test_walks_filtered_listing_until_the_empty_page(
    run: Callable[..., HarvestStats], site: FakeUscis
) -> None:
    stats = run(max_pages=10)
    assert stats.pages_walked == 2
    assert [q["page"] for q in site.listing_requests] == [["0"], ["1"]]
    assert all(
        q["uri_1"] == ["19"] and q["items_per_page"] == ["100"] for q in site.listing_requests
    )


def test_discovers_and_fetches_every_decision(
    run: Callable[..., HarvestStats], db: psycopg.Connection[tuple[object, ...]]
) -> None:
    stats = run(max_pages=10)
    assert (stats.discovered_new, stats.fetched, stats.failed) == (100, 100, 0)
    assert _count(db, "SELECT count(*) FROM raw_decision WHERE content IS NOT NULL") == 100
    assert _count(db, "SELECT count(DISTINCT url) FROM raw_decision") == 100


def test_stored_row_keeps_bytes_hash_and_metadata(
    run: Callable[..., HarvestStats], db: psycopg.Connection[tuple[object, ...]]
) -> None:
    run(max_pages=10)
    row = db.execute(
        "SELECT url, visa_type, category, issued_year, decision_date, sha256, byte_size,"
        " content, listing_topic FROM raw_decision WHERE decision_id = 'SEP172026_01B2203'"
    ).fetchone()
    assert row is not None
    url, visa, category, year, when, sha, size, content, topic = row
    assert visa == "EB-1A" and category.startswith("B2 ") and year == 2026 and topic == 19
    assert str(when) == "2026-09-17"
    assert bytes(content) == fake_pdf(str(url))
    assert size == len(fake_pdf(str(url)))
    assert len(str(sha)) == 64


def test_rerun_adds_nothing_and_downloads_nothing(
    run: Callable[..., HarvestStats], site: FakeUscis, db: psycopg.Connection[tuple[object, ...]]
) -> None:
    run(max_pages=10)
    pdfs_before = len(site.pdf_requests)
    stats = run(max_pages=10)
    assert (stats.discovered_new, stats.fetched) == (0, 0)
    assert len(site.pdf_requests) == pdfs_before
    assert _count(db, "SELECT count(*) FROM raw_decision") == 100


def test_interrupted_run_resumes_only_pending(
    run: Callable[..., HarvestStats], site: FakeUscis
) -> None:
    first = run(max_pages=10, fetch_limit=30)
    assert first.fetched == 30
    second = run(max_pages=10)
    assert (second.discovered_new, second.fetched) == (0, 70)
    assert len(site.pdf_requests) == len(set(site.pdf_requests)) == 100


def test_min_year_discovers_all_but_fetches_only_recent(
    run: Callable[..., HarvestStats], db: psycopg.Connection[tuple[object, ...]]
) -> None:
    stats = run(max_pages=10, min_year=2026)
    assert stats.discovered_new == 100
    fetched_years = {
        r[0]
        for r in db.execute(
            "SELECT DISTINCT issued_year FROM raw_decision WHERE content IS NOT NULL"
        )
    }
    assert fetched_years == {2026}
    assert stats.fetched == _count(db, "SELECT count(*) FROM raw_decision WHERE issued_year = 2026")


def test_non_pdf_body_is_recorded_as_failure_not_stored(
    run: Callable[..., HarvestStats], site: FakeUscis, db: psycopg.Connection[tuple[object, ...]]
) -> None:
    bad = (
        "https://www.uscis.gov/sites/default/files/err/"
        "B2%20-%20Aliens%20with%20Extraordinary%20Ability/"
        "Decisions_Issued_in_2026/SEP172026_01B2203.pdf"
    )
    site.broken.add(bad)
    stats = run(max_pages=10)
    assert (stats.fetched, stats.failed) == (99, 1)
    row = db.execute(
        "SELECT content IS NULL, fetch_error FROM raw_decision WHERE url = %s", (bad,)
    ).fetchone()
    assert row is not None and row[0] is True and "not a PDF" in str(row[1])


def test_every_run_is_audited(
    run: Callable[..., HarvestStats], db: psycopg.Connection[tuple[object, ...]]
) -> None:
    run(max_pages=10)
    run(max_pages=10)
    rows = db.execute(
        "SELECT topic, pages_walked, discovered_new, fetched, failed, finished_at IS NOT NULL"
        " FROM harvest_run ORDER BY id"
    ).fetchall()
    assert rows == [(19, 2, 100, 100, 0, True), (19, 2, 0, 0, 0, True)]


def test_schema_rejects_content_without_hash(db: psycopg.Connection[tuple[object, ...]]) -> None:
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(
            "INSERT INTO raw_decision (url, decision_id, category, visa_type, content)"
            " VALUES ('https://www.uscis.gov/x.pdf', 'x', 'B2 - x', 'EB-1A', '\\x25504446')"
        )
