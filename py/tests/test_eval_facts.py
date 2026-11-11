"""Phase-7 facts extraction: an AAO decision turned back into the evidence inventory the
petitioner filed, with no verdict. The leak detector is the guard: the adjudicator's
conclusion must not ride into the examiner's input."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from pydantic import BaseModel

from adjudicate.eval.facts import (
    PLACEHOLDER,
    ExtractedFacts,
    extract_facts,
    hard_leaks,
    soft_hits,
)
from adjudicate.eval.realset import CriterionTruth, Label, TestDecision


def test_hard_leaks_catch_verdicts_and_procedure_on_word_boundaries() -> None:
    text = (
        "The Director found the letters insufficient; on appeal we agree the petitioner "
        "did not establish the reputation and fails to meet the criterion."
    )
    assert hard_leaks(text) == [
        "the director", "insufficient", "appeal", "we agree", "did not establish", "fails to",
    ]  # fmt: skip
    assert hard_leaks("A certificate of membership issued by the society in 2019.") == []
    assert hard_leaks("Sufficiently cited? Self-sufficient grids.") == ["sufficient"]


def test_job_titles_and_ordinary_words_are_not_leaks() -> None:
    # pilot false positive: "Founder Directory" matched the stem "director"
    assert hard_leaks("A Founder Directory printout listing the beneficiary.") == []
    assert hard_leaks("Offer letter naming the beneficiary the Director of Engineering.") == []
    assert hard_leaks("Weighted citation index; an appealing design.") == []
    assert hard_leaks("Deficiencies were remanded.") == ["deficien", "remand"]  # stems


def test_soft_hits_count_weight_words_without_failing() -> None:
    assert soft_hits("Only two letters, merely restating the regulation.") == ["only", "merely"]


def _decision(criteria: list[str]) -> TestDecision:
    truth = tuple(
        CriterionTruth(c, "not_met", "not_met", Label("not_met", "aao")) for c in criteria
    )
    return TestDecision("JUL012026_01B2203", date(2026, 7, 1), "dismissed", None, "text", truth)


class FakeClient:
    def __init__(self, *payloads: dict[str, Any]) -> None:
        self.payloads = list(payloads)
        self.users: list[str] = []

    def complete_json[T: BaseModel](
        self, model: str, *, system: str, user: str, schema: type[T], max_tokens: int
    ) -> T:
        self.users.append(user)
        return schema.model_validate(self.payloads.pop(0))


def art(criterion: str, description: str) -> dict[str, str]:
    return {
        "criterion": criterion,
        "kind": "record",
        "title": "A record",
        "description": description,
    }


def test_clean_extraction_becomes_a_petition_for_the_examiner() -> None:
    client = FakeClient(
        {"field": "materials science", "artifacts": [
            art("judging", "Two invitations to review manuscripts for a journal in 2021."),
            art("awards", "A university teaching prize awarded in 2019."),
        ]},
    )  # fmt: skip
    out = extract_facts(client, _decision(["awards", "judging"]), index=7)
    assert out.status == "ok" and out.attempts == 1 and out.leaks == [] and out.placeholders == []
    assert out.petition is not None
    assert out.petition.id == "P0007" and out.petition.field == "materials science"
    assert [(a.id, a.claimed_criterion) for a in out.petition.artifacts] == [
        ("A01", "judging"),
        ("A02", "awards"),
    ]
    assert "awards" in client.users[0] and "text" in client.users[0]


def test_a_leak_is_retried_once_naming_the_words_then_the_decision_is_dropped() -> None:
    leaky = {"field": "f", "artifacts": [art("judging", "The Director found this insufficient.")]}
    client = FakeClient(leaky, leaky)
    out = extract_facts(client, _decision(["judging"]), index=1)
    assert out.status == "leaky" and out.petition is None and out.attempts == 2
    assert out.leaks == ["the director", "insufficient"]
    assert "director" in client.users[1] and "insufficient" in client.users[1]

    fixed = FakeClient(leaky, {"field": "f", "artifacts": [art("judging", "Review invitations.")]})
    again = extract_facts(fixed, _decision(["judging"]), index=1)
    assert again.status == "ok" and again.attempts == 2


def test_a_criterion_the_decision_never_describes_gets_a_placeholder_and_is_reported() -> None:
    client = FakeClient(
        {"field": "f", "artifacts": [art("judging", "Review invitations.")]},
        {"field": "f", "artifacts": [art("judging", "Review invitations.")]},
    )
    out = extract_facts(client, _decision(["judging", "awards"]), index=2)
    assert out.status == "ok" and out.placeholders == ["awards"]
    assert out.petition is not None
    assert [a.description for a in out.petition.artifacts if a.claimed_criterion == "awards"] == [
        PLACEHOLDER
    ]
    assert "awards" in client.users[1]  # the retry asked for it by name


def test_artifacts_for_criteria_nobody_claimed_are_dropped() -> None:
    client = FakeClient(
        {"field": "f", "artifacts": [art("judging", "Reviews."), art("high_salary", "A salary.")]}
    )
    out = extract_facts(client, _decision(["judging"]), index=3)
    assert out.petition is not None
    assert {a.claimed_criterion for a in out.petition.artifacts} == {"judging"}


def test_extracted_facts_schema_has_no_verdict_field() -> None:
    fields = set(ExtractedFacts.model_json_schema()["$defs"]["ExtractedArtifact"]["properties"])
    assert fields == {"criterion", "kind", "title", "description"}
    with pytest.raises(ValueError):
        ExtractedFacts.model_validate({"field": "f", "artifacts": []})


def test_a_truncated_answer_is_retried_once_with_a_larger_output_budget() -> None:
    from adjudicate.llm.client import TruncatedError

    class Truncating(FakeClient):
        def __init__(self) -> None:
            super().__init__({"field": "f", "artifacts": [art("judging", "Reviews.")]})
            self.budgets: list[int] = []

        def complete_json[T: BaseModel](
            self, model: str, *, system: str, user: str, schema: type[T], max_tokens: int
        ) -> T:
            self.budgets.append(max_tokens)
            if len(self.budgets) == 1:
                raise TruncatedError("output truncated at max_tokens=6000")
            return super().complete_json(
                model, system=system, user=user, schema=schema, max_tokens=max_tokens
            )

    client = Truncating()
    out = extract_facts(client, _decision(["judging"]), index=1)
    assert out.status == "ok" and client.budgets == [6000, 16000]
