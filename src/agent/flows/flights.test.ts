/**
 * src/agent/flows/flights.test.ts
 *
 * SECTION 1 — Pure-function oracle units (no browser, no LLM): verifyFlightsResult.
 * SECTION 2 — Entry-guard units: runFlightsFlow throws before opening Chromium on
 *             a blank origin/destination (guards run before createStagehand()).
 * SECTION 3 — RUN_LIVE-gated live integration (skipped unless RUN_LIVE=1).
 *
 * Runner: node --import tsx/esm --test src/agent/flows/flights.test.ts
 *   Live: RUN_LIVE=1 node --env-file=.env --import tsx/esm --test src/agent/flows/flights.test.ts
 *
 * Key contracts:
 *   - verifyFlightsResult: ok:true ONLY when hasResults (anti-hallucination).
 *   - ordering: isBlockPage → isNoResults → hasResults → unreadable.
 *   - a confirmed block is a clean ok:false outcome, never a crash.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { ServerEventType } from "../../protocol/events.js";

const isLive = !!process.env.RUN_LIVE;

interface FlightsVerificationType {
  hasResults: boolean;
  isNoResults: boolean;
  isBlockPage: boolean;
  blockReason: string;
  origin: string;
  destination: string;
  topResult: string;
}

type Intent = {
  site: string;
  location: string;
  target: string;
  party: number | null;
  date: string[];
  time: string | null;
  constraints: Record<string, unknown>;
};

function flightsIntent(over: Partial<Intent> = {}): Intent {
  return {
    site: "flights",
    location: "San Francisco",
    target: "New York",
    party: null,
    date: ["2026-06-09"],
    time: null,
    constraints: {},
    ...over,
  };
}

function pageSignals(over: Partial<FlightsVerificationType> = {}): FlightsVerificationType {
  return {
    hasResults: false,
    isNoResults: false,
    isBlockPage: false,
    blockReason: "",
    origin: "San Francisco",
    destination: "New York",
    topResult: "",
    ...over,
  };
}

let verifyFlightsResult: (
  r: FlightsVerificationType,
  intent: Intent,
) => { ok: boolean; summary: string; reason: string };
let runFlightsFlow: (
  intent: Intent,
  emit: (e: ServerEventType) => void,
  isCancelled?: () => boolean,
) => Promise<void>;

before(async () => {
  const mod = await import("./flights.js");
  verifyFlightsResult = mod.verifyFlightsResult;
  runFlightsFlow = mod.runFlightsFlow;
});

// ---------------------------------------------------------------------------
// SECTION 1: verifyFlightsResult oracle
// ---------------------------------------------------------------------------
describe("verifyFlightsResult() — oracle (pure function)", () => {
  it("ok:true ONLY when hasResults is true (the single success path)", () => {
    const out = verifyFlightsResult(
      pageSignals({ hasResults: true, topResult: "United, $245, 11h 30m, 1 stop" }),
      flightsIntent(),
    );
    assert.equal(out.ok, true, "results shown → ok");
    assert.ok(out.summary.includes("United"), "summary surfaces the top result");
    assert.ok(out.summary.includes("San Francisco → New York"), "summary names the route");
  });

  it("no-results → clean ok:false (graceful, never a crash)", () => {
    const out = verifyFlightsResult(pageSignals({ isNoResults: true }), flightsIntent());
    assert.equal(out.ok, false);
    assert.equal(out.reason, "no-results");
    assert.ok(out.summary.toLowerCase().includes("no flights"));
  });

  it("confirmed block → ok:false 'Blocked' (honest)", () => {
    const out = verifyFlightsResult(
      pageSignals({ isBlockPage: true, blockReason: "unusual traffic detected" }),
      flightsIntent(),
    );
    assert.equal(out.ok, false);
    assert.equal(out.reason, "blocked");
    assert.ok(out.summary.startsWith("Blocked:"));
  });

  it("ordering: a block page never reports success even if hasResults is also true", () => {
    const out = verifyFlightsResult(
      pageSignals({ isBlockPage: true, hasResults: true }),
      flightsIntent(),
    );
    assert.equal(out.ok, false, "block beats results");
    assert.equal(out.reason, "blocked");
  });

  it("reached the page but no readable results → honest ok:false (no fabricated success)", () => {
    const out = verifyFlightsResult(pageSignals({}), flightsIntent());
    assert.equal(out.ok, false);
    assert.equal(out.reason, "no-results-read");
  });
});

// ---------------------------------------------------------------------------
// SECTION 2: entry guards — throw before opening Chromium (no browser needed)
// ---------------------------------------------------------------------------
describe("runFlightsFlow() — entry guards (fail before Chromium opens)", () => {
  it("throws when origin (intent.location) is blank", async () => {
    await assert.rejects(
      () => runFlightsFlow(flightsIntent({ location: "  " }), () => {}),
      /origin/,
      "blank origin must throw a clear error before any browser launch",
    );
  });

  it("throws when destination (intent.target) is blank", async () => {
    await assert.rejects(
      () => runFlightsFlow(flightsIntent({ target: "" }), () => {}),
      /destination/,
      "blank destination must throw a clear error before any browser launch",
    );
  });
});

// ---------------------------------------------------------------------------
// SECTION 3: RUN_LIVE-gated live integration
// Run with:
//   RUN_LIVE=1 node --env-file=.env --import tsx/esm --test src/agent/flows/flights.test.ts
// ---------------------------------------------------------------------------
describe("runFlightsFlow() — live integration", { skip: !isLive }, () => {
  it("drives Google Flights and ends with a result + done (results or an honest outcome)", async () => {
    const events: ServerEventType[] = [];
    await runFlightsFlow(flightsIntent(), (e) => events.push(e));

    const result = events.find((e) => e.type === "result") as
      | { ok: boolean; summary: string }
      | undefined;
    assert.ok(result, "a result event must be emitted");
    assert.ok(result!.summary.length > 0, "result.summary must be non-empty");
    assert.ok(events.find((e) => e.type === "done"), "done event must be emitted");
  });
});
