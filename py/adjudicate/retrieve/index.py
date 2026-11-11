"""Build the chunk index: chunk merits reasoning sections, then embed what's missing/stale."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import psycopg

from adjudicate.db import require_autocommit
from adjudicate.retrieve.chunk import CHUNKABLE_KINDS, chunk_section
from adjudicate.retrieve.embed import Embedder, vector_literal

type Conn = psycopg.Connection[tuple[object, ...]]


@dataclass(slots=True)
class IndexStats:
    chunks: int = 0
    embedded: int = 0


def _chunk_missing(conn: Conn) -> int:
    sections = conn.execute(
        "SELECT s.decision_id, s.ordinal, s.start_char, s.body FROM decision_section s"
        " JOIN decision d ON d.id = s.decision_id"
        " WHERE d.kind = 'merits' AND s.kind = ANY(%s)"
        " AND NOT EXISTS (SELECT 1 FROM chunk c"
        "   WHERE c.decision_id = s.decision_id AND c.section_ordinal = s.ordinal)"
        " ORDER BY s.decision_id, s.ordinal",
        (sorted(CHUNKABLE_KINDS),),
    ).fetchall()
    created = 0
    for decision_id, ordinal, start, body in sections:
        with conn.transaction():
            for i, c in enumerate(chunk_section(str(body), section_start=int(str(start)))):
                conn.execute(
                    "INSERT INTO chunk (decision_id, section_ordinal, ordinal, start_char,"
                    " end_char, body) VALUES (%s, %s, %s, %s, %s, %s)",
                    (decision_id, ordinal, i, c.start_char, c.end_char, c.body),
                )
                created += 1
    return created


def build_index(
    conn: Conn,
    embedder: Embedder,
    *,
    batch: int = 64,
    log: Callable[[str], None] = lambda _m: None,
) -> IndexStats:
    """Idempotent: creates chunks only for unchunked sections; embeds only chunks whose
    embedding is missing or was made by a different model."""
    require_autocommit(conn, "build_index")
    stats = IndexStats(chunks=_chunk_missing(conn))
    log(f"{stats.chunks} new chunk(s)")
    pending = conn.execute(
        "SELECT id, body FROM chunk WHERE embed_model IS DISTINCT FROM %s ORDER BY id",
        (embedder.name,),
    ).fetchall()
    for start in range(0, len(pending), batch):
        rows = pending[start : start + batch]
        vectors = embedder.embed_documents([str(body) for _, body in rows])
        if len(vectors) != len(rows) or any(len(v) != embedder.dim for v in vectors):
            raise ValueError(f"embedder {embedder.name} returned malformed vectors")
        with conn.transaction():
            for (chunk_id, _), vec in zip(rows, vectors, strict=True):
                conn.execute(
                    "UPDATE chunk SET embedding = %s::vector, embed_model = %s WHERE id = %s",
                    (vector_literal(vec), embedder.name, chunk_id),
                )
        stats.embedded += len(rows)
        if (start // batch) % 20 == 0:
            log(f"embedded {stats.embedded}/{len(pending)}")
    return stats
