/**
 * src/agent/intent.ts
 *
 * Step-0 intent parser (D-06): one structured LLM call that turns a
 * natural-language command into a Zod-validated Intent.
 *
 * Local date + timezone are injected so relative dates ("weekend", "tonight")
 * resolve to the correct upcoming ISO dates. This fixes the Phase 2 hero's
 * "tonight"/"next Friday" wrong-booking failure class.
 *
 * Provider-agnostic: dispatches via sh.llmClient — Stagehand handles the
 * Anthropic vs. OpenAI switch from resolveProviderConfig().
 *
 * SECURITY (T-01-03): LLM output passes through IntentSchema.parse() before
 * any caller acts on it. Malformed output throws a ZodError — never swallowed.
 * SECURITY (T-01-04): Only the provider NAME is logged, never a key value.
 *
 * ESM note: all relative imports use .js specifiers (NodeNext).
 */

import { z } from "zod";
import { createStagehand } from "./stagehand.js";
import { resolveProviderConfig } from "../config/env.js";

// ---------------------------------------------------------------------------
// IntentSchema — D-06 target shape (Zod 3.25.76 single-arg z.record)
// ---------------------------------------------------------------------------

export const IntentSchema = z.object({
  site:        z.string(),              // "weather" | "resy" | "amazon"
  location:    z.string(),             // "San Francisco"
  target:      z.string(),             // "weather" | "restaurant" | "product"
  party:       z.number().nullable(),  // null for weather
  date:        z.array(z.string()),    // ISO ["2026-05-31","2026-06-01"]
  time:        z.string().nullable(),  // "19:00" | null
  constraints: z.record(z.unknown()), // arbitrary extras
});

/** Structured intent returned by parseIntent(). */
export type Intent = z.infer<typeof IntentSchema>;

// ---------------------------------------------------------------------------
// ClarifyNeeded — D-07 minimal seam
// Phase 1 weather never throws this; exists so Phase 2/4 can reuse the seam.
// ---------------------------------------------------------------------------

/** Emitted when a required slot cannot be resolved from the command alone. */
export class ClarifyNeeded extends Error {
  constructor(
    public readonly question: string,
    public readonly options?: string[],
  ) {
    super(question);
    this.name = "ClarifyNeeded";
  }
}

// ---------------------------------------------------------------------------
// resolveWeekendDates — pure, deterministic, UTC-safe
// ---------------------------------------------------------------------------

/**
 * Given an ISO date string (YYYY-MM-DD), returns [satISO, sunISO] for the
 * upcoming weekend (next Saturday + Sunday).
 *
 * Rules:
 *   - Saturday input  → [that Saturday, following Sunday]
 *   - Sunday input    → [following Saturday, following Sunday] (next full weekend)
 *   - Any other day   → [next Saturday, next Sunday]
 *
 * Uses Date.UTC arithmetic on parsed Y/M/D components to avoid host-timezone
 * shift bugs from new Date(iso).
 */
export function resolveWeekendDates(isoDate: string): string[] {
  // Parse YYYY-MM-DD components and build a UTC midnight timestamp.
  const [year, month, day] = isoDate.split("-").map(Number);
  // Date.UTC months are 0-indexed.
  const utcMs = Date.UTC(year, month - 1, day);

  // dayOfWeek: 0=Sun, 1=Mon, ..., 6=Sat
  const utcDate = new Date(utcMs);
  const dayOfWeek = utcDate.getUTCDay(); // 0-6, Sunday=0

  // Days until next Saturday (6), and then Sunday is +1 more.
  // Saturday (6) → 0 days ahead  → Saturday that day
  // Sunday  (0) → 6 days ahead  → next Saturday (skip this Sunday)
  // Monday  (1) → 5 days ahead
  // ...
  let daysToSat: number;
  if (dayOfWeek === 6) {
    // Input IS Saturday → use that Saturday (offset 0)
    daysToSat = 0;
  } else if (dayOfWeek === 0) {
    // Input is Sunday → jump to the NEXT Saturday (6 days ahead)
    daysToSat = 6;
  } else {
    // Mon(1)→5, Tue(2)→4, Wed(3)→3, Thu(4)→2, Fri(5)→1
    daysToSat = 6 - dayOfWeek;
  }

  const ONE_DAY_MS = 86_400_000;
  const satMs = utcMs + daysToSat * ONE_DAY_MS;
  const sunMs = satMs + ONE_DAY_MS;

  return [toISODateString(satMs), toISODateString(sunMs)];
}

/** Formats a UTC epoch ms as YYYY-MM-DD. */
function toISODateString(utcMs: number): string {
  const d = new Date(utcMs);
  const year  = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day   = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Internal LLM call helper — injectable for testing
// ---------------------------------------------------------------------------

/**
 * The actual structured completion call.
 * Extracted so callers can substitute a mock implementation for offline tests.
 *
 * Uses sh.llmClient.createChatCompletion which is provider-agnostic —
 * Stagehand dispatches to Anthropic or OpenAI based on the resolved model.
 *
 * Defensive fallback: tries the call pre-init; if llmClient is unavailable
 * (TypeError/undefined), calls sh.init() and retries once (post-init path).
 * This resolves the UNRESOLVED spike from plan 01-01.
 */
export type LLMCallFn = (
  messages: Array<{ role: "user" | "system"; content: string }>,
  schema: typeof IntentSchema,
) => Promise<unknown>;

/**
 * Build the real LLM call function backed by sh.llmClient.createChatCompletion.
 * Returns a tuple [callFn, cleanup] where cleanup() calls sh.close() if
 * sh.init() was invoked (post-init path), or is a no-op (pre-init path).
 */
async function buildRealLLMCallFn(): Promise<[LLMCallFn, () => Promise<void>]> {
  const sh = createStagehand();

  let initCalled = false;

  const attemptCall: LLMCallFn = async (messages, schema) => {
    // Stagehand's createChatCompletion requires a logger — use the instance logger.
    // The logger is available after construction (same as llmClient).
    const logger = sh.logger;

    // WR-06: single source of truth for the createChatCompletion payload, invoked
    // from both the pre-init and post-init-retry paths so the two copies can no
    // longer drift (e.g. a future change to temperature or response_model.name).
    const doCall = () =>
      sh.llmClient.createChatCompletion({
        options: {
          messages,
          response_model: {
            name: "parse_intent",
            schema,
          },
          temperature: 0,
        },
        logger,
      });

    // Try the call directly (pre-init path — constructor sets llmClient).
    try {
      return await doCall();
    } catch (err) {
      // If llmClient was not ready pre-init (Pitfall 5 fallback), init and retry.
      const msg = err instanceof Error ? err.message : String(err);
      const isNotReadyErr =
        msg.includes("Cannot read properties of undefined") ||
        msg.includes("llmClient") ||
        err instanceof TypeError;

      if (isNotReadyErr && !initCalled) {
        initCalled = true;
        await sh.init();
        return await doCall();
      }
      throw err;
    }
  };

  const cleanup = async (): Promise<void> => {
    if (initCalled) {
      await sh.close();
    }
  };

  return [attemptCall, cleanup];
}

// ---------------------------------------------------------------------------
// parseIntent — the public Step-0 parser
// ---------------------------------------------------------------------------

/**
 * True when a slot value is missing OR a model-invented placeholder. When the user
 * omits a field the model sometimes fills it with "<UNKNOWN>", "unknown", "N/A",
 * "TBD" etc. instead of leaving it empty; those must count as missing so the
 * required-slot guards ask the user (ClarifyNeeded) rather than searching the
 * literal placeholder string (the "<UNKNOWN>" search bug).
 */
const PLACEHOLDER_RE =
  /^[\s<>/\[\](){}"'.\-]*(unknown|unspecified|n\/?a|tbd|tba|none|null|undefined|any)[\s<>/\[\](){}"'.\-]*$/i;
export function isBlank(v: string | null | undefined): boolean {
  return !v || v.trim() === "" || PLACEHOLDER_RE.test(v.trim());
}

/**
 * Parses a natural-language command into a Zod-validated Intent.
 *
 * Injects local date + IANA timezone so relative phrases ("weekend", "tonight",
 * "next Friday") are grounded to ISO dates before the LLM fills the slots.
 *
 * SECURITY (T-01-03): passes all LLM output through IntentSchema.parse() before
 * returning — malformed or injected output throws ZodError, never silently passes.
 * SECURITY (T-01-04): logs only the provider NAME, never an API key value.
 *
 * @param command    Natural-language command from the user.
 * @param _llmCallFn Optional injected LLM call fn for offline/mock unit tests.
 *                   Defaults to the real sh.llmClient path.
 */
export async function parseIntent(
  command: string,
  _llmCallFn?: LLMCallFn,
): Promise<Intent> {
  // Inject local date + timezone so relative dates resolve correctly.
  const localDate = new Date().toISOString().slice(0, 10);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const systemMessage = {
    role: "system" as const,
    content:
      `Today is ${localDate} (${tz}). ` +
      `"Weekend" means the upcoming Saturday and Sunday. ` +
      `Resolve all relative dates to ISO YYYY-MM-DD format. ` +
      `Understand natural, conversational phrasing: "I want you to…", "can you…", "please…", "I'd like…", "go…" are all commands — extract the task and ignore the politeness wrapper. ` +
      `If the message contains "user clarified:", everything after that marker is the user answering earlier questions — treat those clarifications as authoritative and cumulative: fill the slots they provide and NEVER blank, downgrade, or overwrite a slot the user already specified earlier in the same message. ` +
      `Respond only via the parse_intent tool. Fill the fields you can determine from the message; for anything the user did NOT specify, leave it empty (target="", party=null, time=null, date=[]). NEVER invent a placeholder like "unknown", "<UNKNOWN>", "N/A", or "TBD" — an empty field is correct and lets the app ask the user. ` +
      `For weather queries: site="weather", target="weather", party=null, time=null. ` +
      `For restaurant-booking queries: site="resy", target=the restaurant name when the user gives one, OR a cuisine/description when no name is given (e.g. "Rich Table", "sushi", "italian", "a steakhouse") — a cuisine/description is a VALID target the app can search, so use it; set target="" ONLY when the user has said nothing at all about the venue or the kind of food (never invent a specific venue name), party=number_of_guests, time="HH:MM" (24-hour format), date=["YYYY-MM-DD"] (resolved ISO date). ` +
      `For shopping/add-to-cart queries: site="amazon", target=the FULL product description exactly as the user phrased it, keeping every qualifier such as size/quantity/type (e.g. "12oz bag of coffee" — do NOT shorten to just "coffee"), party=null, time=null, date=[]. ` +
      `For flight-search queries (e.g. "find me a ticket from SFO to JFK", "flights to New York next Tuesday"): site="flights", location=the ORIGIN airport or city, target=the DESTINATION airport or city, date=["YYYY-MM-DD" departure date], party=number of passengers or null, time=null. ` +
      `For hostile-site punt demos (StreetEasy, Kayak): site="punt", target=the site name (e.g. "streeteasy", "kayak").`,
  };

  const userMessage = {
    role: "user" as const,
    content: command,
  };

  const messages = [systemMessage, userMessage];

  let llmCallFn: LLMCallFn;
  let cleanup: () => Promise<void>;

  if (_llmCallFn) {
    // Injected mock — no cleanup needed, no API key required.
    llmCallFn = _llmCallFn;
    cleanup = async () => {};
  } else {
    // Call-time env read — mirrors env.ts pattern (never at module top level).
    // Only read when a real LLM call is needed (not for mock/test path).
    const { provider } = resolveProviderConfig();
    [llmCallFn, cleanup] = await buildRealLLMCallFn();
    // SECURITY (T-01-04): log only the provider name, never a key value.
    console.log(`[parseIntent] provider: ${provider}`);
  }

  try {

    const raw = await llmCallFn(messages, IntentSchema);

    // createChatCompletion(response_model) returns { data, usage } — the parsed
    // object lives at `.data`. Injected mocks return the object directly, so
    // unwrap `.data` only when present (same defensive shape as llm-spike.test.ts).
    const payload =
      raw && typeof raw === "object" && "data" in raw
        ? (raw as { data: unknown }).data
        : raw;

    // SECURITY (T-01-03): Validate before any downstream use.
    // IntentSchema.parse() throws ZodError on malformed/injected LLM output.
    const parsed = IntentSchema.parse(payload);

    // Required-slot validation for Resy bookings (D-07 / criterion 1).
    // SECURITY (T-2-04): target is a validated string — never executed, only used as search data.
    if (parsed.site === "resy") {
      // A6 (DEC-location): default location to "San Francisco" if missing/empty/placeholder.
      if (isBlank(parsed.location)) {
        parsed.location = "San Francisco";
      }

      // Check required slots in priority order; throw ClarifyNeeded on the FIRST missing slot.
      // isBlank() also catches "<UNKNOWN>"-style placeholders so we ask the user "which
      // restaurant?" instead of literally searching the placeholder string.
      if (isBlank(parsed.target)) {
        throw new ClarifyNeeded(
          'Which restaurant, or what type of food? (e.g. "Rich Table", or a cuisine like "sushi")',
        );
      }
      if (parsed.party === null || parsed.party === undefined) {
        throw new ClarifyNeeded("How many guests?", ["1", "2", "3", "4", "5", "6+"]);
      }
      // When the user omits a date/time the model does NOT leave the slot empty —
      // it fills a placeholder (e.g. "/UNKNOWN/") or an unresolved phrase. Clarify
      // unless the slot is a real ISO date / HH:MM time; otherwise the placeholder
      // slips past this guard into buildResySearchUrl and throws a developer-facing
      // error ("Invalid date '/UNKNOWN/' — Resolve relative dates…") at the user.
      if (!parsed.date || parsed.date.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date[0])) {
        throw new ClarifyNeeded("What date? (e.g., 'tonight', 'next Friday', 'June 7')");
      }
      if (
        parsed.time === null ||
        parsed.time === undefined ||
        !/^([01]?\d|2[0-3]):[0-5]\d$/.test(parsed.time)
      ) {
        throw new ClarifyNeeded("What time? (e.g., '7pm', '7:30pm', '8:00pm')");
      }
    }

    // Required-slot validation for Amazon shopping (site="amazon" requires a non-empty target).
    // SECURITY (T-3-01): target is validated as a string by IntentSchema.parse(); used only as
    // search-query text downstream — never executed. No instructions to follow embedded content.
    if (parsed.site === "amazon") {
      if (isBlank(parsed.target)) {
        throw new ClarifyNeeded("What product are you looking for?");
      }
    }

    // Required-slot validation for flight search: origin (location), destination
    // (target), and a real departure ISO date. Mirrors the resy guards so a missing
    // slot asks the user rather than driving Google Flights with a blank field.
    if (parsed.site === "flights") {
      if (isBlank(parsed.location)) {
        throw new ClarifyNeeded("Which city or airport are you flying FROM?");
      }
      if (isBlank(parsed.target)) {
        throw new ClarifyNeeded("Where do you want to fly TO?");
      }
      if (!parsed.date || parsed.date.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date[0])) {
        throw new ClarifyNeeded("What departure date? (e.g., 'next Tuesday', 'June 9')");
      }
    }

    return parsed;
  } finally {
    await cleanup();
  }
}
