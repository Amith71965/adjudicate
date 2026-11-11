"""Migration runner contract: ordered, recorded, idempotent, atomic per file."""

from __future__ import annotations

import re
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
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        applied = apply_migrations(conn, tmp_path)
        assert applied == ["0001_a.sql", "0002_b.sql"]
        rows = conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
        assert [r[0] for r in rows] == ["0001_a.sql", "0002_b.sql"]


def test_second_run_applies_nothing(tmp_path: Path, scratch_db_url: str) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, tmp_path)
        assert apply_migrations(conn, tmp_path) == []


def test_failed_file_is_rolled_back_and_not_recorded(tmp_path: Path, scratch_db_url: str) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    _write(tmp_path, "0002_bad.sql", "CREATE TABLE u (v int); SELECT nonsense_fn();")
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        with pytest.raises(MigrationError, match=re.escape("0002_bad.sql")):
            apply_migrations(conn, tmp_path)
        assert conn.execute("SELECT to_regclass('u')").fetchone() == (None,)
        versions = [r[0] for r in conn.execute("SELECT version FROM schema_migrations")]
        assert versions == ["0001_a.sql"]


def test_ignores_non_sql_files(tmp_path: Path, scratch_db_url: str) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    _write(tmp_path, "README.md", "not a migration")
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        assert apply_migrations(conn, tmp_path) == ["0001_a.sql"]


@pytest.mark.parametrize("bad", ["001_x.sql", "0003-x.sql", "scratch.sql", "0003_x.SQL"])
def test_misnamed_sql_file_is_an_error_not_a_skip(
    tmp_path: Path, scratch_db_url: str, bad: str
) -> None:
    # A silently skipped schema file is worse than a crash: tables never exist
    # and `make migrate` still says OK.
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    _write(tmp_path, bad, "CREATE TABLE u (v int);")
    with (
        psycopg.connect(scratch_db_url) as conn,
        pytest.raises(MigrationError, match=re.escape(bad)),
    ):
        apply_migrations(conn, tmp_path)


def test_duplicate_numeric_prefix_is_an_error(tmp_path: Path, scratch_db_url: str) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    _write(tmp_path, "0001_b.sql", "CREATE TABLE u (v int);")
    with (
        psycopg.connect(scratch_db_url, autocommit=True) as conn,
        pytest.raises(MigrationError, match="0001"),
    ):
        apply_migrations(conn, tmp_path)


def test_editing_an_applied_migration_is_an_error(tmp_path: Path, scratch_db_url: str) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, tmp_path)
        _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int, w int);")
        with pytest.raises(MigrationError, match="checksum"):
            apply_migrations(conn, tmp_path)


def test_applied_migration_missing_from_disk_is_an_error(
    tmp_path: Path, scratch_db_url: str
) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, tmp_path)
        (tmp_path / "0001_a.sql").rename(tmp_path / "0001_renamed.sql")
        with pytest.raises(MigrationError, match=re.escape("0001_a.sql")):
            apply_migrations(conn, tmp_path)


def test_repo_migrations_install_pgvector(scratch_db_url: str) -> None:
    repo_migrations = Path(__file__).resolve().parents[2] / "db" / "migrations"
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, repo_migrations)
        row = conn.execute("SELECT 1 FROM pg_extension WHERE extname = 'vector'").fetchone()
        assert row == (1,)


def test_requires_autocommit_so_each_file_really_commits(
    tmp_path: Path, scratch_db_url: str
) -> None:
    # In psycopg, transaction() inside an implicit transaction is only a SAVEPOINT;
    # nothing would be durable until the caller happened to commit.
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    with psycopg.connect(scratch_db_url) as conn, pytest.raises(ValueError, match="autocommit"):
        apply_migrations(conn, tmp_path)


def test_applied_migrations_are_visible_to_other_connections(
    tmp_path: Path, scratch_db_url: str
) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE t (v int);")
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, tmp_path)
        with psycopg.connect(scratch_db_url) as other:
            assert other.execute("SELECT to_regclass('t')").fetchone() != (None,)
