"""Synthetic recommendation-letter packets for Phase 6, with ground truth by construction.

Every sentence is rendered from a template written for one kind:
- context: who the author is and how they know the work (no claim of merit);
- mechanism_plain / mechanism_superlative: what was done and a checkable consequence, the
  latter dressed in superlatives (a lexicon wrongly flags it);
- assertion_superlative / assertion_plain: praise or importance with no mechanism (mode C),
  the latter without any superlative word (a lexicon misses it).
Planted on top: a boilerplate block copied (one sentence lightly edited) across 2-3 letters,
and a letter presented as independent whose author co-wrote with, or shares an affiliation
with, the beneficiary. Near misses (same surname, different initial; an organization that only
shares its first word) are the hard negatives. Held-out templates never appear in dev.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from adjudicate.schemas.letters import (
    BeneficiaryProfile,
    Letter,
    LetterAuthor,
    LetterPacket,
    Publication,
)
from adjudicate.synth.petitions import FIELDS, NAMES

Pool = dict[str, tuple[str, ...]]
Block = tuple[tuple[str, str], ...]  # (template, kind) sentences copied as one paragraph

# {n}=beneficiary, {f}=field, {t}=topic, {o}=beneficiary's organization, {a}=author's
# organization, {x}>{y} counts, {p} a percentage, {e1}>{e2} error figures.
DEV: Pool = {
    "context": (
        "I hold a senior appointment at {a}, where I have worked on {f} for over fifteen years.",
        "I write in support of the petition filed on behalf of {n}.",
        "I have followed the work of {n} since we met at a {f} workshop in 2019.",
        "My own research concerns {t}, so I know the problems {n} works on.",
        "I was asked for my view of the work of {n}, and I am glad to give it.",
        "This letter states my professional opinion of the contributions of {n}.",
    ),
    "mechanism_plain": (
        "The {t} method of {n} cut processing time from {x} hours to {y} minutes, and {o} has "
        "run it in production since 2022.",
        "The open-source library {n} released for {t} is downloaded about {x} thousand times a "
        "month and is a dependency of three national laboratory pipelines.",
        "At {a} we replaced our own {t} approach with the one {n} developed after it reduced our "
        "error rate by {p} percent on our internal test set.",
        "A 2021 paper by {n} introduced a calibration step for {t} that two standards bodies "
        "have since written into their reference procedures.",
        "When our team adopted the technique {n} devised, the cost of each {t} run fell from {x} "
        "dollars to {y} dollars.",
        "{n} designed the evaluation protocol that groups now use to compare {t} systems; it "
        "appears in the methods sections of over {x} papers.",
    ),
    "mechanism_superlative": (
        "It is the most accurate {t} system published: on the shared public benchmark it lowered "
        "error from {e1} to {e2}, ahead of every other entry.",
        "The design by {n} is the fastest I know of, completing the standard {t} workload in {y} "
        "minutes where the next best takes {x}.",
        "This is an exceptional result in concrete terms: the method held its accuracy on {y} "
        "unseen datasets where earlier methods failed on most of them.",
        "The best evidence of its value is practical: {o} credits the method with avoiding {x} "
        "hours of downtime last year in its published annual report.",
        "The most remarkable part is measurable: the {t} model {n} built needs {p} percent less "
        "training data than the previous state of the art to reach the same accuracy.",
        "It is a truly outstanding piece of engineering, and the numbers show it: {o} ships it "
        "to {x} thousand devices, with a failure rate below one in ten thousand.",
    ),
    "assertion_superlative": (
        "{n} is without question one of the most brilliant researchers in {f} of their generation.",
        "I consider {n} to be among the top one percent of scientists working on {t} anywhere "
        "in the world.",
        "The contributions of {n} are truly extraordinary and unparalleled in the field.",
        "In my long career I have rarely met anyone as exceptionally gifted as {n}.",
        "{n} is a world-class expert whose work stands at the very forefront of {f}.",
        "Their achievements are remarkable by any standard.",
    ),
    "assertion_plain": (
        "The work of {n} has changed how practitioners think about {t}.",
        "The importance of this research to the field cannot be overstated.",
        "Many groups have taken note of these results and built on them.",
        "The ideas of {n} will shape the direction of {f} for years to come.",
        "Their contributions are of major significance to the field.",
        "Without this research, progress on {t} would have been much slower.",
    ),
}
DEV_BLOCKS: tuple[Block, ...] = (
    (
        (
            "As an expert in {f}, I can state that {n} has made original contributions of "
            "major significance to the field.",
            "assertion_plain",
        ),
        (
            "The research of {n} has been widely cited and relied upon by researchers across "
            "the world.",
            "assertion_plain",
        ),
        (
            "In my opinion, {n} has risen to the very top of the field and enjoys sustained "
            "national and international acclaim.",
            "assertion_superlative",
        ),
    ),
    (
        (
            "The work of {n} on {t} is recognized by leading experts as among the most "
            "important in recent years.",
            "assertion_superlative",
        ),
        ("These findings have been adopted by industry and academia alike.", "assertion_plain"),
        (
            "I have no doubt that {n} is one of the small percentage who have risen to the very "
            "top of {f}.",
            "assertion_superlative",
        ),
    ),
)

HELDOUT: Pool = {
    "context": (
        "By way of background, I lead the {t} group at {a}.",
        "Please accept this letter as my recommendation for {n}.",
        "I first read the work of {n} in 2020 while surveying the literature on {t}.",
        "My comments below draw on twenty years of practice in {f}.",
        "I serve on the editorial board of a {f} journal and review work on {t} regularly.",
        "I am familiar with the record of {n} through conference talks and published papers.",
    ),
    "mechanism_plain": (
        "Using the scheduling algorithm {n} wrote, the operations team at {o} serves {p} "
        "percent more requests on the same hardware.",
        "Three hospitals now follow the {t} protocol {n} wrote, which lowered their repeat-test "
        "rate from {p} percent to under half that.",
        "{n} found a flaw in the standard {t} benchmark, and the maintainers corrected it in "
        "their next release, crediting {n} in the changelog.",
        "Our lab reproduced the results of {n} on {y} new datasets and saw the same gains in "
        "every one.",
        "The sensor layout {n} proposed let {o} retire {y} of its {x} monitoring stations "
        "without losing coverage.",
        "Regulators in two countries cite the {t} test procedure {n} published as an accepted "
        "way to demonstrate compliance.",
    ),
    "mechanism_superlative": (
        "Measured by the standard test in the field, the model {n} built is the strongest "
        "available, scoring {e2} against the previous record of {e1}.",
        "The most impressive thing is that it works at scale: {o} processes {x} million records "
        "a day with it.",
        "It is outstanding in a specific sense: no other published method handles {t} at noise "
        "levels {y} times higher than in earlier studies, as the paper by {n} showed.",
        "Its greatest strength is cost: the approach {n} designed runs on hardware costing {x} "
        "dollars, where rival systems need a dedicated server.",
        "By a wide margin the best result of its kind, the controller {n} tuned kept {o} within "
        "tolerance for {x} consecutive months.",
        "An extraordinary result with a simple proof: {y} independent teams ran the code {n} "
        "released and matched every reported figure.",
    ),
    "assertion_superlative": (
        "Simply put, {n} is the finest {f} specialist I have encountered.",
        "{n} has an exceptional and rare talent that sets them apart from their peers.",
        "Their output places them in the elite tier of researchers internationally.",
        "I recommend {n} in the strongest possible terms as an outstanding scientist.",
        "Few people in {f} have achieved anything comparable to the brilliant record of {n}.",
        "The accomplishments of {n} are nothing short of phenomenal.",
    ),
    "assertion_plain": (
        "The field owes a great deal to {n}.",
        "{n} has made the kind of contribution that people in {f} talk about.",
        "Their research is widely relied upon by others.",
        "It is clear that the work of {n} has had a lasting influence on {t}.",
        "Colleagues across {f} regard these results as essential reading.",
        "The research program {n} leads has moved the whole area of {t} forward.",
    ),
}
HELDOUT_BLOCKS: tuple[Block, ...] = (
    (
        (
            "Having reviewed the record, I can confirm that {n} is internationally recognized "
            "for original work in {f}.",
            "assertion_plain",
        ),
        (
            "Their publications are relied upon by scholars and practitioners in many countries.",
            "assertion_plain",
        ),
        (
            "{n} clearly belongs to the small group of experts at the very top of the field.",
            "assertion_superlative",
        ),
    ),
    (
        (
            "It is my firm belief that {n} is among the most accomplished people working on "
            "{t} today.",
            "assertion_superlative",
        ),
        ("The impact of these contributions is felt throughout {f}.", "assertion_plain"),
        (
            "Their acclaim is sustained, national and international, and well deserved.",
            "assertion_plain",
        ),
    ),
)
# A lightly edited copy: the first block sentence in the second letter gets a new opening.
BLOCK_EDITS = (
    ("As an expert in", "As a specialist in"),
    ("The work of", "The research of"),
    ("Having reviewed", "Having studied"),
    ("It is my firm belief", "It is my view"),
)

FIRST = (
    "Tamsin",
    "Joaquin",
    "Priya",
    "Halvard",
    "Mireille",
    "Kofi",
    "Annika",
    "Desmond",
    "Yusra",
    "Teodor",
    "Ingrid",
    "Rafferty",
    "Noor",
    "Caspian",
    "Leocadia",
    "Bram",
)
SURNAMES = (
    "Okafor-Lind",
    "Varanasi-Holt",
    "Brennick",
    "Solvang",
    "Achterberg",
    "Mbekwe",
    "Castellane",
    "Rookwood",
    "Thistlebrook",
    "Vashenko",
    "Larkspur",
    "Delacroix-Ude",
    "Henmarsh",
    "Quintavalle",
    "Oyelaran",
    "Feldspar",
    "Morrowind",
    "Kittredge",
    "Pelletrine",
    "Ashcombe",
)
ORGS = (
    "Fallowmere University",
    "Ambergate Polytechnic",
    "Quarry Hill Institute",
    "Kestrel Systems Laboratory",
    "Halden Research Foundation",
    "Larchmont College",
    "Pellucid Robotics",
    "Greywater Research Council",
    "Tidewater Applied Physics Lab",
    "Corvid Analytics",
    "Marrowgate Institute",
    "Saltmarsh University",
    "Wrenfield Polytechnic",
)
NEAR_SUFFIXES = ("Coastal Trust", "Heritage Society", "Data Cooperative")
TITLES = (
    "Professor of {f}",
    "Principal Scientist",
    "Director of Research",
    "Associate Professor",
    "Chief Engineer",
)
PUB_TITLES = (
    "Scalable methods for {t}",
    "A benchmark for {t}",
    "Robust {t} under shift",
    "Lessons from deploying {t}",
)
SCIENCE_FIELDS = [f for f in FIELDS if f[0] != "jazz performance"]  # templates are technical
AFFIL_VARIANTS = ("The {x}", "{x} (visiting appointment)", "{x}, main campus")


@dataclass(frozen=True, slots=True)
class Planted:
    letter_id: str
    kind: str  # violations: coauthor | affiliation; near misses: surname | organization

    def to_json(self) -> dict[str, str]:
        return {"letter_id": self.letter_id, "kind": self.kind}


@dataclass(frozen=True, slots=True)
class LetterCase:
    packet: LetterPacket
    kinds: dict[str, list[str]]  # letter id -> one kind per sentence
    planted_boilerplate: tuple[tuple[str, str], ...]  # sorted letter-id pairs
    planted_violations: tuple[Planted, ...]
    near_misses: tuple[Planted, ...]
    templates_used: frozenset[str]

    def to_json(self) -> dict[str, object]:
        return {
            "packet": self.packet.model_dump(mode="json"),
            "kinds": self.kinds,
            "planted_boilerplate": [list(p) for p in self.planted_boilerplate],
            "planted_violations": [p.to_json() for p in self.planted_violations],
            "near_misses": [p.to_json() for p in self.near_misses],
            "templates_used": sorted(self.templates_used),
        }


def _cited(first: str, surname: str, rng: random.Random) -> str:
    """A name as a bibliography prints it."""
    return f"{surname}, {first[0]}." if rng.random() < 0.5 else f"{first[0]}. {surname}"


def _values(rng: random.Random) -> dict[str, str]:
    e1 = rng.randint(30, 50) / 10
    return {
        "x": str(rng.randint(20, 90)),
        "y": str(rng.randint(3, 12)),
        "p": str(rng.randint(12, 45)),
        "e1": f"{e1:.1f}",
        "e2": f"{e1 - rng.randint(6, 15) / 10:.1f}",
    }


def _body_counts(n_letters: int, rng: random.Random, pool: Pool) -> list[tuple[int, int]]:
    """(mechanism, assertion) sentence counts per letter; one weak letter is all assertion."""
    weak = rng.randrange(n_letters)
    counts = [
        (0, 3) if i == weak else (rng.choice((1, 2, 2, 3)), rng.choice((1, 1, 2)))
        for i in range(n_letters)
    ]
    cap_m = len(pool["mechanism_plain"]) + len(pool["mechanism_superlative"])
    cap_a = len(pool["assertion_plain"]) + len(pool["assertion_superlative"])
    while sum(m for m, _ in counts) > cap_m or sum(a for _, a in counts) > cap_a:
        i = rng.randrange(n_letters)
        m, a = counts[i]
        counts[i] = (max(m - 1, 0 if i == weak else 1), max(a - 1, 1))
    return counts


def _authors(
    index: int,
    rng: random.Random,
    field: str,
    org: str,
    phd: str,
    prior: str,
    coauthors: list[tuple[str, str]],
    strangers: list[tuple[str, str]],
    own_orgs: list[str],
    b_initial: str,
    n_letters: int,
) -> tuple[list[LetterAuthor], list[Planted], list[Planted]]:
    # roles: one truthful dependent letter, an optional violation and near miss, rest clean
    roles = ["dependent"]
    if index % 3 != 2:
        roles.append("violation:" + ("coauthor" if index % 2 == 0 else "affiliation"))
    if index % 2 == 1:
        roles.append("near:" + ("surname" if index % 4 == 1 else "organization"))
    roles += ["clean"] * (n_letters - len(roles))
    rng.shuffle(roles)

    authors: list[LetterAuthor] = []
    violations: list[Planted] = []
    near: list[Planted] = []
    for i, role in enumerate(roles):
        lid = f"L{i + 1:02d}"
        own = own_orgs.pop()
        independent = True
        if role == "dependent":  # a co-author, presented honestly as such
            first, surname = coauthors[0]
            name, affils, independent = f"Prof. {first} {surname}", [phd], False
        elif role == "violation:coauthor":
            first, surname = coauthors[1]
            name, affils = f"Dr. {first} {surname}", [own]
            violations.append(Planted(lid, "coauthor"))
        elif role == "violation:affiliation":
            first, surname = strangers.pop()
            variant = rng.choice(AFFIL_VARIANTS).format(x=rng.choice([phd, prior]))
            name, affils = f"{first} {surname}", [own, variant]
            violations.append(Planted(lid, "affiliation"))
        elif role == "near:surname":  # shares a co-author's surname, not the initial
            co_first, surname = coauthors[2]
            first = next(f for f in FIRST if f[0] not in (co_first[0], b_initial))
            name, affils = f"Dr. {first} {surname}", [own]
            near.append(Planted(lid, "surname"))
        elif role == "near:organization":  # shares only the first word of an organization
            first, surname = strangers.pop()
            name, affils = f"{first} {surname}", [f"{org.split()[0]} {rng.choice(NEAR_SUFFIXES)}"]
            near.append(Planted(lid, "organization"))
        else:
            first, surname = strangers.pop()
            name, affils = f"Dr. {first} {surname}", [own]
        title = rng.choice(TITLES).format(f=field)
        authors.append(
            LetterAuthor(
                name=name, title=title, affiliations=affils, claimed_independent=independent
            )
        )
    return authors, violations, near


def _case(index: int, rng: random.Random, pool: Pool, blocks: tuple[Block, ...]) -> LetterCase:
    field, topic, org = rng.choice(SCIENCE_FIELDS)
    beneficiary = rng.choice(NAMES)
    b_first, b_surname = beneficiary.removeprefix("Dr. ").split(" ", 1)
    orgs = list(ORGS)
    rng.shuffle(orgs)
    phd, prior = orgs.pop(), orgs.pop()
    people = list(zip(rng.sample(FIRST, 12), rng.sample(SURNAMES, 12), strict=True))
    people = [(f, s) for f, s in people if f[0] != b_first[0]][:10]
    coauthors, strangers = people[:4], people[4:]  # strangers: no paper, no shared org
    pubs = []
    for i, title in enumerate(rng.sample(PUB_TITLES, 3)):
        names = [coauthors[i], coauthors[3]] if i < 2 else [coauthors[2]]
        cited = [_cited(b_first, b_surname, rng)] + [_cited(f, s, rng) for f, s in names]
        rng.shuffle(cited)
        pubs.append(Publication(title=title.format(t=topic), authors=cited))

    n_letters = rng.randint(4, 5)
    authors, violations, near = _authors(
        index, rng, field, org, phd, prior, coauthors, strangers, orgs, b_first[0], n_letters
    )

    # sentence templates are drawn without replacement within a petition
    draws = {k: rng.sample(v, len(v)) for k, v in pool.items()}
    used: set[str] = set()

    def take(*kinds: str) -> tuple[str, str]:
        kind = rng.choice([k for k in kinds if draws[k]])
        tpl = draws[kind].pop()
        used.add(tpl)
        return tpl, kind

    bodies: list[list[tuple[str, str]]] = []
    for m, a in _body_counts(n_letters, rng, pool):
        body = [take("mechanism_plain", "mechanism_superlative") for _ in range(m)]
        body += [take("assertion_plain", "assertion_superlative") for _ in range(a)]
        rng.shuffle(body)
        bodies.append([take("context"), *body])

    planted: tuple[tuple[str, str], ...] = ()
    if index % 2 == 0:  # half the petitions carry one boilerplate block in 2-3 letters
        block = blocks[(index // 2) % len(blocks)]
        group = sorted(rng.sample(range(n_letters), rng.choice((2, 2, 3))))
        for j, li in enumerate(group):
            copy = list(block)
            if j == 1:  # the second copy is lightly edited, as a drafter would
                tpl, kind = copy[0]
                old, new = next((o, n) for o, n in BLOCK_EDITS if tpl.startswith(o))
                copy[0] = (new + tpl[len(old) :], kind)
            at = rng.randint(1, len(bodies[li]))
            bodies[li][at:at] = copy
        used.update(t for t, _ in block)
        ids = [f"L{li + 1:02d}" for li in group]
        planted = tuple((a, b) for k, a in enumerate(ids) for b in ids[k + 1 :])

    letters, kinds = [], {}
    for i, (author, body) in enumerate(zip(authors, bodies, strict=True)):
        vals = {"n": beneficiary, "f": field, "t": topic, "o": org, "a": author.affiliations[0]}
        lid = f"L{i + 1:02d}"
        sentences = [tpl.format(**vals, **_values(rng)) for tpl, _ in body]
        letters.append(Letter(id=lid, author=author, sentences=sentences))
        kinds[lid] = [k for _, k in body]
    packet = LetterPacket(
        petition_id=f"P{index + 1:02d}",
        field=field,
        beneficiary=BeneficiaryProfile(
            name=beneficiary, affiliations=[org, phd, prior], publications=pubs
        ),
        letters=letters,
    )
    return LetterCase(packet, kinds, planted, tuple(violations), tuple(near), frozenset(used))


def generate_letter_set(*, n: int, seed: int, heldout: bool = False) -> list[LetterCase]:
    rng = random.Random(seed)  # noqa: S311 — reproducible synthetic data, not security
    pool, blocks = (HELDOUT, HELDOUT_BLOCKS) if heldout else (DEV, DEV_BLOCKS)
    return [_case(i, rng, pool, blocks) for i in range(n)]
