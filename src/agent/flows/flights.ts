/**
 * src/agent/flows/flights.ts
 *
 * Google Flights search flow (added Phase 5 polish — un-punted after a live scout
 * confirmed Google Flights is reachable on a residential IP: consent is a single
 * "Accept all" click and the search form exposes a clean a11y tree).
 *
 * Mirrors runResyFlow exactly:
 *   - Deterministic step-state machine over the shared runLoop harness (loop.ts UNCHANGED).
 *   - Real keystrokes (page.type) for the origin/destination autocomplete + the date
 *     textbox (Pitfall 1: fill() does not fire the autocomplete/calendar JS).
 *   - sh.act() natural-language clicks for the suggestion options + Search button
 *     (a11y-grounded; resilient to Google's frequent DOM churn).
 *   - verifyFlightsResult oracle gates "done": ok:true ONLY when a real results list
 *     is shown. No-results and a (rare) bot-block are clean ok:false outcomes, never
 *     a crash and never a fabricated success ("verify honestly" — DEC-reliability).
 *
 * Intent mapping (IntentSchema is fixed): location = origin, target = destination,
 *   date[0] = departure (ISO), party = passengers (default 1), time = null.
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
// Google Flights entry URL. The flow drives the search form on this page;
// we do NOT deep-link query params (the form is the scouted, groundable path).
// ---------------------------------------------------------------------------
const FLIGHTS_URL = "https://www.google.com/travel/flights";

// ---------------------------------------------------------------------------
// FlightsVerification schema — extracted page signals for the oracle.
// Analog of ResyVerification: nullable/garbage-tolerant via z.preprocess where
// the field may be absent on a non-terminal page.
// ---------------------------------------------------------------------------

export const FlightsVerification = z.object({
  hasResults: z.boolean(),      // a list of flight options with prices/times is shown
  isNoResults: z.boolean(),     // page explicitly says no flights for this route/date
  isBlockPage: z.boolean(),     // access-denied / bot-detection / CAPTCHA (NOT a consent banner)
  blockReason: z.string(),      // block message text, or "" if not blocked
  origin: z.string(),           // departure city/airport shown on the page
  destination: z.string(),      // arrival city/airport shown on the page
  topResult: z.string(),        // one-line summary of the best/first flight, or ""
});

export type FlightsVerificationType = z.infer<typeof FlightsVerification>;

// ---------------------------------------------------------------------------
// verifyFlightsResult — pure oracle (no I/O). Ordering IS the invariant:
//   1. isBlockPage  → honest block (clean ok:false, never a crash)
//   2. isNoResults  → graceful "no flights" (clean ok:false)
//   3. hasResults   → success (ok:true) — the ONLY success path
//   4. otherwise    → reached the page but couldn't read results (ok:false)
// Never returns ok:true without hasResults (anti-hallucination, "verify honestly").
// ---------------------------------------------------------------------------

export function verifyFlightsResult(
  result: FlightsVerificationType,
  intent: Intent,
): { ok: boolean; summary: string; reason: string } {
  const route = `${intent.location} → ${intent.target}`;
  const onDate = intent.date?.[0] ? ` on ${intent.date[0]}` : "";

  // Step 1: confirmed bot-block — honest, graceful (consent banners are NOT blocks;
  // the extract instruction is told to set isBlockPage:false for consent).
  if (result.isBlockPage) {
    return {
      ok: false,
      summary: `Blocked: ${result.blockReason || "Google Flights blocked automated access"}`,
      reason: "blocked",
    };
  }

  // Step 2: no flights for the route/date — clean graceful outcome.
  if (result.isNoResults) {
    return {
      ok: false,
      summary: `No flights found for ${route}${onDate}.`,
      reason: "no-results",
    };
  }

  // Step 3: success — results are shown. The ONLY ok:true path.
  if (result.hasResults) {
    const top = result.topResult?.trim();
    return {
      ok: true,
      summary: `Found flights ${route}${onDate}${top ? `: ${top}` : ""}.`,
      reason: "",
    };
  }

  // Step 4: reached Google Flights but no readable results — honest miss.
  return {
    ok: false,
    summary: `Reached Google Flights for ${route} but couldn't read a results list — try again or adjust the route/date.`,
    reason: "no-results-read",
  };
}

// ---------------------------------------------------------------------------
// Extraction instruction for FlightsVerification.
// ---------------------------------------------------------------------------

const FLIGHTS_EXTRACT_INSTRUCTION =
  "Analyze the current Google Flights page and answer: " +
  "hasResults (true if a list of bookable flight options with prices and times is shown), " +
  "isNoResults (true if the page says no flights/results were found for this route or date), " +
  "isBlockPage (true ONLY if this is an access-denied, bot-detection, or CAPTCHA challenge page — a cookie/privacy CONSENT banner is NOT a block, answer false for consent banners), " +
  "blockReason (the block message text if isBlockPage is true, otherwise empty string), " +
  "origin (the departure city or airport shown), " +
  "destination (the arrival city or airport shown), " +
  "topResult (a one-line summary of the best or first flight shown — airline, price, duration, stops — or empty string if no results).";

// ---------------------------------------------------------------------------
// FlightsStep — deterministic state-machine step names.
// ---------------------------------------------------------------------------

type FlightsStep =
  | "dismiss-consent"
  | "set-oneway"
  | "focus-origin"
  | "type-origin"        // bridge: clear + page.type real keystrokes (autocomplete)
  | "pick-origin"
  | "focus-destination"
  | "type-destination"   // bridge: page.type real keystrokes (autocomplete)
  | "pick-destination"
  | "focus-date"
  | "type-date"          // bridge: page.type the ISO departure date
  | "confirm-date"       // click Done in the date picker to apply + close the calendar
  | "click-search"
  | "settle-results"     // bridge: brief wait for the results list to render
  | "extract-verify"
  | "recover-reobserve"
  | "abort";

// ---------------------------------------------------------------------------
// Stagehand recoverable-error detection (same set as resy.ts; duplicated locally
// to avoid modifying resy.ts to export it).
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
  const msg = err.message.toLowerCase();
  return (
    msg.includes("element not found") ||
    msg.includes("xpath") ||
    msg.includes("timed out") ||
    msg.includes("click") ||
    msg.includes("dom process") ||
    msg.includes("no object generated") ||
    msg.includes("did not match schema")
  );
}

// ---------------------------------------------------------------------------
// runFlightsFlow — entry point. Creates and owns the Stagehand instance.
//   try { init + navigate + loop } catch { emit error+done; rethrow } finally { close }
// ---------------------------------------------------------------------------

export async function runFlightsFlow(
  intent: Intent,
  emit: (event: ServerEventType) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  // Fail loudly before opening Chromium on missing required slots (mirrors runResyFlow).
  // parseIntent guards the ws path via ClarifyNeeded, but this is an exported entry point.
  if (!intent.location?.trim()) {
    throw new Error("runFlightsFlow requires an origin in intent.location (e.g. 'SFO' or 'San Francisco').");
  }
  if (!intent.target?.trim()) {
    throw new Error("runFlightsFlow requires a destination in intent.target (e.g. 'JFK' or 'New York').");
  }

  const origin = intent.location.trim();
  const destination = intent.target.trim();
  const departISO = intent.date?.[0] ?? "";

  // Retry the whole flow once on a TRANSIENT Stagehand grounding error (intermittent
  // "No object generated" on a grounded act/observe — runLoop owns those calls so it
  // can't be caught mid-loop; a fresh attempt almost always succeeds).
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const sh = createStagehand(); // lazy factory — fresh browser per attempt
    try {
      await sh.init();
      const page = sh.context.pages()[0]; // v3 page access — NOT sh.page

    emit({ type: "status", step: 0, text: `Navigating to Google Flights…` });
    // domcontentloaded (not networkidle): Google keeps background beacons alive.
    await page.goto(FLIGHTS_URL, { waitUntil: "domcontentloaded" });

    let currentStep: FlightsStep = "dismiss-consent";
    let failureCount = 0;
    let pendingStep: FlightsStep = "dismiss-consent";

    // Bridge flags — set by decide() before returning type:"extract" for steps where
    // doExtract performs an action (typing) rather than the terminal extraction.
    let isOriginType = false;
    let isDestType = false;
    let isDateType = false;
    let isSettleResults = false;
    let isSearchClick = false;

    const loopConfig: LoopConfig = {
      maxSteps: 25,
      timeoutMs: 300_000,
      maxIdentical: 3,
      emit,
      isCancelled,
    };

    const flow: FlowDefinition = {
      get observeInstruction(): string {
        switch (currentStep) {
          case "dismiss-consent":    return "find the cookie consent 'Accept all' or privacy banner accept button";
          case "set-oneway":         return "find the trip type selector currently showing 'Round trip'";
          case "focus-origin":       return "find the 'Where from?' origin input";
          case "type-origin":        return "find the 'Where from?' origin input";
          case "pick-origin":        return `find the airport or city suggestion matching ${origin}`;
          case "focus-destination":  return "find the 'Where to?' destination input";
          case "type-destination":   return "find the 'Where to?' destination input";
          case "pick-destination":   return `find the airport or city suggestion matching ${destination}`;
          case "focus-date":         return "find the Departure date input";
          case "type-date":          return "find the Departure date input";
          case "confirm-date":       return "find the Done or Confirm button in the date picker dialog";
          case "click-search":       return "find the Search button (the blue magnifying-glass Search button, not a date-picker button)";
          case "settle-results":     return "find the flight results list with prices and times";
          case "extract-verify":     return "find the flight results list with prices and times";
          case "recover-reobserve":  return "observe all interactive elements currently visible on the page";
          case "abort":              return "observe what is currently visible on the page";
          default:                   return "observe all interactive elements on the page";
        }
      },

      decide: (_candidates, _step) => {
        switch (currentStep) {
          case "dismiss-consent":
            pendingStep = "dismiss-consent";
            currentStep = "set-oneway";
            return {
              type: "act",
              narration: "Accepting Google's cookie consent (if shown)…",
              instruction: "click the 'Accept all' button on the Google cookie/consent banner if one is shown; otherwise do nothing",
            };

          case "set-oneway":
            pendingStep = "set-oneway";
            currentStep = "focus-origin";
            return {
              type: "act",
              narration: "Setting trip type to One way…",
              instruction: "open the trip type dropdown that currently shows 'Round trip' and choose 'One way'",
            };

          case "focus-origin":
            pendingStep = "focus-origin";
            currentStep = "type-origin";
            return {
              type: "act",
              narration: "Selecting the origin field…",
              instruction: "click the 'Where from?' origin input to open the origin search box",
            };

          case "type-origin":
            // Bridge: clear the IP-prefilled origin, then type real keystrokes.
            pendingStep = "type-origin";
            currentStep = "pick-origin";
            isOriginType = true;
            return { type: "extract", narration: `Typing origin "${origin}"…` };

          case "pick-origin":
            pendingStep = "pick-origin";
            currentStep = "focus-destination";
            return {
              type: "act",
              narration: `Selecting origin "${origin}" from suggestions…`,
              instruction: `click the airport or city suggestion option that best matches "${origin}"`,
            };

          case "focus-destination":
            pendingStep = "focus-destination";
            currentStep = "type-destination";
            return {
              type: "act",
              narration: "Selecting the destination field…",
              instruction: "click the 'Where to?' destination input to focus it",
            };

          case "type-destination":
            pendingStep = "type-destination";
            currentStep = "pick-destination";
            isDestType = true;
            return { type: "extract", narration: `Typing destination "${destination}"…` };

          case "pick-destination":
            pendingStep = "pick-destination";
            currentStep = "focus-date";
            return {
              type: "act",
              narration: `Selecting destination "${destination}" from suggestions…`,
              instruction: `click the airport or city suggestion option that best matches "${destination}"`,
            };

          case "focus-date":
            pendingStep = "focus-date";
            currentStep = "type-date";
            return {
              type: "act",
              narration: "Selecting the departure date field…",
              instruction: "click the 'Departure' date input to focus it",
            };

          case "type-date":
            pendingStep = "type-date";
            currentStep = "confirm-date";
            isDateType = true;
            return { type: "extract", narration: `Entering departure date ${departISO || "(unset)"}…` };

          case "confirm-date":
            // Close the calendar FIRST so the next step grounds "Search" to the real
            // Search button, not the date-picker's "Done" (the live-run failure mode).
            pendingStep = "confirm-date";
            currentStep = "click-search";
            return {
              type: "act",
              narration: "Confirming the date…",
              instruction: "click the 'Done' button in the date picker dialog to apply the selected date and close the calendar",
            };

          case "click-search":
            // Bridge (NOT a loop act): Stagehand's grounding intermittently returns a
            // malformed elementId for this button → NoObjectGenerated. The bridge retries
            // the grounded click a few times (each a fresh grounding), then routes to recovery.
            pendingStep = "click-search";
            currentStep = "settle-results";
            isSearchClick = true;
            return { type: "extract", narration: "Searching for flights…" };

          case "settle-results":
            // Results render asynchronously after Search — brief wait before extracting.
            pendingStep = "settle-results";
            currentStep = "extract-verify";
            isSettleResults = true;
            return { type: "extract", narration: "Waiting for flight results to load…" };

          case "extract-verify":
            return { type: "extract", narration: "Reading flight results…" };

          case "recover-reobserve":
            failureCount++;
            if (failureCount >= 2) {
              currentStep = "abort";
              return {
                type: "act",
                narration: "Recovery failed — advancing to final extraction…",
                instruction: "observe what is currently visible on the page",
              };
            }
            currentStep = pendingStep;
            return {
              type: "act",
              narration: "Element not found — re-observing page state before retry…",
              instruction: "observe all interactive elements currently visible on the page",
            };

          case "abort":
            return { type: "extract", narration: "Aborting — reporting current page state…" };

          default: {
            const _exhaustive: never = currentStep;
            void _exhaustive;
            return { type: "extract", narration: "Unknown step — extracting current state…" };
          }
        }
      },

      doExtract: async (extractSh: Stagehand) => {
        // Origin bridge: select-all to clear the IP-prefilled value, then real keystrokes.
        if (isOriginType) {
          isOriginType = false;
          try {
            // Clicking 'Where from?' opens the origin dialog with the IP-prefilled value
            // AUTO-SELECTED, so real keystrokes REPLACE it (scout-verified) and fire the
            // autocomplete (Pitfall 1: fill() would not fire it). No explicit clear is needed —
            // asking the LLM to "clear" made it invent an unsupported `tripleClick` action,
            // which failed Stagehand's action schema (AI_NoObjectGeneratedError).
            await page.type(origin, { delay: 50 });
          } catch (err) {
            if (isRecoverableStagehandError(err)) {
              currentStep = "recover-reobserve";
              return { _bridge: "type-origin" };
            }
            throw err;
          }
          return { _bridge: "type-origin" };
        }

        // Destination bridge.
        if (isDestType) {
          isDestType = false;
          try {
            await page.type(destination, { delay: 50 });
          } catch (err) {
            if (isRecoverableStagehandError(err)) {
              currentStep = "recover-reobserve";
              return { _bridge: "type-destination" };
            }
            throw err;
          }
          return { _bridge: "type-destination" };
        }

        // Date bridge: type the ISO date, then Escape to close the calendar so it does
        // not stay open and block the Search button (the Resy date-picker-stall lesson).
        if (isDateType) {
          isDateType = false;
          try {
            // Type the ISO departure date into the focused Departure field. Closing/confirming
            // the calendar is handled by the click-search step (it closes any open picker
            // first) — the Resy date-picker-stall lesson. Exact date registration is the #1
            // thing to tune on the first live run.
            if (departISO) {
              await page.type(departISO, { delay: 40 });
            }
          } catch (err) {
            if (isRecoverableStagehandError(err)) {
              currentStep = "recover-reobserve";
              return { _bridge: "type-date" };
            }
            throw err;
          }
          return { _bridge: "type-date" };
        }

        // Search-click bridge: click the Search button DETERMINISTICALLY via a locator first
        // (the grounded click intermittently mis-grounds to the date-picker "Done" or emits a
        // malformed elementId → NoObjectGenerated, so the search never runs). Fall back to a
        // grounded click with retries only if no locator matches.
        if (isSearchClick) {
          isSearchClick = false;
          let clicked = false;
          for (const sel of [
            'button[aria-label="Search" i]',
            'button[jsname]:has-text("Search")',
            'button:has-text("Search")',
          ]) {
            try {
              // Cast: Stagehand's Locator type omits .last() (present at runtime via Playwright).
              const loc = page.locator(sel) as unknown as {
                count(): Promise<number>;
                last(): { click(): Promise<void> };
              };
              if (await loc.count()) {
                await loc.last().click();
                clicked = true;
                break;
              }
            } catch {
              // try the next selector
            }
          }
          if (!clicked) {
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await extractSh.act("click the main blue Search button to run the flight search");
                clicked = true;
                break;
              } catch {
                // retry with a fresh grounding
              }
            }
          }
          if (!clicked) currentStep = "recover-reobserve";
          return { _bridge: "click-search" };
        }

        // Settle bridge: Google Flights results render asynchronously after Search;
        // give them a moment so the terminal extract sees the real results list.
        if (isSettleResults) {
          isSettleResults = false;
          // Deterministically wait for the results page (up to ~16s): poll for the results-page
          // UI that only appears AFTER a search runs ("Top flights" / "Best" / "Cheapest" /
          // "Sorted by"). Break as soon as it shows so the extract reads real results instead of
          // a half-loaded page. Falls through after the timeout — no worse than a fixed wait.
          for (let i = 0; i < 16; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            try {
              const sig = page.locator(
                "text=/Top flights|Best flights|Cheapest|Sorted by top flights/i",
              ) as unknown as { count(): Promise<number> };
              if ((await sig.count()) > 0) break;
            } catch {
              // ignore and keep polling
            }
          }
          return { _bridge: "settle-results" };
        }

        // Terminal extraction — page signals for the oracle. Google Flights results render
        // progressively; if the first read looks not-yet-loaded (no results, no "no results",
        // no block), wait briefly and re-extract once to avoid a false "couldn't read results".
        const firstRaw = await extractSh.extract(FLIGHTS_EXTRACT_INSTRUCTION, FlightsVerification);
        const firstParsed = FlightsVerification.safeParse(firstRaw);
        if (
          firstParsed.success &&
          !firstParsed.data.hasResults &&
          !firstParsed.data.isNoResults &&
          !firstParsed.data.isBlockPage
        ) {
          await new Promise((resolve) => setTimeout(resolve, 3500));
          return await extractSh.extract(FLIGHTS_EXTRACT_INSTRUCTION, FlightsVerification);
        }
        return firstRaw;
      },

      verify: (raw) => {
        const r = raw as Record<string, unknown>;
        if (r && typeof r === "object" && "_bridge" in r) {
          return {
            ok: false,
            summary: "",
            reason: `intermediate:${String(r._bridge)}`,
            nonTerminal: true,
          };
        }
        // Re-validate via safeParse, not a blind cast (an LLM mis-shape returns ok:false
        // with a clear reason instead of dereferencing undefined fields).
        const parsed = FlightsVerification.safeParse(raw);
        if (!parsed.success) {
          return { ok: false, summary: "", reason: "extraction did not match FlightsVerification schema" };
        }
        return verifyFlightsResult(parsed.data, intent);
      },
    };

    await runLoop(sh, flow, loopConfig);
      await sh.close();
      return; // success — runLoop already emitted result + done
    } catch (err) {
      await sh.close().catch(() => {});
      // Transient grounding hiccup → retry the whole flow once with a fresh browser.
      if (isRecoverableStagehandError(err) && attempt < MAX_ATTEMPTS) {
        emit({ type: "status", step: 0, text: "Hit a transient page-grounding hiccup — retrying…" });
        continue;
      }
      // Final failure: emit error+done, then rethrow — never swallow.
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      emit({ type: "done" });
      throw err;
    }
  }
}
