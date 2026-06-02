/**
 * src/agent/flows/weather.ts
 *
 * Complete weather flow: NWS URL builder, WeatherForecast schema, D-04 oracle, runWeatherFlow.
 *
 * Deliverables:
 *   D-01/D-02  Deterministic NWS URL from location string (never LLM, never IP-based)
 *   D-03       WeatherForecast Zod schema with nullable high/low (Pitfall 2)
 *   D-04       verifyWeatherResult oracle — Sat=Today aware (Pitfall 1), lat/lon aware (Pitfall 7)
 *   D-09       JPEG screenshot per step via page.screenshot({ type:"jpeg", quality:70 })
 *   D-10       Templated summary — no extra LLM call
 *
 * Anti-patterns avoided:
 *   - sh.page does not exist in v3 — use sh.context.pages()[0]
 *   - page.extract/page.observe do not exist — use sh.extract / sh.observe
 *   - Never open Chromium at import time — createStagehand() + sh.init() inside run function
 *
 * ESM note: relative imports use .js specifiers under NodeNext.
 */

import { z } from "zod";
import type { Stagehand } from "@browserbasehq/stagehand";
import { createStagehand } from "../stagehand.js";
import { runLoop, type LoopConfig, type FlowDefinition } from "../loop.js";
import type { ServerEventType } from "../../protocol/events.js";

// ---------------------------------------------------------------------------
// D-03: WeatherForecast schema
// high/low are nullable (Pitfall 2 — NWS shows only high on day periods, only low on night periods)
// days array must have at least one entry
// ---------------------------------------------------------------------------

export const WeatherForecast = z.object({
  location: z.string(),
  days: z
    .array(
      z.object({
        label: z.string(),
        high: z.number().nullable(),
        low: z.number().nullable(),
        summary: z.string(),
      }),
    )
    .min(1),
});

export type WeatherForecastType = z.infer<typeof WeatherForecast>;

// ---------------------------------------------------------------------------
// D-01/D-02: Deterministic NWS URL builder
// Never an LLM call, never IP-based — location string → hardcoded NWS lat/lon
// ---------------------------------------------------------------------------

const NWS_LOCATIONS: Record<string, { lat: number; lon: number }> = {
  "san francisco": { lat: 37.7749, lon: -122.4194 },
  sf: { lat: 37.7749, lon: -122.4194 },
};

/**
 * Returns the NWS MapClick URL for a known location.
 * Throws descriptively for unknown locations — never silently falls through.
 */
export function buildNwsUrl(location: string): string {
  const norm = location.toLowerCase().trim();
  // Resolve tolerantly (#2 — parser->flow location mismatch): parseIntent may return
  // "San Francisco, CA" / "San Francisco CA", but the keys are bare city names.
  // Try exact, then the part before a comma, then a known key as the leading token(s).
  let coords = NWS_LOCATIONS[norm] ?? NWS_LOCATIONS[norm.split(",")[0].trim()];
  if (!coords) {
    for (const k of Object.keys(NWS_LOCATIONS)) {
      if (norm === k || norm.startsWith(k + " ") || norm.startsWith(k + ",")) {
        coords = NWS_LOCATIONS[k];
        break;
      }
    }
  }
  if (!coords) {
    throw new Error(
      `No NWS coordinates for location: "${location}". Add to NWS_LOCATIONS map.`,
    );
  }
  return `https://forecast.weather.gov/MapClick.php?lat=${coords.lat}&lon=${coords.lon}`;
}

// ---------------------------------------------------------------------------
// D-04: Success oracle — pure function, no I/O
// Sat=Today rule: NWS labels the current day "Today", not "Saturday"
// Pitfall 7: oracle accepts "37.77N 122.41W" as a valid SF location
// D-10: deterministic templated summary — no extra LLM call
// ---------------------------------------------------------------------------

/**
 * Verifies extracted WeatherForecastType against D-04 criteria.
 *
 * requestedDayNames: day-name substrings the oracle must find in the days array.
 *   On Saturday 2026-05-31, NWS shows "Today" not "Saturday".
 *   Pass ["Today","Sunday"] (not ["Saturday","Sunday"]) so substring match works correctly.
 *   The caller (runWeatherFlow or the command handler) is responsible for applying the Sat=Today
 *   substitution BEFORE calling this function. The oracle's substring match then handles it.
 *
 * A day is "matched" when:
 *   - d.label.toLowerCase() includes the requested name (case-insensitive substring)
 *   - d.summary is non-empty
 *   - at least one of d.high or d.low is non-null
 */
export function verifyWeatherResult(
  result: WeatherForecastType,
  requestedDayNames: string[],
): { ok: boolean; summary: string; reason: string } {
  // Check location is non-empty
  if (!result.location?.trim()) {
    return { ok: false, summary: "", reason: "location field is empty" };
  }

  // Accept city name or lat/lon pattern (Pitfall 7: "37.77N 122.41W")
  const loc = result.location.toLowerCase();
  const locationOk =
    loc.includes("san francisco") || /\d+\.\d+[ns]/i.test(result.location);
  if (!locationOk) {
    return {
      ok: false,
      summary: "",
      reason: `location "${result.location}" does not match SF`,
    };
  }

  // Match each requested day by label substring, non-empty summary, and at least one temp
  const matched = requestedDayNames.filter((dayName) =>
    result.days.some(
      (d) =>
        d.label.toLowerCase().includes(dayName.toLowerCase()) &&
        d.summary.trim() !== "" &&
        (d.high !== null || d.low !== null),
    ),
  );

  if (matched.length < requestedDayNames.length) {
    const missing = requestedDayNames.filter((d) => !matched.includes(d));
    return {
      ok: false,
      summary: "",
      reason: `Missing or incomplete forecast for: ${missing.join(", ")}`,
    };
  }

  // D-10: deterministic template summary — no extra LLM call
  const parts = result.days
    .filter((d) =>
      requestedDayNames.some((r) =>
        d.label.toLowerCase().includes(r.toLowerCase()),
      ),
    )
    .map((d) => `${d.label} ${d.high ?? "?"}°/${d.low ?? "?"}° ${d.summary}`)
    .join(", ");

  return {
    ok: true,
    summary: `${result.location} weekend: ${parts}`,
    reason: "",
  };
}

// ---------------------------------------------------------------------------
// runWeatherFlow — entry point for the full weather pipeline
// Caller provides location string (e.g. "San Francisco") and requestedDayNames
// (e.g. ["Today","Sunday"] when today is Saturday — Sat=Today rule already applied)
// ---------------------------------------------------------------------------

/**
 * Full weather flow: NWS URL → headless Chromium → extract → oracle → emit.
 *
 * Lifecycle: creates and owns the Stagehand instance.
 *   try { init + navigate + loop } catch { emit error+done; rethrow } finally { close }
 *
 * Error surfacing pattern (never swallows):
 *   On any throw: emits { type:"error", message } + { type:"done" } then rethrows.
 *   The caller (server.ts runAgent) catches and logs; the ws client sees the error event.
 */
export async function runWeatherFlow(
  location: string,
  requestedDayNames: string[],
  emit: (event: ServerEventType) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  const sh = createStagehand(); // lazy factory — no browser yet

  try {
    await sh.init(); // opens headless Chromium
    const page = sh.context.pages()[0]; // v3 page access — NOT sh.page (removed in v3)

    const url = buildNwsUrl(location);
    emit({ type: "status", step: 0, text: `Navigating to ${url}…` });
    await page.goto(url, { waitUntil: "networkidle" });

    const loopConfig: LoopConfig = {
      maxSteps: 25,
      timeoutMs: 300_000,
      maxIdentical: 3,
      emit,
      isCancelled,
    };

    const flow: FlowDefinition = {
      observeInstruction: "7-day weather forecast data on this page",

      decide: (_candidates, _step) => ({
        type: "extract",
        narration: "Extracting 7-day forecast…",
      }),

      doExtract: async (sh: Stagehand) => {
        // Compute today dynamically (UTC, matching resolveWeekendDates) — never hardcode
        // the weekday: a stale literal misleads the LLM and drifts every day (WR-01).
        const now = new Date();
        const todayIso = now.toISOString().slice(0, 10);
        const weekday = now.toLocaleDateString("en-US", {
          weekday: "long",
          timeZone: "UTC",
        });
        const raw = await sh.extract(
          `Extract the 7-day weather forecast. For each period return: label (period name exactly as shown), ` +
            `high temperature in °F (integer or null if not shown), low temperature in °F (integer or null if not shown), ` +
            `and summary (the short description text). Today is ${weekday} ${todayIso}.`,
          WeatherForecast,
        );
        return raw;
      },

      verify: (raw) =>
        verifyWeatherResult(raw as WeatherForecastType, requestedDayNames),
    };

    await runLoop(sh, flow, loopConfig);
  } catch (err) {
    // Error surfacing pattern: emit error+done, then rethrow — never swallow
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
