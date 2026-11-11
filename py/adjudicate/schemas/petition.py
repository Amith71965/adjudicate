"""Petition evidence inventory and the evidence → criterion mapping (artifacts x criteria)."""

from __future__ import annotations

import json
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, Field, model_validator

from adjudicate.parse.structure import Criterion
from adjudicate.schemas.examiner import ProngReview
from adjudicate.schemas.letters import LetterPacket, LetterReview, MeritsReview


class EvidenceKind(StrEnum):
    CERTIFICATE = "certificate"
    LETTER = "letter"
    ARTICLE = "article"
    PUBLICATION = "publication"
    RECORD = "record"
    CONTRACT = "contract"
    OTHER = "other"


class Artifact(BaseModel):
    id: str = Field(pattern=r"^A\d{2}$")
    kind: EvidenceKind
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=2000)
    claimed_criterion: Criterion | None = None  # where the draft petition files it


class Petition(BaseModel):
    id: str = Field(pattern=r"^P\d{2,4}$")
    visa: str = Field(pattern=r"^EB-1A$")
    field: str = Field(min_length=1, max_length=120)
    beneficiary: str = Field(min_length=1, max_length=80)  # synthetic only
    artifacts: list[Artifact] = Field(min_length=1, max_length=200)


class CriterionScore(BaseModel):
    criterion: Criterion
    strength: float = Field(ge=0, le=1)


class ArtifactMapping(BaseModel):
    artifact_id: str
    best_criterion: Criterion | None  # None: supports no criterion
    strength: float = Field(ge=0, le=1)
    rationale: str = Field(min_length=1, max_length=600)
    scores: list[CriterionScore]  # one per criterion: the artifacts x criteria matrix

    @model_validator(mode="after")
    def _complete_row(self) -> ArtifactMapping:
        if {s.criterion for s in self.scores} != set(Criterion) or len(self.scores) != 10:
            raise ValueError("scores must contain exactly one entry for each of the 10 criteria")
        return self


class PetitionMapping(BaseModel):
    petition_id: str
    mappings: list[ArtifactMapping]


SCHEMAS: dict[str, type[BaseModel]] = {
    "petition.schema.json": Petition,
    "petition_mapping.schema.json": PetitionMapping,
    "prong_review.schema.json": ProngReview,
    "letter_packet.schema.json": LetterPacket,
    "letter_review.schema.json": LetterReview,
    "merits_review.schema.json": MeritsReview,
}


def export_json_schemas(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name, model in SCHEMAS.items():
        (directory / name).write_text(
            json.dumps(model.model_json_schema(), indent=2, sort_keys=True) + "\n"
        )
