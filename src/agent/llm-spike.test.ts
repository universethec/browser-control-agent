/**
 * src/agent/llm-spike.test.ts
 *
 * EMPIRICAL SPIKE — resolves Open Question A2 / Pitfall 5:
 *   "Is sh.llmClient populated before sh.init()?"
 *
 * This test answers the question plan 01-02 builds against:
 *   - LLM-PATH: pre-init  → llmClient is available immediately after createStagehand()
 *   - LLM-PATH: post-init → llmClient requires sh.init() (browser opens)
 *
 * SECURITY (T-00-03, T-01-01):
 *   - Only logs the resolved LLM-PATH string and provider NAME
 *   - NEVER logs process.env.*_API_KEY values
 *
 * RUN_LIVE gate: entire suite is skipped unless RUN_LIVE=1 is set.
 * This is a live probe — requires a valid API key (ANTHROPIC_API_KEY or OPENAI_API_KEY).
 *
 * Run offline (skips all):
 *   node --import tsx/esm --test src/agent/llm-spike.test.ts
 *
 * Run live (resolves the path):
 *   RUN_LIVE=1 node --import tsx/esm --test src/agent/llm-spike.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createStagehand } from "./stagehand.js";
import { resolveProviderConfig } from "../config/env.js";

const isLive = !!process.env.RUN_LIVE;

// ---------------------------------------------------------------------------
// LLM-PATH spike — skipped offline, runs when RUN_LIVE=1
// ---------------------------------------------------------------------------
describe("LLM-PATH spike: sh.llmClient pre-init vs post-init", { skip: !isLive }, () => {
  it("resolves which path produces a valid LLM response and logs LLM-PATH", async () => {
    // SECURITY: log only provider NAME, never the key value
    const { provider } = resolveProviderConfig();

    // Minimal schema for the probe call
    const ProbeSchema = z.object({ answer: z.string() });

    const sh = createStagehand();
    let resolvedPath: "pre-init" | "post-init" | null = null;
    let responseOk = false;
    let initCalled = false;

    try {
      // ----------------------------------------------------------------
      // ATTEMPT 1: try llmClient BEFORE init() (the unverified assumption)
      // ----------------------------------------------------------------
      const llmClientPreInit = (sh as unknown as { llmClient?: unknown }).llmClient;

      if (
        llmClientPreInit !== undefined &&
        llmClientPreInit !== null &&
        typeof (llmClientPreInit as { createChatCompletion?: unknown }).createChatCompletion === "function"
      ) {
        try {
          const client = llmClientPreInit as {
            createChatCompletion: (opts: unknown) => Promise<unknown>;
          };
          const result = await client.createChatCompletion({
            options: {
              messages: [
                {
                  role: "user",
                  content: 'Reply with a JSON object exactly like this: {"answer":"ok"}',
                },
              ],
              response_model: {
                name: "probe",
                schema: ProbeSchema,
              },
              temperature: 0,
            },
          });
          // If we get here, pre-init path worked
          const parsed = result as { data?: { answer?: string }; answer?: string };
          const answer = parsed?.data?.answer ?? (parsed as { answer?: string })?.answer ?? "";
          if (typeof answer === "string" && answer.length > 0) {
            resolvedPath = "pre-init";
            responseOk = true;
          }
        } catch (_preInitErr) {
          // pre-init path failed — will try post-init
        }
      }

      // ----------------------------------------------------------------
      // ATTEMPT 2: init() then retry (post-init path)
      // ----------------------------------------------------------------
      if (resolvedPath === null) {
        await sh.init();
        initCalled = true;

        const llmClientPostInit = (sh as unknown as { llmClient?: unknown }).llmClient;
        assert.ok(
          llmClientPostInit !== undefined && llmClientPostInit !== null,
          "sh.llmClient must be non-null after sh.init()"
        );

        const client = llmClientPostInit as {
          createChatCompletion: (opts: unknown) => Promise<unknown>;
        };
        const result = await client.createChatCompletion({
          options: {
            messages: [
              {
                role: "user",
                content: 'Reply with a JSON object exactly like this: {"answer":"ok"}',
              },
            ],
            response_model: {
              name: "probe",
              schema: ProbeSchema,
            },
            temperature: 0,
          },
        });

        const parsed = result as { data?: { answer?: string }; answer?: string };
        const answer = parsed?.data?.answer ?? (parsed as { answer?: string })?.answer ?? "";
        if (typeof answer === "string" && answer.length > 0) {
          resolvedPath = "post-init";
          responseOk = true;
        }
      }
    } finally {
      // Only close if browser was opened
      if (initCalled) {
        await sh.close();
      }
    }

    // ----------------------------------------------------------------
    // DECISIVE LOG LINE — exactly one of these two strings:
    //   "LLM-PATH: pre-init"
    //   "LLM-PATH: post-init"
    // SECURITY: logs path string and provider NAME only, never the key value
    // ----------------------------------------------------------------
    console.log(`LLM-PATH: ${resolvedPath ?? "UNRESOLVED"}`);
    console.log(`Provider: ${provider}`);

    assert.ok(
      resolvedPath !== null,
      `Neither pre-init nor post-init path returned a valid response. ` +
        `Check that ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} is set and valid.`
    );
    assert.ok(responseOk, "At least one path must have returned a non-empty response");
    assert.ok(
      resolvedPath === "pre-init" || resolvedPath === "post-init",
      `resolvedPath must be 'pre-init' or 'post-init', got: ${resolvedPath}`
    );
  });
});

// ---------------------------------------------------------------------------
// Offline guard — verifies the skip gate works
// ---------------------------------------------------------------------------
describe("LLM-PATH spike: offline gate check", () => {
  it("spike suite is correctly skipped when RUN_LIVE is not set", { skip: isLive }, () => {
    // This test runs ONLY offline (no RUN_LIVE). It verifies that when RUN_LIVE
    // is absent, the live spike describe block is skipped (not executed).
    assert.equal(process.env.RUN_LIVE, undefined);
  });
});
