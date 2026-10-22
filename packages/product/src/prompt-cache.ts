import { estimateTokens, type ContextTurn } from "./context.js";

export interface PromptCachePlan {
  provider: "anthropic" | "openai" | "deepseek" | "gemini" | "none";
  /** explicit sends Anthropic cache_control. automatic relies on the provider's prefix cache. */
  mode: "explicit" | "automatic";
}

type CachePart = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

export interface LaidOutMessage {
  role: string;
  content: string | CachePart[];
  [key: string]: unknown;
}

export function promptCachePlan(model: string): PromptCachePlan {
  const id = model.toLowerCase();
  if (id.includes("claude") || id.includes("anthropic")) return { provider: "anthropic", mode: "explicit" };
  if (id.includes("deepseek")) return { provider: "deepseek", mode: "automatic" };
  if (id.includes("gemini")) return { provider: "gemini", mode: "automatic" };
  if (id.includes("gpt") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4") || id.includes("openai")) {
    return { provider: "openai", mode: "automatic" };
  }
  return { provider: "none", mode: "automatic" };
}

export function layoutCachedPrompt<T extends { role: string; content?: string | null }>(input: {
  system: string;
  toolIndex: string;
  pinned: string;
  summary: string;
  recent: T[];
  model: string;
}): {
  messages: LaidOutMessage[];
  cache: PromptCachePlan;
  estimatedStableTokens: number;
  estimatedVolatileTokens: number;
} {
  const cache = promptCachePlan(input.model);
  const stable: Array<{ text: string }> = [];
  if (input.system.trim()) stable.push({ text: input.system.trim() });
  if (input.toolIndex.trim()) stable.push({ text: `Tool index:\n${input.toolIndex.trim()}` });
  if (input.pinned.trim()) stable.push({ text: `Pinned notes:\n${input.pinned.trim()}` });
  const messages: LaidOutMessage[] = stable.map((block, index) => ({
    role: "system",
    content: cache.mode === "explicit" && index === stable.length - 1
      ? [{ type: "text", text: block.text, cache_control: { type: "ephemeral" } }]
      : block.text,
  }));
  if (input.summary.trim()) {
    messages.push({ role: "system", content: `Earlier conversation summary:\n${input.summary.trim()}` });
  }
  for (const turn of input.recent) {
    messages.push({ ...turn, role: turn.role, content: turn.content ?? "" });
  }
  const stableText = stable.map((block) => block.text).join("\n");
  const volatileText = [
    input.summary.trim() ? `Earlier conversation summary:\n${input.summary.trim()}` : "",
    ...input.recent.map((turn) => turn.content ?? ""),
  ].filter(Boolean).join("\n");
  return {
    messages,
    cache,
    estimatedStableTokens: estimateTokens(stableText),
    estimatedVolatileTokens: estimateTokens(volatileText),
  };
}

export function replayCacheTokens(input: {
  system: string;
  toolIndex: string;
  pinned: string;
  summary: string;
  recent: ContextTurn[];
  model: string;
}): { beforeEstimated: number; stableEstimated: number; volatileEstimated: number } {
  const laid = layoutCachedPrompt(input);
  const beforeEstimated = estimateTokens([
    input.system,
    input.toolIndex,
    input.pinned,
    input.summary,
    ...input.recent.map((turn) => turn.content),
  ].join("\n"));
  return {
    beforeEstimated,
    stableEstimated: laid.estimatedStableTokens,
    volatileEstimated: laid.estimatedVolatileTokens,
  };
}
