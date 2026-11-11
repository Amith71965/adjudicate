"""Listing-page parsing, category mapping, URL canonicalisation and dedupe.

All inputs are committed fixtures captured from the live index; no network.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from adjudicate.harvest.categories import VisaType, visa_type_for_category
from adjudicate.harvest.listing import (
    ListingEntry,
    dedupe,
    parse_decision_filename,
    parse_listing,
    parse_listing_page,
)
from adjudicate.harvest.urls import canonical_url

FIX = Path(__file__).parent / "fixtures" / "listing"
BASE = "https://www.uscis.gov/administrative-appeals/aao-decisions/aao-non-precedent-decisions"


def _entries(name: str) -> list[ListingEntry]:
    return parse_listing((FIX / name).read_text(), BASE)


class TestParseListing:
    def test_full_category_page_yields_every_row(self) -> None:
        assert len(_entries("eb1a_page0.html")) == 100

    def test_first_row_fields(self) -> None:
        first = _entries("eb1a_page0.html")[0]
        assert first.url == (
            "https://www.uscis.gov/sites/default/files/err/"
            "B2%20-%20Aliens%20with%20Extraordinary%20Ability/"
            "Decisions_Issued_in_2026/SEP172026_01B2203.pdf"
        )
        assert first.decision_id == "SEP172026_01B2203"
        assert first.category == "B2 - Aliens with Extraordinary Ability"
        assert first.visa_type is VisaType.EB1A
        assert first.display_date == date(2026, 9, 17)
        assert first.issued_year == 2026

    def test_page_past_the_end_is_empty_not_an_error(self) -> None:
        assert _entries("eb1a_page_past_end.html") == []

    def test_unfiltered_page_mixes_categories(self) -> None:
        kinds = {e.visa_type for e in _entries("unfiltered_page1.html")}
        assert VisaType.EB1A in kinds
        assert VisaType.OTHER in kinds  # e.g. A6 U-visa adjustment decisions

    def test_rows_without_a_pdf_link_raise_instead_of_vanishing(self) -> None:
        html = '<div class="views-row"><div class="views-item-title"><a href="/x">x</a></div></div>'
        with pytest.raises(ValueError, match="views-row"):
            parse_listing(html, BASE)

    def test_page_with_no_views_rows_and_no_empty_marker_is_rejected(self) -> None:
        # A layout change must fail loudly, not look like "end of results".
        with pytest.raises(ValueError, match="listing"):
            parse_listing("<html><body><p>Access denied</p></body></html>", BASE)


@pytest.mark.parametrize(
    ("category", "expected"),
    [
        ("B2 - Aliens with Extraordinary Ability", VisaType.EB1A),
        ("D8-Aliens-of-Extraordinary-Ability-or-Achievement_O-1_O-2_and_O-3", VisaType.O1),
        (
            "B5 - Members of the Professions holding Advanced Degrees or Aliens of "
            "Exceptional Ability",
            VisaType.EB2_NIW,
        ),
        ("B4 - Multinational Managers and Executives", VisaType.EB1C),
        ("D7-Intracompany-Transferees_L-1A-and-L-1B", VisaType.L1),
        ("B3 - Outstanding Professors and Researchers", VisaType.EB1B),
        ("A6 - Adjustment of Alien in U Nonimmigrant Status", VisaType.OTHER),
        ("Z9 - Something new", VisaType.OTHER),
    ],
)
def test_category_mapping(category: str, expected: VisaType) -> None:
    assert visa_type_for_category(category) is expected


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("SEP152026_01B2203.pdf", ("SEP152026_01B2203", date(2026, 9, 15), 1, "B2203")),
        ("JAN312005_06B2203.pdf", ("JAN312005_06B2203", date(2005, 1, 31), 6, "B2203")),
        ("AUG282024_01D8101.pdf", ("AUG282024_01D8101", date(2024, 8, 28), 1, "D8101")),
    ],
)
def test_decision_filename_parsing(name: str, expected: tuple[str, date, int, str]) -> None:
    parsed = parse_decision_filename(name)
    assert parsed is not None
    assert (parsed.decision_id, parsed.decision_date, parsed.sequence, parsed.code) == expected


@pytest.mark.parametrize("name", ["notes.pdf", "FEB302026_01B2203.pdf", "SEP152026.pdf"])
def test_unparseable_filenames_return_none(name: str) -> None:
    assert parse_decision_filename(name) is None


class TestCanonicalUrl:
    def test_relative_href_becomes_absolute_https(self) -> None:
        assert canonical_url("/sites/a%20b.pdf", BASE) == "https://www.uscis.gov/sites/a%20b.pdf"

    def test_percent_encoding_variants_collapse(self) -> None:
        variants = [
            "/sites/default/files/err/B2 - Aliens/x.pdf",
            "/sites/default/files/err/B2%20-%20Aliens/x.pdf",
            "/sites/default/files/err/B2%20%2D%20Aliens/x.pdf",
            "HTTP://WWW.USCIS.GOV/sites/default/files/err/B2%20-%20Aliens/x.pdf",
        ]
        assert len({canonical_url(v, BASE) for v in variants}) == 1

    def test_query_and_fragment_are_dropped(self) -> None:
        assert canonical_url("/x.pdf?download=1#page=2", BASE) == "https://www.uscis.gov/x.pdf"

    def test_reserved_characters_stay_encoded(self) -> None:
        # Category folder names contain ( ) and , — must round-trip stably.
        a = canonical_url("/err/Sec.%20245%28m%29%281%29%2C/x.pdf", BASE)
        b = canonical_url("/err/Sec. 245(m)(1),/x.pdf", BASE)
        assert a == b

    def test_off_site_urls_are_rejected(self) -> None:
        with pytest.raises(ValueError, match=r"uscis\.gov"):
            canonical_url("https://evil.example.com/x.pdf", BASE)


def test_dedupe_keeps_first_seen_order() -> None:
    entries = _entries("eb1a_page0.html")
    doubled = entries + entries[:10]
    assert dedupe(doubled) == entries


class TestListingPage:
    def test_reports_total_rows_and_next_link(self) -> None:
        page = parse_listing_page((FIX / "eb1a_page0.html").read_text(), BASE)
        assert (len(page.entries), page.total_rows, page.has_next) == (100, 5294, True)

    def test_past_end_page_has_no_next(self) -> None:
        page = parse_listing_page((FIX / "eb1a_page_past_end.html").read_text(), BASE)
        assert (page.entries, page.has_next) == ([], False)

    def test_real_rows_have_no_date_drift(self) -> None:
        assert parse_listing_page((FIX / "eb1a_page0.html").read_text(), BASE).drift == []

    def test_drift_between_display_date_and_filename_is_reported(self) -> None:
        html = (
            (FIX / "eb1a_page0.html")
            .read_text()
            .replace("September 17, 2026", "September 18, 2026", 1)
        )
        drift = parse_listing_page(html, BASE).drift
        assert len(drift) == 1 and "SEP172026_01B2203" in drift[0]
