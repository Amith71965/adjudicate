"""CLI wiring and the corpus stats report that proves the Phase-1 exit criterion."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import httpx
import psycopg
import pytest

from adjudicate.harvest.__main__ import main
from adjudicate.harvest.stats import corpus_stats
from adjudicate.migrate import apply_migrations

pytestmark = pytest.mark.db

FIX = Path(__file__).parent / "fixtures"
REPO_MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


@pytest.fixture
def db(scratch_db_url: str) -> Iterator[psycopg.Connection[tuple[object, ...]]]:
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, REPO_MIGRATIONS)
        yield conn


def _site(broken: bool = False) -> httpx.MockTransport:
    page0 = (FIX / "listing" / "eb1a_page0.html").read_text()
    end = (FIX / "listing" / "eb1a_page_past_end.html").read_text()
    robots = (FIX / "robots.txt").read_text()

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/robots.txt"):
            return httpx.Response(200, text=robots)
        if url.endswith(".pdf"):
            if broken:
                return httpx.Response(404)
            return httpx.Response(200, content=b"%PDF-1.4 " + url.encode() + b"\n%%EOF\n")
        return httpx.Response(200, text=page0 if "page=0" in url else end)

    return httpx.MockTransport(handler)


def test_cli_harvests_and_exits_zero(
    db: psycopg.Connection[tuple[object, ...]], scratch_db_url: str
) -> None:
    sleeps: list[float] = []
    code = main(
        ["--topic", "19", "--max-pages", "3", "--fetch-limit", "5"],
        transport=_site(),
        database_url=scratch_db_url,
        sleep=sleeps.append,
    )
    assert code == 0
    stats = corpus_stats(db)
    assert stats.fetched == 5
    # robots.txt Crawl-delay (10 s) governs spacing even though no flag set it.
    assert sleeps and min(sleeps) >= 9.0


def test_cli_exits_nonzero_when_any_document_failed(
    scratch_db_url: str, db: psycopg.Connection[tuple[object, ...]]
) -> None:
    code = main(
        ["--topic", "19", "--max-pages", "3", "--fetch-limit", "2"],
        transport=_site(broken=True),
        database_url=scratch_db_url,
        sleep=lambda s: None,
    )
    assert code == 1


def test_cli_refuses_an_interval_below_robots_delay(
    scratch_db_url: str, db: psycopg.Connection[tuple[object, ...]]
) -> None:
    code = main(
        ["--topic", "19", "--max-pages", "1", "--min-interval", "2"],
        transport=_site(),
        database_url=scratch_db_url,
        sleep=lambda s: None,
    )
    assert code == 2


def test_stats_report_counts_and_duplicates(db: psycopg.Connection[tuple[object, ...]]) -> None:
    rows = [
        ("https://www.uscis.gov/a.pdf", "EB-1A", 2024, b"%PDF-1 a"),
        ("https://www.uscis.gov/b.pdf", "EB-1A", 2016, b"%PDF-1 b"),
        ("https://www.uscis.gov/c.pdf", "O-1", 2025, b"%PDF-1 a"),  # same bytes as a
        ("https://www.uscis.gov/d.pdf", "EB-2/NIW", 2025, None),
    ]
    for url, visa, year, content in rows:
        db.execute(
            "INSERT INTO raw_decision (url, decision_id, category, visa_type, issued_year,"
            " content, sha256, byte_size, fetched_at)"
            " VALUES (%s, 'x', 'c', %s, %s, %s, CASE WHEN %s::bytea IS NULL THEN NULL"
            " ELSE encode(sha256(%s::bytea), 'hex') END, octet_length(%s::bytea),"
            " CASE WHEN %s::bytea IS NULL THEN NULL ELSE now() END)",
            (url, visa, year, content, content, content, content, content),
        )
    s = corpus_stats(db)
    assert (s.total, s.fetched, s.pending) == (4, 3, 1)
    assert s.distinct_urls == 4
    assert s.duplicate_content_groups == 1
    assert s.fetched_by_visa == {"EB-1A": 2, "O-1": 1}
    assert s.fetched_modern_by_visa == {"EB-1A": 1, "O-1": 1}


@pytest.mark.parametrize(
    "flag", [["--max-pages", "0"], ["--max-pages", "-1"], ["--fetch-limit", "0"]]
)
def test_cli_rejects_non_positive_limits(
    flag: list[str], scratch_db_url: str, db: psycopg.Connection[tuple[object, ...]]
) -> None:
    argv = ["--topic", "19", "--max-pages", "1", *flag]
    with pytest.raises(SystemExit) as exc:
        main(argv, transport=_site(), database_url=scratch_db_url, sleep=lambda s: None)
    assert exc.value.code == 2


def test_cli_refuses_to_crawl_on_html_robots(
    scratch_db_url: str, db: psycopg.Connection[tuple[object, ...]]
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>maintenance</html>")

    code = main(
        ["--topic", "19", "--max-pages", "1"],
        transport=httpx.MockTransport(handler),
        database_url=scratch_db_url,
        sleep=lambda s: None,
    )
    assert code == 2
