"""Run verdict extraction over the gold set and report field-level accuracy.

usage: python -m adjudicate.parse.run_gold [--model anthropic/claude-haiku-5.5]
Writes eval/results/phase2_gold_<model>.json. Spend is capped by
ADJUDICATE_LLM_BUDGET_USD; responses are cached, so re-runs are free.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from adjudicate.llm.client import BudgetExceededError, LlmClient, LlmError
from adjudicate.parse.gold_eval import accuracy_report, load_gold, score
from adjudicate.parse.structure import extract_outcome
from adjudicate.parse.verdicts import DEFAULT_MODEL, GroundingError, extract_verdicts

REPO = Path(__file__).resolve().parents[3]
GOLD = REPO / "py" / "tests" / "golden"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args(argv)

    client = LlmClient.from_env(cache_dir=REPO / ".cache" / "llm")
    labels = load_gold(GOLD / "labels")
    per_decision, failures = [], {}
    for label in labels:
        text = (GOLD / "texts" / f"{label.decision_id}.txt").read_text()
        try:
            verdicts = extract_verdicts(client, text, model=args.model)
        except BudgetExceededError:
            raise  # a partial run must not report accuracy as if it were complete
        except (LlmError, GroundingError, ValueError) as exc:
            failures[label.decision_id] = f"{type(exc).__name__}: {exc}"[:300]
            print(f"FAILED {label.decision_id}: {failures[label.decision_id]}", flush=True)
            continue
        per_decision.append(score(label, extract_outcome(text), verdicts))
        print(f"{label.decision_id}: spent ${client.spent_usd:.4f}", flush=True)

    report = accuracy_report(per_decision)
    print(f"\nfield accuracy {report.correct}/{report.total} = {report.accuracy:.1%}")
    for name, (ok, n) in sorted(report.by_field.items()):
        print(f"  {name:<13} {ok}/{n} = {ok / n:.1%}")
    print(f"extraction failures: {len(failures)}; spent ${client.spent_usd:.4f}")

    out = REPO / "eval" / "results" / f"phase2_gold_{args.model.split('/')[-1]}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "model": args.model,
                "decisions_scored": len(per_decision),
                "extraction_failures": failures,
                "accuracy": report.accuracy,
                "correct": report.correct,
                "total": report.total,
                "by_field": report.by_field,
                "errors": [
                    {
                        "decision_id": e.decision_id,
                        "field": e.field,
                        "criterion": e.criterion.value if e.criterion else None,
                        "gold": e.gold,
                        "predicted": e.predicted,
                    }
                    for e in report.errors
                ],
            },
            indent=2,
        )
        + "\n"
    )
    print(f"wrote {out.relative_to(REPO)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
