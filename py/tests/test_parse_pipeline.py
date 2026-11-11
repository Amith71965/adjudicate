"""Parse raw PDFs into the structured corpus, then extract verdicts — idempotently."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from pathlib import Path

import httpx
import psycopg
import pytest

from adjudicate.llm.client import LlmClient
from adjudicate.migrate import apply_migrations
from adjudicate.parse.pipeline import PARSER_VERSION, extract_pending, parse_pending

pytestmark = pytest.mark.db

FIX = Path(__file__).parent / "fixtures" / "decisions"
REPO_MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
FIXTURES = {
    "SEP152026_01B2203": "EB-1A",  # merits (remand)
    "SEP172026_06B2203": "EB-1A",  # merits (stage 2)
    "JUN092025_02B5203": "EB-2/NIW",  # motion
    "JAN312005_06B2203": "EB-1A",  # legacy
}

type Conn = psycopg.Connection[tuple[object, ...]]
DEC = "decision d JOIN raw_decision r ON r.id = d.raw_decision_id"


@pytest.fixture
def db(scratch_db_url: str) -> Iterator[Conn]:
    with psycopg.connect(scratch_db_url, autocommit=True) as conn:
        apply_migrations(conn, REPO_MIGRATIONS)
        for did, visa in FIXTURES.items():
            body = (FIX / f"{did}.pdf").read_bytes()
            conn.execute(
                "INSERT INTO raw_decision (url, decision_id, category, visa_type, listing_topic,"
                " issued_year, content, sha256, byte_size, fetched_at)"
                " VALUES (%s, %s, 'c', %s, 19, %s, %s, %s, %s, now())",
                (
                    f"https://www.uscis.gov/{did}.pdf",
                    did,
                    visa,
                    int(did[5:9]),
                    body,
                    hashlib.sha256(body).hexdigest(),
                    len(body),
                ),
            )
        yield conn


def _one(conn: Conn, sql: str, *args: object) -> tuple[object, ...]:
    row = conn.execute(sql, args).fetchone()
    assert row is not None
    return row


def test_every_fetched_pdf_becomes_one_classified_decision(db: Conn) -> None:
    stats = parse_pending(db)
    assert stats.parsed == 4
    kinds = dict(db.execute(f"SELECT r.decision_id, d.kind FROM {DEC}"))
    assert kinds == {
        "SEP152026_01B2203": "merits",
        "SEP172026_06B2203": "merits",
        "JUN092025_02B5203": "motion",
        "JAN312005_06B2203": "legacy_format",
    }


def test_merits_decisions_get_sections_outcome_and_citations(db: Conn) -> None:
    parse_pending(db)
    (outcome,) = _one(
        db,
        f"SELECT outcome FROM {DEC} WHERE r.decision_id = 'SEP172026_06B2203'",
    )
    assert outcome == "dismissed"
    kinds = {
        str(k)
        for (k,) in db.execute(
            "SELECT s.kind FROM decision_section s JOIN raw_decision r"
            " ON r.id = (SELECT raw_decision_id FROM decision WHERE id = s.decision_id)"
            " WHERE r.decision_id = 'SEP172026_06B2203'"
        )
    }
    assert {"law", "analysis", "final_merits"} <= kinds
    (n,) = _one(db, "SELECT count(*) FROM decision_citation WHERE reporter = '596 F.3d 1115'")
    assert n == 2


def test_section_offsets_slice_the_stored_text(db: Conn) -> None:
    parse_pending(db)
    rows = db.execute(
        "SELECT d.text, s.start_char, s.end_char, s.title FROM decision_section s"
        " JOIN decision d ON d.id = s.decision_id WHERE s.kind = 'final_merits'"
    ).fetchall()
    assert rows
    for text, start, end, title in rows:
        assert (
            str(text)[int(str(start)) : int(str(end))]
            .lstrip()
            .split(".", 1)[1]
            .strip()
            .startswith(str(title))
        )


def test_reparse_is_idempotent_and_versioned(db: Conn) -> None:
    parse_pending(db)
    again = parse_pending(db)
    assert again.parsed == 0
    (version,) = _one(db, "SELECT DISTINCT parser_version FROM decision")
    assert version == PARSER_VERSION


def test_unreadable_pdf_is_recorded_not_skipped(db: Conn) -> None:
    db.execute(
        "INSERT INTO raw_decision (url, decision_id, category, visa_type, content, sha256,"
        " byte_size, fetched_at) VALUES ('https://www.uscis.gov/bad.pdf', 'BAD', 'c', 'EB-1A',"
        " '\\x255044462d312e340a2525454f460a', repeat('a', 64), 15, now())"
    )
    stats = parse_pending(db)
    assert stats.failed == 1
    (kind, reason) = _one(
        db,
        f"SELECT kind, kind_reason FROM {DEC} WHERE r.decision_id = 'BAD'",
    )
    assert kind == "unreadable" and "text layer" in str(reason)


def _fake_llm(tmp_path: Path, calls: list[str]) -> LlmClient:
    def handler(request: httpx.Request) -> httpx.Response:
        user = json.loads(request.content)["messages"][1]["content"]
        calls.append(user)
        quote = "we conclude he has not demonstrated eligibility for this"
        if "Branski" not in user:  # the remand fixture
            quote = (
                "we will withdraw the decision and remand the matter for entry of a new decision"
            )
        payload = {
            "criteria": [
                {"criterion": "judging", "director": "met", "aao": "not_addressed", "quote": quote}
            ],
            "final_merits": "not_met",
        }
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": json.dumps(payload)}}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 100, "cost": 0.0002},
            },
        )

    return LlmClient(
        api_key="sk-test",
        budget_usd=1.0,
        cache_dir=tmp_path,
        transport=httpx.MockTransport(handler),
    )


def test_extraction_runs_only_on_eb1a_merits_and_records_cost(db: Conn, tmp_path: Path) -> None:
    parse_pending(db)
    calls: list[str] = []
    stats = extract_pending(db, _fake_llm(tmp_path, calls))
    assert stats.extracted == 2 and len(calls) == 2  # motion + legacy skipped
    (n, model, cost) = _one(
        db, "SELECT count(*), max(model), sum(cost_usd) FROM decision_extraction"
    )
    assert n == 2 and model == "anthropic/claude-haiku-5.5" and float(str(cost)) > 0
    (verdicts,) = _one(db, "SELECT count(*) FROM criterion_verdict")
    assert verdicts == 2


def test_extraction_is_idempotent(db: Conn, tmp_path: Path) -> None:
    parse_pending(db)
    calls: list[str] = []
    client = _fake_llm(tmp_path, calls)
    extract_pending(db, client)
    again = extract_pending(db, client)
    assert again.extracted == 0 and len(calls) == 2


def test_extraction_failure_is_recorded_and_the_run_continues(db: Conn, tmp_path: Path) -> None:
    parse_pending(db)

    def handler(request: httpx.Request) -> httpx.Response:
        bad = {
            "criteria": [
                {
                    "criterion": "judging",
                    "director": "met",
                    "aao": "met",
                    "quote": "this sentence is not in the decision at all",
                }
            ],
            "final_merits": "not_met",
        }
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": json.dumps(bad)}}],
                "usage": {"cost": 0.0001},
            },
        )

    client = LlmClient(
        api_key="sk-test",
        budget_usd=1.0,
        cache_dir=tmp_path,
        transport=httpx.MockTransport(handler),
    )
    stats = extract_pending(db, client)
    assert stats.failed == 2 and stats.extracted == 0
    (n,) = _one(db, "SELECT count(*) FROM decision_extraction WHERE error LIKE 'GroundingError%%'")
    assert n == 2
    (verdicts,) = _one(db, "SELECT count(*) FROM criterion_verdict")
    assert verdicts == 0  # an ungrounded extraction never enters the corpus


# --- database review (phase 2) -------------------------------------------------------------


def test_reparse_after_version_bump_keeps_ids_and_paid_extractions(
    db: Conn, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    parse_pending(db)
    extract_pending(db, _fake_llm(tmp_path, []))
    ids_before = dict(db.execute("SELECT raw_decision_id, id FROM decision"))
    monkeypatch.setattr("adjudicate.parse.pipeline.PARSER_VERSION", "test-bump")
    assert parse_pending(db).parsed == 5 - 1  # all readable rows re-parsed (4 fixtures)
    assert dict(db.execute("SELECT raw_decision_id, id FROM decision")) == ids_before
    (n,) = _one(db, "SELECT count(*) FROM decision_extraction")
    assert n == 2  # extraction rows survive the re-parse ...


def test_stale_extractions_are_redone_when_the_parser_changes(
    db: Conn, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    parse_pending(db)
    calls: list[str] = []
    client = _fake_llm(tmp_path, calls)
    extract_pending(db, client)
    monkeypatch.setattr("adjudicate.parse.pipeline.PARSER_VERSION", "test-bump")
    parse_pending(db)
    stats = extract_pending(db, client)  # ... but are re-extracted against the new text
    assert stats.extracted == 2
    (version,) = _one(db, "SELECT DISTINCT parser_version FROM decision_extraction")
    assert version == "test-bump"


def test_failed_extractions_can_be_retried_and_keep_their_cost(db: Conn, tmp_path: Path) -> None:
    parse_pending(db)

    def bad(request: httpx.Request) -> httpx.Response:
        payload = {
            "criteria": [
                {
                    "criterion": "judging",
                    "director": "met",
                    "aao": "met",
                    "quote": "not in the decision at all, invented",
                }
            ],
            "final_merits": "not_met",
        }
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": json.dumps(payload)}}],
                "usage": {"cost": 0.001},
            },
        )

    failing = LlmClient(
        api_key="sk-test",
        budget_usd=1.0,
        cache_dir=tmp_path / "a",
        transport=httpx.MockTransport(bad),
    )
    extract_pending(db, failing)
    assert (
        extract_pending(db, _fake_llm(tmp_path / "b", [])).extracted == 0
    )  # not retried by default
    stats = extract_pending(db, _fake_llm(tmp_path / "c", []), retry_failed=True)
    assert stats.extracted == 2
    (attempts, cost) = _one(db, "SELECT min(attempts), min(cost_usd) FROM decision_extraction")
    assert attempts == 2 and float(str(cost)) >= 0.002  # first (failed) attempt's spend kept


def test_sections_store_their_text_with_a_full_text_index(db: Conn) -> None:
    parse_pending(db)
    (body, start, end, text) = _one(
        db,
        "SELECT s.body, s.start_char, s.end_char, d.text FROM decision_section s"
        " JOIN decision d ON d.id = s.decision_id WHERE s.kind = 'final_merits' LIMIT 1",
    )
    assert body == str(text)[int(str(start)) : int(str(end))]
    (hits,) = _one(
        db,
        "SELECT count(*) FROM decision_section"
        " WHERE fts @@ plainto_tsquery('english', 'sustained acclaim')",
    )
    assert int(str(hits)) >= 1


def test_content_without_byte_size_is_rejected(db: Conn) -> None:
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(
            "INSERT INTO raw_decision (url, decision_id, category, visa_type, content, sha256,"
            " fetched_at) VALUES ('https://www.uscis.gov/n.pdf', 'N', 'c', 'EB-1A', '\\x25',"
            " repeat('b', 64), now())"
        )


def test_decision_ids_are_unique_across_the_corpus(db: Conn) -> None:
    with pytest.raises(psycopg.errors.UniqueViolation):
        db.execute(
            "INSERT INTO raw_decision (url, decision_id, category, visa_type)"
            " VALUES ('https://www.uscis.gov/dup.pdf', 'SEP152026_01B2203', 'c', 'EB-1A')"
        )


def test_failed_prong_is_dropped_unless_not_met() -> None:
    from adjudicate.parse.verdicts import CriterionVerdict

    v = CriterionVerdict.model_validate(
        {
            "criterion": "judging",
            "director": "met",
            "aao": "met",
            "failed_prong": "irrelevant",
            "quote": "x" * 12,
        }
    )
    assert v.failed_prong is None


def test_budget_stop_records_the_spend_before_stopping(db: Conn, tmp_path: Path) -> None:
    from adjudicate.llm.client import BudgetExceededError

    parse_pending(db)
    client = _fake_llm(tmp_path, [])
    client.budget_usd = 0.00025  # first call fits, the second cannot
    with pytest.raises(BudgetExceededError):
        extract_pending(db, client)
    (total,) = _one(db, "SELECT coalesce(sum(cost_usd), 0) FROM decision_extraction")
    assert float(str(total)) == pytest.approx(client.spent_usd)


def test_merits_decision_with_a_motion_order_is_reclassified(db: Conn) -> None:
    parse_pending(db)
    # Corrupt one stored merits text's ORDER line, bump the version, re-parse from raw: the
    # raw PDF still says "appeal is dismissed", so instead test the pure helper.
    from adjudicate.parse.pipeline import reconcile_kind

    kind, reason = reconcile_kind("merits", "ok", "motion_dismissed")
    assert kind == "motion" and "ORDER" in reason
    kind, reason = reconcile_kind("merits", "ok", "unknown")
    assert kind == "merits" and "WARNING" in reason
