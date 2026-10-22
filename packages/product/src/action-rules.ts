import { findBot } from "./index.js";

export type ActionRule = "act" | "act-if-preapproved" | "ask" | "handoff";
export type ActionMode = "draft" | "perform" | "ask" | "handoff";

export interface ActionRules {
  defaultRule: ActionRule;
  byAction: Record<string, ActionRule>;
  preapproved: string[];
}

const RULES = new Set<string>(["act", "act-if-preapproved", "ask", "handoff"]);
const OUTBOUND = new Set(["gmail_draft", "outlook_draft", "slack_reply", "telegram_reply"]);
const ACTION_NAME = /^[a-z0-9_.:-]{1,80}$/i;

export function isActionRule(value: string): value is ActionRule {
  return RULES.has(value);
}

function cleanNames(values: unknown[]): { names?: string[]; error?: string } {
  const names: string[] = [];
  for (const value of values) {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name) continue;
    if (!ACTION_NAME.test(name)) return { error: "Pre-approved action names must be 1 to 80 letters, numbers, or . _ : -." };
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > 20) return { error: "At most 20 pre-approved actions." };
  return { names };
}

export function parseActionRules(
  body: Record<string, unknown>,
  existing?: ActionRules,
): { rules?: ActionRules; error?: string; touched: boolean } {
  const touched = Object.hasOwn(body, "actionRule") || Object.hasOwn(body, "actionRules") || Object.hasOwn(body, "preapproved") || Object.hasOwn(body, "actionBy");
  if (!touched) return { rules: existing, touched: false };
  let defaultRule: ActionRule = existing?.defaultRule ?? "ask";
  let byAction: Record<string, ActionRule> = { ...(existing?.byAction ?? {}) };
  let preapproved = [...(existing?.preapproved ?? [])];

  const rawRule = typeof body.actionRule === "string" ? body.actionRule.trim() : "";
  if (rawRule) {
    if (!isActionRule(rawRule)) return { error: "Action rule must be act, act-if-preapproved, ask, or handoff.", touched: true };
    defaultRule = rawRule;
  }

  if (body.actionRules && typeof body.actionRules === "object" && !Array.isArray(body.actionRules)) {
    const raw = body.actionRules as Record<string, unknown>;
    if (typeof raw.defaultRule === "string" && raw.defaultRule.trim()) {
      if (!isActionRule(raw.defaultRule)) return { error: "Action rule must be act, act-if-preapproved, ask, or handoff.", touched: true };
      defaultRule = raw.defaultRule;
    }
    if (raw.byAction && typeof raw.byAction === "object" && !Array.isArray(raw.byAction)) {
      const entries = Object.entries(raw.byAction as Record<string, unknown>);
      if (entries.length > 20) return { error: "At most 20 per-action rules.", touched: true };
      const next: Record<string, ActionRule> = {};
      for (const [key, value] of entries) {
        if (!ACTION_NAME.test(key) || typeof value !== "string" || !isActionRule(value)) {
          return { error: "Each per-action rule needs a short action name and act, act-if-preapproved, ask, or handoff.", touched: true };
        }
        next[key] = value;
      }
      byAction = next;
    }
    if (Array.isArray(raw.preapproved)) {
      const cleaned = cleanNames(raw.preapproved);
      if (cleaned.error || !cleaned.names) return { error: cleaned.error, touched: true };
      preapproved = cleaned.names;
    }
  }

  if (Object.hasOwn(body, "preapproved")) {
    const source = typeof body.preapproved === "string"
      ? body.preapproved.split(",")
      : Array.isArray(body.preapproved)
        ? body.preapproved
        : null;
    if (!source) return { error: "Pre-approved actions must be a comma-separated list.", touched: true };
    const cleaned = cleanNames(source);
    if (cleaned.error || !cleaned.names) return { error: cleaned.error, touched: true };
    preapproved = cleaned.names;
  }

  if (typeof body.actionBy === "string") {
    const lines = body.actionBy.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length > 20) return { error: "At most 20 per-action rules.", touched: true };
    const next: Record<string, ActionRule> = {};
    for (const line of lines) {
      const match = /^([a-z0-9_.:-]{1,80})\s*[:=]\s*(act|act-if-preapproved|ask|handoff)$/i.exec(line);
      const rule = match?.[2]?.toLowerCase() ?? "";
      if (!match?.[1] || !isActionRule(rule)) return { error: "Each action rule line must look like calendar_create=act.", touched: true };
      next[match[1]] = rule;
    }
    byAction = next;
  }

  return { rules: { defaultRule, byAction, preapproved }, touched: true };
}

export async function resolveAction(root: string | undefined, botId: string | undefined, action: string): Promise<ActionMode> {
  if (OUTBOUND.has(action)) return "draft";
  if (!root || !botId) return "ask";
  const bot = await findBot(botId, root);
  const rules = bot?.actionRules;
  const rule = rules?.byAction?.[action] ?? rules?.defaultRule ?? "ask";
  if (rule === "act") return "perform";
  if (rule === "handoff") return "handoff";
  if (rule === "act-if-preapproved") return rules?.preapproved.includes(action) ? "perform" : "ask";
  return "ask";
}
