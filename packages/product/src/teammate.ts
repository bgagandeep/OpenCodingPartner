import { randomUUID, createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { securityGate } from "@opencodingpartner/workers";
import { appendChannelLog, findBot, productDataDir } from "./index.js";

export const RESPONSIBILITY_CAP = 20;

export interface AuditRow {
  id: string;
  at: string;
  outcome: "permitted" | "refused" | "failed";
  action: string;
  ruleId?: string;
  detail: string;
}

export interface Responsibility {
  id: string;
  botId: string;
  goal: string;
  status: "open" | "done";
  progress: string;
  createdAt: string;
}

export interface ThreadMessage {
  id: string;
  botId?: string;
  role: "person" | "bot" | "system";
  text: string;
  at: string;
}

export interface TeamThread {
  id: string;
  title: string;
  botIds: string[];
  messages: ThreadMessage[];
  createdAt: string;
}

export interface DenyRule {
  id: string;
  tool: string;
  pathPrefix?: string;
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;

function file(root: string, name: string): string {
  return path.join(root, name);
}

async function readJson<T>(target: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
}

export function redactAuditText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 300);
}

export async function recordAudit(root: string, row: Omit<AuditRow, "id" | "at">): Promise<AuditRow> {
  const saved: AuditRow = {
    id: randomUUID(),
    at: new Date().toISOString(),
    outcome: row.outcome,
    action: redactAuditText(row.action),
    ruleId: row.ruleId,
    detail: redactAuditText(row.detail),
  };
  const rows = await readJson<AuditRow[]>(file(root, "audit.json"), []);
  rows.push(saved);
  await writeJson(file(root, "audit.json"), rows.slice(-200));
  return saved;
}

export async function listAudit(root: string): Promise<AuditRow[]> {
  return readJson<AuditRow[]>(file(root, "audit.json"), []);
}

export async function listResponsibilities(root: string): Promise<Responsibility[]> {
  return readJson<Responsibility[]>(file(root, "responsibilities.json"), []);
}

export async function createResponsibility(root: string, botId: string, goal: string): Promise<Responsibility> {
  const text = goal.trim();
  if (!text || text.length > 500) throw new Error("A responsibility needs a goal of 1 to 500 characters.");
  const bot = await findBot(botId, root);
  if (!bot) throw new Error("Unknown bot.");
  const rows = await listResponsibilities(root);
  if (rows.filter((item) => item.status === "open").length >= RESPONSIBILITY_CAP) {
    throw new Error(`Responsibility cap is ${RESPONSIBILITY_CAP}.`);
  }
  const saved: Responsibility = {
    id: randomUUID(),
    botId,
    goal: text,
    status: "open",
    progress: "",
    createdAt: new Date().toISOString(),
  };
  rows.push(saved);
  await writeJson(file(root, "responsibilities.json"), rows);
  return saved;
}

export async function updateResponsibility(root: string, id: string, patch: { status?: "open" | "done"; progress?: string }): Promise<Responsibility> {
  const rows = await listResponsibilities(root);
  const row = rows.find((item) => item.id === id);
  if (!row) throw new Error("Unknown responsibility.");
  if (patch.status) row.status = patch.status;
  if (typeof patch.progress === "string") row.progress = patch.progress.trim().slice(0, 500);
  await writeJson(file(root, "responsibilities.json"), rows);
  return row;
}

export async function listThreads(root: string): Promise<TeamThread[]> {
  return readJson<TeamThread[]>(file(root, "threads.json"), []);
}

export async function createThread(root: string, botIds: string[], text: string): Promise<TeamThread> {
  const ids = [...new Set(botIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length < 2) throw new Error("A thread needs two bots.");
  for (const id of ids) {
    if (!(await findBot(id, root))) throw new Error("Unknown bot.");
  }
  const prompt = text.trim();
  if (!prompt) throw new Error("A thread needs a message.");
  const now = new Date().toISOString();
  const messages: ThreadMessage[] = [{ id: randomUUID(), role: "person", text: prompt.slice(0, 4_000), at: now }];
  for (const id of ids) {
    const bot = await findBot(id, root);
    messages.push({
      id: randomUUID(),
      botId: id,
      role: "bot",
      text: `No model is configured. ${bot?.name ?? "Bot"} is in this thread and will not invent an action.`,
      at: now,
    });
  }
  const thread: TeamThread = { id: randomUUID(), title: prompt.slice(0, 80), botIds: ids, messages, createdAt: now };
  const rows = await listThreads(root);
  rows.push(thread);
  await writeJson(file(root, "threads.json"), rows.slice(-100));
  return thread;
}

export async function reachThread(root: string, threadId: string, channel: "slack" | "telegram", destination: string): Promise<TeamThread> {
  const rows = await listThreads(root);
  const thread = rows.find((item) => item.id === threadId);
  if (!thread) throw new Error("Unknown thread.");
  const dest = destination.trim();
  if (!dest || dest.length > 200) throw new Error("Reach needs a destination.");
  const person = [...thread.messages].reverse().find((item) => item.role === "person");
  const draft = await appendChannelLog({
    channel,
    direction: "out",
    text: person?.text ?? thread.title,
    botId: thread.botIds[0],
    destination: dest,
    status: "draft",
  }, root);
  thread.messages.push({
    id: randomUUID(),
    role: "system",
    text: `Reach draft for ${channel}. Nothing was sent. ${draft.id}`,
    at: new Date().toISOString(),
  });
  await writeJson(file(root, "threads.json"), rows);
  return thread;
}

async function memoryPath(workspace: string, root: string): Promise<string> {
  const resolved = await realpath(path.resolve(workspace)).catch(() => path.resolve(workspace));
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return path.join(root, "memories", hash, "MEMORY.md");
}

export async function listMemory(workspace: string, root = productDataDir()): Promise<string[]> {
  const raw = await readFile(await memoryPath(workspace, root), "utf8").catch(() => "");
  return raw.split(/\r?\n/).filter((line) => line.trim().startsWith("- "));
}

export async function correctMemory(workspace: string, query: string, replacement: string, root = productDataDir()): Promise<string[]> {
  const needle = query.trim().toLowerCase();
  const next = replacement.replace(/[\r\n]+/g, " ").trim();
  if (!needle || !next || next.length > 2_000) throw new Error("Memory needs a query and a replacement of 1 to 2,000 characters.");
  const gate = securityGate({ relativePath: "MEMORY.md", content: next, sandboxRoot: workspace });
  if (!gate.allow) throw new Error(`blocked (${gate.reasons.join(", ")})`);
  const target = await memoryPath(workspace, root);
  const lines = (await readFile(target, "utf8").catch(() => "# Workspace Memory\n")).split(/\r?\n/);
  let changed = false;
  const updated = lines.map((line) => {
    if (!changed && line.trim().startsWith("- ") && line.toLowerCase().includes(needle)) {
      changed = true;
      return `- [${new Date().toISOString().slice(0, 10)}] ${next}`;
    }
    return line;
  });
  if (!changed) throw new Error("No matching memory.");
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${updated.join("\n").replace(/\n*$/, "\n")}`, { encoding: "utf8", mode: 0o600 });
  return listMemory(workspace, root);
}

export async function forgetMemory(workspace: string, query: string, root = productDataDir()): Promise<number> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("query is required");
  const target = await memoryPath(workspace, root);
  const existing = await readFile(target, "utf8").catch(() => "");
  let removed = 0;
  const kept = existing.split(/\r?\n/).filter((line) => {
    if (line.trim().startsWith("- ") && line.toLowerCase().includes(needle)) {
      removed += 1;
      return false;
    }
    return true;
  });
  if (existing) await writeFile(target, `${kept.join("\n").replace(/\n*$/, "\n")}`, { encoding: "utf8", mode: 0o600 });
  return removed;
}

function validRule(value: unknown): value is DenyRule {
  if (!value || typeof value !== "object") return false;
  const row = value as DenyRule;
  if (typeof row.id !== "string" || !row.id) return false;
  if (typeof row.tool !== "string" || !TOOL_NAME.test(row.tool)) return false;
  if (row.pathPrefix !== undefined) {
    if (typeof row.pathPrefix !== "string" || !row.pathPrefix || row.pathPrefix.includes("..") || row.pathPrefix.startsWith("/")) return false;
  }
  return true;
}

export async function listDenyRules(root: string): Promise<{ rules: DenyRule[]; broken: boolean }> {
  const raw = await readJson<unknown>(file(root, "deny-rules.json"), []);
  if (!Array.isArray(raw)) return { rules: [], broken: true };
  if (raw.some((item) => !validRule(item))) return { rules: [], broken: true };
  return { rules: raw, broken: false };
}

export async function saveDenyRule(root: string, tool: string, pathPrefix?: string): Promise<DenyRule> {
  const current = await listDenyRules(root);
  if (current.broken) throw new Error("Deny rules are broken. Refusing to add one.");
  const rule: DenyRule = { id: randomUUID(), tool: tool.trim(), ...(pathPrefix?.trim() ? { pathPrefix: pathPrefix.trim() } : {}) };
  if (!validRule(rule)) throw new Error("A deny rule needs a tool name and an optional relative path prefix.");
  await writeJson(file(root, "deny-rules.json"), [...current.rules, rule]);
  return rule;
}

export async function gateTool(root: string, tool: string, relativePath: string): Promise<{ ok: true } | { ok: false; ruleId: string; detail: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file(root, "deny-rules.json"), "utf8"));
  } catch (error) {
    const missing = error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
    if (missing) return { ok: true };
    return { ok: false, ruleId: "broken", detail: "Refused by rule broken." };
  }
  if (!Array.isArray(raw) || raw.some((item) => !validRule(item))) return { ok: false, ruleId: "broken", detail: "Refused by rule broken." };
  const rules = raw as DenyRule[];
  const match = rules.find((rule) => rule.tool === tool && (!rule.pathPrefix || relativePath.replaceAll("\\", "/").startsWith(rule.pathPrefix)));
  if (!match) return { ok: true };
  return { ok: false, ruleId: match.id, detail: `Refused by rule ${match.id}.` };
}
