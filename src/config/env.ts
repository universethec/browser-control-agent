/**
 * src/config/env.ts
 *
 * Provider auto-detect + default model map + friendly missing-key guard.
 *
 * Reads ANTHROPIC_API_KEY / OPENAI_API_KEY from process.env at call-time
 * (NOT at module-load-time — keeps functions pure + testable without mocking).
 *
 * Exports:
 *   type Provider           — "anthropic" | "openai"
 *   DEFAULT_MODEL           — Record<Provider, string>  (one-line model swap — A2/A3)
 *   resolveProviderConfig() — detects provider from env, returns { provider, model }
 *   printMissingKeyHelp()   — one-line fix to stderr naming BOTH keys; never logs key VALUES (T-00-03)
 *
 * ESM note (Pitfall 6): callers import from "../config/env.js" with .js specifier.
 */

import chalk from "chalk";

export type Provider = "anthropic" | "openai";

/**
 * Default model per provider, in Stagehand's "provider/model" string form.
 * Exported as a NAMED CONSTANT so a wrong model ID is a one-line fix (Assumptions Log A2/A3).
 *
 * Stagehand v3 auto-loads the matching provider key from the environment
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY) when given a "provider/model" string.
 *
 * [CITED: platform.claude.com/docs/en/about-claude/models/overview — claude-sonnet-4-6]
 * [CITED: developers.openai.com/api/docs/models — gpt-5.5]
 */
export const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "anthropic/claude-sonnet-4-6",
  openai:    "openai/gpt-5.5",
};

/**
 * Prints a single actionable fix to stderr naming BOTH provider keys.
 * Never logs or echoes key VALUES (threat T-00-03: Information Disclosure).
 *
 * Called by resolveProviderConfig() when neither key is present.
 * Also exported so Phase 1's catch block can reuse the exact wording on 401 errors.
 */
export function printMissingKeyHelp(): void {
  // SECURITY: never pass process.env.*_API_KEY to console.error / console.log.
  // The message names the variable names (ANTHROPIC_API_KEY, OPENAI_API_KEY), never their values.
  console.error(
    "\n" +
    chalk.red.bold("✗ No LLM API key found.") + "\n\n" +
    "  Set one of: " +
    chalk.cyan("ANTHROPIC_API_KEY") + " or " + chalk.cyan("OPENAI_API_KEY") + "\n\n" +
    "  Fix: " + chalk.cyan("cp .env.example .env") +
    " then add one line:\n" +
    "    " + chalk.cyan("ANTHROPIC_API_KEY=sk-ant-…") +
    "  (or " + chalk.cyan("OPENAI_API_KEY=sk-…") + ")\n\n" +
    "  Then re-run " + chalk.cyan("npm start") + ".\n"
  );
}

/**
 * Detects which LLM provider key is present in the environment and returns
 * the provider name + its default model string.
 *
 * Rules:
 *   - Whitespace-only key → treated as ABSENT (trim check)
 *   - ANTHROPIC-only      → { provider: "anthropic", model: DEFAULT_MODEL.anthropic }
 *   - OPENAI-only         → { provider: "openai",    model: DEFAULT_MODEL.openai }
 *   - BOTH keys           → Anthropic wins (DEC-model tie-break); logs a dim note that OpenAI is also available
 *   - Neither key         → calls printMissingKeyHelp() then process.exit(1) (SC3)
 *
 * Reads process.env at call-time so permutation tests can manipulate env around each call.
 *
 * @throws Never — exits via process.exit(1) instead of throwing, so the error is friendly (SC3).
 */
export function resolveProviderConfig(): { provider: Provider; model: string } {
  // Read at call-time (NOT module-load-time) — ensures tests can set/restore env per-test.
  const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY?.trim());
  const hasOpenAI    = !!(process.env.OPENAI_API_KEY?.trim());

  if (hasAnthropic && hasOpenAI) {
    // Both keys present: pick Anthropic deterministically (DEC-model order).
    // Log a dim informational note — NOT a warning, NOT the key value.
    // SECURITY: only log the provider NAME, never the key value.
    console.log(
      chalk.dim("Both ANTHROPIC_API_KEY and OPENAI_API_KEY found — using Anthropic. " +
        "Remove ANTHROPIC_API_KEY to switch to OpenAI.")
    );
    return { provider: "anthropic", model: DEFAULT_MODEL.anthropic };
  }

  if (hasAnthropic) {
    return { provider: "anthropic", model: DEFAULT_MODEL.anthropic };
  }

  if (hasOpenAI) {
    return { provider: "openai", model: DEFAULT_MODEL.openai };
  }

  // Neither key is present (or both are whitespace-only).
  printMissingKeyHelp();
  process.exit(1);
}
