"""Retrieval API. A database failure is a 503, never an empty result: for a tool that
argues from precedent, "corpus down" must not look like "no precedent found"."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict
from enum import StrEnum
from typing import Annotated

import psycopg
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse

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
        chunks, embedded = (int(str(row[0])), int(str(row[1]))) if row else (0, 0)
        body = {
            "db": "ok",
            "status": "degraded" if problems else "ok",
            "problems": problems,
            "chunks": chunks,
            "embedded": embedded,
            "embed_model": embedder.name,
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
            )
        filters = {
            "visa": visa.value if visa else None,
            "criterion": criterion.value if criterion else None,
            "section": section.value if section else None,
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

    return app


def production_app() -> FastAPI:  # pragma: no cover — wired for `uvicorn --factory`
    from adjudicate.db import database_url
    from adjudicate.retrieve.embed import FastEmbedder

    return create_app(lambda: psycopg.connect(database_url(), autocommit=True), FastEmbedder())
