from __future__ import annotations

import uuid
from collections.abc import Iterator

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from adjudicate.db import assert_disposable, database_url


@pytest.fixture
def scratch_db_url() -> Iterator[str]:
    """A brand-new empty database, dropped after the test."""
    assert_disposable(database_url())
    name = f"t_{uuid.uuid4().hex[:12]}"
    admin = psycopg.connect(database_url(), autocommit=True)
    admin.execute(f'CREATE DATABASE "{name}"')
    params = conninfo_to_dict(database_url())
    params["dbname"] = name
    try:
        yield make_conninfo(**params)  # type: ignore[arg-type]
    finally:
        admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        admin.close()
