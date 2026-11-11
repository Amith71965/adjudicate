"""``python -m adjudicate.parse {parse|extract} [--limit N]`` against DATABASE_URL."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import psycopg

from adjudicate.db import database_url, describe_target
from adjudicate.llm.client import BudgetExceededError, LlmClient
from adjudicate.parse.pipeline import extract_pending, parse_pending
from adjudicate.parse.verdicts import DEFAULT_MODEL

REPO = Path(__file__).resolve().parents[3]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m adjudicate.parse")
    p.add_argument("step", choices=["parse", "extract"])
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--retry-failed", action="store_true", help="re-attempt failed extractions")
    args = p.parse_args(argv)
    print(f"{args.step} @ {describe_target()}", flush=True)
    with psycopg.connect(database_url(), autocommit=True) as conn:
        if args.step == "parse":
            ps = parse_pending(conn, log=lambda m: print(m, flush=True))
            print(f"parsed {ps.parsed}, unreadable {ps.failed}")
            return 0
        client = LlmClient.from_env(cache_dir=REPO / ".cache" / "llm")
        try:
            es = extract_pending(
                conn,
                client,
                model=args.model,
                limit=args.limit,
                retry_failed=args.retry_failed,
                log=lambda m: print(m, flush=True),
            )
        except BudgetExceededError as exc:
            print(f"stopped: {exc} (spent this run ${client.spent_usd:.4f})")
            return 3
        print(f"extracted {es.extracted}, failed {es.failed}, cost ${es.cost_usd:.4f}")
        return 0 if es.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
