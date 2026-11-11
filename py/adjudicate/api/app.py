"""Retrieval API. A database failure is a 503, never an empty result: for a tool that
argues from precedent, "corpus down" must not look like "no precedent found"."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict
from typing import Annotated

import psycopg
from fastapi import FastAPI, HTTPException, Query

from adjudicate.retrieve.embed import Embedder
from adjudicate.retrieve.search import SearchMode, search

type Conn = psycopg.Connection[tuple[object, ...]]
type ConnFactory = Callable[[], Conn]


def create_app(connect: ConnFactory, embedder: Embedder) -> FastAPI:
    app = FastAPI(title="Adjudicate retrieval API", version="0.3.0")

    @contextmanager
    def db() -> Iterator[Conn]:
        try:
            conn = connect()
        except psycopg.Error as exc:
            raise HTTPException(503, f"corpus database unavailable: {exc}") from exc
        try:
            yield conn
        except psycopg.Error as exc:
            raise HTTPException(503, f"corpus database unavailable: {exc}") from exc
        finally:
            conn.close()

    @app.get("/health")
    def health() -> dict[str, object]:
        with db() as conn:
            row = conn.execute(
                "SELECT count(*), count(*) FILTER (WHERE embedding IS NOT NULL) FROM chunk"
            ).fetchone()
        chunks, embedded = (int(str(row[0])), int(str(row[1]))) if row else (0, 0)
        return {"db": "ok", "chunks": chunks, "embedded": embedded, "embed_model": embedder.name}

    @app.get("/search")
    def search_endpoint(
        q: Annotated[str, Query(min_length=1, max_length=2000, pattern=r"\S")],
        k: Annotated[int, Query(ge=1, le=50)] = 10,
        mode: SearchMode = SearchMode.HYBRID,
        visa: str | None = None,
        criterion: str | None = None,
    ) -> dict[str, object]:
        with db() as conn:
            hits = search(conn, embedder, q, k=k, mode=mode, visa=visa, criterion=criterion)
        return {"query": q, "mode": mode.value, "results": [asdict(h) for h in hits]}

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
