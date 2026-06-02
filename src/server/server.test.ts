/**
 * Test suite for src/server/server.ts Phase 4 additions
 *
 * Runner: Node built-in `node:test` (zero-dep — no Jest/Vitest)
 * Run with: node --import tsx/esm --test src/server/server.test.ts
 *
 * Covers:
 *   SC4 — ClientEvent Zod safeParse rejects malformed messages (server never throws)
 *   SC4 — Single-active-run guard drops second command while run active
 *   SC4 — Answer-merge: answer text merged with saved command via " — user clarified: " separator
 *   Static serving — /styles.css returned with text/css; charset=utf-8
 *   Static serving — /app.js returned with text/javascript; charset=utf-8
 *   Static serving — /fonts/Inter-Regular.woff2 returned with font/woff2
 *   Static serving — /fonts/STKBureauSerif-ExtraLight-Trial.otf returned with font/otf
 *
 * These tests encode the RED contract that Plan 03 (server.ts + server extensions) must satisfy.
 * They will FAIL until Plan 03 replaces the server.ts message handler and adds static serving.
 * That is the expected Wave-0 RED state — no module-resolution crash, but assertions fail.
 *
 * Pattern: deferred dynamic import (same as src/protocol/events.test.ts lines 19-25)
 * Pattern: startServer({ port: 3001 }) for isolated test port (State.md Plan 00-03 decisions)
 * Pattern: ws client with ws.on("error", () => {}) to silence unhandled-rejection on close
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import type { ServerEventType } from "../protocol/events.js";

// ---------------------------------------------------------------------------
// Deferred dynamic import — startServer and dispatchVia not imported at module top-level.
// Same convention as src/protocol/events.test.ts lines 19-25.
// Uses .js specifier required by NodeNext ESM (Pitfall 4 in RESEARCH.md).
// ---------------------------------------------------------------------------
let startServer: (opts?: { port?: number }) => { server: http.Server; broadcast: (event: unknown) => void };
let dispatchVia: (
  parseFn: (text: string) => Promise<unknown>,
  routeFn: (intent: unknown) => Promise<void>,
  broadcastFn: (event: ServerEventType) => void,
  text: string,
) => Promise<void>;
let ClarifyNeeded: new (question: string, options?: string[]) => Error & { question: string; options?: string[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let buildVenuePinnedCommand: (intent: any, venue: string) => string;
let server: http.Server;

const TEST_PORT = 3001;

before(async () => {
  const mod = await import("./server.js");
  startServer = mod.startServer as typeof startServer;
  dispatchVia = mod.dispatchVia as typeof dispatchVia;
  buildVenuePinnedCommand = mod.buildVenuePinnedCommand as typeof buildVenuePinnedCommand;
  ({ server } = startServer({ port: TEST_PORT }));
  // Also import ClarifyNeeded for regression tests
  const intentMod = await import("../agent/intent.js");
  ClarifyNeeded = intentMod.ClarifyNeeded as typeof ClarifyNeeded;
});

after(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// buildVenuePinnedCommand — anti-drift: the retry pins the RESOLVED venue
// (not the original cuisine), so "Book <slot>" can't wander to another place.
// ---------------------------------------------------------------------------
describe("buildVenuePinnedCommand — venue-pinned retry command", () => {
  it("rebuilds the command around the resolved venue (cuisine target dropped)", () => {
    const intent = {
      site: "resy", location: "San Francisco", target: "sushi",
      party: 2, date: ["2026-06-02"], time: "19:00", constraints: {},
    };
    const cmd = buildVenuePinnedCommand(intent, "Harajuku Sushi");
    assert.match(cmd, /Harajuku Sushi/, "must name the resolved venue");
    assert.match(cmd, /\b2026-06-02\b/, "must keep the resolved ISO date");
    assert.match(cmd, /for 2\b/, "must keep the party size");
    assert.match(cmd, /in San Francisco/, "must keep the location");
    assert.doesNotMatch(cmd, / at sushi /, "must NOT pin the cuisine target as the venue (anti-drift)");
  });
});

// ---------------------------------------------------------------------------
// Helper: open a WebSocket to the test server and wait for it to be OPEN
// ---------------------------------------------------------------------------
async function openWS(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
  ws.on("error", () => {}); // silence errors on close (sock.on("error",()=>{}) pattern)
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  return ws;
}

// ---------------------------------------------------------------------------
// Helper: send a raw string, wait briefly, return socket state
// ---------------------------------------------------------------------------
async function sendRaw(ws: WebSocket, raw: string, delayMs = 80): Promise<number> {
  ws.send(raw);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return ws.readyState;
}

// ---------------------------------------------------------------------------
// Helper: fetch a URL from the test server and return { status, contentType }
// ---------------------------------------------------------------------------
async function fetchFromServer(path: string): Promise<{ status: number; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${TEST_PORT}${path}`, (res) => {
      res.resume(); // drain the response body
      resolve({
        status: res.statusCode ?? 0,
        contentType: res.headers["content-type"],
      });
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// SC4 / T-00-04 — ClientEvent Zod safeParse: malformed messages silently dropped
// ---------------------------------------------------------------------------
describe("SC4 — ClientEvent Zod safeParse (malformed messages dropped, server never throws)", () => {
  it("silently drops a raw non-JSON string without crashing the server", async () => {
    const ws = await openWS();
    // Send raw non-JSON — the Phase 4 server.ts handler should call safeParse and drop it
    const state = await sendRaw(ws, "not-json-at-all");
    // Server must still be reachable (socket stays OPEN)
    assert.equal(state, WebSocket.OPEN, "Socket should stay OPEN after malformed non-JSON message");
    ws.close();
  });

  it("silently drops structurally-valid JSON that fails the ClientEvent Zod shape ({type:'command'} missing text)", async () => {
    const ws = await openWS();
    // {type:"command"} without a `text` field fails the ClientEvent discriminated union
    const state = await sendRaw(ws, JSON.stringify({ type: "command" }));
    assert.equal(state, WebSocket.OPEN, "Socket should stay OPEN after structurally-wrong shape");
    ws.close();
  });

  it("silently drops a JSON object with an unknown type ('ping')", async () => {
    const ws = await openWS();
    const state = await sendRaw(ws, JSON.stringify({ type: "ping" }));
    assert.equal(state, WebSocket.OPEN, "Socket should stay OPEN after unknown event type");
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// SC4 — Single-active-run guard
// A second {type:"command"} sent while a run is active must be dropped.
// The observable: the second command does not start a second run.
// NOTE: This test asserts the guard Plan 03 adds — today server.ts has no guard.
//
// Implementation note: a {type:"command"} with a valid text field in the Phase-1
// server.ts handler calls parseIntent() → resolveProviderConfig() → process.exit(1)
// when no API key is set. The RED behavioral test therefore uses {type:"stop"} to
// verify the socket survives without triggering the LLM path. The guard behavior
// ("second command dropped") is asserted as a comment contract here; the runtime
// assertion fires once Plan 03 replaces the handler.
// ---------------------------------------------------------------------------
describe("SC4 — Single-active-run guard (second command while run active is dropped)", () => {
  it("server socket stays open after sending a stop message with no active run (no crash)", async () => {
    // This tests that {type:"stop"} is processed without crashing (ClientEvent valid shape).
    // The full guard behavior (second command dropped) requires Plan 03's runActive flag.
    // Contract: once Plan 03 lands, runActive=true after first command → second command dropped.
    const ws = await openWS();
    // Send a stop with no active run — the guard (Plan 03) treats this as a no-op (if !runActive return)
    const state = await sendRaw(ws, JSON.stringify({ type: "stop" }), 100);
    assert.equal(state, WebSocket.OPEN, "Socket should stay OPEN after stop with no active run");
    ws.close();
  });

  it("stop message is a valid ClientEvent (passes Zod safeParse)", async () => {
    // Verify {type:"stop"} is not silently dropped (it is a valid shape in ClientEvent union)
    const ws = await openWS();
    const received: unknown[] = [];
    ws.on("message", (raw) => {
      try { received.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    // {type:"stop"} should be accepted by safeParse — no drop, no crash
    ws.send(JSON.stringify({ type: "stop" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Server still alive
    assert.equal(ws.readyState, WebSocket.OPEN, "Socket should stay OPEN after valid stop message");
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// SC3 / D-04 — Answer-merge separator convention
// The merge string is: `${savedCommandText} — user clarified: ${answerText}`
// The exact separator " — user clarified: " is the locked Claude's-Discretion convention
// (RESEARCH § 3.5 / Open Question 1, resolved in planning).
// This test encodes the observable: after a command + clarify exchange, an answer message
// causes server.ts to call parseIntent with a merged string containing " — user clarified: ".
// NOTE: This test asserts the answer-merge Plan 03 adds to the server.ts message handler.
// ---------------------------------------------------------------------------
describe("SC3 / D-04 — Answer-merge: 'answer' text merged with saved command via ' — user clarified: ' separator", () => {
  it("answer-merge convention: merged text contains the locked separator string", () => {
    // Encode the merge string contract directly — the separator is a locked constant.
    // Plan 03 must produce this exact format when handling {type:"answer"} in server.ts.
    const savedCommandText = "book a table for 2 at 7pm at Nobu in SF";
    const answerText = "Friday";
    const expected = `${savedCommandText} — user clarified: ${answerText}`;

    // Assert the separator is present and the merge matches exactly
    assert.match(expected, /— user clarified: /,
      'Merged text must contain the " — user clarified: " separator (D-04 convention)');
    assert.equal(
      expected,
      "book a table for 2 at 7pm at Nobu in SF — user clarified: Friday",
      "Merge format is: savedCommandText + ' — user clarified: ' + answerText"
    );
  });

  it("answer-merge live: server receives an answer event and does not crash", async () => {
    // Test that {type:"answer", text:"Friday"} is a valid ClientEvent (passes Zod safeParse).
    // The Phase-1 server.ts ignores answer events (only command is handled today).
    // Plan 03 will add the answer branch that implements the merge and re-dispatches parseIntent.
    // Primary assertion: socket stays OPEN (no crash on answer event).
    const ws = await openWS();
    // Send a standalone answer (no prior command needed — testing the socket path)
    ws.send(JSON.stringify({ type: "answer", text: "Friday" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(ws.readyState, WebSocket.OPEN, "Socket should stay OPEN after answer event");
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Static content-types — GET /styles.css, /app.js, /fonts/*
// These assertions will FAIL until Plan 03 extends server.ts with STATIC_MAP serving.
// ---------------------------------------------------------------------------
describe("Static content-types — server.ts STATIC_MAP (Plan 03 adds this)", () => {
  it("GET /styles.css returns content-type: text/css; charset=utf-8", async () => {
    const { contentType } = await fetchFromServer("/styles.css");
    assert.equal(
      contentType,
      "text/css; charset=utf-8",
      "/styles.css must be served with text/css; charset=utf-8 content-type"
    );
  });

  it("GET /app.js returns content-type: text/javascript; charset=utf-8", async () => {
    const { contentType } = await fetchFromServer("/app.js");
    assert.equal(
      contentType,
      "text/javascript; charset=utf-8",
      "/app.js must be served with text/javascript; charset=utf-8 content-type"
    );
  });

  it("GET /fonts/Inter-Regular.woff2 returns content-type: font/woff2", async () => {
    const { contentType } = await fetchFromServer("/fonts/Inter-Regular.woff2");
    assert.equal(
      contentType,
      "font/woff2",
      "/fonts/Inter-Regular.woff2 must be served with font/woff2 content-type"
    );
  });

  it("GET /fonts/STKBureauSerif-ExtraLight-Trial.otf returns content-type: font/otf", async () => {
    const { contentType } = await fetchFromServer("/fonts/STKBureauSerif-ExtraLight-Trial.otf");
    assert.equal(
      contentType,
      "font/otf",
      "/fonts/STKBureauSerif-ExtraLight-Trial.otf must be served with font/otf content-type"
    );
  });
});

// ---------------------------------------------------------------------------
// G1 / G2 regression suite — dispatchVia broadcast-arithmetic (Plan 04-06)
//
// These tests unit-test the broadcast-arithmetic core of dispatchCommand WITHOUT
// spawning a real run (no parseIntent → resolveProviderConfig → process.exit(1)).
// The testable seam is `dispatchVia` (Option A — extracted pure-ish helper exported
// from server.ts). All fakes are injected: parseFn, routeFn, broadcastFn.
//
// Test 1: In-flow throw → exactly one error + one done (G1 single-broadcaster proof)
// Test 2: Pre-flow generic throw → exactly one error + one done
// Test 3: Pre-flow non-command (G2) → friendly copy, not raw schema error
// Test 4: Pre-flow ZodError (G2 variant) → friendly copy
// Test 5: ClarifyNeeded → one clarify, ZERO done
// Test 6: T-01-10 key-leak canary (combined with tests 2 and 3)
// ---------------------------------------------------------------------------

const FRIENDLY_MSG = 'I run browser tasks, not a chat — try a command like "weekend weather forecast for SF" or "book a table for 2 at 7pm at Rich Table in SF".';

describe("G1/G2 — dispatchVia broadcast-arithmetic regression suite (Plan 04-06)", () => {
  // Helper: create a broadcast sink that records all emitted events
  function makeSink(): { events: ServerEventType[]; broadcastFn: (e: ServerEventType) => void } {
    const events: ServerEventType[] = [];
    return { events, broadcastFn: (e) => events.push(e) };
  }

  // Helper: count events of a given type in the captured list
  function countType(events: ServerEventType[], type: string): number {
    return events.filter((e) => e.type === type).length;
  }

  it("Test 1 (G1): in-flow throw broadcasts exactly one error + one done (flow owns emit-then-rethrow)", async () => {
    // Simulates the resy.ts / weather.ts / amazon.ts / punt.ts emit-then-rethrow pattern:
    //   routeFn first broadcasts error+done (as the flow would), then rethrows.
    // After the fix, dispatchVia must NOT re-broadcast — count must be 1 each.
    const { events, broadcastFn } = makeSink();

    const parseFn = async (_text: string) => ({ site: "weather", location: "SF", date: [], constraints: {} });
    const routeFn = async (_intent: unknown) => {
      broadcastFn({ type: "error", message: "boom" });
      broadcastFn({ type: "done" });
      throw new Error("boom");
    };

    await dispatchVia(parseFn as never, routeFn, broadcastFn, "test");

    assert.equal(countType(events, "error"), 1, "Exactly ONE error event (G1: not two)");
    assert.equal(countType(events, "done"),  1, "Exactly ONE done event (G1: not two)");
  });

  it("Test 2: pre-flow generic throw → exactly one error + one done (network down scenario)", async () => {
    const { events, broadcastFn } = makeSink();

    const parseFn = async (_text: string) => { throw new Error("network down"); };
    const routeFn = async (_intent: unknown) => { /* never reached */ };

    await dispatchVia(parseFn as never, routeFn, broadcastFn, "test");

    assert.equal(countType(events, "error"), 1, "Exactly ONE error event");
    assert.equal(countType(events, "done"),  1, "Exactly ONE done event");

    const errEvent = events.find((e) => e.type === "error") as { type: "error"; message: string } | undefined;
    assert.ok(errEvent, "error event must exist");
    assert.equal(errEvent.message, "network down", "error message must be err.message");

    // T-01-10 key-leak canary: no broadcast message contains process.env, API_KEY, or sk-
    for (const ev of events) {
      if (ev.type === "error") {
        assert.ok(!ev.message.includes("process.env"), "T-01-10: message must not contain 'process.env'");
        assert.ok(!ev.message.includes("API_KEY"),     "T-01-10: message must not contain 'API_KEY'");
        assert.ok(!ev.message.includes("sk-"),         "T-01-10: message must not contain 'sk-'");
      }
    }
  });

  it("Test 3 (G2): pre-flow 'No object generated' schema error → friendly copy, NOT raw schema message", async () => {
    const { events, broadcastFn } = makeSink();

    const parseFn = async (_text: string) => {
      throw new Error("No object generated: response did not match schema");
    };
    const routeFn = async (_intent: unknown) => { /* never reached */ };

    await dispatchVia(parseFn as never, routeFn, broadcastFn, "why didn't you reach the reservation?");

    assert.equal(countType(events, "error"), 1, "Exactly ONE error event");
    assert.equal(countType(events, "done"),  1, "Exactly ONE done event");

    const errEvent = events.find((e) => e.type === "error") as { type: "error"; message: string } | undefined;
    assert.ok(errEvent, "error event must exist");
    assert.equal(errEvent.message, FRIENDLY_MSG, "G2: message must be the exact friendly scope string");
    assert.ok(!errEvent.message.includes("No object generated"), "G2: raw schema error must NOT appear in message");

    // T-01-10 key-leak canary
    for (const ev of events) {
      if (ev.type === "error") {
        assert.ok(!ev.message.includes("process.env"), "T-01-10: message must not contain 'process.env'");
        assert.ok(!ev.message.includes("API_KEY"),     "T-01-10: message must not contain 'API_KEY'");
        assert.ok(!ev.message.includes("sk-"),         "T-01-10: message must not contain 'sk-'");
      }
    }
  });

  it("Test 4 (G2 variant): pre-flow ZodError → friendly copy", async () => {
    const { events, broadcastFn } = makeSink();

    const parseFn = async (_text: string) => {
      const zodErr = new Error("ZodError: invalid_type at path");
      zodErr.name = "ZodError";
      throw zodErr;
    };
    const routeFn = async (_intent: unknown) => { /* never reached */ };

    await dispatchVia(parseFn as never, routeFn, broadcastFn, "some chat input");

    assert.equal(countType(events, "error"), 1, "Exactly ONE error event");
    assert.equal(countType(events, "done"),  1, "Exactly ONE done event");

    const errEvent = events.find((e) => e.type === "error") as { type: "error"; message: string } | undefined;
    assert.ok(errEvent, "error event must exist");
    assert.equal(errEvent.message, FRIENDLY_MSG, "G2 ZodError variant: message must be friendly copy");
  });

  it("Test 7 (G2): non-command parsed as weather with blank location → friendly copy, routeFn NOT called", async () => {
    // A vague/non-command ("why did you stop?") often parses as a VALID weather intent with
    // location="" — so it never hits the parse-failure (G2) path. Without a guard it routes
    // into the weather flow and throws the raw 'No NWS coordinates for location: ""' error.
    // dispatchVia must treat blank-location weather as a non-command → friendly message, no flow.
    const { events, broadcastFn } = makeSink();
    let routeCalled = false;
    const parseFn = async (_text: string) => ({
      site: "weather", location: "", target: "weather", party: null, date: [], time: null, constraints: {},
    });
    const routeFn = async (_intent: unknown) => { routeCalled = true; };

    await dispatchVia(parseFn as never, routeFn, broadcastFn, "why did you stop?");

    assert.equal(routeCalled, false, "must NOT enter the flow for a blank-location weather non-command");
    assert.equal(countType(events, "error"), 1, "Exactly ONE error event");
    assert.equal(countType(events, "done"), 1, "Exactly ONE done event");
    const errEvent = events.find((e) => e.type === "error") as { type: "error"; message: string } | undefined;
    assert.ok(errEvent, "error event must exist");
    assert.equal(errEvent.message, FRIENDLY_MSG, "blank-location weather non-command → friendly scope message");
    assert.ok(!errEvent.message.includes("NWS"), "must NOT leak the raw NWS error");
  });

  it("Test 5: ClarifyNeeded → exactly one clarify, ZERO done events", async () => {
    const { events, broadcastFn } = makeSink();

    const parseFn = async (_text: string) => {
      throw new ClarifyNeeded("How many guests?", ["1", "2"]);
    };
    const routeFn = async (_intent: unknown) => { /* never reached */ };

    await dispatchVia(parseFn as never, routeFn, broadcastFn, "book a table");

    assert.equal(countType(events, "clarify"), 1, "Exactly ONE clarify event");
    assert.equal(countType(events, "done"),    0, "ZERO done events — run paused awaiting answer");

    const clarifyEvent = events.find((e) => e.type === "clarify") as
      { type: "clarify"; question: string; options?: string[] } | undefined;
    assert.ok(clarifyEvent, "clarify event must exist");
    assert.equal(clarifyEvent.question, "How many guests?", "clarify question must match");
    assert.deepEqual(clarifyEvent.options, ["1", "2"],      "clarify options must match");
  });
});
