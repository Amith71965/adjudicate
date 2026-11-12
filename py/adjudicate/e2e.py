"""Throwaway database clones for the end-to-end review flow (`make e2e`).

The review log is append-only, so a browser test must never write into the real database: it
runs against ``e2e_<random>``, a template copy of it, dropped afterwards. Only the local
compose database qualifies (``assert_disposable``), and only ``e2e_*`` names can be dropped.

    python -m adjudicate.e2e clone   # prints the clone's URL
    python -m adjudicate.e2e drop URL
"""

from __future__ import annotations

import re
import sys
import uuid

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from adjudicate.db import UnsafeDatabaseError, assert_disposable, database_url

_CLONE = re.compile(r"^e2e_[0-9a-f]{12}$")


def _with_db(url: str, dbname: str) -> str:
    params = conninfo_to_dict(url)
    params["dbname"] = dbname
    return make_conninfo(**params)  # type: ignore[arg-type]


def _admin(url: str) -> psycopg.Connection[tuple[object, ...]]:
    return psycopg.connect(_with_db(url, "postgres"), autocommit=True)


def clone_database(url: str, template: str) -> str:
    """Copy ``template`` (no other sessions may be connected to it) to a new e2e_* database."""
    assert_disposable(url)
    name = f"e2e_{uuid.uuid4().hex[:12]}"
    with _admin(url) as admin:
        admin.execute(
            sql.SQL("CREATE DATABASE {} TEMPLATE {}").format(
                sql.Identifier(name), sql.Identifier(template)
            )
        )
    return _with_db(url, name)


def drop_database(url: str) -> None:
    assert_disposable(url)
    name = str(conninfo_to_dict(url).get("dbname", ""))
    if not _CLONE.match(name):
        raise UnsafeDatabaseError(f"refusing to drop {name!r}: only e2e_* clones are disposable")
    with _admin(url) as admin:
        drop = sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)")
        admin.execute(drop.format(sql.Identifier(name)))


def main(argv: list[str]) -> int:
    if argv[:1] == ["clone"]:
        url = database_url()
        print(clone_database(url, str(conninfo_to_dict(url)["dbname"])))
        return 0
    if argv[:1] == ["drop"] and len(argv) == 2:
        drop_database(argv[1])
        return 0
    print("usage: python -m adjudicate.e2e clone | drop URL", file=sys.stderr)
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
