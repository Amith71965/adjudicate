"""Deterministic structure: outcome, criterion taxonomy, sections, claimed criteria, citations.

Per-criterion *verdicts* are not extracted here (that is the LLM step); this
layer gives the LLM — and the eval — a reliable skeleton to hang them on.
"""

from __future__ import annotations

import itertools
from pathlib import Path

import pytest

from adjudicate.parse.normalise import normalise
from adjudicate.parse.pdf import pdf_to_text
from adjudicate.parse.structure import (
    Criterion,
    Outcome,
    SectionKind,
    case_citations,
    claimed_criteria,
    criterion_for,
    extract_outcome,
    split_sections,
)

FIX = Path(__file__).parent / "fixtures" / "decisions"


def _text(name: str) -> str:
    return normalise(pdf_to_text((FIX / f"{name}.pdf").read_bytes())).text


@pytest.fixture(scope="module")
def remand() -> str:
    return _text("SEP152026_01B2203")


@pytest.fixture(scope="module")
def stage_two() -> str:
    return _text("SEP172026_06B2203")


class TestOutcome:
    def test_remand(self, remand: str) -> None:
        assert extract_outcome(remand) is Outcome.REMANDED

    def test_dismissal(self, stage_two: str) -> None:
        assert extract_outcome(stage_two) is Outcome.DISMISSED

    @pytest.mark.parametrize(
        ("order", "outcome"),
        [
            ("ORDER: The appeal is sustained.", Outcome.SUSTAINED),
            ("ORDER: The motion to reopen is dismissed.", Outcome.MOTION_DISMISSED),
            ("ORDER: The motion to reconsider is granted.", Outcome.MOTION_GRANTED),
            ("ORDER: The appeal is rejected.", Outcome.REJECTED),
        ],
    )
    def test_order_lines(self, order: str, outcome: Outcome) -> None:
        assert extract_outcome(f"text\n{order}\n") is outcome

    def test_missing_order_is_unknown_not_a_guess(self) -> None:
        assert extract_outcome("no disposition here") is Outcome.UNKNOWN


class TestCriterionTaxonomy:
    @pytest.mark.parametrize(
        ("phrase", "criterion"),
        [
            # headings seen in the live corpus survey
            ("Published Material About the Alien", Criterion.PUBLISHED_MATERIAL),
            ("Published Materials", Criterion.PUBLISHED_MATERIAL),
            ("Leading or Critical Role", Criterion.LEADING_ROLE),
            ("Performance in a Leading or Critical Role", Criterion.LEADING_ROLE),
            ("High Salary or Other Significantly High Remuneration", Criterion.HIGH_SALARY),
            ("Authorship of Scholarly Articles in the Field", Criterion.SCHOLARLY_ARTICLES),
            ("Membership in Associations in the Field", Criterion.MEMBERSHIP),
            ("Memberships", Criterion.MEMBERSHIP),
            ("Lesser Prizes or Awards", Criterion.AWARDS),
            ("Lesser Nationally or Internationally Recognized Awards", Criterion.AWARDS),
            ("Judging", Criterion.JUDGING),
            ("Artistic Display", Criterion.DISPLAY),
            (
                "Original Contributions of Major Significance in the Field",
                Criterion.ORIGINAL_CONTRIBUTIONS,
            ),
            ("Commercial Success in the Performing Arts", Criterion.COMMERCIAL_SUCCESS),
            # bullet phrasing (SEP152026_01B2203)
            ("Participation as a judge of others' work in the field;", Criterion.JUDGING),
            (
                "Performing leading or critical roles for organizations that have a distinguished"
                " reputation; and",
                Criterion.LEADING_ROLE,
            ),
            ("Commanding a high salary in relation to others in the field.", Criterion.HIGH_SALARY),
            # CFR paragraph cites
            ("8 C.F.R. § 204.5(h)(3)(viii)", Criterion.LEADING_ROLE),
            ("8 C.F.R. § 204.5(h)(3)(iv)", Criterion.JUDGING),
            ("8 C.F.R. § 204.5(h)(3)(x)", Criterion.COMMERCIAL_SUCCESS),
        ],
    )
    def test_phrases_map_to_canonical_criteria(self, phrase: str, criterion: Criterion) -> None:
        assert criterion_for(phrase) is criterion

    @pytest.mark.parametrize(
        "phrase", ["Final Merits Determination", "Reserved Issues", "The Petitioner"]
    )
    def test_non_criterion_headings_map_to_none(self, phrase: str) -> None:
        assert criterion_for(phrase) is None

    def test_two_part_criteria_are_marked(self) -> None:
        assert Criterion.LEADING_ROLE.two_part
        assert Criterion.DISPLAY.two_part is False


class TestSections:
    def test_stage_two_decision_has_a_final_merits_section(self, stage_two: str) -> None:
        kinds = [s.kind for s in split_sections(stage_two)]
        assert SectionKind.FINAL_MERITS in kinds
        assert kinds[0] is SectionKind.PREAMBLE and SectionKind.LAW in kinds

    def test_sections_tile_the_text_without_gaps_or_overlap(self, stage_two: str) -> None:
        sections = split_sections(stage_two)
        assert sections[0].start == 0 and sections[-1].end == len(stage_two)
        assert all(a.end == b.start for a, b in itertools.pairwise(sections))

    def test_criterion_subsections_carry_their_criterion(self) -> None:
        text = (
            "I. LAW\nlaw\nII. ANALYSIS\nintro\nA. Published Material\nabout press\n"
            "B. Leading or Critical Role\nabout role\nC. Reserved Issues\nwe reserve\n"
            "III. CONCLUSION\ndone\n"
        )
        got = [(s.kind, s.criterion) for s in split_sections(text)]
        assert (SectionKind.CRITERION, Criterion.PUBLISHED_MATERIAL) in got
        assert (SectionKind.CRITERION, Criterion.LEADING_ROLE) in got
        assert (SectionKind.RESERVED, None) in got


def test_claimed_criteria_from_bullet_list(remand: str) -> None:
    assert claimed_criteria(remand) == [
        Criterion.AWARDS,
        Criterion.JUDGING,
        Criterion.ORIGINAL_CONTRIBUTIONS,
        Criterion.SCHOLARLY_ARTICLES,
        Criterion.LEADING_ROLE,
        Criterion.HIGH_SALARY,
    ]


def test_claimed_criteria_in_prose_only_returns_empty_not_a_guess(stage_two: str) -> None:
    assert claimed_criteria(stage_two) == []


def test_case_citations(remand: str) -> None:
    cites = {c.reporter for c in case_citations(remand)}
    assert {"596 F.3d 1115", "24 F.4th 383", "25 I&N Dec. 369", "26 I&N Dec. 537"} <= cites


def test_case_citation_names(remand: str) -> None:
    names = {c.reporter: c.name for c in case_citations(remand)}
    assert names["25 I&N Dec. 369"] == "Matter of Chawathe"
    assert names["596 F.3d 1115"] == "Kazarian v. USCIS"


def test_criterion_heading_wrapped_across_two_lines_is_recognised() -> None:
    # Real layout (DEC012025_01B2203): "B. Leading or Critical\nRole" became an untyped "Role".
    text = (
        "I. LAW\nlaw\nII. ANALYSIS\nintro\nA. Original Contributions of Major Significance\n"
        "body\nB. Leading or Critical\nRole\nThe regulation at 8 C.F.R. § 204.5(h)(3)(viii).\n"
        "III. CONCLUSION\ndone\n"
    )
    got = [(s.kind, s.criterion) for s in split_sections(text)]
    assert (SectionKind.CRITERION, Criterion.LEADING_ROLE) in got
    assert (SectionKind.OTHER, None) not in got
