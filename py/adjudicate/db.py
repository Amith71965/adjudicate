"""Database access for the corpus store."""

from __future__ import annotations

import os
from collections.abc import Mapping

import psycopg
from psycopg.conninfo import conninfo_to_dict

DEFAULT_DATABASE_URL = "postgresql://adjudicate:adjudicate@localhost:54329/adjudicate"

# The compose container: the only target the test suite may create/drop databases on.
_DISPOSABLE_HOSTS = frozenset({"localhost", "127.0.0.1"})
_DISPOSABLE_PORT = "54329"
_OPT_IN_ENV = "ADJUDICATE_ALLOW_TEST_DB"


class UnsafeDatabaseError(RuntimeError):
    """Refused to run destructive test setup against a non-disposable database."""


def database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL)


def describe_target(url: str | None = None) -> str:
    """``host:port/dbname`` for logs. Never includes credentials."""
    params = conninfo_to_dict(url or database_url())
    return f"{params.get('host', '?')}:{params.get('port', '5432')}/{params.get('dbname', '?')}"


def assert_disposable(url: str, env: Mapping[str, str] | None = None) -> None:
    """Raise unless ``url`` is the local compose DB or explicitly opted in by host:port."""
    environ = os.environ if env is None else env
    params = conninfo_to_dict(url)
    host, port = str(params.get("host", "")), str(params.get("port", "5432"))
    if host in _DISPOSABLE_HOSTS and port == _DISPOSABLE_PORT:
        return
    if environ.get(_OPT_IN_ENV) == f"{host}:{port}":
        return
    raise UnsafeDatabaseError(
        f"refusing destructive test setup on {describe_target(url)}; "
        f"set {_OPT_IN_ENV}={host}:{port} if this database is disposable"
    )


def connect(*, autocommit: bool = False) -> psycopg.Connection[tuple[object, ...]]:
    """Open a connection to the corpus database.

    Writers that commit unit-by-unit (migrations, harvests) need
    ``autocommit=True``: in psycopg, ``conn.transaction()`` inside an implicit
    transaction is only a SAVEPOINT and commits nothing.

    Raises psycopg.OperationalError if the server is unreachable; callers
    must not swallow it — a missing corpus is never a silent empty result.
    """
    return psycopg.connect(database_url(), connect_timeout=5, autocommit=autocommit)


def require_autocommit(conn: psycopg.Connection[tuple[object, ...]], purpose: str) -> None:
    if not conn.autocommit:
        raise ValueError(
            f"{purpose} needs an autocommit connection so each unit of work really commits"
        )
