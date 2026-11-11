"""Strip credential-shaped strings from captured public HTML before committing it.

Public USCIS pages embed a client-side Google API key in <script> tags and
Drupal form tokens in attributes. They are served to every visitor, but they
trip secret scanners and have no value to tests. Listing markup is untouched.

usage: python -I scripts/sanitize_fixture_html.py <file.html>...
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SCRIPT = re.compile(r"<script\b[^>]*>.*?</script>", re.IGNORECASE | re.DOTALL)
TOKEN_ATTRS = re.compile(
    r'(\b(?:data-feedback-token|value)=")(form-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{40,})(")'
)
GOOGLE_KEY = re.compile(r"AIza[0-9A-Za-z_-]{35}")


def sanitize(html: str) -> str:
    html = SCRIPT.sub("<script></script>", html)
    html = TOKEN_ATTRS.sub(r"\1REDACTED\3", html)
    return GOOGLE_KEY.sub("REDACTED", html)


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        path = Path(arg)
        path.write_text(sanitize(path.read_text()))
