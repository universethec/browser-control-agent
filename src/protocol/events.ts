/**
 * src/protocol/events.ts
 *
 * Typed Zod discriminated unions for the backend ↔ frontend WebSocket contract.
 *
 * Source: project spec §3 "Backend ↔ frontend contract"
 * Pattern: RESEARCH.md Pattern 5 (ServerEvent / ClientEvent discriminated unions)
 *
 * PHASE 0: Declaration-only. Do NOT wire to any socket here.
 * Phase 4 validates inbound/outbound WS messages at both ends using these unions (Security V5 / T-00-04).
 *
 * Backend → Frontend:
 *   status      { step: number; text: string }           — agent narration step
 *   screenshot  { step: number; jpegBase64: string }     — per-step screenshot
 *   clarify     { question: string; options?: string[] } — agent asks the user a question
 *   result      { ok: boolean; summary: string }         — final task outcome
 *   error       { message: string }                      — agent-level error
 *   done        {}                                       — stream closed / agent finished
 *
 * Frontend → Backend:
 *   command     { text: string }  — user's natural-language task instruction
 *   answer      { text: string }  — user's response to a clarify question
 *   stop        {}                — user requests an early halt
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Backend → Frontend events
// ---------------------------------------------------------------------------

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"),     step: z.number(), text: z.string() }),
  z.object({ type: z.literal("screenshot"), step: z.number(), jpegBase64: z.string() }),
  z.object({ type: z.literal("clarify"),    question: z.string(), options: z.array(z.string()).optional() }),
  z.object({ type: z.literal("result"),     ok: z.boolean(), summary: z.string(), data: z.unknown().optional() }),
  z.object({ type: z.literal("error"),      message: z.string() }),
  z.object({ type: z.literal("done") }),
]);

/** Inferred TypeScript type for backend → frontend events */
export type ServerEventType = z.infer<typeof ServerEvent>;

// ---------------------------------------------------------------------------
// Frontend → Backend events
// ---------------------------------------------------------------------------

export const ClientEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), text: z.string() }),
  z.object({ type: z.literal("answer"),  text: z.string() }),
  z.object({ type: z.literal("stop") }),
]);

/** Inferred TypeScript type for frontend → backend events */
export type ClientEventType = z.infer<typeof ClientEvent>;
