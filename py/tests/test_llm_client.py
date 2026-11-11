"""LLM client: budget cap before sending, cache, model allowlist, validated JSON.

All HTTP is faked with httpx.MockTransport — tests never spend money.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from pydantic import BaseModel

from adjudicate.llm.client import (
    PRICES,
    BudgetExceededError,
    LlmClient,
    LlmError,
    UnknownModelError,
)

HAIKU = "anthropic/claude-haiku-5.5"


class Answer(BaseModel):
    verdict: str
    score: int


def _reply(content: str, cost: float = 0.001, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status,
        json={
            "model": HAIKU,
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "cost": cost},
        },
    )


class Recorder:
    def __init__(self, *responses: httpx.Response) -> None:
        self.responses = list(responses)
        self.requests: list[dict[str, object]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content))
        return self.responses.pop(0)


def _client(rec: Recorder, tmp_path: Path, budget: float = 1.0) -> LlmClient:
    return LlmClient(
        api_key="sk-test", budget_usd=budget, cache_dir=tmp_path, transport=httpx.MockTransport(rec)
    )


def test_returns_validated_model_and_tracks_actual_cost(tmp_path: Path) -> None:
    rec = Recorder(_reply('{"verdict": "not_met", "score": 3}', cost=0.0021))
    client = _client(rec, tmp_path)
    out = client.complete_json(HAIKU, system="s", user="u", schema=Answer, max_tokens=50)
    assert out == Answer(verdict="not_met", score=3)
    assert client.spent_usd == pytest.approx(0.0021)


def test_json_inside_a_code_fence_is_accepted(tmp_path: Path) -> None:
    rec = Recorder(_reply('```json\n{"verdict": "met", "score": 1}\n```'))
    out = _client(rec, tmp_path).complete_json(
        HAIKU, system="s", user="u", schema=Answer, max_tokens=50
    )
    assert out.verdict == "met"


def test_second_identical_call_is_served_from_cache_for_free(tmp_path: Path) -> None:
    rec = Recorder(_reply('{"verdict": "met", "score": 1}'))
    first = _client(rec, tmp_path)
    first.complete_json(HAIKU, system="s", user="u", schema=Answer, max_tokens=50)
    second = _client(rec, tmp_path)  # new process, same cache dir
    out = second.complete_json(HAIKU, system="s", user="u", schema=Answer, max_tokens=50)
    assert out.verdict == "met"
    assert len(rec.requests) == 1
    assert second.spent_usd == 0.0


def test_budget_is_checked_before_sending(tmp_path: Path) -> None:
    rec = Recorder(_reply('{"verdict": "met", "score": 1}'))
    client = _client(rec, tmp_path, budget=0.000001)
    with pytest.raises(BudgetExceededError, match="budget"):
        client.complete_json(HAIKU, system="s", user="x" * 40_000, schema=Answer, max_tokens=4000)
    assert rec.requests == []  # nothing was sent


def test_budget_accumulates_across_calls(tmp_path: Path) -> None:
    rec = Recorder(*[_reply(f'{{"verdict": "met", "score": {i}}}', cost=0.4) for i in range(3)])
    client = _client(rec, tmp_path, budget=1.0)
    client.complete_json(HAIKU, system="s", user="a", schema=Answer, max_tokens=10)
    client.complete_json(HAIKU, system="s", user="b", schema=Answer, max_tokens=10)
    with pytest.raises(BudgetExceededError):
        client.complete_json(HAIKU, system="s", user="c", schema=Answer, max_tokens=10)
    assert len(rec.requests) == 2


def test_unknown_model_is_refused_before_any_request(tmp_path: Path) -> None:
    rec = Recorder()
    with pytest.raises(UnknownModelError):
        _client(rec, tmp_path).complete_json(
            "anthropic/claude-opus-4.1", system="s", user="u", schema=Answer, max_tokens=10
        )
    assert rec.requests == []


def test_invalid_json_is_retried_once_with_the_error_then_raises(tmp_path: Path) -> None:
    rec = Recorder(_reply("not json"), _reply('{"verdict": "met"}'))
    with pytest.raises(LlmError, match="score"):
        _client(rec, tmp_path).complete_json(
            HAIKU, system="s", user="u", schema=Answer, max_tokens=10
        )
    assert len(rec.requests) == 2
    assert "not valid" in str(rec.requests[1]["messages"]).lower()


def test_invalid_responses_are_never_cached(tmp_path: Path) -> None:
    rec = Recorder(
        _reply("not json"), _reply("still not"), _reply('{"verdict": "met", "score": 2}')
    )
    with pytest.raises(LlmError):
        _client(rec, tmp_path).complete_json(
            HAIKU, system="s", user="u", schema=Answer, max_tokens=10
        )
    out = _client(rec, tmp_path).complete_json(
        HAIKU, system="s", user="u", schema=Answer, max_tokens=10
    )
    assert out.score == 2


def test_http_errors_raise_with_status(tmp_path: Path) -> None:
    rec = Recorder(httpx.Response(402, json={"error": {"message": "Insufficient credits"}}))
    with pytest.raises(LlmError, match="402"):
        _client(rec, tmp_path).complete_json(
            HAIKU, system="s", user="u", schema=Answer, max_tokens=10
        )


def test_requests_are_deterministic(tmp_path: Path) -> None:
    rec = Recorder(_reply('{"verdict": "met", "score": 1}'))
    _client(rec, tmp_path).complete_json(HAIKU, system="s", user="u", schema=Answer, max_tokens=10)
    assert rec.requests[0]["temperature"] == 0


def test_price_table_covers_the_models_we_use() -> None:
    assert {"anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"} <= set(PRICES)


def test_missing_key_is_a_clear_error(tmp_path: Path) -> None:
    with pytest.raises(LlmError, match="OPENROUTER_API_KEY"):
        LlmClient(api_key="", budget_usd=1.0, cache_dir=tmp_path)


# --- silent-failure review (phase 2) -------------------------------------------------------


def test_missing_cost_and_tokens_charges_the_worst_case_estimate(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"choices": [{"message": {"content": '{"verdict": "met", "score": 1}'}}]}
        )

    client = LlmClient(
        api_key="k", budget_usd=1.0, cache_dir=tmp_path, transport=httpx.MockTransport(handler)
    )
    client.complete_json(HAIKU, system="s", user="u" * 3000, schema=Answer, max_tokens=500)
    assert client.spent_usd > 0  # a silent $0 would disable the budget cap


@pytest.mark.parametrize("budget", [float("nan"), float("inf"), 0.0, -1.0])
def test_invalid_budget_is_refused(tmp_path: Path, budget: float) -> None:
    with pytest.raises(LlmError, match="budget"):
        LlmClient(api_key="k", budget_usd=budget, cache_dir=tmp_path)


def test_corrupt_cache_entry_is_discarded_and_refetched(tmp_path: Path) -> None:
    rec = Recorder(
        _reply('{"verdict": "met", "score": 1}'), _reply('{"verdict": "met", "score": 2}')
    )
    _client(rec, tmp_path).complete_json(HAIKU, system="s", user="u", schema=Answer, max_tokens=50)
    for f in tmp_path.rglob("*.json"):
        f.write_text('{"model": "x"')  # truncated write
    out = _client(rec, tmp_path).complete_json(
        HAIKU, system="s", user="u", schema=Answer, max_tokens=50
    )
    assert out.score == 2 and len(rec.requests) == 2


def test_non_json_200_body_is_an_llm_error(tmp_path: Path) -> None:
    rec = Recorder(httpx.Response(200, text="<html>gateway</html>"))
    with pytest.raises(LlmError, match="gateway"):
        _client(rec, tmp_path).complete_json(
            HAIKU, system="s", user="u", schema=Answer, max_tokens=10
        )


def test_transport_errors_become_llm_errors(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    client = LlmClient(
        api_key="k", budget_usd=1.0, cache_dir=tmp_path, transport=httpx.MockTransport(handler)
    )
    with pytest.raises(LlmError, match="slow"):
        client.complete_json(HAIKU, system="s", user="u", schema=Answer, max_tokens=10)
