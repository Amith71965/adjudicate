"""Migration runner contract: ordered, recorded, idempotent, atomic per file."""

from __future__ import annotations

from pathlib import Path

import psycopg
import pytest

from adjudicate.migrate import MigrationError, apply_migrations

pytestmark = pytest.mark.db


def _write(d: Path, name: str, sql: str) -> None:
    (d / name).write_text(sql)


def test_applies_files_in_numeric_order_and_records_them(
    tmp_path: Path, scratch_db_url: str
) -> None:
    _write(tmp_path, "0002_b.sql", "INSERT INTO t VALUES (2);")
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    with psycopg.connect(scratch_db_url) as conn:
        applied = apply_migrations(conn, tmp_path)
        assert applied == ["0001_a.sql", "0002_b.sql"]
        rows = conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
        assert [r[0] for r in rows] == ["0001_a.sql", "0002_b.sql"]


def test_second_run_applies_nothing(tmp_path: Path, scratch_db_url: str) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    with psycopg.connect(scratch_db_url) as conn:
        apply_migrations(conn, tmp_path)
        assert apply_migrations(conn, tmp_path) == []


def test_failed_file_is_rolled_back_and_not_recorded(
    tmp_path: Path, scratch_db_url: str
) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    _write(tmp_path, "0002_bad.sql", "CREATE TABLE u (v int); SELECT nonsense_fn();")
    with psycopg.connect(scratch_db_url) as conn:
        with pytest.raises(MigrationError, match="0002_bad.sql"):
            apply_migrations(conn, tmp_path)
        assert conn.execute("SELECT to_regclass('u')").fetchone() == (None,)
        versions = [r[0] for r in conn.execute("SELECT version FROM schema_migrations")]
        assert versions == ["0001_a.sql"]


def test_ignores_non_sql_and_unnumbered_files(tmp_path: Path, scratch_db_url: str) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    _write(tmp_path, "README.md", "not a migration")
    _write(tmp_path, "scratch.sql", "DROP TABLE t;")
    with psycopg.connect(scratch_db_url) as conn:
        assert apply_migrations(conn, tmp_path) == ["0001_a.sql"]


def test_repo_migrations_install_pgvector(scratch_db_url: str) -> None:
    repo_migrations = Path(__file__).resolve().parents[2] / "db" / "migrations"
    with psycopg.connect(scratch_db_url) as conn:
        apply_migrations(conn, repo_migrations)
        row = conn.execute("SELECT 1 FROM pg_extension WHERE extname = 'vector'").fetchone()
        assert row == (1,)
