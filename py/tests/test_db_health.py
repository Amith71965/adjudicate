"""Phase 0 contract: the corpus database is reachable and pgvector is usable.

These tests are the first thing written in the repo. They fail until the
compose stack is up *and* the extensions migration has run.
"""

from __future__ import annotations

import pytest

from adjudicate.db import connect

pytestmark = pytest.mark.db


def test_can_connect() -> None:
    with connect() as conn:
        row = conn.execute("SELECT 1").fetchone()
    assert row == (1,)


def test_vector_extension_installed() -> None:
    with connect() as conn:
        row = conn.execute(
            "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
        ).fetchone()
    assert row is not None, "pgvector extension is not installed in the corpus database"


def test_vector_distance_operator_works() -> None:
    # Proves the extension is functional, not merely registered.
    with connect() as conn:
        row = conn.execute("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector").fetchone()
    assert row is not None
    assert row[0] == pytest.approx(1.0)


def test_server_is_postgres_17() -> None:
    with connect() as conn:
        row = conn.execute("SHOW server_version_num").fetchone()
    assert row is not None
    assert int(row[0]) // 10000 == 17
