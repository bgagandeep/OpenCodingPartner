import { estimateTokens } from "./context.js";
import { costForUsage, type ModelPrice, type UsageCall, type UsageScopeCap } from "./usage.js";

/** A prompt at least this many estimated input tokens is a big task. The count is ceil(chars/4). */
export const BIG_TASK_ESTIMATED_TOKENS = 400;

export interface SpendProjection {
  estimatedInputTokens: number;
  estimated: true;
  costUsd?: number;
  costBasis?: UsageCall["costBasis"];
  label: string;
}

export function projectSpend(input: {
  promptText: string;
  model: string;
  provider: UsageCall["provider"];
  prices: ModelPrice[];
}): SpendProjection {
  const estimatedInputTokens = estimateTokens(input.promptText);
  const priced = costForUsage(input.provider, input.model, estimatedInputTokens, 0, input.prices);
  const cost = priced.costBasis === "entered"
    ? `$${money(priced.costUsd ?? 0)} from entered prices on estimated tokens`
    : priced.costBasis === "local-default"
      ? "$0 local default"
      : "no price entered";
  return {
    estimatedInputTokens,
    estimated: true,
    ...priced,
    label: `estimated ${estimatedInputTokens} input tokens · ${cost}. Output tokens are not included.`,
  };
}

export interface BudgetScope {
  name: string;
  cap?: UsageScopeCap;
  spentTokens: number;
  spentEstimatedTokens: number;
  spentCostUsd: number;
  spentCostKnown: boolean;
}

export function spentTotals(calls: Array<Pick<UsageCall, "promptTokens" | "completionTokens" | "estimated" | "costUsd">>): Omit<BudgetScope, "name" | "cap"> {
  let spentTokens = 0;
  let spentEstimatedTokens = 0;
  let spentCostUsd = 0;
  let spentCostKnown = false;
  for (const call of calls) {
    const count = call.promptTokens + call.completionTokens;
    spentTokens += count;
    if (call.estimated) spentEstimatedTokens += count;
    if (call.costUsd !== undefined) {
      spentCostUsd += call.costUsd;
      spentCostKnown = true;
    }
  }
  return { spentTokens, spentEstimatedTokens, spentCostUsd: moneyNumber(spentCostUsd), spentCostKnown };
}

/** Hard wins over soft. A $0 cost does not trip a $0 cost cap. Unpriced calls do not invent a cost. */
export function budgetDecision(input: {
  projection: SpendProjection;
  includeProjection: boolean;
  scopes: BudgetScope[];
}): { stop: "ok" | "soft" | "hard"; reason?: string } {
  const hard: string[] = [];
  const soft: string[] = [];
  for (const scope of input.scopes) {
    const cap = scope.cap;
    if (!cap) continue;
    const projectedTokens = input.includeProjection ? input.projection.estimatedInputTokens : 0;
    const tokens = scope.spentTokens + projectedTokens;
    const estimatedTokens = scope.spentEstimatedTokens + projectedTokens;
    let cost = scope.spentCostKnown ? scope.spentCostUsd : 0;
    let known = scope.spentCostKnown;
    if (input.includeProjection && input.projection.costUsd !== undefined) {
      cost = moneyNumber(cost + input.projection.costUsd);
      known = true;
    }
    const estimatedCost = input.includeProjection && input.projection.costBasis === "entered";
    pushCap(hard, scope.name, "hard", cap.hardMaxTokens, cap.hardMaxCostUsd, tokens, estimatedTokens, cost, known, estimatedCost);
    pushCap(soft, scope.name, "soft", cap.softMaxTokens, cap.softMaxCostUsd, tokens, estimatedTokens, cost, known, estimatedCost);
  }
  if (hard.length > 0) {
    return { stop: "hard", reason: finishReason("hard", hard, input.includeProjection ? input.projection : undefined) };
  }
  if (soft.length > 0) {
    return { stop: "soft", reason: finishReason("soft", soft, input.includeProjection ? input.projection : undefined) };
  }
  return { stop: "ok" };
}

const REPLAY_PART = [
  "Edit packages/product/src/server.ts.",
  "Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match.",
  "Decision: keep the draft reply in the app.",
].join("\n");

export function budgetReplayPrompt(): string {
  return Array.from({ length: 12 }, () => REPLAY_PART).join("\n");
}

/** Fixed budget transcript. Before is the projected input. After is 0 because the hard cap pauses before the provider call. */
export function budgetReplayTokens(): { beforeEstimated: number; afterEstimated: number } {
  const prompt = budgetReplayPrompt();
  const projection = projectSpend({ promptText: prompt, model: "stub-model", provider: "local", prices: [] });
  const decision = budgetDecision({
    projection,
    includeProjection: true,
    scopes: [{
      name: "This bot",
      cap: { hardMaxTokens: 1 },
      spentTokens: 0,
      spentEstimatedTokens: 0,
      spentCostUsd: 0,
      spentCostKnown: false,
    }],
  });
  return {
    beforeEstimated: projection.estimatedInputTokens,
    afterEstimated: decision.stop === "hard" ? 0 : projection.estimatedInputTokens,
  };
}

function pushCap(
  lines: string[],
  name: string,
  which: "soft" | "hard",
  maxTokens: number | undefined,
  maxCostUsd: number | undefined,
  tokens: number,
  estimatedTokens: number,
  cost: number,
  known: boolean,
  estimatedCost: boolean,
): void {
  if (maxTokens !== undefined && tokens >= maxTokens) {
    const estimated = estimatedTokens > 0 ? ` (${estimatedTokens} estimated)` : "";
    lines.push(`${name} is at ${tokens} tokens${estimated}; the ${which} cap is ${maxTokens}.`);
  }
  const costReached = maxCostUsd !== undefined && known && cost >= maxCostUsd && !(maxCostUsd === 0 && cost === 0);
  if (costReached) {
    const estimated = estimatedCost ? " on estimated tokens" : "";
    lines.push(`${name} has a known cost of $${money(cost)}${estimated}; the ${which} cap is $${money(maxCostUsd)}.`);
  }
}

function finishReason(stop: "soft" | "hard", lines: string[], projection?: SpendProjection): string {
  const lead = stop === "hard" ? "Hard usage cap reached." : "Soft usage cap reached.";
  const projected = projection ? ` Projected next call: ${projection.label}` : "";
  const tail = stop === "hard" ? "Leave this task paused." : "Continue this task, or leave it paused.";
  return `${lead} ${lines.join(" ")}${projected} ${tail}`;
}

function moneyNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function money(value: number): string {
  return String(moneyNumber(value));
}
