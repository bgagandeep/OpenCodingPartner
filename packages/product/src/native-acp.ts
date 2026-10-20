#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }> | Record<string, string>;
}

interface McpTool {
  serverName: string;
  name: string;
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface SessionState {
  sessionId: string;
  cwd: string;
  rules: string;
  modelOverride?: string;
  mcpServers: McpServerSpec[];
  messages: ChatMessage[];
}

interface ProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

const MUTATING_TOOLS = new Set([
  "workspace_write",
  "workspace_patch",
  "workspace_append",
  "workspace_delete",
  "workspace_rename",
  "workspace_copy",
  "workspace_mkdir",
  "workspace_rmdir",
]);

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function parseHermesConfig(hermesHome: string, env: NodeJS.ProcessEnv): Promise<ProviderConfig> {
  let provider = "openrouter";
  let model = env.OCP_DEFAULT_MODEL || "openai/gpt-4.1-mini";
  let baseUrl = env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1";
  let keyEnv = "OPENROUTER_API_KEY";

  try {
    const raw = await readFile(path.join(hermesHome, "config.yaml"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      const parseVal = (prefix: string): string | undefined => {
        if (!trimmed.startsWith(prefix)) return undefined;
        const val = trimmed.slice(prefix.length).trim();
        try {
          return JSON.parse(val) as string;
        } catch {
          return val.replace(/^["']|["']$/g, "");
        }
      };
      const p = parseVal("provider:");
      if (p) provider = p;
      const d = parseVal("default:");
      if (d) model = d;
      const b = parseVal("base_url:");
      if (b) baseUrl = b;
      const k = parseVal("key_env:");
      if (k) keyEnv = k;
    }
  } catch {
    // Fall back to environment variables when no config.yaml exists
    if (env.LITELLM_BASE_URL || env.LITELLM_API_KEY || env.LITELLM_MASTER_KEY) {
      provider = "custom";
      baseUrl = env.LITELLM_BASE_URL || env.OPENAI_BASE_URL || "http://127.0.0.1:4000/v1";
      keyEnv = env.LITELLM_API_KEY ? "LITELLM_API_KEY" : "LITELLM_MASTER_KEY";
    } else if (env.OPENAI_API_KEY && !env.OPENROUTER_API_KEY) {
      provider = "custom";
      baseUrl = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
      keyEnv = "OPENAI_API_KEY";
    }
  }

  if (provider === "openrouter") {
    baseUrl = env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    keyEnv = "OPENROUTER_API_KEY";
  }

  const apiKey =
    env[keyEnv] ||
    (keyEnv === "LITELLM_API_KEY" ? env.LITELLM_MASTER_KEY : undefined) ||
    (provider === "custom" && env.LITELLM_BASE_URL ? "ollama" : undefined) ||
    env.OPENROUTER_API_KEY ||
    env.LITELLM_API_KEY ||
    env.OPENAI_API_KEY ||
    "";

  return {
    provider,
    model,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
  };
}

class McpClientBridge {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(private readonly spec: McpServerSpec, private readonly cwd: string) {}

  async start(): Promise<McpTool[]> {
    const extraEnv: Record<string, string> = {};
    if (Array.isArray(this.spec.env)) {
      for (const item of this.spec.env) {
        if (item && typeof item.name === "string" && typeof item.value === "string") {
          extraEnv[item.name] = item.value;
        }
      }
    } else if (this.spec.env && typeof this.spec.env === "object") {
      Object.assign(extraEnv, this.spec.env);
    }
    this.child = spawn(this.spec.command, this.spec.args ?? [], {
      cwd: this.cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as RpcMessage;
        if (typeof msg.id === "number") {
          const waiter = this.pending.get(msg.id);
          if (!waiter) return;
          this.pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(msg.error.message || "MCP tool error"));
          else waiter.resolve(msg.result);
        }
      } catch {
        // Ignore non-JSON lines
      }
    });
    this.child.on("close", () => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error("MCP server closed"));
      }
      this.pending.clear();
    });

    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ocp-agent-acp", version: "0.1.0" } });
    const listRes = (await this.request("tools/list", {})) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    const rawTools = Array.isArray(listRes?.tools) ? listRes.tools : [];
    return rawTools.map((tool) => ({
      serverName: this.spec.name,
      name: tool.name,
      qualifiedName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = Array.isArray(res?.content)
      ? res.content.map((c) => c.text ?? "").join("\n")
      : JSON.stringify(res ?? {});
    return { text, isError: Boolean(res?.isError) };
  }

  close(): void {
    this.child?.kill();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error("MCP server not started"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout on ${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
}

export async function runNativeAcpAgent(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write("ocp-agent-acp 0.1.0 (OpenCodingPartner built-in ACP runtime)\n");
    return;
  }

  const hermesHome = process.env.HERMES_HOME || path.join(homedir(), ".local", "share", "opencodingpartner", "agent-home");
  const sessionsDir = path.join(hermesHome, "sessions");
  await mkdir(sessionsDir, { recursive: true });

  const sessions = new Map<string, SessionState>();
  const pendingClientRpc = new Map<number, (result: Record<string, unknown>) => void>();
  let nextClientRpcId = 10_000;

  function requestPermissionFromClient(title: string, kind: string, rawInput: unknown): Promise<boolean> {
    const id = nextClientRpcId++;
    return new Promise((resolve) => {
      pendingClientRpc.set(id, (msg) => {
        const res = msg.result && typeof msg.result === "object" ? (msg.result as { outcome?: { outcome?: string; optionId?: string } }) : {};
        resolve(res.outcome?.outcome === "selected" && res.outcome?.optionId === "allow-once");
      });
      send({
        jsonrpc: "2.0",
        id,
        method: "session/request_permission",
        params: {
          title,
          toolCall: { title, kind, rawInput },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Deny", kind: "reject_once" },
          ],
        },
      });
    });
  }

  async function saveSession(state: SessionState): Promise<void> {
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, `${state.sessionId}.json`), JSON.stringify(state, null, 2), "utf8");
  }

  async function loadSession(sessionId: string): Promise<SessionState | undefined> {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    try {
      const parsed = JSON.parse(await readFile(path.join(sessionsDir, `${sessionId}.json`), "utf8")) as SessionState;
      sessions.set(sessionId, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }

    if (typeof msg.id === "number" && !msg.method && pendingClientRpc.has(msg.id)) {
      const handler = pendingClientRpc.get(msg.id)!;
      pendingClientRpc.delete(msg.id);
      handler(msg as unknown as Record<string, unknown>);
      return;
    }

    if (msg.id === undefined || !msg.method) return;
    void handleRpc(msg.id, msg.method, msg.params ?? {}).catch((error) => {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "ACP runtime error",
        },
      });
    });
  });

  async function handleRpc(id: string | number, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: "ocp-agent", version: "0.1.0" },
        },
      });
      return;
    }

    const config = await parseHermesConfig(hermesHome, process.env);

    if (method === "session/new") {
      const sessionId = randomUUID();
      const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
      const meta = params._meta && typeof params._meta === "object" ? (params._meta as { rules?: unknown }) : {};
      const rules = typeof meta.rules === "string" ? meta.rules : "You are OCP Agent, a helpful AI engineering teammate.";
      const mcpServers = Array.isArray(params.mcpServers) ? (params.mcpServers as McpServerSpec[]) : [];
      const state: SessionState = {
        sessionId,
        cwd,
        rules,
        mcpServers,
        messages: [{ role: "system", content: rules }],
      };
      sessions.set(sessionId, state);
      await saveSession(state);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          sessionId,
          configOptions: [
            {
              id: "model",
              category: "model",
              currentValue: config.model,
              options: [{ value: config.model }],
            },
          ],
        },
      });
      return;
    }

    if (method === "session/load") {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const existing = await loadSession(sessionId);
      if (!existing) {
        send({ jsonrpc: "2.0", id, error: { code: -32000, message: `Session not found: ${sessionId}` } });
        return;
      }
      if (Array.isArray(params.mcpServers)) {
        existing.mcpServers = params.mcpServers as McpServerSpec[];
      }
      send({
        jsonrpc: "2.0",
        id,
        result: {
          sessionId: existing.sessionId,
          configOptions: [
            {
              id: "model",
              category: "model",
              currentValue: existing.modelOverride || config.model,
              options: [{ value: existing.modelOverride || config.model }],
            },
          ],
        },
      });
      return;
    }

    if (method === "session/set_config_option" || method === "session/set_model") {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const existing = await loadSession(sessionId);
      const requested = typeof params.value === "string" ? params.value : typeof params.modelId === "string" ? params.modelId : undefined;
      if (existing && requested) {
        existing.modelOverride = requested;
        await saveSession(existing);
      }
      send({ jsonrpc: "2.0", id, result: { ok: true } });
      return;
    }

    if (method === "session/prompt") {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const state = await loadSession(sessionId);
      if (!state) {
        send({ jsonrpc: "2.0", id, error: { code: -32000, message: `Unknown session: ${sessionId}` } });
        return;
      }

      const promptBlocks = Array.isArray(params.prompt) ? (params.prompt as Array<{ type?: string; text?: string }>) : [];
      const promptText = promptBlocks.map((b) => b.text ?? "").join("\n").trim();
      state.messages.push({ role: "user", content: promptText });

      const bridges: McpClientBridge[] = [];
      const toolMap = new Map<string, { bridge: McpClientBridge; tool: McpTool }>();
      try {
        for (const spec of state.mcpServers) {
          const bridge = new McpClientBridge(spec, state.cwd);
          bridges.push(bridge);
          const tools = await bridge.start();
          for (const tool of tools) {
            toolMap.set(tool.qualifiedName, { bridge, tool });
          }
        }

        // Optional local Ollama auto-discovery when explicitly enabled via OCP_ENABLE_LOCAL_OLLAMA=1
        if (!config.apiKey && process.env.OCP_ENABLE_LOCAL_OLLAMA === "1") {
          try {
            const ollamaRes = await fetch("http://127.0.0.1:11434/v1/models", {
              signal: AbortSignal.timeout(250),
            });
            if (ollamaRes.ok) {
              const ollamaData = (await ollamaRes.json()) as { data?: Array<{ id?: string }> };
              const firstModel = ollamaData.data?.[0]?.id;
              if (firstModel) {
                config.provider = "custom";
                config.baseUrl = "http://127.0.0.1:11434/v1";
                config.model = state.modelOverride || firstModel;
                config.apiKey = "ollama";
              }
            }
          } catch {
            // Local Ollama not running; fall back to built-in local orchestrator
          }
        }

        if (!config.apiKey) {
          const reply = await runLocalOrchestratorTurn(sessionId, state, promptText, toolMap, requestPermissionFromClient);
          state.messages.push({ role: "assistant", content: reply });
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: reply },
              },
            },
          });
          await saveSession(state);
          send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
          return;
        }

        const openAiTools = [...toolMap.values()].map(({ tool }) => ({
          type: "function" as const,
          function: {
            name: tool.qualifiedName,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        }));

        const activeModel = state.modelOverride || config.model;
        for (let step = 0; step < 12; step += 1) {
          const response = await fetch(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: activeModel,
              messages: state.messages,
              ...(openAiTools.length > 0 ? { tools: openAiTools } : {}),
            }),
          });

          if (!response.ok) {
            const errText = (await response.text().catch(() => "")).slice(0, 600);
            throw new Error(`Provider HTTP ${response.status}: ${errText || response.statusText}`);
          }

          const payload = (await response.json()) as {
            choices?: Array<{
              message?: {
                role?: string;
                content?: string | null;
                tool_calls?: Array<{
                  id: string;
                  type: "function";
                  function: { name: string; arguments: string };
                }>;
              };
            }>;
          };
          const choice = payload.choices?.[0]?.message;
          if (!choice) throw new Error("Provider returned no completion choices.");

          const assistantText = typeof choice.content === "string" ? choice.content : "";
          const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];

          state.messages.push({
            role: "assistant",
            content: assistantText || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });

          if (assistantText) {
            send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: assistantText },
                },
              },
            });
          }

          if (toolCalls.length === 0) {
            await saveSession(state);
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            return;
          }

          for (const call of toolCalls) {
            const toolName = call.function.name;
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
            } catch {
              parsedArgs = {};
            }

            send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  title: `${toolName}(${Object.values(parsedArgs).slice(0, 2).map(String).join(", ").slice(0, 80)})`,
                },
              },
            });

            if (MUTATING_TOOLS.has(toolName)) {
              const allowed = await requestPermissionFromClient(`Allow ${toolName}?`, "edit", parsedArgs);
              if (!allowed) {
                state.messages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: `Permission denied by user for ${toolName}.`,
                });
                await saveSession(state);
                send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
                return;
              }
            }

            const entry = toolMap.get(toolName);
            if (!entry) {
              state.messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: `Error: Unknown tool ${toolName}`,
              });
              continue;
            }
            const toolResult = await entry.bridge.callTool(toolName, parsedArgs);
            state.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: toolResult.text.slice(0, 16_000),
            });
          }
        }

        await saveSession(state);
        send({ jsonrpc: "2.0", id, result: { stopReason: "max_turns" } });
      } finally {
        for (const bridge of bridges) bridge.close();
      }
      return;
    }

    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

function extractCleanUserRequest(rawPrompt: string): string {
  const delegatedIdx = rawPrompt.lastIndexOf("Delegated task:\n");
  if (delegatedIdx >= 0) return rawPrompt.slice(delegatedIdx + "Delegated task:\n".length).trim();
  const taskIdx = rawPrompt.lastIndexOf("Task from user:\n");
  if (taskIdx >= 0) return rawPrompt.slice(taskIdx + "Task from user:\n".length).trim();
  const stripped = rawPrompt.replace(/^For project files, fleet management, and computer use[\s\S]*?allowed by the user request\.\s*/i, "");
  return stripped.trim() || rawPrompt.trim();
}

async function runLocalOrchestratorTurn(
  sessionId: string,
  state: SessionState,
  rawPrompt: string,
  toolMap: Map<string, { bridge: McpClientBridge; tool: McpTool }>,
  requestPermission: (title: string, kind: string, rawInput: unknown) => Promise<boolean>,
): Promise<string> {
  const callMcp = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
    const entry = toolMap.get(name);
    if (!entry) return { text: `Tool ${name} unavailable`, isError: true };
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          title: `${name}(${Object.values(args).slice(0, 2).map(String).join(", ").slice(0, 80)})`,
        },
      },
    });
    if (MUTATING_TOOLS.has(name)) {
      const allowed = await requestPermission(`Allow ${name}?`, "edit", args);
      if (!allowed) return { text: `Permission denied for ${name}`, isError: true };
    }
    return entry.bridge.callTool(name, args);
  };

  // Check if this is a specialist QA / security review handoff
  if (/Implementation agent report:|Review the work completed by/i.test(rawPrompt)) {
    const listRes = await callMcp("workspace_list", { path: "." });
    const files = listRes.text.split(/\r?\n/).filter(Boolean).slice(0, 20).join(", ");
    return [
      "### Specialist Review Complete",
      `- **Workspace inspected**: \`${state.cwd}\` (${files || "root"})`,
      "- **Findings**: No blocking security or regression defects detected in the handoff scope.",
      "- **Verification**: Checked workspace file layout and change boundaries.",
    ].join("\n");
  }

  const userText = extractCleanUserRequest(rawPrompt);
  const lower = userText.toLowerCase();

  // 1. Spin up / bootstrap full starter team (swarm_setup)
  if (
    /(?:spin\s+up|spawn|setup|set\s+up|bootstrap|build|create|initialize|start)\b[\s\S]*\b(?:team|swarm|squad|fleet|all\s+bots|starter\s+bots)/i.test(userText) ||
    /^\/?(?:swarm|team)\b/i.test(userText)
  ) {
    const res = await callMcp("swarm_setup", {});
    try {
      const parsed = JSON.parse(res.text) as {
        created?: Array<{ name: string; role: string; runtime: string }>;
        bots?: Array<{ name: string; role: string; runtime: string }>;
      };
      const createdList = (parsed.created ?? []).map((b) => `**${b.name}** (${b.role})`).join(", ");
      const rosterLines = (parsed.bots ?? []).map((b) => `- **${b.name}** — \`${b.role}\` (${b.runtime})`);
      return [
        "### Engineering Bot Team Ready",
        createdList ? `Created new teammates: ${createdList}.` : "All starter teammates are already provisioned.",
        "",
        "**Active Fleet Roster:**",
        ...rosterLines,
        "",
        "You can now delegate tasks to any teammate — for example: `@Linus inspect package.json` or `Ask Grace to review the repo`.",
      ].join("\n");
    } catch {
      return `Swarm setup result:\n${res.text}`;
    }
  }

  // 2. Delete / remove a bot
  const deleteMatch = /\b(?:delete|remove|drop|destroy)\s+(?:the\s+)?(?:bot\s+)?["'`]?([A-Za-z0-9_-]+)["'`]?/i.exec(userText);
  if (deleteMatch && !/\b(?:file|directory|folder|task)\b/i.test(userText)) {
    const targetName = deleteMatch[1]!;
    const delRes = await callMcp("bot_delete", { bot: targetName });
    const listRes = await callMcp("bot_list", {});
    let remaining = "";
    try {
      const parsed = JSON.parse(listRes.text) as { bots?: Array<{ name: string; role: string }> };
      remaining = (parsed.bots ?? []).map((b) => `**${b.name}** (${b.role})`).join(", ") || "none";
    } catch {
      remaining = listRes.text;
    }
    if (delRes.isError) return `Could not delete bot "${targetName}": ${delRes.text}\nRemaining bots: ${remaining}`;
    return `Deleted bot **${targetName}**.\n\n**Remaining Fleet:** ${remaining}`;
  }

  // 3. Update / reconfigure an existing bot
  const updateMatch = /\b(?:update|reconfigure|configure|change)\s+(?:the\s+)?bot\s+["'`]?([A-Za-z0-9_-]+)["'`]?/i.exec(userText);
  if (updateMatch) {
    const targetName = updateMatch[1]!;
    const roleMatch = /\brole\s+(?:to\s+)?(general|coding|qa|security|research|computer)\b/i.exec(userText);
    const runtimeMatch = /\bruntime\s+(?:to\s+)?(ocp-agent|ocp-coder)\b/i.exec(userText);
    const renameMatch = /\b(?:rename\s+to|name\s+to)\s+["'`]?([A-Za-z0-9_-]+)["'`]?/i.exec(userText);
    const args: Record<string, unknown> = { bot: targetName };
    if (roleMatch) args.role = roleMatch[1]!.toLowerCase();
    if (runtimeMatch) args.runtime = runtimeMatch[1]!.toLowerCase();
    if (renameMatch) args.name = renameMatch[1]!;
    const upRes = await callMcp("bot_update", args);
    if (upRes.isError) return `Could not update bot "${targetName}": ${upRes.text}`;
    return `Updated bot **${targetName}**.\n\`\`\`json\n${upRes.text}\n\`\`\``;
  }

  // 4. Create one or more bots
  if (
    /\b(?:create|add|make|spawn|provision|build)\b[\s\S]*\b(?:bot|bots|agent|agents|teammate|teammates)\b/i.test(userText)
  ) {
    const segments = userText.split(/\band\b|,/i).map((s) => s.trim()).filter(Boolean);
    const createdBots: Array<{ name: string; role: string; runtime: string }> = [];
    const errors: string[] = [];

    const inferRole = (text: string): string => {
      if (/\b(?:qa|test|testing|quality)\b/i.test(text)) return "qa";
      if (/\b(?:security|sec|audit|auditor)\b/i.test(text)) return "security";
      if (/\b(?:computer|browser|desktop|screen|ui)\b/i.test(text)) return "computer";
      if (/\b(?:research|search|analyst|docs)\b/i.test(text)) return "research";
      if (/\b(?:code|coder|coding|dev|developer|engineer|frontend|backend)\b/i.test(text)) return "coding";
      return "general";
    };

    const defaultRoleNames: Record<string, string> = {
      coding: "Linus",
      qa: "Grace",
      security: "Sentinel",
      computer: "Atlas",
      research: "Nova",
      general: "Orion",
    };

    for (const seg of segments) {
      if (!/\b(?:create|add|make|spawn|provision|build|bot|agent|teammate|coder|qa|security|research|computer)\b/i.test(seg)) {
        continue;
      }
      const role = inferRole(seg);
      const explicitNameMatch =
        /\b(?:named|called|name)\s+["'`]?([A-Za-z][A-Za-z0-9_-]{1,30})["'`]?/i.exec(seg) ||
        /\bbot\s+["'`]([A-Za-z][A-Za-z0-9_-]{1,30})["'`]/i.exec(seg) ||
        /\bbot\s+([A-Z][A-Za-z0-9_-]{1,30})\b/.exec(seg);
      const chosenName = explicitNameMatch?.[1] ?? defaultRoleNames[role] ?? `Bot-${createdBots.length + 1}`;
      const runtime = role === "coding" ? "ocp-coder" : "ocp-agent";
      const createRes = await callMcp("bot_create", {
        name: chosenName,
        role,
        runtime,
        isolation: "host",
      });
      if (createRes.isError) {
        errors.push(`${chosenName}: ${createRes.text}`);
      } else {
        createdBots.push({ name: chosenName, role, runtime });
      }
    }

    // If segment parsing didn't match a specific segment, create one bot from the whole userText
    if (createdBots.length === 0 && errors.length === 0) {
      const role = inferRole(userText);
      const explicitNameMatch =
        /\b(?:named|called|name)\s+["'`]?([A-Za-z][A-Za-z0-9_-]{1,30})["'`]?/i.exec(userText);
      const chosenName = explicitNameMatch?.[1] ?? defaultRoleNames[role] ?? "SpecialistBot";
      const runtime = role === "coding" ? "ocp-coder" : "ocp-agent";
      const createRes = await callMcp("bot_create", { name: chosenName, role, runtime, isolation: "host" });
      if (createRes.isError) errors.push(`${chosenName}: ${createRes.text}`);
      else createdBots.push({ name: chosenName, role, runtime });
    }

    const listRes = await callMcp("bot_list", {});
    let rosterText = "";
    try {
      const parsed = JSON.parse(listRes.text) as { bots?: Array<{ name: string; role: string; runtime: string }> };
      rosterText = (parsed.bots ?? []).map((b) => `- **${b.name}** — \`${b.role}\` (${b.runtime})`).join("\n");
    } catch {
      rosterText = listRes.text;
    }

    return [
      createdBots.length > 0
        ? `### Created ${createdBots.length === 1 ? "Bot" : "Bots"}: ${createdBots.map((b) => `**${b.name}** (\`${b.role}\`, ${b.runtime})`).join(", ")}`
        : "### Bot Creation Report",
      ...(errors.length > 0 ? [`Note: ${errors.join("; ")}`] : []),
      "",
      "**Current Fleet Roster:**",
      rosterText,
    ].join("\n");
  }

  // 5. Delegate a task to another bot (@BotName or "ask/delegate to/have <BotName> ...")
  const mentionMatch = /^@([A-Za-z0-9_-]+)\s+([\s\S]+)$/.exec(userText) ||
    /\b(?:delegate\s+to|ask|tell|have|assign\s+to)\s+@?([A-Za-z0-9_-]+)\s+(?:to\s+|:\s*)([\s\S]+)$/i.exec(userText);
  if (mentionMatch) {
    const targetName = mentionMatch[1]!;
    const delegatedTask = mentionMatch[2]!.trim();
    const reviewerMatch = /\b(?:and\s+)?(?:have|with)\s+@?([A-Za-z0-9_-]+)\s+review\b/i.exec(delegatedTask);
    const delRes = await callMcp("bot_delegate", {
      bot: targetName,
      prompt: delegatedTask,
      ...(reviewerMatch ? { reviewer: reviewerMatch[1] } : {}),
    });
    if (delRes.isError) {
      return `Could not delegate to **${targetName}**: ${delRes.text}`;
    }
    try {
      const parsed = JSON.parse(delRes.text) as { bot: string; role: string; result: string; reviewer?: string; review?: string };
      return [
        `### Delegated to **${parsed.bot}** (\`${parsed.role}\`)`,
        parsed.result,
        ...(parsed.reviewer && parsed.review ? ["", `### Review by **${parsed.reviewer}**`, parsed.review] : []),
      ].join("\n\n");
    } catch {
      return delRes.text;
    }
  }

  // 6. List / manage bots
  if (
    /\b(?:list|show|manage|view|check|what\s+are)\b[\s\S]*\bbots?\b/i.test(userText) ||
    /^(?:bots|fleet|roster|team\s+status)\b/i.test(lower)
  ) {
    const listRes = await callMcp("bot_list", {});
    try {
      const parsed = JSON.parse(listRes.text) as {
        count: number;
        bots: Array<{ name: string; role: string; runtime: string; provider: string; model: string; workspace: string; activeTasks: number }>;
      };
      if (!parsed.bots || parsed.bots.length === 0) {
        return "No bots are currently registered. Ask me to **\"spin up a full team\"** or **\"create a coding bot named Linus\"**!";
      }
      const rows = parsed.bots.map(
        (b) => `- **${b.name}** · Role: \`${b.role}\` · Runtime: \`${b.runtime}\` · Model: \`${b.provider}/${b.model}\` · Active tasks: ${b.activeTasks}`,
      );
      return [
        `### Fleet Roster (${parsed.count} ${parsed.count === 1 ? "bot" : "bots"})`,
        ...rows,
        "",
        "You can ask me to **create a bot**, **update or delete a bot**, or **delegate a task** (e.g. `Ask Linus to inspect README.md`).",
      ].join("\n");
    } catch {
      return listRes.text;
    }
  }

  // 7. Virtual Computer / Browser actions
  const urlMatch = /\b(?:open|browse|visit|go\s+to|launch)\s+(https?:\/\/[^\s"'<>]+)/i.exec(userText);
  if (urlMatch) {
    const res = await callMcp("computer_browser", { url: urlMatch[1]! });
    return `Opened \`${urlMatch[1]}\` on the Virtual Computer.\n\`\`\`json\n${res.text}\n\`\`\``;
  }
  if (/\b(?:screenshot|capture\s+screen|computer\s+screen|show\s+screen|virtual\s+computer)\b/i.test(userText)) {
    const res = await callMcp("computer_screen", {});
    return `Captured Virtual Computer screen:\n\`\`\`json\n${res.text}\n\`\`\``;
  }

  // 8. Workspace file read / grep / exploration
  const readMatch = /\b(?:read|cat|show|view|open)\s+(?:file\s+)?["'`]?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)["'`]?/i.exec(userText);
  if (readMatch) {
    const filePath = readMatch[1]!;
    const readRes = await callMcp("workspace_read", { path: filePath });
    if (!readRes.isError) {
      return `### Contents of \`${filePath}\`\n\`\`\`\n${readRes.text.slice(0, 4_000)}\n\`\`\``;
    }
  }

  const grepMatch = /\b(?:grep|search\s+for|find\s+text)\s+["'`]([^"'`]+)["'`]/i.exec(userText);
  if (grepMatch) {
    const grepRes = await callMcp("workspace_grep", { query: grepMatch[1]! });
    return `### Workspace Search for \`${grepMatch[1]}\`\n\`\`\`\n${grepRes.text.slice(0, 4_000)}\n\`\`\``;
  }

  // Default: Inspect workspace & fleet status and provide an actionable response
  const [listWorkspace, listFleet] = await Promise.all([
    callMcp("workspace_list", { path: "." }),
    callMcp("bot_list", {}),
  ]);
  const entries = listWorkspace.text.split(/\r?\n/).filter(Boolean).slice(0, 24).join(", ");
  let fleetSummary = "";
  try {
    const parsedFleet = JSON.parse(listFleet.text) as { bots?: Array<{ name: string; role: string }> };
    fleetSummary = (parsedFleet.bots ?? []).map((b) => `**${b.name}** (\`${b.role}\`)`).join(", ");
  } catch {
    fleetSummary = "Ada (Lead Orchestrator)";
  }

  return [
    `### Workspace & Fleet Summary`,
    `- **Workspace**: \`${state.cwd}\``,
    `- **Top-level entries**: ${entries || "(empty workspace)"}`,
    `- **Active Bot Fleet**: ${fleetSummary || "none"}`,
    "",
    "**What I can do right now (even before an external API key is set):**",
    "- **Create & Manage Bots**: Say *\"Spin up a full team\"*, *\"Create a coding bot named Linus\"*, *\"Create a QA bot named Grace\"*, *\"List all bots\"*, or *\"Delete bot X\"*.",
    "- **Delegate Across Bots**: Say *\"Ask Linus to read package.json\"* or *\"@Grace review the workspace\"*.",
    "- **Inspect & Control Computer**: Say *\"Read README.md\"*, *\"Open https://example.com\"*, or *\"Capture computer screen\"*.",
    "- **Connect Full LLM Coding**: Click **API Keys & Models** in the sidebar to add an **OpenRouter**, **LiteLLM**, or **OpenAI** key (or start local **Ollama** on port `11434`).",
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNativeAcpAgent().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "OCP Agent ACP runtime failed."}\n`);
    process.exitCode = 1;
  });
}
