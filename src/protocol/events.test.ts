/**
 * Test suite for src/protocol/events.ts
 *
 * Runner: Node built-in `node:test` (zero-dep — no Jest/Vitest)
 * Run with: node --import tsx/esm --test src/protocol/events.test.ts
 *
 * Covers:
 *   D-05 backward compatibility — {ok, summary} (no data) still validates
 *   D-05 data-carrying — {ok, summary, data: {...}} validates and data is preserved
 *   D-05 optional — data field absent leaves data undefined
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import type { z } from "zod";

// Deferred dynamic import so the module is read at call-time
// (same pattern as src/config/env.test.ts lines 37-42)
let ServerEvent: { parse: (v: unknown) => unknown };

before(async () => {
  const mod = await import("./events.js");
  ServerEvent = mod.ServerEvent as typeof ServerEvent;
});

// ---------------------------------------------------------------------------
// D-05: result event — backward-compat + data-carrying
// ---------------------------------------------------------------------------
describe("ServerEvent — result member (D-05)", () => {
  it("BACKWARD COMPAT: parses {type:result, ok, summary} without data field", () => {
    const input = { type: "result", ok: true, summary: "task complete" };
    const parsed = ServerEvent.parse(input) as Record<string, unknown>;
    assert.equal(parsed["type"], "result");
    assert.equal(parsed["ok"], true);
    assert.equal(parsed["summary"], "task complete");
    // data is absent (undefined) — backward-compat preserved
    assert.equal(parsed["data"], undefined);
  });

  it("BACKWARD COMPAT: parses {type:result, ok:false, summary} without data field", () => {
    const input = { type: "result", ok: false, summary: "task failed" };
    const parsed = ServerEvent.parse(input) as Record<string, unknown>;
    assert.equal(parsed["type"], "result");
    assert.equal(parsed["ok"], false);
    assert.equal(parsed["summary"], "task failed");
    assert.equal(parsed["data"], undefined);
  });

  it("DATA-CARRYING: parses result with data object and preserves data content", () => {
    const dataPayload = { days: [{ label: "Today", high: 68, low: null, summary: "Sunny" }] };
    const input = { type: "result", ok: true, summary: "weather ok", data: dataPayload };
    const parsed = ServerEvent.parse(input) as Record<string, unknown>;
    assert.equal(parsed["type"], "result");
    assert.equal(parsed["ok"], true);
    assert.deepEqual(parsed["data"], dataPayload);
  });

  it("DATA-CARRYING: data deep-equals the original input data object", () => {
    const dataPayload = { location: "San Francisco, CA", days: [], meta: { version: 1 } };
    const input = { type: "result", ok: true, summary: "x", data: dataPayload };
    const parsed = ServerEvent.parse(input) as Record<string, unknown>;
    assert.deepEqual(parsed["data"], dataPayload);
  });

  it("OPTIONAL: data is undefined when not supplied", () => {
    const input = { type: "result", ok: true, summary: "x" };
    const parsed = ServerEvent.parse(input) as Record<string, unknown>;
    // z.unknown().optional() leaves the key absent (undefined) when not supplied
    assert.equal(parsed["data"], undefined);
  });

  it("DATA-CARRYING: data can be any arbitrary JSON value (string)", () => {
    const input = { type: "result", ok: true, summary: "x", data: "some string value" };
    const parsed = ServerEvent.parse(input) as Record<string, unknown>;
    assert.equal(parsed["data"], "some string value");
  });
});

// ---------------------------------------------------------------------------
// Other members of ServerEvent union remain intact
// ---------------------------------------------------------------------------
describe("ServerEvent — other union members unaffected", () => {
  it("status event still validates", () => {
    const parsed = ServerEvent.parse({ type: "status", step: 1, text: "step 1" }) as Record<string, unknown>;
    assert.equal(parsed["type"], "status");
    assert.equal(parsed["step"], 1);
  });

  it("screenshot event still validates", () => {
    const parsed = ServerEvent.parse({ type: "screenshot", step: 2, jpegBase64: "abc123" }) as Record<string, unknown>;
    assert.equal(parsed["type"], "screenshot");
    assert.equal(parsed["jpegBase64"], "abc123");
  });

  it("done event still validates", () => {
    const parsed = ServerEvent.parse({ type: "done" }) as Record<string, unknown>;
    assert.equal(parsed["type"], "done");
  });

  it("error event still validates", () => {
    const parsed = ServerEvent.parse({ type: "error", message: "boom" }) as Record<string, unknown>;
    assert.equal(parsed["type"], "error");
    assert.equal(parsed["message"], "boom");
  });

  it("clarify event still validates", () => {
    const parsed = ServerEvent.parse({ type: "clarify", question: "Which day?" }) as Record<string, unknown>;
    assert.equal(parsed["type"], "clarify");
    assert.equal(parsed["question"], "Which day?");
  });
});
