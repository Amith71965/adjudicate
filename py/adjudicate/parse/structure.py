"""Deterministic decision structure: outcome, criteria, sections, claims, citations.

Everything here is regex over normalised text and either answers exactly or
answers "unknown/empty" — it never guesses. Per-criterion verdicts, which need
reading comprehension, are left to the LLM extraction step.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum


class Criterion(StrEnum):
    """The ten EB-1A criteria at 8 C.F.R. § 204.5(h)(3)(i)-(x)."""

    AWARDS = "awards"
    MEMBERSHIP = "membership"
    PUBLISHED_MATERIAL = "published_material"
    JUDGING = "judging"
    ORIGINAL_CONTRIBUTIONS = "original_contributions"
    SCHOLARLY_ARTICLES = "scholarly_articles"
    DISPLAY = "display"
    LEADING_ROLE = "leading_role"
    HIGH_SALARY = "high_salary"
    COMMERCIAL_SUCCESS = "commercial_success"

    @property
    def paragraph(self) -> str:
        return _PARAGRAPH[self]

    @property
    def two_part(self) -> bool:
        """Criteria whose text imposes two independent tests; failing either fails both.

        Conservative reading of the regulation: role + distinguished organization;
        material *about* the person + in major media/professional publications;
        membership requiring outstanding achievements + judged by recognised experts;
        contributions that are original + of major significance.
        """
        return self in _TWO_PART


_PARAGRAPH = dict(
    zip(Criterion, ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"], strict=True)
)
_BY_PARAGRAPH = {v: k for k, v in _PARAGRAPH.items()}
_TWO_PART = frozenset(
    {
        Criterion.LEADING_ROLE,
        Criterion.PUBLISHED_MATERIAL,
        Criterion.MEMBERSHIP,
        Criterion.ORIGINAL_CONTRIBUTIONS,
    }
)
_CFR_PARAGRAPH = re.compile(r"204\.5\(h\)\(3\)\((x|ix|viii|vii|vi|v|iv|iii|ii|i)\)")
# Ordered: earlier, more specific phrases win ("original contributions" before "award").
_KEYWORDS: list[tuple[re.Pattern[str], Criterion]] = [
    (re.compile(r"leading or critical", re.I), Criterion.LEADING_ROLE),
    (re.compile(r"high salary|remuneration", re.I), Criterion.HIGH_SALARY),
    (re.compile(r"commercial success", re.I), Criterion.COMMERCIAL_SUCCESS),
    (re.compile(r"scholarly articles?", re.I), Criterion.SCHOLARLY_ARTICLES),
    (re.compile(r"original contributions?", re.I), Criterion.ORIGINAL_CONTRIBUTIONS),
    (re.compile(r"published materials?", re.I), Criterion.PUBLISHED_MATERIAL),
    (re.compile(r"\bjudg(?:e|es|ing)\b", re.I), Criterion.JUDGING),
    (re.compile(r"\bmemberships?\b", re.I), Criterion.MEMBERSHIP),
    (re.compile(r"\bdisplay\b|\bexhibitions?\b", re.I), Criterion.DISPLAY),
    (re.compile(r"\bawards?\b|\bprizes?\b", re.I), Criterion.AWARDS),
]


def criterion_for(phrase: str) -> Criterion | None:
    if (m := _CFR_PARAGRAPH.search(phrase)) is not None:
        return _BY_PARAGRAPH[m.group(1)]
    for pattern, criterion in _KEYWORDS:
        if pattern.search(phrase):
            return criterion
    return None


class Outcome(StrEnum):
    DISMISSED = "dismissed"
    SUSTAINED = "sustained"
    REMANDED = "remanded"
    REJECTED = "rejected"
    MOTION_DISMISSED = "motion_dismissed"
    MOTION_GRANTED = "motion_granted"
    UNKNOWN = "unknown"


_ORDER = re.compile(r"^ORDER:\s*(.+(?:\n(?!FURTHER ORDER)[^\n]+)?)", re.MULTILINE)


def extract_outcome(text: str) -> Outcome:
    m = _ORDER.search(text)
    if m is None:
        return Outcome.UNKNOWN
    order = m.group(1).lower()
    if "motion" in order:
        if "granted" in order:
            return Outcome.MOTION_GRANTED
        if "dismissed" in order or "denied" in order:
            return Outcome.MOTION_DISMISSED
        return Outcome.UNKNOWN
    for word, outcome in (
        ("remanded", Outcome.REMANDED),
        ("sustained", Outcome.SUSTAINED),
        ("rejected", Outcome.REJECTED),
        ("dismissed", Outcome.DISMISSED),
    ):
        if word in order:
            return outcome
    return Outcome.UNKNOWN


class SectionKind(StrEnum):
    PREAMBLE = "preamble"
    LAW = "law"
    ANALYSIS = "analysis"
    CRITERION = "criterion"
    FINAL_MERITS = "final_merits"
    RESERVED = "reserved"
    CONCLUSION = "conclusion"
    OTHER = "other"


@dataclass(frozen=True, slots=True)
class Section:
    kind: SectionKind
    title: str
    criterion: Criterion | None
    start: int
    end: int


_TOP = re.compile(r"^[IVX]+\. ([A-Z][A-Z ,'&-]+)$", re.MULTILINE)
_SUB = re.compile(r"^(?:[A-Z]|\d{1,2})\. ([A-Z][^\n]{2,80})$", re.MULTILINE)


def _top_kind(title: str) -> SectionKind:
    if "ANALYSIS" in title:
        return SectionKind.ANALYSIS
    if "LAW" in title:
        return SectionKind.LAW
    if "CONCLUSION" in title:
        return SectionKind.CONCLUSION
    return SectionKind.OTHER


def _sub_kind(title: str) -> tuple[SectionKind, Criterion | None]:
    lowered = title.lower()
    if "final merits" in lowered:
        return SectionKind.FINAL_MERITS, None
    if "reserve" in lowered:
        return SectionKind.RESERVED, None
    criterion = criterion_for(title)
    if criterion is not None and "criteria" not in lowered:
        return SectionKind.CRITERION, criterion
    return SectionKind.OTHER, None


def split_sections(text: str) -> list[Section]:
    """Tile the text into sections at headings (subheadings only inside ANALYSIS)."""
    marks: list[tuple[int, SectionKind, str, Criterion | None]] = []
    analysis_span: tuple[int, int] | None = None
    tops = list(_TOP.finditer(text))
    for i, m in enumerate(tops):
        kind = _top_kind(m.group(1))
        marks.append((m.start(), kind, m.group(1), None))
        if kind is SectionKind.ANALYSIS:
            end = tops[i + 1].start() if i + 1 < len(tops) else len(text)
            analysis_span = (m.end(), end)
    if analysis_span is not None:
        for m in _SUB.finditer(text, *analysis_span):
            kind, criterion = _sub_kind(m.group(1))
            marks.append((m.start(), kind, m.group(1), criterion))
    marks.sort(key=lambda mark: mark[0])
    if not marks or marks[0][0] > 0:
        marks.insert(0, (0, SectionKind.PREAMBLE, "", None))
    bounds = [m[0] for m in marks[1:]] + [len(text)]
    return [
        Section(kind, title, criterion, start, end)
        for (start, kind, title, criterion), end in zip(marks, bounds, strict=True)
    ]


_CLAIM_BLOCK = re.compile(r"claim[^\n]*(?:\n[^\n•]*){0,3}?((?:\n•[^\n]+)+)", re.IGNORECASE)


def claimed_criteria(text: str) -> list[Criterion]:
    """Criteria listed as bullets after a 'claimed' sentence in ANALYSIS; [] if only prose."""
    heading = re.search(r"^[IVX]+\. ANALYSIS\b", text, re.MULTILINE)
    if heading is None:
        return []
    m = _CLAIM_BLOCK.search(text, heading.end())
    if m is None:
        return []
    found: list[Criterion] = []
    for line in m.group(1).strip().splitlines():
        criterion = criterion_for(line)
        if criterion is not None and criterion not in found:
            found.append(criterion)
    return found


@dataclass(frozen=True, slots=True)
class CaseCitation:
    name: str
    reporter: str


# Party names may wrap across lines ("Amin\nv. Mayorkas"), hence \s between tokens.
_AGENCY_CITE = re.compile(r"(Matter\sof\s[A-Z][^,]{0,40}?(?:,\sInc\.)?),?\s(\d+\sI&N\sDec\.\s\d+)")
_FEDERAL_CITE = re.compile(
    r"([A-Z][\w.'&-]*(?:\s[A-Z][\w.'&-]*){0,2}\sv\.\s[A-Z][\w.'&-]*(?:\s[A-Z][\w.'&-]*){0,2}),"
    r"\s(\d+\sF\.(?:\sSupp\.)?\s?(?:2d|3d|4th)\s\d+|\d+\sF\.\s\d+)"
)
_SIGNALS = re.compile(r"^(?:See also|See generally|See|Cf\.|Accord|But see|E\.g\.,?) ")


def case_citations(text: str) -> list[CaseCitation]:
    seen: dict[str, CaseCitation] = {}
    for pattern in (_AGENCY_CITE, _FEDERAL_CITE):
        for m in pattern.finditer(text):
            name = _SIGNALS.sub("", " ".join(m.group(1).split()))
            reporter = " ".join(m.group(2).split())
            seen.setdefault(reporter, CaseCitation(name, reporter))
    return list(seen.values())
