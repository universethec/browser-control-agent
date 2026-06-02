/**
 * src/agent/flows/amazon.ts
 *
 * Amazon add-to-cart flow: AmazonCartVerification schema, SUCCESS ORACLE (verifyAmazonResult),
 * and AMAZON_EXTRACT_INSTRUCTION. The runAmazonFlow state machine is plan 03-04.
 *
 * Deliverables (this plan — 03-03):
 *   Criterion 1 oracle         verifyAmazonResult — gates ok:true on reaching cart confirmation
 *                               with a matching item title AND cartCount >= 1.
 *                               Never reports done-when-it-isn't (anti-hallucination gate).
 *
 *   ORDERING IS THE INVARIANT (analog of verifyResyResult in resy.ts):
 *     1. isRobotCheck → ok:false, reason:"amazon-robot-check" (FIRST — clean punt signal, Pitfall 2)
 *     2. isSignInWall && !isAddedToCartConfirmed → ok:false, reason:"amazon-sign-in-wall"
 *     2b. cannotShipToLocation && !isAddedToCartConfirmed → ok:false, reason:"amazon-cannot-ship" (honest geo verdict)
 *     3. Anti-hallucination gate: !isAddedToCartConfirmed && !isCartPage → ok:false
 *     4. Tolerant keyword-overlap title match (any significant word from intent.target in addedItemTitle)
 *     5. Cart-count gate: cartCount === null || cartCount < 1 → ok:false
 *     6. Success: ok:true
 *
 * Anti-patterns avoided:
 *   - sh.page does not exist in v3 — use sh.context.pages()[0]
 *   - page.extract/page.observe do not exist — use sh.extract / sh.observe
 *   - Never open Chromium at import time — createStagehand() + sh.init() inside run function
 *   - No checkout/payment/Buy Now step exists (stop-before-purchase guarantee, Criterion 3)
 *
 * ESM note: relative imports use .js specifiers under NodeNext.
 */

import { z } from "zod";
import type { Stagehand } from "@browserbasehq/stagehand";
import { createStagehand } from "../stagehand.js";
import { runLoop, type LoopConfig, type FlowDefinition } from "../loop.js";
import type { ServerEventType } from "../../protocol/events.js";
import type { Intent } from "../intent.js";

// ---------------------------------------------------------------------------
// Criterion 1: AmazonCartVerification schema (analog of ResyVerification in resy.ts)
// Nullable fields: cartCount may be absent on non-terminal pages.
// ---------------------------------------------------------------------------

export const AmazonCartVerification = z.object({
  cartCount: z.number().nullable(),
  addedItemTitle: z.string(),
  isAddedToCartConfirmed: z.boolean(),
  isCartPage: z.boolean(),
  isSignInWall: z.boolean(),
  isRobotCheck: z.boolean(),
  // Geo-restriction signal — true when Amazon shows "This item cannot be shipped to
  // your selected delivery location". Amazon geolocates by IP; from a non-US connection
  // the chosen product is often unshippable and Add to Cart is removed. Reported
  // honestly by verifyAmazonResult (analog of resy.ts venueNotFound / G3).
  cannotShipToLocation: z.boolean(),
});

export type AmazonCartVerificationType = z.infer<typeof AmazonCartVerification>;

// IN-04: Minimum length for a word in intent.target to count as "significant"
// for the tolerant title-overlap match. Words shorter than this (e.g. "a",
// "of", "the", "12oz") are stop-word noise and are filtered out — EXCEPT when
// that would discard every word (WR-01), in which case we fall back to the
// full normalized word set so genuinely short product names ("tea", "pen",
// "USB") still match honestly. Named here so the threshold lives in one place.
const MIN_SIGNIFICANT_WORD_LEN = 4;

// ---------------------------------------------------------------------------
// Criterion 1: verifyAmazonResult oracle — analog of verifyResyResult
// Pure function, no I/O.
//
// ORDERING IS THE INVARIANT (RESEARCH §A.3 / Pattern 4):
//   1. isRobotCheck first — clean punt signal (Pitfall 2, T-3-08)
//   2. isSignInWall && !isAddedToCartConfirmed — clean outcome, stopped before purchase
//   2b. cannotShipToLocation && !isAddedToCartConfirmed — honest geo-restriction verdict (G3 analog)
//   3. Anti-hallucination gate — prevents done-when-it-isn't (T-3-08)
//   4. Tolerant keyword-overlap title match (INTENTIONAL TOLERANCE: word overlap is the
//      correct strategy here because Amazon product titles are vendor-supplied and vary wildly.
//      "12oz bag of coffee" must match "Death Wish Coffee 12 oz" via the word "coffee".
//      NOT substring of the full target — Pitfall 5; documents the trade-off: small false-positive
//      risk accepted for robustness; the cart-count gate still bounds it. T-3-10: accepted risk.)
//   5. Cart-count gate — cartCount >= 1 required
//   6. Success
//
// Every failure path returns a non-empty reason. Never returns ok:true when
// the anti-hallucination gate would fire. This ordering is asserted by the test.
// ---------------------------------------------------------------------------

/**
 * Verifies an extracted AmazonCartVerificationType against the shopping intent.
 *
 * @param result  Extracted page signals (Zod-parsed by runAmazonFlow / test fixtures).
 * @param intent  The parsed shopping intent (site="amazon", target=product description, …).
 * @returns       { ok: boolean; summary: string; reason: string }
 */
export function verifyAmazonResult(
  result: AmazonCartVerificationType,
  intent: Intent,
): { ok: boolean; summary: string; reason: string } {
  // Step 1: Robot check FIRST — clean punt signal (Pitfall 2, T-3-08).
  // A robot-check page causes downstream flow failures if not caught here
  // (the search box is absent; StagehandElementNotFoundError would fire).
  // Checked before any other branch — the invariant ordering.
  if (result.isRobotCheck) {
    return { ok: false, summary: "", reason: "amazon-robot-check" };
  }

  // Step 2: Sign-in wall (clean outcome — stopped before purchase, Criterion 3).
  // Allow isAddedToCartConfirmed:true to pass through even with isSignInWall:true
  // (in case Amazon shows a sign-in nag after cart add but confirmation is visible).
  if (result.isSignInWall && !result.isAddedToCartConfirmed) {
    return { ok: false, summary: "", reason: "amazon-sign-in-wall" };
  }

  // Step 2b: Cannot-ship-to-location — honest geo-restriction outcome (analog of
  // resy.ts venueNotFound / G3). Amazon geolocates by IP; from a non-US connection the
  // chosen product commonly shows "cannot be shipped to your selected delivery location"
  // and the Add to Cart button is removed — so a cart confirmation is structurally
  // unreachable. Report this honestly with a user-facing summary INSTEAD of letting it
  // fall through to the generic "Did not reach add-to-cart confirmation" gate below.
  // Ordered AFTER sign-in-wall (step 2), BEFORE the anti-hallucination gate (step 3) —
  // this insertion point is the invariant. Gated on !isAddedToCartConfirmed so a genuine
  // confirmation (an item that DID add) always wins over a co-present shipping flag.
  if (result.cannotShipToLocation && !result.isAddedToCartConfirmed) {
    return {
      ok: false,
      summary:
        "This item can't ship to your delivery location, so it can't be added to the cart. " +
        "Amazon detects region by IP — the add-to-cart demo needs a US-region connection.",
      reason: "amazon-cannot-ship",
    };
  }

  // Step 3: Anti-hallucination gate (T-3-08 / criterion 1).
  // Must reach add-to-cart confirmation OR be on the cart page before any success path.
  // This check MUST come before title/count checks — its ordering is the invariant.
  if (!result.isAddedToCartConfirmed && !result.isCartPage) {
    return {
      ok: false,
      summary: "",
      reason: "Did not reach add-to-cart confirmation",
    };
  }

  // Step 4: Tolerant keyword-overlap title match (RESEARCH §A.3, Pitfall 5).
  // INTENTIONAL TOLERANCE: Split intent.target into significant words
  // (length >= MIN_SIGNIFICANT_WORD_LEN, IN-04, to skip "a", "of", "the",
  // "12oz") and require ANY such word to appear in the product title. This
  // handles "12oz bag of coffee" → "Death Wish Coffee 12 oz" via the word
  // "coffee", without requiring an exact-string substring match.
  // Trade-off: small false-positive risk accepted (T-3-10: accepted risk per threat register).
  //
  // WR-01: If EVERY word is short (e.g. "tea", "pen", "USB"), the significant
  // filter would leave [] and [].some(...) === false, falsely reporting a
  // mismatch even when the right item was added. Fall back to the full
  // normalized word set when no significant words survive so short-name
  // targets still match honestly.
  const allWords = intent.target
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const significantWords = allWords.filter((w) => w.length >= MIN_SIGNIFICANT_WORD_LEN);
  const matchWords = significantWords.length > 0 ? significantWords : allWords;
  const titleLower = result.addedItemTitle.toLowerCase();
  const titleMatch = matchWords.some((w) => titleLower.includes(w));
  if (!titleMatch) {
    return {
      ok: false,
      summary: "",
      reason: `Cart item "${result.addedItemTitle}" does not match intent "${intent.target}"`,
    };
  }

  // Step 5: Cart count gate — count must be >= 1 after add-to-cart.
  if (result.cartCount === null || result.cartCount < 1) {
    return {
      ok: false,
      summary: "",
      reason: `Cart count ${result.cartCount} is not >= 1`,
    };
  }

  // Step 6: All guards passed — success.
  return {
    ok: true,
    summary: `Added to cart: ${result.addedItemTitle} (cart count: ${result.cartCount})`,
    reason: "",
  };
}

// ---------------------------------------------------------------------------
// AMAZON_EXTRACT_INSTRUCTION — consumed by runAmazonFlow in plan 03-04.
// Asks Stagehand to extract the AmazonCartVerification fields from the current page.
// ---------------------------------------------------------------------------

export const AMAZON_EXTRACT_INSTRUCTION =
  "Extract the following from the current Amazon page: " +
  "cartCount (the numeric cart-count badge in the header, or null if not visible); " +
  "addedItemTitle (the product title shown on the 'Added to Cart' confirmation area or cart page, or empty string if absent); " +
  "isAddedToCartConfirmed (true if an 'Added to Cart' heading or confirmation message is visible); " +
  "isCartPage (true ONLY if the main content is Amazon's Shopping Cart page showing cart line items and a Subtotal — NOT merely because a URL or link fragment contains '/cart'); " +
  "isSignInWall (true if a sign-in or login prompt is blocking the page or the checkout path); " +
  "isRobotCheck (true if Amazon's 'Robot Check' CAPTCHA challenge page is shown — look for page title 'Robot Check' or body text indicating bot detection); " +
  "cannotShipToLocation (true if the page shows a delivery/shipping restriction such as 'This item cannot be shipped to your selected delivery location' or 'cannot be shipped to your location', false otherwise).";

// ---------------------------------------------------------------------------
// Stagehand error name set — checked by name/message for error-recovery routing
// (RESEARCH §2.8: StagehandElementNotFoundError, XPathResolutionError,
//  ActTimeoutError, StagehandDomProcessError, StagehandClickError)
// Copied verbatim from resy.ts lines 270–290.
// ---------------------------------------------------------------------------

const STAGEHAND_RECOVERABLE_ERROR_NAMES = new Set([
  "StagehandElementNotFoundError",
  "XPathResolutionError",
  "ActTimeoutError",
  "StagehandDomProcessError",
  "StagehandClickError",
]);

function isRecoverableStagehandError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (STAGEHAND_RECOVERABLE_ERROR_NAMES.has(err.name)) return true;
  // Also catch by message fragments for cases where error names may vary
  const msg = err.message.toLowerCase();
  return (
    msg.includes("element not found") ||
    msg.includes("xpath") ||
    msg.includes("timed out") ||
    msg.includes("click") ||
    msg.includes("dom process")
  );
}

// ---------------------------------------------------------------------------
// AmazonStep union — the deterministic state machine steps for runAmazonFlow.
// NO checkout/payment/Buy Now step — stop-before-purchase structural guarantee (Criterion 3).
// ---------------------------------------------------------------------------

type AmazonStep =
  | "dismiss-popup"
  | "focus-search"
  | "type-query"
  | "submit-search"
  | "open-product"
  | "select-variation"
  | "add-to-cart"
  | "extract-verify"
  | "recover-reobserve"
  | "abort";

// ---------------------------------------------------------------------------
// runAmazonFlow — entry point for the Amazon add-to-cart pipeline.
//
// Lifecycle: creates and owns the Stagehand instance.
//   try { init + navigate + loop } catch { emit error+done; rethrow } finally { close }
//
// Error surfacing pattern (never swallows):
//   On any throw: emits { type:"error", message } + { type:"done" } then rethrows.
//   The caller (server.ts runAgent) catches and logs; the ws client sees the error event.
//
// Stop-before-purchase (Criterion 3): the state machine has NO checkout/payment step.
// The terminal "extract-verify" always ends the loop (loop.ts emits result+done on a
// non-nonTerminal verify) — there is structurally no way to progress past add-to-cart.
// ---------------------------------------------------------------------------

export async function runAmazonFlow(
  intent: Intent,
  emit: (event: ServerEventType) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  // WR-03: Fail loudly before opening Chromium on an empty product target.
  // runAmazonFlow is an exported entry point wired directly in server.ts and
  // callable in tests / future answer-resume paths, so it must guard its inputs
  // the same way runResyFlow does — otherwise an empty target launches a full
  // headless browser only to type "" into search and run a doomed query.
  if (!intent.target?.trim()) {
    throw new Error(
      "runAmazonFlow requires a non-empty intent.target (product description). " +
      "Ensure parseIntent resolved the target before calling runAmazonFlow.",
    );
  }

  const sh = createStagehand(); // lazy factory — no browser yet

  try {
    await sh.init(); // opens headless Chromium
    const page = sh.context.pages()[0]; // v3 page access — NOT sh.page (removed in v3)

    emit({ type: "status", step: 0, text: `Navigating to https://www.amazon.com…` });
    await page.goto("https://www.amazon.com", { waitUntil: "networkidle" });

    // -----------------------------------------------------------------------
    // State-machine closure variables — all declared before flow so closures
    // capture live references (not temporal-dead-zone undefined).
    // -----------------------------------------------------------------------

    let currentStep: AmazonStep = "dismiss-popup";

    // failureCount + pendingStep: never-retry-same-action→replan (REQ-error-recovery).
    // On a Stagehand error, doExtract routes to recover-reobserve, recording
    // the failing step in pendingStep. recover-reobserve retries exactly once.
    let failureCount = 0;
    let pendingStep: AmazonStep = "dismiss-popup";

    // isTypingBridge: decide() sets this before returning type:"extract" for the
    // type-query step (Pitfall 1 — real keystrokes fire Amazon's autocomplete JS).
    let isTypingBridge = false;

    // isVariationStep: decide() sets this before the select-variation extract bridge so
    // doExtract picks any required product option (size/flavor/count) before add-to-cart.
    let isVariationStep = false;

    const loopConfig: LoopConfig = {
      maxSteps: 25,
      timeoutMs: 300_000,
      maxIdentical: 3,
      emit,
      isCancelled,
    };

    const flow: FlowDefinition = {
      // -----------------------------------------------------------------------
      // Step-aware observeInstruction getter — observe only what is relevant to
      // the current step, reducing a11y-tree noise.
      // -----------------------------------------------------------------------
      get observeInstruction(): string {
        switch (currentStep) {
          case "dismiss-popup":
            return "find any popup, overlay, or banner with a dismiss or close button";
          case "focus-search":
            return "find the product search input box at the top of the page";
          case "type-query":
            return "find the product search input box at the top of the page";
          case "submit-search":
            return "find the search submit button or press Enter on the search input";
          case "open-product":
            return "find product listing results, excluding sponsored ads";
          case "select-variation":
            return "find required product option selectors such as size, flavor, color, count, or style";
          case "add-to-cart":
            return "find the Add to Cart button on this product page";
          case "extract-verify":
            return "find the cart count badge and any Added to Cart confirmation";
          case "recover-reobserve":
            return "observe all interactive elements currently visible on the page";
          case "abort":
            return "observe what is currently visible on the page";
          default:
            return "observe all interactive elements on the page";
        }
      },

      // -----------------------------------------------------------------------
      // decide() — deterministic state machine.
      // Each non-bridge case sets pendingStep = <this step> then advances currentStep
      // (the recovery-routing contract: recover-reobserve returns to pendingStep).
      //
      // NO step references checkout, payment, Buy Now (as a click target),
      // or place-order — stop-before-purchase structural guarantee (Criterion 3, T-3-11).
      // -----------------------------------------------------------------------
      decide: (_candidates, _step) => {
        switch (currentStep) {
          case "dismiss-popup":
            pendingStep = "dismiss-popup";
            currentStep = "focus-search";
            return {
              type: "act",
              narration: "Dismissing popup or cookie notice (if present)…",
              instruction:
                "dismiss the cookie consent banner or any popup if present, or click accept on any privacy notice",
            };

          case "focus-search":
            pendingStep = "focus-search";
            currentStep = "type-query";
            return {
              type: "act",
              narration: "Clicking the search input box…",
              instruction: "click on the product search input box to focus it",
            };

          case "type-query":
            // Bridge: page.type() for real keystrokes — Pitfall 1.
            // Never fill() — fill() does not fire Amazon's autocomplete JS.
            pendingStep = "type-query";
            currentStep = "submit-search";
            isTypingBridge = true;
            return {
              type: "extract",
              narration: `Typing "${intent.target}" into search box…`,
            };

          case "submit-search":
            pendingStep = "submit-search";
            currentStep = "open-product";
            return {
              type: "act",
              narration: "Submitting the search…",
              instruction: "press Enter to submit the product search",
            };

          case "open-product":
            pendingStep = "open-product";
            currentStep = "select-variation";
            return {
              type: "act",
              narration: "Opening first non-sponsored product result…",
              instruction: "click the first product result that is not a sponsored ad",
            };

          case "select-variation":
            // Many products require choosing a size/flavor/count/style before Add to Cart
            // works. This bridge best-effort-selects the first available option for each
            // required choice (in doExtract). Simple products have none — it no-ops safely.
            pendingStep = "select-variation";
            currentStep = "add-to-cart";
            isVariationStep = true;
            return {
              type: "extract",
              narration: "Selecting required product options (if any)…",
            };

          case "add-to-cart":
            // Instruction precision (§A.5): disambiguate against "Buy Now" and "Add to List"
            // so the LLM does not accidentally click Buy Now (stop-before-purchase, T-3-11).
            pendingStep = "add-to-cart";
            currentStep = "extract-verify";
            return {
              type: "act",
              narration: "Clicking Add to Cart…",
              instruction: "click the Add to Cart button, not Buy Now or Add to List",
            };

          case "extract-verify":
            // Terminal step: loop.ts runs doExtract → verifyAmazonResult → emits result+done.
            return {
              type: "extract",
              narration: "Verifying cart addition…",
            };

          case "recover-reobserve":
            // Never-retry-same-action: on first failure, re-observe and route back
            // to the pending step once. On second failure, advance to abort.
            // Copied verbatim from resy.ts lines 522–541.
            failureCount++;
            if (failureCount >= 2) {
              currentStep = "abort";
              return {
                type: "act",
                narration: "Recovery failed — advancing to final extraction…",
                instruction: "observe what is currently visible on the page",
              };
            }
            // First recovery: re-ground the a11y tree, then retry the pending step.
            currentStep = pendingStep;
            return {
              type: "act",
              narration: "Element not found — re-observing page state before retry…",
              instruction: "observe all interactive elements currently visible on the page",
            };

          case "abort":
            // Abort: ends on extract so verifyAmazonResult reports ok:false honestly.
            // Robot-check and sign-in-wall flow through the oracle — never a crash.
            return {
              type: "extract",
              narration: "Aborting — reporting current page state…",
            };

          default: {
            const _exhaustive: never = currentStep;
            void _exhaustive;
            return { type: "extract", narration: "Unknown step — extracting current state…" };
          }
        }
      },

      // -----------------------------------------------------------------------
      // doExtract — two paths:
      //   1. isTypingBridge: page.type() for real-keystroke search (Pitfall 1)
      //   2. Terminal extraction: extractSh.extract(AMAZON_EXTRACT_INSTRUCTION, AmazonCartVerification)
      //
      // Bridge steps wrap their Stagehand calls in try/catch to implement the
      // never-retry-same-action recovery (REQ-error-recovery):
      //   - Recoverable error: currentStep → "recover-reobserve"; return { _bridge } immediately.
      //   - Non-recoverable error: rethrow — outer try/catch closes the browser and emits error+done.
      //   - Success: return { _bridge } so verify() sets nonTerminal:true and the loop continues.
      // -----------------------------------------------------------------------
      doExtract: async (extractSh: Stagehand) => {
        if (isTypingBridge) {
          isTypingBridge = false;
          try {
            // Real keystrokes — dispatches keyDown/keyUp per character.
            // Never fill() — Pitfall 1: fill() does not fire Amazon's autocomplete JS.
            await page.type(intent.target, { delay: 50 });
          } catch (err) {
            if (isRecoverableStagehandError(err)) {
              currentStep = "recover-reobserve";
              return { _bridge: "type-query" };
            }
            // Non-recoverable: rethrow so the outer try/catch closes the browser
            // and the caller emits error+done. Never swallow.
            throw err;
          }
          return { _bridge: "type-query" };
        }

        if (isVariationStep) {
          isVariationStep = false;
          try {
            // Best-effort: pick the first available option for any required product
            // variation (size/flavor/color/count/style) so Add to Cart isn't blocked.
            // Simple products have none — act() finds nothing, throws, and we no-op.
            await extractSh.act(
              "if this product requires choosing an option such as size, flavor, color, count, or style before it can be added to the cart, select the first available option for each such required choice",
            );
          } catch {
            // No required options (simple product) or selection not found — proceed to add-to-cart.
          }
          return { _bridge: "select-variation" };
        }

        // Terminal extraction — extract page signals for the oracle
        return await extractSh.extract(AMAZON_EXTRACT_INSTRUCTION, AmazonCartVerification);
      },

      // -----------------------------------------------------------------------
      // verify() — bridge steps set nonTerminal:true so the loop continues without
      // emitting result+done; real extraction gates through verifyAmazonResult.
      //
      // Bridge step contract: doExtract returns { _bridge: "<step-name>" } for
      // intermediate steps (type-query). verify() detects this sentinel and
      // returns { nonTerminal: true } — the loop calls `continue` and suppresses
      // result+done for that iteration.
      //
      // Only the terminal "extract-verify" (or "abort") extraction reaches the
      // verifyAmazonResult oracle and emits the authoritative result+done pair.
      // Re-validates via safeParse — never blind-casts (T-3-12 mitigated).
      // -----------------------------------------------------------------------
      verify: (raw) => {
        // WR-02: Narrow `raw` (typed unknown) BEFORE reading `_bridge`. The prior
        // `raw as Record<string, unknown>` cast asserted non-null-object to the
        // type system, so a null/primitive extraction (an LLM/Stagehand edge case
        // the comments anticipate) would make `"_bridge" in r` throw a TypeError
        // that escapes verify() instead of falling through to the clean
        // schema-mismatch path. Guarding first keeps the `in` operator safe.
        if (raw && typeof raw === "object" && "_bridge" in raw) {
          return {
            ok: false,
            summary: "",
            reason: `intermediate:${String((raw as { _bridge: unknown })._bridge)}`,
            nonTerminal: true,
          };
        }
        // Terminal extraction: re-validate via safeParse (never blind cast, T-3-12).
        const parsed = AmazonCartVerification.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            summary: "",
            reason: "extraction did not match AmazonCartVerification schema",
          };
        }
        return verifyAmazonResult(parsed.data, intent);
      },
    };

    await runLoop(sh, flow, loopConfig);
  } catch (err) {
    // Error surfacing pattern: emit error+done, then rethrow — never swallow.
    // Emits only err.message — never process.env.*_API_KEY (T-3-14 mitigated).
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    emit({ type: "done" });
    throw err;
  } finally {
    await sh.close();
  }
}
