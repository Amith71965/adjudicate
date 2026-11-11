"""Pick the Phase-2 gold set: 25 EB-1A merits decisions issued in 2025, stratified by outcome.

2025 only, so the gold set stays disjoint from the 2026 decisions held out for the
Phase-7 eval. Deterministic (fixed seed), and the selection + normalised texts are
committed so the gold set is reproducible without the database.

usage: python -I scripts/select_gold.py <repo-root>
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import psycopg

from adjudicate.db import database_url
from adjudicate.harvest.categories import VisaType
from adjudicate.parse.filter import classify
from adjudicate.parse.normalise import normalise
from adjudicate.parse.pdf import pdf_to_text
from adjudicate.parse.structure import Outcome, extract_outcome

SEED = 20261110
TARGET = 25
MIN_REMANDS = 5

root = Path(sys.argv[1])
gold = root / "py" / "tests" / "golden"
with psycopg.connect(database_url()) as conn:
    rows = conn.execute(
        "SELECT decision_id, content FROM raw_decision WHERE visa_type = 'EB-1A'"
        " AND issued_year = 2025 AND content IS NOT NULL ORDER BY decision_id"
    ).fetchall()

merits: dict[str, tuple[str, Outcome]] = {}
for decision_id, content in rows:
    text = normalise(pdf_to_text(bytes(content))).text
    if classify(text, VisaType.EB1A).is_merits:
        merits[str(decision_id)] = (text, extract_outcome(text))

rng = random.Random(SEED)  # noqa: S311 — reproducible sampling, not security
ids = sorted(merits)
rng.shuffle(ids)
remands = [i for i in ids if merits[i][1] is Outcome.REMANDED][:MIN_REMANDS]
others = [i for i in ids if i not in remands][: TARGET - len(remands)]
chosen = sorted(remands + others)

for i in chosen:
    (gold / "texts" / f"{i}.txt").write_text(merits[i][0])
(gold / "selection.json").write_text(
    json.dumps(
        {
            "seed": SEED,
            "population": f"{len(rows)} EB-1A decisions issued 2025; {len(merits)} merits",
            "decision_ids": chosen,
            "outcomes": {i: merits[i][1].value for i in chosen},
        },
        indent=2,
    )
    + "\n"
)
print(f"{len(rows)} decisions, {len(merits)} merits, selected {len(chosen)}")
print(
    {
        o: sum(merits[i][1].value == o for i in chosen)
        for o in {"dismissed", "remanded", "sustained"}
    }
)
