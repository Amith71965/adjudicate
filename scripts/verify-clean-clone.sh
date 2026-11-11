#!/usr/bin/env bash
# Prove `make setup && make up && make verify` works from a fresh clone on an EMPTY
# database, without ever touching the dev database volume.
#
# Safety (see _local/INCIDENTS.md, 2026-11-10 near miss):
# - the throwaway compose project is passed explicitly with -p on every command
#   and never exported, so nothing later in the caller's shell can be redirected;
# - the clone goes into a fresh mktemp directory; this script deletes no files.
#
# usage: scripts/verify-clean-clone.sh <branch> <parent-dir-for-temp-clones>
set -euo pipefail

branch=${1:?branch}
parent=${2:?parent dir}
repo=$(git rev-parse --show-toplevel)
throwaway=adjudicatecleancheck
dev_project=$(basename "$repo")

if [[ "$throwaway" == "$dev_project" ]]; then
  echo "refusing: throwaway project name equals the dev project" >&2
  exit 2
fi

mkdir -p "$parent"
clone=$(mktemp -d "$parent/clean.XXXXXX")
git clone -q -b "$branch" "$repo" "$clone"
echo "clone: $clone"

# The DB container name and port are fixed, so stop the dev stack (its volume is kept).
docker compose -p "$dev_project" -f "$repo/compose.yaml" stop

status=0
(
  cd "$clone"
  make setup >"$clone/setup.log" 2>&1
  docker compose -p "$throwaway" up -d --wait
  .venv/bin/python -m adjudicate.migrate
  make verify >"$clone/verify.log" 2>&1
) || status=$?

docker compose -p "$throwaway" -f "$clone/compose.yaml" down -v
docker compose -p "$dev_project" -f "$repo/compose.yaml" up -d --wait
grep -E "passed|failed|Tests |verify:" "$clone/verify.log" || true
echo "clean-clone verify exit: $status"
exit "$status"
