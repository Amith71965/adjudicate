"""Map AAO decision-category folder names to the visa classification they decide."""

from __future__ import annotations

import re
from enum import StrEnum


class VisaType(StrEnum):
    EB1A = "EB-1A"
    O1 = "O-1"
    EB2_NIW = "EB-2/NIW"
    EB1C = "EB-1C"
    L1 = "L-1"
    EB1B = "EB-1B"
    OTHER = "other"


# Keyed by the AAO category code that prefixes every folder name ("B2 - ...", "D8-...").
_BY_CODE: dict[str, VisaType] = {
    "B2": VisaType.EB1A,
    "D8": VisaType.O1,
    "B5": VisaType.EB2_NIW,
    "B4": VisaType.EB1C,
    "D7": VisaType.L1,
    "B3": VisaType.EB1B,
}
_CODE = re.compile(r"^\s*([A-Z]\d{1,2})\s*-")


def category_code(category: str) -> str | None:
    match = _CODE.match(category)
    return match.group(1) if match else None


def visa_type_for_category(category: str) -> VisaType:
    """Known in-scope codes map to their visa; every other category is OTHER (kept, not dropped)."""
    code = category_code(category)
    return _BY_CODE.get(code, VisaType.OTHER) if code else VisaType.OTHER
