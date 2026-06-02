/**
 * src/agent/stagehand.ts
 *
 * Lazy LOCAL Stagehand factory.
 *
 * Source: RESEARCH.md Pattern 3 (createStagehand LOCAL factory)
 * Spec §9: env LOCAL, headless, viewport 1288×711
 *
 * LAZY: The factory only CONSTRUCTS the Stagehand instance — it does NOT call init().
 * Opening Chromium is a Phase-1 agent-run concern, not an import/boot concern.
 * Anti-Pattern: "Opening Chromium at boot" (see RESEARCH.md Anti-Patterns section).
 *
 * Phase-1 usage pattern (for future reference — do NOT copy here):
 *   const sh = createStagehand();
 *   await sh.init();                       // opens the headless browser
 *   const page = stagehand.context.pages()[0];  // v3 page access (changed from stagehand.page)
 *
 * ESM note (Pitfall 6): relative imports use .js specifiers under NodeNext.
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { resolveProviderConfig } from "../config/env.js";

/**
 * Returns a configured LOCAL headless Stagehand instance at viewport 1288×711.
 *
 * Config:
 *   env: "LOCAL"     — no Browserbase account needed [VERIFIED: docs.stagehand.dev/v3]
 *   model            — "provider/model" string from resolveProviderConfig(); Stagehand
 *                      auto-loads the matching key (ANTHROPIC_API_KEY / OPENAI_API_KEY)
 *   localBrowserLaunchOptions:
 *     headless: true           — explicit (default is true; clarity over brevity)
 *     viewport: 1288×711       — locked default (DEC-ui); lives HERE so all phases share it
 *     deviceScaleFactor: 2     — renders the SAME 1288×711 LOGICAL viewport at 2× device
 *                                pixels (crisp on retina displays). Does NOT change the
 *                                logical layout that selectors/oracles render against —
 *                                all flow oracles remain unaffected (G6 gap closure).
 *   verbose: 1                 — minimal logging; NOT 2 (verbose 2 logs more key-adjacent
 *                                detail — avoid per T-00-03 Information Disclosure)
 *   // experimental: true      — OPTIONAL in Stagehand v3; NOT load-bearing.
 *                                In v3, extract() with Zod works without this flag.
 *                                experimental: true only gates niche providers (e.g. Vertex).
 *                                [VERIFIED: docs.stagehand.dev/v3/references/extract]
 *                                Included here as a commented knob per DEC-framework (Pitfall 3).
 *
 * Does NOT call init() — no browser opens at import/construct time.
 *
 * REGION NOTE (known limitation): no proxy / geolocation / locale is set, so the
 * headless browser uses the host machine's real outbound IP. Target sites geolocate
 * by IP — e.g. from a non-US connection Amazon serves a non-US delivery context where
 * many products show "cannot be shipped to your selected delivery location" and Add to
 * Cart is removed. The flows are therefore scoped to a US connection (the UI's "San
 * Francisco area only" note). The Amazon oracle reports this honestly via the
 * `cannotShipToLocation` verdict (see flows/amazon.ts verifyAmazonResult step 2b)
 * rather than failing opaquely. Making it genuinely work from any region needs a US
 * proxy in localBrowserLaunchOptions — deliberately out of scope for this demo.
 */
export function createStagehand(): Stagehand {
  const { model } = resolveProviderConfig();

  return new Stagehand({
    env: "LOCAL",
    model,
    localBrowserLaunchOptions: {
      headless: true,
      // Viewport sized for the full-screen UI (was 1288x711, tuned for the old 30%
      // side-pane). A 1440x900 (16:10) capture displays near 1:1 full-screen — no
      // "zoomed-in" upscaling — and renders more of the page at natural density.
      // deviceScaleFactor:2 keeps it crisp on retina. (Overrides the prior DEC-ui
      // lock; Gauntlet to confirm flows are unaffected — desktop layout is unchanged.)
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    },
    verbose: 1,
    // experimental: true,  // OPTIONAL in v3 — harmless if set; not required for Zod extract()
  });
}
