"""Recommendation letters (Phase 6) and the Kazarian step-two merits review.

A letter is a list of sentences so that every finding points at an exact sentence by index:
the detector cannot misquote a letter, only mislabel a sentence.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field

from adjudicate.schemas.examiner import Citation


class LetterAuthor(BaseModel):
    name: str = Field(min_length=1, max_length=80)  # synthetic only
    title: str = Field(min_length=1, max_length=120)
    affiliations: list[str] = Field(min_length=1, max_length=6)
    # How the petition presents the letter: an "independent" expert (no tie to the beneficiary)
    # or a colleague, advisor or employer. A tie behind an independent label is a violation.
    claimed_independent: bool


class Letter(BaseModel):
    id: str = Field(pattern=r"^L\d{2}$")
    author: LetterAuthor
    sentences: list[str] = Field(min_length=1, max_length=80)


class Publication(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    authors: list[str] = Field(min_length=1, max_length=30)  # as printed, e.g. "Okafor, T."


class BeneficiaryProfile(BaseModel):
    name: str = Field(min_length=1, max_length=80)  # synthetic only
    affiliations: list[str] = Field(min_length=1, max_length=10)
    publications: list[Publication] = Field(max_length=100)


class LetterPacket(BaseModel):
    petition_id: str = Field(pattern=r"^P\d{2,4}$")
    field: str = Field(min_length=1, max_length=120)
    beneficiary: BeneficiaryProfile
    letters: list[Letter] = Field(min_length=1, max_length=20)


class SentenceLabel(StrEnum):
    MECHANISM = "mechanism"  # says what was done and a concrete, checkable consequence
    ASSERTION = "assertion"  # praise or importance claimed without a mechanism (mode C)
    CONTEXT = "context"  # who the author is, how they know the work; no claim of merit


class SentenceVerdict(BaseModel):
    index: int = Field(ge=0)
    label: SentenceLabel
    reason: str = Field(min_length=1, max_length=200)


class LetterReview(BaseModel):
    sentences: list[SentenceVerdict] = Field(min_length=1, max_length=80)


class MeritsReview(BaseModel):
    # Kazarian v. USCIS, 596 F.3d 1115 (9th Cir. 2010), step two: in the totality of the
    # record, sustained national or international acclaim, and one of the small percentage
    # at the very top of the field (8 C.F.R. § 204.5(h)(2)).
    sustained_acclaim: bool
    top_of_field: bool
    risk: float = Field(ge=0, le=1)  # likelihood the final merits determination is adverse
    reasoning: str = Field(min_length=40, max_length=2000)
    citations: list[Citation] = Field(min_length=1, max_length=3)
