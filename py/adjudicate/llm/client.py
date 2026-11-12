"""OpenRouter chat client for structured extraction, built to never surprise the bill.

- **Budget cap, checked before sending.** The pre-send estimate is the larger of a
  worst-case token estimate and the most expensive real call seen this run, so a
  run cannot creep past its cap through many small calls.
- **Cache.** Valid responses are cached on disk by request hash; tests and re-runs
  cost nothing. Invalid responses are never cached.
- **Model allowlist.** Only models with a known price may be called.
- **Validated JSON.** Output must parse into the caller's Pydantic schema; one retry
  with the validation error, then a loud ``LlmError``.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
from pathlib import Path
from typing import TypeVar

import httpx
from pydantic import BaseModel, ValidationError

# USD per million tokens (input, output), from OpenRouter /api/v1/models on 2026-11-10.
PRICES: dict[str, tuple[float, float]] = {
    "anthropic/claude-haiku-5.5": (0.10, 0.50),
    "anthropic/claude-sonnet-5.5": (2.00, 10.00),
}
BASE_URL = "https://openrouter.ai/api/v1"
_CHARS_PER_TOKEN = 3.0  # deliberately pessimistic (real English is ~4)
_FENCE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)

T = TypeVar("T", bound=BaseModel)


class LlmError(RuntimeError):
    """The model call failed or produced output that does not fit the schema."""


class BudgetExceededError(LlmError):
    """Sending this request could exceed the run's spend cap; nothing was sent."""


class TruncatedError(LlmError):
    """The model hit max_tokens (often hidden reasoning); the answer is incomplete."""


class UnknownModelError(LlmError):
    """Model is not in the price table; refusing to spend on an unknown rate."""


def _read_dotenv(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    pairs = (line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
    return {k.strip(): v.strip().strip("'\"") for k, v in pairs if not k.lstrip().startswith("#")}


class LlmClient:
    def __init__(
        self,
        *,
        api_key: str,
        budget_usd: float,
        cache_dir: Path,
        transport: httpx.BaseTransport | None = None,
        base_url: str = BASE_URL,
        timeout: float = 180.0,
    ) -> None:
        if not api_key:
            raise LlmError("OPENROUTER_API_KEY is not set (put it in .env)")
        if not (math.isfinite(budget_usd) and budget_usd > 0):
            raise LlmError(f"budget must be a positive finite number of USD, got {budget_usd}")
        self.budget_usd = budget_usd
        self.spent_usd = 0.0
        self._max_seen_cost = 0.0
        self._cache_dir = cache_dir
        # One send at a time: the pooled TLS connection is not safe to share across threads
        # (seen as "bad record mac"), and budget check + spend update must be atomic.
        self._lock = threading.Lock()
        self._http = httpx.Client(
            base_url=base_url,
            transport=transport,
            timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}", "X-Title": "adjudicate"},
        )

    @classmethod
    def from_env(cls, *, cache_dir: Path, repo_root: Path | None = None) -> LlmClient:
        root = repo_root or Path(__file__).resolve().parents[3]
        env = {**_read_dotenv(root / ".env"), **os.environ}
        return cls(
            api_key=env.get("OPENROUTER_API_KEY", ""),
            budget_usd=float(env.get("ADJUDICATE_LLM_BUDGET_USD", "2.00")),
            cache_dir=cache_dir,
        )

    # -- cost ---------------------------------------------------------------------------
    def _estimate(self, model: str, prompt_chars: int, max_tokens: int) -> float:
        price_in, price_out = PRICES[model]
        tokens_in = prompt_chars / _CHARS_PER_TOKEN
        worst = (tokens_in * price_in + max_tokens * price_out) / 1e6
        return max(worst, self._max_seen_cost)

    def _check_budget(self, model: str, prompt_chars: int, max_tokens: int) -> float:
        estimate = self._estimate(model, prompt_chars, max_tokens)
        if self.spent_usd + estimate > self.budget_usd:
            raise BudgetExceededError(
                f"budget ${self.budget_usd:.4f}: spent ${self.spent_usd:.4f}"
                f" + estimated ${estimate:.4f} would exceed it; request not sent"
            )
        return estimate

    # -- cache --------------------------------------------------------------------------
    def _cache_path(self, key: str) -> Path:
        return self._cache_dir / key[:2] / f"{key}.json"

    # -- call ---------------------------------------------------------------------------
    def _send(self, model: str, messages: list[dict[str, str]], max_tokens: int) -> str:
        with self._lock:
            return self._send_locked(model, messages, max_tokens)

    def _send_locked(self, model: str, messages: list[dict[str, str]], max_tokens: int) -> str:
        chars = sum(len(m["content"]) for m in messages)
        estimate = self._check_budget(model, chars, max_tokens)
        try:
            response = self._http.post(
                "/chat/completions",
                json={
                    "model": model,
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": 0,
                    "usage": {"include": True},
                },
            )
        except httpx.HTTPError as exc:
            # A timed-out request may still have been billed: charge the estimate.
            self.spent_usd += estimate
            raise LlmError(f"transport error: {type(exc).__name__}: {exc}") from exc
        if response.status_code != 200:
            try:
                detail = response.json().get("error", {}).get("message", response.text)
            except ValueError:
                detail = response.text
            raise LlmError(f"HTTP {response.status_code}: {detail}")
        try:
            body = response.json()
        except ValueError as exc:
            raise LlmError(f"non-JSON response body: {response.text[:200]}") from exc
        if not isinstance(body, dict):
            raise LlmError(f"unexpected response body: {str(body)[:200]}")
        cost = self._cost(model, body.get("usage") or {}, estimate)
        self.spent_usd += cost
        self._max_seen_cost = max(self._max_seen_cost, cost)
        choices = body.get("choices") or [{}]
        if isinstance(choices[0], dict) and choices[0].get("finish_reason") == "length":
            details = (body.get("usage") or {}).get("completion_tokens_details") or {}
            raise TruncatedError(
                f"output truncated at max_tokens={max_tokens}"
                f" (hidden reasoning tokens: {details.get('reasoning_tokens', '?')})"
            )
        try:
            return str(body["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError) as exc:
            raise LlmError(f"malformed response: {str(body)[:200]}") from exc

    @staticmethod
    def _cost(model: str, usage: dict[str, object], estimate: float) -> float:
        """Reported cost, else list price from tokens, else the pre-send worst case.

        Never 0 for a call we cannot price: a silent $0 would disable the budget cap.
        """
        reported = usage.get("cost")
        if isinstance(reported, int | float) and math.isfinite(reported) and reported >= 0:
            return float(reported)
        tokens_in, tokens_out = usage.get("prompt_tokens"), usage.get("completion_tokens")
        if isinstance(tokens_in, int) and isinstance(tokens_out, int):
            price_in, price_out = PRICES[model]
            return (tokens_in * price_in + tokens_out * price_out) / 1e6
        return estimate

    @staticmethod
    def _parse(content: str, schema: type[T]) -> T:
        text = content.strip()
        if (m := _FENCE.match(text)) is not None:
            text = m.group(1)
        return schema.model_validate_json(text)

    def complete_json(
        self, model: str, *, system: str, user: str, schema: type[T], max_tokens: int
    ) -> T:
        if model not in PRICES:
            raise UnknownModelError(f"{model} has no known price; add it to PRICES first")
        schema_json = json.dumps(schema.model_json_schema(), sort_keys=True)
        system_full = (
            f"{system}\n\nRespond with only a JSON object (no prose) matching this JSON Schema:\n"
            f"{schema_json}"
        )
        key = hashlib.sha256(
            json.dumps([model, system_full, user, max_tokens], sort_keys=True).encode()
        ).hexdigest()
        path = self._cache_path(key)
        if path.is_file():
            try:
                entry = json.loads(path.read_text())
                if entry.get("truncated") is True:
                    # a replay must take the same path the original run took
                    raise TruncatedError(f"cached: output hit max_tokens={max_tokens}")
                return self._parse(entry["content"], schema)
            except ValueError, KeyError, TypeError, AttributeError:
                path.unlink(missing_ok=True)  # half-written/stale entry: refetch, never trust

        messages = [{"role": "system", "content": system_full}, {"role": "user", "content": user}]
        try:
            content = self._send(model, messages, max_tokens)
        except TruncatedError:
            self._store(path, {"model": model, "truncated": True})
            raise
        try:
            result = self._parse(content, schema)
        except ValidationError as first:
            messages += [
                {"role": "assistant", "content": content},
                {
                    "role": "user",
                    "content": f"Your previous reply was not valid: {first}. "
                    "Reply with only the corrected JSON object.",
                },
            ]
            content = self._send(model, messages, max_tokens)
            try:
                result = self._parse(content, schema)
            except ValidationError as second:
                raise LlmError(f"invalid output after retry: {second}") from second
        self._store(path, {"model": model, "content": content})
        return result

    @staticmethod
    def _store(path: Path, entry: dict[str, object]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(entry))
        os.replace(tmp, path)  # atomic: a crash never leaves a half-written entry
