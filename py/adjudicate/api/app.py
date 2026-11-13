"""Retrieval API. A database failure is a 503, never an empty result: for a tool that
argues from precedent, "corpus down" must not look like "no precedent found"."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict
from datetime import date
from enum import StrEnum
from typing import Annotated

import psycopg
from fastapi import FastAPI, HTTPException, Path, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, model_validator

from adjudicate.api.locate import page_texts, quote_page
from adjudicate.parse.structure import Criterion, SectionKind
from adjudicate.retrieve.chunk import CHUNKABLE_KINDS
from adjudicate.retrieve.embed import Embedder
from adjudicate.retrieve.search import SearchMode, search

type Conn = psycopg.Connection[tuple[object, ...]]


class Visa(StrEnum):
    EB1A = "EB-1A"
    O1 = "O-1"
    NIW = "EB-2/NIW"


CriterionCode = Criterion
type ConnFactory = Callable[[], Conn]


def create_app(connect: ConnFactory, embedder: Embedder) -> FastAPI:
    app = FastAPI(title="Adjudicate retrieval API", version="0.3.0")

    @contextmanager
    def db() -> Iterator[Conn]:
        try:
            conn = connect()
        except psycopg.Error as exc:
            raise HTTPException(503, "corpus database unavailable") from exc
        try:
            yield conn
        except psycopg.OperationalError as exc:
            raise HTTPException(503, "corpus database unavailable") from exc
        except psycopg.Error as exc:  # schema/programming errors are bugs, not outages
            raise HTTPException(500, f"database error: {type(exc).__name__}") from exc
        finally:
            conn.close()

    def index_problems(conn: Conn) -> list[str]:
        """Anything that would make search silently answer from part of the corpus."""
        row = conn.execute(
            "SELECT count(*), count(*) FILTER (WHERE embed_model IS DISTINCT FROM %s),"
            " (SELECT count(*) FROM decision_section s JOIN decision d ON d.id = s.decision_id"
            "  WHERE d.kind = 'merits' AND s.kind = ANY(%s) AND NOT EXISTS (SELECT 1 FROM chunk c"
            "  WHERE c.decision_id = s.decision_id AND c.section_ordinal = s.ordinal))"
            " FROM chunk",
            (embedder.name, sorted(CHUNKABLE_KINDS)),
        ).fetchone()
        chunks, stale, unchunked = (int(str(x)) for x in row) if row else (0, 0, 0)
        problems = []
        if chunks == 0:
            problems.append("no chunks indexed")
        if stale:
            problems.append(f"{stale} chunk(s) not embedded with {embedder.name}")
        if unchunked:
            problems.append(f"{unchunked} merits section(s) not chunked")
        return problems

    @app.get("/health")
    def health() -> JSONResponse:
        with db() as conn:
            row = conn.execute(
                "SELECT count(*), count(*) FILTER (WHERE embed_model = %s) FROM chunk",
                (embedder.name,),
            ).fetchone()
            problems = index_problems(conn)
            log = conn.execute(
                "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
                " WHERE c.oid = to_regclass('review_event')"
            ).fetchone()
        chunks, embedded = (int(str(row[0])), int(str(row[1]))) if row else (0, 0)
        body = {
            "db": "ok",
            "status": "degraded" if problems else "ok",
            "problems": problems,
            "chunks": chunks,
            "embedded": embedded,
            "embed_model": embedder.name,
            # which schema the review log resolves to: the e2e runner refuses anything but e2e_*
            "review_log_schema": str(log[0]) if log else None,
        }
        return JSONResponse(body, status_code=503 if problems else 200)

    @app.get("/search")
    def search_endpoint(
        q: Annotated[str, Query(min_length=1, max_length=2000, pattern=r"\S")],
        k: Annotated[int, Query(ge=1, le=50)] = 10,
        mode: SearchMode = SearchMode.HYBRID,
        visa: Visa | None = None,
        criterion: CriterionCode | None = None,
        section: SectionKind | None = None,
        before: date | None = None,  # temporal split: only decisions issued before this date
    ) -> dict[str, object]:
        if section is not None and section.value not in CHUNKABLE_KINDS:
            # never indexed: an empty answer would look like "no precedent", so refuse instead
            raise HTTPException(422, f"section {section.value!r} is not searchable")
        with db() as conn:
            if problems := index_problems(conn):
                raise HTTPException(503, "index incomplete: " + "; ".join(problems))
            hits = search(
                conn,
                embedder,
                q,
                k=k,
                mode=mode,
                visa=visa.value if visa else None,
                criterion=criterion.value if criterion else None,
                section=section.value if section else None,
                before=before,
            )
        filters = {
            "visa": visa.value if visa else None,
            "criterion": criterion.value if criterion else None,
            "section": section.value if section else None,
            "before": before.isoformat() if before else None,
        }
        # echoed so a client can tell an applied filter from one an older API ignored
        return {
            "query": q,
            "mode": mode.value,
            "filters": filters,
            "results": [asdict(h) for h in hits],
        }

    @app.get("/passages/{chunk_id}")
    def passage(chunk_id: int) -> dict[str, object]:
        with db() as conn:
            row = conn.execute(
                "SELECT c.id, r.decision_id, r.url, s.kind, s.criterion, c.body, c.start_char,"
                " c.end_char FROM chunk c JOIN decision d ON d.id = c.decision_id"
                " JOIN raw_decision r ON r.id = d.raw_decision_id"
                " JOIN decision_section s ON s.decision_id = c.decision_id"
                "  AND s.ordinal = c.section_ordinal WHERE c.id = %s",
                (chunk_id,),
            ).fetchone()
        if row is None:
            raise HTTPException(404, f"no passage {chunk_id}")
        keys = (
            "chunk_id",
            "decision_id",
            "url",
            "section_kind",
            "criterion",
            "body",
            "start_char",
            "end_char",
        )
        return dict(zip(keys, row, strict=True))

    @app.get("/decisions/{decision_id}")
    def decision(decision_id: str) -> dict[str, object]:
        with db() as conn:
            row = conn.execute(
                "SELECT d.id, r.decision_id, r.url, r.visa_type, d.kind, d.outcome,"
                " e.final_merits FROM decision d JOIN raw_decision r ON r.id = d.raw_decision_id"
                " LEFT JOIN decision_extraction e ON e.decision_id = d.id AND e.error IS NULL"
                " WHERE r.decision_id = %s",
                (decision_id,),
            ).fetchone()
            if row is None:
                raise HTTPException(404, f"no decision {decision_id}")
            pk = row[0]
            verdicts = conn.execute(
                "SELECT criterion, director, aao, failed_prong, quote FROM criterion_verdict"
                " WHERE decision_id = %s ORDER BY criterion",
                (pk,),
            ).fetchall()
            sections = conn.execute(
                "SELECT ordinal, kind, title, criterion FROM decision_section"
                " WHERE decision_id = %s ORDER BY ordinal",
                (pk,),
            ).fetchall()
        return {
            "decision_id": row[1],
            "url": row[2],
            "visa_type": row[3],
            "kind": row[4],
            "outcome": row[5],
            "final_merits": row[6],
            "verdicts": [
                dict(zip(("criterion", "director", "aao", "failed_prong", "quote"), v, strict=True))
                for v in verdicts
            ],
            "sections": [
                dict(zip(("ordinal", "kind", "title", "criterion"), s, strict=True))
                for s in sections
            ],
        }

    def decision_pdf_bytes(decision_id: str) -> bytes:
        with db() as conn:
            row = conn.execute(
                "SELECT content FROM raw_decision WHERE decision_id = %s AND content IS NOT NULL",
                (decision_id,),
            ).fetchone()
        if row is None:
            raise HTTPException(404, f"no stored PDF for {decision_id}")
        content = row[0]
        if not isinstance(content, (bytes, memoryview)):
            raise HTTPException(500, f"stored PDF for {decision_id} is not bytes")
        return bytes(content)

    @app.get("/decisions/{decision_id}/pdf")
    def decision_pdf(decision_id: DecisionId) -> Response:
        return Response(
            decision_pdf_bytes(decision_id),
            media_type="application/pdf",
            headers={"content-disposition": f'inline; filename="{decision_id}.pdf"'},
        )

    @app.get("/decisions/{decision_id}/locate")
    def decision_locate(
        decision_id: DecisionId, q: Annotated[str, Query(min_length=1, max_length=2000)]
    ) -> dict[str, object]:
        pages = page_texts(decision_pdf_bytes(decision_id))
        return {
            "decision_id": decision_id,
            "page": quote_page(b"", q, pages),
            "pages": len(pages),
        }

    @app.get("/cases/{case_id}/events")
    def case_events(case_id: CaseId) -> dict[str, object]:
        with db() as conn:
            rows = conn.execute(
                "SELECT id, case_id, item_id, action, note, actor, created_at FROM review_event"
                " WHERE case_id = %s ORDER BY id",
                (case_id,),
            ).fetchall()
        return {"case_id": case_id, "events": [_event(r) for r in rows]}

    @app.post("/cases/{case_id}/events", status_code=201)
    def append_event(case_id: CaseId, event: ReviewEventIn) -> dict[str, object]:
        # One writer per case at a time (advisory lock), so ids follow commit order, and a
        # writer that read an older log (another tab, a retried request) is refused, not appended.
        with db() as conn, conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (case_id,))
            last = conn.execute(
                "SELECT coalesce(max(id), 0) FROM review_event WHERE case_id = %s", (case_id,)
            ).fetchone()
            last_id = int(str(last[0])) if last else 0
            if event.expected_last_id is not None and event.expected_last_id != last_id:
                raise HTTPException(
                    409, f"the review log changed (last event {last_id}); reload the case"
                )
            row = conn.execute(
                "INSERT INTO review_event (case_id, item_id, action, note, actor)"
                " VALUES (%s, %s, %s, %s, %s)"
                " RETURNING id, case_id, item_id, action, note, actor, created_at",
                (case_id, event.item_id, event.action, event.note, event.actor),
            ).fetchone()
        if row is None:  # INSERT ... RETURNING always yields the row
            raise HTTPException(500, "event was not recorded")
        return _event(row)

    return app


DecisionId = Annotated[str, Path(pattern=r"^[A-Z]{3}[0-9]{6}_[0-9]{2}[A-Z][0-9]{4}$")]
CaseId = Annotated[str, Path(pattern=r"^P[0-9]{2,4}$")]  # ASCII: \d would admit any digit


class ReviewAction(StrEnum):
    RESOLVE = "resolve"
    DISMISS = "dismiss"
    REOPEN = "reopen"
    SIGNOFF = "signoff"
    EXPORT = "export"


ITEM_ACTIONS = {ReviewAction.RESOLVE, ReviewAction.DISMISS, ReviewAction.REOPEN}


class ReviewEventIn(BaseModel):
    """One entry in the attorney's review log; mirrors the review_event CHECKs."""

    item_id: str | None = Field(default=None, pattern=r"^[a-z]+:[a-z0-9_/:-]{1,80}$")
    action: ReviewAction
    note: str = Field(max_length=2000)
    actor: str = Field(max_length=80)
    expected_last_id: int | None = Field(default=None, ge=0)  # optimistic concurrency

    @model_validator(mode="after")
    def _scoped_and_accountable(self) -> ReviewEventIn:
        if "\x00" in self.note or "\x00" in self.actor:
            raise ValueError("NUL characters are not allowed")
        if len(self.note.strip()) < 3:
            raise ValueError("an attorney note is required")
        if not self.actor.strip():
            raise ValueError("actor is required")
        if (self.action in ITEM_ACTIONS) != (self.item_id is not None):
            raise ValueError("resolve/dismiss/reopen name an item; signoff/export do not")
        return self


def _event(row: tuple[object, ...]) -> dict[str, object]:
    keys = ("id", "case_id", "item_id", "action", "note", "actor", "created_at")
    return dict(zip(keys, row, strict=True))


def production_app() -> FastAPI:  # pragma: no cover — wired for `uvicorn --factory`
    from adjudicate.db import database_url
    from adjudicate.retrieve.embed import FastEmbedder

    return create_app(lambda: psycopg.connect(database_url(), autocommit=True), FastEmbedder())
