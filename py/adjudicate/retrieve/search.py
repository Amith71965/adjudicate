"""Hybrid search: pgvector cosine + Postgres FTS (ts_rank_cd), fused by RRF, one hit per decision.

The lexical half ORs the query's terms (websearch_to_tsquery would AND them, so a natural-
language query would match almost nothing) and lets ts_rank_cd reward fuller matches. It is
lexical ranking, not BM25.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

import psycopg

from adjudicate.retrieve.embed import Embedder, vector_literal
from adjudicate.retrieve.rrf import rrf

type Conn = psycopg.Connection[tuple[object, ...]]
_TERM = re.compile(r"[A-Za-z0-9]{2,}")
# Present in nearly every chunk (e.g. "petitioner"/"beneficiary" in 97%): they add only noise
# to ts_rank_cd, which has no IDF weighting.
DOMAIN_STOPWORDS = frozenset(
    {
        "petitioner",
        "petitioners",
        "beneficiary",
        "beneficiarys",
        "criterion",
        "criteria",
        "evidence",
        "record",
        "uscis",
        "scops",
        "director",
        "aao",
        "appeal",
        "regulation",
        # plain English stopwords (Postgres drops these too; keep the term list honest)
        *[
            "the",
            "of",
            "and",
            "an",
            "to",
            "in",
            "for",
            "on",
            "with",
            "under",
            "by",
            "is",
            "was",
            "that",
            "this",
            "as",
            "at",
            "or",
            "be",
            "not",
        ],
        *["his", "her", "their", "its"],
    }
)


def lexical_terms(query: str) -> list[str]:
    return sorted({t.lower() for t in _TERM.findall(query)} - DOMAIN_STOPWORDS)


class SearchMode(StrEnum):
    HYBRID = "hybrid"
    VECTOR = "vector"
    LEXICAL = "lexical"


@dataclass(frozen=True, slots=True)
class SearchHit:
    rank: int
    decision_id: str  # stable public id, e.g. SEP152026_01B2203
    chunk_id: int
    url: str
    visa_type: str
    outcome: str | None
    section_kind: str
    criterion: str | None
    snippet: str


def _vector_ids(conn: Conn, qv: str, params: dict[str, object], n: int) -> list[int]:
    rows = conn.execute(
        "SELECT c.id FROM chunk c JOIN decision d ON d.id = c.decision_id"
        " JOIN raw_decision r ON r.id = d.raw_decision_id"
        " JOIN decision_section s"
        " ON s.decision_id = c.decision_id AND s.ordinal = c.section_ordinal"
        " WHERE (%(visa)s::text IS NULL OR r.visa_type = %(visa)s)"
        " AND (%(criterion)s::text IS NULL OR s.criterion = %(criterion)s)"
        " AND c.embedding IS NOT NULL AND c.embed_model = %(model)s"
        " ORDER BY c.embedding <=> %(qv)s::vector LIMIT %(n)s",
        {**params, "qv": qv, "n": n},
    ).fetchall()
    return [int(str(r[0])) for r in rows]


def _lexical_ids(conn: Conn, query: str, params: dict[str, object], n: int) -> list[int]:
    terms = lexical_terms(query)
    if not terms:
        return []
    rows = conn.execute(
        "WITH q AS (SELECT to_tsquery('english', %(tq)s) AS tq)"
        " SELECT c.id FROM q, chunk c JOIN decision d ON d.id = c.decision_id"
        " JOIN raw_decision r ON r.id = d.raw_decision_id"
        " JOIN decision_section s"
        " ON s.decision_id = c.decision_id AND s.ordinal = c.section_ordinal"
        " WHERE (%(visa)s::text IS NULL OR r.visa_type = %(visa)s)"
        " AND (%(criterion)s::text IS NULL OR s.criterion = %(criterion)s)"
        " AND c.fts @@ q.tq"
        " ORDER BY ts_rank_cd(c.fts, q.tq) DESC, c.id LIMIT %(n)s",
        {**params, "tq": " | ".join(terms), "n": n},
    ).fetchall()
    return [int(str(r[0])) for r in rows]


def search(
    conn: Conn,
    embedder: Embedder,
    query: str,
    *,
    k: int = 10,
    mode: SearchMode = SearchMode.HYBRID,
    visa: str | None = None,
    criterion: str | None = None,
    candidates: int = 100,
) -> list[SearchHit]:
    if not query.strip():
        raise ValueError("query must not be empty")
    if k <= 0:
        raise ValueError(f"k must be positive, got {k}")
    # Only vectors made by this embedder: same-dim models must never mix vector spaces.
    params: dict[str, object] = {"visa": visa, "criterion": criterion, "model": embedder.name}
    rankings: list[list[int]] = []
    if mode in (SearchMode.HYBRID, SearchMode.VECTOR):
        # Filtered HNSW post-filters; iterative scan keeps rare filters from under-filling.
        conn.execute("SET hnsw.iterative_scan = 'relaxed_order'")
        conn.execute(f"SET hnsw.ef_search = {max(40, int(candidates))}")  # default 40 caps hits
        qv = vector_literal(embedder.embed_query(query))
        rankings.append(_vector_ids(conn, qv, params, candidates))
    if mode in (SearchMode.HYBRID, SearchMode.LEXICAL):
        rankings.append(_lexical_ids(conn, query, params, candidates))
    fused = rrf(rankings)
    if not fused:
        return []
    meta = {
        int(str(row[0])): row
        for row in conn.execute(
            "SELECT c.id, r.decision_id, r.url, r.visa_type, d.outcome, s.kind, s.criterion,"
            " c.body FROM chunk c JOIN decision d ON d.id = c.decision_id"
            " JOIN raw_decision r ON r.id = d.raw_decision_id"
            " JOIN decision_section s ON s.decision_id = c.decision_id"
            "  AND s.ordinal = c.section_ordinal WHERE c.id = ANY(%s)",
            (fused,),
        )
    }
    hits: list[SearchHit] = []
    seen: set[str] = set()
    for chunk_id in fused:
        row = meta.get(chunk_id)
        if row is None:  # deleted by a concurrent re-parse between the two queries
            continue
        _, did, url, visa_type, outcome, kind, crit, body = row
        if str(did) in seen:
            continue
        seen.add(str(did))
        hits.append(
            SearchHit(
                rank=len(hits) + 1,
                decision_id=str(did),
                chunk_id=chunk_id,
                url=str(url),
                visa_type=str(visa_type),
                outcome=str(outcome) if outcome is not None else None,
                section_kind=str(kind),
                criterion=str(crit) if crit is not None else None,
                snippet=str(body)[:600],
            )
        )
        if len(hits) == k:
            break
    return hits
