"""Per-criterion verdicts (Director vs AAO) via LLM, with a verbatim-grounding gate.

Every finding must carry a quote that appears verbatim (whitespace-insensitive)
in the decision. A fabricated quote gets one corrective retry; a second
fabrication raises — an unsupported verdict never enters the corpus.
"""

from __future__ import annotations

import re
from enum import StrEnum

from pydantic import BaseModel, Field, model_validator

from adjudicate.llm.client import LlmClient
from adjudicate.parse.structure import Criterion

DEFAULT_MODEL = "anthropic/claude-haiku-5.5"
_ANALYSIS = re.compile(r"^[IVX]+\. ANALYSIS\b", re.MULTILINE)
_SPACE = re.compile(r"\s+")


class Verdict(StrEnum):
    MET = "met"
    NOT_MET = "not_met"
    NOT_REACHED = "not_reached"  # expressly reserved / unnecessary to decide
    NOT_ADDRESSED = "not_addressed"  # the decision is silent on it
    WAIVED = "waived"  # not raised / abandoned on appeal (Matter of O-R-E-) — failure mode D


class GroundingError(ValueError):
    """The model cited text that is not in the decision."""


class CriterionVerdict(BaseModel):
    criterion: Criterion
    director: Verdict
    aao: Verdict
    failed_prong: str | None = Field(default=None, max_length=120)
    quote: str = Field(min_length=10, max_length=700)

    @model_validator(mode="after")
    def _prong_only_when_not_met(self) -> CriterionVerdict:
        if self.aao is not Verdict.NOT_MET:
            self.failed_prong = None
        return self


class DecisionVerdicts(BaseModel):
    criteria: list[CriterionVerdict]
    final_merits: Verdict

    @model_validator(mode="after")
    def _unique_criteria(self) -> DecisionVerdicts:
        seen = [c.criterion for c in self.criteria]
        if len(seen) != len(set(seen)):
            raise ValueError(f"duplicate criteria in extraction: {seen}")
        return self


SYSTEM = """\
You extract findings from a U.S. Citizenship and Immigration Services (USCIS)
Administrative Appeals Office (AAO) decision about an EB-1A "extraordinary ability"
petition. The ten evidentiary criteria are at 8 C.F.R. § 204.5(h)(3)(i)-(x):
awards (i), membership (ii), published_material (iii), judging (iv),
original_contributions (v), scholarly_articles (vi), display (vii),
leading_role (viii), high_salary (ix), commercial_success (x).

Report one entry for EVERY criterion the petitioner claimed (initially, in an RFE
response, or on appeal). Do not include a criterion the decision says was NOT claimed.
For each entry:
- director: what the USCIS Director (the service center, sometimes called "SCOPS")
  concluded about that criterion: "met", "not_met", or "not_addressed" if the Director
  never ruled on it. If the decision says the Director found only certain criteria met,
  every other claimed criterion is "not_met" for the Director.
- aao: the AAO's OWN conclusion: "met"; "not_met"; "not_reached" if the AAO expressly
  reserved the issue, said it need not decide it, or said it will not disturb or discuss
  the individual criteria; "waived" only if the AAO SAYS the petitioner did not raise,
  contest or develop it on appeal (waived/abandoned/forfeited); "not_addressed" if the
  AAO is silent about it. Never assume the AAO agrees with the Director on a criterion
  the AAO does not discuss — that is "not_addressed". If the AAO agrees with, adopts
  or affirms the Director's finding, copy the Director's verdict; if it withdraws a
  favourable finding, use "not_met". If it says an argument is waived but ALSO
  concludes the criterion is not met, use "not_met".
- failed_prong: when aao is "not_met", the specific element that failed, in at most
  ten words (e.g. "organization's distinguished reputation"); otherwise null.
- quote: ONE sentence copied EXACTLY, character for character, from the decision text,
  supporting the aao value. Do not paraphrase, merge, or add ellipses.

final_merits: the AAO's conclusion on the final merits determination (sustained
national or international acclaim; among the small percentage at the very top of the
field): "met", "not_met", "not_reached" (e.g. fewer than three criteria met, or
remanded without deciding it — even if the AAO adds an advisory remark that the record
"in the aggregate" would not support acclaim), or "not_addressed".

Include only criteria the decision names explicitly.

Use only the decision text. Never infer a verdict the text does not state."""


def analysis_text(text: str) -> str:
    match = _ANALYSIS.search(text)
    if match is None:
        raise ValueError("decision has no ANALYSIS section; nothing to extract")
    return text[match.start() :]


def _squash(s: str) -> str:
    return _SPACE.sub(" ", s).strip()


def ungrounded_quotes(result: DecisionVerdicts, text: str) -> list[str]:
    haystack = _squash(text)
    return [c.quote for c in result.criteria if _squash(c.quote) not in haystack]


def extract_verdicts(
    client: LlmClient, text: str, *, model: str = DEFAULT_MODEL, max_tokens: int = 3000
) -> DecisionVerdicts:
    analysis = analysis_text(text)
    user = f"DECISION TEXT (analysis onward):\n\n{analysis}"
    result = client.complete_json(
        model, system=SYSTEM, user=user, schema=DecisionVerdicts, max_tokens=max_tokens
    )
    bad = ungrounded_quotes(result, text)
    if not bad:
        return result
    retry_user = (
        f"{user}\n\nYOUR PREVIOUS ANSWER contained quotes not found verbatim in the text: "
        f"{bad}. Copy each quote exactly from the decision text."
    )
    result = client.complete_json(
        model, system=SYSTEM, user=retry_user, schema=DecisionVerdicts, max_tokens=max_tokens
    )
    bad = ungrounded_quotes(result, text)
    if bad:
        raise GroundingError(f"quotes not found in decision after retry: {bad}")
    return result
