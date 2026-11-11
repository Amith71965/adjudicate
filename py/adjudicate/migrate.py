"""Minimal forward-only SQL migration runner.

Files named ``NNNN_description.sql`` are applied in numeric order, each in its
own transaction, and recorded in ``schema_migrations``. A failing file is rolled
back, not recorded, and raised — never skipped.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import psycopg

from adjudicate.db import connect

_MIGRATION_NAME = re.compile(r"^(\d{4})_[\w-]+\.sql$")


class MigrationError(RuntimeError):
    """A migration file failed to apply."""


def _pending(conn: psycopg.Connection[tuple[object, ...]], directory: Path) -> list[Path]:
    files = sorted(
        (p for p in directory.iterdir() if p.is_file() and _MIGRATION_NAME.match(p.name)),
        key=lambda p: p.name,
    )
    done = {str(r[0]) for r in conn.execute("SELECT version FROM schema_migrations")}
    return [p for p in files if p.name not in done]


def apply_migrations(conn: psycopg.Connection[tuple[object, ...]], directory: Path) -> list[str]:
    """Apply pending migrations from ``directory``; return the names applied."""
    with conn.transaction():
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            " version text PRIMARY KEY,"
            " applied_at timestamptz NOT NULL DEFAULT now())"
        )
    applied: list[str] = []
    for path in _pending(conn, directory):
        try:
            with conn.transaction():
                conn.execute(path.read_text().encode())
                conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (path.name,))
        except psycopg.Error as exc:
            raise MigrationError(f"{path.name}: {exc}") from exc
        applied.append(path.name)
    return applied


def main() -> int:
    directory = Path(__file__).resolve().parents[2] / "db" / "migrations"
    with connect() as conn:
        applied = apply_migrations(conn, directory)
    print(f"applied {len(applied)} migration(s): {', '.join(applied) or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
