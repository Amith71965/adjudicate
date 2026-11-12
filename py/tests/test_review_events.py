"""Phase 8: the attorney's review log — an append-only event store behind the review UI.

Every disposition of an AI objection (resolve / dismiss / reopen), every sign-off and every
export is one immutable row. The log is the case's version history, so the database itself
refuses to edit or delete it.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

from adjudicate.api.app import create_app
from adjudicate.migrate import apply_migrations
from tests.test_retrieve_index import FakeEmbedder

pytestmark = pytest.mark.db
REPO_MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
RESOLVE = {
    "item_id": "prong:judging/whole",
    "action": "resolve",
    "note": "Added review reports as Exhibit 14.",
    "actor": "Attorney A",
}


@pytest.fixture
def db_url(scratch_db_url: str) -> str:
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, REPO_MIGRATIONS)
    return scratch_db_url


@pytest.fixture
def client(db_url: str) -> Iterator[TestClient]:
    app = create_app(lambda: psycopg.connect(db_url, autocommit=True), FakeEmbedder())
    with TestClient(app) as c:
        yield c


def test_a_new_case_has_no_events(client: TestClient) -> None:
    r = client.get("/cases/P01/events")
    assert r.status_code == 200 and r.json() == {"case_id": "P01", "events": []}


def test_an_event_is_appended_and_listed_in_order(client: TestClient) -> None:
    first = client.post("/cases/P01/events", json=RESOLVE)
    assert first.status_code == 201
    ev = first.json()
    assert {k: ev[k] for k in RESOLVE} == RESOLVE and ev["id"] > 0 and ev["created_at"]
    reopen = {**RESOLVE, "action": "reopen", "note": "Reports missing."}
    client.post("/cases/P01/events", json=reopen)
    events = client.get("/cases/P01/events").json()["events"]
    assert [e["action"] for e in events] == ["resolve", "reopen"]


def test_events_belong_to_one_case(client: TestClient) -> None:
    client.post("/cases/P01/events", json=RESOLVE)
    assert client.get("/cases/P02/events").json()["events"] == []


@pytest.mark.parametrize("note", ["", "   ", "ok"])
def test_a_disposition_needs_a_real_attorney_note(client: TestClient, note: str) -> None:
    assert client.post("/cases/P01/events", json={**RESOLVE, "note": note}).status_code == 422


@pytest.mark.parametrize(
    "body",
    [
        {**RESOLVE, "item_id": None},  # an objection disposition names its objection
        {**RESOLVE, "action": "signoff"},  # a sign-off is for the case, not one item
        {**RESOLVE, "action": "approve"},  # unknown action
        {**RESOLVE, "actor": ""},  # someone is accountable
        {**RESOLVE, "item_id": "judging; DROP TABLE review_event"},
    ],
)
def test_malformed_events_are_refused(client: TestClient, body: dict[str, object]) -> None:
    assert client.post("/cases/P01/events", json=body).status_code == 422


def test_case_ids_are_validated(client: TestClient) -> None:
    assert client.get("/cases/../events").status_code in (404, 422)
    assert client.get("/cases/X1/events").status_code == 422


def test_signoff_and_export_are_case_level(client: TestClient) -> None:
    for action in ("signoff", "export"):
        note = "I reviewed every objection."
        body = {"item_id": None, "action": action, "note": note, "actor": "Attorney A"}
        assert client.post("/cases/P01/events", json=body).status_code == 201


def test_the_log_cannot_be_edited_or_deleted(client: TestClient, db_url: str) -> None:
    client.post("/cases/P01/events", json=RESOLVE)
    with psycopg.connect(db_url, autocommit=True) as conn:
        for sql in ("UPDATE review_event SET note = 'rewritten'", "DELETE FROM review_event"):
            with pytest.raises(psycopg.Error, match="append-only"):
                conn.execute(sql)
    assert client.get("/cases/P01/events").json()["events"][0]["note"] == RESOLVE["note"]


def test_a_database_outage_is_a_503_not_an_empty_history() -> None:
    def down() -> psycopg.Connection[tuple[object, ...]]:
        raise psycopg.OperationalError("connection refused")

    with TestClient(create_app(down, FakeEmbedder())) as c:
        assert c.get("/cases/P01/events").status_code == 503
        assert c.post("/cases/P01/events", json=RESOLVE).status_code == 503


# --- phase-8 review fixes --------------------------------------------------------------------


def test_non_ascii_digits_are_a_422_not_a_database_500(client: TestClient) -> None:
    arabic_indic = chr(0x661) + chr(0x662)  # pass a Unicode \d, fail the DB CHECK [0-9]
    assert client.get(f"/cases/P{arabic_indic}/events").status_code == 422


@pytest.mark.parametrize("field", ["note", "actor"])
def test_nul_characters_are_refused(client: TestClient, field: str) -> None:
    body = {**RESOLVE, field: "Added the\x00 reports."}
    assert client.post("/cases/P01/events", json=body).status_code == 422


def test_a_stale_writer_is_refused_so_two_tabs_cannot_both_dispose(client: TestClient) -> None:
    # both tabs loaded an empty log; the first write wins, the second must not land
    first = client.post("/cases/P01/events", json={**RESOLVE, "expected_last_id": 0})
    second = client.post(
        "/cases/P01/events", json={**RESOLVE, "action": "dismiss", "expected_last_id": 0}
    )
    assert first.status_code == 201 and second.status_code == 409
    assert [e["action"] for e in client.get("/cases/P01/events").json()["events"]] == ["resolve"]
    third = {**RESOLVE, "action": "reopen", "expected_last_id": first.json()["id"]}
    assert client.post("/cases/P01/events", json=third).status_code == 201


def test_the_precondition_is_per_case(client: TestClient) -> None:
    client.post("/cases/P02/events", json={**RESOLVE, "expected_last_id": 0})
    fresh = client.post("/cases/P01/events", json={**RESOLVE, "expected_last_id": 0})
    assert fresh.status_code == 201


def test_health_names_the_schema_that_holds_the_review_log(db_url: str) -> None:
    app = create_app(lambda: psycopg.connect(db_url, autocommit=True), FakeEmbedder())
    with TestClient(app) as c:
        assert c.get("/health").json()["review_log_schema"] == "public"
