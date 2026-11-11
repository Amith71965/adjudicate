"""``python -m adjudicate.retrieve index`` | ``search "<query>" [--mode] [--visa] [--k]``."""

from __future__ import annotations

import argparse
import sys

import psycopg

from adjudicate.db import database_url, describe_target
from adjudicate.retrieve.embed import FastEmbedder
from adjudicate.retrieve.index import build_index
from adjudicate.retrieve.search import SearchMode, search


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m adjudicate.retrieve")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("index")
    s = sub.add_parser("search")
    s.add_argument("query")
    s.add_argument("--k", type=int, default=10)
    s.add_argument("--mode", choices=[m.value for m in SearchMode], default="hybrid")
    s.add_argument("--visa", default=None)
    s.add_argument("--criterion", default=None)
    args = p.parse_args(argv)
    embedder = FastEmbedder()
    with psycopg.connect(database_url(), autocommit=True) as conn:
        if args.cmd == "index":
            print(f"indexing @ {describe_target()}", flush=True)
            stats = build_index(conn, embedder, log=lambda m: print(m, flush=True))
            print(f"chunks +{stats.chunks}, embedded {stats.embedded}")
            return 0
        for hit in search(
            conn,
            embedder,
            args.query,
            k=args.k,
            mode=SearchMode(args.mode),
            visa=args.visa,
            criterion=args.criterion,
        ):
            print(
                f"{hit.rank:>2}. {hit.decision_id} [{hit.section_kind}"
                f"{':' + hit.criterion if hit.criterion else ''}] {hit.snippet[:140]!r}"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
