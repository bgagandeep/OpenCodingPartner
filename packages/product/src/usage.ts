import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

/** One model call. Cost is omitted until a saved price applies. Local calls default to $0. */
export interface UsageCall {
  id: string;
  botId: string;
  taskId?: string;
  model: string;
  provider: "openrouter" | "local" | "custom";
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  estimated: boolean;
  costUsd?: number;
  costBasis?: "entered" | "local-default" | "session-cache";
  step?: string;
  tier?: "cheap" | "strong";
  routeFallback?: boolean;
  createdAt: string;
}

export interface ModelPrice {
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface UsageScopeCap {
  maxTokens?: number;
  maxCostUsd?: number;
  softMaxTokens?: number;
  softMaxCostUsd?: number;
  hardMaxTokens?: number;
  hardMaxCostUsd?: number;
}

export interface UsageCaps {
  perBot: Array<{ botId: string } & UsageScopeCap>;
  perDay?: UsageScopeCap;
}

export interface UsageBucket {
  key: string;
  promptTokens: number;
  completionTokens: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  cachedPromptTokens: number;
  enteredCostUsd?: number;
  localDefaultCalls: number;
  sessionCacheCalls: number;
  unpricedCalls: number;
  calls: number;
}

export interface UsageSnapshot {
  byBot: UsageBucket[];
  byTask: UsageBucket[];
  byDay: UsageBucket[];
  today: UsageBucket;
  recent: UsageCall[];
}

const CALL_LIMIT = 2_000;
const RECENT_LIMIT = 40;

export function usageProviderKind(provider: string, baseUrl: string): UsageCall["provider"] {
  if (provider === "openrouter") return "openrouter";
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return "local";
  } catch {
    // A base URL that is not a URL is not treated as local.
  }
  return "custom";
}

export function measureUsage(usage: unknown, promptText: string, completionText: string): {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  estimated: boolean;
} {
  const record = usage && typeof usage === "object" ? usage as Record<string, unknown> : undefined;
  const prompt = record ? finiteToken(record.prompt_tokens) ?? finiteToken(record.input_tokens) : undefined;
  const completion = record ? finiteToken(record.completion_tokens) ?? finiteToken(record.output_tokens) : undefined;
  if (prompt !== undefined && completion !== undefined) {
    const details = record?.prompt_tokens_details && typeof record.prompt_tokens_details === "object"
      ? record.prompt_tokens_details as Record<string, unknown>
      : undefined;
    const cached = details ? finiteToken(details.cached_tokens) : undefined;
    const gemini = record?.usage_metadata && typeof record.usage_metadata === "object"
      ? finiteToken((record.usage_metadata as { cached_content_token_count?: unknown }).cached_content_token_count)
      : undefined;
    const cachedTop = cached
      ?? (record ? finiteToken(record.cached_tokens) ?? finiteToken(record.cache_read_input_tokens) ?? finiteToken(record.prompt_cache_hit_tokens) : undefined)
      ?? gemini;
    return {
      promptTokens: prompt,
      completionTokens: completion,
      ...(cachedTop !== undefined ? { cachedPromptTokens: cachedTop } : {}),
      estimated: false,
    };
  }
  return {
    promptTokens: Math.ceil(promptText.length / 4),
    completionTokens: Math.ceil(completionText.length / 4),
    estimated: true,
  };
}

export function costForUsage(
  provider: UsageCall["provider"],
  model: string,
  promptTokens: number,
  completionTokens: number,
  prices: ModelPrice[],
): { costUsd?: number; costBasis?: UsageCall["costBasis"] } {
  const price = prices.find((item) => item.model === model);
  if (price) {
    const costUsd = roundUsd((promptTokens * price.inputPerMillion + completionTokens * price.outputPerMillion) / 1_000_000);
    return { costUsd, costBasis: "entered" };
  }
  if (provider === "local") return { costUsd: 0, costBasis: "local-default" };
  return {};
}

export function normalizeModelPrices(value: unknown): ModelPrice[] {
  if (!Array.isArray(value)) throw new Error("Model prices must be a list.");
  if (value.length > 100) throw new Error("At most 100 model prices can be saved.");
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("A model price was not an object.");
    const item = raw as Record<string, unknown>;
    const model = typeof item.model === "string" ? item.model.trim() : "";
    if (!model || model.length > 200) throw new Error("Each model price needs a model id.");
    if (seen.has(model)) throw new Error(`Duplicate price for ${model}.`);
    seen.add(model);
    return {
      model,
      inputPerMillion: requiredNonNegative(item.inputPerMillion, `Input price for ${model}`),
      outputPerMillion: requiredNonNegative(item.outputPerMillion, `Output price for ${model}`),
    };
  });
}

export function normalizeUsageCaps(value: unknown): UsageCaps {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Usage caps must be an object.");
  const raw = value as Record<string, unknown>;
  const perDay = raw.perDay === undefined || raw.perDay === null ? undefined : normalizeScopeCap(raw.perDay, "Per-day");
  const perBotRaw = raw.perBot === undefined ? [] : raw.perBot;
  if (!Array.isArray(perBotRaw)) throw new Error("Per-bot caps must be a list.");
  if (perBotRaw.length > 100) throw new Error("At most 100 bot caps can be saved.");
  const seen = new Set<string>();
  const perBot = perBotRaw.map((item) => {
    if (!item || typeof item !== "object") throw new Error("A bot cap was not an object.");
    const record = item as Record<string, unknown>;
    const botId = typeof record.botId === "string" ? record.botId.trim() : "";
    if (!botId || botId.length > 80) throw new Error("A bot cap needs a bot id.");
    if (seen.has(botId)) throw new Error(`Duplicate cap for bot ${botId}.`);
    seen.add(botId);
    const cap = normalizeScopeCap(record, "Bot");
    return { botId, ...cap };
  });
  return { perBot, ...(perDay && scopeHasCap(perDay) ? { perDay } : {}) };
}

export async function readUsagePolicy(root: string): Promise<{ prices: ModelPrice[]; caps: UsageCaps }> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "settings.json"), "utf8")) as {
      modelPrices?: unknown;
      usageCaps?: unknown;
    };
    return {
      prices: Array.isArray(parsed.modelPrices) ? normalizeModelPrices(parsed.modelPrices) : [],
      caps: parsed.usageCaps ? normalizeUsageCaps(parsed.usageCaps) : { perBot: [] },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { prices: [], caps: { perBot: [] } };
    throw error;
  }
}

export async function noteModelUsage(root: string, input: {
  botId: string;
  taskId?: string;
  model: string;
  provider: string;
  baseUrl: string;
  usage: unknown;
  promptText: string;
  completionText: string;
  step?: string;
  tier?: "cheap" | "strong";
  routeFallback?: boolean;
  sessionCache?: boolean;
}): Promise<UsageCall> {
  if (input.sessionCache) {
    const call: UsageCall = {
      id: randomUUID(),
      botId: input.botId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      model: input.model.slice(0, 200),
      provider: usageProviderKind(input.provider, input.baseUrl),
      promptTokens: 0,
      completionTokens: 0,
      estimated: false,
      costUsd: 0,
      costBasis: "session-cache",
      ...(input.step && input.step.length <= 40 && !/[\r\n]/.test(input.step) ? { step: input.step } : {}),
      ...(input.tier === "cheap" || input.tier === "strong" ? { tier: input.tier } : {}),
      ...(input.routeFallback ? { routeFallback: true } : {}),
      createdAt: new Date().toISOString(),
    };
    await appendUsageCall(root, call);
    return call;
  }
  const measured = measureUsage(input.usage, input.promptText, input.completionText);
  const provider = usageProviderKind(input.provider, input.baseUrl);
  const { prices } = await readUsagePolicy(root);
  const priced = costForUsage(provider, input.model, measured.promptTokens, measured.completionTokens, prices);
  const call: UsageCall = {
    id: randomUUID(),
    botId: input.botId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    model: input.model.slice(0, 200),
    provider,
    promptTokens: measured.promptTokens,
    completionTokens: measured.completionTokens,
    ...(measured.cachedPromptTokens !== undefined ? { cachedPromptTokens: measured.cachedPromptTokens } : {}),
    estimated: measured.estimated,
    ...priced,
    ...(input.step && input.step.length <= 40 && !/[\r\n]/.test(input.step) ? { step: input.step } : {}),
    ...(input.tier === "cheap" || input.tier === "strong" ? { tier: input.tier } : {}),
    ...(input.routeFallback ? { routeFallback: true } : {}),
    createdAt: new Date().toISOString(),
  };
  await appendUsageCall(root, call);
  return call;
}

export async function readUsageCalls(root: string): Promise<UsageCall[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "usage.json"), "utf8")) as { calls?: unknown };
    if (!parsed || !Array.isArray(parsed.calls)) throw new Error("Usage meter file is corrupt.");
    return parsed.calls.map((item) => {
      if (!isUsageCall(item)) throw new Error("Usage meter file is corrupt.");
      return item;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function usageSnapshot(root: string, now = new Date()): Promise<UsageSnapshot> {
  const calls = await readUsageCalls(root);
  const day = now.toISOString().slice(0, 10);
  return {
    byBot: groupCalls(calls, (call) => call.botId),
    byTask: groupCalls(calls.filter((call) => call.taskId), (call) => call.taskId ?? ""),
    byDay: groupCalls(calls, (call) => call.createdAt.slice(0, 10)),
    today: bucketFor(day, calls.filter((call) => call.createdAt.slice(0, 10) === day)),
    recent: [...calls].reverse().slice(0, RECENT_LIMIT),
  };
}

export async function usageCapReason(root: string, botId: string, now = new Date()): Promise<string | undefined> {
  const [{ caps }, calls] = await Promise.all([readUsagePolicy(root), readUsageCalls(root)]);
  const day = now.toISOString().slice(0, 10);
  const botCap = caps.perBot.find((item) => item.botId === botId);
  const reasons = [
    capLine("This bot", calls.filter((call) => call.botId === botId), botCap?.maxTokens, botCap?.maxCostUsd),
    capLine("Today", calls.filter((call) => call.createdAt.slice(0, 10) === day), caps.perDay?.maxTokens, caps.perDay?.maxCostUsd),
  ].filter((line): line is string => Boolean(line));
  if (reasons.length === 0) return undefined;
  return `Usage cap reached. ${reasons.join(" ")} Continue this task, or leave it paused.`;
}

async function appendUsageCall(root: string, call: UsageCall): Promise<void> {
  await mutateUsage(root, (calls) => {
    calls.push(call);
    if (calls.length > CALL_LIMIT) calls.splice(0, calls.length - CALL_LIMIT);
  });
}

function capLine(scope: string, calls: UsageCall[], maxTokens?: number, maxCostUsd?: number): string | undefined {
  let tokens = 0;
  let estimatedTokens = 0;
  let cost = 0;
  let priced = false;
  for (const call of calls) {
    const count = call.promptTokens + call.completionTokens;
    tokens += count;
    if (call.estimated) estimatedTokens += count;
    if (call.costUsd !== undefined) {
      cost += call.costUsd;
      priced = true;
    }
  }
  const parts: string[] = [];
  if (maxTokens !== undefined && tokens >= maxTokens) {
    const estimated = estimatedTokens > 0 ? ` (${estimatedTokens} estimated)` : "";
    parts.push(`${scope} has used ${tokens} tokens${estimated}; the cap is ${maxTokens}.`);
  }
  const costReached = maxCostUsd !== undefined && priced && cost >= maxCostUsd && !(maxCostUsd === 0 && cost === 0);
  if (costReached) {
    parts.push(`${scope} has a known cost of $${formatUsd(cost)}; the cap is $${formatUsd(maxCostUsd)}.`);
  }
  return parts.length ? parts.join(" ") : undefined;
}

function groupCalls(calls: UsageCall[], keyOf: (call: UsageCall) => string): UsageBucket[] {
  const buckets = new Map<string, UsageCall[]>();
  for (const call of calls) {
    const key = keyOf(call);
    const list = buckets.get(key);
    if (list) list.push(call);
    else buckets.set(key, [call]);
  }
  return [...buckets.entries()].map(([key, group]) => bucketFor(key, group));
}

function bucketFor(key: string, calls: UsageCall[]): UsageBucket {
  const bucket: UsageBucket = {
    key,
    promptTokens: 0,
    completionTokens: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    cachedPromptTokens: 0,
    localDefaultCalls: 0,
    sessionCacheCalls: 0,
    unpricedCalls: 0,
    calls: calls.length,
  };
  for (const call of calls) {
    bucket.promptTokens += call.promptTokens;
    bucket.completionTokens += call.completionTokens;
    if (call.estimated) {
      bucket.estimatedPromptTokens += call.promptTokens;
      bucket.estimatedCompletionTokens += call.completionTokens;
    } else if (call.cachedPromptTokens) {
      bucket.cachedPromptTokens += call.cachedPromptTokens;
    }
    if (call.costBasis === "entered" && call.costUsd !== undefined) {
      bucket.enteredCostUsd = roundUsd((bucket.enteredCostUsd ?? 0) + call.costUsd);
    } else if (call.costBasis === "local-default") bucket.localDefaultCalls += 1;
    else if (call.costBasis === "session-cache") bucket.sessionCacheCalls += 1;
    else bucket.unpricedCalls += 1;
  }
  return bucket;
}

function isUsageCall(value: unknown): value is UsageCall {
  if (!value || typeof value !== "object") return false;
  const call = value as Partial<UsageCall>;
  return typeof call.id === "string"
    && typeof call.botId === "string"
    && typeof call.model === "string"
    && (call.provider === "openrouter" || call.provider === "local" || call.provider === "custom")
    && typeof call.promptTokens === "number"
    && typeof call.completionTokens === "number"
    && typeof call.estimated === "boolean"
    && typeof call.createdAt === "string"
    && (call.step === undefined || (typeof call.step === "string" && call.step.length <= 40))
    && (call.tier === undefined || call.tier === "cheap" || call.tier === "strong")
    && (call.routeFallback === undefined || typeof call.routeFallback === "boolean")
    && (call.costBasis === undefined || call.costBasis === "entered" || call.costBasis === "local-default" || call.costBasis === "session-cache");
}

function finiteToken(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function requiredNonNegative(value: unknown, label: string): number {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a number that is zero or greater.`);
  }
  return parsed;
}

function normalizeScopeCap(value: unknown, label: string): UsageScopeCap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} cap must be an object.`);
  const record = value as Record<string, unknown>;
  const maxTokens = optionalNonNegative(record.maxTokens, `${label} token cap`);
  const maxCostUsd = optionalNonNegative(record.maxCostUsd, `${label} cost cap`);
  const softMaxTokens = optionalNonNegative(record.softMaxTokens, `${label} soft token cap`);
  const softMaxCostUsd = optionalNonNegative(record.softMaxCostUsd, `${label} soft cost cap`);
  const hardMaxTokens = optionalNonNegative(record.hardMaxTokens, `${label} hard token cap`);
  const hardMaxCostUsd = optionalNonNegative(record.hardMaxCostUsd, `${label} hard cost cap`);
  return {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(softMaxTokens !== undefined ? { softMaxTokens } : {}),
    ...(softMaxCostUsd !== undefined ? { softMaxCostUsd } : {}),
    ...(hardMaxTokens !== undefined ? { hardMaxTokens } : {}),
    ...(hardMaxCostUsd !== undefined ? { hardMaxCostUsd } : {}),
  };
}

function scopeHasCap(cap: UsageScopeCap): boolean {
  return cap.maxTokens !== undefined
    || cap.maxCostUsd !== undefined
    || cap.softMaxTokens !== undefined
    || cap.softMaxCostUsd !== undefined
    || cap.hardMaxTokens !== undefined
    || cap.hardMaxCostUsd !== undefined;
}

function optionalNonNegative(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredNonNegative(value, label);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatUsd(value: number): string {
  return String(roundUsd(value));
}

async function mutateUsage(root: string, mutate: (calls: UsageCall[]) => void | Promise<void>): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, ".usage.lock");
  const started = Date.now();
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  for (;;) {
    try {
      lockHandle = await open(lock, "wx", 0o600);
      await lockHandle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await clearStaleUsageLock(lock);
      if (Date.now() - started > 10_000) throw new Error("Timed out waiting for the usage meter lock.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    const calls = await readUsageCalls(root);
    await mutate(calls);
    const temp = path.join(root, `.usage-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify({ calls }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path.join(root, "usage.json"));
  } finally {
    await lockHandle?.close();
    await rm(lock, { force: true });
  }
}

async function clearStaleUsageLock(lockPath: string): Promise<void> {
  try {
    const [contents, info] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    const pid = Number(contents.trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        if (Date.now() - info.mtimeMs < 15_000) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      }
    } else if (Date.now() - info.mtimeMs < 15_000) {
      return;
    }
    await rm(lockPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
