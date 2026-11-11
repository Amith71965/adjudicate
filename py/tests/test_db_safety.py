"""The test suite creates and force-drops databases; it must only ever do that locally."""

from __future__ import annotations

import pytest

from adjudicate.db import UnsafeDatabaseError, assert_disposable, describe_target


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://adjudicate:adjudicate@localhost:54329/adjudicate",
        "postgresql://adjudicate:adjudicate@127.0.0.1:54329/adjudicate",
    ],
)
def test_local_compose_db_is_disposable(url: str) -> None:
    assert_disposable(url, env={})


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://u:p@db.prod.example.com:5432/app",
        "postgresql://u:p@localhost:5432/app",  # a host Postgres, not our container
        "postgresql://u:p@10.0.0.5:54329/app",
    ],
)
def test_anything_else_is_refused(url: str) -> None:
    with pytest.raises(UnsafeDatabaseError):
        assert_disposable(url, env={})


def test_explicit_opt_in_allows_a_non_default_target() -> None:
    assert_disposable(
        "postgresql://u:p@ci-db:5432/app", env={"ADJUDICATE_ALLOW_TEST_DB": "ci-db:5432"}
    )


def test_opt_in_is_scoped_to_the_named_host() -> None:
    with pytest.raises(UnsafeDatabaseError):
        assert_disposable(
            "postgresql://u:p@other:5432/app", env={"ADJUDICATE_ALLOW_TEST_DB": "ci-db:5432"}
        )


def test_describe_target_never_leaks_the_password() -> None:
    text = describe_target("postgresql://adjudicate:s3cret@localhost:54329/adjudicate")
    assert "s3cret" not in text
    assert "localhost:54329/adjudicate" in text
