#!/usr/bin/env bash
# Phase 9 local full-stack smoke — bounded, no real provider spend.
#
# Starts the real Worker (wrangler dev) with the local D1 (81 chunks / 8060 recipients), a DEV
# auth bypass, and a DUMMY provider key, then captures request/response evidence for the routes
# that don't require a live Sendmode call. The five SMS flows themselves are covered by
# test/phase9.test.ts against a stubbed provider (never the live one).
set -u

LOG=/tmp/dhsc-wrangler-dev.log
rm -f "$LOG"

# Dummy key: no real Sendmode call is made by the endpoints we exercise. Vars are injected into
# the Worker `env` via `--var` (wrangler dev does not lift shell env into `env`).

npx wrangler dev --port 8799 --ip 127.0.0.1 \
  --var SENDMODE_ACCESS_KEY:dummy-local-key \
  --var DEV_AUTH_BYPASS:true >"$LOG" 2>&1 &
WPID=$!

cleanup() {
  kill "$WPID" 2>/dev/null
  # Also kill any child listener that survived (wrangler spawns a child workerd).
  lsof -nP -iTCP:8799 -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null
  wait "$WPID" 2>/dev/null
}
trap cleanup EXIT

# Wait for readiness (up to ~40s).
for i in $(seq 1 80); do
  if grep -q "Ready on http://" "$LOG" 2>/dev/null; then break; fi
  sleep 0.5
done

BASE=http://127.0.0.1:8799

echo "==================== 1. SPA served at / ===================="
curl -s -o /dev/null -w "GET / -> HTTP %{http_code} (%{content_type})\n" "$BASE/"

echo
echo "==================== 2. Auth guard (dev bypass is ARMED for this session) ===================="
# NOTE: this smoke runs `wrangler dev` with `DEV_AUTH_BYPASS:true` so the unauthenticated
# rejection path cannot be exercised here. Deny-by-default (anonymous /api/* -> 401) is proven by
# test/phase5.test.ts. What this section shows is that the guard is wired and routes are reachable.
curl -s -w "\nGET /api/health (dev bypass armed) -> HTTP %{http_code}\n" "$BASE/api/health"

echo
echo "==================== 2b. Public opt-out page at /x (Phase 9.5) ===================="
curl -s -o /dev/null -w "GET /x -> HTTP %{http_code} (%{content_type})\n" "$BASE/x"
curl -s "$BASE/x" | grep -q 'name="number"' && echo 'GET /x contains the opt-out form field "number"' || echo 'WARNING: /x did not contain the form field'

echo
echo "==================== 3. Authenticated reads (dev bypass) ===================="
echo "--- GET /api/health (authenticated) ---"
curl -s -w "\n-> HTTP %{http_code}\n" "$BASE/api/health"

echo "--- GET /api/campaigns?filter=history (empty, live D1) ---"
curl -s -w "\n-> HTTP %{http_code}\n" "$BASE/api/campaigns?filter=history"

echo "--- GET /api/opt-outs (no opt-outs yet) ---"
curl -s -w "\n-> HTTP %{http_code}\n" "$BASE/api/opt-outs"

echo
echo "==================== 4. Flow 9.5 over real HTTP: public opt-out then read counts ===================="
echo "--- POST /api/opt-out (PUBLIC, no identity) ---"
curl -s -w "\n-> HTTP %{http_code}\n" -X POST "$BASE/api/opt-out" \
  -H 'Content-Type: application/json' -d '{"number":"07700900077"}'

echo "--- GET /api/opt-outs (authenticated) — validRecipientCount must be 8059 ---"
curl -s -w "\n-> HTTP %{http_code}\n" "$BASE/api/opt-outs"

echo "--- DELETE /api/opt-outs/+447700900077 (authenticated) ---"
curl -s -w "\n-> HTTP %{http_code}\n" -X DELETE "$BASE/api/opt-outs/+447700900077"

echo "--- GET /api/opt-outs — count back to 8060 ---"
curl -s -w "\n-> HTTP %{http_code}\n" "$BASE/api/opt-outs"

echo
 echo "==================== 5. Access identity header path (note: dev bypass still armed) ===================="
echo "--- GET /api/campaigns?filter=history with Cf-Access-Authenticated-User-Email ---"
curl -s -w "\n-> HTTP %{http_code}\n" "$BASE/api/campaigns?filter=history" \
  -H 'Cf-Access-Authenticated-User-Email: operator@dhsc.uk'

echo
echo "==================== done ===================="
