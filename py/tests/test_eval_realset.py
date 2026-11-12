"""Phase-7 real held-out set: a temporal split (test = EB-1A merits decided on or after the
cutoff; the retrieval index may only use decisions before it) and per-criterion labels."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from datetime import date
from pathlib import Path

import psycopg
import pytest

from adjudicate.eval.realset import Label, criterion_label, load_split
from adjudicate.migrate import apply_migrations

pytestmark = pytest.mark.db
MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
Conn = psycopg.Connection[tuple[object, ...]]


@pytest.mark.parametrize(
    ("director", "aao", "expected"),
    [
        ("not_met", "met", Label("met", "aao")),  # the AAO decided: its verdict is the truth
        ("met", "not_met", Label("not_met", "aao")),
        ("not_met", "not_reached", Label("not_met", "director")),  # Director's finding stands
        ("met", "not_addressed", Label("met", "director")),
        ("not_met", "waived", Label("not_met", "director")),  # abandoned on appeal
        ("not_addressed", "not_reached", Label(None, None)),  # nobody decided: excluded
    ],
)
def test_criterion_label(director: str, aao: str, expected: Label) -> None:
    assert criterion_label(director, aao) == expected


@pytest.fixture
def db(scratch_db_url: str) -> Iterator[Conn]:
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, MIGRATIONS)
        yield conn


def _decision(
    conn: Conn, did: str, visa: str, decided: date, kind: str, verdicts: list[tuple[str, str, str]]
) -> None:
    body = did.encode()
    raw = conn.execute(
        "INSERT INTO raw_decision (url, decision_id, category, visa_type, content, sha256,"
        " byte_size, fetched_at, decision_date) VALUES (%s, %s, 'c', %s, %s, %s, %s, now(), %s)"
        " RETURNING id",
        (
            f"https://www.uscis.gov/{did}.pdf",
            did,
            visa,
            body,
            hashlib.sha256(body).hexdigest(),
            len(body),
            decided,
        ),
    ).fetchone()
    assert raw is not None
    dec = conn.execute(
        "INSERT INTO decision (raw_decision_id, parser_version, kind, kind_reason, outcome, text)"
        " VALUES (%s, 'p', %s, 'r', 'dismissed', 'text of the decision') RETURNING id",
        (raw[0], kind),
    ).fetchone()
    assert dec is not None
    conn.execute(
        "INSERT INTO decision_extraction (decision_id, model, final_merits, parser_version)"
        " VALUES (%s, 'm', 'not_reached', 'p')",
        (dec[0],),
    )
    for crit, director, aao in verdicts:
        conn.execute(
            "INSERT INTO criterion_verdict (decision_id, criterion, director, aao, quote)"
            " VALUES (%s, %s, %s, %s, 'q')",
            (dec[0], crit, director, aao),
        )  # fmt: skip


def test_split_is_temporal_and_merits_only(db: Conn) -> None:
    _decision(db, "OLD1", "EB-1A", date(2026, 5, 31), "merits", [("judging", "met", "met")])
    _decision(db, "NEW1", "EB-1A", date(2026, 6, 1), "merits",
              [("judging", "met", "met"), ("awards", "not_met", "not_reached")])  # fmt: skip
    _decision(db, "NEW2", "EB-1A", date(2026, 7, 2), "motion", [("judging", "met", "met")])
    _decision(db, "NEW3", "O-1", date(2026, 7, 2), "merits", [("judging", "met", "met")])
    split = load_split(db, cutoff=date(2026, 6, 1))
    assert [d.decision_id for d in split.test] == ["NEW1"]
    assert split.index_decision_ids == {"OLD1"}
    (d,) = split.test
    assert d.outcome == "dismissed" and d.decided == date(2026, 6, 1)
    assert [(c.criterion, c.label) for c in d.criteria] == [
        ("awards", Label("not_met", "director")),
        ("judging", Label("met", "aao")),
    ]


def test_split_refuses_a_test_decision_without_verdicts(db: Conn) -> None:
    _decision(db, "NEW1", "EB-1A", date(2026, 6, 3), "merits", [])
    with pytest.raises(ValueError, match="NEW1"):
        load_split(db, cutoff=date(2026, 6, 1))
