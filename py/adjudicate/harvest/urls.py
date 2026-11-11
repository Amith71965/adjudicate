"""Canonical form for decision URLs, so the same PDF is never stored twice."""

from __future__ import annotations

from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

ALLOWED_HOST = "www.uscis.gov"
# Characters left literal in the path. Everything else (space, ( ) , etc.) is
# percent-encoded with upper-case hex, so encoding variants collapse.
_SAFE_PATH = "/-._~"


def canonical_url(href: str, base: str) -> str:
    absolute = urljoin(base, href.strip())
    parts = urlsplit(absolute)
    host = (parts.hostname or "").lower()
    if host != ALLOWED_HOST:
        raise ValueError(f"refusing off-site URL (expected {ALLOWED_HOST}): {absolute}")
    path = quote(unquote(parts.path), safe=_SAFE_PATH)
    return urlunsplit(("https", host, path, "", ""))
