"""Score the examiner on real held-out decisions, beside two baselines.

Rows are claimed criteria. Positive class = not met (an objection is warranted). The primary
slice is criteria the AAO itself decided; "all labelled" adds those where the Director's finding
stands. Baselines: always predict not met (the base rate, high under survivorship bias) and copy
the Director's finding (an oracle a pre-filing tool never has — the ceiling to compare against).
A petition is predicted to fail when fewer than three claimed criteria are predicted met.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from adjudicate.eval.metrics import Prf, auroc, bootstrap_ci, confusion, prf

NEEDED = 3  # criteria required at step one (8 C.F.R. § 204.5(h)(3))


@dataclass(frozen=True, slots=True)
class Row:
    decision_id: str
    criterion: str
    label: str | None  # met | not_met | None
    source: str | None  # aao | director | None
    director: str
    risk: float | None  # examiner criterion risk; None = no prediction
    outcome: str | None  # the AAO's outcome for the decision
    placeholder: bool  # the decision described no evidence for this criterion


def _pairs(rows: Iterable[Row], threshold: float) -> list[tuple[bool, bool]]:
    return [(r.label == "not_met", (r.risk or 0.0) >= threshold) for r in rows]


def _prf_dict(m: Prf) -> dict[str, object]:
    c = m.confusion
    return {
        "confusion": {"tp": c.tp, "fp": c.fp, "fn": c.fn, "tn": c.tn},
        "precision": m.precision,
        "recall": m.recall,
        "f1": m.f1,
        "accuracy": m.accuracy,
        "support": m.support,
    }


def _block(rows: Sequence[Row], threshold: float, *, seed: int, n_boot: int) -> dict[str, object]:
    out = _prf_dict(prf(confusion(_pairs(rows, threshold))))
    out["n"] = len(rows)
    out["auroc"] = auroc([r.risk or 0.0 for r in rows], [r.label == "not_met" for r in rows])
    by_decision: dict[str, list[Row]] = defaultdict(list)
    for r in rows:
        by_decision[r.decision_id].append(r)
    units = list(by_decision.values())

    def f1(sample: list[list[Row]]) -> float | None:
        return prf(confusion(_pairs([r for u in sample for r in u], threshold))).f1

    try:
        out["f1_ci95"] = list(bootstrap_ci(units, f1, n=n_boot, seed=seed)) if units else None
    except ValueError:
        out["f1_ci95"] = None
    return out


def youden_threshold(rows: Sequence[Row]) -> float:
    """The risk cut-off maximising TPR - FPR (ties: the higher cut-off, fewer flags)."""
    pos = [r.risk or 0.0 for r in rows if r.label == "not_met" and r.risk is not None]
    neg = [r.risk or 0.0 for r in rows if r.label == "met" and r.risk is not None]
    if not pos or not neg:
        raise ValueError("calibration needs both classes")
    best_t, best_j = 0.0, -2.0
    for t in sorted(set(pos + neg)):
        j = sum(p >= t for p in pos) / len(pos) - sum(n >= t for n in neg) / len(neg)
        if j >= best_j:
            best_t, best_j = t, j
    return best_t


def _calibrated(
    scored: Sequence[Row], calibration_ids: frozenset[str], *, seed: int, n_boot: int
) -> dict[str, object]:
    fit = [r for r in scored if r.decision_id in calibration_ids]
    test = [r for r in scored if r.decision_id not in calibration_ids and r.source == "aao"]
    t = youden_threshold(fit)
    return {
        "threshold": t,
        "fit_decisions": len({r.decision_id for r in fit}),
        "test_decisions": len({r.decision_id for r in test}),
        "examiner": _block(test, t, seed=seed, n_boot=n_boot),
        "always_not_met": _prf_dict(prf(confusion((r.label == "not_met", True) for r in test))),
        "copy_director": _prf_dict(
            prf(confusion((r.label == "not_met", r.director == "not_met") for r in test))
        ),
    }


def score(
    rows: Sequence[Row],
    *,
    threshold: float,
    calibration_ids: frozenset[str] = frozenset(),
    seed: int = 20261111,
    n_boot: int = 1000,
) -> dict[str, object]:
    """`calibration_ids`: decisions a threshold is fit on (Youden's J); the calibrated block
    then scores only the other decisions' AAO-decided criteria, beside both baselines."""
    labelled = [r for r in rows if r.label is not None]
    scored = [r for r in labelled if r.risk is not None]
    aao = [r for r in scored if r.source == "aao"]

    def baseline(pred: Iterable[tuple[bool, bool]]) -> dict[str, object]:
        return _prf_dict(prf(confusion(pred)))

    per_criterion = {
        c: _prf_dict(prf(confusion(_pairs([r for r in scored if r.criterion == c], threshold))))
        for c in sorted({r.criterion for r in scored})
    }
    fns = [r for r in scored if r.label == "not_met" and (r.risk or 0.0) < threshold]
    fps = [r for r in scored if r.label == "met" and (r.risk or 0.0) >= threshold]

    # outcome: only decisions where every claimed criterion has a prediction
    decisions: dict[str, list[Row]] = defaultdict(list)
    for r in rows:
        decisions[r.decision_id].append(r)
    complete = {d: rs for d, rs in decisions.items() if all(r.risk is not None for r in rs)}
    predicted_fail = {
        d: sum((r.risk or 0.0) < threshold for r in rs) < NEEDED for d, rs in complete.items()
    }
    dismissed = {d: rs[0].outcome == "dismissed" for d, rs in complete.items()}
    n_out = len(complete)
    return {
        "threshold": threshold,
        "counts": {
            "rows": len(rows),
            "labelled": len(labelled),
            "unlabelled": len(rows) - len(labelled),
            "unpredicted": len(labelled) - len(scored),
            "placeholders": sum(r.placeholder for r in rows),
            "decisions": len(decisions),
        },
        "examiner": {
            "aao_decided": _block(aao, threshold, seed=seed, n_boot=n_boot),
            "all_labelled": _block(scored, threshold, seed=seed, n_boot=n_boot),
        },
        "baselines": {
            "always_not_met": baseline((r.label == "not_met", True) for r in aao),
            "copy_director": baseline((r.label == "not_met", r.director == "not_met") for r in aao),
        },
        "calibrated": (
            _calibrated(scored, calibration_ids, seed=seed, n_boot=n_boot)
            if calibration_ids
            else None
        ),
        "per_criterion": per_criterion,
        "outcome": {
            "decisions": n_out,
            "accuracy": (
                sum(predicted_fail[d] == dismissed[d] for d in complete) / n_out if n_out else None
            ),
            "always_dismiss_accuracy": (sum(dismissed.values()) / n_out if n_out else None),
        },
        "failures": {
            "false_negatives": [
                {"decision_id": r.decision_id, "criterion": r.criterion, "risk": r.risk}
                for r in fns
            ],
            "false_positives": [
                {"decision_id": r.decision_id, "criterion": r.criterion, "risk": r.risk}
                for r in fps
            ],
            "fn_by_criterion": dict(Counter(r.criterion for r in fns)),
            "fp_by_criterion": dict(Counter(r.criterion for r in fps)),
            "fn_on_placeholder": sum(r.placeholder for r in fns),
            "fp_on_placeholder": sum(r.placeholder for r in fps),
        },
    }


def regression_failures(
    current: dict[str, object], baseline: dict[str, object], *, tolerance: float
) -> list[str]:
    """AUROC (threshold-free) and calibrated F1 may not fall more than `tolerance` below the
    baseline. F1 at the fixed 0.5 threshold is not watched: on this examiner it equals the
    always-not-met baseline (risks sit above 0.5), so it cannot regress meaningfully."""

    def get(report: dict[str, object], path: tuple[str, ...]) -> float | None:
        node: object = report
        for key in path:
            if not isinstance(node, dict):
                return None
            node = node.get(key)
        return node if isinstance(node, (int, float)) else None

    failures = []
    for name, path in (
        ("aao_decided auroc", ("examiner", "aao_decided", "auroc")),
        ("calibrated f1", ("calibrated", "examiner", "f1")),
    ):
        value, ref = get(current, path), get(baseline, path)
        if value is None:
            failures.append(f"{name} is undefined")
        elif ref is not None and value < ref - tolerance:
            failures.append(f"{name} {value:.3f} < baseline {ref:.3f} - {tolerance}")
    return failures
