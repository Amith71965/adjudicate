"""PII guard for anything committed: fixtures, golden files, synthetic petitions.

The repo must only ever contain synthetic applicant data. This scanner is
deliberately conservative (high recall on the obvious identifiers) and runs as
a test, so a leak fails the build instead of relying on review.

Known limits, stated rather than hidden: it does not detect personal *names*
or free-text addresses (no reliable regex exists; redacted AAO text is full of
capitalised institution fragments). Synthetic data must therefore use obviously
fictional names, and the generators that produce it are tested separately.
"""

from __future__ import annotations

import re
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

PII_PATTERNS: dict[str, re.Pattern[str]] = {
    "ssn": re.compile(r"\b\d{3}[-\s]\d{2}[-\s]\d{4}\b"),
    "ssn_bare": re.compile(r"\b\d{9}\b"),
    # USCIS alien registration number: A + 8-9 digits, optionally dash-grouped.
    "a_number": re.compile(r"\bA-?\d{3}-?\d{3}-?\d{2,3}\b", re.IGNORECASE),
    "email": re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"),
    "phone": re.compile(r"(?:\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b"),
    "dob": re.compile(
        r"\b(?:DOB|date of birth|born)\b[:\s]+\d{1,2}/\d{1,2}/\d{2,4}", re.IGNORECASE
    ),
}


class UnscannableFileError(RuntimeError):
    """A file could not be turned into text, so it cannot be proven PII-free."""


@dataclass(frozen=True, slots=True)
class PiiFinding:
    kind: str
    match: str


@dataclass(frozen=True, slots=True)
class FilePiiFinding:
    path: Path
    kind: str
    match: str


def scan_for_pii(text: str) -> list[PiiFinding]:
    return [
        PiiFinding(kind, m.group(0))
        for kind, pattern in PII_PATTERNS.items()
        for m in pattern.finditer(text)
    ]


def _pdf_text(path: Path) -> str:
    try:
        result = subprocess.run(  # noqa: S603 — fixed argv, no shell
            ["pdftotext", "-q", str(path), "-"],  # noqa: S607 — poppler on PATH
            capture_output=True,
            text=True,
            check=True,
            timeout=60,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise UnscannableFileError(f"{path}: pdftotext failed ({exc})") from exc
    if not result.stdout.strip():
        raise UnscannableFileError(f"{path}: PDF has no text layer; cannot verify no PII")
    return result.stdout


def file_text(path: Path) -> str:
    """Extract scannable text from ``path`` or raise UnscannableFileError."""
    if path.suffix.lower() == ".pdf":
        return _pdf_text(path)
    try:
        return path.read_bytes().decode("utf-8")
    except UnicodeDecodeError as exc:
        raise UnscannableFileError(f"{path}: not UTF-8 text and no extractor known") from exc


def scan_tree(roots: Iterable[Path]) -> list[FilePiiFinding]:
    """Scan every file under each root. Missing roots and unreadable files raise."""
    findings: list[FilePiiFinding] = []
    for root in roots:
        if not root.exists():
            raise FileNotFoundError(f"PII scan root does not exist: {root}")
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            findings.extend(
                FilePiiFinding(path, f.kind, f.match) for f in scan_for_pii(file_text(path))
            )
    return findings
