/**
 * Test suite for src/config/env.ts
 *
 * Runner: Node built-in `node:test` (zero-dep — no Jest/Vitest)
 * Run with: node --test
 *
 * Covers:
 *   SC4 — provider auto-detect: ANTHROPIC-only, OPENAI-only, BOTH keys (tie-break), whitespace-only = absent
 *   SC3 — no-key path: child-process exits 1, stderr "No LLM API key", both key names named, no stack frame
 *   DEFAULT_MODEL — exact strings present and exported
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// We'll import the module under test — but only after setting up env.
// Import must be deferred so each test controls process.env independently.
// We use a helper that re-imports via dynamic import (each call re-evaluates the module).
// IMPORTANT: Node's module cache means a bare dynamic import() is cached after the first call.
// To isolate env state we manipulate process.env around each test and rely on the
// module reading process.env at call-time (not at module-load-time).
// The implementation MUST read `process.env.*` inside the function body, not at module top-level.

let resolveProviderConfig: () => { provider: string; model: string };
let DEFAULT_MODEL: Record<string, string>;

// Save / restore env keys around each test
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
let savedEnv: Partial<Record<(typeof KEYS)[number], string | undefined>>;

before(async () => {
  // Import once; functions read process.env at call-time (not module-load-time).
  const mod = await import("./env.js");
  resolveProviderConfig = mod.resolveProviderConfig;
  DEFAULT_MODEL = mod.DEFAULT_MODEL;
});

beforeEach(() => {
  savedEnv = {};
  for (const key of KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

// ---------------------------------------------------------------------------
// DEFAULT_MODEL constant
// ---------------------------------------------------------------------------
describe("DEFAULT_MODEL", () => {
  it("exports anthropic default model string", () => {
    assert.equal(
      DEFAULT_MODEL.anthropic,
      "anthropic/claude-sonnet-4-6",
      "Anthropic default must be 'anthropic/claude-sonnet-4-6'"
    );
  });

  it("exports openai default model string", () => {
    assert.equal(
      DEFAULT_MODEL.openai,
      "openai/gpt-5.5",
      "OpenAI default must be 'openai/gpt-5.5'"
    );
  });
});

// ---------------------------------------------------------------------------
// resolveProviderConfig() — SC4: provider auto-detect permutations
// ---------------------------------------------------------------------------
describe("resolveProviderConfig()", () => {
  it("ANTHROPIC-only key → returns anthropic provider and model", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test123";

    const result = resolveProviderConfig();

    assert.equal(result.provider, "anthropic");
    assert.equal(result.model, "anthropic/claude-sonnet-4-6");
  });

  it("OPENAI-only key → returns openai provider and model", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test456";

    const result = resolveProviderConfig();

    assert.equal(result.provider, "openai");
    assert.equal(result.model, "openai/gpt-5.5");
  });

  it("BOTH keys → resolves to anthropic (tie-break) and returns anthropic model", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test123";
    process.env.OPENAI_API_KEY = "sk-openai-test456";

    const result = resolveProviderConfig();

    assert.equal(result.provider, "anthropic");
    assert.equal(result.model, "anthropic/claude-sonnet-4-6");
  });

  it("whitespace-only ANTHROPIC key is treated as absent (trim check)", () => {
    process.env.ANTHROPIC_API_KEY = "   ";
    process.env.OPENAI_API_KEY = "sk-openai-real";

    const result = resolveProviderConfig();

    assert.equal(result.provider, "openai");
    assert.equal(result.model, "openai/gpt-5.5");
  });

  it("whitespace-only OPENAI key is treated as absent (trim check)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-real";
    process.env.OPENAI_API_KEY = "   ";

    const result = resolveProviderConfig();

    assert.equal(result.provider, "anthropic");
    assert.equal(result.model, "anthropic/claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------
// No-key path — SC3: child process exits 1, friendly message, no stack frame
//
// We spawn a child process so process.exit(1) does NOT kill this test runner.
// ---------------------------------------------------------------------------
describe("no-key path (SC3)", () => {
  it("exits 1 when both keys are absent, prints 'No LLM API key', names both key names, no stack frame", () => {
    // Path to a tiny inline script that imports env.ts and calls resolveProviderConfig
    // We use tsx to transpile TypeScript on-the-fly (zero-dep for dev runtime)
    const tsxBin = resolve(__dirname, "../../node_modules/.bin/tsx");

    const inlineScript = `
import { resolveProviderConfig } from "./src/config/env.js";
resolveProviderConfig();
`;

    const projectRoot = resolve(__dirname, "../../");

    const result = spawnSync(tsxBin, ["--input-type=module"], {
      input: inlineScript,
      cwd: projectRoot,
      env: {
        // Inherit PATH so tsx can find modules, but strip both API keys
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Explicitly unset both provider keys
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      },
      encoding: "utf8",
    });

    // exit code must be 1 (non-zero)
    assert.equal(result.status, 1, `Expected exit 1, got ${result.status}. stderr: ${result.stderr}`);

    const stderr = result.stderr ?? "";

    // Must contain the "No LLM API key" sentinel
    assert.match(stderr, /No LLM API key/i, "stderr must contain 'No LLM API key'");

    // Must name BOTH key names (not just one)
    assert.match(stderr, /ANTHROPIC_API_KEY/, "stderr must name ANTHROPIC_API_KEY");
    assert.match(stderr, /OPENAI_API_KEY/, "stderr must name OPENAI_API_KEY");

    // Must NOT contain stack frame text
    const stackFramePatterns = [
      /at Object\.<anonymous>/,
      /at Module\._compile/,
      /node:internal/,
      /at file:\/\//,
    ];
    for (const pattern of stackFramePatterns) {
      assert.doesNotMatch(
        stderr,
        pattern,
        `stderr must not contain stack frame text matching ${pattern}`
      );
    }
  });
});
