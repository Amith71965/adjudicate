"""A deliberately slow HTTP client for a public government site.

- Requests are spaced by at least the robots.txt ``Crawl-delay`` (10 s for uscis.gov).
- 429/5xx and transport errors back off exponentially, honouring ``Retry-After``.
- Other 4xx are not retried. Exhausted retries raise ``FetchError`` — never a
  silent ``None`` that the caller might mistake for "no document".
"""

from __future__ import annotations

import time
import urllib.robotparser
from collections.abc import Callable

import httpx

USER_AGENT = "adjudicate-research/0.1 (+https://github.com/Amith71965/adjudicate)"
_RETRYABLE = frozenset({429, 500, 502, 503, 504})
_MAX_RETRY_AFTER = 900.0


class FetchError(RuntimeError):
    """A URL could not be fetched after the allowed retries."""


def crawl_delay_from_robots(robots_txt: str, *, default: float = 10.0) -> float:
    parser = urllib.robotparser.RobotFileParser()
    parser.parse(robots_txt.splitlines())
    delay = parser.crawl_delay(USER_AGENT)
    return float(delay) if delay is not None else default


def _retry_after(response: httpx.Response) -> float:
    value = response.headers.get("Retry-After", "")
    try:
        return min(float(value), _MAX_RETRY_AFTER)
    except ValueError:
        return 0.0


class PoliteClient:
    def __init__(
        self,
        *,
        transport: httpx.BaseTransport | None = None,
        min_interval: float = 10.0,
        robots_delay: float | None = None,
        max_retries: int = 4,
        timeout: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if robots_delay is not None and min_interval < robots_delay:
            raise ValueError(
                f"min_interval {min_interval}s is below robots crawl-delay {robots_delay}s"
            )
        self._interval = min_interval
        self._max_retries = max_retries
        self._clock = clock
        self._sleep = sleep
        self._last: float | None = None
        self._http = httpx.Client(
            transport=transport,
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        )

    def close(self) -> None:
        self._http.close()

    def _wait_turn(self) -> None:
        if self._last is None:
            return
        remaining = self._interval - (self._clock() - self._last)
        if remaining > 0:
            self._sleep(remaining)

    def get(self, url: str) -> httpx.Response:
        last_problem = ""
        for attempt in range(self._max_retries + 1):
            self._wait_turn()
            self._last = self._clock()
            try:
                response = self._http.get(url)
            except httpx.TransportError as exc:
                last_problem = f"{type(exc).__name__}: {exc}"
                retry_after = 0.0
            else:
                if response.is_success:
                    return response
                last_problem = f"HTTP {response.status_code}"
                if response.status_code not in _RETRYABLE:
                    break
                retry_after = _retry_after(response)
            if attempt == self._max_retries:
                break
            backoff = self._interval * 2 ** (attempt + 1)
            self._sleep(max(backoff, retry_after))
        raise FetchError(f"{url}: {last_problem}")
