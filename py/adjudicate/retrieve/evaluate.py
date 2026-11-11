"""Phase-3 exit gate: recall@k of known-item queries, per retrieval mode.

usage: python -m adjudicate.retrieve.evaluate   (exit 1 if hybrid recall@10 < 0.8)
Writes eval/results/phase3_retrieval.json. Vector-only and lexical-only are reported
beside hybrid so the fusion has to earn its place.
"""

from __future__ import annotations

import json
import random
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import psycopg

from adjudicate.db import database_url
from adjudicate.retrieve.embed import FastEmbedder
from adjudicate.retrieve.rrf import recall_at_k
from adjudicate.retrieve.search import SearchMode, search

REPO = Path(__file__).resolve().parents[3]
QUERIES = REPO / "eval" / "queries" / "phase3_queries.json"
RESULTS = REPO / "eval" / "results" / "phase3_retrieval.json"
GATE = 0.8


@dataclass(frozen=True, slots=True)
class Query:
    id: str
    query: str
    relevant: frozenset[str]


def load_queries(path: Path) -> list[Query]:
    data = json.loads(path.read_text())
    return [Query(q["id"], q["query"], frozenset(q["relevant"])) for q in data["queries"]]


def mrr(results: Mapping[str, Sequence[str]], relevant: Mapping[str, set[str]]) -> float:
    total = 0.0
    for qid, ranked in results.items():
        total += next((1.0 / i for i, d in enumerate(ranked, 1) if d in relevant[qid]), 0.0)
    return total / len(results)


def score_mode(
    results: Mapping[str, Sequence[str]], relevant: Mapping[str, set[str]]
) -> dict[str, float]:
    out = {f"recall@{k}": recall_at_k(results, relevant, k=k) for k in (1, 5, 10)}
    out["mrr"] = mrr(results, relevant)
    return out


def bootstrap_ci(
    values: Sequence[float], *, iterations: int = 5000, seed: int = 20261111, alpha: float = 0.05
) -> tuple[float, float]:
    """Percentile bootstrap CI of the mean over queries (44 queries → wide; say so)."""
    rng = random.Random(seed)  # noqa: S311 — reproducible resampling, not security
    n = len(values)
    means = sorted(sum(rng.choice(values) for _ in range(n)) / n for _ in range(iterations))
    return means[int(alpha / 2 * iterations)], means[int((1 - alpha / 2) * iterations) - 1]


def main() -> int:
    queries = load_queries(QUERIES)
    relevant = {q.id: set(q.relevant) for q in queries}
    embedder = FastEmbedder()
    scores: dict[str, dict[str, float]] = {}
    misses: dict[str, list[str]] = {}
    with psycopg.connect(database_url(), autocommit=True) as conn:
        for mode in SearchMode:
            results = {
                q.id: [h.decision_id for h in search(conn, embedder, q.query, k=10, mode=mode)]
                for q in queries
            }
            scores[mode.value] = score_mode(results, relevant)
            per_query = [float(bool(relevant[q.id] & set(results[q.id][:10]))) for q in queries]
            lo, hi = bootstrap_ci(per_query)
            scores[mode.value]["recall@10_ci95_low"] = lo
            scores[mode.value]["recall@10_ci95_high"] = hi
            misses[mode.value] = [q.id for q in queries if not relevant[q.id] & set(results[q.id])]
            print(mode.value, {k: round(v, 3) for k, v in scores[mode.value].items()})
    report = {
        "queries": len(queries),
        "embed_model": embedder.name,
        "scores": scores,
        "misses_at_10": misses,
    }
    RESULTS.parent.mkdir(parents=True, exist_ok=True)
    RESULTS.write_text(json.dumps(report, indent=2) + "\n")
    ok = scores[SearchMode.HYBRID.value]["recall@10"] >= GATE
    print(f"gate recall@10 >= {GATE}: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
