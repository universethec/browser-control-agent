/**
 * src/agent/loop.test.ts
 *
 * Wave-0 RED skeleton: guard tests for loop.ts (built in plan 01-03).
 *
 * This file imports ./loop.js which does NOT exist yet — it is built in plan 01-03.
 * These tests will fail/error with ERR_MODULE_NOT_FOUND until that plan runs.
 * That is expected. The skeletons encode the guard contracts plan 01-03 must satisfy.
 *
 * Runner: node --import tsx/esm --test src/agent/loop.test.ts
 *
 * Pure guard tests — no browser, no LLM:
 *   - maxSteps: 0 → result.ok === false, summary matches /Max steps/
 *   - timeoutMs: 0 (immediate) → result.ok === false, summary matches /Timeout/
 *   - flow.decide always returns same action → ok:false matching /identical/ after 3 identical
 *
 * Uses fakeStagehand and fakeFlow stubs — no Chromium needed.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { ServerEventType } from "../protocol/events.js";

// ---------------------------------------------------------------------------
// Fake stubs — no real browser, no real LLM
// ---------------------------------------------------------------------------

// fakeStagehand: minimal Stagehand-compatible stub
// observe returns [], act returns {}, context.pages()[0].screenshot returns a tiny JPEG buffer
const fakeStagehand = {
  observe: async (_instruction: string) => [],
  act: async (_instruction: string) => ({ success: true }),
  extract: async <T>(_instruction: string, _schema: T) => ({}),
  context: {
    pages: () => [
      {
        screenshot: async (_opts?: unknown) => Buffer.from([0xff, 0xd8, 0x00, 0x00]),
        goto: async (_url: string, _opts?: unknown) => null,
      },
    ],
  },
  close: async () => {},
  init: async () => {},
} as unknown as import("@browserbasehq/stagehand").Stagehand;

// fakeFlow: a flow whose decide always returns the same action (used for 3-identical guard test)
const SAME_ACTION = { type: "act" as const, narration: "doing the same thing", instruction: "click button" };

const fakeFlow = {
  observeInstruction: "find elements on the page",
  decide: (_candidates: unknown[], _step: number) => SAME_ACTION,
  doExtract: async (_sh: unknown) => ({ ok: true }),
  verify: (_raw: unknown) => ({ ok: true, summary: "verified", reason: "" }),
};

// A flow that returns a unique action each step (to avoid triggering the 3-identical guard)
const progressingFlow = {
  observeInstruction: "find elements on the page",
  decide: (_candidates: unknown[], step: number) => ({
    type: "act" as const,
    narration: `action step ${step}`,
    instruction: `click button ${step}`,
  }),
  doExtract: async (_sh: unknown) => ({ ok: true }),
  verify: (_raw: unknown) => ({ ok: true, summary: "verified", reason: "" }),
};

// A flow whose verify() returns a clarify verdict on its first extract step —
// exercises the offer-and-pause path (loop emits clarify, NO result, NO done).
const clarifyingFlow = {
  observeInstruction: "find elements on the page",
  decide: (_candidates: unknown[], _step: number) => ({
    type: "extract" as const,
    narration: "extracting to verify",
  }),
  doExtract: async (_sh: unknown) => ({ availableSlots: ["6:45 PM"] }),
  verify: (_raw: unknown) => ({
    ok: false,
    summary: "",
    reason: "offered-alternative",
    clarify: { question: "No 7:00 PM. Next available: 6:45 PM.", options: ["Book 6:45 PM", "No"] },
  }),
};

// Deferred dynamic import — ./loop.js does not exist until plan 01-03
// This will throw ERR_MODULE_NOT_FOUND until loop.ts is created.
// That is the expected RED state.
let runLoop: (
  sh: import("@browserbasehq/stagehand").Stagehand,
  flow: {
    observeInstruction: string;
    decide: (candidates: unknown[], step: number) => { type: "extract" | "act"; narration: string; instruction?: string };
    doExtract: (sh: unknown) => Promise<unknown>;
    verify: (raw: unknown) => { ok: boolean; summary: string; reason: string; nonTerminal?: boolean; clarify?: { question: string; options?: string[] } };
  },
  config: {
    maxSteps: number;
    timeoutMs: number;
    maxIdentical: number;
    emit: (event: ServerEventType) => void;
    isCancelled?: () => boolean;
  }
) => Promise<{ ok: boolean; summary: string; data?: unknown }>;

before(async () => {
  // NOTE: This import will fail with ERR_MODULE_NOT_FOUND until plan 01-03 creates loop.ts.
  // That is the expected RED state for Wave-0 skeletons.
  const mod = await import("./loop.js");
  runLoop = mod.runLoop;
});

// ---------------------------------------------------------------------------
// Guard tests — pure logic, no browser
// ---------------------------------------------------------------------------
describe("runLoop() — guards", () => {
  it("returns ok:false with /Max steps/ summary when maxSteps is 0", async () => {
    const events: ServerEventType[] = [];
    const result = await runLoop(
      fakeStagehand,
      progressingFlow,
      {
        maxSteps: 0,
        timeoutMs: 60_000,
        maxIdentical: 3,
        emit: (e) => events.push(e),
      }
    );
    assert.equal(result.ok, false, "ok must be false when maxSteps is 0");
    assert.match(result.summary, /Max steps/i, "summary must match /Max steps/");
  });

  it("returns ok:false with /Timeout/ summary when timeoutMs is 0 (immediate)", async () => {
    const events: ServerEventType[] = [];
    const result = await runLoop(
      fakeStagehand,
      progressingFlow,
      {
        maxSteps: 25,
        timeoutMs: 0,
        maxIdentical: 3,
        emit: (e) => events.push(e),
      }
    );
    assert.equal(result.ok, false, "ok must be false when timeout is 0ms");
    assert.match(result.summary, /Timeout/i, "summary must match /Timeout/");
  });

  it("returns ok:false with /identical/ summary after 3 consecutive identical actions", async () => {
    const events: ServerEventType[] = [];
    // fakeFlow.decide always returns the same action — triggers 3-identical guard
    const result = await runLoop(
      fakeStagehand,
      fakeFlow,
      {
        maxSteps: 25,
        timeoutMs: 60_000,
        maxIdentical: 3,
        emit: (e) => events.push(e),
      }
    );
    assert.equal(result.ok, false, "ok must be false when 3 identical actions detected");
    assert.match(result.summary, /identical/i, "summary must match /identical/");
  });

  it("emits at least one event during execution", async () => {
    const events: ServerEventType[] = [];
    await runLoop(
      fakeStagehand,
      fakeFlow,
      {
        maxSteps: 25,
        timeoutMs: 60_000,
        maxIdentical: 3,
        emit: (e) => events.push(e),
      }
    );
    assert.ok(events.length > 0, "at least one event must be emitted during loop execution");
  });

  // ---------------------------------------------------------------------------
  // Phase 4 cancellation-guard tests (D-02 / Plan 04-02)
  // ---------------------------------------------------------------------------

  it("returns {ok:false, summary:'Stopped'} and emits exactly one done (no result) when isCancelled returns true", async () => {
    const events: ServerEventType[] = [];
    const result = await runLoop(
      fakeStagehand,
      progressingFlow,
      {
        maxSteps: 25,
        timeoutMs: 60_000,
        maxIdentical: 3,
        emit: (e) => events.push(e),
        isCancelled: () => true, // fires immediately on first check
      }
    );
    assert.equal(result.ok, false, "ok must be false on cancellation");
    assert.equal(result.summary, "Stopped", "summary must be exactly 'Stopped'");
    // Cancel guard emits ONLY done — NOT a preceding result event (stop is an interruption, not a task outcome)
    const doneEvents = events.filter((e) => e.type === "done");
    const resultEvents = events.filter((e) => e.type === "result");
    assert.equal(doneEvents.length, 1, "exactly one done event must be emitted on cancellation");
    assert.equal(resultEvents.length, 0, "zero result events must be emitted on cancellation");
  });

  it("behaves exactly as before when isCancelled is undefined (backward-compatible)", async () => {
    const events: ServerEventType[] = [];
    // No isCancelled field — the optional param is absent entirely
    const result = await runLoop(
      fakeStagehand,
      progressingFlow,
      {
        maxSteps: 0,
        timeoutMs: 60_000,
        maxIdentical: 3,
        emit: (e) => events.push(e),
        // isCancelled intentionally absent
      }
    );
    // maxSteps:0 → Guard 3 fires normally, no cancel path involved
    assert.equal(result.ok, false, "ok must be false (maxSteps guard, not cancel)");
    assert.match(result.summary, /Max steps/i, "summary must match /Max steps/ (not Stopped)");
  });

  it("does not exit early when isCancelled returns false", async () => {
    const events: ServerEventType[] = [];
    // isCancelled always returns false — should NOT trigger early exit
    // Use maxSteps:0 so the loop exits via Guard 3 immediately (not cancel guard)
    const result = await runLoop(
      fakeStagehand,
      progressingFlow,
      {
        maxSteps: 0,
        timeoutMs: 60_000,
        maxIdentical: 3,
        emit: (e) => events.push(e),
        isCancelled: () => false,
      }
    );
    // Should exit via maxSteps guard, not cancel guard
    assert.equal(result.ok, false);
    assert.match(result.summary, /Max steps/i, "summary must match /Max steps/ (isCancelled=false does not exit early)");
  });

  // ---------------------------------------------------------------------------
  // Clarify-verdict (next-available-slot offer) — slot-offer feature
  // ---------------------------------------------------------------------------

  it("emits exactly one clarify (no result, no done) when verify returns a clarify verdict", async () => {
    const events: ServerEventType[] = [];
    const result = await runLoop(
      fakeStagehand,
      clarifyingFlow,
      {
        maxSteps: 25,
        timeoutMs: 60_000,
        maxIdentical: 3,
        emit: (e) => events.push(e),
      }
    );
    const clarifyEvents = events.filter((e) => e.type === "clarify");
    const resultEvents = events.filter((e) => e.type === "result");
    const doneEvents = events.filter((e) => e.type === "done");
    assert.equal(clarifyEvents.length, 1, "exactly one clarify event");
    assert.equal(resultEvents.length, 0, "zero result events on a clarify verdict");
    assert.equal(doneEvents.length, 0, "zero done events on a clarify verdict (run pauses for the answer)");
    assert.deepEqual(
      clarifyEvents[0],
      { type: "clarify", question: "No 7:00 PM. Next available: 6:45 PM.", options: ["Book 6:45 PM", "No"] },
      "clarify event must carry the verdict's question + options",
    );
    assert.equal(result.ok, false, "LoopResult.ok is false on a clarify/offer outcome");
  });
});
