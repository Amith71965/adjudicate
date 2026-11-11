# Adjudicate — developer entry points.
# Memory budget (8 GB host): never run `up` + `web-dev` + a video render together.
# Run `make down` before any brag/HyperFrames render.

SHELL := /bin/bash
.DEFAULT_GOAL := help
PY := .venv/bin

.PHONY: help setup up down migrate harvest harvest-stats verify verify-clean verify-py verify-web lint-py type-py test-py test-web lint-web type-web nuke

help: ## list targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

setup: ## create .venv and install python + node deps
	uv sync --frozen
	cd web && npm ci

up: ## start postgres 17 + pgvector (memory-capped) and migrate
	docker compose up -d --wait
	$(PY)/python -m adjudicate.migrate

down: ## stop infra to free RAM (do this before any render)
	docker compose down

migrate: ## apply pending SQL migrations
	$(PY)/python -m adjudicate.migrate

# Phase-1 corpus. Polite: robots Crawl-delay (10 s) between every request; ~2 h first run.
# Idempotent: --target-fetched is a total, so a repeat run discovers and downloads nothing.
harvest: ## harvest modern EB-1A, O-1 and NIW decisions (slow, resumable)
	$(PY)/python -m adjudicate.harvest --topic 19 --max-pages 8 --min-year 2017 --target-fetched 450
	$(PY)/python -m adjudicate.harvest --topic 4 --max-pages 8 --min-year 2017
	$(PY)/python -m adjudicate.harvest --topic 18 --max-pages 1 --min-year 2017 --target-fetched 60

harvest-stats: ## print corpus counts (Phase-1 exit criterion)
	$(PY)/python -m adjudicate.harvest.stats

lint-py:
	$(PY)/ruff check py
	$(PY)/ruff format --check py
type-py:
	$(PY)/mypy
test-py:
	$(PY)/pytest
lint-web:
	cd web && npx eslint .
type-web:
	cd web && npm run -s typecheck
test-web:
	cd web && npx vitest run

verify-py: lint-py type-py test-py
verify-web: lint-web type-web test-web
verify: verify-py verify-web ## full gate: lint, types, tests (python + web)
	@echo "verify: OK"

verify-clean: ## make verify from a fresh clone on an empty DB (dev volume untouched)
	scripts/verify-clean-clone.sh $$(git branch --show-current) $${TMPDIR:-/tmp}/adjudicate-verify

nuke: ## stop infra AND delete the corpus volume (destructive)
	docker compose down -v
