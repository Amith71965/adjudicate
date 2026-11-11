"""``python -m adjudicate.harvest --topic 19 --max-pages 5 --min-year 2017``

Exit codes: 0 success, 1 one or more documents failed, 2 bad configuration.
"""

from __future__ import annotations

import argparse
import sys
import time
from collections.abc import Callable, Sequence

import httpx
import psycopg

from adjudicate.db import database_url as default_database_url
from adjudicate.db import describe_target
from adjudicate.harvest.crawl import harvest
from adjudicate.harvest.http import (
    FetchError,
    PoliteClient,
    RobotsRules,
    crawl_delay_from_robots,
)

ROBOTS_URL = "https://www.uscis.gov/robots.txt"
TOPICS = {19: "EB-1A (I-140 extraordinary ability)", 18: "EB-2/NIW (I-140)", 4: "O (I-129)"}


def _positive_int(text: str) -> int:
    value = int(text)
    if value <= 0:
        raise argparse.ArgumentTypeError(f"must be a positive integer, got {value}")
    return value


def _parse(argv: Sequence[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m adjudicate.harvest", description=__doc__)
    p.add_argument("--topic", type=int, required=True, choices=sorted(TOPICS))
    p.add_argument("--max-pages", type=_positive_int, required=True)
    p.add_argument("--min-year", type=int, default=None)
    p.add_argument("--fetch-limit", type=_positive_int, default=None)
    p.add_argument("--min-interval", type=float, default=None, help="seconds; >= robots delay")
    return p.parse_args(argv)


def say(msg: str) -> None:
    print(msg, flush=True)


def main(
    argv: Sequence[str] | None = None,
    *,
    transport: httpx.BaseTransport | None = None,
    database_url: str | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    args = _parse(sys.argv[1:] if argv is None else argv)

    bootstrap = PoliteClient(transport=transport, min_interval=0.0, sleep=sleep)
    try:
        robots_txt = bootstrap.get(ROBOTS_URL).text
        rules = RobotsRules.parse(robots_txt)
        robots_delay = crawl_delay_from_robots(robots_txt)
    except (FetchError, ValueError) as exc:
        say(f"cannot read robots.txt, refusing to crawl: {exc}")
        return 2
    finally:
        bootstrap.close()

    interval = robots_delay if args.min_interval is None else args.min_interval
    try:
        client = PoliteClient(
            transport=transport, min_interval=interval, robots_delay=robots_delay, sleep=sleep
        )
    except ValueError as exc:
        say(f"configuration error: {exc}")
        return 2

    url = database_url or default_database_url()
    say(
        f"harvesting topic {args.topic} [{TOPICS[args.topic]}] into {describe_target(url)}"
        f" at {interval:.0f}s/request"
    )
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            stats = harvest(
                client,
                conn,
                topic=args.topic,
                max_pages=args.max_pages,
                min_year=args.min_year,
                fetch_limit=args.fetch_limit,
                allowed=rules.allows,
                log=say,
            )
    finally:
        client.close()
    say(
        f"done: pages {stats.pages_walked} (end reached: {stats.reached_end}),"
        f" new {stats.discovered_new}, fetched {stats.fetched}, failed {stats.failed},"
        f" abandoned {stats.abandoned}, warnings {stats.warnings}"
    )
    return 1 if stats.failed else 0


if __name__ == "__main__":
    sys.exit(main())
