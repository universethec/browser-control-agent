/**
 * src/agent/loop.ts
 *
 * Reusable observe→decide→act→verify loop harness with three hard guards (D-08).
 *
 * Architecture (DEC-reliability): Builds ONLY the gap Stagehand does not provide.
 * Stagehand provides: observe-before-act grounding, stale-ref self-heal, transient retries.
 * This module provides: outer while loop, timeout guard, 3-identical ring buffer, verifier gate.
 *
 * Key invariants:
 *   - Never calls sh.init() — caller owns the Stagehand lifecycle.
 *   - Every TERMINAL return path emits both a `result` event and a `done` event.
 *     Non-terminal (intermediate) steps set `nonTerminal:true` on the verify return value
 *     and the loop `continue`s without emitting result or done — these are bridge steps.
 *   - Page access via sh.context.pages()[0] — sh.page does not exist in Stagehand v3.
 *
 * ESM note: relative imports use .js specifiers under NodeNext.
 */

import type { Stagehand } from "@browserbasehq/stagehand";
import type { ServerEventType } from "../protocol/events.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface LoopConfig {
  /** Maximum number of act steps before giving up. Use 25 per DEC-reliability. */
  maxSteps: number;
  /** Wall-clock timeout in milliseconds. Use 300_000 (5 min) per DEC-reliability. */
  timeoutMs: number;
  /** Stop when this many consecutive identical actions are detected. Use 3 per DEC-reliability. */
  maxIdentical: number;
  /** Event emitter — receives status/screenshot/result/done events. */
  emit: (event: ServerEventType) => void;
  /**
   * Phase 4: checked at top of each loop iteration; when it returns true the loop
   * halts and emits done (stop / disconnect). Optional — omitting it preserves
   * all existing guard behavior unchanged (backward-compatible).
   */
  isCancelled?: () => boolean;
}

export interface LoopResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/**
 * Flow definition injected by the caller (e.g. weather.ts or any future flow).
 * Separates flow-specific logic from the generic loop harness.
 */
export interface FlowDefinition {
  /** Instruction passed to sh.observe() each cycle. */
  observeInstruction: string;
  /** Decide what action to take based on observe results and current step count. */
  decide: (candidates: unknown[], step: number) => FlowAction;
  /** Execute the primary extraction and return the raw result. */
  doExtract: (sh: Stagehand) => Promise<unknown>;
  /**
   * Gate success: validates the raw result against flow-specific criteria.
   *
   * Return shape: { ok, summary, reason, nonTerminal? }
   *   - nonTerminal: true  — intermediate/bridge step; the loop `continue`s without
   *                          emitting result+done. The flow uses this to signal that
   *                          doExtract performed a side-effecting action (e.g. typing,
   *                          selecting a dropdown) but the terminal extraction has not
   *                          yet occurred. Only the final terminal extraction emits
   *                          result+done.
   *   - nonTerminal absent/false — terminal step; the loop emits result+done and returns.
   *
   * Because `nonTerminal` is optional, existing callers (e.g. weather.ts) that return
   * only { ok, summary, reason } remain fully compatible without any modification.
   */
  verify: (raw: unknown) => {
    ok: boolean;
    summary: string;
    reason: string;
    nonTerminal?: boolean;
    /**
     * clarify: the flow needs a user answer before it can finish (e.g. the
     * next-available-slot offer). When present, runLoop emits ONE `clarify`
     * event and returns WITHOUT `result`/`done` — the run pauses and the
     * server's answer handler re-dispatches. Optional, so existing callers
     * (weather/amazon/punt) are unaffected.
     */
    clarify?: { question: string; options?: string[] };
  };
}

export interface FlowAction {
  type: "extract" | "act";
  /** Text for the status event narration. */
  narration: string;
  /** Used when type === "act" — passed to sh.act(). */
  instruction?: string;
}

// ---------------------------------------------------------------------------
// Core loop harness
// ---------------------------------------------------------------------------

/**
 * Runs the observe→decide→act→verify loop with three hard guards.
 *
 * Guards (DEC-reliability / D-08):
 *   1. Timeout: exits immediately if Date.now() - startMs > config.timeoutMs
 *   2. maxSteps: exits after config.maxSteps act steps
 *   3. 3-identical: exits if the last config.maxIdentical actions are all identical
 *
 * Every TERMINAL return path emits result + done before returning.
 * Non-terminal (bridge) steps set nonTerminal:true on the verify return value;
 * the loop continues without emitting result+done for those iterations.
 * Caller must call sh.init() before this function and sh.close() after.
 */
export async function runLoop(
  sh: Stagehand,
  flow: FlowDefinition,
  config: LoopConfig,
): Promise<LoopResult> {
  const startMs = Date.now();
  const recentActions: string[] = [];
  let step = 0;

  while (step < config.maxSteps) {
    // Guard 1: timeout — checked before any work
    // Use >= so that timeoutMs:0 fires immediately on the very first iteration
    if (Date.now() - startMs >= config.timeoutMs) {
      const summary = "Timeout exceeded";
      config.emit({ type: "result", ok: false, summary });
      config.emit({ type: "done" });
      return { ok: false, summary };
    }

    // Guard NEW (Phase 4): cancellation signal — fires at the next inter-step boundary.
    // Emits ONLY done (not result) because stop is an interruption, not a task outcome.
    // The client already shows "Run stopped." optimistically (D-02 / UI-SPEC Note #7).
    if (config.isCancelled?.()) {
      config.emit({ type: "done" });
      return { ok: false, summary: "Stopped" };
    }

    step++;

    // Observe — sh.observe provides grounding against the a11y tree
    const candidates = await sh.observe(flow.observeInstruction);

    // Decide — flow-specific action selection
    const action = flow.decide(candidates, step);

    // Guard 2: 3-identical actions — rolling ring buffer
    const actionKey = JSON.stringify(action);
    if (
      recentActions.length >= config.maxIdentical &&
      recentActions.every((a) => a === actionKey)
    ) {
      const summary = "Stuck: 3 identical actions in a row";
      config.emit({ type: "result", ok: false, summary });
      config.emit({ type: "done" });
      return { ok: false, summary };
    }
    recentActions.push(actionKey);
    if (recentActions.length > config.maxIdentical) recentActions.shift();

    // Emit narration status
    config.emit({ type: "status", step, text: action.narration });

    // Act — extract or click/type depending on action type
    const raw =
      action.type === "extract"
        ? await flow.doExtract(sh)
        : await sh.act(action.instruction ?? "");

    // Screenshot after every act step (D-09)
    const page = sh.context.pages()[0];
    const buf = await page.screenshot({ type: "jpeg", quality: 92 });
    config.emit({ type: "screenshot", step, jpegBase64: buf.toString("base64") });

    // Verify on extract steps — oracle gates success (D-04).
    // Bridge steps (search-typing, pick-guests, pick-time) set nonTerminal:true on the
    // verify return value — these are intermediate doExtract calls that perform an action
    // (e.g. typing, selecting a dropdown) but are not the terminal extraction.
    // The loop continues without emitting result+done for non-terminal steps.
    // Only the final terminal extraction (extract-verify / abort) emits result+done.
    if (action.type === "extract") {
      const verdict = flow.verify(raw);
      if (verdict.nonTerminal) {
        // Non-terminal bridge step — action was performed inside doExtract; continue the loop.
        continue;
      }
      // Clarify verdict — the flow needs a user answer before it can finish (e.g. the
      // next-available-slot offer). Emit exactly ONE clarify and return WITHOUT result/done;
      // the run pauses and the server's answer handler re-dispatches (mirrors pre-flow clarify).
      if (verdict.clarify) {
        config.emit({ type: "clarify", question: verdict.clarify.question, options: verdict.clarify.options });
        return { ok: false, summary: verdict.summary || "offered-alternative" };
      }
      config.emit({
        type: "result",
        ok: verdict.ok,
        summary: verdict.summary || verdict.reason,
        data: verdict.ok ? raw : undefined,
      });
      config.emit({ type: "done" });
      return {
        ok: verdict.ok,
        summary: verdict.summary || verdict.reason,
        data: verdict.ok ? raw : undefined,
      };
    }
  }

  // Guard 3: maxSteps exhausted
  const summary = `Max steps (${config.maxSteps}) reached without success`;
  config.emit({ type: "result", ok: false, summary });
  config.emit({ type: "done" });
  return { ok: false, summary };
}
