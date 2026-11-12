"""usage: python -m adjudicate.eval [--limit N] [--workers W] [--set-baseline]

Needs `make up`, `make api` (retrieval on :8000) and the web app serving /api/examine
(ADJUDICATE_WEB, default http://127.0.0.1:3000). Facts extraction spends from
ADJUDICATE_LLM_BUDGET_USD; the examiner is capped by ADJUDICATE_MAX_CALLS on the web side.
Writes eval/results/phase7_real.json; exits 1 on a regression against phase7_baseline.json.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import replace
from datetime import date
from pathlib import Path

import httpx
import psycopg

from adjudicate.db import database_url
from adjudicate.eval.facts import extract_facts
from adjudicate.eval.harness import examine, run
from adjudicate.eval.realset import load_split
from adjudicate.eval.score import regression_failures
from adjudicate.llm.client import LlmClient

ROOT = Path(__file__).resolve().parents[3]
RESULT = ROOT / "eval" / "results" / "phase7_real.json"
BASELINE = ROOT / "eval" / "results" / "phase7_baseline.json"
TOLERANCE = 0.05
CALIBRATION_END = date(2026, 7, 1)  # June 2026 decisions fit the threshold; Jul-Sep score it


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--set-baseline", action="store_true")
    args = ap.parse_args()

    with psycopg.connect(database_url()) as conn:
        split = load_split(conn)
        if args.limit:
            split = replace(split, test=split.test[: args.limit])
        client = LlmClient.from_env(cache_dir=ROOT / ".cache" / "facts")
        web = os.environ.get("ADJUDICATE_WEB", "http://127.0.0.1:3000")
        with httpx.Client(base_url=web, timeout=900.0) as http:

            def chunk_decisions(ids: list[int]) -> dict[int, str]:
                rows = conn.execute(
                    "SELECT c.id, r.decision_id FROM chunk c"
                    " JOIN decision d ON d.id = c.decision_id"
                    " JOIN raw_decision r ON r.id = d.raw_decision_id WHERE c.id = ANY(%s)",
                    (ids,),
                ).fetchall()
                return {int(str(a)): str(b) for a, b in rows}

            report = run(
                split,
                facts=lambda d, i: extract_facts(client, d, index=i),
                examine=lambda p, before: examine(http, p, before),
                chunk_decisions=chunk_decisions,
                workers=args.workers,
                calibration_end=CALIBRATION_END,
            )
    report["facts_llm"] = {"spent_usd": round(client.spent_usd, 4), "note": "this run only"}
    RESULT.write_text(json.dumps(report, indent=2) + "\n")
    s = report["score"]
    print(json.dumps({k: s[k] for k in ("counts", "examiner", "baselines", "outcome")}, indent=1))  # type: ignore[index]
    print(f"facts: {report['facts']} | facts spend ${client.spent_usd:.4f} | llm {report['llm']}")
    if args.set_baseline:
        keep = {"examiner": s["examiner"], "calibrated": s["calibrated"]}  # type: ignore[index]
        undefined = regression_failures(keep, keep, tolerance=TOLERANCE)
        if undefined:  # a baseline with a missing metric would wave every later run through
            print(f"baseline NOT written: {'; '.join(undefined)}", file=sys.stderr)
            return 1
        BASELINE.write_text(json.dumps(keep, indent=2) + "\n")
        print(f"baseline written: {BASELINE.relative_to(ROOT)}")
        return 0
    if BASELINE.is_file():
        failures = regression_failures(report["score"], json.loads(BASELINE.read_text()),  # type: ignore[arg-type]
                                       tolerance=TOLERANCE)  # fmt: skip
        for f in failures:
            print(f"REGRESSION: {f}", file=sys.stderr)
        return 1 if failures else 0
    print(f"no baseline at {BASELINE.relative_to(ROOT)}: nothing compared", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
