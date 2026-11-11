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
from adjudicate.parse.verdicts import DEFAULT_MODEL, GroundingError, extract_verdicts

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


def parse_pending(conn: Conn, *, log: Callable[[str], None] = lambda _m: None) -> ParseStats:
    require_autocommit(conn, "parse_pending")
    pending = conn.execute(
        "SELECT r.id, r.visa_type, r.content FROM raw_decision r"
        " LEFT JOIN decision d ON d.raw_decision_id = r.id"
        " WHERE r.content IS NOT NULL AND (d.id IS NULL OR d.parser_version <> %s)"
        " ORDER BY r.id",
        (PARSER_VERSION,),
    ).fetchall()
    stats = ParseStats()
    for raw_id, visa, content in pending:
        with conn.transaction():
            conn.execute("DELETE FROM decision WHERE raw_decision_id = %s", (raw_id,))
            try:
                if not isinstance(content, bytes | memoryview):
                    raise TypeError(f"raw_decision {raw_id}: content is {type(content).__name__}")
                normalised = normalise(pdf_to_text(bytes(content)))
            except PdfTextError as exc:
                conn.execute(
                    "INSERT INTO decision (raw_decision_id, parser_version, kind, kind_reason)"
                    " VALUES (%s, %s, 'unreadable', %s)",
                    (raw_id, PARSER_VERSION, str(exc)),
                )
                stats.failed += 1
                continue
            text = normalised.text
            verdict = classify(text, VisaType(str(visa)))
            row = conn.execute(
                "INSERT INTO decision (raw_decision_id, parser_version, kind, kind_reason, words,"
                " outcome, text, repairs) VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
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
            ).fetchone()
            if row is None:  # pragma: no cover
                raise RuntimeError("decision insert returned no id")
            decision_id = row[0]
            if verdict.kind is DecisionKind.MERITS:
                for ordinal, s in enumerate(split_sections(text)):
                    conn.execute(
                        "INSERT INTO decision_section (decision_id, ordinal, kind, title,"
                        " criterion, start_char, end_char) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                        (
                            decision_id,
                            ordinal,
                            s.kind.value,
                            s.title,
                            s.criterion.value if s.criterion else None,
                            s.start,
                            s.end,
                        ),
                    )
            for c in case_citations(text):
                conn.execute(
                    "INSERT INTO decision_citation (decision_id, reporter, name)"
                    " VALUES (%s, %s, %s)",
                    (decision_id, c.reporter, c.name),
                )
            stats.parsed += 1
        if stats.parsed % 100 == 0:
            log(f"parsed {stats.parsed}/{len(pending)}")
    return stats


def extract_pending(
    conn: Conn,
    client: LlmClient,
    *,
    model: str = DEFAULT_MODEL,
    limit: int | None = None,
    log: Callable[[str], None] = lambda _m: None,
) -> ExtractStats:
    require_autocommit(conn, "extract_pending")
    pending = conn.execute(
        "SELECT d.id, d.text FROM decision d JOIN raw_decision r ON r.id = d.raw_decision_id"
        " LEFT JOIN decision_extraction e ON e.decision_id = d.id"
        " WHERE d.kind = 'merits' AND r.visa_type = 'EB-1A' AND e.decision_id IS NULL"
        " ORDER BY d.id LIMIT %s",
        (limit,),
    ).fetchall()
    stats = ExtractStats()
    for decision_id, text in pending:
        before = client.spent_usd
        try:
            result = extract_verdicts(client, str(text), model=model)
        except BudgetExceededError:
            log(f"budget reached after {stats.extracted} extraction(s); stopping")
            raise
        except (LlmError, GroundingError, ValueError) as exc:
            cost = client.spent_usd - before
            stats.failed += 1
            stats.cost_usd += cost
            conn.execute(
                "INSERT INTO decision_extraction (decision_id, model, cost_usd, error)"
                " VALUES (%s, %s, %s, %s)",
                (decision_id, model, cost, f"{type(exc).__name__}: {exc}"[:2000]),
            )
            log(f"FAILED decision {decision_id}: {type(exc).__name__}")
            continue
        cost = client.spent_usd - before
        with conn.transaction():
            conn.execute(
                "INSERT INTO decision_extraction (decision_id, model, final_merits, cost_usd)"
                " VALUES (%s, %s, %s, %s)",
                (decision_id, model, result.final_merits.value, cost),
            )
            for c in result.criteria:
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
        stats.extracted += 1
        stats.cost_usd += cost
        if stats.extracted % 25 == 0:
            log(f"extracted {stats.extracted}/{len(pending)} (${client.spent_usd:.4f})")
    return stats
