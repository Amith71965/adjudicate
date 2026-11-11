"""Phase-7 scoring: per-criterion rows → examiner metrics, both baselines, outcome accuracy,
failure taxonomy and the regression gate. Positive class: criterion not met."""

from __future__ import annotations

import pytest

from adjudicate.eval.score import Row, regression_failures, score

THRESHOLD = 0.5


def row(
    did: str,
    crit: str,
    label: str | None,
    risk: float | None,
    *,
    source: str = "aao",
    director: str = "not_met",
    outcome: str = "dismissed",
    placeholder: bool = False,
) -> Row:
    return Row(did, crit, label, source if label else None, director, risk, outcome, placeholder)


ROWS = [
    row("D1", "judging", "met", 0.2, director="met"),  # TN, director right
    row("D1", "awards", "not_met", 0.9),  # TP
    row("D1", "membership", "not_met", 0.3),  # FN
    row("D2", "judging", "met", 0.7, director="not_met"),  # FP, director wrong
    row("D2", "awards", "not_met", 0.8, source="director"),  # TP, director-sourced label
    row("D2", "display", None, 0.9),  # unlabelled: excluded
    row("D3", "awards", "not_met", None, outcome="remanded"),  # unpredicted: counted, excluded
]


def test_examiner_metrics_on_aao_decided_and_all_labelled() -> None:
    s = score(ROWS, threshold=THRESHOLD)
    aao = s["examiner"]["aao_decided"]
    assert aao["confusion"] == {"tp": 1, "fp": 1, "fn": 1, "tn": 1}
    assert aao["precision"] == pytest.approx(0.5) and aao["recall"] == pytest.approx(0.5)
    allc = s["examiner"]["all_labelled"]
    assert allc["confusion"] == {"tp": 2, "fp": 1, "fn": 1, "tn": 1}
    assert s["counts"] == {"rows": 7, "labelled": 6, "unlabelled": 1, "unpredicted": 1,
                           "placeholders": 0, "decisions": 3}  # fmt: skip


def test_auroc_uses_the_risk_score_without_a_threshold() -> None:
    s = score(ROWS, threshold=THRESHOLD)
    # positives 0.9, 0.3 vs negatives 0.2, 0.7 on AAO-decided: 0.3 loses to 0.7 only, 3 of 4
    assert s["examiner"]["aao_decided"]["auroc"] == pytest.approx(0.75)


def test_baselines_always_fail_and_copy_the_director_on_aao_decided() -> None:
    s = score(ROWS, threshold=THRESHOLD)
    always = s["baselines"]["always_not_met"]
    assert always["recall"] == 1.0 and always["precision"] == pytest.approx(2 / 4)
    director = s["baselines"]["copy_director"]
    assert director["confusion"] == {"tp": 2, "fp": 1, "fn": 0, "tn": 1}


def test_per_criterion_breakdown_and_failure_taxonomy() -> None:
    s = score(ROWS, threshold=THRESHOLD)
    assert s["per_criterion"]["awards"]["confusion"]["tp"] == 2
    assert s["per_criterion"]["judging"]["confusion"] == {"tp": 0, "fp": 1, "fn": 0, "tn": 1}
    tax = s["failures"]
    assert tax["false_negatives"] == [{"decision_id": "D1", "criterion": "membership", "risk": 0.3}]
    assert tax["false_positives"] == [{"decision_id": "D2", "criterion": "judging", "risk": 0.7}]
    assert tax["fn_by_criterion"] == {"membership": 1} and tax["fp_by_criterion"] == {"judging": 1}


def test_outcome_prediction_counts_criteria_predicted_met() -> None:
    # a petition is predicted to fail when fewer than 3 claimed criteria are predicted met
    s = score(ROWS, threshold=THRESHOLD)
    out = s["outcome"]
    assert out["decisions"] == 2  # D3 has an unpredicted criterion: excluded and counted
    assert out["accuracy"] == pytest.approx(1.0)  # D1, D2 predicted to fail; both dismissed
    assert out["always_dismiss_accuracy"] == pytest.approx(1.0)


def test_bootstrap_ci_brackets_the_point_estimate() -> None:
    s = score(ROWS * 5, threshold=THRESHOLD)
    f1 = s["examiner"]["all_labelled"]
    lo, hi = f1["f1_ci95"]
    assert lo <= f1["f1"] <= hi


def test_regression_gate_watches_auroc_and_calibrated_f1() -> None:
    def rep(auroc: float | None, f1: float | None) -> dict[str, object]:
        return {
            "examiner": {"aao_decided": {"auroc": auroc}},
            "calibrated": {"examiner": {"f1": f1}},
        }

    base = rep(0.75, 0.70)
    assert regression_failures(rep(0.72, 0.66), base, tolerance=0.05) == []
    assert regression_failures(rep(0.74, 0.60), base, tolerance=0.05) == [
        "calibrated f1 0.600 < baseline 0.700 - 0.05"
    ]
    assert regression_failures(rep(None, 0.7), base, tolerance=0.05) == [
        "aao_decided auroc is undefined"
    ]
    no_cal = {"examiner": {"aao_decided": {"auroc": 0.75}}, "calibrated": None}
    assert regression_failures(no_cal, base, tolerance=0.05) == ["calibrated f1 is undefined"]


def test_youden_threshold_maximises_tpr_minus_fpr() -> None:
    from adjudicate.eval.score import youden_threshold

    rows = [row("C1", "a", "not_met", 0.95), row("C1", "b", "not_met", 0.9),
            row("C2", "a", "met", 0.85), row("C2", "b", "met", 0.6)]  # fmt: skip
    assert youden_threshold(rows) == 0.9  # flags the two positives, neither negative
    with pytest.raises(ValueError, match="both classes"):
        youden_threshold([row("C1", "a", "met", 0.5)])


def test_calibrated_threshold_is_fit_on_calibration_decisions_and_scored_on_the_rest() -> None:
    calib = [row("C1", "a", "not_met", 0.95), row("C1", "b", "met", 0.85)]
    test = [row("T1", "a", "not_met", 0.97), row("T1", "b", "met", 0.9),
            row("T2", "a", "met", 0.8, director="met")]  # fmt: skip
    s = score(calib + test, threshold=THRESHOLD, calibration_ids=frozenset({"C1"}))
    cal = s["calibrated"]
    assert cal["threshold"] == 0.95 and cal["fit_decisions"] == 1 and cal["test_decisions"] == 2
    assert cal["examiner"]["confusion"] == {"tp": 1, "fp": 0, "fn": 0, "tn": 2}
    assert cal["always_not_met"]["confusion"] == {"tp": 1, "fp": 2, "fn": 0, "tn": 0}
    assert cal["copy_director"]["confusion"] == {"tp": 1, "fp": 1, "fn": 0, "tn": 1}
    assert score(test, threshold=THRESHOLD)["calibrated"] is None  # no calibration set given
