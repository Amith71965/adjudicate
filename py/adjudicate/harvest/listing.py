"""Parse one page of the AAO non-precedent decision index.

Every ``views-row`` must yield exactly one decision PDF; a row that doesn't, or
a page that has neither rows nor the explicit "no results" marker, raises. A
silent empty list here would look identical to "end of results" and quietly
truncate the corpus.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

from bs4 import BeautifulSoup, Tag

from adjudicate.harvest.categories import VisaType, visa_type_for_category
from adjudicate.harvest.urls import canonical_url

_FILENAME = re.compile(r"^([A-Z]{3})(\d{2})(\d{4})_(\d{2})([A-Z]\d{4,5})\.pdf$")
_ISSUED_DIR = re.compile(r"^Decisions_Issued_in_(\d{4})$")
_NO_RESULTS_CLASS = "block-msg--no-results"


@dataclass(frozen=True, slots=True)
class DecisionFilename:
    decision_id: str
    decision_date: date
    sequence: int
    code: str


@dataclass(frozen=True, slots=True)
class ListingEntry:
    url: str
    decision_id: str
    category: str
    visa_type: VisaType
    issued_year: int | None
    display_date: date | None
    decision_date: date | None


def parse_decision_filename(name: str) -> DecisionFilename | None:
    """``SEP152026_01B2203.pdf`` → id, date, sequence, code. None if not that shape."""
    match = _FILENAME.match(name)
    if not match:
        return None
    month, day, year, seq, code = match.groups()
    try:
        when = datetime.strptime(f"{month}{day}{year}", "%b%d%Y").date()
    except ValueError:
        return None
    return DecisionFilename(name.removesuffix(".pdf"), when, int(seq), code)


def _parse_display_date(row: Tag) -> date | None:
    cell = row.select_one(".views-field-field-display-date .field-content")
    if cell is None:
        return None
    try:
        return datetime.strptime(cell.get_text(strip=True), "%B %d, %Y").date()
    except ValueError:
        return None


def _entry_from_row(row: Tag, base: str) -> ListingEntry:
    link = row.select_one(".views-item-title a[href]")
    href = str(link["href"]) if link is not None else ""
    if not href.lower().endswith(".pdf"):
        raise ValueError(f"views-row without a decision PDF link: {href or '<none>'}")
    url = canonical_url(href, base)
    segments = PurePosixPath(unquote(urlsplit(url).path)).parts
    try:
        category = segments[segments.index("err") + 1]
    except (ValueError, IndexError) as exc:
        raise ValueError(f"decision URL outside /err/<category>/: {url}") from exc
    issued_year = next((int(m.group(1)) for s in segments if (m := _ISSUED_DIR.match(s))), None)
    filename = parse_decision_filename(segments[-1])
    return ListingEntry(
        url=url,
        decision_id=segments[-1].removesuffix(".pdf"),
        category=category,
        visa_type=visa_type_for_category(category),
        issued_year=issued_year,
        display_date=_parse_display_date(row),
        decision_date=filename.decision_date if filename else None,
    )


def parse_listing(html: str, base: str) -> list[ListingEntry]:
    soup = BeautifulSoup(html, "html.parser")
    rows = soup.select("div.views-row")
    if not rows:
        if soup.select_one(f".{_NO_RESULTS_CLASS}") is not None:
            return []
        raise ValueError("unrecognised listing page: no views-row and no no-results marker")
    return [_entry_from_row(row, base) for row in rows]


def dedupe(entries: list[ListingEntry]) -> list[ListingEntry]:
    seen: set[str] = set()
    out: list[ListingEntry] = []
    for entry in entries:
        if entry.url not in seen:
            seen.add(entry.url)
            out.append(entry)
    return out
