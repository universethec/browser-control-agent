/**
 * src/agent/intent.test.ts
 *
 * Wave-0 RED skeleton: test contracts for intent.ts (built in plan 01-02).
 *
 * This file imports ./intent.js which does NOT exist yet — it is built in plan 01-02.
 * These tests will fail/error with ERR_MODULE_NOT_FOUND until that plan runs.
 * That is expected. The skeletons encode the contracts plan 01-02 must satisfy.
 *
 * Runner: node --import tsx/esm --test src/agent/intent.test.ts
 *
 * Pure-function units (run offline, no LLM):
 *   - resolveWeekendDates() — returns the ISO dates for the upcoming Sat+Sun
 *
 * Mock-LLM contract test (asserts shape of parseIntent output):
 *   - returns an object satisfying IntentSchema { site, location, target, party, date, time, constraints }
 *   - location contains "San Francisco" for the SF weekend weather command
 *   - date is the resolved weekend ISO array
 *
 * SECURITY (T-00-03): KEYS save/restore block strips API keys from env
 * so these unit tests never accidentally hit a live LLM.
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Env key save/restore (verbatim from src/config/env.test.ts lines 34-60)
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
let savedEnv: Partial<Record<(typeof KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

// Deferred dynamic import — ./intent.js does not exist until plan 01-02
// This will throw ERR_MODULE_NOT_FOUND until intent.ts is created.
// That is the expected RED state.
let resolveWeekendDates: (isoDate: string) => string[];
let parseIntent: (command: string, _llmCallFn?: unknown) => Promise<unknown>;
let ClarifyNeeded: typeof import("./intent.js").ClarifyNeeded;

before(async () => {
  // NOTE: This import will fail with ERR_MODULE_NOT_FOUND until plan 01-02 creates intent.ts.
  // That is the expected RED state for Wave-0 skeletons.
  const mod = await import("./intent.js");
  resolveWeekendDates = mod.resolveWeekendDates;
  parseIntent = mod.parseIntent;
  ClarifyNeeded = mod.ClarifyNeeded;
});

// ---------------------------------------------------------------------------
// resolveWeekendDates() — pure function, no LLM, testable immediately
// ---------------------------------------------------------------------------
describe("resolveWeekendDates()", () => {
  it("2026-05-30 (Saturday) resolves to [2026-05-30, 2026-05-31]", () => {
    // Saturday input → same Saturday + following Sunday
    // NOTE: 2026-05-30 is the actual Saturday (2026-05-31 is Sunday per UTC calendar).
    const dates = resolveWeekendDates("2026-05-30");
    assert.deepEqual(dates, ["2026-05-30", "2026-05-31"]);
  });

  it("a Wednesday resolves to the upcoming Sat+Sun (not same-week Mon/Tue)", () => {
    // 2026-06-03 is a Wednesday
    const dates = resolveWeekendDates("2026-06-03");
    // Upcoming weekend: 2026-06-06 (Sat) + 2026-06-07 (Sun)
    assert.deepEqual(dates, ["2026-06-06", "2026-06-07"]);
  });

  it("a Sunday resolves to the NEXT weekend (following Sat+Sun, not same-day Sun)", () => {
    // 2026-06-07 is a Sunday — should return the next Sat+Sun (not this Sun again)
    const dates = resolveWeekendDates("2026-06-07");
    // Next weekend: 2026-06-13 (Sat) + 2026-06-14 (Sun)
    assert.deepEqual(dates, ["2026-06-13", "2026-06-14"]);
  });

  it("returns an array of exactly 2 ISO date strings", () => {
    const dates = resolveWeekendDates("2026-05-31");
    assert.equal(dates.length, 2);
    // Both must be valid ISO date strings (YYYY-MM-DD)
    assert.match(dates[0], /^\d{4}-\d{2}-\d{2}$/);
    assert.match(dates[1], /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// parseIntent() — mock-LLM contract test
// Tests the shape of the output, not the live LLM call.
// The actual LLM call is stubbed: keys are stripped (beforeEach removes them).
// Plan 01-02 must implement parseIntent so it can work with a mocked response.
// ---------------------------------------------------------------------------
describe("parseIntent() — IntentSchema contract (mock path)", () => {
  it("returns an object satisfying IntentSchema shape for SF weekend weather command", async () => {
    // IN-01: This test now DRIVES parseIntent with an injected mockFn (matching
    // the Resy mock-path test below) instead of only documenting the contract.
    // The weather path is the default branch in server.ts, so it must have real
    // behavioral coverage. Keys are stripped by beforeEach, so the mock path
    // must resolve without hitting a live LLM.

    // Sanity-check the pure date helper the contract relies on.
    // NOTE: 2026-05-30 is Saturday; 2026-05-31 is Sunday (UTC). Using the Saturday fixture.
    const weekendDates = resolveWeekendDates("2026-05-30");
    assert.deepEqual(weekendDates, ["2026-05-30", "2026-05-31"]);

    // Mock LLM returns a complete weather intent object directly.
    // parseIntent's .data unwrap tolerates an object returned directly (no .data wrapper).
    const mockWeatherIntent = {
      site: "weather",
      location: "San Francisco",
      target: "weather",
      party: null,
      date: expect_weekend_iso_array(), // ["2026-05-31", "2026-06-01"]
      time: null,
      constraints: {},
    };
    const mockFn = async () => mockWeatherIntent;

    const result = (await parseIntent(
      "weekend weather forecast for SF",
      mockFn,
    )) as typeof mockWeatherIntent;

    // Assert the IntentSchema shape + key field values that server.ts routes on.
    assert.equal(result.site, "weather");
    assert.match(result.location, expect_contains_sf_string()); // "San Francisco" or "SF"
    assert.equal(result.target, "weather");
    assert.equal(result.party, null);
    assert.equal(result.time, null);
    assert.equal(result.date.length, 2);
    assert.match(result.date[0], /^\d{4}-\d{2}-\d{2}$/);
    assert.match(result.date[1], /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// parseIntent() — Resy intent shape (mock path)
// ---------------------------------------------------------------------------
describe("parseIntent() — Resy intent shape (mock path)", () => {
  it("returns a Resy intent with correct shape for a booking command", async () => {
    // Build a mock _llmCallFn that returns a complete Resy intent object directly.
    // parseIntent's .data unwrap tolerates an object returned directly (no .data wrapper).
    const mockResyIntent = {
      site: "resy",
      location: "San Francisco",
      target: "Nobu",
      party: 2,
      date: ["2026-06-07"],
      time: "19:00",
      constraints: {},
    };
    const mockFn = async () => mockResyIntent;

    const result = await parseIntent(
      "book a table for 2 at 7pm at Nobu in SF",
      mockFn,
    ) as typeof mockResyIntent;

    assert.equal(result.site, "resy");
    assert.match(result.target, /nobu/i);
    assert.equal(result.party, 2);
    assert.equal(result.time, "19:00");
    assert.equal(result.date.length, 1);
    assert.match(result.date[0], /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// parseIntent() — ClarifyNeeded on missing Resy slot (criterion 1)
// ---------------------------------------------------------------------------
describe("parseIntent() — ClarifyNeeded on missing Resy slot (criterion 1)", () => {
  it("throws ClarifyNeeded when target is missing (empty string)", async () => {
    const mockFn = async () => ({
      site: "resy",
      location: "San Francisco",
      target: "",
      party: 2,
      date: ["2026-06-07"],
      time: "19:00",
      constraints: {},
    });

    await assert.rejects(
      () => parseIntent("book a table", mockFn),
      (err: unknown) =>
        err instanceof ClarifyNeeded &&
        /restaurant/i.test(err.question),
    );
  });

  it("throws ClarifyNeeded when the model fills target with a placeholder ('<UNKNOWN>')", async () => {
    // Regression: a venue-less command makes the model emit a placeholder, not "".
    // Must ask 'which restaurant?', not literally search '<UNKNOWN>'.
    const mockFn = async () => ({
      site: "resy",
      location: "San Francisco",
      target: "<UNKNOWN>",
      party: 2,
      date: ["2026-06-07"],
      time: "19:00",
      constraints: {},
    });

    await assert.rejects(
      () => parseIntent("I want you to book a table for 2 at 7pm", mockFn),
      (err: unknown) =>
        err instanceof ClarifyNeeded &&
        /restaurant/i.test(err.question),
    );
  });

  it("target-missing clarify invites a cuisine/description, not only a venue name (clarify-loop fix)", async () => {
    // Regression for the multi-round clarify loop (HANDOFF active bug): the target
    // question must signal that a cuisine/description (e.g. "sushi") is an acceptable
    // answer. The old copy ("Which restaurant are you looking for?") funneled users
    // into giving only a proper venue name, which the parser then re-blanked → loop.
    const mockFn = async () => ({
      site: "resy",
      location: "San Francisco",
      target: "",
      party: 2,
      date: ["2026-06-07"],
      time: "19:00",
      constraints: {},
    });

    await assert.rejects(
      () => parseIntent("book a table for 2 tomorrow in SF", mockFn),
      (err: unknown) =>
        err instanceof ClarifyNeeded &&
        /restaurant/i.test(err.question) &&             // existing contract preserved
        /cuisine|type of food|sushi/i.test(err.question), // new: invites a description
    );
  });

  it("throws ClarifyNeeded when party is null, with options", async () => {
    const mockFn = async () => ({
      site: "resy",
      location: "San Francisco",
      target: "Nobu",
      party: null,
      date: ["2026-06-07"],
      time: "19:00",
      constraints: {},
    });

    await assert.rejects(
      () => parseIntent("book a table", mockFn),
      (err: unknown) => {
        if (!(err instanceof ClarifyNeeded)) return false;
        if (!/guests/i.test(err.question)) return false;
        // Must carry the options list ["1".."6+"]
        assert.ok(Array.isArray(err.options), "options must be an array");
        assert.ok((err.options as string[]).length > 0, "options must be non-empty");
        return true;
      },
    );
  });

  it("throws ClarifyNeeded when date is empty array", async () => {
    const mockFn = async () => ({
      site: "resy",
      location: "San Francisco",
      target: "Nobu",
      party: 2,
      date: [],
      time: "19:00",
      constraints: {},
    });

    await assert.rejects(
      () => parseIntent("book a table", mockFn),
      (err: unknown) =>
        err instanceof ClarifyNeeded &&
        /date/i.test(err.question),
    );
  });

  it("throws ClarifyNeeded when the model fills date with a non-ISO placeholder ('/UNKNOWN/')", async () => {
    // Regression: a no-date command makes the model emit a placeholder, not [].
    // The placeholder must trigger clarify, not leak into buildResySearchUrl.
    const mockFn = async () => ({
      site: "resy",
      location: "San Francisco",
      target: "Nobu",
      party: 2,
      date: ["/UNKNOWN/"],
      time: "19:00",
      constraints: {},
    });

    await assert.rejects(
      () => parseIntent("reserve a sushi place for 2 in SF", mockFn),
      (err: unknown) =>
        err instanceof ClarifyNeeded &&
        /date/i.test(err.question),
    );
  });

  it("throws ClarifyNeeded when the model fills time with a non-HH:MM placeholder ('/UNKNOWN/')", async () => {
    const mockFn = async () => ({
      site: "resy",
      location: "San Francisco",
      target: "Nobu",
      party: 2,
      date: ["2026-06-07"],
      time: "/UNKNOWN/",
      constraints: {},
    });

    await assert.rejects(
      () => parseIntent("book a table for 2 at Nobu in SF", mockFn),
      (err: unknown) =>
        err instanceof ClarifyNeeded &&
        /time/i.test(err.question),
    );
  });

  it("throws ClarifyNeeded when time is null", async () => {
    const mockFn = async () => ({
      site: "resy",
      location: "San Francisco",
      target: "Nobu",
      party: 2,
      date: ["2026-06-07"],
      time: null,
      constraints: {},
    });

    await assert.rejects(
      () => parseIntent("book a table", mockFn),
      (err: unknown) =>
        err instanceof ClarifyNeeded &&
        /time/i.test(err.question),
    );
  });

  it("does NOT throw ClarifyNeeded for a weather intent (party=null, time=null preserved)", async () => {
    const mockFn = async () => ({
      site: "weather",
      location: "San Francisco",
      target: "weather",
      party: null,
      date: ["2026-06-07", "2026-06-08"],
      time: null,
      constraints: {},
    });

    // Should resolve without throwing — weather intents have no required party/time
    const result = await parseIntent("weather forecast for SF this weekend", mockFn) as {
      site: string;
      party: null;
      time: null;
    };
    assert.equal(result.site, "weather");
    assert.equal(result.party, null);
    assert.equal(result.time, null);
  });
});

// ---------------------------------------------------------------------------
// parseIntent() — Amazon intent shape (mock path)
// Tests site="amazon" routing and the non-empty-target slot check.
// ---------------------------------------------------------------------------
describe("parseIntent() — Amazon intent shape (mock path)", () => {
  it("returns an amazon intent when mock returns site=amazon and non-empty target", async () => {
    const mockAmazonIntent = {
      site: "amazon",
      location: "",
      target: "12oz bag of coffee",
      party: null,
      date: [],
      time: null,
      constraints: {},
    };
    const mockFn = async () => mockAmazonIntent;

    const result = await parseIntent(
      "add a 12oz bag of coffee to my cart",
      mockFn,
    ) as typeof mockAmazonIntent;

    assert.equal(result.site, "amazon");
    assert.equal(result.target, "12oz bag of coffee");
    assert.equal(result.party, null);
    assert.equal(result.time, null);
    assert.deepEqual(result.date, []);
  });

  it("returns a punt intent when mock returns site=punt with a site name in target", async () => {
    const mockPuntIntent = {
      site: "punt",
      location: "",
      target: "streeteasy",
      party: null,
      date: [],
      time: null,
      constraints: {},
    };
    const mockFn = async () => mockPuntIntent;

    const result = await parseIntent(
      "search for apartments on streeteasy",
      mockFn,
    ) as typeof mockPuntIntent;

    assert.equal(result.site, "punt");
    assert.equal(result.target, "streeteasy");
  });

  it("throws ClarifyNeeded matching /product/i when amazon target is empty", async () => {
    const mockFn = async () => ({
      site: "amazon",
      location: "",
      target: "",
      party: null,
      date: [],
      time: null,
      constraints: {},
    });

    await assert.rejects(
      () => parseIntent("add something to cart", mockFn),
      (err: unknown) =>
        err instanceof ClarifyNeeded &&
        /product/i.test(err.question),
    );
  });
});

// ---------------------------------------------------------------------------
// IntentSchema shape documentation helpers (pure — no runtime assertion)
// ---------------------------------------------------------------------------
function expect_contains_sf_string(): RegExp {
  return /san francisco|sf/i;
}

function expect_weekend_iso_array(): string[] {
  // The two ISO dates for weekend 2026-05-31
  return ["2026-05-31", "2026-06-01"];
}
