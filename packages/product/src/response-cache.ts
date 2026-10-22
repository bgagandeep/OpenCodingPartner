import { createHash } from "node:crypto";
import { estimateTokens } from "./context.js";

/** Reads and searches are deterministic. Writes, shell, tests, and the virtual computer are not. */
const CACHEABLE_TOOLS = new Set([
  "workspace_read",
  "workspace_list",
  "workspace_grep",
  "workspace_glob",
  "tool_describe",
  "tool_search",
  "tool_output_read",
  "memory_search",
  "history_search",
  "history_read",
]);

export const RESPONSE_CACHE_LIMIT = 40;
export const RESPONSE_CACHE_VALUE_CAP = 16_000;

export interface ResponseCacheEntry {
  kind: "tool" | "model";
  key: string;
  value: string;
}

export function isCacheableTool(name: string): boolean {
  return CACHEABLE_TOOLS.has(name);
}

export function modelResponseIsCacheable(toolNames: string[]): boolean {
  return toolNames.every((name) => isCacheableTool(name));
}

export function responseCacheKey(kind: "tool" | "model", value: unknown): string {
  return createHash("sha256").update(`${kind}\0${stableJson(value)}`).digest("hex");
}

export function toolCacheKey(name: string, args: Record<string, unknown>): string {
  return responseCacheKey("tool", { name, args });
}

export function modelCacheKey(model: string, messages: unknown, toolNames: string[]): string {
  return responseCacheKey("model", { model, messages, toolNames });
}

export function lookupResponse(
  entries: ResponseCacheEntry[] | undefined,
  kind: "tool" | "model",
  key: string,
): string | undefined {
  return entries?.find((entry) => entry.kind === kind && entry.key === key)?.value;
}

/** Store the full text. A value over the cap is left uncached so a hit never returns a cut-off file or completion. */
export function storeResponse(
  entries: ResponseCacheEntry[] | undefined,
  kind: "tool" | "model",
  key: string,
  value: string,
): ResponseCacheEntry[] {
  const current = entries ?? [];
  if (value.length > RESPONSE_CACHE_VALUE_CAP) return current;
  const next = current.filter((entry) => !(entry.kind === kind && entry.key === key));
  next.push({ kind, key, value });
  if (next.length > RESPONSE_CACHE_LIMIT) next.splice(0, next.length - RESPONSE_CACHE_LIMIT);
  return next;
}

export function forgetToolResponses(entries: ResponseCacheEntry[] | undefined): ResponseCacheEntry[] {
  return (entries ?? []).filter((entry) => entry.kind !== "tool");
}

const REPLAY_MODEL = "Plan the change to packages/product/src/server.ts. Error: workspace_patch failed: hunk did not match. Decision: keep the draft reply.";
const REPLAY_TOOL = "packages/product/src/server.ts\nError: workspace_patch failed in packages/product/src/server.ts: hunk did not match.\nDecision: keep the draft reply in the app.";

/** Fixed session-cache transcript. Separate from the rolling, trim, retrieval, and routing replays. */
export function responseCacheReplayTokens(): { beforeEstimated: number; afterEstimated: number } {
  const modelKey = modelCacheKey("stub-model", [{ role: "user", content: REPLAY_MODEL }], ["workspace_read"]);
  const readKey = toolCacheKey("workspace_read", { path: "packages/product/src/server.ts" });
  let entries: ResponseCacheEntry[] = [];
  let afterEstimated = 0;
  for (const text of [REPLAY_MODEL, REPLAY_MODEL]) {
    if (lookupResponse(entries, "model", modelKey) === undefined) {
      afterEstimated += estimateTokens(text);
      entries = storeResponse(entries, "model", modelKey, text);
    }
  }
  for (const text of [REPLAY_TOOL, REPLAY_TOOL]) {
    if (lookupResponse(entries, "tool", readKey) === undefined) {
      afterEstimated += estimateTokens(text);
      entries = storeResponse(entries, "tool", readKey, text);
    }
  }
  return {
    beforeEstimated: estimateTokens(REPLAY_MODEL) * 2 + estimateTokens(REPLAY_TOOL) * 2,
    afterEstimated,
  };
}

export function responseCacheReplayKept(): { model: string; tool: string } {
  return { model: REPLAY_MODEL, tool: REPLAY_TOOL };
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
    return sorted;
  }
  return value;
}
