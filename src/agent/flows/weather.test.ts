/**
 * src/agent/flows/weather.test.ts
 *
 * Wave-0 skeleton: two sections.
 *
 * SECTION 1 — Pure verifyWeatherResult() oracle units (no browser, no LLM)
 *   These tests exercise a pure function and run on every commit (offline).
 *   They import ./weather.js which does NOT exist yet (built in plan 01-03).
 *   Expected offline state: ERR_MODULE_NOT_FOUND → SKELETON_PRESENT signal.
 *
 * SECTION 2 — RUN_LIVE-gated live integration block
 *   Skipped unless RUN_LIVE=1. Exercises runWeatherFlow() end-to-end.
 *   Plan 01-04 flips this section green.
 *
 * Runner: node --import tsx/esm --test src/agent/flows/weather.test.ts
 *   Offline: only pure oracle units run (or fail with ERR_MODULE_NOT_FOUND)
 *   Live:    RUN_LIVE=1 node --import tsx/esm --test src/agent/flows/weather.test.ts
 *
 * Key contracts encoded here:
 *   - D-04 oracle: location match + all requested days present with non-empty summary + high/low
 *   - Sat=Today rule (Pitfall 1): "Today" matches a request for "Today" or "Saturday"
 *   - Pitfall 7: lat/lon location format "37.77N 122.41W" is accepted
 *   - SC1/SC2/SC3/SC4 observable signals gated for plan 01-04
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { ServerEventType } from "../../protocol/events.js";

const isLive = !!process.env.RUN_LIVE;

// ---------------------------------------------------------------------------
// Type used in fixtures — matches WeatherForecastType from weather.ts
// (Defined inline here so oracle tests can run without weather.js importing)
// ---------------------------------------------------------------------------
interface WeatherForecastType {
  location: string;
  days: Array<{
    label: string;
    high: number | null;
    low: number | null;
    summary: string;
  }>;
}

// Deferred dynamic import — ./weather.js does not exist until plan 01-03
// Oracle tests will fail/err with ERR_MODULE_NOT_FOUND until then.
// That is the expected RED state.
let verifyWeatherResult: (
  result: WeatherForecastType,
  requestedDayNames: string[]
) => { ok: boolean; summary: string; reason: string };

let runWeatherFlow: (
  location: string,
  requestedDayNames: string[],
  emit: (event: ServerEventType) => void
) => Promise<void>;

let buildNwsUrl: (location: string) => string;

before(async () => {
  // NOTE: This import will fail with ERR_MODULE_NOT_FOUND until plan 01-03 creates weather.ts.
  // That is the expected RED state for Wave-0 skeletons.
  const mod = await import("./weather.js");
  verifyWeatherResult = mod.verifyWeatherResult;
  runWeatherFlow = mod.runWeatherFlow;
  buildNwsUrl = mod.buildNwsUrl;
});

// ---------------------------------------------------------------------------
// SECTION 1: Pure verifyWeatherResult() oracle units
// No browser, no LLM. Run on every commit.
// ---------------------------------------------------------------------------
describe("verifyWeatherResult() — D-04 oracle (pure function)", () => {
  it("passes when location matches and both weekend days are present with data", () => {
    const fixture: WeatherForecastType = {
      location: "San Francisco, CA",
      days: [
        { label: "Today",   high: 68, low: null, summary: "Sunny" },
        { label: "Tonight", high: null, low: 53, summary: "Mostly Clear" },
        { label: "Sunday",  high: 65, low: null, summary: "Partly Cloudy" },
      ],
    };
    const result = verifyWeatherResult(fixture, ["Today", "Sunday"]);
    assert.equal(result.ok, true);
    assert.match(result.summary, /San Francisco/);
  });

  it("SAT=TODAY RULE: ['Today','Sunday'] matches a days entry labeled 'Today' (Pitfall 1)", () => {
    // On Saturday 2026-05-31, NWS labels the day "Today" not "Saturday"
    // The oracle must accept "Today" when "Today" is requested
    const fixture: WeatherForecastType = {
      location: "San Francisco, CA",
      days: [
        { label: "Today",  high: 71, low: null, summary: "Sunny" },
        { label: "Sunday", high: 65, low: null, summary: "Cloudy" },
      ],
    };
    const result = verifyWeatherResult(fixture, ["Today", "Sunday"]);
    assert.equal(result.ok, true, "oracle must accept 'Today' when 'Today' is in requestedDayNames");
    assert.match(result.summary, /San Francisco/);
  });

  it("SAT=TODAY RULE: passes when day labeled 'Today' satisfies a 'Today' request", () => {
    // Direct test of the Sat=Today rule — core correctness requirement (SC2)
    const fixture: WeatherForecastType = {
      location: "San Francisco, CA",
      days: [
        { label: "Today", high: 68, low: null, summary: "Sunny" },
      ],
    };
    const result = verifyWeatherResult(fixture, ["Today"]);
    assert.equal(result.ok, true, "'Today' day entry must satisfy a 'Today' request");
  });

  it("fails when location is empty", () => {
    const fixture: WeatherForecastType = {
      location: "",
      days: [{ label: "Today", high: 70, low: null, summary: "Sunny" }],
    };
    const result = verifyWeatherResult(fixture, ["Today"]);
    assert.equal(result.ok, false);
    assert.ok(result.reason.length > 0, "reason must be non-empty on failure");
  });

  it("fails when a requested day is missing from days array", () => {
    const fixture: WeatherForecastType = {
      location: "San Francisco, CA",
      days: [{ label: "Today", high: 68, low: null, summary: "Sunny" }],
    };
    const result = verifyWeatherResult(fixture, ["Today", "Sunday"]);
    assert.equal(result.ok, false);
    // reason must name the missing day
    assert.match(result.reason, /Sunday/i, "reason must name the missing day 'Sunday'");
  });

  it("fails when requested day has no summary (empty summary)", () => {
    const fixture: WeatherForecastType = {
      location: "San Francisco, CA",
      days: [
        { label: "Today",  high: 68, low: null, summary: "" },  // empty summary
        { label: "Sunday", high: 65, low: null, summary: "Cloudy" },
      ],
    };
    const result = verifyWeatherResult(fixture, ["Today", "Sunday"]);
    // "Today" has empty summary → should fail
    assert.equal(result.ok, false);
    assert.match(result.reason, /Today/i);
  });

  it("fails when requested day has neither high nor low temperature", () => {
    const fixture: WeatherForecastType = {
      location: "San Francisco, CA",
      days: [
        { label: "Today",  high: null, low: null, summary: "Sunny" }, // no temps
        { label: "Sunday", high: 65,   low: null, summary: "Cloudy" },
      ],
    };
    const result = verifyWeatherResult(fixture, ["Today", "Sunday"]);
    // "Today" has no high AND no low → oracle should reject it
    assert.equal(result.ok, false);
  });

  it("PITFALL 7: accepts lat/lon location format '37.77N 122.41W'", () => {
    // NWS page title is "7-Day Forecast 37.77N 122.41W" — oracle must accept this
    const fixture: WeatherForecastType = {
      location: "37.77N 122.41W",
      days: [{ label: "Today", high: 71, low: null, summary: "Sunny" }],
    };
    const result = verifyWeatherResult(fixture, ["Today"]);
    assert.equal(result.ok, true, "lat/lon format must be accepted as valid SF location");
  });

  it("produces a non-empty summary string on success", () => {
    const fixture: WeatherForecastType = {
      location: "San Francisco, CA",
      days: [
        { label: "Today",  high: 68, low: null, summary: "Sunny" },
        { label: "Sunday", high: 65, low: 52,   summary: "Partly Cloudy" },
      ],
    };
    const result = verifyWeatherResult(fixture, ["Today", "Sunday"]);
    assert.equal(result.ok, true);
    assert.ok(result.summary.length > 0, "summary must be non-empty on success");
  });
});

// ---------------------------------------------------------------------------
// SECTION 1b: buildNwsUrl() — deterministic URL builder (pure function)
// Locks the #2 fix: parseIntent returns location variants like "San Francisco, CA",
// so buildNwsUrl must resolve them — while still failing closed on unknowns.
// ---------------------------------------------------------------------------
describe("buildNwsUrl() — D-01/D-02 URL builder (pure function)", () => {
  const SF = "lat=37.7749&lon=-122.4194";

  it("resolves the canonical city name and the SF alias", () => {
    assert.match(buildNwsUrl("San Francisco"), /forecast\.weather\.gov/);
    assert.ok(buildNwsUrl("San Francisco").includes(SF));
    assert.ok(buildNwsUrl("SF").includes(SF));
  });

  it("#2: tolerates the state-suffixed forms parseIntent actually returns", () => {
    // The LLM returns "San Francisco, CA" / "San Francisco CA" — both must resolve to SF.
    assert.ok(buildNwsUrl("San Francisco, CA").includes(SF));
    assert.ok(buildNwsUrl("San Francisco CA").includes(SF));
    assert.ok(buildNwsUrl("San Francisco, California").includes(SF));
    assert.ok(buildNwsUrl("sf, ca").includes(SF));
  });

  it("fails closed on an unknown location (never silently defaults)", () => {
    assert.throws(() => buildNwsUrl("Tokyo"), /No NWS coordinates/);
  });
});

// ---------------------------------------------------------------------------
// SECTION 2: RUN_LIVE-gated live integration block
// Skipped unless RUN_LIVE=1. Plan 01-04 flips this section green.
// ---------------------------------------------------------------------------
describe("runWeatherFlow() — live integration (SC1/SC2/SC3/SC4)", { skip: !isLive }, () => {
  it("SC1/SC2/SC3/SC4: full weather pipeline for SF weekend forecast", async () => {
    // Collect all emitted events
    const events: ServerEventType[] = [];
    const emit = (e: ServerEventType) => events.push(e);

    // Run the live weather flow.
    // Date reality: today is Sunday 2026-05-31. When you ask for "weekend weather" while
    // already in the weekend, the only weekend day NWS still shows is the current day,
    // which NWS labels "Today" (Saturday has passed). The oracle requires EVERY requested
    // day-label to be present, so we request the visible weekend day: ["Today"]. The full
    // ws command path (parseIntent -> deriveDayNames) and the "weekend-on-a-Sunday rolls to
    // next weekend" product semantics are a Phase 2 hero concern, out of scope for this
    // pipeline proof — see 01-04-SUMMARY.
    await runWeatherFlow("San Francisco", ["Today"], emit);

    // -----------------------------------------------------------------------
    // SC1: navigates to NWS forecast.weather.gov (verified by status event)
    // -----------------------------------------------------------------------
    const statusEvents = events.filter((e) => e.type === "status");
    assert.ok(statusEvents.length > 0, "SC1: at least one status event must be emitted");
    const hasNavStatus = statusEvents.some(
      (e) => e.type === "status" && /forecast\.weather\.gov|weather\.gov/i.test(e.text)
    );
    assert.ok(hasNavStatus, "SC1: a status event must reference forecast.weather.gov");

    // -----------------------------------------------------------------------
    // SC2: result event has data with valid WeatherForecast + weekend days
    // -----------------------------------------------------------------------
    const resultEvent = events.find((e) => e.type === "result");
    assert.ok(resultEvent, "SC2: a result event must be emitted");
    assert.equal(
      (resultEvent as { type: string; ok: boolean }).ok,
      true,
      "SC2: result.ok must be true"
    );

    const resultWithData = resultEvent as { type: string; ok: boolean; data?: unknown };
    assert.ok(resultWithData.data !== undefined && resultWithData.data !== null, "SC2: result.data must be non-null");

    // Validate data shape (WeatherForecast)
    const data = resultWithData.data as WeatherForecastType;
    assert.ok(Array.isArray(data.days), "SC2: result.data.days must be an array");
    assert.ok(data.days.length >= 1, "SC2: result.data.days must have at least 1 entry");

    // Sat=Today rule: at least one day matches "Today" or "Sunday"
    const hasToday = data.days.some(
      (d) => /today/i.test(d.label) && d.summary.trim() !== "" && (d.high !== null || d.low !== null)
    );
    const hasSunday = data.days.some(
      (d) => /sunday/i.test(d.label) && d.summary.trim() !== "" && (d.high !== null || d.low !== null)
    );
    assert.ok(hasToday || hasSunday, "SC2: at least one of Today/Sunday must appear in result.data.days");

    // -----------------------------------------------------------------------
    // SC3: screenshot event with valid JPEG magic bytes
    // -----------------------------------------------------------------------
    const screenshotEvent = events.find((e) => e.type === "screenshot");
    assert.ok(screenshotEvent, "SC3: a screenshot event must be emitted");
    const jpegBase64 = (screenshotEvent as { type: string; jpegBase64: string }).jpegBase64;
    assert.ok(jpegBase64.length > 0, "SC3: jpegBase64 must be non-empty");
    // JPEG magic bytes: FF D8
    const magicHex = Buffer.from(jpegBase64, "base64").subarray(0, 2).toString("hex");
    assert.equal(magicHex, "ffd8", "SC3: image must start with JPEG magic bytes FF D8");

    // -----------------------------------------------------------------------
    // SC4: loop ran at least 1 full cycle; done event emitted
    // -----------------------------------------------------------------------
    const stepEvents = events.filter((e) => e.type === "status" && (e as { type: string; step: number }).step >= 1);
    assert.ok(stepEvents.length >= 1, "SC4: at least one status event with step >= 1 must be emitted");

    const doneEvent = events.find((e) => e.type === "done");
    assert.ok(doneEvent, "SC4: a done event must be emitted at the end");
  });
});
