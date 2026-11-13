"""Find the page of a decision PDF that holds a cited quote, for the in-app viewer.

Quotes come from normalised chunk text; page text comes straight from pdftotext, page by page
(pages are separated by form feeds). Whitespace is compared loosely, and if the full quote does
not match (an OCR repair changed a character) its opening words are tried. Too-short quotes are
never guessed.
"""

from __future__ import annotations

import re

from adjudicate.parse.pdf import pdf_to_text

_WS = re.compile(r"\s+")
MIN_CHARS = 24


def _flat(text: str) -> str:
    return _WS.sub(" ", text).strip().lower()


def page_texts(pdf: bytes) -> list[str]:
    pages = pdf_to_text(pdf).split("\f")
    if len(pages) > 1 and not pages[-1].strip():
        pages.pop()  # pdftotext ends every page with a form feed: no empty page after the last
    return [_flat(p) for p in pages]


def quote_page(pdf: bytes, quote: str, pages: list[str] | None = None) -> int | None:
    """1-based page holding `quote`, or None when it cannot be placed with confidence."""
    target = _flat(quote)
    if len(target) < MIN_CHARS:
        return None
    texts = pages if pages is not None else page_texts(pdf)
    for probe in (target, target[:80], target[:48]):
        if len(probe) < MIN_CHARS:
            break
        hits = [i for i, text in enumerate(texts, 1) if probe in text]
        if len(hits) == 1 or (hits and probe == target):
            return hits[0]
    return None
