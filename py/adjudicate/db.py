"""Database access for the corpus store."""

from __future__ import annotations

import os

import psycopg

DEFAULT_DATABASE_URL = "postgresql://adjudicate:adjudicate@localhost:54329/adjudicate"


def database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL)


def connect() -> psycopg.Connection[tuple[object, ...]]:
    """Open a connection to the corpus database.

    Raises psycopg.OperationalError if the server is unreachable; callers
    must not swallow it — a missing corpus is never a silent empty result.
    """
    return psycopg.connect(database_url(), connect_timeout=5)
