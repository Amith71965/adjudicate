# Adjudicate: web

The TypeScript half of [Adjudicate](../README.md): the adversarial examiner (`lib/examiner`), the letter reviewers (`lib/letters`), the MCP server (`mcp/`), and the attorney review UI (`app/`, `components/review`, `lib/review`).

Run it from the repository root with `make web` (needs `make up` and `make api`). Tests: `make test-web` for vitest, `make e2e` for the Playwright flow. See the [root README](../README.md) for the full picture.
