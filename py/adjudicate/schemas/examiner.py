"""The adversarial examiner's output for one prong of one claimed criterion.

Every review must cite AAO reasoning: citations are constrained (after generation) to the
passages the examiner retrieved, and each quote must appear verbatim in its passage.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Citation(BaseModel):
    chunk_id: int = Field(ge=1)
    decision_id: str = Field(min_length=1, max_length=40)
    # Long enough that a verbatim match is evidence, not coincidence ("the record" is not).
    quote: str = Field(min_length=30, max_length=600)


class ProngReview(BaseModel):
    # Taking the inventory at face value, does the evidence meet this prong? False when it is
    # silent on the prong or what it shows fails it (mode B). Doubts about genuineness,
    # corroboration or weight belong in risk and the objection.
    facially_met: bool
    risk: float = Field(ge=0, le=1)  # likelihood an officer raises it in an RFE
    objection: str = Field(min_length=20, max_length=1200)  # strongest RFE-style objection
    citations: list[Citation] = Field(min_length=1, max_length=3)
