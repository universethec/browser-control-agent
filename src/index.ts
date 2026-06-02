/**
 * src/index.ts — Entrypoint
 *
 * Boot order is LOAD-BEARING for SC3 safety. Do not reorder.
 *
 *   1. Load .env FIRST (dotenv/config) so keys are in process.env before anything reads them.
 *   2. PRE-FLIGHT GUARD: resolveProviderConfig() either returns {provider, model}
 *      or prints the friendly one-liner and process.exit(1) — guard runs BEFORE the server
 *      so a missing key never surfaces as a deep stack trace (SC3 end-to-end).
 *   3. startServer() — only reached if a key is present.
 *
 * SECURITY (T-00-03): log only the provider NAME, never the key value.
 * NO browser launch here — Phase 0 boots the shell only; Stagehand init is Phase 1+.
 *
 * ESM note (Pitfall 6): relative imports use .js specifiers.
 */

// Step 1: load .env into process.env BEFORE reading any key.
import "dotenv/config";

// Step 2: provider guard — exits 1 with a friendly message if no key is present.
import { resolveProviderConfig } from "./config/env.js";

// Step 3: start the HTTP+ws server — only reached after the guard passes.
import { startServer } from "./server/server.js";

const { provider } = resolveProviderConfig();

// Log selected provider NAME only (never the key value — T-00-03).
console.log(`Provider: ${provider}`);

// Destructure broadcast from startServer() (Phase 1 change — startServer now returns { server, broadcast }).
// broadcast is the emit seam wired inside server.ts; index.ts boots the server and holds the reference.
// void broadcast suppresses the unused-variable lint warning at the top level; the command handler
// inside server.ts is the live consumer of broadcast at runtime.
const { broadcast } = startServer();
void broadcast;
