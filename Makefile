# Adjudicate — developer entry points.
# Memory budget (8 GB host): never run `up` + `web-dev` + a video render together.
# Run `make down` before any brag/HyperFrames render.

SHELL := /bin/bash
.DEFAULT_GOAL := help
PY := .venv/bin
export DATABASE_URL ?= postgresql://adjudicate:adjudicate@localhost:54329/adjudicate

.PHONY: help setup up down migrate verify verify-py verify-web lint-py type-py test-py test-web lint-web type-web nuke

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

nuke: ## stop infra AND delete the corpus volume (destructive)
	docker compose down -v
