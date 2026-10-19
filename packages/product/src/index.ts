import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceChangeReview } from "./workspace.js";

export { captureWorkspaceBaseline, collectWorkspaceChanges, type WorkspaceBaseline, type WorkspaceChangeEntry, type WorkspaceChangeReview } from "./workspace.js";

export type BotRole = "general" | "coding" | "qa" | "security" | "research" | "computer";
export type BotRuntime = "ocp-agent" | "ocp-coder" | "hermes" | "grok-build";
export type BotProvider = "openrouter" | "litellm";
export type BotIsolation = "docker" | "host";
export type BotNetworkMode = "disabled" | "enabled";
export type TaskStatus = "queued" | "running" | "awaiting-approval" | "succeeded" | "failed" | "needs-attention" | "cancelled";

export interface BotDefinition {
  id: string;
  name: string;
  role: BotRole;
  runtime: BotRuntime;
  isolation?: BotIsolation;
  network?: BotNetworkMode;
  workspace: string;
  instructions: string;
  provider?: BotProvider;
  endpoint?: string;
  apiKeyEnv?: string;
  model?: string;
  runtimeSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductTask {
  id: string;
  botId: string;
  reviewerBotId?: string;
  agents?: TaskAgentSnapshot[];
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  processId?: number;
  processIdentity?: string;
  approvals?: TaskApproval[];
  events?: ProductTaskEvent[];
  pendingApproval?: PendingTaskApproval;
  runtimeSessionId?: string;
  result?: string;
  error?: string;
  workspaceChanges?: WorkspaceChangeReview;
}

export interface TaskAgentSnapshot {
  botId: string;
  name: string;
  role: BotRole;
  runtime: BotRuntime;
  isolation?: BotIsolation;
  provider?: BotProvider;
  model?: string;
  endpoint?: string;
  network?: BotNetworkMode;
}

export interface ProductTaskEvent {
  id: string;
  kind: string;
  createdAt: string;
  title?: string;
  text?: string;
}

export interface PendingTaskApproval {
  id: string;
  title: string;
  description?: string;
  subject?: unknown;
  allowOnceOptionId: string;
  requestedAt: string;
}

export interface TaskApproval {
  title: string;
  description?: string;
  decision: "allow-once" | "cancelled";
  createdAt: string;
}

export interface ProductProject {
  id: string;
  name: string;
  workspace: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

interface ProductState {
  schemaVersion: 1;
  projects?: ProductProject[];
  bots: BotDefinition[];
  tasks: ProductTask[];
}

const EMPTY_STATE: ProductState = { schemaVersion: 1, projects: [], bots: [], tasks: [] };

export function productDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OCP_DATA_DIR) return path.resolve(env.OCP_DATA_DIR);
  const legacyDirectory = path.join(homedir(), ".local", "share", "opencodingpartner");
  if (process.platform === "win32") {
    const preferred = path.resolve(env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "OpenCodingPartner");
    return existsSync(legacyDirectory) ? legacyDirectory : preferred;
  }
  if (process.platform === "darwin") {
    const preferred = path.join(homedir(), "Library", "Application Support", "OpenCodingPartner");
    return existsSync(legacyDirectory) ? legacyDirectory : preferred;
  }
  const xdgDataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : path.join(homedir(), ".local", "share");
  return path.join(xdgDataHome, "opencodingpartner");
}

export function validBotRole(value: string): value is BotRole {
  return ["general", "coding", "qa", "security", "research", "computer"].includes(value);
}

export function validBotRuntime(value: string): value is BotRuntime {
  return value === "ocp-agent" || value === "ocp-coder" || value === "hermes" || value === "grok-build";
}

export function isOcpAgentRuntime(value: string): boolean {
  return value === "ocp-agent" || value === "hermes";
}

export function botRuntimeLabel(value: string): string {
  return isOcpAgentRuntime(value) ? "OCP Agent" : "OCP Coder";
}

export function validBotNetworkMode(value: string): value is BotNetworkMode {
  return value === "disabled" || value === "enabled";
}

export interface ProviderSettings {
  openrouterApiKey?: string;
  litellmApiKey?: string;
  litellmBaseUrl?: string;
  openaiApiKey?: string;
  defaultModel?: string;
  updatedAt?: string;
}

export async function readProviderSettings(root = productDataDir()): Promise<ProviderSettings> {
  try {
    const raw = await readFile(path.join(root, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as ProviderSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveProviderSettings(
  input: Partial<ProviderSettings>,
  root = productDataDir(),
): Promise<ProviderSettings> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  const current = await readProviderSettings(root);
  const next: ProviderSettings = { ...current, updatedAt: new Date().toISOString() };
  const assign = (key: keyof Omit<ProviderSettings, "updatedAt">) => {
    if (!Object.prototype.hasOwnProperty.call(input, key)) return;
    const val = typeof input[key] === "string" ? input[key]!.trim() : "";
    if (val) next[key] = val;
    else delete next[key];
  };
  assign("openrouterApiKey");
  assign("litellmApiKey");
  assign("litellmBaseUrl");
  assign("openaiApiKey");
  assign("defaultModel");
  const target = path.join(root, "settings.json");
  await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
  return next;
}

export function applyProviderSettingsToEnv(
  settings: ProviderSettings,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...baseEnv };
  if (settings.openrouterApiKey && !merged.OPENROUTER_API_KEY) {
    merged.OPENROUTER_API_KEY = settings.openrouterApiKey;
  }
  if (settings.litellmApiKey && !merged.LITELLM_API_KEY) {
    merged.LITELLM_API_KEY = settings.litellmApiKey;
  }
  if (settings.litellmBaseUrl && !merged.LITELLM_BASE_URL) {
    merged.LITELLM_BASE_URL = settings.litellmBaseUrl;
  }
  if (settings.openaiApiKey && !merged.OPENAI_API_KEY) {
    merged.OPENAI_API_KEY = settings.openaiApiKey;
  }
  if (settings.defaultModel && !merged.OCP_DEFAULT_MODEL) {
    merged.OCP_DEFAULT_MODEL = settings.defaultModel;
  }
  return merged;
}

/** Operating instructions for the Lead Orchestrator bot that can create, configure, and coordinate other bots. */
export function leadBotInstructions(): string {
  return [
    "You are Ada, the Lead Orchestrator and Bot Manager for this workspace.",
    "You can create new specialist bots (`bot_create` or `swarm_setup`), inspect and manage all bots (`bot_list`, `bot_update`, `bot_delete`), and delegate coding, QA, security, research, or computer-use work to other bots (`bot_delegate`).",
    "When the user asks to build a team, create a bot, manage bots, or coordinate multi-agent work, use the bot management tools directly and report the updated roster and results clearly.",
    defaultBotInstructions("general"),
  ].join("\n\n");
}

/** Default operating guidance for a role when the user leaves instructions blank. */
export function defaultBotInstructions(role: BotRole): string {
  const shared = "Work only in the assigned workspace. Inspect the relevant context before acting, make your work easy to review, and report what you changed, what you verified, and anything still uncertain. Never claim an action or check you did not perform.";
  const focus: Record<BotRole, string> = {
    general: "You are a practical AI teammate. Help with the user's request, clarify assumptions in your final report, and keep changes focused.",
    coding: "You are OCP Coder, a coding teammate. First inspect the project conventions and relevant files, then make the smallest complete change that satisfies the request. Preserve unrelated user work and summarize changed files and verification.",
    qa: "You are a QA agent. Review the requested behavior and identify concrete failures, regressions, and missing coverage. Reproduce findings when practical; prioritize actionable issues with severity and file or line references. Do not make product changes unless asked.",
    security: "You are a security review agent. Look for exploitable weaknesses in the requested scope, trace their impact, and report actionable findings with evidence and severity. Distinguish confirmed vulnerabilities from risks that need validation. Do not expose secrets in your report.",
    research: "You are a research agent. Gather evidence relevant to the request, separate source-backed facts from inference, and provide concise findings with links or precise source locations when available. Do not modify project files unless asked.",
    computer: "You are a computer-use agent. Follow the user's requested interaction carefully, inspect the result after each consequential step, and stop before irreversible actions unless the user clearly requested them. Report what you observed.",
  };
  return `${focus[role]}\n\n${shared}`;
}

export function validBotProvider(value: string): value is BotProvider {
  return value === "openrouter" || value === "litellm";
}

/** Return the required key variable when an explicitly routed bot cannot authenticate. */
export function missingProviderKey(bot: BotDefinition, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!bot.provider) return undefined;
  const keyEnv = bot.provider === "openrouter" ? "OPENROUTER_API_KEY" : bot.apiKeyEnv || "LITELLM_API_KEY";
  if (env[keyEnv]) return undefined;
  if (bot.provider === "litellm" && keyEnv === "LITELLM_API_KEY" && env.LITELLM_MASTER_KEY) return undefined;
  return keyEnv;
}

export async function listProjects(root = productDataDir()): Promise<ProductProject[]> {
  const state = await readState(root);
  const byWorkspace = new Map<string, ProductProject>();
  for (const project of state.projects ?? []) {
    byWorkspace.set(project.workspace, project);
  }
  for (const bot of state.bots) {
    if (!byWorkspace.has(bot.workspace)) {
      byWorkspace.set(bot.workspace, {
        id: `proj-${Buffer.from(bot.workspace).toString("base64url").slice(0, 16)}`,
        name: path.basename(bot.workspace) || bot.workspace,
        workspace: bot.workspace,
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt,
      });
    }
  }
  return [...byWorkspace.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function createProject(
  input: { name?: string; workspace: string; description?: string; ensureDirectory?: boolean },
  root = productDataDir(),
): Promise<ProductProject> {
  const targetPath = path.resolve(input.workspace.trim());
  if (input.ensureDirectory) {
    await mkdir(targetPath, { recursive: true });
  }
  const resolvedWorkspace = await canonicalWorkspacePath(targetPath);
  const now = new Date().toISOString();
  const projectName = (input.name?.trim() || path.basename(resolvedWorkspace) || "Project").slice(0, 100);
  let result: ProductProject | undefined;
  await mutateState(root, (state) => {
    if (!state.projects) state.projects = [];
    const existing = state.projects.find((p) => p.workspace === resolvedWorkspace);
    if (existing) {
      if (input.name?.trim()) existing.name = projectName;
      if (input.description !== undefined) existing.description = input.description.trim() || undefined;
      existing.updatedAt = now;
      result = existing;
      return;
    }
    const created: ProductProject = {
      id: randomUUID(),
      name: projectName,
      workspace: resolvedWorkspace,
      description: input.description?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    state.projects.push(created);
    result = created;
  });
  return result!;
}

export async function deleteProject(
  idOrWorkspace: string,
  options: { deleteBots?: boolean } = {},
  root = productDataDir(),
): Promise<void> {
  const resolvedCandidate = await canonicalWorkspacePath(idOrWorkspace).catch(() => idOrWorkspace);
  await mutateState(root, (state) => {
    recoverAbandonedTaskRecords(state);
    if (!state.projects) state.projects = [];
    const project = state.projects.find((p) => p.id === idOrWorkspace || p.workspace === resolvedCandidate);
    const targetWorkspace = project?.workspace ?? resolvedCandidate;
    const projectBots = state.bots.filter((b) => b.workspace === targetWorkspace);
    const hasActiveTask = state.tasks.some(
      (task) =>
        projectBots.some((b) => b.id === task.botId || b.id === task.reviewerBotId) &&
        ["queued", "running", "awaiting-approval"].includes(task.status),
    );
    if (hasActiveTask) {
      throw new Error("A project with active bot tasks cannot be removed.");
    }
    if (options.deleteBots) {
      state.bots = state.bots.filter((b) => b.workspace !== targetWorkspace);
    }
    state.projects = state.projects.filter((p) => p.id !== idOrWorkspace && p.workspace !== targetWorkspace);
  });
}

export async function listBots(root = productDataDir(), workspace?: string): Promise<BotDefinition[]> {
  const bots = (await readState(root)).bots.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!workspace) return bots;
  const resolved = await canonicalWorkspacePath(workspace);
  return bots.filter((bot) => bot.workspace === resolved);
}

export async function findBot(id: string, root = productDataDir(), workspace?: string): Promise<BotDefinition | undefined> {
  const bots = (await readState(root)).bots;
  const byId = bots.find((bot) => bot.id === id);
  if (byId) return byId;
  const lowered = id.trim().toLocaleLowerCase();
  if (workspace) {
    const resolved = await canonicalWorkspacePath(workspace);
    const inWorkspace = bots.find((bot) => bot.workspace === resolved && bot.name.toLocaleLowerCase() === lowered);
    if (inWorkspace) return inWorkspace;
  }
  return bots.find((bot) => bot.name.toLocaleLowerCase() === lowered);
}

/** Ensure a Lead Orchestrator bot (or a full starter engineering team) exists for the workspace. */
export async function bootstrapFleet(
  workspace: string,
  mode: "lead" | "team" = "lead",
  root = productDataDir(),
): Promise<{ created: BotDefinition[]; bots: BotDefinition[] }> {
  const resolvedWorkspace = await canonicalWorkspacePath(workspace);
  await createProject({ workspace: resolvedWorkspace }, root).catch(() => undefined);
  const existing = await listBots(root, resolvedWorkspace);
  const created: BotDefinition[] = [];
  const specs: Array<{
    name: string;
    role: BotRole;
    runtime: BotRuntime;
    isolation?: BotIsolation;
    instructions: string;
  }> = [
    {
      name: "Ada",
      role: "general",
      runtime: "ocp-agent",
      isolation: "host",
      instructions: leadBotInstructions(),
    },
  ];
  if (mode === "team") {
    specs.push(
      {
        name: "Linus",
        role: "coding",
        runtime: "ocp-coder",
        instructions: defaultBotInstructions("coding"),
      },
      {
        name: "Grace",
        role: "qa",
        runtime: "ocp-agent",
        isolation: "host",
        instructions: defaultBotInstructions("qa"),
      },
      {
        name: "Sentinel",
        role: "security",
        runtime: "ocp-agent",
        isolation: "host",
        instructions: defaultBotInstructions("security"),
      },
      {
        name: "Atlas",
        role: "computer",
        runtime: "ocp-agent",
        isolation: "host",
        instructions: defaultBotInstructions("computer"),
      },
    );
  }
  for (const spec of specs) {
    if (existing.some((b) => b.name.toLocaleLowerCase() === spec.name.toLocaleLowerCase())) {
      continue;
    }
    if (mode === "lead" && existing.length > 0) {
      break;
    }
    const bot = await createBot(
      {
        name: spec.name,
        role: spec.role,
        runtime: spec.runtime,
        isolation: spec.isolation,
        workspace: resolvedWorkspace,
        instructions: spec.instructions,
      },
      root,
    );
    created.push(bot);
  }
  return { created, bots: await listBots(root, resolvedWorkspace) };
}

export async function findTask(id: string, root = productDataDir()): Promise<ProductTask | undefined> {
  return (await listTasks(root)).find((task) => task.id === id);
}

/** Remove one inactive task record from local OpenCodingPartner state. */
export async function deleteTask(id: string, root = productDataDir()): Promise<void> {
  await mutateState(root, (state) => {
    recoverAbandonedTaskRecords(state);
    const index = state.tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new Error(`Unknown task: ${id}`);
    if (["queued", "running", "awaiting-approval"].includes(state.tasks[index]!.status)) {
      throw new Error("An active task cannot be deleted.");
    }
    state.tasks.splice(index, 1);
  });
}

/** Remove a bot definition while retaining task history and runtime session files. */
export async function deleteBot(id: string, root = productDataDir()): Promise<void> {
  await mutateState(root, (state) => {
    recoverAbandonedTaskRecords(state);
    const index = state.bots.findIndex((bot) => bot.id === id);
    if (index < 0) throw new Error(`Unknown bot: ${id}`);
    if (state.tasks.some((task) => (task.botId === id || task.reviewerBotId === id) && ["queued", "running", "awaiting-approval"].includes(task.status))) {
      throw new Error("A bot with active work cannot be deleted.");
    }
    state.bots.splice(index, 1);
  });
}

/** Copy local bot/task state and Hermes profiles to a new, private backup directory. */
export async function backupProductData(destination: string, root = productDataDir()): Promise<string> {
  await mutateState(root, (state) => recoverAbandonedTaskRecords(state));
  const tasks = await listTasks(root);
  if (tasks.some((task) => ACTIVE_TASK_STATUSES.includes(task.status))) {
    throw new Error("Cannot back up while a bot task is active. Wait for all tasks to finish and try again.");
  }
  const source = await realpath(root);
  const requestedTarget = path.resolve(destination);
  const targetParent = await realpath(path.dirname(requestedTarget));
  const target = path.join(targetParent, path.basename(requestedTarget));
  const inside = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  };
  if (inside(source, target) || inside(target, source)) {
    throw new Error("Backup destination cannot overlap the OpenCodingPartner data directory.");
  }
  try {
    await lstat(target);
    throw new Error("Backup destination already exists. Choose a new path; backups are never overwritten.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let createdTarget: { dev: number; ino: number } | undefined;
  try {
    await mutateState(root, async (state) => {
      if (state.tasks.some((task) => ACTIVE_TASK_STATUSES.includes(task.status))) {
        throw new Error("Cannot back up while a bot task is active. Wait for all tasks to finish and try again.");
      }
      await mkdir(target, { mode: 0o700 });
      const targetInfo = await lstat(target);
      createdTarget = { dev: targetInfo.dev, ino: targetInfo.ino };
      await copyProductDataContents(source, target);
      await chmod(target, 0o700);
    });
  } catch (error) {
    if (createdTarget) {
      const current = await lstat(target).catch(() => undefined);
      if (current?.dev === createdTarget.dev && current.ino === createdTarget.ino) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    throw error;
  }
  return target;
}

/** Restore a backup into a new OCP data directory, optionally remapping workspace paths. */
export async function restoreProductData(
  sourceDirectory: string,
  destination: string,
  workspaceMapping?: { from: string; to: string },
): Promise<{ directory: string; remappedBots: string[] }> {
  const source = await realpath(path.resolve(sourceDirectory));
  const state = await readState(source);
  if (state.tasks.some((task) => ACTIVE_TASK_STATUSES.includes(task.status))) {
    throw new Error("The selected backup contains active tasks and cannot be restored. Create a clean backup after those tasks finish.");
  }
  const requestedTarget = path.resolve(destination);
  const targetParent = await realpath(path.dirname(requestedTarget));
  const target = path.join(targetParent, path.basename(requestedTarget));
  const inside = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  };
  if (inside(source, target) || inside(target, source)) {
    throw new Error("Restore destination cannot overlap the backup directory.");
  }

  const remappedBots: string[] = [];
  if (workspaceMapping) {
    const fromCandidate = path.resolve(workspaceMapping.from);
    const from = await realpath(fromCandidate).catch(() => fromCandidate);
    const to = await realpath(path.resolve(workspaceMapping.to));
    if (!(await stat(to)).isDirectory()) throw new Error("Workspace relocation target must be an existing directory.");
    for (const bot of state.bots) {
      const workspace = path.resolve(bot.workspace);
      if (inside(from, workspace)) {
        const relative = path.relative(from, workspace);
        const mapped = path.resolve(to, relative);
        if (!inside(to, mapped)) throw new Error(`Workspace mapping escaped its destination for bot ${bot.name}.`);
        if (!(await stat(mapped).catch(() => undefined))?.isDirectory()) {
          throw new Error(`Mapped workspace for bot ${bot.name} does not exist: ${mapped}`);
        }
        bot.workspace = await realpath(mapped);
        bot.runtimeSessionId = undefined;
        remappedBots.push(bot.name);
      } else if (!(await stat(bot.workspace).catch(() => undefined))?.isDirectory()) {
        throw new Error(`Workspace for bot ${bot.name} is outside the mapped root and is unavailable: ${bot.workspace}`);
      }
    }
  } else {
    for (const bot of state.bots) {
      if (!(await stat(bot.workspace).catch(() => undefined))?.isDirectory()) {
        throw new Error(`Workspace for bot ${bot.name} is unavailable: ${bot.workspace}. Use --workspace-from and --workspace-to to relocate it.`);
      }
    }
  }

  try {
    await lstat(target);
    throw new Error("Restore destination already exists. Choose a new path; existing data is never overwritten.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let createdTarget: { dev: number; ino: number } | undefined;
  try {
    await mkdir(target, { mode: 0o700 });
    const targetInfo = await lstat(target);
    createdTarget = { dev: targetInfo.dev, ino: targetInfo.ino };
    await copyProductDataContents(source, target);
    await writeFile(path.join(target, "state.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(path.join(target, "state.json"), 0o600);
    await chmod(target, 0o700);
  } catch (error) {
    if (createdTarget) {
      const current = await lstat(target).catch(() => undefined);
      if (current?.dev === createdTarget.dev && current.ino === createdTarget.ino) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    throw error;
  }
  return { directory: target, remappedBots };
}

async function copyProductDataContents(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source)) {
    if (entry === ".state.lock" || /^\.state-.*\.tmp$/.test(entry)) continue;
    const sourcePath = path.join(source, entry);
    const destinationPath = path.join(target, entry);
    const copy = async (currentPath: string): Promise<boolean> => {
      const relative = path.relative(source, currentPath);
      if (relative === ".state.lock" || /^\.state-.*\.tmp$/.test(relative)) return false;
      const info = await lstat(currentPath);
      if (info.isSymbolicLink()) throw new Error("Copy refused a symbolic link in the OpenCodingPartner data directory.");
      return true;
    };
    if (!(await copy(sourcePath))) continue;
    await cp(sourcePath, destinationPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: copy,
    });
  }
}

export async function createBot(
  input: Omit<BotDefinition, "id" | "createdAt" | "updatedAt">,
  root = productDataDir(),
): Promise<BotDefinition> {
  const now = new Date().toISOString();
  const agentRuntime = isOcpAgentRuntime(input.runtime);
  const isolation = agentRuntime ? input.isolation ?? "docker" : undefined;
  const bot: BotDefinition = {
    ...input,
    isolation,
    network: agentRuntime && isolation === "docker" ? input.network ?? "disabled" : undefined,
    workspace: await canonicalWorkspacePath(input.workspace),
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  await mutateState(root, (state) => {
    if (
      state.bots.some(
        (existing) =>
          existing.workspace === bot.workspace &&
          existing.name.toLocaleLowerCase() === bot.name.toLocaleLowerCase(),
      )
    ) {
      throw new Error(`A bot named "${bot.name}" already exists in this project workspace.`);
    }
    if (!state.projects) state.projects = [];
    if (!state.projects.some((p) => p.workspace === bot.workspace)) {
      state.projects.push({
        id: randomUUID(),
        name: path.basename(bot.workspace) || bot.workspace,
        workspace: bot.workspace,
        createdAt: now,
        updatedAt: now,
      });
    }
    state.bots.push(bot);
  });
  return bot;
}

export async function updateBot(
  id: string,
  update: Partial<Pick<BotDefinition, "name" | "role" | "runtime" | "isolation" | "network" | "workspace" | "instructions" | "provider" | "endpoint" | "apiKeyEnv" | "model">>,
  root = productDataDir(),
): Promise<BotDefinition> {
  let updated: BotDefinition | undefined;
  await mutateState(root, async (state) => {
    recoverAbandonedTaskRecords(state);
    const bot = state.bots.find((item) => item.id === id);
    if (!bot) throw new Error(`Unknown bot: ${id}`);
    const normalizedUpdate = { ...update };
    if (update.workspace) normalizedUpdate.workspace = await canonicalWorkspacePath(update.workspace);
    const targetWorkspace = normalizedUpdate.workspace ?? bot.workspace;
    const runtime = normalizedUpdate.runtime ?? bot.runtime;
    const agentRuntime = isOcpAgentRuntime(runtime);
    const isolation = normalizedUpdate.isolation ?? bot.isolation ?? "docker";
    const reconfiguredRuntime = (Object.hasOwn(update, "runtime") && isOcpAgentRuntime(bot.runtime) !== agentRuntime) || Object.hasOwn(update, "isolation");
    const network = normalizedUpdate.network ?? (reconfiguredRuntime ? "disabled" : bot.network ?? "disabled");
    if (network === "enabled" && (!agentRuntime || isolation !== "docker")) {
      throw new Error("Network access can only be enabled for an OCP Agent bot using Docker isolation.");
    }
    normalizedUpdate.network = agentRuntime && isolation === "docker" ? network : undefined;
    if (state.tasks.some((task) => (task.botId === id || task.reviewerBotId === id) && ["queued", "running", "awaiting-approval"].includes(task.status))) {
      throw new Error("A bot cannot be reconfigured while one of its tasks is active.");
    }
    const targetName = normalizedUpdate.name ?? bot.name;
    if (
      state.bots.some(
        (item) =>
          item.id !== id &&
          item.workspace === targetWorkspace &&
          item.name.toLocaleLowerCase() === targetName.toLocaleLowerCase(),
      )
    ) {
      throw new Error(`A bot named "${targetName}" already exists in this project workspace.`);
    }
    const runtimeChanged = Object.prototype.hasOwnProperty.call(normalizedUpdate, "runtime")
      && isOcpAgentRuntime(bot.runtime) !== agentRuntime;
    const resetSession = runtimeChanged || ["workspace", "instructions", "provider", "endpoint", "model", "network"].some((key) =>
      Object.prototype.hasOwnProperty.call(normalizedUpdate, key) && bot[key as keyof BotDefinition] !== normalizedUpdate[key as keyof typeof normalizedUpdate]);
    Object.assign(bot, normalizedUpdate, { updatedAt: new Date().toISOString() });
    if (resetSession) bot.runtimeSessionId = undefined;
    updated = bot;
  });
  return updated as BotDefinition;
}

export async function createTask(
  input: Pick<ProductTask, "botId" | "prompt"> & Partial<Pick<ProductTask, "reviewerBotId">>,
  root = productDataDir(),
): Promise<ProductTask> {
  const now = new Date().toISOString();
  const task: ProductTask = { ...input, id: randomUUID(), status: "queued", processId: process.pid, processIdentity: processIdentity(process.pid), createdAt: now, updatedAt: now };
  await mutateState(root, async (state) => {
    recoverAbandonedTaskRecords(state);
    const bot = state.bots.find((item) => item.id === task.botId);
    if (!bot) throw new Error(`Unknown bot: ${task.botId}`);
    const reviewer = task.reviewerBotId ? state.bots.find((item) => item.id === task.reviewerBotId) : undefined;
    if (task.reviewerBotId && !reviewer) throw new Error(`Unknown reviewer bot: ${task.reviewerBotId}`);
    if (reviewer && (reviewer.id === bot.id || !(await workspacePathsMatch(reviewer.workspace, bot.workspace)) || !["qa", "security"].includes(reviewer.role))) {
      throw new Error("A specialist reviewer must be a separate QA or security bot assigned to the same workspace.");
    }
    task.agents = [bot, ...(reviewer ? [reviewer] : [])].map((agent) => ({
      botId: agent.id,
      name: agent.name,
      role: agent.role,
      runtime: agent.runtime,
      isolation: isOcpAgentRuntime(agent.runtime) ? agent.isolation ?? "docker" : undefined,
      provider: agent.provider,
      model: agent.model,
      endpoint: agent.endpoint,
      network: isOcpAgentRuntime(agent.runtime) && (agent.isolation ?? "docker") === "docker" ? agent.network ?? "disabled" : undefined,
    }));
    const activeWorkspaceBots = state.tasks
      .filter((item) => ["queued", "running", "awaiting-approval"].includes(item.status))
      .map((item) => state.bots.find((candidate) => candidate.id === item.botId))
      .filter((candidate): candidate is BotDefinition => candidate !== undefined);
    let activeWorkspace = false;
    for (const activeBot of activeWorkspaceBots) {
      if (await workspacesOverlap(bot.workspace, activeBot.workspace)) {
        activeWorkspace = true;
        break;
      }
    }
    if (activeWorkspace) {
      throw new Error("This workspace already has an active task queued or running. Wait for it to finish or choose a separate workspace.");
    }
    state.tasks.push(task);
  });
  return task;
}

async function canonicalWorkspacePath(workspace: string): Promise<string> {
  try { return await realpath(workspace); }
  catch { return path.resolve(workspace); }
}

export async function workspacePathsMatch(leftPath: string, rightPath: string): Promise<boolean> {
  return (await canonicalWorkspacePath(leftPath)) === (await canonicalWorkspacePath(rightPath));
}

async function workspacesOverlap(leftPath: string, rightPath: string): Promise<boolean> {
  const left = await canonicalWorkspacePath(leftPath);
  const right = await canonicalWorkspacePath(rightPath);
  const within = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  };
  return within(left, right) || within(right, left);
}

export async function updateTask(
  id: string,
  update: Partial<Pick<ProductTask, "status" | "runtimeSessionId" | "result" | "error" | "processId" | "processIdentity" | "approvals" | "pendingApproval" | "workspaceChanges">>,
  root = productDataDir(),
): Promise<ProductTask> {
  let updated: ProductTask | undefined;
  await mutateState(root, (state) => {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    Object.assign(task, update, { updatedAt: new Date().toISOString() });
    if (Object.hasOwn(update, "processId") && update.processId === undefined) task.processIdentity = undefined;
    updated = task;
  });
  return updated as ProductTask;
}

export async function recordTaskApproval(id: string, approval: TaskApproval, root = productDataDir()): Promise<void> {
  await mutateState(root, (state) => {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    task.approvals ??= [];
    task.approvals.push(approval);
    task.updatedAt = new Date().toISOString();
  });
}

export async function recordTaskEvent(
  id: string,
  event: Omit<ProductTaskEvent, "id" | "createdAt">,
  root = productDataDir(),
): Promise<void> {
  await mutateState(root, (state) => {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    task.events ??= [];
    task.events.push({
      ...event,
      title: event.title?.slice(0, 500),
      text: event.text?.slice(0, 4000),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    if (task.events.length > 500) task.events.splice(0, task.events.length - 500);
    task.updatedAt = new Date().toISOString();
  });
}

export async function updateBotSession(id: string, runtimeSessionId: string, root = productDataDir()): Promise<void> {
  await mutateState(root, (state) => {
    const bot = state.bots.find((item) => item.id === id);
    if (!bot) throw new Error(`Unknown bot: ${id}`);
    bot.runtimeSessionId = runtimeSessionId;
    bot.updatedAt = new Date().toISOString();
  });
}

export async function listTasks(root = productDataDir()): Promise<ProductTask[]> {
  const state = await readState(root);
  const stale = state.tasks.filter(isTaskAbandoned);
  if (stale.length > 0) {
    await mutateState(root, (current) => {
      recoverAbandonedTaskRecords(current);
    });
  }
  return (await readState(root)).tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const ACTIVE_TASK_STATUSES = ["queued", "running", "awaiting-approval"];

function isTaskAbandoned(task: ProductTask): boolean {
  if (!ACTIVE_TASK_STATUSES.includes(task.status)) return false;
  return task.processId === undefined || !processIsRunning(task.processId, task.processIdentity);
}

function recoverAbandonedTaskRecords(state: ProductState): void {
  const now = new Date().toISOString();
  for (const task of state.tasks) {
    if (!isTaskAbandoned(task)) continue;
    task.status = "needs-attention";
    task.error = "The owning OpenCodingPartner process exited before recording a result. Inspect the workspace before retrying this task.";
    task.processId = undefined;
    task.processIdentity = undefined;
    task.pendingApproval = undefined;
    task.events ??= [];
    task.events.push({
      id: randomUUID(),
      kind: "recovered",
      title: "Run interrupted",
      text: "The previous local process is no longer running. Review the workspace before starting follow-up work.",
      createdAt: now,
    });
    if (task.events.length > 500) task.events.splice(0, task.events.length - 500);
    task.updatedAt = now;
  }
}

function processIsRunning(pid: number, expectedIdentity?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (expectedIdentity) {
      const currentIdentity = processIdentity(pid);
      // If the OS does not expose an identity, fall back conservatively to PID liveness.
      if (currentIdentity && currentIdentity !== expectedIdentity) return false;
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Linux boot ID plus process start ticks protects recovery from PID reuse. */
function processIdentity(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const statText = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = statText.slice(statText.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTicks = fields[19]; // /proc stat field 22; fields begin at field 3.
    if (!startTicks) return undefined;
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `${bootId}:${startTicks}`;
  } catch {
    return undefined;
  }
}

export interface RuntimeUpdate {
  kind: string;
  text?: string;
  title?: string;
  raw?: unknown;
}

export interface RuntimePermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface RuntimePermissionRequest {
  title: string;
  description?: string;
  subject?: unknown;
  options: RuntimePermissionOption[];
}

export interface RunBotSessionOptions {
  onUpdate?: (update: RuntimeUpdate) => void;
  onPermissionRequest?: (request: RuntimePermissionRequest) => Promise<string | undefined>;
  onPermissionResolved?: (approval: TaskApproval) => Promise<void>;
  onSessionReady?: (sessionId: string) => Promise<void> | void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
}

type RuntimeRpcRequest = (method: string, params: unknown) => Promise<unknown>;

function executableOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (path.isAbsolute(binary) || binary.includes(path.sep)) {
    try {
      accessSync(binary, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      // Keep scanning PATH
    }
  }
  return false;
}

/** Resolve the executable command and arguments for OCP Agent or OCP Coder, defaulting to the built-in ACP runtime unless an explicit binary is configured. */
export function resolveRuntimeCommand(
  agentRuntime: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; fallback: boolean } {
  const explicit = agentRuntime
    ? env.OCP_AGENT_BIN || env.OCP_HERMES_BIN
    : env.OCP_CODER_BIN || env.OCP_GROK_BIN;
  if (explicit) {
    return { command: explicit, args: agentRuntime ? ["acp"] : ["agent", "stdio"], fallback: false };
  }
  const defaultBin = agentRuntime ? "hermes" : "grok";
  if (env.OCP_USE_EXTERNAL_CLI === "1" && executableOnPath(defaultBin, env)) {
    return { command: defaultBin, args: agentRuntime ? ["acp"] : ["agent", "stdio"], fallback: false };
  }
  const nativeScript = fileURLToPath(new URL("./native-acp.js", import.meta.url));
  return {
    command: process.execPath,
    args: [nativeScript, ...(agentRuntime ? ["acp"] : ["agent", "stdio"])],
    fallback: true,
  };
}

function safeRuntimeRpcError(value: unknown): Error {
  const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const data = error.data && typeof error.data === "object" ? error.data as Record<string, unknown> : {};
  const message = typeof error.message === "string" ? error.message : "The agent runtime rejected the request.";
  const rawDetail = typeof error.data === "string"
    ? error.data
    : typeof data.details === "string"
      ? data.details
      : typeof data.message === "string"
        ? data.message
        : typeof data.error === "string"
          ? data.error
          : "";
  const details = rawDetail && rawDetail !== message ? ` ${rawDetail}` : "";
  const code = typeof error.code === "number" || typeof error.code === "string" ? ` (${error.code})` : "";
  const combined = `${message}${details}`;
  const hint = /402\s+Payment\s+Required|usage\s+balance\s+exhausted/i.test(combined)
    ? " (Tip: edit this bot and set Provider to OpenRouter or LiteLLM to route directly through your own API key or local model.)"
    : "";
  const sanitized = `${combined}${hint}`
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{12,}\b/gi, "[redacted credential]")
    .replace(/((?:api[\s_-]*key|authorization|access[\s_-]*token|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 1_200);
  return new Error(`Agent runtime error${code}: ${sanitized}`);
}

async function selectRuntimeModel(
  sessionId: string,
  requestedModel: string,
  session: { configOptions?: unknown; models?: unknown },
  request: RuntimeRpcRequest,
): Promise<void> {
  const matches = (choice: string): boolean => choice === requestedModel || choice.includes(":") && choice.slice(choice.indexOf(":") + 1) === requestedModel;
  const configOptions = Array.isArray(session.configOptions) ? session.configOptions : [];
  const modelOption = configOptions.find((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const option = raw as { id?: unknown; category?: unknown };
    return option.id === "model" || option.category === "model" || option.category === "model_config";
  }) as { id?: unknown; currentValue?: unknown; options?: unknown } | undefined;
  if (modelOption && typeof modelOption.id === "string") {
    if (typeof modelOption.currentValue === "string" && matches(modelOption.currentValue)) return;
    const available = Array.isArray(modelOption.options)
      ? modelOption.options.flatMap((raw) => raw && typeof raw === "object" && typeof (raw as { value?: unknown }).value === "string" ? [(raw as { value: string }).value] : [])
      : [];
    let selectedValue = requestedModel;
    if (available.length > 0) {
      const candidates = available.filter(matches);
      if (candidates.length !== 1) {
        throw new Error(candidates.length === 0
          ? `The requested model "${requestedModel}" is not available in this runtime's model selector.`
          : `The requested model "${requestedModel}" matches multiple runtime models; use the full model ID.`);
      }
      selectedValue = candidates[0]!;
    }
    await request("session/set_config_option", { sessionId, configId: modelOption.id, value: selectedValue });
    return;
  }

  const modelState = session.models && typeof session.models === "object"
    ? session.models as { currentModelId?: unknown; availableModels?: unknown }
    : undefined;
  if (!modelState) {
    throw new Error("The agent runtime did not advertise model selection for this bot. Configure its model in the OCP Agent profile or remove the bot model override.");
  }
  const available = Array.isArray(modelState.availableModels)
    ? modelState.availableModels.flatMap((raw) => raw && typeof raw === "object" && typeof (raw as { modelId?: unknown }).modelId === "string" ? [(raw as { modelId: string }).modelId] : [])
    : [];
  if (typeof modelState.currentModelId === "string" && matches(modelState.currentModelId)) return;

  let selectedModel = requestedModel;
  if (available.length > 0) {
    const candidates = available.filter(matches);
    if (candidates.length !== 1) {
      throw new Error(candidates.length === 0
        ? `The requested model "${requestedModel}" is not available in this runtime's model catalog.`
        : `The requested model "${requestedModel}" matches multiple runtime models; use the full model ID.`);
    }
    selectedModel = candidates[0]!;
  }
  await request("session/set_model", { sessionId, modelId: selectedModel });
}

/** Run a durable bot session through OCP Agent ACP or OCP Coder ACP. */
export async function runBotSession(
  bot: BotDefinition,
  prompt: string,
  options: RunBotSessionOptions = {},
): Promise<{ sessionId: string; result: string; permissionDenied: boolean }> {
  const onUpdate = options.onUpdate ?? (() => undefined);
  const env = options.env ?? process.env;
  const dataRoot = options.dataDir ?? productDataDir(env);
  const persistedSettings = await readProviderSettings(dataRoot);
  const effectiveEnv = applyProviderSettingsToEnv(persistedSettings, env);
  const agentRuntime = isOcpAgentRuntime(bot.runtime);
  const resolved = resolveRuntimeCommand(agentRuntime, effectiveEnv);
  const command = resolved.command;
  const args = resolved.args;
  const runtimeEnv: NodeJS.ProcessEnv = { ...effectiveEnv, OCP_DATA_DIR: dataRoot };
  if (agentRuntime) {
    if ((bot.isolation ?? "docker") === "docker") {
      runtimeEnv.TERMINAL_ENV = "docker";
      runtimeEnv.TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE = "true";
      runtimeEnv.TERMINAL_DOCKER_RUN_AS_HOST_USER = "true";
      runtimeEnv.TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES = "false";
      runtimeEnv.TERMINAL_DOCKER_ORPHAN_REAPER = "true";
      runtimeEnv.TERMINAL_DOCKER_NETWORK = bot.network === "enabled" ? "true" : "false";
      runtimeEnv.TERMINAL_DOCKER_VOLUMES = "[]";
      runtimeEnv.TERMINAL_DOCKER_FORWARD_ENV = "[]";
      runtimeEnv.TERMINAL_DOCKER_ENV = "{}";
      runtimeEnv.TERMINAL_DOCKER_EXTRA_ARGS = "[]";
    } else {
      runtimeEnv.TERMINAL_ENV = "local";
    }
  }
  if (bot.provider) {
    if (!bot.model?.trim()) throw new Error("A model is required for a bot with an explicit provider.");
    const keyEnv = bot.provider === "openrouter" ? "OPENROUTER_API_KEY" : bot.apiKeyEnv || "LITELLM_API_KEY";
    if (bot.provider === "litellm" && keyEnv === "LITELLM_API_KEY" && !runtimeEnv.LITELLM_API_KEY && runtimeEnv.LITELLM_MASTER_KEY) {
      runtimeEnv.LITELLM_API_KEY = runtimeEnv.LITELLM_MASTER_KEY;
    }
    const missingKey = missingProviderKey(bot, runtimeEnv);
    if (missingKey) throw new Error(`Provider key is missing. Set ${missingKey} in the environment before running this bot.`);
    if (agentRuntime) {
      const profile = await configureHermesBot(bot, dataRoot);
      runtimeEnv.HERMES_HOME = profile;
    } else {
      const profile = await configureCoderBot(bot, dataRoot);
      runtimeEnv.GROK_HOME = profile;
      runtimeEnv.HERMES_HOME = profile;
      runtimeEnv.GROK_TELEMETRY_ENABLED = "0";
      runtimeEnv.GROK_FEEDBACK_ENABLED = "0";
    }
  }
  let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let resolveChildClose!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const childClosePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveChildClose = resolve; });
  let forceKillTimer: NodeJS.Timeout | undefined;
  const child = spawn(command, args, { cwd: bot.workspace, env: runtimeEnv, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const abortChild = () => {
    if (closed || forceKillTimer) return;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    forceKillTimer.unref();
  };
  options.signal?.addEventListener("abort", abortChild, { once: true });
  if (options.signal?.aborted) abortChild();
  const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  let text = "";
  let permissionDenied = false;
  child.on("error", (error) => {
    closed = { code: 127, signal: null };
    if (forceKillTimer) clearTimeout(forceKillTimer);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Could not start ${command}: ${error.message}`));
    }
    pending.clear();
  });
  child.on("close", (code, signal) => {
    closed = { code, signal };
    resolveChildClose(closed);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Agent process exited (${code ?? signal ?? "unknown"}).`));
    }
    pending.clear();
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
      if (message.method !== "session/request_permission") {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Unsupported ACP request." } })}\n`);
        return;
      }
      void resolvePermission(message).catch(() => {
        permissionDenied = true;
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } })}\n`);
        onUpdate({ kind: "permission_denied", title: "Permission decision could not be recorded" });
      });
      return;
    }
    if (typeof message.id === "number" || typeof message.id === "string") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error && typeof message.error === "object") {
        waiter.reject(safeRuntimeRpcError(message.error));
      } else waiter.resolve(message.result);
      return;
    }
    if (message.method === "session/update" && message.params && typeof message.params === "object") {
      const params = message.params as Record<string, unknown>;
      const candidate = params.update && typeof params.update === "object" ? params.update : params;
      const update = candidate as Record<string, unknown>;
      const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "update";
      const content = update.content && typeof update.content === "object" ? update.content as { text?: unknown } : undefined;
      const chunk = typeof content?.text === "string" ? content.text : undefined;
      if (kind === "agent_message_chunk" && chunk) text += chunk;
      onUpdate({ kind, text: chunk, title: typeof update.title === "string" ? update.title : undefined, raw: update });
      return;
    }
  });

  async function resolvePermission(message: Record<string, unknown>): Promise<void> {
    const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : {};
    const toolCall = params.toolCall && typeof params.toolCall === "object" ? params.toolCall as Record<string, unknown> : undefined;
    const rawOptions = Array.isArray(params.options) ? params.options : [];
    const choices = rawOptions.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const option = raw as Record<string, unknown>;
      if (typeof option.optionId !== "string" || typeof option.name !== "string" || typeof option.kind !== "string") return [];
      return [{ optionId: option.optionId, name: option.name, kind: option.kind }];
    });
    const title = typeof params.title === "string"
      ? params.title
      : typeof toolCall?.title === "string"
        ? toolCall.title
        : typeof toolCall?.name === "string"
          ? `Allow ${toolCall.name}?`
          : "Agent requests permission";
    const description = typeof params.description === "string"
      ? params.description
      : toolCall
        ? JSON.stringify({ kind: toolCall.kind, input: toolCall.rawInput, content: toolCall.content }).slice(0, 4000)
        : undefined;
    const allowOnce = choices.find((choice) => choice.kind === "allow_once");
    const selected = allowOnce && options.onPermissionRequest
      ? await options.onPermissionRequest({ title, description, subject: params.subject ?? toolCall, options: choices })
      : undefined;
    const allowed = allowOnce !== undefined && selected === allowOnce.optionId;
    const approval: TaskApproval = {
      title,
      description,
      decision: allowed ? "allow-once" : "cancelled",
      createdAt: new Date().toISOString(),
    };
    await options.onPermissionResolved?.(approval);
    if (allowed) {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "selected", optionId: allowOnce.optionId } },
      })}\n`);
      onUpdate({ kind: "permission_allowed", title });
      return;
    }
    permissionDenied = true;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } })}\n`);
    onUpdate({ kind: "permission_denied", title });
  }

  const request = (method: string, params: unknown): Promise<unknown> => {
    if (closed) return Promise.reject(new Error(`Agent process exited (${closed.code ?? closed.signal}).`));
    const id = nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for agent runtime method ${method}.`));
        abortChild();
      }, 10 * 60_000);
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  };

  try {
    const initializeResult = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const initializeRecord = initializeResult && typeof initializeResult === "object" ? initializeResult as { agentCapabilities?: unknown } : {};
    const agentCapabilities = initializeRecord.agentCapabilities && typeof initializeRecord.agentCapabilities === "object"
      ? initializeRecord.agentCapabilities as { loadSession?: unknown }
      : {};
    const workspaceTools = (agentRuntime || resolved.fallback) ? [{
      name: "opencodingpartner-workspace",
      command: process.execPath,
      args: [fileURLToPath(new URL("./workspace-mcp.js", import.meta.url)), bot.workspace],
      env: [{ name: "OCP_DATA_DIR", value: dataRoot }],
    }] : [];
    const toolGuidance = (agentRuntime || resolved.fallback)
      ? "For project files, fleet management, and computer use, use the OpenCodingPartner MCP tools: workspace tools (workspace_list, workspace_read, workspace_grep, workspace_glob, workspace_write, workspace_patch), bot & fleet management (bot_list, bot_create, bot_update, bot_delete, bot_delegate, swarm_setup), workspace memory (memory_search / memory_remember), local task history recall (history_search / history_read), and virtual computer control (computer_screen, computer_mouse, computer_keyboard, computer_browser). Use the OCP Agent Docker terminal only for checks explicitly allowed by the user request.\n\n"
      : "";
    const canLoadSession = agentCapabilities.loadSession === true;
    if (bot.runtimeSessionId && !canLoadSession) {
      onUpdate({ kind: "session_reset", title: "Runtime cannot resume this saved session; starting a new session." });
    }
    const sessionResult = bot.runtimeSessionId && canLoadSession
      ? await request("session/load", { sessionId: bot.runtimeSessionId, cwd: bot.workspace, mcpServers: workspaceTools })
      : await request("session/new", {
          cwd: bot.workspace,
          mcpServers: workspaceTools,
          _meta: { rules: `You are the ${bot.name}, a ${bot.role} teammate.\n\n${bot.instructions}\n\n${toolGuidance}` },
        });
    const sessionRecord = sessionResult && typeof sessionResult === "object"
      ? sessionResult as { sessionId?: unknown; configOptions?: unknown; models?: unknown }
      : {};
    const sessionId = typeof sessionRecord.sessionId === "string" ? sessionRecord.sessionId : bot.runtimeSessionId;
    if (!sessionId) throw new Error("Agent runtime did not return an ACP session ID.");
    await options.onSessionReady?.(sessionId);
    if (bot.model && !bot.provider) await selectRuntimeModel(sessionId, bot.model, sessionRecord, request);
    const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: `${toolGuidance}${prompt}` }] });
    const resultRecord = result && typeof result === "object" ? result as { stopReason?: unknown } : {};
    if (!text && typeof resultRecord.stopReason === "string") text = `Agent finished (${resultRecord.stopReason}) without a text response.`;
    child.stdin.end();
    const shutdownTimer = setTimeout(abortChild, 5_000);
    shutdownTimer.unref();
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try { exit = closed ?? await childClosePromise; }
    finally { clearTimeout(shutdownTimer); }
    if (options.signal?.aborted) throw new Error("Agent run cancelled.");
    if (exit.code !== 0) throw new Error(`Agent process exited after its response (${exit.code ?? exit.signal ?? "unknown"}).`);
    return { sessionId, result: text, permissionDenied };
  } catch (error) {
    abortChild();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abortChild);
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    pending.clear();
    lines.close();
  }
}

async function configureHermesBot(bot: BotDefinition, root: string): Promise<string> {
  const profile = path.join(root, "hermes-profiles", bot.id);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await chmod(profile, 0o700);
  const model = yamlScalar(bot.model ?? "");
  const providerConfig = bot.provider === "openrouter"
    ? `model:\n  provider: openrouter\n  default: ${model}\n`
    : `model:\n  provider: custom\n  default: ${model}\n  base_url: ${yamlScalar(bot.endpoint ?? "")}\n  key_env: ${yamlScalar(bot.apiKeyEnv || "LITELLM_API_KEY")}\n`;
  const terminalConfig = bot.isolation === "host" ? "" : [
    "terminal:",
    "  backend: docker",
    "  docker_mount_cwd_to_workspace: true",
    "  docker_run_as_host_user: true",
    "  docker_persist_across_processes: false",
    "  docker_orphan_reaper: true",
    `  docker_network: ${bot.network === "enabled" ? "true" : "false"}`,
    "  docker_volumes: []",
    "  docker_forward_env: []",
    "  docker_env: {}",
    "  docker_extra_args: []",
    "",
  ].join("\n");
  await writeFile(path.join(profile, "config.yaml"), `${providerConfig}\n${terminalConfig}`, { encoding: "utf8", mode: 0o600 });
  await chmod(path.join(profile, "config.yaml"), 0o600);
  return profile;
}

async function configureCoderBot(bot: BotDefinition, root: string): Promise<string> {
  const profile = path.join(root, "coder-profiles", bot.id);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await chmod(profile, 0o700);
  const modelId = bot.model ?? "";
  const baseUrl = bot.provider === "openrouter"
    ? "https://openrouter.ai/api/v1"
    : (bot.endpoint ?? "http://127.0.0.1:4000/v1");
  const keyEnv = bot.provider === "openrouter" ? "OPENROUTER_API_KEY" : (bot.apiKeyEnv || "LITELLM_API_KEY");
  const mcpScript = fileURLToPath(new URL("./workspace-mcp.js", import.meta.url));
  const toml = [
    "[cli]",
    "auto_update = false",
    "",
    "[features]",
    "telemetry = false",
    "feedback = false",
    "support_permission = true",
    "",
    "[telemetry]",
    "trace_upload = false",
    "mixpanel_enabled = false",
    "",
    "[models]",
    'default = "ocp-custom"',
    'web_search = "ocp-custom"',
    "",
    "[model.ocp-custom]",
    `model = ${yamlScalar(modelId)}`,
    `base_url = ${yamlScalar(baseUrl)}`,
    `name = ${yamlScalar(modelId)}`,
    `env_key = ${yamlScalar(keyEnv)}`,
    "context_window = 256000",
    "",
    "[mcp_servers.opencodingpartner-workspace]",
    `command = ${yamlScalar(process.execPath)}`,
    `args = [${yamlScalar(mcpScript)}, ${yamlScalar(bot.workspace)}]`,
    "enabled = true",
    "",
    "[mcp_servers.opencodingpartner-workspace.env]",
    `OCP_DATA_DIR = ${yamlScalar(root)}`,
    "",
  ].join("\n");
  await writeFile(path.join(profile, "config.toml"), toml, { encoding: "utf8", mode: 0o600 });
  await chmod(path.join(profile, "config.toml"), 0o600);
  const yaml = bot.provider === "openrouter"
    ? `model:\n  provider: openrouter\n  default: ${yamlScalar(modelId)}\n`
    : `model:\n  provider: custom\n  default: ${yamlScalar(modelId)}\n  base_url: ${yamlScalar(baseUrl)}\n  key_env: ${yamlScalar(keyEnv)}\n`;
  await writeFile(path.join(profile, "config.yaml"), yaml, { encoding: "utf8", mode: 0o600 });
  await chmod(path.join(profile, "config.yaml"), 0o600);
  return profile;
}

export {
  captureComputerScreen,
  computerKeyboard,
  computerMouse,
  computerOpenBrowser,
  ensureComputerDisplay,
  readDesktopState,
  setComputerControl,
  stopComputerDesktop,
  type ComputerActionResult,
  type ComputerDesktopState,
  type KeyboardActionInput,
  type MouseActionInput,
} from "./computer-desktop.js";

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

async function readState(root: string): Promise<ProductState> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as ProductState;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.bots) || !Array.isArray(parsed.tasks)) {
      throw new Error("Unsupported or corrupt OpenCodingPartner state file.");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STATE, bots: [], tasks: [] };
    throw error;
  }
}

async function mutateState(root: string, mutate: (state: ProductState) => void | Promise<void>): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  const lock = path.join(root, ".state.lock");
  const started = Date.now();
  let lockHandle;
  for (;;) {
    try {
      lockHandle = await open(lock, "wx", 0o600);
      await lockHandle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await clearDeadLock(lock);
      if (Date.now() - started > 10_000) throw new Error("Timed out waiting for the local state lock.");
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  try {
    const state = await readState(root);
    await mutate(state);
    const target = path.join(root, "state.json");
    const temp = path.join(root, `.state-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, target);
  } finally {
    await lockHandle.close();
    await rm(lock, { force: true });
  }
}

async function clearDeadLock(lockPath: string): Promise<void> {
  try {
    const [contents, info] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    const pid = Number(contents.trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      }
    } else if (Date.now() - info.mtimeMs < 5_000) {
      return;
    }
    await rm(lockPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
