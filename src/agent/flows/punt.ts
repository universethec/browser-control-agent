/**
 * src/agent/flows/punt.ts
 *
 * Hostile-site detect-and-punt micro-flow.
 *
 * Deliverables:
 *   PuntVerification   Zod schema for block-detection extraction
 *   PuntVerificationType  inferred TS type
 *   resolvePuntUrl     pure helper: site name → URL (fail-closed)
 *   detectBlock        pure oracle: classify block vs normal page
 *   runPuntFlow        micro-flow: navigate → extract → screenshot → result/done
 *
 * KEY DESIGN DECISION: This flow does NOT use runLoop.
 *   The punt is a single-shot check: navigate → extract → report.
 *   Adding runLoop would introduce FlowDefinition/LoopConfig boilerplate
 *   for a one-step operation (RESEARCH §B.3, §C.3).
 *
 * Security invariants (T-3-04, T-3-05, Criterion 3):
 *   - Exactly ONE goto + ONE extract — never fights the wall.
 *   - No sh.act, no CAPTCHA-solving, no retry-on-block.
 *   - A detected block is a SUCCESS outcome: result{ok:false} + done.
 *     Only genuine throws/Stagehand crashes reach the error event.
 *   - Screenshot captures only the public block page — no credentials entered.
 *
 * ESM note: relative imports use .js specifiers under NodeNext.
 */

import { z } from "zod";
import { createStagehand } from "../stagehand.js";
import type { ServerEventType } from "../../protocol/events.js";
import type { Intent } from "../intent.js";

// ---------------------------------------------------------------------------
// PuntVerification schema — mirrors WeatherForecast shape (weather.ts lines 33–45)
// Ask Stagehand to extract the block-detection signal from the current page.
// ---------------------------------------------------------------------------

export const PuntVerification = z.object({
  isBlockPage: z.boolean(),        // true if an access-denied / bot-detection page is shown
  blockReason: z.string(),         // human-readable reason from the block page, or "" if not blocked
  pageTitle: z.string(),           // page title (for logging/diagnosis)
  hasExpectedContent: z.boolean(), // true if the page has expected real content (listings, flights, etc.)
});

export type PuntVerificationType = z.infer<typeof PuntVerification>;

// ---------------------------------------------------------------------------
// Extraction instruction — used by runPuntFlow to extract block detection signal
// ---------------------------------------------------------------------------

const PUNT_EXTRACT_INSTRUCTION =
  "Analyze the current page and answer: " +
  "(1) Is this a HARD ACCESS BLOCK — an access-denied page, an anti-bot / bot-detection challenge " +
  "(e.g. a 'Press & Hold' button, PerimeterX, DataDome, Cloudflare, Akamai), or a CAPTCHA? " +
  "IMPORTANT: a cookie or privacy CONSENT banner (text like 'Before you continue', 'We use cookies', " +
  "'Accept all' / 'Reject all') is NOT a block — answer false for consent/privacy banners. (isBlockPage: true/false) " +
  "(2) If and only if it is a hard access block, what does the blocking message say? (blockReason: the exact text, or empty string otherwise) " +
  "(3) What is the exact page title? (pageTitle) " +
  "(4) Does the page show its expected real content, such as apartment listings or flight results? " +
  "(hasExpectedContent: true/false — false if the content is not visible, e.g. behind a block, a consent banner, or an empty page)";

// ---------------------------------------------------------------------------
// PUNT_URLS map — pure lookup: site name → URL (fail-closed)
// Analogue of NWS_LOCATIONS in weather.ts and RESY_CITY_SLUGS in resy.ts
// ---------------------------------------------------------------------------

// CR-01: Null-prototype map so inherited Object.prototype key names
// ("constructor", "toString", "valueOf", "__proto__", …) are NOT reachable as
// lookup keys. With a plain object, PUNT_URLS["constructor"] resolves to
// Object.prototype.constructor (a truthy Function), which defeated the
// `if (!url)` fail-closed guard and let a non-string reach page.goto().
const PUNT_URLS: Record<string, string> = Object.assign(Object.create(null), {
  streeteasy: "https://www.streeteasy.com/for-rent/nyc",
  "google flights": "https://www.google.com/flights",
  kayak: "https://www.kayak.com",
});

/**
 * Resolves a punt site name to its target URL.
 *
 * Normalizes input (lowercase + trim), tries exact match then
 * the first-two-words form (mirrors buildNwsUrl tolerant resolution).
 * Throws descriptively for unknown sites — fail-closed (mirrors buildResySearchUrl throw).
 *
 * CR-01: Uses own-property lookups (hasOwnProperty.call) on a null-prototype
 * map so prototype-chain key names cannot fail open. The `typeof url !== "string"`
 * guard is defense-in-depth so any non-string survivor still hits the throw.
 */
export function resolvePuntUrl(target: string): string {
  const norm = target.toLowerCase().trim();
  const key2 = norm.split(/\s+/).slice(0, 2).join(" ");
  // Own-property lookups only — never the prototype chain. Try exact match,
  // then first two words (handles "google flights" from "Google Flights SF").
  const url =
    (Object.prototype.hasOwnProperty.call(PUNT_URLS, norm) ? PUNT_URLS[norm] : undefined) ??
    (Object.prototype.hasOwnProperty.call(PUNT_URLS, key2) ? PUNT_URLS[key2] : undefined);
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`No punt URL for site: "${target}". Add to PUNT_URLS.`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// detectBlock — pure oracle (no I/O)
// Analogue of verifyWeatherResult in weather.ts, but simpler.
//
// Block logic (honest-label fix):
//   - isBlockPage:true → CONFIRMED block (bot-detection / CAPTCHA / access-denied) → isBlocked:true
//   - everything else → isBlocked:false. Absence of expected content ALONE (a cookie-consent or
//     region gate) is NOT a bot-block; runPuntFlow reports that benign case honestly instead.
//
// Reason priority:
//   blockReason (from block page text) → pageTitle-derived → literal fallback
// ---------------------------------------------------------------------------

export function detectBlock(
  result: PuntVerificationType,
): { isBlocked: boolean; reason: string } {
  // Honest-label fix: only a CONFIRMED block page counts. A page lacking its expected
  // content is NOT automatically a bot-wall — a cookie-consent or region gate hides content
  // benignly. Reporting that as "Blocked" was a false positive (e.g. Google's consent wall
  // surfaced as `Blocked: Before you continue to Google…`) and violated verify-honestly.
  if (result.isBlockPage) {
    const reason =
      result.blockReason ||
      (result.pageTitle ? `Block page: "${result.pageTitle}"` : "Site blocked access");
    return { isBlocked: true, reason };
  }
  return { isBlocked: false, reason: "" };
}

// ---------------------------------------------------------------------------
// runPuntFlow — micro-flow entry point
//
// Lifecycle (RESEARCH §B.3):
//   createStagehand() → sh.init() → page.goto(domcontentloaded) →
//   sh.extract(PuntVerification) → page.screenshot() → emit result + done
//
// Pitfall 4: waitUntil:"domcontentloaded" NOT "networkidle" — PerimeterX
//   keeps a network beacon alive, causing networkidle to time out.
//
// Pitfall 6 / Criterion 3: A detected block is reported via result{ok:false},
//   NEVER via error. Only genuine throws/Stagehand crashes reach the catch block.
// ---------------------------------------------------------------------------

export async function runPuntFlow(
  intent: Intent,
  emit: (event: ServerEventType) => void,
  // isCancelled: signature uniformity with the looped flows. Punt is a micro-flow
  // (single sh.extract, no runLoop) so there is no inter-step boundary to interrupt.
  // A stop during punt is a no-op until sh.extract completes; the flow's
  // finally { await sh.close() } then runs, guaranteeing no orphan browser.
  _isCancelled?: () => boolean,
): Promise<void> {
  // WR-03: Resolve the URL BEFORE opening Chromium. runPuntFlow is an exported
  // entry point wired directly in server.ts and callable in tests, so it must
  // fail fast on a missing/unknown site (fail-closed, see CR-01) without paying
  // for a full headless-Chromium launch + teardown. Mirrors runResyFlow's guard.
  const url = resolvePuntUrl(intent.target); // throws fail-closed for unknown sites

  const sh = createStagehand(); // lazy factory — no browser yet

  try {
    await sh.init(); // opens headless Chromium
    const page = sh.context.pages()[0]; // v3 page access — NOT sh.page (removed in v3)

    emit({ type: "status", step: 0, text: `Navigating to ${url}…` });
    // Use "domcontentloaded" NOT "networkidle" — PerimeterX keeps a beacon alive
    // and would cause networkidle to hang indefinitely (Pitfall 4).
    await page.goto(url, { waitUntil: "domcontentloaded" });

    emit({ type: "status", step: 1, text: "Checking for access block…" });
    const raw = await sh.extract(PUNT_EXTRACT_INSTRUCTION, PuntVerification);

    // Screenshot the block page BEFORE emitting the result (T-3-05: only public block page)
    const buf = await page.screenshot({ type: "jpeg", quality: 70 });
    emit({ type: "screenshot", step: 1, jpegBase64: buf.toString("base64") });

    // Oracle decision — pure, no I/O
    const { isBlocked, reason } = detectBlock(raw);
    if (isBlocked) {
      // CRITICAL (Pitfall 6 / Criterion 3): a confirmed block is a SUCCESS outcome via result, NOT error
      emit({ type: "result", ok: false, summary: `Blocked: ${reason}` });
    } else if (!raw.hasExpectedContent) {
      // Honest-label fix: content gated behind a benign consent/region banner — NOT a bot-wall.
      // Report it honestly rather than pasting consent text as a fake "Blocked" reason.
      emit({
        type: "result",
        ok: false,
        summary: `Couldn't reach ${intent.target} content — a consent or region gate, not a bot block. Not attempted.`,
      });
    } else {
      emit({ type: "result", ok: false, summary: `Site loaded but task not attempted: ${intent.target}` });
    }
    emit({ type: "done" });
  } catch (err) {
    // Error surfacing pattern (Shared Pattern A): emit error+done, rethrow — never swallow.
    // ONLY genuine throws / Stagehand crashes reach here — NOT detected blocks (Pitfall 6).
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
