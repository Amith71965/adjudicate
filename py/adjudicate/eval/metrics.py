"""Classification metrics for the real-decision eval. Positive class: the criterion is NOT met
(an objection is warranted). Undefined ratios are None, never 0 or 1: an empty class must not
read as a perfect (or a failed) score."""

from __future__ import annotations

import random
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Confusion:
    tp: int
    fp: int
    fn: int
    tn: int


@dataclass(frozen=True, slots=True)
class Prf:
    precision: float | None
    recall: float | None
    f1: float | None
    accuracy: float | None
    support: int  # positives in the truth
    confusion: Confusion


def confusion(pairs: Iterable[tuple[bool, bool]]) -> Confusion:
    """Count (truth positive, predicted positive) pairs."""
    tp = fp = fn = tn = 0
    for truth, pred in pairs:
        if truth and pred:
            tp += 1
        elif pred:
            fp += 1
        elif truth:
            fn += 1
        else:
            tn += 1
    return Confusion(tp, fp, fn, tn)


def _ratio(num: int, den: int) -> float | None:
    return None if den == 0 else num / den


def prf(c: Confusion) -> Prf:
    precision = _ratio(c.tp, c.tp + c.fp)
    recall = _ratio(c.tp, c.tp + c.fn)
    f1 = (
        None
        if precision is None or recall is None
        else (0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall))
    )
    total = c.tp + c.fp + c.fn + c.tn
    return Prf(precision, recall, f1, _ratio(c.tp + c.tn, total), c.tp + c.fn, c)


def macro_f1(classes: Sequence[Prf]) -> tuple[float | None, int]:
    """Mean F1 over classes where F1 is defined, and how many that was."""
    defined = [m.f1 for m in classes if m.f1 is not None]
    return (sum(defined) / len(defined) if defined else None), len(defined)


def auroc(scores: Sequence[float], labels: Sequence[bool]) -> float | None:
    """Probability a random positive outscores a random negative (ties count half)."""
    if len(scores) != len(labels):
        raise ValueError(f"{len(scores)} scores for {len(labels)} labels")
    pos = [s for s, y in zip(scores, labels, strict=True) if y]
    neg = [s for s, y in zip(scores, labels, strict=True) if not y]
    if not pos or not neg:
        return None
    wins = sum(1.0 if p > n else 0.5 if p == n else 0.0 for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def bootstrap_ci[U](
    units: Sequence[U],
    stat: Callable[[list[U]], float | None],
    *,
    n: int = 1000,
    seed: int = 20261111,
    alpha: float = 0.05,
) -> tuple[float, float]:
    """Percentile CI from resampling whole units (decisions), since criteria within one
    decision are not independent. Resamples where the statistic is undefined are skipped."""
    rng = random.Random(seed)  # noqa: S311 — reproducible resampling, not security
    values = sorted(
        v for v in (stat([rng.choice(units) for _ in units]) for _ in range(n)) if v is not None
    )
    if not values:
        raise ValueError("statistic undefined on every resample")
    lo = values[int((alpha / 2) * (len(values) - 1))]
    hi = values[int((1 - alpha / 2) * (len(values) - 1))]
    return lo, hi
