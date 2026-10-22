import { estimateTokens } from "./context.js";

export type RouteStep = "route" | "summary" | "classify" | "lint-fix" | "plan" | "edit" | "answer";
export type RouteMode = "auto" | "cheap" | "strong";
export type RouteTier = "cheap" | "strong";

const CHEAP_STEPS = new Set<RouteStep>(["route", "summary", "classify", "lint-fix", "answer"]);
const EDIT_TOOLS = new Set([
  "workspace_write",
  "workspace_patch",
  "workspace_append",
  "workspace_delete",
  "workspace_rename",
  "workspace_copy",
  "plan_submit",
]);

export function selectStepModel(input: {
  step: RouteStep;
  mode: RouteMode;
  strongModel: string;
  cheapModel?: string;
  local?: boolean;
}): { model: string; tier: RouteTier; step: RouteStep; fallback: boolean } {
  const cheapModel = input.cheapModel?.trim() || undefined;
  const wantsCheap = input.mode === "cheap" || (input.mode === "auto" && CHEAP_STEPS.has(input.step));
  if (input.mode === "strong" || !wantsCheap) {
    return { model: input.strongModel, tier: "strong", step: input.step, fallback: false };
  }
  if (cheapModel) return { model: cheapModel, tier: "cheap", step: input.step, fallback: false };
  if (input.local) return { model: input.strongModel, tier: "cheap", step: input.step, fallback: false };
  return { model: input.strongModel, tier: "strong", step: input.step, fallback: true };
}

export function classifyPrompt(userText: string): string {
  return [
    "Classify this user turn for OCP.",
    "Reply with one label: plan, edit, lint-fix, or answer.",
    "plan: design the change before editing.",
    "edit: change code.",
    "lint-fix: a test or lint failure needs a small fix.",
    "answer: a question that does not change files.",
    userText.trim(),
  ].join("\n");
}

export function parseRouteLabel(text: string): RouteStep | undefined {
  const match = text.toLowerCase().match(/\b(plan|edit|lint-fix|answer)\b/);
  if (match?.[1] === "plan" || match?.[1] === "edit" || match?.[1] === "lint-fix" || match?.[1] === "answer") return match[1];
  return undefined;
}

export function nextRouteStep(current: RouteStep, toolNames: string[], toolTexts: string[]): RouteStep {
  if (toolNames.some((name) => EDIT_TOOLS.has(name))) return "edit";
  const failed = toolNames.some((name, index) => (
    name === "workspace_test" || name === "workspace_shell"
  ) && /\b(not ok|failed|error)\b/i.test(toolTexts[index] ?? ""));
  if (failed) return "lint-fix";
  return current;
}

export function formatRouteUsage(input: {
  step: string;
  tier: RouteTier;
  fallback: boolean;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
  costUsd?: number;
  costBasis?: "entered" | "local-default" | "session-cache";
}): string {
  const tokens = input.estimated
    ? `estimated ${input.promptTokens} in / ${input.completionTokens} out`
    : `${input.promptTokens} in / ${input.completionTokens} out`;
  const tier = input.fallback ? `${input.tier}, no cheap model configured` : input.tier;
  const cost = input.costBasis === "session-cache"
    ? "session cache, no provider call"
    : input.costBasis === "entered"
    ? `$${money(input.costUsd ?? 0)} from entered prices${input.estimated ? " on estimated tokens" : ""}`
    : input.costBasis === "local-default"
      ? "$0 local default"
      : "no price entered";
  return `${input.step} · ${tier} · ${input.model}: ${tokens} · ${cost}`;
}

const REPLAY_USER = "Fix the hunk mismatch in packages/product/src/server.ts.";

export function routingReplayTokens(): { beforeEstimated: number; strongEstimated: number; cheapEstimated: number } {
  const steps: Array<{ tier: "cheap" | "strong"; text: string }> = [
    { tier: "cheap", text: classifyPrompt(REPLAY_USER) },
    {
      tier: "cheap",
      text: "Summarize earlier coding turns.\n\nuser: Edit packages/product/src/server.ts\ntool: Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match.",
    },
    {
      tier: "cheap",
      text: "not ok 1 - draft reply\nError: workspace_patch failed in packages/product/src/server.ts: hunk did not match.",
    },
    { tier: "strong", text: "Plan the draft reply change in packages/product/src/server.ts before editing." },
    { tier: "strong", text: "Apply the approved patch to packages/product/src/server.ts." },
  ];
  const estimated = steps.map((step) => ({ tier: step.tier, tokens: estimateTokens(step.text) }));
  const strongEstimated = estimated.filter((step) => step.tier === "strong").reduce((sum, step) => sum + step.tokens, 0);
  const cheapEstimated = estimated.filter((step) => step.tier === "cheap").reduce((sum, step) => sum + step.tokens, 0);
  return { beforeEstimated: strongEstimated + cheapEstimated, strongEstimated, cheapEstimated };
}

function money(value: number): string {
  return String(Math.round(value * 1_000_000) / 1_000_000);
}
