"""Walk one category of the AAO index, record every decision, fetch pending PDFs.

Idempotent by construction: discovery is ``INSERT ... ON CONFLICT (url) DO
NOTHING`` and fetching only touches rows without content, so an interrupted run
resumes exactly where it stopped and a complete re-run downloads nothing.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass

import psycopg

from adjudicate.db import require_autocommit
from adjudicate.harvest.http import FetchError, PoliteClient
from adjudicate.harvest.listing import ListingEntry, dedupe, parse_listing

INDEX_URL = "https://www.uscis.gov/administrative-appeals/aao-decisions/aao-non-precedent-decisions"
PAGE_SIZE = 100

type Conn = psycopg.Connection[tuple[object, ...]]


@dataclass(slots=True)
class HarvestStats:
    pages_walked: int = 0
    discovered_new: int = 0
    fetched: int = 0
    failed: int = 0


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
    rows = conn.execute(
        "SELECT url FROM raw_decision WHERE content IS NULL AND listing_topic = %s"
        " AND (%s::int IS NULL OR issued_year >= %s::int)"
        " ORDER BY decision_date DESC NULLS LAST, id LIMIT %s",
        (topic, min_year, min_year, limit),
    ).fetchall()
    return [str(r[0]) for r in rows]


def _fetch_one(client: PoliteClient, conn: Conn, url: str) -> str | None:
    """Fetch and store one PDF. Returns an error string instead of storing a bad body."""
    try:
        response = client.get(url)
    except FetchError as exc:
        error = str(exc)
    else:
        body = response.content
        if body.startswith(b"%PDF-"):
            with conn.transaction():
                conn.execute(
                    "UPDATE raw_decision SET content = %s, sha256 = %s, byte_size = %s,"
                    " fetched_at = now(), http_status = %s, content_type = %s, fetch_error = NULL"
                    " WHERE url = %s",
                    (
                        body,
                        hashlib.sha256(body).hexdigest(),
                        len(body),
                        response.status_code,
                        response.headers.get("content-type"),
                        url,
                    ),
                )
            return None
        ctype = response.headers.get("content-type", "?")
        error = f"not a PDF (HTTP {response.status_code}, content-type {ctype})"
    with conn.transaction():
        conn.execute("UPDATE raw_decision SET fetch_error = %s WHERE url = %s", (error, url))
    return error


def harvest(
    client: PoliteClient,
    conn: Conn,
    *,
    topic: int,
    max_pages: int,
    min_year: int | None = None,
    fetch_limit: int | None = None,
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
        for page in range(max_pages):
            entries = dedupe(parse_listing(client.get(listing_url(topic, page)).text, INDEX_URL))
            stats.pages_walked += 1
            if not entries:
                break
            new = _record(conn, entries, topic)
            stats.discovered_new += new
            log(f"page {page}: {len(entries)} listed, {new} new")
        pending = _pending(conn, topic, min_year, fetch_limit)
        log(f"{len(pending)} pending PDF(s) to fetch")
        for i, url in enumerate(pending, 1):
            problem = _fetch_one(client, conn, url)
            if problem is None:
                stats.fetched += 1
            else:
                stats.failed += 1
                log(f"FAILED {url}: {problem}")
            if i % 25 == 0:
                log(f"fetched {stats.fetched}/{len(pending)} ({stats.failed} failed)")
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        with conn.transaction():
            conn.execute(
                "UPDATE harvest_run SET finished_at = now(), pages_walked = %s,"
                " discovered_new = %s, fetched = %s, failed = %s, error = %s WHERE id = %s",
                (
                    stats.pages_walked,
                    stats.discovered_new,
                    stats.fetched,
                    stats.failed,
                    error,
                    run_id,
                ),
            )
    return stats
