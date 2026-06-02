/**
 * src/server/server.ts
 *
 * Built-in Node http static server + ws stub.
 *
 * Serves public/index.html at the root path, attaches a WebSocketServer,
 * sends a single status event on connection, and handles inbound "command"
 * messages by running the full pipeline: parseIntent → runWeatherFlow.
 *
 * Design decisions:
 *   - NO http framework (DEC-ui: lightest shell — built-in node:http is the whole story)
 *   - Phase 1: inbound "command" message wired to parseIntent → runWeatherFlow with broadcast
 *     as the emit fn; full ClientEvent Zod validation deferred to Phase 4 (T-00-04 accepted)
 *   - ESM note (Pitfall 6): callers import from "./server/http.js" with .js specifier
 *
 * Exports:
 *   startServer(opts?)  — creates, wires, and starts the http+ws server;
 *                         returns { server, broadcast }
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import { type ServerEventType, ClientEvent } from "../protocol/events.js";
import { runWeatherFlow } from "../agent/flows/weather.js";
import { runResyFlow } from "../agent/flows/resy.js";
import { runAmazonFlow } from "../agent/flows/amazon.js";
import { runPuntFlow } from "../agent/flows/punt.js";
import { runFlightsFlow } from "../agent/flows/flights.js";
import { parseIntent, ClarifyNeeded, isBlank, type Intent } from "../agent/intent.js";

// Friendly scope message shown when the input isn't an actionable browser command —
// a parse failure OR a non-command that parsed as an empty weather intent (blank location).
// SECURITY (T-01-10): static string only; never err internals, env, or key values.
const FRIENDLY_NON_COMMAND =
  'I run browser tasks, not a chat — try a command like "weekend weather forecast for SF" or "book a table for 2 at 7pm at Rich Table in SF".';

// ---------------------------------------------------------------------------
// dispatchVia: the testable broadcast-arithmetic core of dispatchCommand.
//
//   parseFn(text)   — stands in for parseIntent (injectable for tests)
//   routeFn(intent) — stands in for the site router (injectable for tests)
//   broadcastFn     — the event sink (injectable for tests)
//
// G1 — flowEntered flag (single-broadcaster):
//   flowEntered is set true as the FIRST statement in the try body, AFTER parseFn
//   resolves (i.e. BEFORE any run*Flow call via routeFn).  ClarifyNeeded is thrown
//   by parseFn so flowEntered stays false on the clarify path — correct.
//   After the ClarifyNeeded branch, `if (flowEntered) return;` short-circuits
//   the re-broadcast for in-flow errors (the flow already emitted its own
//   error+done via the emit-then-rethrow pattern in resy/weather/amazon/punt).
//   Only PRE-flow errors (flowEntered === false, i.e. parseIntent-stage throws)
//   reach the broadcast block below.
//
// G2 — friendly non-command substitution (pre-flow branch only):
//   When the raw error message matches the "couldn't read this as a command"
//   signature (AI-SDK structured-output failure OR ZodError schema mismatch),
//   substitute a static scope-clarifying message instead of leaking the raw
//   AI-SDK error to the UI.  Conversational replies are NOT added (D1 dropped).
//
// SECURITY (T-01-10): broadcast message is ONLY the controlled friendly string,
//   err.message, or String(err) — never process.env.*, never an API key, never
//   a stack trace.  The friendly-substitution path also carries no internals.
// ---------------------------------------------------------------------------
export async function dispatchVia(
  parseFn: (text: string) => Promise<Intent>,
  routeFn: (intent: Intent) => Promise<void>,
  broadcastFn: (event: ServerEventType) => void,
  text: string,
): Promise<void> {
  let flowEntered = false;
  try {
    const intent = await parseFn(text);
    // Non-command guard (Test 7): a vague/non-command input parses as a VALID intent that
    // routes to the weather flow (anything not resy/amazon/punt falls to the weather else-branch)
    // with a blank location, so it never reaches the parse-failure (G2) path below. Routing it
    // runs a doomed weather flow that throws a raw "No NWS coordinates for location ''" at the
    // user. Catch ANY weather-branch-bound intent with a blank location → friendly scope message
    // (the LLM emits "weather" OR an empty/unknown site for non-commands; both must be caught).
    if (isBlank(intent.location) && intent.site !== "resy" && intent.site !== "amazon" && intent.site !== "punt") {
      broadcastFn({ type: "error", message: FRIENDLY_NON_COMMAND });
      broadcastFn({ type: "done" });
      return;
    }
    flowEntered = true; // set FIRST, before any run*Flow call via routeFn
    await routeFn(intent);
  } catch (err: unknown) {
    // ClarifyNeeded → clarify event, return WITHOUT done (run is paused awaiting answer).
    // MUST be first — ClarifyNeeded is not a flow error.
    if (err instanceof ClarifyNeeded) {
      broadcastFn({ type: "clarify", question: err.question, options: err.options });
      return; // do NOT broadcast done
    }

    // G1: in-flow throw — the flow already emitted its own error+done (emit-then-rethrow
    // pattern in resy/weather/amazon/punt). Do NOT re-broadcast. flowEntered is true
    // only when parseFn resolved AND routeFn was called (i.e. a run*Flow was invoked).
    if (flowEntered) return;

    // PRE-flow error (parseIntent-stage throw, flowEntered === false).
    // G2: detect "couldn't read this as a command" signature and substitute friendly copy.
    // SECURITY (T-01-10): message is only the controlled friendly string or err.message/String(err).
    const rawMsg = err instanceof Error ? err.message : String(err);
    const isNonCommandFailure =
      rawMsg.includes("No object generated") ||
      rawMsg.includes("did not match schema") ||
      (err instanceof Error && err.name === "ZodError");

    const message = isNonCommandFailure ? FRIENDLY_NON_COMMAND : rawMsg;

    broadcastFn({ type: "error", message });
    broadcastFn({ type: "done" });
  }
}

/**
 * Start the static HTTP server and attach the ws stub.
 *
 * PORT resolution: opts.port > process.env.PORT > 3000
 *
 * Serves public/index.html (200, text/html) at all paths.
 * On ws "connection", sends ONE status event (Phase-4 seam).
 * Logs "Ready → http://localhost:PORT" (RESEARCH Open Question 3: print URL, don't auto-open).
 *
 * @returns { server, broadcast } — the http.Server and the broadcast helper
 *   broadcast fans a typed ServerEventType to all currently OPEN ws clients.
 *   Destructure at the call site to obtain the broadcast fn for future wiring.
 */
/**
 * buildVenuePinnedCommand — rebuild a fully-specified, venue-named Resy command from a
 * parsed intent + the venue actually reached. Used when the flow offers a next-available
 * slot: re-parsing this (merged with the "Book <slot>" answer) pins the SAME venue at the
 * chosen time instead of re-searching a cuisine target (which could drift to another place).
 * Exported for unit testing.
 */
export function buildVenuePinnedCommand(intent: Intent, venue: string): string {
  return `book a table for ${intent.party} on ${intent.date[0]} at ${venue} in ${intent.location}`;
}

export function startServer(opts?: { port?: number }) {
  // PORT resolution: opts.port > a VALID positive numeric process.env.PORT > 3000.
  // Number("") === 0 and Number("abc") === NaN would otherwise silently bind to a
  // random/zero port, so coerce any non-positive / non-integer value back to 3000.
  const envPort = Number(process.env.PORT);
  const PORT = opts?.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 3000);

  // Fatal boot-error handler. A failed listen() (e.g. EADDRINUSE) emits 'error' on the
  // http server, and `ws` forwards that same error to the WebSocketServer instance — so
  // this is attached to BOTH below, registered before listen(). Without a handler on the
  // wss, the forwarded error is unhandled and crashes the process with a raw stack trace.
  const onFatalServerError = (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `✗ Port ${PORT} is already in use. Set a different PORT (e.g. PORT=3001 npm start) or free it.`,
      );
    } else {
      console.error(`✗ Server error: ${err.message}`);
    }
    process.exit(1);
  };

  // Resolve index.html relative to THIS module file (works whether compiled to dist/ or run by tsx).
  // import.meta.url is the file:// URL of THIS module; ../../public/index.html walks up two dirs:
  //   src/server/server.ts → src/ → project root → public/index.html
  const indexPath = new URL("../../public/index.html", import.meta.url);

  // ---------------------------------------------------------------------------
  // STATIC_MAP: whitelist of known paths → { file specifier, content-type }
  // Phase 4 extension (T-04-path): static file lookup using ONLY this map.
  // Never construct a filesystem path from req.url — whitelist only (path-traversal mitigation).
  // Order is load-bearing: STATIC_MAP dispatch MUST precede the htmlCache block (PATTERNS Pitfall 1).
  // ---------------------------------------------------------------------------
  const STATIC_MAP: Record<string, { file: string; contentType: string }> = {
    "/styles.css":  { file: "../../public/styles.css",  contentType: "text/css; charset=utf-8" },
    "/app.js":      { file: "../../public/app.js",      contentType: "text/javascript; charset=utf-8" },
    "/fonts/STKBureauSerif-ExtraLight-Trial.otf": {
      file: "../../public/fonts/STKBureauSerif-ExtraLight-Trial.otf", contentType: "font/otf" },
    "/fonts/Inter-Regular.woff2":  { file: "../../public/fonts/Inter-Regular.woff2",  contentType: "font/woff2" },
    "/fonts/Inter-Medium.woff2":   { file: "../../public/fonts/Inter-Medium.woff2",   contentType: "font/woff2" },
    "/fonts/Inter-SemiBold.woff2": { file: "../../public/fonts/Inter-SemiBold.woff2", contentType: "font/woff2" },
  };

  const server = createServer(async (req, res) => {
    // Phase 4: static-asset dispatch — FIRST, before the index.html catch-all.
    // Only serves paths present in STATIC_MAP (whitelist only, no FS traversal).
    const url = req.url ?? "/";
    const staticEntry = STATIC_MAP[url];
    if (staticEntry) {
      try {
        const filePath = new URL(staticEntry.file, import.meta.url); // same ESM pattern as indexPath
        const content = await readFile(filePath);                    // Buffer — fonts are binary
        res.writeHead(200, { "content-type": staticEntry.contentType });
        res.end(content);
        return;
      } catch {
        // File not found — return 404 with the expected content-type so the browser's
        // font-face fallback stack activates gracefully (the OTF is intentionally absent).
        res.writeHead(404, { "content-type": staticEntry.contentType });
        res.end("Not Found");
        return;
      }
    }

    // Catch-all: serve index.html for all other paths (SPA / root).
    // Read per request (like the STATIC_MAP assets) so edits to public/index.html show
    // on refresh without a server restart. tsx watch only reloads on src/ changes, so a
    // first-request cache here silently strands public/ edits (the SF-note bug). The
    // disk read is negligible for this local single-user tool.
    try {
      const html = await readFile(indexPath, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      // A missing/unreadable public/index.html must NOT surface as an unhandled
      // promise rejection that crashes the process with a raw stack trace.
      // Respond with a clean 500 and log a one-line reason (never a key value).
      console.error(
        `Failed to serve index.html: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    }
  });

  // Catch http-server-level errors (e.g. EADDRINUSE from listen) before they go unhandled.
  server.on("error", onFatalServerError);

  // Attach the WebSocketServer to the same underlying http.Server.
  // Phase 1: inbound "command" message runs parseIntent → runWeatherFlow with broadcast.
  // Phase 4 carries full typed ClientEvent Zod validation over this socket (T-00-04 accepted).
  const wss = new WebSocketServer({ server });

  // `ws` forwards the underlying http server's 'error' (incl. EADDRINUSE) to the wss
  // instance; without this handler that forwarded error is unhandled and crashes.
  wss.on("error", onFatalServerError);

  // ---------------------------------------------------------------------------
  // broadcast: fan a typed ServerEventType to all currently OPEN ws clients.
  // Defined after wss construction so it can close over wss.clients.
  // ---------------------------------------------------------------------------
  const broadcast = (event: ServerEventType): void => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Phase 4: single-active-run guard state — closure-scoped inside startServer().
  // NO sh handle here — each run*Flow owns its own createStagehand→init→close.
  // cancelRequested is the only cross-boundary state; the loop reads it via isCancelled.
  // ---------------------------------------------------------------------------
  let runActive = false;
  let cancelRequested = false;
  let savedCommandText = "";
  // offeredOnce: set when the resy flow offers a next-available slot (so the retry run
  // passes allowOffer=false → no second offer). Reset on every fresh command.
  let offeredOnce = false;

  // ---------------------------------------------------------------------------
  // deriveDayNames: map Intent.date ISO strings to requestedDayNames for the oracle.
  //   - If a date equals today's UTC date, use "Today" (NWS shows "Today" for the current day)
  //   - Otherwise use the UTC day name (e.g. "Saturday", "Sunday", "Monday"…)
  // This handles the general case: Sat=Today when today IS Saturday, but also
  // Sun=Today when today IS Sunday (today is 2026-05-31, Sunday).
  // ---------------------------------------------------------------------------
  const UTC_DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"] as const;

  function deriveDayNames(intentDates: string[]): string[] {
    const todayIso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    return intentDates.map((iso) => {
      if (iso === todayIso) return "Today";
      const [year, month, day] = iso.split("-").map(Number);
      const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      return UTC_DAY_NAMES[utcDay];
    });
  }

  // ---------------------------------------------------------------------------
  // dispatchCommand: parseIntent → route by site → run*Flow with isCancelled.
  // Each flow call passes () => cancelRequested as the trailing isCancelled arg
  // (Plan 04-02 added isCancelled? to LoopConfig + flow signatures).
  // Delegates broadcast arithmetic to dispatchVia (testable seam — Option A).
  // runActive MUST reset in the .finally() wrapping this entire call (Pitfall 5).
  // ---------------------------------------------------------------------------
  function dispatchCommand(text: string): Promise<void> {
    const realRouter = async (intent: Intent): Promise<void> => {
      // Route by site. deriveDayNames is weather-specific — kept on weather branch ONLY.
      if (intent.site === "resy") {
        // When the flow offers a next-available slot, rebuild the saved command venue-pinned
        // so the "Book <slot>" answer re-parses to the SAME venue (the slot rides in the answer
        // text). allowOffer is false on a retry (offeredOnce already set) → no second offer.
        const onOfferSlots = (venue: string, _slot: string): void => {
          savedCommandText = buildVenuePinnedCommand(intent, venue);
          offeredOnce = true;
        };
        return runResyFlow(intent, broadcast, () => cancelRequested, !offeredOnce, onOfferSlots);
      }
      if (intent.site === "amazon") {
        return runAmazonFlow(intent, broadcast, () => cancelRequested);
      }
      if (intent.site === "punt") {
        return runPuntFlow(intent, broadcast, () => cancelRequested);
      }
      if (intent.site === "flights") {
        return runFlightsFlow(intent, broadcast, () => cancelRequested);
      }
      // Weather and all other sites: derive requestedDayNames from parsed ISO dates.
      const requestedDayNames = deriveDayNames(intent.date);
      return runWeatherFlow(intent.location, requestedDayNames, broadcast, () => cancelRequested);
    };

    return dispatchVia(parseIntent, realRouter, broadcast, text);
  }

  wss.on("connection", (sock) => {
    // A socket that errors mid-send (e.g. the browser tab closes) must not throw
    // an uncaught exception and crash the server — swallow it quietly.
    sock.on("error", () => {});

    // Phase 4 (Task 3): disconnect cleanup.
    // If the browser disconnects mid-run, signal the loop to halt at the next step.
    // The running flow's own finally { await sh.close() } tears down Chromium — no orphan.
    // No sh handle here (each flow owns its browser — PATTERNS Run-state vars note).
    sock.on("close", () => {
      if (runActive) {
        cancelRequested = true;
      }
    });

    // Phase 4: full inbound handler — ClientEvent safeParse + single-run guard +
    // command / answer / stop branches (Task 2). Disconnect cleanup in Task 3.
    sock.on("message", (raw) => {
      // Phase 4: Zod safeParse replaces the untyped JSON.parse cast (closes T-00-04, SC4).
      // JSON.parse failure yields null → safeParse fails → silently dropped (never throws).
      const parsed = ClientEvent.safeParse(
        (() => { try { return JSON.parse(raw.toString()); } catch { return null; } })(),
      );
      if (!parsed.success) return; // malformed — silently drop

      const msg = parsed.data; // ClientEventType — fully typed discriminated union

      if (msg.type === "command") {
        if (runActive) return;              // single-active-run guard (D-01)
        runActive = true;
        cancelRequested = false;
        savedCommandText = msg.text;        // save for D-04 answer-merge
        offeredOnce = false;                // fresh command resets the offer-once guard
        dispatchCommand(msg.text).finally(() => {
          runActive = false;
          cancelRequested = false;
          // Note: ClarifyNeeded catch returns without done, so runActive resets here;
          // the answer branch will re-set runActive=true when the answer arrives.
        });
      }

      if (msg.type === "answer") {
        // D-04: re-dispatch parseIntent with merged text (savedCommandText + answer).
        // Guard: if no prior command was saved, there is nothing to answer → drop.
        // Guard: if a run is already active, the answer arrived too late → drop.
        if (runActive || !savedCommandText) return;
        // Decline of a next-available-slot offer → stop, do not retry.
        if (offeredOnce && msg.text.trim().toLowerCase() === "no") {
          offeredOnce = false;
          savedCommandText = "";
          broadcast({ type: "done" });
          return;
        }
        runActive = true;
        cancelRequested = false;
        // Locked separator convention (RESEARCH Open Questions (RESOLVED) #1):
        const mergedText = `${savedCommandText} — user clarified: ${msg.text}`;
        // WR-01: accumulate so multi-round clarify keeps EVERY prior answer. Without this,
        // the next answer re-merges against the original text and drops earlier answers
        // (e.g. answer "Sushi" → asked guests → answer "2" re-merges vs original, loses
        // "Sushi", re-asks "which restaurant?" — the duplicate-clarify bug).
        savedCommandText = mergedText;
        dispatchCommand(mergedText).finally(() => {
          runActive = false;
          cancelRequested = false;
        });
      }

      if (msg.type === "stop") {
        // D-02: signal the loop to halt at the next inter-step boundary.
        // Do NOT emit done — the loop's isCancelled branch emits exactly one done (Pitfall 3).
        // Do NOT call any close — the flow's own finally closes the browser.
        if (!runActive) return;
        cancelRequested = true;
      }
    });

    // Outbound: send status-on-connect so the client knows the backend is ready.
    broadcast({ type: "status", step: 0, text: "Backend ready." });
  });

  server.listen(PORT, () => {
    // SECURITY: never log API key values here (T-00-03). Logging only the URL is safe.
    console.log(`Ready → http://localhost:${PORT}`);
  });

  return { server, broadcast };
}
