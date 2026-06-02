#!/usr/bin/env bash
# scripts/gauntlet.sh — D-10 cold-clone DX check
#
# Reproduces the reviewer's cold path reproducibly, built on scripts/smoke.sh's helper style:
#   1. Clone the repo into a fresh temp dir (local clone of the curated tree)
#   2. npm install  — includes the Chromium postinstall (playwright install chromium)
#   3. Assert Chromium installed (SC1 — no manual browser step)
#   4. Assert .env.example present + .env NOT tracked (SC2a)
#   5. cp .env.example .env
#   6. Dummy-key boot → HTTP 200 on localhost:PORT (SC2b, automatable)
#   7. No-key → friendly one-liner, exit non-zero, no stack trace (SC3, automatable)
#   8. Print the temp-clone path and a NEXT: human step banner
#
# Usage:
#   bash scripts/gauntlet.sh                   # clones from the local repo
#   bash scripts/gauntlet.sh https://github.com/owner/browser-control-agent
#                                              # clones from a remote URL
#
# Exit: 0 if all automatable cold-clone checks pass; non-zero if any fail.

set -u

PASS=0
FAIL=0

# Colour helpers (safe even when stdout is not a tty — same as smoke.sh)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

pass()    { echo -e "${GREEN}[PASS]${RESET}    $1"; PASS=$((PASS + 1)); }
fail()    { echo -e "${RED}[FAIL]${RESET}    $1"; FAIL=$((FAIL + 1)); }
section() { echo; echo "--- $1 ---"; }
banner()  { echo; echo -e "${BOLD}${CYAN}$1${RESET}"; }

# ---------------------------------------------------------------------------
# Locate the repo root (script may be called from any cwd)
# ---------------------------------------------------------------------------
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: could not determine repo root from scripts/ directory." >&2
  exit 1
fi

# Clone source: CLI arg overrides the default local clone
CLONE_SRC="${1:-$REPO_ROOT}"
PORT="${PORT:-3000}"

# ---------------------------------------------------------------------------
# Create temp dir + trap: print path on exit, then clean up
# ---------------------------------------------------------------------------
CLONE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gauntlet-clone.XXXXXX")"

# Printed early so the operator can inspect even if a check fails mid-run
echo
echo -e "${YELLOW}Temp clone path:${RESET} $CLONE_DIR"
echo "(Preserved until this shell exits — the live-run step uses it)"

cleanup() {
  echo
  echo "Cleaning up temp clone: $CLONE_DIR"
  rm -rf "$CLONE_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# GC-0: Clone
# ---------------------------------------------------------------------------
section "GC-0: Clone the curated repo into a fresh temp dir"

echo "  Cloning: $CLONE_SRC"
echo "  Into:    $CLONE_DIR"
echo

# Use git clone; if cloning a local path the working-tree content is identical
# to what a reviewer gets from GitHub (the curated file set + pinned manifest).
if git clone "$CLONE_SRC" "$CLONE_DIR" 2>&1; then
  pass "GC-0: Clone succeeded"
else
  fail "GC-0: Clone failed — cannot proceed"
  echo
  echo "Result: FAIL (clone failed; remaining checks skipped)"
  exit 1
fi

# ---------------------------------------------------------------------------
# GC-1 (SC1): npm install includes Chromium postinstall
# ---------------------------------------------------------------------------
section "GC-1 (SC1): npm install — including Chromium postinstall"

echo "  Running: npm install (inside $CLONE_DIR)"
echo "  (The Chromium download may take a few minutes — this is the point.)"
echo

if (cd "$CLONE_DIR" && npm install 2>&1); then
  pass "GC-1: npm install completed"
else
  fail "GC-1: npm install failed"
  echo
  echo "Result: FAIL"
  exit 1
fi

# Verify Chromium was installed by the postinstall — reuse smoke.sh SC1 check
echo
echo "  Checking Chromium presence via playwright install --list ..."
if (cd "$CLONE_DIR" && npx playwright install --list 2>/dev/null | grep -qi chromium); then
  pass "GC-1: Chromium browser found in playwright install --list (no manual browser step needed)"
else
  echo "  INFO: Chromium not listed — the CDN download may have been blocked by the environment."
  echo "  Manual fallback: npx playwright install chromium"
  fail "GC-1: Chromium not confirmed (CDN-blocked environment? run: npx playwright install chromium)"
fi

# ---------------------------------------------------------------------------
# GC-2a (SC2a): .env.example committed; .env NOT tracked
# ---------------------------------------------------------------------------
section "GC-2a (SC2a): .env.example present in clone; .env NOT git-tracked"

if [ -f "$CLONE_DIR/.env.example" ]; then
  pass "GC-2a: .env.example is present in the fresh clone"
else
  fail "GC-2a: .env.example is NOT present — README setup step 3 (cp .env.example .env) will break"
fi

if git -C "$CLONE_DIR" ls-files --error-unmatch .env >/dev/null 2>&1; then
  fail "GC-2a: .env IS tracked in the clone — secret hygiene violation!"
else
  pass "GC-2a: .env is NOT tracked in the clone (correct — .gitignore covers it)"
fi

# Copy .env.example → .env in the clone (mirroring README step 3)
cp "$CLONE_DIR/.env.example" "$CLONE_DIR/.env"
echo "  Copied .env.example → .env (a dummy key will be injected for the boot checks below)"

# ---------------------------------------------------------------------------
# GC-2b (SC2b): Dummy-key boot → HTTP 200
# ---------------------------------------------------------------------------
section "GC-2b (SC2b): Dummy-key boot — npm start should serve HTTP 200 on localhost:${PORT}"

# Set a syntactically valid but fake Anthropic key so the app starts without
# exiting on the missing-key guard, then probe the HTTP server.
ANTHROPIC_API_KEY="sk-ant-dummy-not-a-real-key" npm --prefix "$CLONE_DIR" start &
SERVER_PID=$!
sleep 4

if curl -fsS "http://localhost:${PORT}" >/dev/null 2>&1; then
  pass "GC-2b: Server responded HTTP 200 on localhost:${PORT} (dummy key, fresh clone)"
else
  fail "GC-2b: Server did not respond on localhost:${PORT} — wrong port or startup error?"
fi

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

# ---------------------------------------------------------------------------
# GC-3 (SC3): No-key → friendly one-liner, exit non-zero, no stack trace
# ---------------------------------------------------------------------------
section "GC-3 (SC3): Missing key → friendly one-line fix printed, exits non-zero, no stack trace"

# Remove any key from the .env so the guard fires; capture output + exit code.
(grep -v "API_KEY" "$CLONE_DIR/.env.example" > "$CLONE_DIR/.env") 2>/dev/null || true

SC3_OUT=$(cd "$CLONE_DIR" && ANTHROPIC_API_KEY="" OPENAI_API_KEY="" npm start 2>&1)
SC3_EXIT=$?

if echo "$SC3_OUT" | grep -q "No LLM API key"; then
  if echo "$SC3_OUT" | grep -Eq "at Object\.|at node:internal"; then
    fail "GC-3: Output contains 'No LLM API key' but ALSO contains a stack trace — fix the guard"
  elif [ "$SC3_EXIT" -eq 0 ]; then
    fail "GC-3: Friendly message present but the process exited 0 — guard must exit non-zero"
  else
    pass "GC-3: Missing key → friendly 'No LLM API key' message, exit $SC3_EXIT, no stack trace"
  fi
else
  fail "GC-3: Missing-key output does NOT contain 'No LLM API key' (message wording mismatch)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "=============================="
echo " Gauntlet Summary"
echo "=============================="
echo -e "  ${GREEN}PASS${RESET}: $PASS"
echo -e "  ${RED}FAIL${RESET}: $FAIL"
echo "=============================="
echo

if [ "$FAIL" -gt 0 ]; then
  echo "Result: FAIL ($FAIL automatable cold-clone check(s) failed)"
  echo
  echo "Fix the failing check(s) before running the live flow (Task 2)."
  exit 1
fi

echo "Result: PASS — all automatable cold-clone checks passed."

# ---------------------------------------------------------------------------
# NEXT: Human step banner
# ---------------------------------------------------------------------------
banner "========================================================================"
banner " NEXT: Human live-flow step (Task 2)"
banner "========================================================================"
echo
echo "All automatable checks passed. The temp clone is ready for the live run."
echo
echo -e "  Temp clone: ${YELLOW}$CLONE_DIR${RESET}"
echo
echo "  Steps:"
echo "  1. cd $CLONE_DIR"
echo "  2. Paste your REAL Anthropic OR OpenAI key into .env:"
echo "       ANTHROPIC_API_KEY=sk-ant-..."
echo "     (or OPENAI_API_KEY=sk-...)"
echo "  3. npm start"
echo "  4. Open http://localhost:${PORT} and run a live flow:"
echo "       - weekend weather forecast for SF"
echo "       - book a table for 2 at 7pm at Rich Table in SF"
echo "       - (optional) add a 12oz bag of coffee to cart on Amazon"
echo "  5. Judge as a reviewer: was clone → key → run effortless, following"
echo "     ONLY the README? Any friction = a README setup bug to fix + re-run."
echo
echo "NOTE: The temp clone will be deleted when this shell exits."
echo "      Open a NEW terminal and cd into the path above for the live run."
echo

# Disable the EXIT trap so the human can use the temp dir for Task 2
# The operator is responsible for cleaning up after the live run.
trap - EXIT

exit 0
