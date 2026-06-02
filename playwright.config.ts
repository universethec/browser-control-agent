// playwright.config.ts
// Minimal Playwright configuration for Phase 4 Web UI E2E tests.
//
// Tests live in ./tests/ui/ and run against a locally-started server on :3000.
// Do NOT add a webServer block — the server is started manually via `npm start`.
//
// The TEST_UI=1 gate is enforced inside each test file via test.skip(!isUITest, ...)
// (matches the RUN_LIVE convention used by live agent tests).
//
// Run command: TEST_UI=1 npx playwright test
// List command: TEST_UI= npx playwright test --list

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
  },
});
