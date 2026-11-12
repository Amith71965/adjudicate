#!/usr/bin/env bash
# Phase-8 browser flow (`make e2e`). The review log is append-only, so the run gets its own
# throwaway review log (schema e2e_<random>, see py/adjudicate/e2e.py): sandbox → API on :8001
# and `next start` on :3100 bound to it → Playwright → stop both and drop the sandbox, always.
# Memory (8 GB host): needs `make up`; never alongside `make web`, `make api` or a video render.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin
LOGS=$(mktemp -d "${TMPDIR:-/tmp}/adjudicate-e2e.XXXXXX")

# A leftover `make api` or `next start` on these ports would answer the health checks with the
# real review log behind it, and the test would sign off and export into it irreversibly.
for port in 8001 3100; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "e2e: port $port is already in use; stop that server first" >&2; exit 1
  fi
done

$PY/python -m adjudicate.migrate >/dev/null # corpus tables at the latest schema
SANDBOX=$($PY/python -m adjudicate.e2e create)
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  $PY/python -m adjudicate.e2e drop "$SANDBOX" && echo "e2e: dropped the review sandbox; logs in $LOGS"
}
trap cleanup EXIT

DATABASE_URL="$SANDBOX" $PY/uvicorn --factory adjudicate.api.app:production_app \
  --host 127.0.0.1 --port 8001 >"$LOGS/api.log" 2>&1 &
pids+=($!)
(cd web && ADJUDICATE_API=http://127.0.0.1:8001 exec node_modules/.bin/next start -H 127.0.0.1 -p 3100) \
  >"$LOGS/web.log" 2>&1 &
pids+=($!)

for url in http://127.0.0.1:8001/health http://127.0.0.1:3100/; do
  for _ in $(seq 1 90); do curl -fs -o /dev/null "$url" 2>/dev/null && break || sleep 1; done
  curl -fsS -o /dev/null "$url" || { echo "e2e: $url never came up (see $LOGS)" >&2; exit 1; }
done

for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null || { echo "e2e: a server exited (see $LOGS)" >&2; exit 1; }; done
schema=$(curl -fs http://127.0.0.1:8001/health | $PY/python -c 'import json,sys; print(json.load(sys.stdin)["review_log_schema"])' || true)
case "$schema" in
  e2e_*) ;;
  *) echo "e2e: the API's review log is in schema '$schema', not a sandbox; refusing to run" >&2; exit 1 ;;
esac

(cd web && E2E_BASE_URL=http://127.0.0.1:3100 npx playwright test)
