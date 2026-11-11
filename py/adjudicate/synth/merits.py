"""Synthetic Kazarian step-two pairs, with the expected outcome by construction.

Both petitions in a pair pass step one (each claimed criterion is facially met, low step-one
risk). The strong one documents acclaim (a national medal, a national profile, chairing a grant
panel, a method in wide production use, pay above the 99th percentile); the weak one meets
three criteria at their floor (a handful of peer reviews, modestly cited conference papers, one
conference best-paper award) — the profile the AAO most often finds wanting at final merits.
Half the pairs share identical letter findings, so the evidence alone has to separate them.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from adjudicate.parse.structure import Criterion
from adjudicate.schemas.petition import (
    Artifact,
    EvidenceKind,
    LetterSummary,
    MeritsInput,
    Petition,
    StepOneCriterion,
)
from adjudicate.synth.letters import SCIENCE_FIELDS
from adjudicate.synth.petitions import NAMES

C, K = Criterion, EvidenceKind
Template = tuple[EvidenceKind, str, str]

# {f}=field, {t}=topic, {o}=organization
STRONG: dict[Criterion, tuple[Template, Template]] = {  # (dev, held-out)
    C.AWARDS: (
        (
            K.CERTIFICATE,
            "National academy young investigator medal",
            "Awarded each year to one researcher nationwide for work on {t}; the award was "
            "reported "
            "by two national newspapers.",
        ),
        (
            K.CERTIFICATE,
            "Gold medal of an international {f} society",
            "Given once a year to one person from the society's sixty member countries; the "
            "citation "
            "names the beneficiary's work on {t}.",
        ),
    ),
    C.PUBLISHED_MATERIAL: (
        (
            K.ARTICLE,
            "Feature profile in a national science magazine",
            "A four-page profile of the beneficiary and their work on {t} in a national magazine "
            "with a circulation of four hundred thousand.",
        ),
        (
            K.ARTICLE,
            "Broadcast and newspaper coverage of the beneficiary",
            "A national public-radio segment and a front-page business-section article, both about "
            "the beneficiary and the adoption of their {t} work.",
        ),
    ),
    C.JUDGING: (
        (
            K.RECORD,
            "Grant panel chair and editorial board service",
            "Chaired the national science agency's {t} grant panel for two cycles and sits on the "
            "editorial board of the field's leading journal.",
        ),
        (
            K.RECORD,
            "Program committee chair of the flagship {f} conference",
            "Served as program chair of the field's largest annual conference, overseeing the "
            "review "
            "of about three thousand submissions.",
        ),
    ),
    C.ORIGINAL_CONTRIBUTIONS: (
        (
            K.RECORD,
            "Adoption record for the beneficiary's {t} method",
            "The method runs in production at {o} and four other organizations; the founding paper "
            "has been cited over two thousand times.",
        ),
        (
            K.RECORD,
            "Industry standard built on the beneficiary's {t} design",
            "A national standards body adopted the beneficiary's design as the reference approach "
            "to {t}; six vendors ship products that implement it.",
        ),
    ),
    C.HIGH_SALARY: (
        (
            K.CONTRACT,
            "Compensation statement and national wage survey",
            "Base salary above the 99th percentile for {f} in the national occupational wage "
            "survey "
            "for the beneficiary's region.",
        ),
        (
            K.CONTRACT,
            "Employment contract and industry pay benchmark",
            "Total pay is more than three times the median for senior {f} professionals according "
            "to an independent industry compensation benchmark.",
        ),
    ),
}
WEAK: dict[Criterion, tuple[Template, Template]] = {
    C.JUDGING: (
        (
            K.RECORD,
            "Peer review confirmations",
            "Confirmation emails for six manuscript reviews completed for two journals in {f}.",
        ),
        (
            K.RECORD,
            "Reviewer acknowledgment letters",
            "Two letters thanking the beneficiary for reviewing four submissions to a {t} "
            "workshop.",
        ),
    ),
    C.SCHOLARLY_ARTICLES: (
        (
            K.PUBLICATION,
            "Five conference papers",
            "Five papers on {t} in regional conference proceedings, cited thirty-eight times in "
            "total.",
        ),
        (
            K.PUBLICATION,
            "Journal articles and preprints",
            "Three journal articles and two preprints on {t}, with a combined twenty-five "
            "citations.",
        ),
    ),
    C.AWARDS: (
        (
            K.CERTIFICATE,
            "Best paper award at a national {f} conference",
            "Best paper award at a national {f} conference, chosen from about four hundred "
            "submissions.",
        ),
        (
            K.CERTIFICATE,
            "Outstanding presentation prize",
            "A prize for the best student-track presentation at an annual {f} meeting.",
        ),
    ),
}
LETTERS_STRONG = LetterSummary(
    letters=5,
    independent=4,
    weak=0,
    assertion_share=0.2,
    boilerplate_pairs=0,
    independence_violations=0,
)
LETTERS_WEAK = LetterSummary(
    letters=4,
    independent=1,
    weak=3,
    assertion_share=0.8,
    boilerplate_pairs=1,
    independence_violations=1,
)
LETTERS_NEUTRAL = LetterSummary(
    letters=4,
    independent=3,
    weak=1,
    assertion_share=0.45,
    boilerplate_pairs=0,
    independence_violations=0,
)


@dataclass(frozen=True, slots=True)
class MeritsCase:
    input: MeritsInput
    tier: str  # strong | weak
    pair: int

    def to_json(self) -> dict[str, object]:
        return {"input": self.input.model_dump(mode="json"), "tier": self.tier, "pair": self.pair}


def _petition(
    pid: str,
    field: str,
    topic: str,
    org: str,
    name: str,
    templates: dict[Criterion, tuple[Template, Template]],
    variant: int,
    rng: random.Random,
) -> tuple[Petition, list[StepOneCriterion]]:
    artifacts, step_one = [], []
    for i, (crit, pair) in enumerate(templates.items()):
        kind, title, desc = pair[variant]
        artifacts.append(
            Artifact(
                id=f"A{i + 1:02d}",
                kind=kind,
                title=title.format(f=field, t=topic, o=org),
                description=desc.format(f=field, t=topic, o=org),
                claimed_criterion=crit,
            )
        )
        step_one.append(StepOneCriterion(criterion=crit, risk=rng.randint(8, 30) / 100))
    petition = Petition(id=pid, visa="EB-1A", field=field, beneficiary=name, artifacts=artifacts)
    return petition, step_one


def generate_merits_set(*, n_pairs: int, seed: int, heldout: bool = False) -> list[MeritsCase]:
    rng = random.Random(seed)  # noqa: S311 — reproducible synthetic data, not security
    variant = 1 if heldout else 0
    cases: list[MeritsCase] = []
    for pair in range(n_pairs):
        field, topic, org = SCIENCE_FIELDS[pair % len(SCIENCE_FIELDS)]
        same_letters = pair % 2 == 1
        for tier, templates in (("strong", STRONG), ("weak", WEAK)):
            pid = f"P{len(cases) + 1:02d}"
            petition, step_one = _petition(
                pid, field, topic, org, rng.choice(NAMES), templates, variant, rng
            )
            letters = (
                LETTERS_NEUTRAL
                if same_letters
                else (LETTERS_STRONG if tier == "strong" else LETTERS_WEAK)
            )
            cases.append(
                MeritsCase(
                    MeritsInput(petition=petition, step_one=step_one, letters=letters), tier, pair
                )
            )
    return cases
