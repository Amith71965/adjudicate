"""The owner's blind check of 5 gold decisions stays in agreement with the gold labels.

The labels in golden/labels/ were written by the developer; blind_check.json holds the
repository owner's independent reading of 5 of them (from the PDFs, without seeing the
labels). If a later edit to a label drifts from that reading, this fails.
"""

from __future__ import annotations

import json
from pathlib import Path

from adjudicate.parse.gold_eval import GoldLabel

GOLDEN = Path(__file__).parent / "golden"
BLIND = json.loads((GOLDEN / "blind_check.json").read_text())


def _fields(label: GoldLabel) -> dict[str, str]:
    out = {"outcome": str(label.outcome), "final_merits": str(label.final_merits)}
    for name, v in label.criteria.items():
        out[f"{name}.director"] = str(v.director)
        out[f"{name}.aao"] = str(v.aao)
    return out


def _gold(decision_id: str) -> GoldLabel:
    return GoldLabel.model_validate_json((GOLDEN / "labels" / f"{decision_id}.json").read_text())


def test_five_decisions_from_the_gold_set_were_checked() -> None:
    selected = {p.stem for p in (GOLDEN / "labels").glob("*.json")}
    ids = [d["decision_id"] for d in BLIND["decisions"]]
    assert len(ids) == 5 and len(set(ids)) == 5
    assert set(ids) <= selected


def test_the_blind_reading_agrees_with_the_gold_labels() -> None:
    total = agree = 0
    for raw in BLIND["decisions"]:
        blind = _fields(GoldLabel.model_validate(raw))
        gold = _fields(_gold(raw["decision_id"]))
        for key in blind.keys() | gold.keys():
            total += 1
            agree += blind.get(key) == gold.get(key)
    assert total == BLIND["fields"] and agree == BLIND["agree"]
    assert agree / total >= 0.95
