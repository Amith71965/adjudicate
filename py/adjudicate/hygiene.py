"""PII guard for anything committed: fixtures, golden files, synthetic petitions.

The repo must only ever contain synthetic applicant data. This scanner is
deliberately conservative (high recall on the obvious identifiers) and is run
as a test, so a leak fails the build instead of relying on review.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

PII_PATTERNS: dict[str, re.Pattern[str]] = {
    "ssn": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    # USCIS alien registration number: A + 8-9 digits, optionally dash-grouped.
    "a_number": re.compile(r"\bA-?\d{3}-?\d{3}-?\d{2,3}\b"),
    "email": re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"),
}


@dataclass(frozen=True, slots=True)
class PiiFinding:
    kind: str
    match: str


def scan_for_pii(text: str) -> list[PiiFinding]:
    return [
        PiiFinding(kind, m.group(0))
        for kind, pattern in PII_PATTERNS.items()
        for m in pattern.finditer(text)
    ]
