"""Walk one category of the AAO index, record every decision, fetch pending PDFs.

Idempotent by construction: discovery is ``INSERT ... ON CONFLICT (url) DO
NOTHING`` and fetching only touches rows without content, so an interrupted run
resumes exactly where it stopped and a complete re-run downloads nothing.

Nothing is dropped quietly: an empty first page raises, a page cap is reported
as truncation, date drift and off-topic categories are warned, failed rows are
retried last and abandoned visibly after ``MAX_ATTEMPTS``, and every run —
including an interrupted one — leaves an audit row.
"""

from __future__ import annotations

import hashlib
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass

import psycopg

from adjudicate.db import require_autocommit
from adjudicate.harvest.categories import VisaType
from adjudicate.harvest.http import FetchError, PoliteClient
from adjudicate.harvest.listing import ListingEntry, dedupe, parse_listing_page

INDEX_URL = "https://www.uscis.gov/administrative-appeals/aao-decisions/aao-non-precedent-decisions"
PAGE_SIZE = 100
MAX_ATTEMPTS = 3
PDF_TAIL_BYTES = 2048
TOPIC_VISA = {19: VisaType.EB1A, 18: VisaType.EB2_NIW, 4: VisaType.O1}

type Conn = psycopg.Connection[tuple[object, ...]]


class HarvestError(RuntimeError):
    """The index did not look like a healthy listing; refusing to guess."""


@dataclass(slots=True)
class HarvestStats:
    pages_walked: int = 0
    discovered_new: int = 0
    fetched: int = 0
    failed: int = 0
    abandoned: int = 0
    warnings: int = 0
    total_listed: int | None = None
    reached_end: bool = False


def listing_url(topic: int, page: int) -> str:
    return f"{INDEX_URL}?uri_1={topic}&items_per_page={PAGE_SIZE}&page={page}"


def _record(conn: Conn, entries: list[ListingEntry], topic: int) -> int:
    inserted = 0
    with conn.transaction():
        for e in entries:
            cur = conn.execute(
                "INSERT INTO raw_decision (url, decision_id, category, visa_type, listing_topic,"
                " issued_year, display_date, decision_date)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (url) DO NOTHING",
                (
                    e.url,
                    e.decision_id,
                    e.category,
                    e.visa_type.value,
                    topic,
                    e.issued_year,
                    e.display_date,
                    e.decision_date,
                ),
            )
            inserted += cur.rowcount
    return inserted


def _pending(conn: Conn, topic: int, min_year: int | None, limit: int | None) -> list[str]:
    # Unknown issued_year is fetched rather than silently excluded by a NULL comparison.
    # Never-tried rows first, so earlier failures cannot starve --fetch-limit.
    rows = conn.execute(
        "SELECT url FROM raw_decision WHERE content IS NULL AND listing_topic = %s"
        " AND fetch_attempts < %s"
        " AND (%s::int IS NULL OR issued_year IS NULL OR issued_year >= %s::int)"
        " ORDER BY fetch_attempts > 0, decision_date DESC NULLS LAST, id LIMIT %s",
        (topic, MAX_ATTEMPTS, min_year, min_year, limit),
    ).fetchall()
    return [str(r[0]) for r in rows]


def _abandoned(conn: Conn, topic: int) -> int:
    row = conn.execute(
        "SELECT count(*) FROM raw_decision WHERE content IS NULL AND listing_topic = %s"
        " AND fetch_attempts >= %s",
        (topic, MAX_ATTEMPTS),
    ).fetchone()
    return int(str(row[0])) if row else 0


def _pdf_problem(body: bytes) -> str | None:
    if not body.startswith(b"%PDF-"):
        return "not a PDF"
    if b"%%EOF" not in body[-PDF_TAIL_BYTES:]:
        return "truncated PDF (no %%EOF trailer)"
    return None


def _fetch_one(
    client: PoliteClient, conn: Conn, url: str, allowed: Callable[[str], bool]
) -> str | None:
    """Fetch and store one PDF. Returns an error string instead of storing a bad body."""
    status: int | None = None
    ctype: str | None = None
    if not allowed(url):
        error = "disallowed by robots.txt"
    else:
        try:
            response = client.get(url)
        except FetchError as exc:
            error = str(exc)
        else:
            body = response.content
            status, ctype = response.status_code, response.headers.get("content-type")
            problem = _pdf_problem(body)
            if problem is None:
                with conn.transaction():
                    conn.execute(
                        "UPDATE raw_decision SET content = %s, sha256 = %s, byte_size = %s,"
                        " fetched_at = now(), http_status = %s, content_type = %s,"
                        " fetch_error = NULL, fetch_attempts = fetch_attempts + 1,"
                        " last_attempt_at = now() WHERE url = %s",
                        (body, hashlib.sha256(body).hexdigest(), len(body), status, ctype, url),
                    )
                return None
            error = f"{problem} (HTTP {status}, content-type {ctype or '?'})"
    with conn.transaction():
        conn.execute(
            "UPDATE raw_decision SET fetch_error = %s, http_status = %s, content_type = %s,"
            " fetch_attempts = fetch_attempts + 1, last_attempt_at = now() WHERE url = %s",
            (error, status, ctype, url),
        )
    return error


def _walk(
    client: PoliteClient,
    conn: Conn,
    topic: int,
    max_pages: int,
    stats: HarvestStats,
    log: Callable[[str], None],
) -> None:
    expected = TOPIC_VISA.get(topic)
    for page_no in range(max_pages):
        page = parse_listing_page(client.get(listing_url(topic, page_no)).text, INDEX_URL)
        stats.pages_walked += 1
        if page_no == 0:
            stats.total_listed = page.total_rows
            if not page.entries:
                raise HarvestError(f"page 0 of topic {topic} returned no decisions")
        if not page.entries:
            stats.reached_end = True
            return
        entries = dedupe(page.entries)
        for problem in page.drift:
            stats.warnings += 1
            log(f"WARNING date drift: {problem}")
        off_topic = Counter(e.visa_type.value for e in entries if e.visa_type is not expected)
        if expected is not None and off_topic:
            stats.warnings += 1
            log(f"WARNING unexpected categories under topic {topic}: {dict(off_topic)}")
        new = _record(conn, entries, topic)
        stats.discovered_new += new
        log(f"page {page_no}: {len(entries)} listed, {new} new")
        if not page.has_next:
            stats.reached_end = True
            return
    log(
        f"WARNING truncated: stopped at --max-pages={max_pages} with more pages listed"
        f" ({stats.total_listed} total rows reported)"
    )


def harvest(
    client: PoliteClient,
    conn: Conn,
    *,
    topic: int,
    max_pages: int,
    min_year: int | None = None,
    fetch_limit: int | None = None,
    allowed: Callable[[str], bool] = lambda _url: True,
    log: Callable[[str], None] = lambda _msg: None,
) -> HarvestStats:
    require_autocommit(conn, "harvest")
    stats = HarvestStats()
    with conn.transaction():
        row = conn.execute(
            "INSERT INTO harvest_run (topic) VALUES (%s) RETURNING id", (topic,)
        ).fetchone()
    if row is None:  # pragma: no cover — INSERT ... RETURNING always yields a row
        raise RuntimeError("harvest_run insert returned no id")
    run_id = row[0]
    error: str | None = None
    try:
        _walk(client, conn, topic, max_pages, stats, log)
        pending = _pending(conn, topic, min_year, fetch_limit)
        log(f"{len(pending)} pending PDF(s) to fetch")
        for i, url in enumerate(pending, 1):
            problem = _fetch_one(client, conn, url, allowed)
            if problem is None:
                stats.fetched += 1
            else:
                stats.failed += 1
                log(f"FAILED {url}: {problem}")
            if i % 25 == 0:
                log(f"fetched {stats.fetched}/{len(pending)} ({stats.failed} failed)")
        stats.abandoned = _abandoned(conn, topic)
        if stats.abandoned:
            log(f"WARNING {stats.abandoned} row(s) abandoned after {MAX_ATTEMPTS} attempts")
    except BaseException as exc:  # audit Ctrl-C too, then re-raise
        error = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
        raise
    finally:
        try:
            with conn.transaction():
                conn.execute(
                    "UPDATE harvest_run SET finished_at = now(), pages_walked = %s,"
                    " discovered_new = %s, fetched = %s, failed = %s, error = %s,"
                    " total_listed = %s, reached_end = %s, abandoned = %s, warnings = %s"
                    " WHERE id = %s",
                    (
                        stats.pages_walked,
                        stats.discovered_new,
                        stats.fetched,
                        stats.failed,
                        error,
                        stats.total_listed,
                        stats.reached_end,
                        stats.abandoned,
                        stats.warnings,
                        run_id,
                    ),
                )
        except psycopg.Error as audit_exc:
            if error is None:
                raise
            log(f"audit write failed after {error}: {audit_exc}")  # keep the original error
    return stats
