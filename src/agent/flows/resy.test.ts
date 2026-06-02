/**
 * src/agent/flows/resy.test.ts
 *
 * Wave-0 skeleton: two sections.
 *
 * SECTION 1 — Pure-function units (no browser, no LLM)
 *   buildResySearchUrl() — DEC-location URL builder: SF city-slug + date + seats params
 *   verifyResyResult()   — criterion-5 oracle: reservation/login screen + name + party
 *   These tests run on every commit (offline).
 *   They import ./resy.js which does NOT exist yet (built in plans 02-03/02-04).
 *   Expected offline state: ERR_MODULE_NOT_FOUND → RED_SKELETON_PRESENT signal.
 *
 * SECTION 2 — RUN_LIVE-gated live integration block
 *   Skipped unless RUN_LIVE=1. Exercises runResyFlow() end-to-end.
 *   Plans 02-03/02-04 flip this section green.
 *
 * Runner: node --import tsx/esm --test src/agent/flows/resy.test.ts
 *   Offline: only pure oracle units run (or fail with ERR_MODULE_NOT_FOUND)
 *   Live:    RUN_LIVE=1 node --env-file=.env --import tsx/esm --test src/agent/flows/resy.test.ts
 *
 * Key contracts encoded here:
 *   - DEC-location: buildResySearchUrl() sets SF via city-slug URL, never by IP
 *   - criterion-5 oracle: verifyResyResult() never returns ok:true without isReservationScreen
 *     or isLoginPromptShown — the "never done-when-it-isn't" anti-hallucination gate
 *   - no-availability is a clean graceful outcome: ok:false + reason:"no-availability", not a throw
 *   - RUN_LIVE integration signals (criteria 3/4/5): status, result, screenshot, done
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerEventType } from "../../protocol/events.js";

const isLive = !!process.env.RUN_LIVE;

// ---------------------------------------------------------------------------
// Live venue parameter — NOT hardcoded to Nobu (RESEARCH A3: "Nobu in SF"
// resolves to Nobu Palo Alto; use a confirmed-present SF venue for the live oracle)
// ---------------------------------------------------------------------------
const LIVE_VENUE = process.env.RESY_VENUE ?? "Rich Table";

// ---------------------------------------------------------------------------
// ResyVerificationType — matches the Zod schema in resy.ts (RESEARCH §7.1)
// Defined inline here so oracle tests can run without resy.js importing.
// ---------------------------------------------------------------------------
interface ResyVerificationType {
  restaurantName: string;
  partySize: number | null;
  date: string | null;
  time: string | null;
  isReservationScreen: boolean;
  isLoginPromptShown: boolean;
  noAvailability: boolean;
  venueNotFound: boolean;
  availableSlots?: string[];
}

// ---------------------------------------------------------------------------
// ResyIntent — uses the existing Intent shape (src/agent/intent.ts IntentSchema)
// Defined inline here as a structural alias for test fixtures.
// ---------------------------------------------------------------------------
interface ResyIntent {
  site: string;
  location: string;
  target: string;
  party: number | null;
  date: string[];
  time: string | null;
  constraints: Record<string, unknown>;
}

// Deferred dynamic import — ./resy.js does not exist until plans 02-03/02-04.
// Oracle tests will fail/err with ERR_MODULE_NOT_FOUND until then.
// That is the expected RED state (identical to how weather.test.ts / loop.test.ts
// started in Phase 1).
let buildResySearchUrl: (location: string, date: string, seats: number) => string;

let verifyResyResult: (
  result: ResyVerificationType,
  intent: ResyIntent,
  allowOffer?: boolean
) => {
  ok: boolean;
  summary: string;
  reason: string;
  offer?: { venue: string; slot: string; question: string; options: string[] };
};

let runResyFlow: (
  intent: ResyIntent,
  emit: (event: ServerEventType) => void
) => Promise<void>;

let pickNextAvailableSlot: (
  available: string[],
  requestedTime: string | null
) => string | null;

before(async () => {
  // NOTE: This import will fail with ERR_MODULE_NOT_FOUND until plans 02-03/02-04 create resy.ts.
  // That is the expected RED state for Wave-0 skeletons.
  const mod = await import("./resy.js");
  buildResySearchUrl = mod.buildResySearchUrl;
  verifyResyResult = mod.verifyResyResult;
  runResyFlow = mod.runResyFlow;
  pickNextAvailableSlot = mod.pickNextAvailableSlot;
});

// ---------------------------------------------------------------------------
// SECTION 1c: pickNextAvailableSlot() — next-available-slot offer helper (pure)
// Returns the open slot label closest to the requested time; ties → earlier.
// Powers the "Next available: <slot>" offer when the requested time can't be booked.
// ---------------------------------------------------------------------------
describe("pickNextAvailableSlot() — next-available offer helper (pure)", () => {
  it("returns the open slot closest to the requested time", () => {
    const next = pickNextAvailableSlot(["6:00 PM", "6:45 PM", "7:30 PM"], "19:00");
    assert.equal(next, "6:45 PM"); // 18:45 is 15m away; 19:30 is 30m; 18:00 is 60m
  });

  it("breaks ties toward the earlier slot", () => {
    const next = pickNextAvailableSlot(["6:45 PM", "7:15 PM"], "19:00");
    assert.equal(next, "6:45 PM"); // both 15m from 19:00 → earlier wins
  });

  it("parses minute-less labels like '7 PM'", () => {
    const next = pickNextAvailableSlot(["7 PM", "8 PM"], "19:30");
    assert.equal(next, "7 PM"); // 19:00 and 20:00 both 30m → earlier
  });

  it("skips unparseable labels and picks among the valid ones", () => {
    const next = pickNextAvailableSlot(["", "garbage", "6:45 PM", "7:30 PM"], "19:00");
    assert.equal(next, "6:45 PM");
  });

  it("returns null when no label is parseable", () => {
    assert.equal(pickNextAvailableSlot([], "19:00"), null);
    assert.equal(pickNextAvailableSlot(["--", "soon"], "19:00"), null);
  });

  it("falls back to the earliest slot when requestedTime is null", () => {
    const next = pickNextAvailableSlot(["7:30 PM", "6:00 PM", "8:00 PM"], null);
    assert.equal(next, "6:00 PM");
  });
});

// ---------------------------------------------------------------------------
// SECTION 1d: verifyResyResult() — next-available-slot offer branch
// When the requested time can't be confirmed but the venue lists open slots and
// allowOffer is set, the oracle returns an `offer` instead of the bare failure.
// allowOffer omitted/false → today's graceful failure (no offer).
// ---------------------------------------------------------------------------
describe("verifyResyResult() — next-available-slot offer branch", () => {
  const offerIntent: ResyIntent = {
    site: "resy",
    location: "San Francisco",
    target: "Harajuku Sushi",
    party: 2,
    date: ["2026-06-02"],
    time: "19:00",
    constraints: {},
  };

  // Reached the venue, but no reservation/login screen for the requested time,
  // and the page lists other open slots.
  const reachedButUnconfirmed: ResyVerificationType = {
    restaurantName: "Harajuku Sushi",
    partySize: 2,
    date: "June 2, 2026",
    time: null,
    isReservationScreen: false,
    isLoginPromptShown: false,
    noAvailability: false,
    venueNotFound: false,
    availableSlots: ["5:45 PM", "6:45 PM", "7:30 PM"],
  };

  it("offers the nearest slot when allowOffer and the venue has open slots", () => {
    const out = verifyResyResult(reachedButUnconfirmed, offerIntent, true);
    assert.ok(out.offer, "must return an offer");
    assert.equal(out.offer!.venue, "Harajuku Sushi");
    assert.equal(out.offer!.slot, "6:45 PM"); // closest to 19:00
    assert.deepEqual(out.offer!.options, ["Book 6:45 PM", "No"]);
    assert.match(out.offer!.question, /Harajuku Sushi/);
    assert.match(out.offer!.question, /Next available: 6:45 PM/);
    assert.equal(out.ok, false);
  });

  it("offers on a no-availability page too when slots are listed", () => {
    const noAvail: ResyVerificationType = { ...reachedButUnconfirmed, noAvailability: true };
    const out = verifyResyResult(noAvail, offerIntent, true);
    assert.ok(out.offer, "no-availability + listed slots → offer");
    assert.equal(out.offer!.slot, "6:45 PM");
  });

  it("does NOT offer when allowOffer is false (today's graceful failure)", () => {
    const out = verifyResyResult(reachedButUnconfirmed, offerIntent, false);
    assert.equal(out.offer, undefined, "no offer when allowOffer is false");
    assert.equal(out.ok, false);
    assert.match(out.summary, /Try a different time or date/);
  });

  it("does NOT offer when there are no open slots", () => {
    const noSlots: ResyVerificationType = { ...reachedButUnconfirmed, availableSlots: [] };
    const out = verifyResyResult(noSlots, offerIntent, true);
    assert.equal(out.offer, undefined, "no offer when no slots");
    assert.equal(out.ok, false);
  });
});

// ---------------------------------------------------------------------------
// SECTION 1a: buildResySearchUrl() — DEC-location URL builder (pure function)
// Locks the city-slug contract: SF + alias + state-suffix tolerance + fail-closed
// ---------------------------------------------------------------------------
describe("buildResySearchUrl() — DEC-location URL builder (pure function)", () => {
  const SLUG = "san-francisco-ca";
  const FULL_URL = "https://resy.com/cities/san-francisco-ca/search?date=2026-06-07&seats=2";

  it("resolves canonical 'San Francisco' to the correct Resy city-slug URL", () => {
    const url = buildResySearchUrl("San Francisco", "2026-06-07", 2);
    assert.equal(url, FULL_URL, "must return the full canonical Resy URL for SF");
    assert.ok(url.includes(SLUG), "URL must contain slug 'san-francisco-ca'");
    assert.ok(url.includes("date=2026-06-07"), "URL must include date param");
    assert.ok(url.includes("seats=2"), "URL must include seats param");
  });

  it("resolves the 'SF' alias to the same slug", () => {
    const url = buildResySearchUrl("SF", "2026-06-07", 2);
    assert.ok(url.includes(SLUG), "SF alias must resolve to slug 'san-francisco-ca'");
    assert.ok(url.includes("date=2026-06-07"), "URL must include date param");
    assert.ok(url.includes("seats=2"), "URL must include seats param");
  });

  it("tolerates the state-suffixed forms parseIntent actually returns", () => {
    // parseIntent() returns "San Francisco, CA" / "San Francisco CA" — both must resolve
    assert.ok(buildResySearchUrl("San Francisco, CA", "2026-06-07", 2).includes(SLUG),
      "'San Francisco, CA' must resolve to slug 'san-francisco-ca'");
    assert.ok(buildResySearchUrl("San Francisco CA", "2026-06-07", 2).includes(SLUG),
      "'San Francisco CA' must resolve to slug 'san-francisco-ca'");
    assert.ok(buildResySearchUrl("san francisco, ca", "2026-06-07", 2).includes(SLUG),
      "lowercase 'san francisco, ca' must resolve");
    assert.ok(buildResySearchUrl("SF, CA", "2026-06-07", 2).includes(SLUG),
      "'SF, CA' must resolve to slug 'san-francisco-ca'");
    assert.ok(buildResySearchUrl("sf, ca", "2026-06-07", 2).includes(SLUG),
      "lowercase 'sf, ca' must resolve");
  });

  it("fails closed on an unknown location (never silently defaults)", () => {
    assert.throws(
      () => buildResySearchUrl("Tokyo", "2026-06-07", 2),
      /No Resy city slug/,
      "must throw with /No Resy city slug/ for unknown locations"
    );
  });

  it("encodes the date and seats params correctly for different inputs", () => {
    const url4 = buildResySearchUrl("San Francisco", "2026-07-04", 4);
    assert.ok(url4.includes("date=2026-07-04"), "date param must match input");
    assert.ok(url4.includes("seats=4"), "seats param must match input");
  });
});

// ---------------------------------------------------------------------------
// SECTION 1b: verifyResyResult() — criterion-5 oracle (pure function)
// Locks the anti-hallucination contract: ok:true is impossible without
// reaching the reservation/login screen (RESEARCH §7.2)
// ---------------------------------------------------------------------------
describe("verifyResyResult() — criterion-5 oracle (pure function)", () => {

  // Shared intent fixture (complete — so ClarifyNeeded never fires in real flow)
  const baseIntent: ResyIntent = {
    site: "resy",
    location: "San Francisco",
    target: "Nobu",
    party: 2,
    date: ["2026-06-07"],
    time: "19:00",
    constraints: {},
  };

  it("ok:true ONLY when isReservationScreen:true AND name matches AND party matches", () => {
    const result: ResyVerificationType = {
      restaurantName: "Nobu Palo Alto",
      partySize: 2,
      date: "June 7, 2026",
      time: "7:00 PM",
      isReservationScreen: true,
      isLoginPromptShown: false,
      noAvailability: false,
      venueNotFound: false,
    };
    const out = verifyResyResult(result, baseIntent);
    assert.equal(out.ok, true, "must return ok:true on full match");
    assert.ok(out.summary.length > 0, "summary must be non-empty on success");
  });

  it("TOLERANT SUBSTRING: 'Nobu' matches 'Nobu Palo Alto' (RESEARCH A3)", () => {
    // The tolerated substring fixture — proving partial name match works
    const result: ResyVerificationType = {
      restaurantName: "Nobu Palo Alto",  // full name on reservation screen
      partySize: 2,
      date: "June 7, 2026",
      time: "7:00 PM",
      isReservationScreen: true,
      isLoginPromptShown: false,
      noAvailability: false,
      venueNotFound: false,
    };
    const intent: ResyIntent = { ...baseIntent, target: "Nobu" };
    const out = verifyResyResult(result, intent);
    assert.equal(out.ok, true, "'Nobu' must match 'Nobu Palo Alto' via tolerant substring");
  });

  it("ok:true when isLoginPromptShown:true (login screen is the accepted DEC-hero terminal state)", () => {
    // The hero stops at the reservation/login screen — login screen showing the slot is ok
    const result: ResyVerificationType = {
      restaurantName: "Nobu Palo Alto",
      partySize: 2,
      date: "June 7, 2026",
      time: "7:00 PM",
      isReservationScreen: false,   // reservation screen not shown yet
      isLoginPromptShown: true,     // login prompt is the terminal state per DEC-hero
      noAvailability: false,
      venueNotFound: false,
    };
    const out = verifyResyResult(result, baseIntent);
    assert.equal(out.ok, true, "login screen with matching name/party is the accepted terminal state");
  });

  it("ok:false with reason matching /no-availability/ when noAvailability:true — does NOT throw", () => {
    // Clean graceful outcome — not a crash (RESEARCH §6.2)
    const result: ResyVerificationType = {
      restaurantName: "",
      partySize: null,
      date: null,
      time: null,
      isReservationScreen: false,
      isLoginPromptShown: false,
      noAvailability: true,
      venueNotFound: false,
    };
    // Must not throw — no-availability is graceful
    let out: { ok: boolean; summary: string; reason: string } | undefined;
    assert.doesNotThrow(() => {
      out = verifyResyResult(result, baseIntent);
    }, "no-availability must return gracefully, never throw");
    assert.equal(out!.ok, false, "ok must be false for no-availability");
    assert.match(out!.reason, /no-availability/, "reason must match /no-availability/");
    assert.ok(out!.reason.length > 0, "reason must be non-empty");
  });

  it("ANTI-HALLUCINATION GATE: ok:false when both isReservationScreen AND isLoginPromptShown are false", () => {
    // This is the criterion-5 gate: never reports done-when-it-isn't
    // Even if name and party match, the screen state veto is mandatory
    const result: ResyVerificationType = {
      restaurantName: "Nobu Palo Alto",
      partySize: 2,
      date: "June 7, 2026",
      time: "7:00 PM",
      isReservationScreen: false,    // <-- NOT on reservation screen
      isLoginPromptShown: false,     // <-- NOT on login screen either
      noAvailability: false,
      venueNotFound: false,
    };
    const out = verifyResyResult(result, baseIntent);
    assert.equal(out.ok, false,
      "ok must be false when neither isReservationScreen nor isLoginPromptShown — anti-hallucination gate");
    assert.ok(out.reason.length > 0, "reason must be non-empty on failure");
  });

  it("generic gate: informative summary names the venue reached (verdict messaging)", () => {
    // When the agent got to the venue but no slot was selectable, the user-facing
    // summary must explain that — not surface the bare internal gate reason. The
    // internal `reason` stays stable for the ordering invariant + existing tests.
    const result: ResyVerificationType = {
      restaurantName: "Nobu Palo Alto",
      partySize: 2,
      date: "June 7, 2026",
      time: "7:00 PM",
      isReservationScreen: false,
      isLoginPromptShown: false,
      noAvailability: false,
      venueNotFound: false,
    };
    const out = verifyResyResult(result, baseIntent);
    assert.equal(out.ok, false);
    assert.ok(out.summary.length > 0, "summary must be informative, not empty");
    assert.match(out.summary, /Nobu Palo Alto/, "summary should name the venue reached");
    assert.equal(
      out.reason,
      "Did not reach reservation/login screen",
      "internal reason unchanged (ordering invariant + existing assertions)",
    );
  });

  it("ok:false on restaurant-name mismatch", () => {
    const result: ResyVerificationType = {
      restaurantName: "Bix",          // wrong restaurant
      partySize: 2,
      date: "June 7, 2026",
      time: "7:00 PM",
      isReservationScreen: true,
      isLoginPromptShown: false,
      noAvailability: false,
      venueNotFound: false,
    };
    const out = verifyResyResult(result, baseIntent);
    assert.equal(out.ok, false, "ok must be false on name mismatch");
    assert.ok(out.reason.length > 0, "reason must be non-empty on name mismatch");
  });

  it("ok:false on party-size mismatch", () => {
    const result: ResyVerificationType = {
      restaurantName: "Nobu Palo Alto",
      partySize: 4,                   // wrong party size
      date: "June 7, 2026",
      time: "7:00 PM",
      isReservationScreen: true,
      isLoginPromptShown: false,
      noAvailability: false,
      venueNotFound: false,
    };
    const out = verifyResyResult(result, baseIntent);
    assert.equal(out.ok, false, "ok must be false on party-size mismatch");
    assert.ok(out.reason.length > 0, "reason must be non-empty on party mismatch");
  });

  it("ok:false produces a non-empty reason in all failure cases", () => {
    // Invariant check: every false outcome has a reason the caller can surface
    const failureCases: [ResyVerificationType, ResyIntent, string][] = [
      [
        { restaurantName: "", partySize: null, date: null, time: null,
          isReservationScreen: false, isLoginPromptShown: false, noAvailability: false,
          venueNotFound: false },
        baseIntent,
        "empty state"
      ],
      [
        { restaurantName: "Wrong Place", partySize: 2, date: "June 7, 2026", time: "7:00 PM",
          isReservationScreen: true, isLoginPromptShown: false, noAvailability: false,
          venueNotFound: false },
        baseIntent,
        "name mismatch on reservation screen"
      ],
      [
        { restaurantName: "Nobu Palo Alto", partySize: null, date: "June 7, 2026", time: "7:00 PM",
          isReservationScreen: true, isLoginPromptShown: false, noAvailability: false,
          venueNotFound: false },
        baseIntent,
        "null party size"
      ],
    ];
    for (const [result, intent, label] of failureCases) {
      const out = verifyResyResult(result, intent);
      assert.equal(out.ok, false, `${label}: ok must be false`);
      assert.ok(out.reason.length > 0, `${label}: reason must be non-empty`);
    }
  });

  // -------------------------------------------------------------------------
  // G3a: venue-not-found tests
  // These prove that an absent venue yields a clear named not-found message
  // (clean ok:false outcome) and that this branch precedes the generic
  // "Did not reach reservation/login screen" gate in the ordering invariant.
  // -------------------------------------------------------------------------

  it("G3a: ok:false + reason:'venue-not-found' + venue-named summary when venueNotFound:true — does NOT throw", () => {
    // Clean graceful outcome analogous to no-availability — never a throw
    const result: ResyVerificationType = {
      restaurantName: "",
      partySize: null,
      date: null,
      time: null,
      isReservationScreen: false,
      isLoginPromptShown: false,
      noAvailability: false,
      venueNotFound: true,
    };
    const intent: ResyIntent = { ...baseIntent, target: "Nobu", location: "San Francisco" };

    let out: { ok: boolean; summary: string; reason: string } | undefined;
    assert.doesNotThrow(() => {
      out = verifyResyResult(result, intent);
    }, "venue-not-found must return gracefully, never throw");
    assert.equal(out!.ok, false, "ok must be false for venue-not-found");
    assert.equal(out!.reason, "venue-not-found", "reason must be 'venue-not-found'");
    assert.ok(out!.summary.includes("Nobu"), "summary must contain the venue name 'Nobu'");
    assert.ok(out!.summary.includes("on Resy in"), "summary must contain 'on Resy in'");
  });

  it("G3a ORDERING: venueNotFound:true ranks ABOVE generic 'Did not reach reservation/login screen'", () => {
    // Ordering proof: when both venueNotFound is true AND the screen state is non-terminal,
    // the result must be "venue-not-found" (NOT the generic gate) because the new branch
    // is inserted BEFORE step 2 in the ordering invariant.
    const result: ResyVerificationType = {
      restaurantName: "",
      partySize: null,
      date: null,
      time: null,
      isReservationScreen: false,   // would trigger generic gate if venueNotFound were absent
      isLoginPromptShown: false,    // would trigger generic gate if venueNotFound were absent
      noAvailability: false,
      venueNotFound: true,          // venue-not-found must win over the generic gate
    };
    const intent: ResyIntent = { ...baseIntent, target: "Nobu", location: "San Francisco" };
    const out = verifyResyResult(result, intent);
    assert.equal(out.ok, false, "ok must be false");
    assert.equal(out.reason, "venue-not-found",
      "venue-not-found must outrank the generic 'Did not reach reservation/login screen' gate");
    assert.notEqual(out.reason, "Did not reach reservation/login screen",
      "the generic gate must NOT fire when venueNotFound is true");
  });
});

// ---------------------------------------------------------------------------
// SECTION 2: RUN_LIVE-gated live integration block
// Skipped unless RUN_LIVE=1. Plans 02-03/02-04 flip this section green.
//
// Run with:
//   RUN_LIVE=1 node --env-file=.env --import tsx/esm --test src/agent/flows/resy.test.ts
//
// Set RESY_VENUE to override the demo venue (default: "Rich Table"):
//   RESY_VENUE="Ernest" RUN_LIVE=1 node --env-file=.env --import tsx/esm --test ...
//
// Note: exact <select> aria-labels (A1/A2) and venue availability are confirmed
// on the first live run (plan 02-04). The deferred RESY_VENUE param avoids
// hardcoding "Nobu in SF" as the live fixture (RESEARCH A3 — Nobu Palo Alto;
// use a confirmed-present SF venue — Rich Table or Ernest — for the live oracle).
// ---------------------------------------------------------------------------
describe("runResyFlow() — live integration (criteria 3/4/5)", { skip: !isLive }, () => {
  it("criteria 3/4/5: full Resy booking pipeline for SF venue reservation/login screen", async () => {
    // Collect all emitted events
    const events: ServerEventType[] = [];
    const emit = (e: ServerEventType) => events.push(e);

    // Complete intent fixture — all required slots filled so ClarifyNeeded never fires
    // target: LIVE_VENUE is a confirmed-present SF venue (process.env.RESY_VENUE ?? "Rich Table")
    // The "Nobu in SF" command from the brief is the INTENT-PARSE example (criterion 1),
    // not the live oracle target (RESEARCH A3 — "Nobu SF" is not on Resy).
    const intent: ResyIntent = {
      site: "resy",
      location: "San Francisco",
      target: LIVE_VENUE,
      party: 2,
      date: ["2026-06-14"],    // near-future Saturday (2 weeks out from 2026-05-31)
      time: "19:00",
      constraints: {},
    };

    await runResyFlow(intent, emit);

    // -----------------------------------------------------------------------
    // criterion 3: agent narrated its steps (at least one status event emitted)
    // -----------------------------------------------------------------------
    const statusEvents = events.filter((e) => e.type === "status");
    assert.ok(statusEvents.length > 0, "criterion 3: at least one status event must be emitted");

    // -----------------------------------------------------------------------
    // criterion 4/5: result event with ok:true OR clean no-availability outcome
    // Both are valid live outcomes (RESEARCH §14.3 / VALIDATION §54-64):
    //   - ok:true   → reached reservation/login screen with the selected slot
    //   - ok:false + reason:"no-availability" → graceful outcome, not a crash
    // Assert it is a `result` event, NOT an `error` event
    // -----------------------------------------------------------------------
    const resultEvent = events.find((e) => e.type === "result");
    assert.ok(resultEvent, "criterion 4: a result event must be emitted (not error)");

    // No error event allowed — no-availability must be graceful, not a crash
    const errorEvent = events.find((e) => e.type === "error");
    assert.ok(!errorEvent, "criterion 5: no error event — no-availability must be graceful");

    // Either ok:true, or ok:false with no-availability in the summary field.
    // Note: loop.ts emits result.summary = verdict.summary || verdict.reason — reason is
    // NOT a separate field on the result event (it is collapsed into summary).
    const result = resultEvent as { type: string; ok: boolean; summary?: string };
    const isSuccess = result.ok === true;
    // verifyResyResult returns summary: "No availability for N at Venue on date"
    // loop.ts emits summary = verdict.summary || verdict.reason — summary wins over reason.
    // Match case-insensitively for "no" + optional hyphen + "availability" in the summary.
    const isNoAvailability =
      result.ok === false &&
      typeof result.summary === "string" &&
      /no.?availability/i.test(result.summary);
    assert.ok(
      isSuccess || isNoAvailability,
      `criterion 4/5: result.ok must be true, OR result.ok:false with summary containing "no-availability" (or "No availability"). Got: ok=${result.ok}, summary="${result.summary}"`
    );

    // -----------------------------------------------------------------------
    // criterion 3 (screenshot): screenshot event with valid JPEG magic bytes
    // -----------------------------------------------------------------------
    const screenshotEvent = events.find((e) => e.type === "screenshot");
    assert.ok(screenshotEvent, "criterion 3: a screenshot event must be emitted");
    const jpegBase64 = (screenshotEvent as { type: string; jpegBase64: string }).jpegBase64;
    assert.ok(jpegBase64.length > 0, "screenshot: jpegBase64 must be non-empty");
    // JPEG magic bytes: FF D8
    const magicHex = Buffer.from(jpegBase64, "base64").subarray(0, 2).toString("hex");
    assert.equal(magicHex, "ffd8", "screenshot: image must start with JPEG magic bytes FF D8");

    // -----------------------------------------------------------------------
    // done event emitted (loop completed cleanly)
    // -----------------------------------------------------------------------
    const doneEvent = events.find((e) => e.type === "done");
    assert.ok(doneEvent, "criterion 4: a done event must be emitted at the end");

    // -----------------------------------------------------------------------
    // Save the final screenshot to a reviewable path for the human checkpoint.
    // Uses the LAST screenshot event (most recent browser frame).
    // Path is relative to the project root (two levels up from src/agent/flows/).
    // SECURITY: only the JPEG bytes are written, no key value.
    // -----------------------------------------------------------------------
    const allScreenshots = events.filter((e) => e.type === "screenshot");
    const lastScreenshot = allScreenshots[allScreenshots.length - 1] as
      | { type: string; jpegBase64: string }
      | undefined;
    if (lastScreenshot?.jpegBase64) {
      const proofPath = join(
        import.meta.dirname,
        "../../../live-proof/resy-live-proof.jpg",
      );
      await writeFile(proofPath, Buffer.from(lastScreenshot.jpegBase64, "base64"));
      console.log(`[live-proof] screenshot saved → ${proofPath}`);
    }
  });
});
