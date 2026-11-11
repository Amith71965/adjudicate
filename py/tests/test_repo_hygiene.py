"""Permanent guards: local-only folders stay ignored; fixtures carry no real PII."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from adjudicate.hygiene import PII_PATTERNS, scan_for_pii, scan_tree

REPO = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize(
    "probe",
    ["_local/WORKLOG.md", "_media/brag/take.mp4", ".archify/scratch.html", ".env"],
)
def test_local_only_paths_are_git_ignored(probe: str) -> None:
    # Probe a nested path: a bare directory name is not matched by `dir/` patterns
    # when the directory does not exist (see _local/INCIDENTS.md).
    result = subprocess.run(["git", "check-ignore", "-q", probe], cwd=REPO, check=False)
    assert result.returncode == 0, f"{probe} is not git-ignored"


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("SSN 123-45-6789 on file", "ssn"),
        ("Alien number A123456789 assigned", "a_number"),
        ("A-123-456-789", "a_number"),
        ("contact jane.doe@example.org", "email"),
    ],
)
def test_scan_detects_each_pii_kind(text: str, kind: str) -> None:
    assert kind in {f.kind for f in scan_for_pii(text)}


@pytest.mark.parametrize(
    "text",
    [
        "8 C.F.R. § 204.5(h)(3)(viii)",
        "Matter of Chawathe, 25 I&N Dec. 369, 375-76 (AAO 2010)",
        "In Re: 44003330  Date: SEP. 15, 2026",
        "SEP152026_01B2203.pdf",
        "596 F.3d 1115",
    ],
)
def test_scan_ignores_legal_citations_and_decision_ids(text: str) -> None:
    assert scan_for_pii(text) == []


def test_pattern_registry_is_compiled() -> None:
    assert all(isinstance(p, re.Pattern) for p in PII_PATTERNS.values())


FIXTURE_ROOTS = [REPO / "py" / "tests" / "fixtures", REPO / "web" / "tests" / "fixtures"]


def test_committed_fixtures_contain_no_pii() -> None:
    # Roots must exist (scan_tree raises otherwise), so this can never pass vacuously.
    assert scan_tree(FIXTURE_ROOTS) == []
