"""Polite fetching: robots crawl-delay, rate floor, bounded backoff, loud failure.

Time is injected (FakeClock), so no test sleeps for real.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from adjudicate.harvest.http import FetchError, PoliteClient, crawl_delay_from_robots

ROBOTS = (Path(__file__).parent / "fixtures" / "robots.txt").read_text()
URL = "https://www.uscis.gov/sites/default/files/err/x.pdf"


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def _client(
    handler: httpx.MockTransport, clock: FakeClock, *, delay: float = 10.0, retries: int = 4
) -> PoliteClient:
    return PoliteClient(
        transport=handler,
        min_interval=delay,
        max_retries=retries,
        clock=clock.monotonic,
        sleep=clock.sleep,
    )


def test_crawl_delay_is_read_from_the_real_robots_file() -> None:
    assert crawl_delay_from_robots(ROBOTS) == 10.0


def test_crawl_delay_defaults_when_robots_is_silent() -> None:
    assert crawl_delay_from_robots("User-agent: *\nDisallow: /private\n", default=5.0) == 5.0


def test_successive_requests_are_spaced_by_the_crawl_delay() -> None:
    clock = FakeClock()
    client = _client(httpx.MockTransport(lambda r: httpx.Response(200, content=b"ok")), clock)
    for _ in range(3):
        client.get(URL)
    assert clock.sleeps == [10.0, 10.0]  # first request is immediate


def test_time_already_elapsed_counts_toward_the_delay() -> None:
    clock = FakeClock()
    client = _client(httpx.MockTransport(lambda r: httpx.Response(200)), clock)
    client.get(URL)
    clock.now += 7.0
    client.get(URL)
    assert clock.sleeps == [pytest.approx(3.0)]


def test_backs_off_exponentially_on_5xx_then_succeeds() -> None:
    clock = FakeClock()
    statuses = iter([503, 502, 200])
    client = _client(httpx.MockTransport(lambda r: httpx.Response(next(statuses))), clock)
    assert client.get(URL).status_code == 200
    # Backoff waits replace (are not added on top of) the crawl delay: max(delay, backoff).
    assert clock.sleeps == [20.0, 40.0]


def test_retry_after_header_is_honoured_when_longer_than_backoff() -> None:
    clock = FakeClock()
    responses = iter([httpx.Response(429, headers={"Retry-After": "120"}), httpx.Response(200)])
    client = _client(httpx.MockTransport(lambda r: next(responses)), clock)
    client.get(URL)
    assert clock.sleeps == [120.0]


def test_gives_up_loudly_after_max_retries() -> None:
    clock = FakeClock()
    client = _client(httpx.MockTransport(lambda r: httpx.Response(503)), clock, retries=3)
    with pytest.raises(FetchError, match="503"):
        client.get(URL)
    assert len(clock.sleeps) == 3


def test_client_errors_are_not_retried() -> None:
    clock = FakeClock()
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(404)

    client = _client(httpx.MockTransport(handler), clock)
    with pytest.raises(FetchError, match="404"):
        client.get(URL)
    assert calls == 1


def test_transport_errors_are_retried_then_raised() -> None:
    clock = FakeClock()

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection reset", request=request)

    client = _client(httpx.MockTransport(handler), clock, retries=2)
    with pytest.raises(FetchError, match="connection reset"):
        client.get(URL)


def test_requests_identify_the_project_without_personal_contact() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["user-agent"])
        return httpx.Response(200)

    _client(httpx.MockTransport(handler), FakeClock()).get(URL)
    assert seen[0].startswith("adjudicate-research/")
    assert "@" not in seen[0]


def test_min_interval_below_robots_delay_is_refused() -> None:
    with pytest.raises(ValueError, match="crawl-delay"):
        PoliteClient(min_interval=1.0, robots_delay=10.0)
