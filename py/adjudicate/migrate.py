"""Minimal forward-only SQL migration runner.

Files named ``NNNN_description.sql`` are applied in numeric order, each in its
own transaction, and recorded with a sha256 checksum in ``schema_migrations``.

Every anomaly is an error, never a skip: a misnamed ``.sql`` file, a duplicate
numeric prefix, an applied migration edited or removed on disk, or a failing
statement. A silently skipped schema file would leave tables missing while
``make migrate`` still reported success.
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

import psycopg

from adjudicate.db import connect, describe_target, require_autocommit

_MIGRATION_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
_ADVISORY_LOCK_KEY = 0x4144_4A55  # "ADJU": serialises concurrent runners

type Conn = psycopg.Connection[tuple[object, ...]]


class MigrationError(RuntimeError):
    """The migration set is invalid or a migration failed to apply."""


def _checksum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _discover(directory: Path) -> list[Path]:
    sql_files = [p for p in directory.iterdir() if p.is_file() and p.suffix.lower() == ".sql"]
    misnamed = sorted(p.name for p in sql_files if not _MIGRATION_NAME.match(p.name))
    if misnamed:
        raise MigrationError(
            f"misnamed migration file(s) {misnamed}; expected NNNN_lower_snake.sql"
        )
    files = sorted(sql_files, key=lambda p: p.name)
    prefixes: dict[str, str] = {}
    for p in files:
        prefix = p.name[:4]
        if prefix in prefixes:
            raise MigrationError(
                f"duplicate migration prefix {prefix}: {prefixes[prefix]}, {p.name}"
            )
        prefixes[prefix] = p.name
    return files


def _ensure_table(conn: Conn) -> None:
    with conn.transaction():
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            " version text PRIMARY KEY,"
            " applied_at timestamptz NOT NULL DEFAULT now())"
        )
        conn.execute("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text")


def _verify_recorded(conn: Conn, files: list[Path]) -> set[str]:
    recorded = {
        str(version): checksum
        for version, checksum in conn.execute("SELECT version, checksum FROM schema_migrations")
    }
    on_disk = {p.name: p for p in files}
    missing = sorted(set(recorded) - set(on_disk))
    if missing:
        raise MigrationError(f"applied migration(s) missing on disk: {missing}")
    with conn.transaction():
        for name, checksum in recorded.items():
            actual = _checksum(on_disk[name])
            if checksum is None:  # recorded before checksums existed: adopt once
                conn.execute(
                    "UPDATE schema_migrations SET checksum = %s WHERE version = %s",
                    (actual, name),
                )
            elif checksum != actual:
                raise MigrationError(f"{name}: checksum changed after it was applied")
    return set(recorded)


def apply_migrations(conn: Conn, directory: Path) -> list[str]:
    """Validate the migration set, apply pending files; return the names applied."""
    require_autocommit(conn, "apply_migrations")
    files = _discover(directory)
    _ensure_table(conn)
    conn.execute("SELECT pg_advisory_lock(%s)", (_ADVISORY_LOCK_KEY,))
    try:
        done = _verify_recorded(conn, files)
        applied: list[str] = []
        for path in files:
            if path.name in done:
                continue
            try:
                with conn.transaction():
                    conn.execute(path.read_text().encode())
                    conn.execute(
                        "INSERT INTO schema_migrations (version, checksum) VALUES (%s, %s)",
                        (path.name, _checksum(path)),
                    )
            except psycopg.Error as exc:
                raise MigrationError(f"{path.name}: {exc}") from exc
            applied.append(path.name)
        return applied
    finally:
        conn.execute("SELECT pg_advisory_unlock(%s)", (_ADVISORY_LOCK_KEY,))


def main() -> int:
    directory = Path(__file__).resolve().parents[2] / "db" / "migrations"
    print(f"migrating {describe_target()}")
    try:
        with connect(autocommit=True) as conn:
            applied = apply_migrations(conn, directory)
    except (MigrationError, psycopg.OperationalError) as exc:
        print(f"migration failed: {exc}", file=sys.stderr)
        return 1
    print(f"applied {len(applied)} migration(s): {', '.join(applied) or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
