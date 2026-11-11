# Test fixtures

Synthetic or public-record data only. Every file here is scanned for PII by
`py/tests/test_repo_hygiene.py`; binaries without a text layer are refused.

## Provenance
- `listing/*.html`: captured 2026-11-10 from the public AAO non-precedent index, then passed through `scripts/sanitize_fixture_html.py` (strips `<script>` blocks, Drupal form tokens, and a client-side Google API key). Listing markup is unchanged.
- `robots.txt`: www.uscis.gov/robots.txt, captured 2026-11-10.
