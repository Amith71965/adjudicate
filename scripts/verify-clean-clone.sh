#!/usr/bin/env bash
# Prove `make setup && make up && make verify` works from a fresh clone on an EMPTY
# database, without ever touching the dev database or its volume.
#
# Safety (see _local/INCIDENTS.md, 2026-11-10 near miss):
# - the throwaway stack is its own compose project (-p, never exported) on its own
#   port, so the dev stack keeps running and nothing can be redirected to it;
# - the clone goes into a fresh mktemp directory; this script deletes no files;
# - every step is checked explicitly: bash ignores `set -e` inside a subshell whose
#   status is tested, which once let `make verify` run with no database at all.
#
# usage: scripts/verify-clean-clone.sh <branch> <parent-dir-for-temp-clones>
set -euo pipefail

branch=${1:?branch}
parent=${2:?parent dir}
repo=$(git rev-parse --show-toplevel)
throwaway=adjudicatecleancheck
port=54330
url="postgresql://adjudicate:adjudicate@localhost:${port}/adjudicate"

mkdir -p "$parent"
clone=$(mktemp -d "$parent/clean.XXXXXX")
git clone -q -b "$branch" "$repo" "$clone"
echo "clone: $clone"

step() {
  echo "== $*"
  "$@" || { echo "STEP FAILED: $*" >&2; return 1; }
}

run_checks() {
  cd "$clone" || return 1
  step make setup >"$clone/setup.log" 2>&1 || return 1
  step env ADJUDICATE_DB_PORT=$port docker compose -p "$throwaway" up -d --wait || return 1
  step env DATABASE_URL="$url" .venv/bin/python -m adjudicate.migrate || return 1
  step env DATABASE_URL="$url" ADJUDICATE_ALLOW_TEST_DB="localhost:${port}" \
    make verify >"$clone/verify.log" 2>&1 || return 1
}

status=0
run_checks || status=$?

docker compose -p "$throwaway" -f "$clone/compose.yaml" down -v
grep -E "passed|failed|Tests |verify:" "$clone/verify.log" 2>/dev/null || true
echo "clean-clone verify exit: $status"
exit "$status"
