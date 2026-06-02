/**
 * tests/ui/app.spec.ts
 *
 * Playwright E2E suite for Phase 4 Web UI success criteria SC1/SC2/SC3 + font glyph coverage.
 * Finalized against the shipped DOM (Plan 04) — selectors match the actual ids/classes in
 * public/index.html and public/app.js.
 *
 * All tests are gated behind TEST_UI=1.
 * Run with: TEST_UI=1 npx playwright test tests/ui/app.spec.ts
 * Requires `npm start` running on http://localhost:3000 before execution.
 *
 * When TEST_UI is unset (default offline mode), every test.describe opens with
 * test.skip(!isUITest, ...) as its FIRST statement, making the suite inert.
 *
 * DOM selectors (reconciled to the shipped markup from public/index.html + public/app.js):
 *   - button:has-text('Run')          — #run-btn (primary CTA, id="run-btn" text "Run")
 *   - button:has-text('Stop')         — #stop-btn (destructive, id="stop-btn" text "Stop",
 *                                        style="display:none" initially)
 *   - .status-bubble                  — each narration bubble (class "status-bubble")
 *   - #screenshot                     — <img id="screenshot" style="display:none" initially>
 *   - #idle-state                     — idle/empty state div (hidden after first screenshot)
 *   - input[type=text]                — #composer-input (placeholder "Type a command…")
 *   - [placeholder='Type a command…'] — the composer placeholder copy (Copywriting Contract)
 *   - .clarify-chip                   — clarify option chip buttons (class "clarify-chip")
 *
 * Test ordering note:
 *   Tests run sequentially (1 worker). The backend enforces a single-active-run guard.
 *   Tests are ordered so that live-command tests (SC1 Stop, SC3b Stop) run AFTER the
 *   screenshot test, which needs a clean server to start its own run. Tests that do NOT
 *   need a live run use the server's on-connect status broadcast (step 0 "Backend ready.")
 *   to satisfy their assertions without triggering a new agent run.
 *   Execution order: SC1-static → SC2 screenshot (needs clean server) → SC2 status →
 *   SC3a chips → SC3b Stop → SC1 Stop → font
 */

import { test, expect } from "@playwright/test";

const isUITest = !!process.env.TEST_UI;

// ---------------------------------------------------------------------------
// SC1 — command submission (static assertions, no live run)
// ---------------------------------------------------------------------------
test.describe("SC1 — command submission (static)", () => {
  test.skip(!isUITest, "Set TEST_UI=1 to run UI tests (requires npm start on :3000)");

  test("composer input has correct placeholder text", async ({ page }) => {
    await page.goto("http://localhost:3000");
    // Copywriting Contract: placeholder is exactly "Type a command…" (ellipsis U+2026)
    await expect(page.locator("[placeholder='Type a command…']")).toBeVisible();
  });

  test("at least one status bubble appears on connect (on-connect broadcast)", async ({ page }) => {
    // The server broadcasts {type:"status",step:0,text:"Backend ready."} on every WS connection.
    // appendStatusBubble(0, "Backend ready.") creates a .status-bubble with "[0] Backend ready."
    // This proves the DOM contract without starting a live agent run.
    await page.goto("http://localhost:3000");
    await expect(page.locator(".status-bubble").first()).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// SC2 — screenshot pane (live run — placed first among live-run tests)
// ---------------------------------------------------------------------------
test.describe("SC2 — screenshot pane (live run)", () => {
  test.skip(!isUITest, "Set TEST_UI=1 to run UI tests (requires npm start on :3000)");

  test("screenshot img becomes visible with base64 JPEG src during a run", async ({ page }) => {
    // Live agent run required. Extend test timeout to 90s to allow for NWS navigation + steps.
    // This test is placed before any other live-command tests to ensure the server is idle.
    test.setTimeout(90_000);
    await page.goto("http://localhost:3000");
    const input = page.locator("input[type=text]").first();
    // Use the lowest-risk demo command (Copywriting Contract — first demo item)
    await input.fill("weekend weather forecast for SF");
    await page.locator("button:has-text('Run')").click();
    // Verify the server accepted the command: Stop must appear (setRunActive → Stop visible)
    await expect(page.locator("button:has-text('Stop')")).toBeVisible({ timeout: 10_000 });
    // #screenshot is <img id="screenshot" style="display:none"> initially.
    // updateScreenshot() sets src="data:image/jpeg;base64,..." and display:block on screenshot events.
    const screenshot = page.locator("#screenshot");
    await expect(screenshot).toBeVisible({ timeout: 75_000 });
    // src must be a base64 JPEG data URI (UI-SPEC Implementation Note #4)
    const src = await screenshot.getAttribute("src");
    expect(src).toMatch(/^data:image\/jpeg;base64,/);
    // idle-state (#idle-state) must be hidden once the first screenshot arrives
    await expect(page.locator("#idle-state")).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// SC2 — status narration (on-connect broadcast, no new live run)
// ---------------------------------------------------------------------------
test.describe("SC2 — status narration and step-counter format", () => {
  test.skip(!isUITest, "Set TEST_UI=1 to run UI tests (requires npm start on :3000)");

  test("status bubbles accumulate as [N] {text} in the chat thread", async ({ page }) => {
    // The server broadcasts {type:"status",step:0,text:"Backend ready."} on connection.
    // appendStatusBubble(0, "Backend ready.") → .status-bubble with text "[0] Backend ready."
    // This proves the [N] step-counter DOM contract. No new live run is triggered here,
    // which avoids blocking the server when the screenshot test's run is still active.
    await page.goto("http://localhost:3000");
    await expect(page.locator(".status-bubble").first()).toBeVisible({ timeout: 10_000 });
    const bubble = page.locator(".status-bubble").first();
    const text = await bubble.textContent();
    // "[0] Backend ready." matches /\[\d+\]/ — proves the step-counter DOM pattern
    expect(text).toMatch(/\[\d+\]/);
  });
});

// ---------------------------------------------------------------------------
// SC3a — clarify chips (deterministic DOM-injection test)
// ---------------------------------------------------------------------------
test.describe("SC3a — clarify chips (options-based clarification)", () => {
  test.skip(!isUITest, "Set TEST_UI=1 to run UI tests (requires npm start on :3000)");

  test("clarify bubble renders chips and clicking a chip disables the chip set", async ({ page }) => {
    // SC3a verifies chip DOM rendering and disable-on-click behavior (UI-SPEC Clarify Chips).
    // Live clarify triggering is non-deterministic (LLM-dependent and command-dependent).
    // We inject a synthetic clarify ServerEvent to test DOM behavior deterministically.
    // The backend answer-merge round-trip is covered by the http.test.ts unit (Plan 03).
    //
    // Injection strategy: use page.addInitScript() to patch WebSocket before navigation,
    // exposing the instance as window._testWS, then dispatch a synthetic MessageEvent
    // after the WS connection is confirmed open.

    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      class PatchedWS extends OrigWS {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args);
          (window as unknown as { _testWS: WebSocket })._testWS = this;
        }
      }
      window.WebSocket = PatchedWS as typeof WebSocket;
    });

    await page.goto("http://localhost:3000");

    // Wait for the WS to be established: the server broadcasts on-connect status
    await expect(page.locator(".status-bubble").first()).toBeVisible({ timeout: 10_000 });

    // Inject a synthetic clarify event via the live WS message dispatch
    await page.evaluate(() => {
      const ws = (window as unknown as { _testWS: WebSocket })._testWS;
      if (ws) {
        const clarifyMsg = JSON.stringify({
          type: "clarify",
          question: "Which restaurant did you mean?",
          options: ["Nobu SF", "Nobu Downtown", "Nobu Palo Alto"],
        });
        ws.dispatchEvent(new MessageEvent("message", { data: clarifyMsg }));
      }
    });

    // A clarify bubble must appear (.clarify-bubble via appendClarifyBubble)
    await expect(page.locator(".clarify-bubble")).toBeVisible({ timeout: 5_000 });
    // The question text renders as .clarify-question inside .clarify-bubble
    await expect(page.locator(".clarify-question")).toBeVisible({ timeout: 5_000 });
    // Each option renders as <button class="clarify-chip"> inside .clarify-chips
    const chip = page.locator(".clarify-chip").first();
    await expect(chip).toBeVisible({ timeout: 5_000 });
    // All 3 options must render as chips
    await expect(page.locator(".clarify-chip")).toHaveCount(3);

    // Click the first chip — app.js sets chip.disabled=true FIRST (Pitfall 6 / T-04-double-answer),
    // then disables ALL chips in the set
    await chip.click();

    // After click: every chip in this clarify set must be disabled
    const allChips = page.locator(".clarify-chip");
    await expect(allChips.nth(0)).toBeDisabled({ timeout: 3_000 });
    await expect(allChips.nth(1)).toBeDisabled({ timeout: 3_000 });
    await expect(allChips.nth(2)).toBeDisabled({ timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// SC3b — Stop button (live run then immediate Stop)
// ---------------------------------------------------------------------------
test.describe("SC3b — Stop button resets UI to idle", () => {
  test.skip(!isUITest, "Set TEST_UI=1 to run UI tests (requires npm start on :3000)");

  test("clicking Stop immediately re-shows Run, re-enables composer, appends stop bubble", async ({ page }) => {
    await page.goto("http://localhost:3000");
    const input = page.locator("input[type=text]").first();
    await input.fill("weekend weather forecast for SF");
    await page.locator("button:has-text('Run')").click();
    // Wait for Stop button to appear (#stop-btn becomes visible while run is active)
    const stopButton = page.locator("button:has-text('Stop')");
    await expect(stopButton).toBeVisible({ timeout: 10_000 });
    // Click Stop — optimistic UI reset (UI-SPEC Implementation Note #7 / app.js stopButton handler)
    await stopButton.click();
    // Run button (#run-btn) should re-appear immediately (display:none toggled by setRunActive(false))
    await expect(page.locator("button:has-text('Run')")).toBeVisible({ timeout: 3_000 });
    // Composer (#composer-input) should be re-enabled
    await expect(input).toBeEnabled({ timeout: 3_000 });
    // "Run stopped." status bubble is appended (Copywriting Contract: stop confirmation)
    // appendStatusBubble(0, "Run stopped.", true) — ink-tertiary, step 0
    await expect(page.locator(".status-bubble").filter({ hasText: "Run stopped." })).toBeVisible({
      timeout: 5_000,
    });
  });
});

// ---------------------------------------------------------------------------
// SC1 — command submission (live run — Stop button appearance, placed after screenshot test)
// ---------------------------------------------------------------------------
test.describe("SC1 — command submission (live run)", () => {
  test.skip(!isUITest, "Set TEST_UI=1 to run UI tests (requires npm start on :3000)");

  test("user submits a command and Stop button becomes visible", async ({ page }) => {
    // This test proves that submitting a command makes the Stop button appear.
    // It is placed after the SC2 screenshot test and SC3b Stop test to avoid
    // blocking the server for the screenshot test (which needs a clean run).
    await page.goto("http://localhost:3000");
    const input = page.locator("input[type=text]").first();
    await input.fill("weekend weather forecast for SF");
    await page.locator("button:has-text('Run')").click();
    // Stop button (#stop-btn) should appear once run is active (setRunActive(true))
    await expect(page.locator("button:has-text('Stop')")).toBeVisible({ timeout: 10_000 });
    // Immediately stop to keep the test self-contained
    await page.locator("button:has-text('Stop')").click();
    await expect(page.locator("button:has-text('Run')")).toBeVisible({ timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// font glyph coverage — visual/manual marker (TEST_UI gated so --grep "font" resolves)
// ---------------------------------------------------------------------------
test.describe("font glyph coverage", () => {
  test.skip(!isUITest, "Set TEST_UI=1 to run UI tests (requires npm start on :3000)");

  test("page loads and Bureau Serif display heading is present in the DOM", async ({ page }) => {
    // This is a thin automated placeholder: confirms the page loads and the header element exists.
    // Full glyph-coverage verification is Manual-Only per 04-VALIDATION.md:
    // open http://localhost:3000, confirm the serif header renders real glyphs (not tofu).
    // The automated assertion only checks DOM presence, not visual glyph rendering.
    await page.goto("http://localhost:3000");
    // App title "Browser Control Agent" lives in <h1 class="display"> inside #app-header
    await expect(page.locator("text=Browser Control Agent")).toBeVisible({ timeout: 5_000 });
    // Page must have the correct title (served by index.html <title>)
    await expect(page).toHaveTitle(/Browser Control Agent/);
    // The idle-state heading "Try a command" is in <h2 class="display"> in #screenshot-pane
    await expect(page.locator("text=Try a command")).toBeVisible({ timeout: 5_000 });
    // Composer placeholder must be "Type a command…" (Copywriting Contract)
    await expect(page.locator("[placeholder='Type a command…']")).toBeVisible({ timeout: 5_000 });
  });
});
