/**
 * src/agent/flows/resy.ts
 *
 * Resy booking flow: city-slug URL builder, ResyVerification schema, criterion-5 oracle,
 * and runResyFlow (plan 02-04).
 *
 * Deliverables (this plan — 02-03):
 *   DEC-location / criterion-2  buildResySearchUrl — deterministic SF city-slug URL
 *                                from parsed intent; never IP, never an LLM call.
 *                                Closes todo `hero-location-step`.
 *   criterion-5                 verifyResyResult oracle — gates ok:true on reaching the
 *                                reservation/login screen with matching name + party.
 *                                Never reports done-when-it-isn't (anti-Manus invariant).
 *
 * Anti-patterns avoided:
 *   - sh.page does not exist in v3 — use sh.context.pages()[0]
 *   - page.extract/page.observe do not exist — use sh.extract / sh.observe
 *   - Never open Chromium at import time — createStagehand() + sh.init() inside run function
 *   - Never use IP geolocation for the hero location — city-slug URL is the closed-form fix
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
// DEC-location: Deterministic city-slug map
// "san francisco" → "san-francisco-ca" is the canonical Resy city slug.
// Extend this map as needed for future cities — never guess from IP.
// ---------------------------------------------------------------------------

const RESY_CITY_SLUGS: Record<string, string> = {
  "san francisco": "san-francisco-ca",
  sf: "san-francisco-ca",
};

// ---------------------------------------------------------------------------
// criterion-2: buildResySearchUrl — deterministic city-slug URL builder
// Analog of buildNwsUrl() in weather.ts — same normalization + fail-closed pattern.
// The canonical URL template (RESEARCH §1.1):
//   https://resy.com/cities/${slug}/search?date=${date}&seats=${seats}
// ---------------------------------------------------------------------------

/**
 * Returns the canonical Resy search URL for a known location.
 * Throws descriptively for unknown locations — never silently falls through.
 *
 * Location resolution mirrors buildNwsUrl() exactly:
 *   1. Exact lowercase+trim match
 *   2. Part before a comma (tolerates "San Francisco, CA" from parseIntent)
 *   3. startsWith loop for prefix matches (tolerates "San Francisco CA" etc.)
 *
 * This is the closed form of todo `hero-location-step`:
 * location is resolved deterministically before the browser opens — never IP,
 * never an LLM call (DEC-location, RESEARCH Pitfall 3).
 */
export function buildResySearchUrl(
  location: string,
  date: string,
  seats: number,
): string {
  const norm = location.toLowerCase().trim();
  // Resolve tolerantly: try exact, then the part before a comma, then a startsWith loop.
  let slug = RESY_CITY_SLUGS[norm] ?? RESY_CITY_SLUGS[norm.split(",")[0].trim()];
  if (!slug) {
    for (const k of Object.keys(RESY_CITY_SLUGS)) {
      if (norm === k || norm.startsWith(k + " ") || norm.startsWith(k + ",")) {
        slug = RESY_CITY_SLUGS[k];
        break;
      }
    }
  }
  if (!slug) {
    throw new Error(
      `No Resy city slug for location: "${location}". Add to RESY_CITY_SLUGS.`,
    );
  }

  // WR-02: validate LLM-derived inputs before embedding in the URL.
  // date must be ISO YYYY-MM-DD; an LLM-produced "next friday" or an embedded
  // "&seats=99" would silently inject or truncate query parameters otherwise.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `Invalid date "${date}" — expected YYYY-MM-DD format. Resolve relative dates before calling buildResySearchUrl.`,
    );
  }
  // seats must be a positive integer
  if (!Number.isInteger(seats) || seats < 1) {
    throw new Error(
      `Invalid seats "${seats}" — must be a positive integer.`,
    );
  }

  const qs = new URLSearchParams({ date, seats: String(seats) });
  return `https://resy.com/cities/${slug}/search?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// pickNextAvailableSlot — next-available-slot offer helper (pure, no I/O)
//
// From the open slot labels extracted off the venue page (e.g. "6:45 PM"),
// returns the one CLOSEST to the requested time (24h "HH:MM"). Ties resolve to
// the earlier slot. Unparseable labels are skipped. Returns null when no label
// parses; when requestedTime is null/unparseable, returns the earliest slot.
//
// Powers the "Next available: <slot>" offer when the requested time can't be booked.
// ---------------------------------------------------------------------------

/** Parse a 24h "HH:MM" clock string to minutes-from-midnight, or null. */
function parseClockToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Parse a Resy slot label ("6:45 PM", "7 PM", "12:00 AM") to minutes, or null. */
function parseSlotLabelToMinutes(label: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])$/.exec(label.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h < 1 || h > 12 || min > 59) return null;
  const pm = m[3].toLowerCase() === "pm";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return h * 60 + min;
}

export function pickNextAvailableSlot(
  available: string[],
  requestedTime: string | null,
): string | null {
  // Keep only parseable labels, paired with their minutes-from-midnight.
  const parsed: Array<{ label: string; mins: number }> = [];
  for (const label of available) {
    const mins = parseSlotLabelToMinutes(label);
    if (mins !== null) parsed.push({ label, mins });
  }
  if (parsed.length === 0) return null;

  const reqMins = requestedTime ? parseClockToMinutes(requestedTime) : null;

  // No usable requested time → earliest slot (smallest mins).
  if (reqMins === null) {
    return parsed.reduce((a, b) => (b.mins < a.mins ? b : a)).label;
  }

  // Closest by absolute distance; ties resolve to the earlier slot.
  return parsed.reduce((best, cur) => {
    const dCur = Math.abs(cur.mins - reqMins);
    const dBest = Math.abs(best.mins - reqMins);
    if (dCur < dBest) return cur;
    if (dCur === dBest && cur.mins < best.mins) return cur;
    return best;
  }).label;
}

// ---------------------------------------------------------------------------
// criterion-5: ResyVerification schema (RESEARCH §7.1)
// Analog of WeatherForecast in weather.ts — nullable fields + z.infer alias.
// partySize/date/time are nullable because they may be absent on non-terminal pages.
// ---------------------------------------------------------------------------

export const ResyVerification = z.object({
  restaurantName: z.string(),
  partySize: z.number().nullable(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  isReservationScreen: z.boolean(),
  isLoginPromptShown: z.boolean(),
  noAvailability: z.boolean(),
  venueNotFound: z.boolean(),
  // Open/bookable slot labels shown on the venue page (e.g. ["6:45 PM","7:15 PM"]).
  // preprocess coerces null/undefined/garbage to [] so a missing field never fails parse.
  availableSlots: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.string())),
});

export type ResyVerificationType = z.infer<typeof ResyVerification>;

// ---------------------------------------------------------------------------
// Next-available-slot offer helpers (pure)
// ---------------------------------------------------------------------------

/** Format a 24h "HH:MM" as a 12h label ("19:00" → "7:00 PM"); fallback if null/bad. */
function format12h(hhmm: string | null): string {
  if (!hhmm) return "the requested time";
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  let h = Number(m[1]);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m[2]} ${ampm}`;
}

/**
 * Build a next-available-slot offer when the requested time can't be confirmed.
 * Returns null unless allowOffer is set, a venue name is known, and at least one
 * open slot parses. The positive option NAMES the slot ("Book 6:45 PM") so the
 * server's text-seam retry re-parses the time without extra state.
 */
function buildResyOffer(
  result: ResyVerificationType,
  intent: Intent,
  allowOffer: boolean,
): { venue: string; slot: string; question: string; options: string[] } | null {
  if (!allowOffer) return null;
  const venue = result.restaurantName?.trim();
  if (!venue) return null;
  const next = pickNextAvailableSlot(result.availableSlots ?? [], intent.time);
  if (!next) return null;
  const question = `No ${format12h(intent.time)} table at ${venue} for ${intent.party}. Next available: ${next}.`;
  return { venue, slot: next, question, options: [`Book ${next}`, "No"] };
}

// ---------------------------------------------------------------------------
// criterion-5: verifyResyResult oracle — analog of verifyWeatherResult
// Pure function, no I/O.
//
// ORDERING IS THE INVARIANT (RESEARCH §7.2 / Pitfall 6):
//   1. noAvailability check first — clean graceful outcome (never throw)
//   2. isReservationScreen || isLoginPromptShown gate BEFORE any success path
//      ("never done-when-it-isn't" — the anti-hallucination check)
//   3. Restaurant name substring match (tolerant: "Nobu" matches "Nobu Palo Alto")
//   4. Party size exact match
//   5. Success: all guards passed
//
// Every failure path returns a non-empty reason. Never returns ok:true when
// step-2 guard would fire. This ordering is asserted by the test.
// ---------------------------------------------------------------------------

/**
 * Verifies an extracted ResyVerificationType against the booking intent.
 *
 * @param result  Extracted page signals (Zod-parsed by runResyFlow / test fixtures).
 * @param intent  The parsed booking intent (site, location, target, party, date, time, …).
 * @returns       { ok: boolean; summary: string; reason: string }
 */
export function verifyResyResult(
  result: ResyVerificationType,
  intent: Intent,
  allowOffer = false,
): {
  ok: boolean;
  summary: string;
  reason: string;
  offer?: { venue: string; slot: string; question: string; options: string[] };
} {
  // Step 1: No-availability path — clean graceful outcome (RESEARCH §6.2, T-2-09)
  // Must come first so a no-availability page never reaches the screen-state gate.
  if (result.noAvailability) {
    // If the page still lists open slots, offer the next-available instead of a dead-end.
    const offer = buildResyOffer(result, intent, allowOffer);
    if (offer) return { ok: false, summary: "", reason: "offer", offer };
    return {
      ok: false,
      summary: `No availability for ${intent.party} at ${intent.target} on ${intent.date[0]}`,
      reason: "no-availability",
    };
  }

  // Step 1b: Venue-not-found path — clean graceful outcome (G3a, T-2-04)
  // Inserted AFTER noAvailability and BEFORE the generic screen-state gate so the
  // message names the venue explicitly ("Couldn't find 'X' on Resy in Y — try another
  // venue.") rather than falling through to the generic "Did not reach reservation/login
  // screen" failure.  This must NOT throw and must NOT be emitted as an error event.
  if (result.venueNotFound) {
    return {
      ok: false,
      summary: `Couldn't find "${intent.target}" on Resy in ${intent.location} — try another venue.`,
      reason: "venue-not-found",
    };
  }

  // Step 2: Anti-hallucination gate (Pitfall 6, T-2-08, criterion-5)
  // Must reach a terminal screen before any success path is allowed.
  // This check MUST come before name/party checks — its ordering is the invariant.
  if (!result.isReservationScreen && !result.isLoginPromptShown) {
    // Informative, user-facing summary (the loop surfaces summary || reason).
    // Distinguish "got to the venue but couldn't complete slot selection" from a
    // generic miss, so the chat says what actually happened instead of a bare gate.
    const reachedVenue =
      !!result.restaurantName &&
      result.restaurantName.toLowerCase().includes(intent.target.toLowerCase());
    // Reached the venue but couldn't confirm the requested time — offer the next-available
    // slot if the page lists open ones (instead of the dead-end "try a different time").
    if (reachedVenue) {
      const offer = buildResyOffer(result, intent, allowOffer);
      if (offer) return { ok: false, summary: "", reason: "offer", offer };
    }
    const summary = reachedVenue
      ? `Reached ${result.restaurantName} but couldn't confirm a reservation — no open time slot was selected for ${intent.party} at ${intent.time ?? "the requested time"}. Try a different time or date.`
      : `Couldn't reach a reservation screen for "${intent.target}" — the page didn't get to a selectable time slot. Try a different time or date.`;
    return {
      ok: false,
      summary,
      reason: "Did not reach reservation/login screen",
    };
  }

  // Step 3: Restaurant name must match (tolerant substring — RESEARCH A3)
  // "Nobu" matches "Nobu Palo Alto" via case-insensitive substring check.
  const nameOk = result.restaurantName
    .toLowerCase()
    .includes(intent.target.toLowerCase());
  if (!nameOk) {
    return {
      ok: false,
      summary: "",
      reason: `Restaurant "${result.restaurantName}" does not match intent "${intent.target}"`,
    };
  }

  // Step 4: Party size must match exactly
  if (result.partySize !== intent.party) {
    return {
      ok: false,
      summary: "",
      reason: `Party size ${result.partySize} does not match intent ${intent.party}`,
    };
  }

  // Step 5: All guards passed — success
  return {
    ok: true,
    summary: `Reached reservation screen: ${result.restaurantName} for ${result.partySize} on ${result.date} at ${result.time}`,
    reason: "",
  };
}

// ---------------------------------------------------------------------------
// runResyFlow — plan 02-04
//
// DESIGN NOTE: decide() is a DETERMINISTIC step-state machine (DEC-loop
// "deterministic-first") — not per-step LLM calls. The closure variable
// `currentStep` advances through the scripted sequence on each decide() call.
// The loop guards (25 steps / 5 min / 3-identical) from loop.ts are the
// safety backstop for any stall or unexpected repetition.
//
// Error recovery (criterion 4): on Stagehand element/xpath/click/timeout
// errors, decide() advances currentStep to "recover-reobserve" or "abort" —
// NEVER back to the identical failing step (never-retry-same-action rule).
// The abort path ends on an extract so verifyResyResult reports ok:false
// honestly; no-availability and login-wall are clean ok:false outcomes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ResyStep — step names for the deterministic state machine (RESEARCH §5.2)
// ---------------------------------------------------------------------------

type ResyStep =
  | "dismiss-cookie"
  | "search-venue"
  | "search-typing"    // internal sub-step: page.type real keystrokes bridge
  | "pick-venue"
  | "verify-date"
  | "pick-guests"
  | "pick-time"
  | "click-slot"
  | "extract-verify"
  | "recover-reobserve"
  | "abort";

// ---------------------------------------------------------------------------
// selectNative — try locator.selectOption() with A1/A2 selector candidates,
// fall back to sh.act() natural-language instruction on last failure.
// Documents A3/A1/A2: selectors are assumed from live scout; act() is the
// resilience layer confirmed on the first live run.
// ---------------------------------------------------------------------------

async function selectNative(
  page: ReturnType<Stagehand["context"]["pages"]>[0],
  sh: Stagehand,
  selectorCandidates: string[],
  value: string,
  label: string,
): Promise<void> {
  // Try each candidate selector in order (A1/A2 — assumed from scout; exact
  // aria-label names are confirmed on the first live run).
  let lastErr: unknown;
  for (const sel of selectorCandidates) {
    try {
      await page.locator(sel).selectOption(value);
      return; // success — done
    } catch (err) {
      lastErr = err;
      // continue to next candidate
    }
  }
  // All locator candidates failed — fall back to a11y-grounded natural language
  // act() as the A1/A2 selector-drift resilience layer.
  void lastErr; // acknowledged — falling back
  await sh.act(`select ${value} from the ${label} dropdown`);
}

// ---------------------------------------------------------------------------
// Stagehand error name set — checked by name/message for error-recovery routing
// (RESEARCH §2.8: StagehandElementNotFoundError, XPathResolutionError,
//  ActTimeoutError, StagehandDomProcessError, StagehandClickError)
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
// Extraction instruction for ResyVerification (RESEARCH §2.7 / §7.1)
// ---------------------------------------------------------------------------

const RESY_EXTRACT_INSTRUCTION =
  "Extract the following from the current page: " +
  "restaurantName (the restaurant name shown on this page, or empty string if not visible), " +
  "partySize (the number of guests selected, or null if not visible), " +
  "date (the reservation date shown, or null if not visible), " +
  "time (the reservation time shown, or null if not visible), " +
  "isReservationScreen (true if this page shows a reservation confirmation or slot-booking screen), " +
  "isLoginPromptShown (true if a login or sign-in prompt is currently visible), " +
  "noAvailability (true if the page shows a message indicating no tables are available for the requested party/date), " +
  "venueNotFound (true if the page shows no matching restaurant or 'no results' for the searched venue name, i.e. the requested venue does not exist on Resy in this city), " +
  "availableSlots (an array of the bookable/open reservation time-slot labels currently shown on the page, exactly as displayed, e.g. [\"6:45 PM\", \"7:15 PM\"]; empty array if none are shown).";

// ---------------------------------------------------------------------------
// runResyFlow — entry point for the full Resy booking pipeline
//
// Lifecycle: creates and owns the Stagehand instance.
//   try { init + navigate + loop } catch { emit error+done; rethrow } finally { close }
//
// Error surfacing pattern (never swallows):
//   On any throw: emits { type:"error", message } + { type:"done" } then rethrows.
//   The caller (server.ts runAgent) catches and logs; the ws client sees the error event.
// ---------------------------------------------------------------------------

export async function runResyFlow(
  intent: Intent,
  emit: (event: ServerEventType) => void,
  isCancelled?: () => boolean,
  allowOffer = true,
  onOfferSlots?: (venue: string, slot: string) => void,
): Promise<void> {
  // WR-03: fail loudly before opening Chromium on missing required slots.
  // IntentSchema permits date:[] and party:null; the ws path is guarded by parseIntent's
  // ClarifyNeeded, but runResyFlow is an exported entry point and will be called directly
  // in tests and on future answer-resume paths (server.ts:165-168). Guard here so a bad
  // caller sees a clear error rather than a silent undefined-URL navigation.
  if (!intent.date?.length || !intent.date[0]) {
    throw new Error(
      "runResyFlow requires a resolved date in intent.date[0] (e.g. '2026-06-07'). " +
      "Ensure parseIntent resolved the date before calling runResyFlow.",
    );
  }
  if (intent.party == null) {
    throw new Error(
      "runResyFlow requires a party size in intent.party. " +
      "Ensure parseIntent resolved the party size before calling runResyFlow.",
    );
  }

  const sh = createStagehand(); // lazy factory — no browser yet

  try {
    await sh.init(); // opens headless Chromium
    const page = sh.context.pages()[0]; // v3 page access — NOT sh.page (removed in v3)

    const url = buildResySearchUrl(
      intent.location,
      intent.date[0],
      intent.party ?? 2,
    );
    emit({ type: "status", step: 0, text: `Navigating to ${url}…` });
    await page.goto(url, { waitUntil: "networkidle" });

    // -----------------------------------------------------------------------
    // State-machine closure variables — all declared before flow so closures
    // capture live references (not temporal-dead-zone undefined).
    //
    // Navigation happened above; the loop starts at "dismiss-cookie".
    // -----------------------------------------------------------------------

    let currentStep: ResyStep = "dismiss-cookie";

    // Next-available-slot offer: when verify() returns an offer verdict, record the
    // resolved venue + chosen slot here so runResyFlow can hand them to onOfferSlots
    // after the loop emits the clarify (keeps verify() side-effect-free). A holder object
    // (not a bare `let`) so the post-loop read isn't narrowed to never by control-flow analysis.
    const pendingOffer: { current: { venue: string; slot: string } | null } = { current: null };

    // failureCount + pendingStep: never-retry-same-action→replan (criterion 4).
    // On a Stagehand error, doExtract routes to recover-reobserve, recording
    // the failing step in pendingStep. recover-reobserve retries exactly once.
    let failureCount = 0;
    let pendingStep: ResyStep = "dismiss-cookie";

    // Bridge flags: decide() sets these before returning type:"extract" for steps
    // that need doExtract to perform an action (search-typing, pick-guests, pick-time).
    // SEAM NOTE (page.type adjacency): search-venue splits into two loop cycles:
    //   Cycle A — "search-venue"  → type:"act" (sh.act clicks/focuses search box)
    //   Cycle B — "search-typing" → type:"extract" (doExtract calls page.type with real keystrokes)
    // This keeps page.type(intent.target, {delay:50}) adjacent to the search-box
    // focus without modifying loop.ts. Pitfall 1: fill() does NOT fire autocomplete JS;
    // page.type dispatches keyDown/keyUp per character (VERIFIED: page.d.ts line 322-325).
    let isTypingBridge = false;

    // Guests/Time bridge: same pattern — doExtract calls selectNative() which
    // tries locator.selectOption() candidates (A1/A2) then falls back to sh.act().
    let isGuestsStep = false;
    let isTimeStep = false;

    const loopConfig: LoopConfig = {
      maxSteps: 25,
      timeoutMs: 300_000,
      maxIdentical: 3,
      emit,
      isCancelled,
    };

    const flow: FlowDefinition = {
      // observeInstruction is step-aware so the a11y tree grounds against the
      // relevant region for each step, improving observe quality each cycle.
      get observeInstruction(): string {
        switch (currentStep) {
          case "dismiss-cookie":     return "find the cookie consent or privacy banner accept button";
          case "search-venue":       return "find the restaurant or venue search input box";
          case "search-typing":      return "find the restaurant or venue search input box";
          case "pick-venue":         return `find autocomplete suggestions for ${intent.target}`;
          case "verify-date":        return "find the date picker or selected date display";
          case "pick-guests":        return "find the Guests or party size selector dropdown";
          case "pick-time":          return "find the Time selector dropdown for reservation time";
          case "click-slot":         return "find available reservation time slots to click";
          case "extract-verify":     return "find reservation confirmation or login screen details";
          case "recover-reobserve":  return "observe all interactive elements currently visible on the page";
          case "abort":              return "observe what is currently visible on the page";
          default:                   return "observe all interactive elements on the page";
        }
      },

      // decide() — deterministic step-state machine (DEC-loop "deterministic-first").
      //
      // For each non-bridge step, the pattern is:
      //   1. Save pendingStep (for recovery routing)
      //   2. Advance currentStep to the next step
      //   3. Return { type:"act", instruction } — loop.ts calls sh.act(instruction)
      //
      // For bridge steps (search-typing, pick-guests, pick-time), the pattern is:
      //   1. Set the bridge flag (isTypingBridge / isGuestsStep / isTimeStep)
      //   2. Return { type:"extract" } — loop.ts calls doExtract(sh)
      //   3. doExtract() checks the flag and performs the action (page.type / selectNative)
      //   4. verify() detects the { _bridge } sentinel and returns { nonTerminal:true }
      //      so the loop calls `continue` without emitting result+done
      //
      // The terminal step "extract-verify" returns { type:"extract" } and doExtract()
      // falls through to the real sh.extract() → ResyVerification.safeParse → verifyResyResult
      // → emits the authoritative result+done.
      decide: (_candidates, _step) => {
        switch (currentStep) {
          case "dismiss-cookie":
            // A4: cookie banner may be absent on repeat loads — Stagehand handles
            // "element not found" gracefully for optional elements (no-op if absent).
            pendingStep = "dismiss-cookie";
            currentStep = "search-venue";
            return {
              type: "act",
              narration: "Dismissing cookie consent banner (if present)…",
              instruction: "dismiss the cookie consent banner if present, or click accept on any privacy notice",
            };

          case "search-venue":
            // Cycle A: click/focus the search box. Pitfall 2 (stale ref after cookie
            // dismiss): sh.act() with a string instruction always makes a FRESH LLM
            // grounding call against the current a11y tree — no cached Action ref
            // can survive the cookie-dismissal DOM mutation.
            pendingStep = "search-venue";
            currentStep = "search-typing";
            return {
              type: "act",
              narration: "Clicking restaurant search box…",
              instruction: "click on the restaurant or venue search input box to focus it",
            };

          case "search-typing":
            // Cycle B: type real keystrokes (fires autocomplete JS). Uses the
            // doExtract bridge — see SEAM NOTE above.
            pendingStep = "search-typing";
            currentStep = "pick-venue";
            isTypingBridge = true;
            return {
              type: "extract",
              narration: `Typing "${intent.target}" into search box…`,
            };

          case "pick-venue":
            pendingStep = "pick-venue";
            currentStep = "verify-date";
            return {
              type: "act",
              narration: `Selecting venue matching "${intent.target}" from autocomplete…`,
              instruction: `click the first autocomplete suggestion that best matches "${intent.target}"`,
            };

          case "verify-date":
            // The venue page inherits ?date=YYYY-MM-DD from the search URL, so the date
            // is already applied. Do NOT click into the date control — that opens the
            // calendar dropdown, which can stay open and block the later guests/time/slot
            // steps (observed stall: calendar left open, run ends on the generic miss).
            // Instead, trust the URL date and ensure no picker is open so the next steps
            // act on a clean page. (Option A — live-Gauntlet validated.)
            pendingStep = "verify-date";
            currentStep = "pick-guests";
            return {
              type: "act",
              narration: `Confirming date ${intent.date[0]} (already set via URL)…`,
              instruction:
                `Do NOT open the date picker — the date ${intent.date[0]} is already applied from the page URL. ` +
                `If a date or calendar dropdown is currently open, press Escape to close it without changing the date.`,
            };

          case "pick-guests":
            // Uses doExtract bridge: selectNative() with A1/A2 selectors + act() fallback.
            pendingStep = "pick-guests";
            currentStep = "pick-time";
            isGuestsStep = true;
            return {
              type: "extract",
              narration: `Selecting ${intent.party ?? 2} guests…`,
            };

          case "pick-time":
            // Uses doExtract bridge: selectNative() with A1/A2 selectors + act() fallback.
            pendingStep = "pick-time";
            currentStep = "click-slot";
            isTimeStep = true;
            return {
              type: "extract",
              narration: `Selecting time ${intent.time ?? "19:00"}…`,
            };

          case "click-slot":
            pendingStep = "click-slot";
            currentStep = "extract-verify";
            return {
              type: "act",
              narration: "Clicking an available reservation time slot…",
              instruction: "click an available reservation time slot button",
            };

          case "extract-verify":
            // Terminal step: loop.ts runs doExtract → verifyResyResult → emits result+done.
            return {
              type: "extract",
              narration: "Verifying reservation or login screen…",
            };

          case "recover-reobserve":
            // Never-retry-same-action: on first failure, re-observe and route back
            // to the pending step once. On second failure, advance to abort.
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
            // Abort: ends on extract so verifyResyResult reports ok:false honestly.
            // No-availability and login-wall flow through the oracle — never a crash.
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

      // doExtract — handles four cases:
      //   1. search-typing bridge: page.type() for real-keystroke autocomplete (Pitfall 1)
      //   2. pick-guests bridge: selectNative() with A1/A2 selectors + sh.act() fallback
      //   3. pick-time bridge:   selectNative() with A1/A2 selectors + sh.act() fallback
      //   4. Real extraction:    sh.extract(RESY_EXTRACT_INSTRUCTION, ResyVerification)
      //
      // Bridge steps wrap their Stagehand calls in try/catch to implement the
      // never-retry-same-action recovery (criterion 4):
      //   - Recoverable error: currentStep → "recover-reobserve"; return { _bridge } immediately.
      //   - Non-recoverable error: rethrow — outer try/catch closes the browser and emits error+done.
      //   - Success: return { _bridge } so verify() sets nonTerminal:true and the loop continues.
      //
      // verify() detects the { _bridge } sentinel and returns { nonTerminal:true } — the loop
      // continues without emitting result+done. Only the terminal extraction emits result+done.
      doExtract: async (extractSh: Stagehand) => {
        if (isTypingBridge) {
          isTypingBridge = false;
          try {
            // Real keystrokes — dispatches keyDown/keyUp per character (VERIFIED).
            // Never fill() — Pitfall 1: fill() does not fire autocomplete JS.
            await page.type(intent.target, { delay: 50 });
          } catch (err) {
            if (isRecoverableStagehandError(err)) {
              currentStep = "recover-reobserve";
              return { _bridge: "search-typing" };
            }
            // Non-recoverable: rethrow so the outer try/catch closes the browser
            // and the caller emits error+done. Never swallow (header promise §295-298).
            throw err;
          }
          return { _bridge: "search-typing" };
        }

        if (isGuestsStep) {
          isGuestsStep = false;
          try {
            const partyValue = String(intent.party ?? 2);
            // A1/A2: assumed selector candidates from live scout; act() is the
            // resilience layer confirmed on the first live run (RESEARCH §2.4, A1/A2).
            await selectNative(
              page,
              extractSh,
              [
                `select[aria-label="Guests"]`,
                `select[aria-label="Party size"]`,
                `select[name="seats"]`,
                `select[name="party"]`,
              ],
              partyValue,
              "Guests",
            );
          } catch (err) {
            if (isRecoverableStagehandError(err)) {
              currentStep = "recover-reobserve";
              return { _bridge: "pick-guests" };
            }
            // Non-recoverable: rethrow so the outer try/catch closes the browser
            // and the caller emits error+done. Never swallow (header promise §295-298).
            throw err;
          }
          return { _bridge: "pick-guests" };
        }

        if (isTimeStep) {
          isTimeStep = false;
          try {
            const timeValue = intent.time ?? "19:00";
            // Convert to 12-hr format (Resy shows "7:00 PM" in option text).
            const [hourStr, minStr] = timeValue.split(":");
            const hour24 = parseInt(hourStr ?? "19", 10);
            const min = minStr ?? "00";
            const hour12 = hour24 > 12 ? hour24 - 12 : hour24 === 0 ? 12 : hour24;
            const ampm = hour24 >= 12 ? "PM" : "AM";
            const time12 = `${hour12}:${min} ${ampm}`;

            await selectNative(
              page,
              extractSh,
              [
                `select[aria-label="Time"]`,
                `select[aria-label="Reservation time"]`,
                `select[name="time"]`,
              ],
              time12,
              "Time",
            );
          } catch (err) {
            if (isRecoverableStagehandError(err)) {
              currentStep = "recover-reobserve";
              return { _bridge: "pick-time" };
            }
            // Non-recoverable: rethrow so the outer try/catch closes the browser
            // and the caller emits error+done. Never swallow (header promise §295-298).
            throw err;
          }
          return { _bridge: "pick-time" };
        }

        // Real extraction — extract page signals for the oracle
        return await extractSh.extract(RESY_EXTRACT_INSTRUCTION, ResyVerification);
      },

      // verify() — bridge steps set nonTerminal:true so the loop continues without
      // emitting result+done; real extraction gates through verifyResyResult.
      //
      // Bridge step contract: doExtract returns { _bridge: "<step-name>" } for
      // intermediate steps (search-typing, pick-guests, pick-time). verify() detects
      // this sentinel and returns { nonTerminal: true } — the loop calls `continue`
      // and suppresses result+done for that iteration.
      //
      // Only the terminal "extract-verify" (or "abort") extraction reaches the
      // verifyResyResult oracle and emits the authoritative result+done pair.
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
        // Real extraction: criterion-5 oracle gate — re-validate via safeParse, not a
        // blind cast. If extraction returns a mismatched shape (e.g. a { data } wrapper
        // or an LLM hallucination), safeParse fails and we return ok:false with a clear
        // reason rather than letting verifyResyResult dereference undefined fields.
        const parsed = ResyVerification.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            summary: "",
            reason: "extraction did not match ResyVerification schema",
          };
        }
        const { offer, ...verdict } = verifyResyResult(parsed.data, intent, allowOffer);
        if (offer) {
          // Record for onOfferSlots (post-loop) and turn the offer into a clarify verdict so
          // runLoop emits the question + options and pauses without result/done.
          pendingOffer.current = { venue: offer.venue, slot: offer.slot };
          return {
            ok: false,
            summary: "",
            reason: "offered-alternative",
            clarify: { question: offer.question, options: offer.options },
          };
        }
        return verdict;
      },
    };

    await runLoop(sh, flow, loopConfig);

    // If the flow offered a next-available slot, hand the resolved venue + slot to the
    // server so it can rebuild the saved command (venue-pinned) for the retry on "Book".
    const offered = pendingOffer.current;
    if (offered && onOfferSlots) {
      onOfferSlots(offered.venue, offered.slot);
    }
  } catch (err) {
    // Error surfacing pattern: emit error+done, then rethrow — never swallow.
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
