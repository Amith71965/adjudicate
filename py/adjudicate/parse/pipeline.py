"""raw_decision → decision (+ sections, citations) → LLM verdicts. Idempotent, per-row commits.

- ``parse_pending``: deterministic; re-parses rows whose parser_version is stale.
- ``extract_pending``: LLM verdicts for EB-1A merits decisions only. A grounding or
  schema failure is stored as an error row (visible, never a verdict); a budget
  overrun stops the run instead of being recorded as a per-decision failure.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass

import psycopg

from adjudicate.db import require_autocommit
from adjudicate.harvest.categories import VisaType
from adjudicate.llm.client import BudgetExceededError, LlmClient, LlmError
from adjudicate.parse.filter import DecisionKind, classify
from adjudicate.parse.normalise import normalise
from adjudicate.parse.pdf import PdfTextError, pdf_to_text
from adjudicate.parse.structure import case_citations, extract_outcome, split_sections
from adjudicate.parse.verdicts import (
    DEFAULT_MODEL,
    DecisionVerdicts,
    GroundingError,
    extract_verdicts,
)

PARSER_VERSION = "2026.11.10-1"

type Conn = psycopg.Connection[tuple[object, ...]]


@dataclass(slots=True)
class ParseStats:
    parsed: int = 0
    failed: int = 0


@dataclass(slots=True)
class ExtractStats:
    extracted: int = 0
    failed: int = 0
    cost_usd: float = 0.0


_UPSERT_DECISION = (
    "INSERT INTO decision (raw_decision_id, parser_version, kind, kind_reason, words, outcome,"
    " text, repairs) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
    " ON CONFLICT (raw_decision_id) DO UPDATE SET parser_version = EXCLUDED.parser_version,"
    " kind = EXCLUDED.kind, kind_reason = EXCLUDED.kind_reason, words = EXCLUDED.words,"
    " outcome = EXCLUDED.outcome, text = EXCLUDED.text, repairs = EXCLUDED.repairs,"
    " parsed_at = now() RETURNING id"
)
_CLEAR_DERIVED = (
    "DELETE FROM decision_section WHERE decision_id = %s",
    "DELETE FROM decision_citation WHERE decision_id = %s",
)


def _upsert(conn: Conn, values: tuple[object, ...]) -> int:
    row = conn.execute(_UPSERT_DECISION, values).fetchone()
    if row is None:  # pragma: no cover
        raise RuntimeError("decision upsert returned no id")
    return int(str(row[0]))


def _parse_one(conn: Conn, raw_id: int, visa: str) -> bool:
    """Parse one raw PDF in its own transaction. Returns False if it was unreadable.

    The decision id is stable across re-parses (upsert); only derived rows are replaced.
    """
    content_row = conn.execute(
        "SELECT content FROM raw_decision WHERE id = %s", (raw_id,)
    ).fetchone()
    content = content_row[0] if content_row else None
    if not isinstance(content, bytes | memoryview):
        raise TypeError(f"raw_decision {raw_id}: content is {type(content).__name__}")
    with conn.transaction():
        try:
            normalised = normalise(pdf_to_text(bytes(content)))
        except PdfTextError as exc:
            decision_id = _upsert(
                conn, (raw_id, PARSER_VERSION, "unreadable", str(exc), 0, None, None, "{}")
            )
            for sql in _CLEAR_DERIVED:
                conn.execute(sql, (decision_id,))
            return False
        text = normalised.text
        verdict = classify(text, VisaType(visa))
        decision_id = _upsert(
            conn,
            (
                raw_id,
                PARSER_VERSION,
                verdict.kind.value,
                "; ".join(verdict.reasons),
                verdict.words,
                extract_outcome(text).value,
                text,
                json.dumps(dict(normalised.repairs)),
            ),
        )
        for sql in _CLEAR_DERIVED:
            conn.execute(sql, (decision_id,))
        if verdict.kind is DecisionKind.MERITS:
            for ordinal, s in enumerate(split_sections(text)):
                conn.execute(
                    "INSERT INTO decision_section (decision_id, ordinal, kind, title, criterion,"
                    " start_char, end_char, body) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    (
                        decision_id,
                        ordinal,
                        s.kind.value,
                        s.title,
                        s.criterion.value if s.criterion else None,
                        s.start,
                        s.end,
                        text[s.start : s.end],
                    ),
                )
        else:  # no longer a merits decision: an old extraction no longer applies
            conn.execute("DELETE FROM decision_extraction WHERE decision_id = %s", (decision_id,))
        for c in case_citations(text):
            conn.execute(
                "INSERT INTO decision_citation (decision_id, reporter, name) VALUES (%s, %s, %s)",
                (decision_id, c.reporter, c.name),
            )
    return True


def parse_pending(conn: Conn, *, log: Callable[[str], None] = lambda _m: None) -> ParseStats:
    """Parse raw PDFs with no decision yet, or whose parse is from an older version.

    PDF bytes are read one row at a time, never the whole corpus into memory.
    """
    require_autocommit(conn, "parse_pending")
    pending = conn.execute(
        "SELECT r.id, r.visa_type FROM raw_decision r"
        " LEFT JOIN decision d ON d.raw_decision_id = r.id"
        " WHERE r.content IS NOT NULL AND (d.id IS NULL OR d.parser_version <> %s)"
        " ORDER BY r.id",
        (PARSER_VERSION,),
    ).fetchall()
    stats = ParseStats()
    for raw_id, visa in pending:
        if _parse_one(conn, int(str(raw_id)), str(visa)):
            stats.parsed += 1
        else:
            stats.failed += 1
        if (stats.parsed + stats.failed) % 100 == 0:
            log(f"parsed {stats.parsed + stats.failed}/{len(pending)}")
    return stats


def extract_pending(
    conn: Conn,
    client: LlmClient,
    *,
    model: str = DEFAULT_MODEL,
    limit: int | None = None,
    retry_failed: bool = False,
    log: Callable[[str], None] = lambda _m: None,
) -> ExtractStats:
    """Extract verdicts for EB-1A merits decisions lacking a current, successful extraction.

    Re-extracts when the decision was re-parsed (parser_version changed); retries failed
    attempts only when asked. Spend from earlier attempts is carried forward, never lost.
    A budget overrun stops the run; it is not recorded as a per-decision failure.
    """
    require_autocommit(conn, "extract_pending")
    pending = conn.execute(
        "SELECT d.id, d.text, d.parser_version, e.attempts, e.cost_usd FROM decision d"
        " JOIN raw_decision r ON r.id = d.raw_decision_id"
        " LEFT JOIN decision_extraction e ON e.decision_id = d.id"
        " WHERE d.kind = 'merits' AND r.visa_type = 'EB-1A'"
        " AND (e.decision_id IS NULL OR e.parser_version <> d.parser_version"
        "      OR (%s AND e.error IS NOT NULL))"
        " ORDER BY d.id LIMIT %s",
        (retry_failed, limit),
    ).fetchall()
    stats = ExtractStats()
    for decision_id, text, version, prior_attempts, prior_cost in pending:
        attempts = int(str(prior_attempts)) + 1 if prior_attempts is not None else 1
        carried = float(str(prior_cost)) if prior_cost is not None else 0.0
        before = client.spent_usd
        result: DecisionVerdicts | None = None
        error: str | None = None
        try:
            result = extract_verdicts(client, str(text), model=model)
        except BudgetExceededError:
            log(f"budget reached after {stats.extracted} extraction(s); stopping")
            raise
        except (LlmError, GroundingError, ValueError) as exc:
            error = f"{type(exc).__name__}: {exc}"[:2000]
        cost = client.spent_usd - before
        with conn.transaction():
            conn.execute("DELETE FROM decision_extraction WHERE decision_id = %s", (decision_id,))
            conn.execute(
                "INSERT INTO decision_extraction (decision_id, model, final_merits, cost_usd,"
                " error, attempts, parser_version) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (
                    decision_id,
                    model,
                    result.final_merits.value if result else None,
                    carried + cost,
                    error,
                    attempts,
                    version,
                ),
            )
            for c in result.criteria if result else []:
                conn.execute(
                    "INSERT INTO criterion_verdict (decision_id, criterion, director, aao,"
                    " failed_prong, quote) VALUES (%s, %s, %s, %s, %s, %s)",
                    (
                        decision_id,
                        c.criterion.value,
                        c.director.value,
                        c.aao.value,
                        c.failed_prong,
                        c.quote,
                    ),
                )
        stats.cost_usd += cost
        if result is None:
            stats.failed += 1
            log(f"FAILED decision {decision_id}: {str(error)[:80]}")
        else:
            stats.extracted += 1
        if (stats.extracted + stats.failed) % 25 == 0:
            log(f"extracted {stats.extracted}/{len(pending)} (${client.spent_usd:.4f})")
    return stats
