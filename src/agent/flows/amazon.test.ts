/**
 * src/agent/flows/amazon.test.ts
 *
 * Wave-0 skeleton: two sections.
 *
 * SECTION 1 — Pure-function units (no browser, no LLM)
 *   verifyAmazonResult() — pure oracle: ordering invariants, anti-hallucination gate,
 *                          keyword-overlap title match, robot-check and sign-in-wall
 * SECTION 2 — RUN_LIVE-gated live integration block
 *   Skipped unless RUN_LIVE=1. Exercises runAmazonFlow() end-to-end.
 *
 * Runner: node --import tsx/esm --test src/agent/flows/amazon.test.ts
 *   Offline: only pure oracle units run
 *   Live:    RUN_LIVE=1 node --env-file=.env --import tsx/esm --test src/agent/flows/amazon.test.ts
 *
 * Expected offline state (Wave 0): The before() deferred import will throw
 * ERR_MODULE_NOT_FOUND because ./amazon.js does not exist until Wave 2 creates amazon.ts.
 * This is identical to how resy.test.ts / weather.test.ts started. Section 1 cases
 * will be cancelled (not failed) and Section 2 is skipped offline — correct RED state.
 *
 * Key contracts encoded here:
 *   - verifyAmazonResult oracle ordering invariant: robot-check first → sign-in-wall →
 *     anti-hallucination gate → keyword-overlap title match → cart count → success
 *   - anti-hallucination gate: ok:true requires isAddedToCartConfirmed OR isCartPage
 *   - tolerant keyword-overlap title match: any significant word from intent.target in addedItemTitle
 *   - robot-check and sign-in-wall are clean ok:false outcomes (not errors)
 *   - RUN_LIVE integration: status/result/screenshot/done events + JPEG magic bytes
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerEventType } from "../../protocol/events.js";

const isLive = !!process.env.RUN_LIVE;

// ---------------------------------------------------------------------------
// AmazonCartVerificationType — matches the Zod schema in amazon.ts (wave 2)
// Defined inline here so oracle tests can run without amazon.js importing.
// ---------------------------------------------------------------------------
interface AmazonCartVerificationType {
  cartCount: number | null;
  addedItemTitle: string;
  isAddedToCartConfirmed: boolean;
  isCartPage: boolean;
  isSignInWall: boolean;
  isRobotCheck: boolean;
  cannotShipToLocation: boolean;
}

// ---------------------------------------------------------------------------
// AmazonIntent — structural alias matching the Intent shape from intent.ts
// Defined inline here as a test fixture type.
// ---------------------------------------------------------------------------
interface AmazonIntent {
  site: string;
  location: string;
  target: string;
  party: number | null;
  date: string[];
  time: string | null;
  constraints: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Deferred dynamic import — ./amazon.js does not exist until Wave 2.
// Oracle tests will fail/cancel with ERR_MODULE_NOT_FOUND until then.
// That is the expected RED state (identical to how resy.test.ts started in Phase 2).
// ---------------------------------------------------------------------------
let verifyAmazonResult: (
  result: AmazonCartVerificationType,
  intent: AmazonIntent,
) => { ok: boolean; summary: string; reason: string };

let runAmazonFlow: (
  intent: AmazonIntent,
  emit: (event: ServerEventType) => void,
) => Promise<void>;

before(async () => {
  // NOTE: This import will fail with ERR_MODULE_NOT_FOUND until Wave 2 creates amazon.ts.
  // That is the expected RED state for Wave-0 skeletons.
  const mod = await import("./amazon.js");
  verifyAmazonResult = mod.verifyAmazonResult;
  runAmazonFlow = mod.runAmazonFlow;
});

// ---------------------------------------------------------------------------
// SECTION 1: verifyAmazonResult() — SC-1 oracle (pure function)
// No browser, no LLM. Run on every commit (once amazon.ts exists in Wave 2).
// ---------------------------------------------------------------------------

// Shared base intent fixture
const baseIntent: AmazonIntent = {
  site: "amazon",
  location: "",
  target: "12oz bag of coffee",
  party: null,
  date: [],
  time: null,
  constraints: {},
};

describe("verifyAmazonResult() — SC-1 oracle (pure function)", () => {

  it("SC-1a: ok:true when isAddedToCartConfirmed:true, title matches, cartCount >= 1", () => {
    const result: AmazonCartVerificationType = {
      cartCount: 1,
      addedItemTitle: "Death Wish Coffee 12 oz",
      isAddedToCartConfirmed: true,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: false,
      cannotShipToLocation: false,
    };
    const out = verifyAmazonResult(result, baseIntent);
    assert.equal(out.ok, true, "must return ok:true on full match");
    assert.ok(out.summary.length > 0, "summary must be non-empty on success");
  });

  it("SC-1b: ANTI-HALLUCINATION GATE — ok:false when isAddedToCartConfirmed:false AND isCartPage:false", () => {
    const result: AmazonCartVerificationType = {
      cartCount: null,
      addedItemTitle: "",
      isAddedToCartConfirmed: false,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: false,
      cannotShipToLocation: false,
    };
    const out = verifyAmazonResult(result, baseIntent);
    assert.equal(out.ok, false, "anti-hallucination gate must block success");
    assert.ok(out.reason.length > 0, "reason must be non-empty");
  });

  it("SC-1c: ok:false with reason:'amazon-robot-check' when isRobotCheck:true — checked FIRST", () => {
    const result: AmazonCartVerificationType = {
      cartCount: null,
      addedItemTitle: "",
      isAddedToCartConfirmed: false,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: true,
      cannotShipToLocation: false,
    };
    const out = verifyAmazonResult(result, baseIntent);
    assert.equal(out.ok, false, "robot check must block");
    assert.equal(out.reason, "amazon-robot-check", "reason must be 'amazon-robot-check'");
  });

  it("SC-1d: TOLERANT MATCH — 'coffee' from intent.target matches 'Death Wish Coffee 12 oz'", () => {
    const result: AmazonCartVerificationType = {
      cartCount: 1,
      addedItemTitle: "Death Wish Coffee 12 oz",
      isAddedToCartConfirmed: true,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: false,
      cannotShipToLocation: false,
    };
    const out = verifyAmazonResult(result, baseIntent);
    assert.equal(out.ok, true, "keyword-overlap title match must pass");
  });

  it("sign-in-wall: ok:false with reason:'amazon-sign-in-wall' when isSignInWall:true and not confirmed", () => {
    const result: AmazonCartVerificationType = {
      cartCount: null,
      addedItemTitle: "",
      isAddedToCartConfirmed: false,
      isCartPage: false,
      isSignInWall: true,
      isRobotCheck: false,
      cannotShipToLocation: false,
    };
    const out = verifyAmazonResult(result, baseIntent);
    assert.equal(out.ok, false, "sign-in wall must block");
    assert.equal(out.reason, "amazon-sign-in-wall", "reason must be 'amazon-sign-in-wall'");
  });

  it("IN-02: CART-COUNT GATE — ok:false when confirmed + title matches but cartCount:null", () => {
    // Step 5: even past the anti-hallucination gate and a matching title, a
    // null/absent cart count must block success with a count-related reason.
    const result: AmazonCartVerificationType = {
      cartCount: null,
      addedItemTitle: "Death Wish Coffee 12 oz",
      isAddedToCartConfirmed: true,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: false,
      cannotShipToLocation: false,
    };
    const out = verifyAmazonResult(result, baseIntent);
    assert.equal(out.ok, false, "cart-count gate must block when cartCount is null");
    assert.match(out.reason, /count/i, "reason must mention the cart count");
  });

  it("IN-02: CART-COUNT GATE — ok:false when cartCount:0 despite confirmation + title match", () => {
    const result: AmazonCartVerificationType = {
      cartCount: 0,
      addedItemTitle: "Death Wish Coffee 12 oz",
      isAddedToCartConfirmed: true,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: false,
      cannotShipToLocation: false,
    };
    const out = verifyAmazonResult(result, baseIntent);
    assert.equal(out.ok, false, "cart-count gate must block when cartCount < 1");
    assert.match(out.reason, /count/i, "reason must mention the cart count");
  });

  it("IN-02: TITLE MISMATCH — ok:false when no intent word overlaps the cart item title", () => {
    // Genuine mismatch: target "12oz bag of coffee" vs a water-bottle title.
    // No significant word ("coffee") appears → ok:false with a "does not match" reason.
    const result: AmazonCartVerificationType = {
      cartCount: 1,
      addedItemTitle: "Stainless Steel Water Bottle",
      isAddedToCartConfirmed: true,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: false,
      cannotShipToLocation: false,
    };
    const out = verifyAmazonResult(result, baseIntent);
    assert.equal(out.ok, false, "non-overlapping title must block");
    assert.match(out.reason, /does not match/i, "reason must say the item does not match intent");
  });

  it("WR-01: SHORT TARGET — all-short-word target ('tea') still matches when added", () => {
    // Regression guard for WR-01: every word in "tea" is below the significant
    // threshold, so the old filter left [] and falsely returned ok:false. The
    // full-word fallback must now match "tea" inside the product title.
    const shortIntent: AmazonIntent = { ...baseIntent, target: "tea" };
    const result: AmazonCartVerificationType = {
      cartCount: 1,
      addedItemTitle: "Organic Green Tea Bags, 100 Count",
      isAddedToCartConfirmed: true,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: false,
      cannotShipToLocation: false,
    };
    const out = verifyAmazonResult(result, shortIntent);
    assert.equal(out.ok, true, "short-name target must match honestly when the item was added");
  });

  it("WR-01: SHORT TARGET — all-short-word target ('tea') still reports mismatch when wrong item", () => {
    // The fallback must not become a blanket pass: a short target against a
    // truly unrelated title still fails honestly.
    const shortIntent: AmazonIntent = { ...baseIntent, target: "tea" };
    const result: AmazonCartVerificationType = {
      cartCount: 1,
      addedItemTitle: "Stainless Steel Water Bottle",
      isAddedToCartConfirmed: true,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: false,
      cannotShipToLocation: false,
    };
    const out = verifyAmazonResult(result, shortIntent);
    assert.equal(out.ok, false, "short-name target must still fail on a non-overlapping title");
    assert.match(out.reason, /does not match/i, "reason must say the item does not match intent");
  });

  it("amazon-cannot-ship: ok:false with reason 'amazon-cannot-ship' + honest summary when cannotShipToLocation:true and not confirmed", () => {
    // Geo-restriction outcome (analog of resy venueNotFound / G3). From a non-US IP
    // Amazon shows "This item cannot be shipped to your selected delivery location" and
    // removes Add to Cart, so no confirmation is reachable. The oracle must report this
    // honestly via a user-facing summary, NOT the generic anti-hallucination verdict.
    const result: AmazonCartVerificationType = {
      cartCount: null,
      addedItemTitle: "",
      isAddedToCartConfirmed: false,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: false,
      cannotShipToLocation: true,
    };
    const out = verifyAmazonResult(result, baseIntent);
    assert.equal(out.ok, false, "shipping-restricted item must block success");
    assert.equal(out.reason, "amazon-cannot-ship", "reason must be 'amazon-cannot-ship'");
    assert.ok(out.summary.length > 0, "summary must carry the honest user-facing message");
    assert.match(out.summary, /ship/i, "summary must mention shipping/location");
    assert.doesNotMatch(
      out.summary,
      /Did not reach add-to-cart confirmation/i,
      "must NOT fall through to the generic anti-hallucination verdict",
    );
  });

  it("amazon-cannot-ship ORDERING: cannot-ship wins over the generic anti-hallucination gate", () => {
    // cannotShipToLocation:true + not confirmed + not cart page would otherwise hit the
    // generic "Did not reach add-to-cart confirmation" gate. The cannot-ship branch must
    // be ordered BEFORE it (analog of the resy venueNotFound ordering proof).
    const result: AmazonCartVerificationType = {
      cartCount: null,
      addedItemTitle: "",
      isAddedToCartConfirmed: false,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: false,
      cannotShipToLocation: true,
    };
    const out = verifyAmazonResult(result, baseIntent);
    assert.equal(out.reason, "amazon-cannot-ship", "cannot-ship must win over the anti-hallucination gate");
  });

  it("amazon-cannot-ship GUARD: a genuine confirmation still wins even if cannotShipToLocation:true", () => {
    // Defensive: a real Added-to-Cart confirmation (with matching title + count) must NOT
    // be overridden by a stale/co-present shipping flag. The branch is gated on
    // !isAddedToCartConfirmed precisely so success is never clobbered.
    const result: AmazonCartVerificationType = {
      cartCount: 1,
      addedItemTitle: "Death Wish Coffee 12 oz",
      isAddedToCartConfirmed: true,
      isCartPage: false,
      isSignInWall: false,
      isRobotCheck: false,
      cannotShipToLocation: true,
    };
    const out = verifyAmazonResult(result, baseIntent);
    assert.equal(out.ok, true, "a real add-to-cart confirmation must not be overridden by a shipping flag");
  });

});

// ---------------------------------------------------------------------------
// SECTION 2: RUN_LIVE-gated live integration block
// Skipped unless RUN_LIVE=1. Wave 2 (amazon.ts) + Wave 3 (server.ts wiring) flip this green.
//
// Run with:
//   RUN_LIVE=1 node --env-file=.env --import tsx/esm --test src/agent/flows/amazon.test.ts
// ---------------------------------------------------------------------------
describe("runAmazonFlow() — live integration (Criterion 1)", { skip: !isLive }, () => {
  it("Criterion 1: searches, opens product, adds to cart — result.ok:true or clean ok:false with reason", async () => {
    const events: ServerEventType[] = [];
    const emit = (e: ServerEventType) => events.push(e);

    const intent: AmazonIntent = {
      site: "amazon",
      location: "",
      target: "12oz bag of coffee",
      party: null,
      date: [],
      time: null,
      constraints: {},
    };

    await runAmazonFlow(intent, emit);

    // At least one status event
    assert.ok(events.filter(e => e.type === "status").length > 0, "at least one status event");

    // result event emitted (not error)
    const resultEvent = events.find(e => e.type === "result");
    assert.ok(resultEvent, "result event must be emitted");

    // No unexpected error event — robot-check/sign-in-wall surface via result.ok:false
    const errorEvent = events.find(e => e.type === "error");
    assert.ok(!errorEvent, "no error event — robot-check/sign-in-wall must surface via result.ok:false");

    // done event
    assert.ok(events.find(e => e.type === "done"), "done event must be emitted");

    // screenshot with valid JPEG magic bytes
    const screenshotEvent = events.find(e => e.type === "screenshot");
    assert.ok(screenshotEvent, "screenshot event must be emitted");
    const jpegBase64 = (screenshotEvent as { type: string; jpegBase64: string }).jpegBase64;
    const magicHex = Buffer.from(jpegBase64, "base64").subarray(0, 2).toString("hex");
    assert.equal(magicHex, "ffd8", "screenshot must start with JPEG magic bytes FF D8");

    // Save live proof screenshot
    const allScreenshots = events.filter(e => e.type === "screenshot");
    const lastScreenshot = allScreenshots[allScreenshots.length - 1] as
      | { type: string; jpegBase64: string } | undefined;
    if (lastScreenshot?.jpegBase64) {
      const proofPath = join(
        import.meta.dirname,
        "../../../live-proof/amazon-live-proof.jpg",
      );
      await writeFile(proofPath, Buffer.from(lastScreenshot.jpegBase64, "base64"));
      console.log(`[live-proof] screenshot saved → ${proofPath}`);
    }
  });
});
