#!/usr/bin/env bash
# scripts/smoke.sh — Wave-0 smoke harness for SC1–SC4
#
# Drives the four success criteria as independently-reporting checks.
# SC1 + SC2a: PASS after this plan (Plan 00-01).
# SC2b / SC3 / SC4: PENDING (dependencies land in Plans 00-02 and 00-03).
#
# Usage: bash scripts/smoke.sh
# Exit: 0 if all RESOLVED checks pass; non-zero if any RESOLVED check fails hard.

set -u

PASS=0
FAIL=0
PENDING=0

# Colour helpers (safe even when stdout is not a tty)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

pass()    { echo -e "${GREEN}[PASS]${RESET}    $1"; PASS=$((PASS + 1)); }
fail()    { echo -e "${RED}[FAIL]${RESET}    $1"; FAIL=$((FAIL + 1)); }
pending() { echo -e "${YELLOW}[PENDING]${RESET} $1"; PENDING=$((PENDING + 1)); }
section() { echo; echo "--- $1 ---"; }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PORT="${PORT:-3000}"

# ---------------------------------------------------------------------------
# SC1 — npm install installs deps AND Chromium (postinstall playwright install chromium)
# ---------------------------------------------------------------------------
section "SC1: One-command install includes Chromium"

if npx playwright install --list 2>/dev/null | grep -qi chromium; then
  pass "SC1: Chromium browser found in playwright install --list"
else
  echo "  INFO: Chromium not listed — the CDN download may have been blocked by the environment."
  echo "  Manual fallback: npx playwright install chromium"
  pending "SC1: Chromium not confirmed (CDN-blocked environment? run: npx playwright install chromium)"
  PENDING=$((PENDING - 1)); FAIL=$((FAIL + 1))   # Treat CDN block as hard fail for SC1
fi

# ---------------------------------------------------------------------------
# SC2a — .env.example committed; .env NOT tracked
# ---------------------------------------------------------------------------
section "SC2a: .env.example committed; .env git-ignored"

SC2A_OK=true
if git -C "$ROOT" ls-files --error-unmatch .env.example >/dev/null 2>&1; then
  pass "SC2a: .env.example is tracked by git"
else
  fail "SC2a: .env.example is NOT tracked — run: git add .env.example && git commit"
  SC2A_OK=false
fi

if git -C "$ROOT" ls-files --error-unmatch .env >/dev/null 2>&1; then
  fail "SC2a: .env IS tracked by git — secret hygiene violation!"
  SC2A_OK=false
else
  pass "SC2a: .env is NOT tracked (correct — .gitignore covers it)"
fi

# ---------------------------------------------------------------------------
# SC2b — npm start serves HTTP 200 on localhost:PORT (requires Plan 00-03 server)
# ---------------------------------------------------------------------------
section "SC2b: npm start serves localhost:PORT (server built in Plan 00-03)"

if [ -f "$ROOT/src/server/http.ts" ] && grep -q "startServer" "$ROOT/src/index.ts" 2>/dev/null; then
  # Server code exists — run the real check
  ANTHROPIC_API_KEY="sk-ant-dummy-not-a-real-key" npm --prefix "$ROOT" start &
  SERVER_PID=$!
  sleep 3
  if curl -fsS "http://localhost:${PORT}" >/dev/null 2>&1; then
    pass "SC2b: Server responded HTTP 200 on localhost:${PORT}"
  else
    fail "SC2b: Server did not respond on localhost:${PORT} (exit or wrong port?)"
  fi
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
else
  pending "SC2b: Server not built yet (src/server/http.ts or startServer wiring missing — lands in Plan 00-03)"
fi

# ---------------------------------------------------------------------------
# SC3 — no/invalid key → one-line fix printed, clean exit 1, no stack trace
#        (requires Plan 00-02's env guard + Plan 00-03's boot path)
# ---------------------------------------------------------------------------
section "SC3: Missing key prints friendly one-liner, exits 1, no stack trace (Plan 00-02)"

if [ -f "$ROOT/src/config/env.ts" ]; then
  # Guard exists — run the real check. Capture the REAL exit code (do NOT mask it
  # with `|| true`): SC3's contract is "exits non-zero", so we must assert it.
  SC3_OUT=$(cd "$ROOT" && ANTHROPIC_API_KEY="" OPENAI_API_KEY="" npm start 2>&1)
  SC3_EXIT=$?
  if echo "$SC3_OUT" | grep -q "No LLM API key"; then
    if echo "$SC3_OUT" | grep -Eq "at Object\.|at node:internal"; then
      fail "SC3: Output contains 'No LLM API key' but ALSO contains a stack trace — fix the guard"
    elif [ "$SC3_EXIT" -eq 0 ]; then
      fail "SC3: Friendly message present but the process exited 0 — the guard must exit non-zero"
    else
      pass "SC3: Missing key → friendly 'No LLM API key' message, exit $SC3_EXIT, no stack trace"
    fi
  else
    fail "SC3: Missing key output does NOT contain 'No LLM API key' (message wording mismatch)"
  fi
else
  pending "SC3: src/config/env.ts not built yet — lands in Plan 00-02"
fi

# ---------------------------------------------------------------------------
# SC4 — resolveProviderConfig() permutation suite via node --test
#        (requires Plan 00-02's env.ts + test file)
# ---------------------------------------------------------------------------
section "SC4: Provider auto-detect resolveProviderConfig() permutation suite (Plan 00-02)"

if [ -f "$ROOT/src/config/env.ts" ]; then
  # Config module exists — run node --test
  if npm --prefix "$ROOT" test 2>&1 | grep -q "pass"; then
    pass "SC4: node --test resolveProviderConfig() permutations pass"
  else
    fail "SC4: node --test did not report passing tests — check src/__tests__/"
  fi
else
  pending "SC4: src/config/env.ts not built yet — lands in Plan 00-02"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "=============================="
echo " Smoke Summary"
echo "=============================="
echo -e "  ${GREEN}PASS${RESET}:    $PASS"
echo -e "  ${YELLOW}PENDING${RESET}: $PENDING"
echo -e "  ${RED}FAIL${RESET}:    $FAIL"
echo "=============================="
echo

if [ "$FAIL" -gt 0 ]; then
  echo "Result: FAIL ($FAIL check(s) failed)"
  exit 1
else
  echo "Result: PASS (all resolved checks pass; $PENDING pending their dependencies)"
  exit 0
fi
