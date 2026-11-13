"""U2 decision viewer: a cited quote is located on its PDF page, so the in-app viewer can open
there with the words highlighted. (Endpoint tests live in test_api.py with its fixture.)"""

from __future__ import annotations

import re
from pathlib import Path

from adjudicate.api.locate import quote_page
from adjudicate.parse.pdf import pdf_to_text

FIX = Path(__file__).parent / "fixtures" / "decisions"
PDF = (FIX / "SEP152026_01B2203.pdf").read_bytes()
PAGES = pdf_to_text(PDF).split("\f")


def phrase_on(page: int, words: int = 12) -> str:
    """A run of words that really is on 1-based `page` (and long enough to be unique)."""
    tokens = re.sub(r"\s+", " ", PAGES[page - 1]).strip().split(" ")
    mid = len(tokens) // 2
    return " ".join(tokens[mid : mid + words])


def test_a_quote_is_found_on_its_page() -> None:
    assert len(PAGES) >= 3
    assert quote_page(PDF, phrase_on(2)) == 2
    assert quote_page(PDF, phrase_on(3)) == 3


def test_line_breaks_and_spacing_in_the_pdf_do_not_matter() -> None:
    phrase = phrase_on(2)
    assert quote_page(PDF, "  " + phrase.replace(" ", "\n  ", 3) + " ") == 2


def test_a_quote_that_is_not_there_has_no_page() -> None:
    assert quote_page(PDF, "the petitioner is plainly among the most famous jugglers alive") is None


def test_a_too_short_quote_is_not_guessed() -> None:
    assert quote_page(PDF, "the") is None
