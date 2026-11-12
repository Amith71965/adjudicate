"""The end-to-end review flow runs against a throwaway clone of the corpus database: the review
log is append-only, so a test run must never write into the real one. Only e2e_* clones on
the local compose database may be created or dropped."""

from __future__ import annotations

from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict

from adjudicate.db import UnsafeDatabaseError
from adjudicate.e2e import clone_database, drop_database
from adjudicate.migrate import apply_migrations

pytestmark = pytest.mark.db
REPO_MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


def test_a_clone_has_the_template_data_and_is_dropped_after(scratch_db_url: str) -> None:
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, REPO_MIGRATIONS)
    template = str(conninfo_to_dict(scratch_db_url)["dbname"])
    url = clone_database(scratch_db_url, template)
    try:
        assert str(conninfo_to_dict(url)["dbname"]).startswith("e2e_")
        with psycopg.connect(url) as conn:
            assert conn.execute("SELECT count(*) FROM review_event").fetchone() == (0,)
    finally:
        drop_database(url)
    with pytest.raises(psycopg.OperationalError):
        psycopg.connect(url).close()


def test_only_e2e_clones_can_be_dropped(scratch_db_url: str) -> None:
    with pytest.raises(UnsafeDatabaseError, match="e2e_"):
        drop_database(scratch_db_url)


def test_remote_databases_are_refused() -> None:
    with pytest.raises(UnsafeDatabaseError):
        clone_database("postgresql://u:p@db.example.com:5432/adjudicate", "adjudicate")
