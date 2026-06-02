/**
 * src/agent/flows/punt.test.ts
 *
 * Wave-0 skeleton: two sections.
 *
 * SECTION 1 — Pure-function units (no browser, no LLM)
 *   detectBlock() — pure oracle: block detection ordering invariants,
 *                   implicit-block (no expected content), blockReason/pageTitle priority
 * SECTION 2 — RUN_LIVE-gated live integration block
 *   Skipped unless RUN_LIVE=1. Exercises runPuntFlow() end-to-end.
 *
 * Runner: node --import tsx/esm --test src/agent/flows/punt.test.ts
 *   Offline: only pure oracle units run
 *   Live:    RUN_LIVE=1 node --env-file=.env --import tsx/esm --test src/agent/flows/punt.test.ts
 *
 * Expected offline state (Wave 0): The before() deferred import will throw
 * ERR_MODULE_NOT_FOUND because ./punt.js does not exist until Wave 2 creates punt.ts.
 * This is identical to how weather.test.ts started in Phase 1. Section 1 cases
 * will be cancelled (not failed) and Section 2 is skipped offline — correct RED state.
 *
 * Key contracts encoded here:
 *   - detectBlock oracle: a CONFIRMED block page (isBlockPage:true) → isBlocked:true; absence of
 *     expected content alone (a consent/region gate) is NOT a bot-block → isBlocked:false (honest-label fix)
 *   - blockReason priority: use blockReason when present, fall back to pageTitle
 *   - punt is a SUCCESS outcome (result.ok:false + done), NOT an error event
 *   - Criterion 2: result.ok===false, summary.length>0, screenshot+done, NO error event
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerEventType } from "../../protocol/events.js";

const isLive = !!process.env.RUN_LIVE;

// ---------------------------------------------------------------------------
// PuntVerificationType — matches the Zod schema in punt.ts (wave 2)
// Defined inline here so oracle tests can run without punt.js importing.
// ---------------------------------------------------------------------------
interface PuntVerificationType {
  isBlockPage: boolean;
  blockReason: string;
  pageTitle: string;
  hasExpectedContent: boolean;
}

// ---------------------------------------------------------------------------
// Deferred dynamic import — ./punt.js does not exist until Wave 2.
// Oracle tests will fail/cancel with ERR_MODULE_NOT_FOUND until then.
// That is the expected RED state (identical to how weather.test.ts started in Phase 1).
// ---------------------------------------------------------------------------
let detectBlock: (
  result: PuntVerificationType,
) => { isBlocked: boolean; reason: string };

let resolvePuntUrl: (target: string) => string;

let runPuntFlow: (
  intent: { site: string; target: string; location: string; party: null; date: string[]; time: null; constraints: Record<string, unknown> },
  emit: (event: ServerEventType) => void,
) => Promise<void>;

before(async () => {
  // NOTE: This import will fail with ERR_MODULE_NOT_FOUND until Wave 2 creates punt.ts.
  // That is the expected RED state for Wave-0 skeletons.
  const mod = await import("./punt.js");
  detectBlock = mod.detectBlock;
  resolvePuntUrl = mod.resolvePuntUrl;
  runPuntFlow = mod.runPuntFlow;
});

// ---------------------------------------------------------------------------
// SECTION 1: detectBlock() — SC-2 oracle (pure function)
// No browser, no LLM. Run on every commit (once punt.ts exists in Wave 2).
// ---------------------------------------------------------------------------
describe("detectBlock() — SC-2 oracle (pure function)", () => {

  it("SC-2a: returns isBlocked:true when isBlockPage:true", () => {
    const result: PuntVerificationType = {
      isBlockPage: true,
      blockReason: "Access to this page has been denied",
      pageTitle: "Access Denied",
      hasExpectedContent: false,
    };
    const out = detectBlock(result);
    assert.equal(out.isBlocked, true, "must detect block when isBlockPage:true");
    assert.ok(out.reason.length > 0, "reason must be non-empty");
  });

  it("SC-2a (variant): a benign no-content gate (no block flag) is NOT a bot-block", () => {
    // Honest-label fix: absence of expected content alone is NOT a confirmed bot-wall.
    // A page can be empty because a cookie-consent or region gate hides the content.
    // Treating that as "Blocked" was a false positive; only isBlockPage counts.
    const result: PuntVerificationType = {
      isBlockPage: false,
      blockReason: "",
      pageTitle: "StreetEasy",
      hasExpectedContent: false,  // no listings, but NOT a confirmed bot-detection page
    };
    const out = detectBlock(result);
    assert.equal(out.isBlocked, false, "no-content-but-not-a-block-page is not a confirmed block");
    assert.equal(out.reason, "", "no block reason when not a confirmed block");
  });

  it("honest-label: a cookie-consent wall is NOT reported as a bot-block", () => {
    // Reproduces the Google Flights false positive: the consent interstitial hides
    // content (hasExpectedContent:false) and the LLM may even put the consent text in
    // blockReason — but it is NOT a bot-wall, so detectBlock must return isBlocked:false.
    const result: PuntVerificationType = {
      isBlockPage: false,
      blockReason: "Before you continue to Google — we use cookies and data to…",
      pageTitle: "Before you continue",
      hasExpectedContent: false,
    };
    const out = detectBlock(result);
    assert.equal(out.isBlocked, false, "a consent gate is benign, not a confirmed bot-block");
  });

  it("SC-2b: returns isBlocked:false when page has expected content and is not a block page", () => {
    const result: PuntVerificationType = {
      isBlockPage: false,
      blockReason: "",
      pageTitle: "Apartments for Rent in NYC",
      hasExpectedContent: true,
    };
    const out = detectBlock(result);
    assert.equal(out.isBlocked, false, "must not report block for a normal page");
    assert.equal(out.reason, "", "reason must be empty for non-block");
  });

  it("uses blockReason when available, falls back to pageTitle", () => {
    const withReason: PuntVerificationType = {
      isBlockPage: true,
      blockReason: "HUMAN Security detected bot",
      pageTitle: "Access Denied",
      hasExpectedContent: false,
    };
    const out = detectBlock(withReason);
    assert.ok(out.reason.includes("HUMAN Security"), "reason must use blockReason when present");
  });

});

// ---------------------------------------------------------------------------
// resolvePuntUrl() — pure helper (CR-01 fail-closed contract)
// No browser, no LLM. site name → URL, throws descriptively for unknown sites.
// ---------------------------------------------------------------------------
describe("resolvePuntUrl() — fail-closed resolution (CR-01)", () => {

  it("resolves a known site (exact match)", () => {
    assert.equal(resolvePuntUrl("streeteasy"), "https://www.streeteasy.com/for-rent/nyc");
  });

  it("resolves via first-two-words tolerance ('Google Flights SF' → google flights)", () => {
    assert.equal(resolvePuntUrl("Google Flights SF"), "https://www.google.com/flights");
  });

  it("normalizes case and surrounding whitespace before lookup", () => {
    assert.equal(resolvePuntUrl("  KAYAK  "), "https://www.kayak.com");
  });

  it("throws fail-closed for an ordinary unknown site", () => {
    assert.throws(() => resolvePuntUrl("nordstrom"), /No punt URL for site/);
  });

  // CR-01: Object.prototype key names must NOT fail open. With a plain-object
  // map, resolvePuntUrl("constructor") returned Object.prototype.constructor
  // (a truthy Function) and skipped the throw, sending a non-string to
  // page.goto(). Each of these must now hit the descriptive fail-closed error.
  for (const protoKey of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
    it(`CR-01: fail-closes on prototype key name "${protoKey}"`, () => {
      assert.throws(
        () => resolvePuntUrl(protoKey),
        /No punt URL for site/,
        `"${protoKey}" must throw the fail-closed error, not return an inherited member`,
      );
    });
  }

});

// ---------------------------------------------------------------------------
// SECTION 2: RUN_LIVE-gated live integration block
// Skipped unless RUN_LIVE=1. Wave 2 (punt.ts) + Wave 4 (server.ts wiring) flip this green.
//
// Run with:
//   RUN_LIVE=1 node --env-file=.env --import tsx/esm --test src/agent/flows/punt.test.ts
//
// Contract: punt is a SUCCESS outcome — result.ok:false + done + screenshot, NOT error + done.
// A detected block is expected, clean, and reported honestly. Only throws/Stagehand crashes
// reach the catch block that emits error (RESEARCH Pitfall 6).
// ---------------------------------------------------------------------------
describe("runPuntFlow() — live integration (Criterion 2)", { skip: !isLive }, () => {
  it("Criterion 2: detects block, emits result.ok=false with reason, screenshot, and done — no error event", async () => {
    const events: ServerEventType[] = [];
    const emit = (e: ServerEventType) => events.push(e);
    const intent = {
      site: "punt",
      target: "streeteasy",
      location: "",
      party: null as null,
      date: [] as string[],
      time: null as null,
      constraints: {} as Record<string, unknown>,
    };

    await runPuntFlow(intent, emit);

    // screenshot event with valid JPEG magic bytes
    const screenshotEvent = events.find(e => e.type === "screenshot");
    assert.ok(screenshotEvent, "screenshot event must be emitted");
    const jpegBase64 = (screenshotEvent as { type: string; jpegBase64: string }).jpegBase64;
    const magicHex = Buffer.from(jpegBase64, "base64").subarray(0, 2).toString("hex");
    assert.equal(magicHex, "ffd8", "screenshot must start with JPEG magic bytes FF D8");

    // result.ok === false with a non-empty summary (the block reason)
    const resultEvent = events.find(e => e.type === "result") as { ok: boolean; summary: string } | undefined;
    assert.ok(resultEvent, "result event must be emitted");
    assert.equal(resultEvent!.ok, false, "result.ok must be false for a punt");
    assert.ok(resultEvent!.summary.length > 0, "result.summary must contain the block reason");

    // NO error event — block is not a crash (Criterion 2: punt = success outcome)
    assert.ok(!events.find(e => e.type === "error"), "no error event — block is a clean outcome");

    // done event
    assert.ok(events.find(e => e.type === "done"), "done event must be emitted");

    // Save live proof screenshot
    const allScreenshots = events.filter(e => e.type === "screenshot");
    const lastShot = allScreenshots[allScreenshots.length - 1] as
      | { type: string; jpegBase64: string } | undefined;
    if (lastShot?.jpegBase64) {
      const proofPath = join(
        import.meta.dirname,
        "../../../live-proof/punt-live-proof.jpg",
      );
      await writeFile(proofPath, Buffer.from(lastShot.jpegBase64, "base64"));
      console.log(`[live-proof] screenshot saved → ${proofPath}`);
    }
  });
});
