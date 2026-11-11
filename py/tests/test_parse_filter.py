"""Procedural filter: keep merits decisions with real criterion analysis, reject the rest.

Tested both ways on real fixtures (via the real PDF → text → normalise path) and
on synthetic edge cases for the conditions no fixture exercises in isolation.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from adjudicate.harvest.categories import VisaType
from adjudicate.parse.filter import DecisionKind, classify
from adjudicate.parse.normalise import normalise
from adjudicate.parse.pdf import PdfTextError, pdf_to_text

FIX = Path(__file__).parent / "fixtures" / "decisions"


def _text(name: str) -> str:
    return normalise(pdf_to_text((FIX / f"{name}.pdf").read_bytes())).text


class TestPdfToText:
    def test_extracts_a_real_decision(self) -> None:
        text = pdf_to_text((FIX / "SEP152026_01B2203.pdf").read_bytes())
        assert "ORDER:" in text and "Kazarian" in text

    def test_non_pdf_bytes_raise(self) -> None:
        with pytest.raises(PdfTextError, match="not a PDF"):
            pdf_to_text(b"<html>soft error</html>")

    def test_pdf_without_text_layer_raises(self) -> None:
        with pytest.raises(PdfTextError, match="text layer"):
            pdf_to_text(b"%PDF-1.4\n%%EOF\n")


@pytest.mark.parametrize(
    ("fixture", "visa", "kind"),
    [
        ("SEP152026_01B2203", VisaType.EB1A, DecisionKind.MERITS),
        ("SEP172026_06B2203", VisaType.EB1A, DecisionKind.MERITS),
        ("JUN092025_02B5203", VisaType.EB2_NIW, DecisionKind.MOTION),
        ("AUG282024_01D8101", VisaType.O1, DecisionKind.MOTION),
        ("JAN312005_06B2203", VisaType.EB1A, DecisionKind.LEGACY_FORMAT),
        ("JUN032025_01D7101", VisaType.L1, DecisionKind.OUT_OF_SCOPE),
    ],
)
def test_real_fixtures_are_classified(fixture: str, visa: VisaType, kind: DecisionKind) -> None:
    result = classify(_text(fixture), visa)
    assert result.kind is kind, result.reasons


def test_motion_is_rejected_even_when_it_cites_the_legal_framework() -> None:
    # The NIW motion cites Dhanasar three times; posture, not citations, must decide.
    result = classify(_text("JUN092025_02B5203"), VisaType.EB2_NIW)
    assert result.kind is DecisionKind.MOTION
    assert any("motion" in r for r in result.reasons)


def test_merits_result_reports_the_evidence_it_relied_on() -> None:
    result = classify(_text("SEP152026_01B2203"), VisaType.EB1A)
    assert result.is_merits
    assert result.criterion_citations >= 5
    assert result.words > 1000


SYNTHETIC_APPEAL = (
    "The matter is now before us on appeal.\n\nI. LAW\n\nstatute.\n\nII. ANALYSIS\n\n"
    + "Under 8 C.F.R. § 204.5(h)(3)(viii) the role and under 8 C.F.R. § 204.5(h)(3)(ix) pay. "
    + "filler " * 1200
    + "\n\nORDER: The appeal is dismissed.\n"
)


def test_synthetic_merits_baseline_passes() -> None:
    assert classify(SYNTHETIC_APPEAL, VisaType.EB1A).kind is DecisionKind.MERITS


def test_too_short_is_rejected() -> None:
    short = SYNTHETIC_APPEAL.replace("filler " * 1200, "filler " * 50)
    assert classify(short, VisaType.EB1A).kind is DecisionKind.TOO_SHORT


def test_missing_analysis_section_is_rejected() -> None:
    no_analysis = SYNTHETIC_APPEAL.replace("II. ANALYSIS", "II. DISCUSSION OF THE RECORD")
    assert classify(no_analysis, VisaType.EB1A).kind is DecisionKind.NO_ANALYSIS


def test_analysis_without_criterion_citations_is_rejected() -> None:
    no_cites = SYNTHETIC_APPEAL.replace("204.5(h)(3)(viii)", "103.3").replace(
        "204.5(h)(3)(ix)", "103.3"
    )
    assert classify(no_cites, VisaType.EB1A).kind is DecisionKind.NO_CRITERION_ANALYSIS


def test_o1_merits_needs_o1_criteria_not_eb1a_ones() -> None:
    o1 = SYNTHETIC_APPEAL.replace("204.5(h)(3)(viii)", "214.2(o)(3)(iii)(B)(4)").replace(
        "204.5(h)(3)(ix)", "214.2(o)(3)(iii)(B)(7)"
    )
    assert classify(o1, VisaType.O1).kind is DecisionKind.MERITS
    assert classify(SYNTHETIC_APPEAL, VisaType.O1).kind is DecisionKind.NO_CRITERION_ANALYSIS


def test_niw_merits_is_recognised_by_its_own_framework() -> None:
    niw = SYNTHETIC_APPEAL.replace(
        "Under 8 C.F.R. § 204.5(h)(3)(viii) the role and under 8 C.F.R. § 204.5(h)(3)(ix) pay.",
        "Under Matter of Dhanasar, 26 I&N Dec. 884 (AAO 2016), the first prong; Dhanasar's second.",
    )
    assert classify(niw, VisaType.EB2_NIW).kind is DecisionKind.MERITS


def test_stage_two_decision_naming_criteria_in_prose_is_merits() -> None:
    # Real fixture: Director found 3 criteria met; AAO denies on the final merits
    # (Kazarian stage 2). It names criteria in prose and never cites (h)(3)(viii).
    result = classify(_text("SEP172026_06B2203"), VisaType.EB1A)
    assert result.is_merits
    assert result.named_criteria >= 3
    assert result.final_merits_section is True


def test_named_criteria_alone_count_as_criterion_analysis() -> None:
    named = SYNTHETIC_APPEAL.replace(
        "Under 8 C.F.R. § 204.5(h)(3)(viii) the role and under 8 C.F.R. § 204.5(h)(3)(ix) pay.",
        "The published material criterion is not met,"
        " nor is the leading or critical role criterion.",
    )
    assert classify(named, VisaType.EB1A).kind is DecisionKind.MERITS


def test_final_merits_subsection_alone_counts() -> None:
    stage_two = SYNTHETIC_APPEAL.replace(
        "Under 8 C.F.R. § 204.5(h)(3)(viii) the role and under 8 C.F.R. § 204.5(h)(3)(ix) pay.",
        "\nB. Final Merits Determination\n\nThe totality of the record does not show acclaim.",
    )
    assert classify(stage_two, VisaType.EB1A).kind is DecisionKind.MERITS


def test_final_merits_mentioned_only_in_prose_does_not_count() -> None:
    prose = SYNTHETIC_APPEAL.replace(
        "Under 8 C.F.R. § 204.5(h)(3)(viii) the role and under 8 C.F.R. § 204.5(h)(3)(ix) pay.",
        "USCIS then considers the totality in a final merits determination.",
    )
    assert classify(prose, VisaType.EB1A).kind is DecisionKind.NO_CRITERION_ANALYSIS


def test_modern_decision_without_headings_is_unstructured_not_legacy() -> None:
    headless = SYNTHETIC_APPEAL.replace("I. LAW", "Law follows.").replace(
        "II. ANALYSIS", "Analysis follows."
    )
    result = classify(headless, VisaType.EB1A)
    assert result.kind is DecisionKind.UNSTRUCTURED


def test_discussion_marker_still_means_legacy() -> None:
    legacy = "DISCUSSION: The petition was denied.\n" + "filler " * 1200
    assert classify(legacy, VisaType.EB1A).kind is DecisionKind.LEGACY_FORMAT


LAW_BOILERPLATE = (
    "at least three of the ten categories listed at 8 C.F.R. § 204.5(h)(3)(i)-(x) "
    "(including items such as awards, published material in certain media, and "
    "scholarly articles)."
)


def test_criteria_named_only_in_the_law_section_do_not_count() -> None:
    signature_case = (
        "The matter is now before us on appeal.\n\nI. LAW\n\n"
        + LAW_BOILERPLATE
        + "\n\nII. ANALYSIS\n\nThe appeal was not properly signed. "
        + "filler " * 1200
        + "\n\nORDER: The appeal is rejected.\n"
    )
    assert classify(signature_case, VisaType.EB1A).kind is DecisionKind.NO_CRITERION_ANALYSIS


def test_motion_marked_only_in_the_caption_is_a_motion() -> None:
    # Real caption (JUL072026_03B2203): no "before us on motion" phrase anywhere.
    caption = (
        "In Re: 40052479 Date: JULY 7, 2026\n"
        "Motions on Administrative Appeals Office Decision\n"
        "Form I-140, Immigrant Petition for Alien Workers (Extraordinary Ability)\n"
    )
    result = classify(
        caption + SYNTHETIC_APPEAL.replace("now before us on appeal", "pending"), VisaType.EB1A
    )
    assert result.kind is DecisionKind.MOTION


def test_motion_order_line_is_a_backstop() -> None:
    text = SYNTHETIC_APPEAL.replace("now before us on appeal", "pending").replace(
        "ORDER: The appeal is dismissed.", "ORDER: The motion to reopen is dismissed."
    )
    assert classify(text, VisaType.EB1A).kind is DecisionKind.MOTION
