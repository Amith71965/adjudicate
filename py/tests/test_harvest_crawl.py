"""End-to-end harvest against a scratch Postgres and a fake uscis.gov (no network)."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import psycopg
import pytest

from adjudicate.harvest.crawl import HarvestError, HarvestStats, harvest
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
        self.truncated: set[str] = set()
        self.listing_override: str | None = None
        self.interrupt_after: int | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith(".pdf"):
            self.pdf_requests.append(url)
            if self.interrupt_after is not None and len(self.pdf_requests) > self.interrupt_after:
                raise KeyboardInterrupt
            if url in self.truncated:
                return httpx.Response(200, content=fake_pdf(url)[:-8])
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
        if self.listing_override is not None:
            return httpx.Response(200, text=self.listing_override if page == 0 else PAST_END)
        return httpx.Response(200, text=PAGE0 if page == 0 else PAST_END)


@pytest.fixture
def db(scratch_db_url: str) -> Iterator[psycopg.Connection[tuple[object, ...]]]:
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
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


def test_each_fetched_pdf_is_durable_before_the_run_ends(
    site: FakeUscis, db: psycopg.Connection[tuple[object, ...]], scratch_db_url: str
) -> None:
    seen_mid_run: list[int] = []
    original = site.__call__

    def spying(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith(".pdf") and len(site.pdf_requests) == 10:
            with psycopg.connect(scratch_db_url) as other:
                seen_mid_run.append(
                    _count(other, "SELECT count(*) FROM raw_decision WHERE content IS NOT NULL")
                )
        return original(request)

    client = PoliteClient(
        transport=httpx.MockTransport(spying), min_interval=0.0, sleep=lambda s: None
    )
    harvest(client, db, topic=19, max_pages=10)
    assert seen_mid_run == [10]  # a crash here would lose nothing already fetched


def test_harvest_requires_autocommit(
    db: psycopg.Connection[tuple[object, ...]], scratch_db_url: str
) -> None:
    client = PoliteClient(transport=httpx.MockTransport(FakeUscis()), min_interval=0.0)
    with psycopg.connect(scratch_db_url) as conn, pytest.raises(ValueError, match="autocommit"):
        harvest(client, conn, topic=19, max_pages=1)


# --- hardening (silent-failure review, phase 1) -------------------------------------------


def _harvest(
    site: FakeUscis, db: psycopg.Connection[tuple[object, ...]], **kw: object
) -> HarvestStats:
    client = PoliteClient(
        transport=httpx.MockTransport(site), min_interval=0.0, sleep=lambda s: None
    )
    try:
        return harvest(client, db, topic=19, **kw)  # type: ignore[arg-type]
    finally:
        client.close()


def test_empty_first_page_is_an_error_not_end_of_results(
    db: psycopg.Connection[tuple[object, ...]],
) -> None:
    site = FakeUscis()
    site.listing_override = PAST_END  # page 0 already "empty"
    with pytest.raises(HarvestError, match="page 0"):
        _harvest(site, db, max_pages=3)
    row = db.execute("SELECT error FROM harvest_run").fetchone()
    assert row is not None and "page 0" in str(row[0])


def test_page_cap_is_reported_as_truncation(
    db: psycopg.Connection[tuple[object, ...]], site: FakeUscis
) -> None:
    logs: list[str] = []
    stats = _harvest(site, db, max_pages=1, log=logs.append)
    assert stats.reached_end is False
    assert any("truncated" in m for m in logs)
    row = db.execute("SELECT reached_end, total_listed FROM harvest_run").fetchone()
    assert row == (False, 5294)


def test_full_walk_reports_reached_end(
    db: psycopg.Connection[tuple[object, ...]], site: FakeUscis
) -> None:
    assert _harvest(site, db, max_pages=5).reached_end is True


def test_rows_with_unknown_year_are_still_fetched_under_min_year(
    db: psycopg.Connection[tuple[object, ...]], site: FakeUscis
) -> None:
    _harvest(site, db, max_pages=5, fetch_limit=0)
    db.execute("UPDATE raw_decision SET issued_year = NULL WHERE decision_id = 'SEP172026_01B2203'")
    _harvest(site, db, max_pages=5, min_year=2026)
    row = db.execute(
        "SELECT content IS NOT NULL FROM raw_decision WHERE decision_id = 'SEP172026_01B2203'"
    ).fetchone()
    assert row == (True,)


BAD = (
    "https://www.uscis.gov/sites/default/files/err/"
    "B2%20-%20Aliens%20with%20Extraordinary%20Ability/"
    "Decisions_Issued_in_2026/SEP172026_01B2203.pdf"
)


def test_failures_are_counted_retried_last_and_abandoned_after_cap(
    db: psycopg.Connection[tuple[object, ...]], site: FakeUscis
) -> None:
    site.broken.add(BAD)
    for _ in range(3):
        _harvest(site, db, max_pages=5)
    attempts, status = db.execute(
        "SELECT fetch_attempts, http_status FROM raw_decision WHERE url = %s", (BAD,)
    ).fetchone() or (None, None)
    assert (attempts, status) == (3, 200)
    requests_before = site.pdf_requests.count(BAD)
    stats = _harvest(site, db, max_pages=5)
    assert site.pdf_requests.count(BAD) == requests_before  # abandoned: not re-requested
    assert stats.abandoned == 1


def test_previously_failed_rows_do_not_starve_the_fetch_limit(
    db: psycopg.Connection[tuple[object, ...]], site: FakeUscis
) -> None:
    site.broken.add(BAD)
    _harvest(site, db, max_pages=5, fetch_limit=1)  # BAD is newest, fails first
    stats = _harvest(site, db, max_pages=5, fetch_limit=1)
    assert stats.fetched == 1  # a healthy row was chosen ahead of the failed one


def test_truncated_pdf_is_rejected(
    db: psycopg.Connection[tuple[object, ...]], site: FakeUscis
) -> None:
    site.truncated.add(BAD)
    stats = _harvest(site, db, max_pages=5)
    assert stats.failed == 1
    row = db.execute("SELECT fetch_error FROM raw_decision WHERE url = %s", (BAD,)).fetchone()
    assert row is not None and "truncated" in str(row[0])


def test_robots_disallowed_urls_are_never_requested(
    db: psycopg.Connection[tuple[object, ...]], site: FakeUscis
) -> None:
    stats = _harvest(site, db, max_pages=5, allowed=lambda url: url != BAD)
    assert BAD not in site.pdf_requests
    assert stats.failed == 1


def test_interrupt_is_audited_as_an_error(
    db: psycopg.Connection[tuple[object, ...]], site: FakeUscis
) -> None:
    site.interrupt_after = 3
    with pytest.raises(KeyboardInterrupt):
        _harvest(site, db, max_pages=5)
    row = db.execute("SELECT error, finished_at IS NOT NULL FROM harvest_run").fetchone()
    assert row == ("KeyboardInterrupt", True)


def test_unexpected_categories_for_the_topic_are_warned(
    db: psycopg.Connection[tuple[object, ...]],
) -> None:
    site = FakeUscis()
    site.listing_override = (FIX / "unfiltered_page1.html").read_text()
    logs: list[str] = []
    _harvest(site, db, max_pages=1, fetch_limit=0, log=logs.append)
    assert any("unexpected" in m and "other" in m for m in logs)
