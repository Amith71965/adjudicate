"""Generate synthetic EB-1A evidence inventories whose correct criterion is known.

Each artifact is rendered from a template written for exactly one criterion (or for none:
decoys). Two or three artifacts per petition are filed under the wrong criterion — the
classic failure mode A (e.g. journal articles offered as proof of a leading role).
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from adjudicate.parse.structure import Criterion
from adjudicate.schemas.petition import Artifact, EvidenceKind, Petition

C = Criterion
FIELDS = [
    ("computational biology", "protein-folding models", "Institute for Molecular Simulation"),
    ("renewable energy engineering", "offshore wind controllers", "Northsea Grid Consortium"),
    ("jazz performance", "modal improvisation", "Harbor City Jazz Orchestra"),
    ("fintech product design", "real-time fraud scoring", "Ledgerline Payments"),
    ("structural engineering", "seismic retrofit systems", "Meridian Bridge Authority"),
]
NAMES = [
    "Dr. Avery Quillfeather",
    "Rowan Thistlewood",
    "Dr. Juniper Ashgrove",
    "Ellis Marrowfield",
    "Dr. Sable Wintermere",
    "Indigo Brackenridge",
    "Dr. Lark Fennimore",
    "Oakley Starling",
]

# (kind, title, description) per true criterion; {f}=field, {t}=topic, {o}=organization.
TEMPLATES: dict[Criterion | None, list[tuple[EvidenceKind, str, str]]] = {
    C.AWARDS: [
        (
            EvidenceKind.CERTIFICATE,
            "National {f} Excellence Prize",
            "Certificate and press release: the beneficiary received a national prize, "
            "selected by an independent jury from open nominations, for work on {t}.",
        )
    ],
    C.MEMBERSHIP: [
        (
            EvidenceKind.LETTER,
            "Fellowship of the Academy of {f}",
            "Bylaws require outstanding achievement judged by recognized national "
            "experts; letter confirms the beneficiary's election as a fellow.",
        )
    ],
    C.PUBLISHED_MATERIAL: [
        (
            EvidenceKind.ARTICLE,
            "Profile in a national trade magazine",
            "A feature article written by a staff journalist about the "
            "beneficiary and their work on {t}, with circulation data.",
        )
    ],
    C.JUDGING: [
        (
            EvidenceKind.RECORD,
            "Peer-review invitations and completion records",
            "Editor emails inviting the beneficiary to review manuscripts on {t} for a "
            "journal in {f}, with confirmations that the reviews were completed.",
        )
    ],
    C.ORIGINAL_CONTRIBUTIONS: [
        (
            EvidenceKind.LETTER,
            "Independent expert letter on {t}",
            "An unaffiliated expert explains how the beneficiary's method "
            "for {t} was adopted across the field and changed practice.",
        )
    ],
    C.SCHOLARLY_ARTICLES: [
        (
            EvidenceKind.PUBLICATION,
            "Peer-reviewed journal articles",
            "Three articles authored by the beneficiary on {t} in peer-reviewed {f} journals.",
        )
    ],
    C.DISPLAY: [
        (
            EvidenceKind.RECORD,
            "Exhibition programme listing",
            "Programme from a curated showcase where the beneficiary's own {f} work was "
            "displayed to the public.",
        )
    ],
    C.LEADING_ROLE: [
        (
            EvidenceKind.LETTER,
            "Letter from the CEO of {o}",
            "Describes the beneficiary as head of the {t} division of {o}, an "
            "organization with documented national reputation, and their decisions.",
        )
    ],
    C.HIGH_SALARY: [
        (
            EvidenceKind.CONTRACT,
            "Compensation statement with survey data",
            "Pay statement for the beneficiary alongside an industry salary survey "
            "placing it above the 95th percentile for {f}.",
        )
    ],
    C.COMMERCIAL_SUCCESS: [
        (
            EvidenceKind.RECORD,
            "Box office and sales reports",
            "Distributor reports of ticket and recording sales for "
            "performances led by the beneficiary.",
        )
    ],
    None: [
        (
            EvidenceKind.CERTIFICATE,
            "Online course completion certificate",
            "Certificate of completion of a self-paced introductory course.",
        ),
        (
            EvidenceKind.LETTER,
            "Employment verification letter",
            "HR letter confirming job title and dates of employment, nothing more.",
        ),
    ],
}
# Where draft petitions commonly misfile each kind of evidence (failure mode A).
MISFILED_AS: dict[Criterion, Criterion] = {
    C.SCHOLARLY_ARTICLES: C.LEADING_ROLE,
    C.PUBLISHED_MATERIAL: C.SCHOLARLY_ARTICLES,
    C.JUDGING: C.AWARDS,
    C.MEMBERSHIP: C.AWARDS,
    C.ORIGINAL_CONTRIBUTIONS: C.PUBLISHED_MATERIAL,
    C.HIGH_SALARY: C.LEADING_ROLE,
    C.DISPLAY: C.PUBLISHED_MATERIAL,
    C.COMMERCIAL_SUCCESS: C.HIGH_SALARY,
    C.AWARDS: C.MEMBERSHIP,
    C.LEADING_ROLE: C.ORIGINAL_CONTRIBUTIONS,
}


@dataclass(frozen=True, slots=True)
class SyntheticCase:
    petition: Petition
    truth: dict[str, Criterion | None]
    planted_mismatches: frozenset[str]

    def to_json(self) -> dict[str, object]:
        return {
            "petition": self.petition.model_dump(mode="json"),
            "truth": {k: (v.value if v else None) for k, v in self.truth.items()},
            "planted_mismatches": sorted(self.planted_mismatches),
        }


def _petition(index: int, rng: random.Random) -> SyntheticCase:
    field, topic, org = rng.choice(FIELDS)
    pool = list(Criterion)
    rng.shuffle(pool)
    truths: list[Criterion | None] = pool[: rng.randint(5, 8)] + [None] * rng.randint(1, 2)
    rng.shuffle(truths)
    real = [i for i, t in enumerate(truths) if t is not None]
    misfile = set(rng.sample(real, k=min(len(real), rng.randint(2, 3))))  # random positions
    decoys = [i for i, t in enumerate(truths) if t is None]
    claimed_decoy = (
        rng.choice(decoys) if rng.random() < 0.6 else None
    )  # weak evidence, filed anyway
    artifacts, truth, planted = [], {}, set()
    for i, crit in enumerate(truths):
        aid = f"A{i + 1:02d}"
        kind, title, desc = rng.choice(TEMPLATES[crit])
        claimed = MISFILED_AS[crit] if (crit is not None and i in misfile) else crit
        if i == claimed_decoy:
            claimed = rng.choice(list(Criterion))
        if claimed != crit:
            planted.add(aid)
        artifacts.append(
            Artifact(
                id=aid,
                kind=kind,
                title=title.format(f=field, t=topic, o=org),
                description=desc.format(f=field, t=topic, o=org),
                claimed_criterion=claimed,
            )
        )
        truth[aid] = crit
    petition = Petition(
        id=f"P{index:02d}",
        visa="EB-1A",
        field=field,
        beneficiary=rng.choice(NAMES),
        artifacts=artifacts,
    )
    return SyntheticCase(petition, truth, frozenset(planted))


def generate_set(*, n: int, seed: int) -> list[SyntheticCase]:
    rng = random.Random(seed)  # noqa: S311 — reproducible synthetic data, not security
    return [_petition(i + 1, rng) for i in range(n)]
