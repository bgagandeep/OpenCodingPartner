import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyUnifiedDiff,
  appendSandboxFile,
  copySandboxFile,
  deleteSandboxFile,
  globSandbox,
  grepSandbox,
  listSandboxDir,
  mkdirSandboxDir,
  renameSandboxFile,
  readSandboxText,
  rmdirSandboxDir,
  securityGate,
  writeSandboxFile,
} from "@opencodingpartner/workers";
import {
  captureComputerScreen,
  computerKeyboard,
  computerMouse,
  computerOpenBrowser,
  type KeyboardActionInput,
  type MouseActionInput,
} from "./computer-desktop.js";
import {
  bootstrapFleet,
  createBot,
  createTask,
  defaultBotInstructions,
  deleteBot,
  findBot,
  listBots,
  listTasks,
  productDataDir,
  updateBot,
  waitForRecordedApproval,
  validBotNetworkMode,
  validBotProvider,
  validBotRole,
  validBotRuntime,
  type BotIsolation,
  type BotNetworkMode,
  type BotProvider,
  type BotRole,
  type BotRuntime,
} from "./index.js";
import { runWorkspaceCommand, runWorkspaceTests } from "./sandbox-run.js";

const acceptedPlans = new Set<string>();
const WRITE_TOOLS = new Set([
  "workspace_write",
  "workspace_patch",
  "workspace_append",
  "workspace_delete",
  "workspace_rename",
  "workspace_copy",
  "workspace_mkdir",
  "workspace_rmdir",
]);

type RpcId = string | number;
interface RpcMessage { id?: RpcId; method?: string; params?: Record<string, unknown>; }

const DIRECT_TOOLS = [
  { name: "workspace_list", description: "List names in a workspace directory. Secret metadata folders are omitted.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative directory; defaults to the workspace root." } } } },
  { name: "workspace_read", description: "Read a non-secret text file from the assigned workspace.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "workspace_grep", description: "Search safe text files for a short phrase or simple regular expression.", inputSchema: { type: "object", properties: { query: { type: "string" }, path: { type: "string", description: "Optional relative directory." } }, required: ["query"] } },
  { name: "workspace_glob", description: "Find workspace files with a relative glob such as src/**/*.ts.", inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "workspace_write", description: "Create one new text file in the assigned workspace. Existing files must be changed with workspace_patch.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "workspace_patch", description: "Apply a unified diff to an existing text file in the assigned workspace.", inputSchema: { type: "object", properties: { path: { type: "string" }, diff: { type: "string" } }, required: ["path", "diff"] } },
  { name: "workspace_append", description: "Append text to an existing workspace file.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "workspace_delete", description: "Delete one text file in the workspace. Directories and protected evidence folders cannot be deleted.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "workspace_rename", description: "Rename one workspace file without overwriting an existing target.", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
  { name: "workspace_copy", description: "Copy one workspace file without overwriting an existing target.", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
  { name: "workspace_mkdir", description: "Create a directory in the workspace.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "workspace_rmdir", description: "Remove one empty directory in the workspace.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "workspace_shell", description: "Run one allow-listed argv command in the workspace (node --test, pnpm test, tsc --noEmit, or read-only git). No shell interpolation.", inputSchema: { type: "object", properties: { argv: { type: "array", items: { type: "string" } } }, required: ["argv"] } },
  { name: "workspace_test", description: "Run node --test in the assigned workspace and return stdout/stderr.", inputSchema: { type: "object", properties: {} } },
  { name: "plan_submit", description: "Submit an implementation plan for human approval before coding edits. Required for coding writes.", inputSchema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] } },
  { name: "memory_search", description: "Search persistent workspace memory for facts, conventions, and past decisions.", inputSchema: { type: "object", properties: { query: { type: "string", description: "Keyword or phrase to search for; empty returns recent memories." } } } },
  { name: "memory_remember", description: "Save a concise non-secret fact, convention, or architectural decision to persistent workspace memory.", inputSchema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] } },
  { name: "memory_forget", description: "Remove entries matching a phrase from persistent workspace memory.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "history_search", description: "Search previous local task transcripts and agent reports for this workspace.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "history_read", description: "Read recent local task exchanges or a specific task report for this workspace.", inputSchema: { type: "object", properties: { taskId: { type: "string" }, limit: { type: "number" } } } },
  { name: "computer_screen", description: "Boot or attach to the bot's virtual computer display, capture a live PNG screenshot to gtm/last-frame.png, and return screen dimensions, cursor coordinates, and active window title.", inputSchema: { type: "object", properties: {} } },
  { name: "computer_mouse", description: "Control the mouse on the bot's virtual computer display (move, click, double_click, right_click, middle_click, down, up, drag, scroll, position).", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["move", "click", "double_click", "right_click", "middle_click", "down", "up", "drag", "scroll", "position"] }, x: { type: "number" }, y: { type: "number" }, fromX: { type: "number" }, fromY: { type: "number" }, button: { type: "string", enum: ["left", "middle", "right"] }, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number" } }, required: ["action"] } },
  { name: "computer_keyboard", description: "Control the keyboard on the bot's virtual computer display (type text or press keys/hotkeys such as Return, Tab, Escape, BackSpace, ctrl+l, ctrl+c).", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["type", "key", "hotkey"] }, text: { type: "string" }, key: { type: "string" } }, required: ["action"] } },
  { name: "computer_browser", description: "Open a URL in Google Chrome inside the bot's virtual computer display and capture a screenshot.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "bot_list", description: "List all bots in the OpenCodingPartner fleet along with their roles, runtimes, models, workspaces, and active task counts.", inputSchema: { type: "object", properties: {} } },
  { name: "bot_create", description: "Create a new persistent bot teammate with a specific name, role, runtime, model/provider, and operating instructions.", inputSchema: { type: "object", properties: { name: { type: "string", description: "Unique bot name (e.g. Linus, Grace, Sentinel)." }, role: { type: "string", enum: ["general", "coding", "qa", "security", "research", "computer"] }, runtime: { type: "string", enum: ["ocp-agent", "ocp-coder"] }, isolation: { type: "string", enum: ["docker", "host"] }, network: { type: "string", enum: ["disabled", "enabled"] }, provider: { type: "string", enum: ["openrouter", "litellm"] }, model: { type: "string" }, endpoint: { type: "string" }, apiKeyEnv: { type: "string" }, workspace: { type: "string" }, instructions: { type: "string" } }, required: ["name"] } },
  { name: "bot_update", description: "Update an existing bot's role, runtime, model/provider, isolation, or instructions by bot ID or name.", inputSchema: { type: "object", properties: { bot: { type: "string", description: "Target bot ID or name." }, name: { type: "string", description: "Optional new name for the bot." }, role: { type: "string", enum: ["general", "coding", "qa", "security", "research", "computer"] }, runtime: { type: "string", enum: ["ocp-agent", "ocp-coder"] }, isolation: { type: "string", enum: ["docker", "host"] }, network: { type: "string", enum: ["disabled", "enabled"] }, provider: { type: "string", enum: ["openrouter", "litellm"] }, model: { type: "string" }, endpoint: { type: "string" }, apiKeyEnv: { type: "string" }, instructions: { type: "string" } }, required: ["bot"] } },
  { name: "bot_delete", description: "Delete an inactive bot from the fleet by ID or name.", inputSchema: { type: "object", properties: { bot: { type: "string", description: "Bot ID or name to delete." } }, required: ["bot"] } },
  { name: "bot_delegate", description: "Delegate a task to another bot in the fleet (by ID or name), optionally chaining a QA or security reviewer bot, and return the teammate's response.", inputSchema: { type: "object", properties: { bot: { type: "string", description: "Target bot ID or name (e.g. Linus, Grace)." }, prompt: { type: "string", description: "Task instructions for the delegated bot." }, reviewer: { type: "string", description: "Optional QA or security reviewer bot ID or name." } }, required: ["bot", "prompt"] } },
  { name: "swarm_setup", description: "Provision a complete multi-agent engineering team (Ada Lead Orchestrator, Linus OCP Coder, Grace QA Reviewer, Sentinel Security Auditor, Atlas Computer Specialist) in the current workspace.", inputSchema: { type: "object", properties: {} } },
];

const DISCOVERY_TOOLS = [
  { name: "tool_search", description: "Search available workspace, memory, history, computer, and bot-management tools by keyword.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "tool_describe", description: "Return JSON schemas and usage guidance for up to 10 tool names.", inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] } },
  { name: "tool_call", description: "Invoke a built-in workspace, memory, history, computer, or bot-management tool by name and arguments.", inputSchema: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name"] } },
];

const TOOLS = [...DIRECT_TOOLS, ...DISCOVERY_TOOLS];
const DISCOVERY_NAMES = new Set(DISCOVERY_TOOLS.map((t) => t.name));
const MAX_FILE_BYTES = 500_000;

function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return productDataDir(env);
}

function workspaceMemoryFilePath(root: string): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(resolveDataDir(), "memories", hash, "MEMORY.md");
}

/** MCP stdio bridge that exposes the existing guarded coding tools to an ACP session. */
export async function runWorkspaceMcp(workspace: string): Promise<void> {
  const root = await realpath(path.resolve(workspace));
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk.toString();
    if (buffer.length > 1_000_000 && !buffer.includes("\n")) {
      buffer = "";
      continue;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { continue; }
      if (message.method?.startsWith("notifications/")) continue;
      if (message.id === undefined || !message.method) continue;
      try {
        const result = await handleMcpRequest(root, message.method, message.params ?? {});
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "Workspace tool failed." } })}\n`);
      }
    }
  }
}

export async function readWorkspaceFile(workspace: string, relativePath: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  let root: string;
  try { root = await realpath(path.resolve(workspace)); }
  catch { return { ok: false, error: "workspace directory is unavailable" }; }
  try { await assertSafeWorkspacePath(root, relativePath, false); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "workspace path refused" }; }
  const info = await stat(path.resolve(root, relativePath)).catch(() => undefined);
  if (info && info.size > MAX_FILE_BYTES) return { ok: false, error: "file is larger than the 500 KB workspace-tool limit" };
  const result = await readSandboxText(root, relativePath);
  return result.ok ? { ok: true, content: result.detail } : { ok: false, error: result.detail };
}

async function handleMcpRequest(root: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "initialize") {
    return { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "opencodingpartner-workspace", version: "0.1.0" } };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method !== "tools/call") throw new Error(`Unsupported MCP method: ${method}`);
  const name = typeof params.name === "string" ? params.name : "";
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
  return executeToolCall(root, name, args, false);
}

async function executeToolCall(root: string, name: string, args: Record<string, unknown>, viaDiscovery: boolean): Promise<unknown> {
  if (name === "tool_search") {
    if (viaDiscovery) return mcpToolResult({ ok: false, detail: "A discovery tool cannot call another discovery tool." });
    const query = (typeof args.query === "string" ? args.query : "").trim().toLowerCase();
    const scored = DIRECT_TOOLS
      .map((tool) => {
        const hay = `${tool.name} ${tool.description}`.toLowerCase();
        const score = !query ? 1 : tool.name.toLowerCase() === query ? 3 : tool.name.toLowerCase().includes(query) ? 2 : hay.includes(query) ? 1 : 0;
        return { tool, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((entry) => ({ name: entry.tool.name, description: entry.tool.description }));
    return mcpToolResult({ ok: true, detail: JSON.stringify(scored, null, 2) });
  }
  if (name === "tool_describe") {
    if (viaDiscovery) return mcpToolResult({ ok: false, detail: "A discovery tool cannot call another discovery tool." });
    const rawNames = Array.isArray(args.names)
      ? args.names
      : typeof args.name === "string"
        ? [args.name]
        : [];
    const names = rawNames.filter((n): n is string => typeof n === "string").slice(0, 10);
    const described = DIRECT_TOOLS.filter((tool) => names.includes(tool.name));
    return mcpToolResult({ ok: true, detail: JSON.stringify(described, null, 2) });
  }
  if (name === "tool_call") {
    if (viaDiscovery) return mcpToolResult({ ok: false, detail: "A discovery tool cannot call another discovery tool." });
    const targetName = typeof args.name === "string" ? args.name : "";
    if (DISCOVERY_NAMES.has(targetName)) {
      return mcpToolResult({ ok: false, detail: "A discovery tool cannot call another discovery tool." });
    }
    const targetArgs = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {};
    return executeToolCall(root, targetName, targetArgs, true);
  }
  if (name === "memory_search") {
    const query = (typeof args.query === "string" ? args.query : "").trim().toLowerCase();
    const memFile = workspaceMemoryFilePath(root);
    const content = await readFile(memFile, "utf8").catch(() => "");
    const lines = content.split(/\r?\n/).filter((line) => line.trim().startsWith("- "));
    const matches = query ? lines.filter((line) => line.toLowerCase().includes(query)) : lines;
    return mcpToolResult({ ok: true, detail: matches.slice(-25).join("\n") || "No matching workspace memories." });
  }
  if (name === "memory_remember") {
    const rawFact = typeof args.fact === "string" ? args.fact : typeof args.note === "string" ? args.note : "";
    const section = typeof args.section === "string" ? args.section.replace(/[\r\n]+/g, " ").trim() : "";
    const factBody = rawFact.replace(/[\r\n]+/g, " ").trim();
    const fact = section && factBody ? `[${section}] ${factBody}` : factBody;
    if (!fact || fact.length > 2_000) return mcpToolResult({ ok: false, detail: "fact must be 1 to 2,000 characters" });
    const gate = securityGate({ relativePath: "MEMORY.md", content: fact, sandboxRoot: root });
    if (!gate.allow) return mcpToolResult({ ok: false, detail: `blocked (${gate.reasons.join(", ")})` });
    const memFile = workspaceMemoryFilePath(root);
    await mkdir(path.dirname(memFile), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(memFile), 0o700).catch(() => undefined);
    const existing = await readFile(memFile, "utf8").catch(() => "# Workspace Memory\n\n");
    const entry = `- [${new Date().toISOString().slice(0, 10)}] ${fact}\n`;
    await writeFile(memFile, `${existing}${entry}`, { encoding: "utf8", mode: 0o600 });
    await chmod(memFile, 0o600).catch(() => undefined);
    return mcpToolResult({ ok: true, detail: "remembered" });
  }
  if (name === "memory_forget") {
    const rawQuery = typeof args.query === "string" ? args.query : typeof args.match === "string" ? args.match : "";
    const query = rawQuery.trim().toLowerCase();
    if (!query) return mcpToolResult({ ok: false, detail: "query is required" });
    const memFile = workspaceMemoryFilePath(root);
    const existing = await readFile(memFile, "utf8").catch(() => "");
    if (!existing) return mcpToolResult({ ok: true, detail: "removed 0 entries" });
    const lines = existing.split(/\r?\n/);
    let removed = 0;
    const kept = lines.filter((line) => {
      if (line.trim().startsWith("- ") && line.toLowerCase().includes(query)) {
        removed += 1;
        return false;
      }
      return true;
    });
    await writeFile(memFile, kept.join("\n"), { encoding: "utf8", mode: 0o600 });
    return mcpToolResult({ ok: true, detail: `removed ${removed} entries` });
  }
  if (name === "history_search" || name === "history_read") {
    const stateFile = path.join(resolveDataDir(), "state.json");
    let parsed: { bots?: Array<{ id: string; name: string; workspace: string }>; tasks?: Array<{ id: string; botId: string; status: string; createdAt: string; prompt: string; result?: string; error?: string }> } = {};
    try {
      parsed = JSON.parse(await readFile(stateFile, "utf8")) as typeof parsed;
    } catch {
      return mcpToolResult({ ok: true, detail: "No local task history available." });
    }
    const workspaceBotIds = new Set(
      (parsed.bots ?? []).filter((b) => path.resolve(b.workspace) === root).map((b) => b.id),
    );
    const botNames = new Map((parsed.bots ?? []).map((b) => [b.id, b.name]));
    const workspaceTasks = (parsed.tasks ?? [])
      .filter((t) => workspaceBotIds.has(t.botId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (name === "history_search") {
      const query = (typeof args.query === "string" ? args.query : "").trim().toLowerCase();
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
      const hits = workspaceTasks
        .filter((t) => `${t.prompt}\n${t.result ?? ""}\n${t.error ?? ""}`.toLowerCase().includes(query))
        .slice(0, limit)
        .map((t) => ({
          taskId: t.id,
          bot: botNames.get(t.botId) ?? t.botId,
          status: t.status,
          createdAt: t.createdAt,
          promptExcerpt: t.prompt.slice(0, 200),
          resultExcerpt: (t.result ?? t.error ?? "").slice(0, 400),
        }));
      return mcpToolResult({ ok: true, detail: JSON.stringify(hits, null, 2).slice(0, 8_000) });
    }

    const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    const selected = taskId ? workspaceTasks.filter((t) => t.id === taskId) : workspaceTasks.slice(0, limit);
    const records = selected.map((t) => ({
      taskId: t.id,
      bot: botNames.get(t.botId) ?? t.botId,
      status: t.status,
      createdAt: t.createdAt,
      prompt: t.prompt.slice(0, 2_000),
      result: (t.result ?? "").slice(0, 4_000),
      error: t.error,
    }));
    return mcpToolResult({ ok: true, detail: JSON.stringify(records, null, 2).slice(0, 16_000) });
  }

  if (name === "computer_screen") {
    const res = await captureComputerScreen(root);
    return mcpToolResult({ ok: res.ok, detail: JSON.stringify(res, null, 2) });
  }
  if (name === "computer_mouse") {
    const action = (typeof args.action === "string" ? args.action : "position") as MouseActionInput["action"];
    const res = await computerMouse(root, {
      action,
      x: typeof args.x === "number" ? args.x : undefined,
      y: typeof args.y === "number" ? args.y : undefined,
      fromX: typeof args.fromX === "number" ? args.fromX : undefined,
      fromY: typeof args.fromY === "number" ? args.fromY : undefined,
      button: typeof args.button === "string" ? (args.button as MouseActionInput["button"]) : undefined,
      direction: typeof args.direction === "string" ? (args.direction as MouseActionInput["direction"]) : undefined,
      amount: typeof args.amount === "number" ? args.amount : undefined,
      actor: "partner",
    });
    return mcpToolResult({ ok: res.ok, detail: JSON.stringify(res, null, 2) });
  }
  if (name === "computer_keyboard") {
    const action = (typeof args.action === "string" ? args.action : "type") as KeyboardActionInput["action"];
    const res = await computerKeyboard(root, {
      action,
      text: typeof args.text === "string" ? args.text : undefined,
      key: typeof args.key === "string" ? args.key : undefined,
      actor: "partner",
    });
    return mcpToolResult({ ok: res.ok, detail: JSON.stringify(res, null, 2) });
  }
  if (name === "computer_browser") {
    const url = typeof args.url === "string" ? args.url : "";
    const res = await computerOpenBrowser(root, url, "partner");
    return mcpToolResult({ ok: res.ok, detail: JSON.stringify(res, null, 2) });
  }

  const dataDir = resolveDataDir();
  if (name === "bot_list") {
    const allProjects = Boolean(args.allProjects);
    const [bots, tasks] = await Promise.all([
      listBots(dataDir, allProjects ? undefined : root),
      listTasks(dataDir),
    ]);
    const summary = bots.map((b) => ({
      id: b.id,
      name: b.name,
      role: b.role,
      runtime: b.runtime,
      isolation: b.isolation,
      network: b.network,
      provider: b.provider ?? "default",
      model: b.model ?? "default",
      workspace: b.workspace,
      activeTasks: tasks.filter((t) => t.botId === b.id && ["queued", "running", "awaiting-approval"].includes(t.status)).length,
    }));
    return mcpToolResult({ ok: true, detail: JSON.stringify({ ok: true, workspace: root, count: summary.length, bots: summary }, null, 2) });
  }
  if (name === "swarm_setup") {
    try {
      const res = await bootstrapFleet(root, "team", dataDir, { isolation: "docker" });
      return mcpToolResult({
        ok: true,
        detail: JSON.stringify(
          {
            ok: true,
            created: res.created.map((b) => ({ id: b.id, name: b.name, role: b.role, runtime: b.runtime })),
            bots: res.bots.map((b) => ({ id: b.id, name: b.name, role: b.role, runtime: b.runtime })),
          },
          null,
          2,
        ),
      });
    } catch (error) {
      return mcpToolResult({ ok: false, detail: error instanceof Error ? error.message : "Failed to set up swarm." });
    }
  }
  if (name === "bot_create") {
    const botName = typeof args.name === "string" ? args.name.trim() : "";
    if (!botName) return mcpToolResult({ ok: false, detail: "Bot name is required." });
    const rawRole = typeof args.role === "string" ? args.role.trim().toLowerCase() : "general";
    const role: BotRole = validBotRole(rawRole) ? rawRole : "general";
    const rawRuntime = typeof args.runtime === "string" ? args.runtime.trim().toLowerCase() : role === "coding" ? "ocp-coder" : "ocp-agent";
    const runtime: BotRuntime = validBotRuntime(rawRuntime) ? rawRuntime : "ocp-agent";
    if (args.isolation === "host") {
      return mcpToolResult({ ok: false, detail: "Host isolation can only be set by a human. Created bots use Docker isolation." });
    }
    const isolation: BotIsolation = "docker";
    const network: BotNetworkMode = validBotNetworkMode(String(args.network ?? "disabled")) ? (args.network as BotNetworkMode) : "disabled";
    const rawProvider: BotProvider | undefined = typeof args.provider === "string" && validBotProvider(args.provider) ? args.provider : undefined;
    const providerKeyAvailable = rawProvider === "openrouter"
      ? Boolean(process.env.OPENROUTER_API_KEY)
      : rawProvider === "litellm"
        ? Boolean(process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY)
        : false;
    const provider: BotProvider | undefined = providerKeyAvailable ? rawProvider : undefined;
    const model = provider && typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
    const endpoint = provider === "litellm" && typeof args.endpoint === "string" && args.endpoint.trim() ? args.endpoint.trim() : undefined;
    const apiKeyEnv = provider === "litellm" && typeof args.apiKeyEnv === "string" && args.apiKeyEnv.trim() ? args.apiKeyEnv.trim() : undefined;
    const targetWorkspace = typeof args.workspace === "string" && args.workspace.trim() ? path.resolve(args.workspace.trim()) : root;
    const instructions = typeof args.instructions === "string" && args.instructions.trim()
      ? args.instructions.trim()
      : defaultBotInstructions(role);
    try {
      const bot = await createBot(
        {
          name: botName,
          role,
          runtime,
          isolation,
          network,
          provider,
          model,
          endpoint,
          apiKeyEnv,
          workspace: targetWorkspace,
          instructions,
        },
        dataDir,
        { allowNewRoot: false, actor: "bot" },
      );
      return mcpToolResult({ ok: true, detail: JSON.stringify({ ok: true, bot }, null, 2) });
    } catch (error) {
      return mcpToolResult({ ok: false, detail: error instanceof Error ? error.message : "Could not create bot." });
    }
  }
  if (name === "bot_update") {
    const targetRef = typeof args.bot === "string" ? args.bot.trim() : typeof args.id === "string" ? args.id.trim() : "";
    const existing = targetRef ? await findBot(targetRef, dataDir, root) : undefined;
    if (!existing) return mcpToolResult({ ok: false, detail: `Bot not found: ${targetRef}` });
    const patch: Parameters<typeof updateBot>[1] = {};
    if (typeof args.name === "string" && args.name.trim()) patch.name = args.name.trim();
    if (typeof args.role === "string" && validBotRole(args.role)) patch.role = args.role;
    if (typeof args.runtime === "string" && validBotRuntime(args.runtime)) patch.runtime = args.runtime;
    if (args.isolation === "docker" || args.isolation === "host") {
      return mcpToolResult({ ok: false, detail: "A bot cannot change another bot's isolation. A human must set host isolation explicitly." });
    }
    if (typeof args.network === "string" && validBotNetworkMode(args.network)) patch.network = args.network;
    if (typeof args.provider === "string") patch.provider = validBotProvider(args.provider) ? args.provider : undefined;
    if (typeof args.model === "string") patch.model = args.model.trim() || undefined;
    if (typeof args.endpoint === "string") patch.endpoint = args.endpoint.trim() || undefined;
    if (typeof args.apiKeyEnv === "string") patch.apiKeyEnv = args.apiKeyEnv.trim() || undefined;
    if (typeof args.instructions === "string" && args.instructions.trim()) patch.instructions = args.instructions.trim();
    try {
      const bot = await updateBot(existing.id, patch, dataDir, { actor: "bot" });
      return mcpToolResult({ ok: true, detail: JSON.stringify({ ok: true, bot }, null, 2) });
    } catch (error) {
      return mcpToolResult({ ok: false, detail: error instanceof Error ? error.message : "Could not update bot." });
    }
  }
  if (name === "bot_delete") {
    const targetRef = typeof args.bot === "string" ? args.bot.trim() : typeof args.id === "string" ? args.id.trim() : typeof args.name === "string" ? args.name.trim() : "";
    const existing = targetRef ? await findBot(targetRef, dataDir, root) : undefined;
    if (!existing) return mcpToolResult({ ok: false, detail: `Bot not found: ${targetRef}` });
    try {
      await deleteBot(existing.id, dataDir);
      return mcpToolResult({ ok: true, detail: JSON.stringify({ ok: true, deleted: existing.name, id: existing.id }, null, 2) });
    } catch (error) {
      return mcpToolResult({ ok: false, detail: error instanceof Error ? error.message : "Could not delete bot." });
    }
  }
  if (name === "bot_delegate") {
    const targetRef = typeof args.bot === "string" ? args.bot.trim() : typeof args.botId === "string" ? args.botId.trim() : "";
    const delegatedPrompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    const reviewerRef = typeof args.reviewer === "string" ? args.reviewer.trim() : typeof args.reviewerBotId === "string" ? args.reviewerBotId.trim() : "";
    if (!targetRef || !delegatedPrompt) {
      return mcpToolResult({ ok: false, detail: "Both 'bot' and 'prompt' are required for bot_delegate." });
    }
    const targetBot = await findBot(targetRef, dataDir, root);
    if (!targetBot) return mcpToolResult({ ok: false, detail: `Target bot not found: ${targetRef}` });
    const reviewerBot = reviewerRef ? await findBot(reviewerRef, dataDir, root) : undefined;
    try {
      const task = await createTask(
        { botId: targetBot.id, prompt: delegatedPrompt, reviewerBotId: reviewerBot?.id },
        dataDir,
      );
      return mcpToolResult({
        ok: true,
        detail: JSON.stringify(
          {
            ok: true,
            queued: true,
            taskId: task.id,
            bot: targetBot.name,
            role: targetBot.role,
            reviewer: reviewerBot?.name,
            result: `Queued for ${targetBot.name}. The Lead can keep chatting; the product will run this task when the workspace is free.`,
          },
          null,
          2,
        ),
      });
    } catch (error) {
      return mcpToolResult({ ok: false, detail: error instanceof Error ? error.message : "Delegated bot execution failed." });
    }
  }

  if (name === "plan_submit") {
    const plan = typeof args.plan === "string" ? args.plan.trim() : "";
    const taskId = process.env.OCP_TASK_ID;
    if (!plan) return mcpToolResult({ ok: false, detail: "plan_submit requires a plan string." });
    if (!taskId) {
      acceptedPlans.add("ad-hoc");
      return mcpToolResult({ ok: true, detail: "Plan recorded for this MCP session (no parent task)." });
    }
    const allowed = await waitForRecordedApproval(
      taskId,
      {
        title: "Approve implementation plan?",
        description: plan.slice(0, 4000),
        subject: { kind: "plan", plan },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        ],
      },
      dataDir,
    );
    if (!allowed) return mcpToolResult({ ok: false, detail: "Plan was not approved. No files will be changed." });
    acceptedPlans.add(taskId);
    return mcpToolResult({ ok: true, detail: "Plan approved. You may edit files and run workspace_test." });
  }

  if (name === "workspace_shell") {
    const argv = Array.isArray(args.argv) ? args.argv.filter((item): item is string => typeof item === "string") : [];
    const ran = await runWorkspaceCommand(root, argv);
    return mcpToolResult({ ok: ran.ok, detail: JSON.stringify(ran, null, 2).slice(0, 16_000) });
  }
  if (name === "workspace_test") {
    const ran = await runWorkspaceTests(root);
    return mcpToolResult({ ok: ran.ok, detail: JSON.stringify(ran, null, 2).slice(0, 16_000) });
  }

  const pathArg = typeof args.path === "string" ? args.path : "";
  const taskId = process.env.OCP_TASK_ID;
  if (WRITE_TOOLS.has(name) && taskId && !acceptedPlans.has(taskId)) {
    return mcpToolResult({
      ok: false,
      detail: "Submit a plan with plan_submit and wait for human approval before editing files.",
    });
  }
  let result: { ok: boolean; detail: string };
  if (name === "workspace_list") {
    if (pathArg) await assertSafeWorkspacePath(root, pathArg, true);
    result = await listSandboxDir(root, pathArg || ".");
  } else if (name === "workspace_read") {
    await assertSafeWorkspacePath(root, pathArg, false);
    const info = await stat(path.resolve(root, pathArg)).catch(() => undefined);
    result = info && info.size > MAX_FILE_BYTES
      ? { ok: false, detail: "file is larger than the 500 KB workspace-tool limit" }
      : await readSandboxText(root, pathArg);
  } else if (name === "workspace_grep") {
    const searchPath = typeof args.path === "string" && args.path ? args.path : ".";
    await assertSafeWorkspacePath(root, searchPath, true);
    result = await grepSandbox(root, typeof args.query === "string" ? args.query : "", searchPath);
  } else if (name === "workspace_glob") {
    result = await globSandbox(root, typeof args.pattern === "string" ? args.pattern : "");
  } else if (name === "workspace_write") {
    const content = typeof args.content === "string" ? args.content : "";
    await assertSafeWorkspacePath(root, pathArg, false);
    const gate = securityGate({ relativePath: pathArg, content, sandboxRoot: root });
    if (content.length > MAX_FILE_BYTES) result = { ok: false, detail: "file is larger than the 500 KB workspace-tool limit" };
    else if (!gate.allow) result = { ok: false, detail: `blocked (${gate.reasons.join(", ")})` };
    else {
      const target = path.resolve(root, pathArg);
      try { await lstat(target); result = { ok: false, detail: "file already exists; use workspace_patch" }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(path.dirname(target), { recursive: true });
        await writeSandboxFile(root, pathArg, content);
        result = { ok: true, detail: "created" };
      }
    }
  } else if (name === "workspace_patch") {
    const diff = typeof args.diff === "string" ? args.diff : "";
    await assertSafeWorkspacePath(root, pathArg, false);
    if (diff.length > MAX_FILE_BYTES) return mcpToolResult({ ok: false, detail: "patch is larger than the 500 KB workspace-tool limit" });
    const target = path.resolve(root, pathArg);
    let source: string;
    try { source = await readFile(target, "utf8"); }
    catch { result = { ok: false, detail: "file missing or unreadable" }; return mcpToolResult(result); }
    const sourceGate = securityGate({ relativePath: pathArg, content: source, sandboxRoot: root });
    const updated = applyUnifiedDiff(source, diff);
    if (!sourceGate.allow) result = { ok: false, detail: `blocked (${sourceGate.reasons.join(", ")})` };
    else if (updated === null) result = { ok: false, detail: "patch context did not match" };
    else {
      const nextGate = securityGate({ relativePath: pathArg, content: updated, sandboxRoot: root });
      if (!nextGate.allow) result = { ok: false, detail: `blocked (${nextGate.reasons.join(", ")})` };
      else {
        await writeFile(target, updated, "utf8");
        result = { ok: true, detail: "patched" };
      }
    }
  } else if (name === "workspace_append") {
    const content = typeof args.content === "string" ? args.content : "";
    await assertSafeWorkspacePath(root, pathArg, false);
    const info = await stat(path.resolve(root, pathArg)).catch(() => undefined);
    result = content.length > MAX_FILE_BYTES || (info !== undefined && info.size + content.length > MAX_FILE_BYTES)
      ? { ok: false, detail: "appended text is larger than the 500 KB workspace-tool limit" }
      : await appendSandboxFile(root, pathArg, content);
  } else if (name === "workspace_delete") {
    await assertSafeWorkspacePath(root, pathArg, false);
    const info = await stat(path.resolve(root, pathArg)).catch(() => undefined);
    result = info && info.size > MAX_FILE_BYTES
      ? { ok: false, detail: "file is larger than the 500 KB workspace-tool limit" }
      : await deleteSandboxFile(root, pathArg);
  } else if (name === "workspace_rename" || name === "workspace_copy") {
    const from = typeof args.from === "string" ? args.from : "";
    const to = typeof args.to === "string" ? args.to : "";
    await assertSafeWorkspacePath(root, from, false);
    await assertSafeWorkspacePath(root, to, false);
    const info = await stat(path.resolve(root, from)).catch(() => undefined);
    result = info && info.size > MAX_FILE_BYTES
      ? { ok: false, detail: "source is larger than the 500 KB workspace-tool limit" }
      : name === "workspace_copy" ? await copySandboxFile(root, from, to) : await renameSandboxFile(root, from, to);
  } else if (name === "workspace_mkdir") {
    await assertSafeWorkspacePath(root, pathArg, false);
    result = await mkdirSandboxDir(root, pathArg);
  } else if (name === "workspace_rmdir") {
    await assertSafeWorkspacePath(root, pathArg, true);
    result = await rmdirSandboxDir(root, pathArg);
  } else throw new Error(`Unknown workspace tool: ${name}`);
  return mcpToolResult(result);
}

function mcpToolResult(result: { ok: boolean; detail: string }) {
  return { content: [{ type: "text", text: result.detail }], isError: !result.ok };
}

async function assertSafeWorkspacePath(root: string, relative: string, directory: boolean): Promise<void> {
  if (!relative || relative.includes("\0") || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw new Error("Workspace path must be relative.");
  const normalized = relative.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === ".ocp" || part === "gtm" || part === "..")) throw new Error("Workspace path is outside the available coding files.");
  const target = path.resolve(root, relative);
  const relativeTarget = path.relative(root, target);
  if (path.isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`)) throw new Error("Workspace path left the assigned directory.");
  let current = root;
  for (const part of relativeTarget.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Symbolic links are not available through workspace tools.");
      if (current !== target && !info.isDirectory()) throw new Error("A parent path is not a directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  if (directory) {
    try { if (!(await lstat(target)).isDirectory()) throw new Error("Workspace path is not a directory."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.argv[2];
  if (!workspace) {
    process.stderr.write("Workspace MCP server requires a workspace path.\n");
    process.exitCode = 2;
  } else {
    runWorkspaceMcp(workspace).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Workspace MCP server failed."}\n`);
      process.exitCode = 1;
    });
  }
}
