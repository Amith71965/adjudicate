"""The end-to-end review flow writes to a throwaway review log, never the real one: the log is
append-only, so a browser test that wrote there could never be cleaned up. The sandbox is a
schema `e2e_<random>` holding its own review_event table; the API reaches it through the
connection's search_path, while passages still come from the real corpus tables."""

from __future__ import annotations

from pathlib import Path

import psycopg
import pytest

from adjudicate.db import UnsafeDatabaseError
from adjudicate.e2e import RESOLVED_SCHEMA, create_review_sandbox, drop_review_sandbox
from adjudicate.migrate import apply_migrations

pytestmark = pytest.mark.db
REPO_MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
INSERT = (
    "INSERT INTO review_event (case_id, item_id, action, note, actor)"
    " VALUES ('P01', 'prong:judging/whole', 'resolve', 'note', 'A')"
)


@pytest.fixture
def db_url(scratch_db_url: str) -> str:
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, REPO_MIGRATIONS)
    return scratch_db_url


def test_a_sandbox_has_its_own_review_log_and_is_dropped_after(db_url: str) -> None:
    sandbox = create_review_sandbox(db_url)
    try:
        with psycopg.connect(sandbox, autocommit=True) as conn:
            schema = conn.execute(RESOLVED_SCHEMA).fetchone()
            assert schema is not None and str(schema[0]).startswith("e2e_")
            conn.execute(INSERT)
            with pytest.raises(psycopg.Error, match="append-only"):
                conn.execute("DELETE FROM review_event")  # same guarantees as the real log
            assert conn.execute("SELECT count(*) FROM schema_migrations").fetchone()  # corpus side
    finally:
        drop_review_sandbox(sandbox)
    with psycopg.connect(db_url) as conn:
        assert conn.execute("SELECT count(*) FROM public.review_event").fetchone() == (0,)
        left = conn.execute("SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'e2e_%'")
        assert left.fetchone() == (0,)


def test_only_sandboxes_can_be_dropped(db_url: str) -> None:
    with pytest.raises(UnsafeDatabaseError, match="sandbox"):
        drop_review_sandbox(db_url)


def test_remote_databases_are_refused() -> None:
    with pytest.raises(UnsafeDatabaseError):
        create_review_sandbox("postgresql://u:p@db.example.com:5432/adjudicate")
