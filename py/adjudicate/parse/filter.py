"""Decide whether a decision is a merits decision with real criterion analysis.

Many AAO decisions are motions to reopen/reconsider or procedural dismissals:
they restate the law (and may even cite the criteria) but contain no analysis
of the evidence. Posture decides first, because citations alone mislead — an
NIW *motion* cites Dhanasar three times. Every rejection carries its reason.

"Criterion analysis" is recognised three ways, because real decisions use all
three: individual CFR cites (204.5(h)(3)(viii)), criteria named in prose
("the leading or critical role criterion"), or a Final Merits Determination
subsection — the Kazarian stage-two denials that matter most to this product.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum

from adjudicate.harvest.categories import VisaType

MIN_WORDS = 1000
MIN_CRITERION_CITATIONS = 2
_POSTURE_WINDOW = 4000

_MOTION = re.compile(r"before us on (?:a |combined )?motions?\b", re.IGNORECASE)
_ROMAN_HEADING = re.compile(r"^[IVX]+\. [A-Z][A-Z ,'&-]+$", re.MULTILINE)
_ANALYSIS_HEADING = re.compile(r"^[IVX]+\. ANALYSIS\b", re.MULTILINE)
_LEGACY_DISCUSSION = re.compile(r"^DISCUSSION:", re.MULTILINE)
_ROMAN = r"(?:x|ix|viii|vii|vi|v|iv|iii|ii|i)"
_CRITERIA: dict[VisaType, re.Pattern[str]] = {
    # Individual criteria only; the boilerplate range "(i)-(x)" does not count.
    VisaType.EB1A: re.compile(rf"204\.5\(h\)\(3\)\({_ROMAN}\)(?!-)"),
    VisaType.O1: re.compile(r"214\.2\(o\)\(3\)\((?:iii|iv)\)(?!-)"),
    VisaType.EB2_NIW: re.compile(r"Dhanasar|204\.5\(k\)\(3\)\(ii\)"),
}

# Distinct EB-1A / O-1A criteria named in prose (O-1A's eight are a near-subset).
_NAMED_CRITERIA: dict[str, re.Pattern[str]] = {
    name: re.compile(rx, re.IGNORECASE)
    for name, rx in {
        "awards": r"\b(?:prizes? or awards?|awards? or prizes?)\b",
        "membership": r"\bmembership in associations\b",
        "published_material": r"\bpublished material\b",
        "judging": r"\bjudg(?:e|ing) (?:of )?the work\b|\bjudging\b",
        "original_contributions": r"\boriginal (?:[a-z-]+, )*(?:or [a-z-]+ )?contributions\b",
        "scholarly_articles": r"\bscholarly articles\b",
        "display": r"\bdisplay of (?:the )?(?:\w+'s )?work\b|\bartistic exhibitions\b",
        "leading_role": r"\bleading or critical role\b",
        "high_salary": r"\bhigh salary\b",
        "commercial_success": r"\bcommercial success(?:es)?\b",
    }.items()
}
_NAMED_FOR = frozenset({VisaType.EB1A, VisaType.O1})
_FINAL_MERITS_HEADING = re.compile(
    r"^(?:[A-Z]|[IVX]+)\. Final Merits Determination\s*$", re.MULTILINE | re.IGNORECASE
)


class DecisionKind(StrEnum):
    MERITS = "merits"
    MOTION = "motion"
    LEGACY_FORMAT = "legacy_format"
    UNSTRUCTURED = "unstructured"
    OUT_OF_SCOPE = "out_of_scope"
    NO_ANALYSIS = "no_analysis"
    NO_CRITERION_ANALYSIS = "no_criterion_analysis"
    TOO_SHORT = "too_short"


@dataclass(frozen=True, slots=True)
class Classification:
    kind: DecisionKind
    words: int
    criterion_citations: int
    named_criteria: int = 0
    final_merits_section: bool = False
    reasons: list[str] = field(default_factory=list)

    @property
    def is_merits(self) -> bool:
        return self.kind is DecisionKind.MERITS


def classify(text: str, visa: VisaType, *, min_words: int = MIN_WORDS) -> Classification:
    words = len(text.split())
    pattern = _CRITERIA.get(visa)
    heading = _ANALYSIS_HEADING.search(text)
    # Evidence counts only from the ANALYSIS section on: the LAW section's
    # boilerplate names criteria ("awards, published material...") in every decision.
    analysis = text[heading.end() :] if heading else ""
    cites = len(pattern.findall(analysis)) if pattern else 0
    named = (
        sum(1 for rx in _NAMED_CRITERIA.values() if rx.search(analysis))
        if visa in _NAMED_FOR
        else 0
    )
    final_merits = bool(_FINAL_MERITS_HEADING.search(analysis))

    def result(kind: DecisionKind, reason: str) -> Classification:
        return Classification(kind, words, cites, named, final_merits, [reason])

    if (m := _MOTION.search(text[:_POSTURE_WINDOW])) is not None:
        return result(DecisionKind.MOTION, f"posture is a motion: {m.group(0)!r}")
    if pattern is None:
        return result(DecisionKind.OUT_OF_SCOPE, f"visa type {visa.value} is out of scope")
    if not _ROMAN_HEADING.search(text):
        if _LEGACY_DISCUSSION.search(text):
            return result(DecisionKind.LEGACY_FORMAT, "pre-2016 'DISCUSSION:' layout")
        return result(DecisionKind.UNSTRUCTURED, "modern decision without section headings")
    if heading is None:
        return result(DecisionKind.NO_ANALYSIS, "no 'ANALYSIS' section heading")
    evidence = [
        f"{cites} criterion citations" if cites >= MIN_CRITERION_CITATIONS else "",
        f"{named} criteria named" if named >= MIN_CRITERION_CITATIONS else "",
        "final merits section" if final_merits else "",
    ]
    evidence = [e for e in evidence if e]
    if not evidence:
        return result(
            DecisionKind.NO_CRITERION_ANALYSIS,
            f"for {visa.value}: {cites} cites, {named} named criteria, no final-merits section",
        )
    if words < min_words:
        return result(DecisionKind.TOO_SHORT, f"{words} words < {min_words}")
    return result(DecisionKind.MERITS, "appeal with ANALYSIS; " + ", ".join(evidence))
