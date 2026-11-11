"""Regenerate the seeded synthetic petition sets (phase 4: mode A; phase 5: modes B and D)."""

import json
from pathlib import Path

from adjudicate.synth.examiner import generate_examiner_set
from adjudicate.synth.petitions import generate_set

OUT = Path(__file__).resolve().parents[1] / "eval" / "synthetic"
SETS = {
    "phase4_petitions.json": [c.to_json() for c in generate_set(n=20, seed=20261111)],
    "phase5_petitions.json": [c.to_json() for c in generate_examiner_set(n=16, seed=20261112)],
}
for name, cases in SETS.items():
    (OUT / name).write_text(json.dumps(cases, indent=2) + "\n")
    print(f"wrote {name}: {len(cases)} petitions")
