"""A throwaway review log for the end-to-end review flow (`make e2e`).

The review log is append-only, so a browser test must never write into the real one. The run
gets a schema ``e2e_<random>`` with its own review_event table (built from the same migration,
so the same CHECKs and append-only triggers), reached through the connection's search_path;
passages still come from the real corpus tables in ``public``. Only the local compose database
qualifies (``assert_disposable``), and only ``e2e_*`` schemas can be dropped.

Cloning the whole corpus database was tried first: CREATE DATABASE ... TEMPLATE crashed a
backend in the memory-capped container with either strategy (INCIDENTS, phase 8).

    python -m adjudicate.e2e create   # prints a connection URL bound to the sandbox
    python -m adjudicate.e2e drop URL
"""

from __future__ import annotations

import re
import sys
import uuid
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from adjudicate.db import UnsafeDatabaseError, assert_disposable, database_url

_SANDBOX = re.compile(r"^e2e_[0-9a-f]{12}$")
_SEARCH_PATH = re.compile(r"-c\s*search_path=(e2e_[0-9a-f]{12}),public$")
RESOLVED_SCHEMA = (
    "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
    " WHERE c.oid = to_regclass('review_event')"
)
REVIEW_LOG_DDL = Path(__file__).resolve().parents[2] / "db" / "migrations" / "0007_review_event.sql"


def _sandbox_of(url: str) -> str:
    match = _SEARCH_PATH.match(str(conninfo_to_dict(url).get("options", "")))
    if not match:
        raise UnsafeDatabaseError("refusing: this URL is not bound to an e2e review sandbox")
    return match.group(1)


def create_review_sandbox(url: str) -> str:
    """Create ``e2e_<random>`` with a fresh review log; return a URL whose search_path uses it."""
    assert_disposable(url)
    name = f"e2e_{uuid.uuid4().hex[:12]}"
    params = conninfo_to_dict(url)
    params["options"] = f"-c search_path={name},public"
    sandbox_url = make_conninfo(**params)  # type: ignore[arg-type]
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(name)))
    try:
        with psycopg.connect(sandbox_url, autocommit=True) as conn:
            conn.execute(REVIEW_LOG_DDL.read_text())  # trusted repo DDL, no parameters
            found = conn.execute(RESOLVED_SCHEMA).fetchone()
    except BaseException:
        drop_review_sandbox(sandbox_url)  # the caller has no URL yet, so nothing else would
        raise
    if found is None or found[0] != name:
        drop_review_sandbox(sandbox_url)
        raise UnsafeDatabaseError(f"sandbox review log did not resolve to {name} (got {found})")
    return sandbox_url


def drop_review_sandbox(url: str) -> None:
    assert_disposable(url)
    name = _sandbox_of(url)
    if not _SANDBOX.match(name):  # pragma: no cover — the pattern above already ensures it
        raise UnsafeDatabaseError(f"refusing to drop {name!r}")
    params = conninfo_to_dict(url)
    params.pop("options", None)
    base = make_conninfo(**params)  # type: ignore[arg-type]
    with psycopg.connect(base, autocommit=True) as conn:
        conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(name)))


def main(argv: list[str]) -> int:
    if argv[:1] == ["create"]:
        print(create_review_sandbox(database_url()))
        return 0
    if argv[:1] == ["drop"] and len(argv) == 2:
        drop_review_sandbox(argv[1])
        return 0
    print("usage: python -m adjudicate.e2e create | drop URL", file=sys.stderr)
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
