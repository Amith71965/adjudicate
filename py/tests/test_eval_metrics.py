"""Phase-7 metric maths, checked against hand-built confusion matrices. Undefined ratios
(0/0) are None, never a silent 0 or 1: an empty class must not look like a perfect score."""

from __future__ import annotations

import math

import pytest

from adjudicate.eval.metrics import (
    Confusion,
    auroc,
    bootstrap_ci,
    confusion,
    macro_f1,
    prf,
)


def test_confusion_counts_truth_and_prediction_pairs() -> None:
    # (truth positive?, predicted positive?) — positive = criterion not met (objection warranted)
    pairs = [(True, True)] * 6 + [(False, True)] * 2 + [(True, False)] * 3 + [(False, False)] * 4
    assert confusion(pairs) == Confusion(tp=6, fp=2, fn=3, tn=4)


def test_precision_recall_f1_by_hand() -> None:
    m = prf(Confusion(tp=6, fp=2, fn=3, tn=4))
    assert m.precision == pytest.approx(6 / 8)
    assert m.recall == pytest.approx(6 / 9)
    assert m.f1 == pytest.approx(2 * (6 / 8) * (6 / 9) / (6 / 8 + 6 / 9))
    assert m.accuracy == pytest.approx(10 / 15)
    assert m.support == 9


def test_zero_division_is_undefined_not_zero() -> None:
    nothing_predicted = prf(Confusion(tp=0, fp=0, fn=4, tn=1))
    assert nothing_predicted.precision is None and nothing_predicted.recall == 0
    assert nothing_predicted.f1 is None
    no_positives = prf(Confusion(tp=0, fp=3, fn=0, tn=2))
    assert no_positives.recall is None and no_positives.precision == 0
    empty = prf(Confusion(0, 0, 0, 0))
    assert empty.accuracy is None and empty.f1 is None


def test_macro_f1_averages_defined_classes_and_says_how_many() -> None:
    a = prf(Confusion(tp=1, fp=0, fn=0, tn=0))  # f1 1.0
    b = prf(Confusion(tp=1, fp=1, fn=1, tn=0))  # f1 0.5
    c = prf(Confusion(tp=0, fp=0, fn=0, tn=5))  # undefined
    value, defined = macro_f1([a, b, c])
    assert value == pytest.approx(0.75) and defined == 2
    assert macro_f1([c]) == (None, 0)


def test_auroc_handles_ties_and_one_class() -> None:
    assert auroc([0.9, 0.8, 0.1, 0.2], [True, True, False, False]) == 1.0
    assert auroc([0.1, 0.2, 0.9, 0.8], [True, True, False, False]) == 0.0
    assert auroc([0.5, 0.5], [True, False]) == 0.5  # a tie is half a win
    assert auroc([0.3, 0.4], [True, True]) is None
    with pytest.raises(ValueError):
        auroc([0.1], [True, False])


def test_bootstrap_ci_resamples_units_and_is_reproducible() -> None:
    units = [[1.0], [0.0], [1.0], [1.0]]  # e.g. one list of per-criterion hits per decision

    def mean(sample: list[list[float]]) -> float | None:
        flat = [x for u in sample for x in u]
        return sum(flat) / len(flat) if flat else None

    lo, hi = bootstrap_ci(units, mean, n=500, seed=7)
    assert 0.0 <= lo <= 0.75 <= hi <= 1.0
    assert (lo, hi) == bootstrap_ci(units, mean, n=500, seed=7)
    same = bootstrap_ci([[1.0]] * 5, mean, n=50, seed=1)
    assert same == (1.0, 1.0)
    assert all(math.isfinite(x) for x in (lo, hi))
