"""Reciprocal-rank fusion and recall@k."""

from __future__ import annotations

from collections.abc import Hashable, Mapping, Sequence


def rrf[T: Hashable](rankings: Sequence[Sequence[T]], *, k: int = 60) -> list[T]:
    """Fuse ranked lists: score(d) = Σ 1 / (k + rank). Ties keep first-appearance order."""
    if k <= 0:
        raise ValueError(f"k must be positive, got {k}")
    scores: dict[T, float] = {}
    first_seen: dict[T, int] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking, start=1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank)
            first_seen.setdefault(item, len(first_seen))
    return sorted(scores, key=lambda item: (-scores[item], first_seen[item]))


def recall_at_k(
    results: Mapping[str, Sequence[str]], relevant: Mapping[str, set[str]], *, k: int
) -> float:
    """Mean over queries of |relevant ∩ top-k| / |relevant|."""
    if not results:
        raise ValueError("no queries to score")
    total = 0.0
    for query, ranked in results.items():
        gold = relevant.get(query)
        if not gold:
            raise ValueError(f"query {query!r} has no relevance labels")
        total += len(gold & set(ranked[:k])) / len(gold)
    return total / len(results)
