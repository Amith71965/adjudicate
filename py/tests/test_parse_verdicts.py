"""Per-criterion verdict extraction (LLM) with grounding: every quote must be verbatim.

The LLM is faked; these tests pin the contract, the prompt inputs and the
grounding gate — not model quality (that is the 25-decision gold-set eval).
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from adjudicate.llm.client import LlmClient
from adjudicate.parse.structure import Criterion
from adjudicate.parse.verdicts import (
    DecisionVerdicts,
    GroundingError,
    Verdict,
    extract_verdicts,
    ungrounded_quotes,
)

TEXT = (
    "I. LAW\nThe law.\nII. ANALYSIS\nA. Published Material\n"
    "The Petitioner submitted articles that are not about him. We agree with the Director "
    "that the record does not satisfy this criterion.\n"
    "B. Leading or Critical Role\nThe Petitioner held a leading role, but the record does "
    "not show the organization has a distinguished reputation.\n"
    "C. Reserved Issues\nWe reserve the remaining criteria.\nIII. CONCLUSION\n"
    "ORDER: The appeal is dismissed.\n"
)

GOOD = {
    "criteria": [
        {
            "criterion": "published_material",
            "director": "not_met",
            "aao": "not_met",
            "failed_prong": "material not about the petitioner",
            "quote": "The Petitioner submitted articles that are not about him.",
        },
        {
            "criterion": "leading_role",
            "director": "not_addressed",
            "aao": "not_met",
            "failed_prong": "distinguished reputation",
            "quote": "the record does not show the organization has a distinguished reputation",
        },
    ],
    "final_merits": "not_reached",
}


def _client(
    tmp_path: Path, *payloads: dict[str, object]
) -> tuple[LlmClient, list[dict[str, object]]]:
    sent: list[dict[str, object]] = []
    queue = [json.dumps(p) for p in payloads]

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": queue.pop(0)}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "cost": 0.0001},
            },
        )

    client = LlmClient(
        api_key="sk-test",
        budget_usd=1.0,
        cache_dir=tmp_path,
        transport=httpx.MockTransport(handler),
    )
    return client, sent


def test_extracts_grounded_verdicts(tmp_path: Path) -> None:
    client, _ = _client(tmp_path, GOOD)
    result = extract_verdicts(client, TEXT)
    assert isinstance(result, DecisionVerdicts)
    by = {c.criterion: c for c in result.criteria}
    assert by[Criterion.PUBLISHED_MATERIAL].aao is Verdict.NOT_MET
    assert by[Criterion.LEADING_ROLE].failed_prong == "distinguished reputation"
    assert result.final_merits is Verdict.NOT_REACHED


def test_prompt_sends_the_analysis_not_the_law_boilerplate(tmp_path: Path) -> None:
    client, sent = _client(tmp_path, GOOD)
    extract_verdicts(client, TEXT)
    user = str(sent[0]["messages"][1]["content"])  # type: ignore[index]
    assert "Published Material" in user and "The law." not in user


def test_quotes_are_matched_ignoring_line_breaks_and_spacing() -> None:
    result = DecisionVerdicts.model_validate(GOOD)
    wrapped = TEXT.replace("are not about him.", "are not\nabout  him.")
    assert ungrounded_quotes(result, wrapped) == []


def test_fabricated_quote_triggers_one_corrective_retry(tmp_path: Path) -> None:
    bad = json.loads(json.dumps(GOOD))
    bad["criteria"][0]["quote"] = "The articles were published in major media."  # not in text
    client, sent = _client(tmp_path, bad, GOOD)
    result = extract_verdicts(client, TEXT)
    assert len(sent) == 2
    assert "not found verbatim" in str(sent[1]["messages"])
    assert result.criteria[0].quote.startswith("The Petitioner submitted")


def test_persistent_fabrication_raises(tmp_path: Path) -> None:
    bad = json.loads(json.dumps(GOOD))
    bad["criteria"][1]["quote"] = "The organization is world famous."
    client, _ = _client(tmp_path, bad, bad)
    with pytest.raises(GroundingError, match="world famous"):
        extract_verdicts(client, TEXT)


def test_duplicate_criteria_are_rejected() -> None:
    dup = json.loads(json.dumps(GOOD))
    dup["criteria"].append(dict(dup["criteria"][0]))
    with pytest.raises(ValueError, match="duplicate"):
        DecisionVerdicts.model_validate(dup)


def test_decision_without_analysis_section_is_refused(tmp_path: Path) -> None:
    client, sent = _client(tmp_path)
    with pytest.raises(ValueError, match="ANALYSIS"):
        extract_verdicts(client, "no structure here")
    assert sent == []
