"""Corpus counts used to verify the harvest (and printed by ``make harvest-stats``)."""

from __future__ import annotations

import sys
from dataclasses import dataclass, field

import psycopg

from adjudicate.db import connect, describe_target

MODERN_FROM_YEAR = 2017

type Conn = psycopg.Connection[tuple[object, ...]]


@dataclass(frozen=True, slots=True)
class CorpusStats:
    total: int
    fetched: int
    pending: int
    failed: int
    distinct_urls: int
    duplicate_content_groups: int
    fetched_by_visa: dict[str, int] = field(default_factory=dict)
    fetched_modern_by_visa: dict[str, int] = field(default_factory=dict)


def _scalar(conn: Conn, sql: str) -> int:
    row = conn.execute(sql).fetchone()
    return int(str(row[0])) if row is not None and row[0] is not None else 0


def corpus_stats(conn: Conn) -> CorpusStats:
    by_visa = {
        str(v): int(str(n))
        for v, n in conn.execute(
            "SELECT visa_type, count(*) FROM raw_decision WHERE content IS NOT NULL"
            " GROUP BY visa_type"
        )
    }
    modern = {
        str(v): int(str(n))
        for v, n in conn.execute(
            "SELECT visa_type, count(*) FROM raw_decision WHERE content IS NOT NULL"
            " AND issued_year >= %s GROUP BY visa_type",
            (MODERN_FROM_YEAR,),
        )
    }
    return CorpusStats(
        total=_scalar(conn, "SELECT count(*) FROM raw_decision"),
        fetched=_scalar(conn, "SELECT count(*) FROM raw_decision WHERE content IS NOT NULL"),
        pending=_scalar(conn, "SELECT count(*) FROM raw_decision WHERE content IS NULL"),
        failed=_scalar(conn, "SELECT count(*) FROM raw_decision WHERE fetch_error IS NOT NULL"),
        distinct_urls=_scalar(conn, "SELECT count(DISTINCT url) FROM raw_decision"),
        duplicate_content_groups=_scalar(
            conn,
            "SELECT count(*) FROM (SELECT sha256 FROM raw_decision WHERE sha256 IS NOT NULL"
            " GROUP BY sha256 HAVING count(*) > 1) d",
        ),
        fetched_by_visa=by_visa,
        fetched_modern_by_visa=modern,
    )


def main() -> int:
    with connect() as conn:
        s = corpus_stats(conn)
    print(f"corpus @ {describe_target()}")
    print(f"  rows {s.total}  fetched {s.fetched}  pending {s.pending}  failed {s.failed}")
    print(
        f"  distinct urls {s.distinct_urls}  duplicate-content groups {s.duplicate_content_groups}"
    )
    for visa in sorted(s.fetched_by_visa):
        modern = s.fetched_modern_by_visa.get(visa, 0)
        fetched = s.fetched_by_visa[visa]
        print(f"  {visa:<9} fetched {fetched:>5}  ({modern} issued {MODERN_FROM_YEAR}+)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
