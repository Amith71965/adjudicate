"""Synthetic petitions for the Phase-5 adversarial examiner, with ground truth by construction.

Every claimed criterion has exactly one artifact, filed correctly (mode A is Phase 4's job).
Planted on top:
- mode B: a two-part criterion whose evidence proves one prong only (a leading role at an
  organization with no shown reputation, a membership admitted by staff, not experts, ...);
- mode D: evidence that plainly supports a criterion the petition never claims.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from adjudicate.parse.structure import Criterion
from adjudicate.schemas.petition import Artifact, EvidenceKind, Petition
from adjudicate.synth.petitions import FIELDS, NAMES, TEMPLATES

C = Criterion
# Mirrors web/lib/examiner/prongs.ts (a cross-language test keeps the two in step).
PRONG_IDS: dict[Criterion, tuple[str, ...]] = {
    C.LEADING_ROLE: ("role", "reputation"),
    C.PUBLISHED_MATERIAL: ("about", "venue"),
    C.MEMBERSHIP: ("requirement", "judged"),
    C.ORIGINAL_CONTRIBUTIONS: ("original", "significance"),
}
TWO_PART = list(PRONG_IDS)
# Display (vii) and commercial success (x) only make sense for artistic work: claiming them
# for an engineer is itself a defect, so they never appear as "fully evidenced" elsewhere.
ARTS_ONLY = frozenset({C.DISPLAY, C.COMMERCIAL_SUCCESS})
ARTS_FIELDS = frozenset({"jazz performance"})

# Half-proven evidence. It reads like a real inventory entry: it does not announce what is
# missing, it simply never shows it. {f}=field, {t}=topic.
HALVES: dict[Criterion, tuple[EvidenceKind, str, str, tuple[str, ...]]] = {
    C.LEADING_ROLE: (
        EvidenceKind.LETTER,
        "Letter from the co-founder of a two-year-old startup",
        "Describes the beneficiary as head of the startup's {t} team and lists the product "
        "and hiring decisions they made.",
        ("reputation",),
    ),
    C.MEMBERSHIP: (
        EvidenceKind.CERTIFICATE,
        "Membership certificate from the Society of {f}",
        "The bylaws require a record of outstanding achievement for admission; applications "
        "are reviewed and approved by the society's administrative staff.",
        ("judged",),
    ),
    C.PUBLISHED_MATERIAL: (
        EvidenceKind.ARTICLE,
        "National newspaper article on trends in {t}",
        "A survey of industry trends in {t} in a national daily that quotes the beneficiary "
        "in one sentence among several sources.",
        ("about",),
    ),
    C.ORIGINAL_CONTRIBUTIONS: (
        EvidenceKind.LETTER,
        "Patent and supervisor letter on a {t} method",
        "The beneficiary's granted patent on a new method for {t}, with a letter from their "
        "own supervisor describing how the invention works.",
        ("significance",),
    ),
}


@dataclass(frozen=True, slots=True)
class PlantedHalf:
    artifact_id: str
    criterion: Criterion
    missing_prongs: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class PlantedUnclaimed:
    artifact_id: str
    criterion: Criterion


@dataclass(frozen=True, slots=True)
class ExaminerCase:
    petition: Petition
    truth: dict[str, Criterion | None]
    planted_halves: tuple[PlantedHalf, ...]
    planted_unclaimed: tuple[PlantedUnclaimed, ...]

    def to_json(self) -> dict[str, object]:
        return {
            "petition": self.petition.model_dump(mode="json"),
            "truth": {k: (v.value if v else None) for k, v in self.truth.items()},
            "planted_halves": [
                {
                    "artifact_id": h.artifact_id,
                    "criterion": h.criterion.value,
                    "missing_prongs": list(h.missing_prongs),
                }
                for h in self.planted_halves
            ],
            "planted_unclaimed": [
                {"artifact_id": u.artifact_id, "criterion": u.criterion.value}
                for u in self.planted_unclaimed
            ],
        }


def _case(index: int, rng: random.Random) -> ExaminerCase:
    field, topic, org = rng.choice(FIELDS)
    forced_half = TWO_PART[index % len(TWO_PART)]  # every half kind is covered across the set
    allowed = [c for c in Criterion if field in ARTS_FIELDS or c not in ARTS_ONLY]
    others = [c for c in allowed if c is not forced_half]
    rng.shuffle(others)
    claimed = [forced_half, *others[: rng.randint(4, 6)]]
    unclaimed = rng.choice([c for c in allowed if c not in claimed])
    halves = {forced_half}
    extra = [c for c in claimed if c.two_part and c is not forced_half]
    if extra and rng.random() < 0.3:
        halves.add(rng.choice(extra))

    # (criterion it truly supports, claimed under, half-proven?)
    plan: list[tuple[Criterion | None, Criterion | None, bool]] = [
        (c, c, c in halves) for c in claimed
    ]
    plan += [(unclaimed, None, False), (None, None, False)]  # mode-D evidence, a decoy
    rng.shuffle(plan)

    artifacts, truth = [], {}
    planted_halves, planted_unclaimed = [], []
    for i, (crit, claim, half) in enumerate(plan):
        aid = f"A{i + 1:02d}"
        if half and crit is not None:
            kind, title, desc, missing = HALVES[crit]
            planted_halves.append(PlantedHalf(aid, crit, missing))
        else:
            kind, title, desc = rng.choice(TEMPLATES[crit])
        if crit is not None and claim is None:
            planted_unclaimed.append(PlantedUnclaimed(aid, crit))
        artifacts.append(
            Artifact(
                id=aid,
                kind=kind,
                title=title.format(f=field, t=topic, o=org),
                description=desc.format(f=field, t=topic, o=org),
                claimed_criterion=claim,
            )
        )
        truth[aid] = crit
    petition = Petition(
        id=f"P{index + 1:02d}",
        visa="EB-1A",
        field=field,
        beneficiary=rng.choice(NAMES),
        artifacts=artifacts,
    )
    return ExaminerCase(petition, truth, tuple(planted_halves), tuple(planted_unclaimed))


def generate_examiner_set(*, n: int, seed: int) -> list[ExaminerCase]:
    rng = random.Random(seed)  # noqa: S311 — reproducible synthetic data, not security
    return [_case(i, rng) for i in range(n)]
