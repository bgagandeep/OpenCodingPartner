#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveAction } from "./action-rules.js";
import { externalToolNeedsApproval } from "./connectors.js";
import { appendProductHandoff } from "./index.js";
import { vaultFillInvocation } from "./vault.js";
import { accountToolNeedsApproval, accountWriteTool } from "./accounts.js";
import { listHttpMcpTools, type HttpMcpEndpoint } from "./http-mcp.js";
import { formatPins, splitRecent, summarizeTurns, takePins, type PinnedNotes } from "./context.js";
import { layoutCachedPrompt } from "./prompt-cache.js";
import { retrieveWorkspaceSnippets } from "./retrieval.js";
import { recentTokenBudget } from "./provider-presets.js";
import { classifyPrompt, formatRouteUsage, nextRouteStep, parseRouteLabel, selectStepModel, type RouteStep } from "./routing.js";
import {
  forgetToolResponses,
  isCacheableTool,
  lookupResponse,
  modelCacheKey,
  modelResponseIsCacheable,
  storeResponse,
  toolCacheKey,
  type ResponseCacheEntry,
} from "./response-cache.js";
import { presentToolOutput, toolOutputDataDir } from "./tool-trim.js";
import type { ReadStamp } from "./tool-trim.js";
import { BIG_TASK_ESTIMATED_TOKENS, budgetDecision, projectSpend, spentTotals } from "./budget.js";
import { noteModelUsage, readUsageCalls, readUsagePolicy, usageCapReason, usageProviderKind } from "./usage.js";

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
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }> | Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
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
  summary?: string;
  foldedCount?: number;
  pinned?: PinnedNotes;
  reads?: ReadStamp[];
  responseCache?: ResponseCacheEntry[];
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
  "bot_create",
  "bot_update",
  "bot_delete",
  "bot_delegate",
  "swarm_setup",
  "computer_mouse",
  "computer_keyboard",
  "computer_browser",
  "vault_fill",
  "workspace_shell",
  "workspace_test",
]);

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function parseHermesConfig(hermesHome: string, env: NodeJS.ProcessEnv): Promise<ProviderConfig> {
  let provider = "openrouter";
  let model = env.OCP_DEFAULT_MODEL || "";
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
    if (this.spec.url) {
      const endpoint: HttpMcpEndpoint = { name: this.spec.name, url: this.spec.url, headers: this.spec.headers };
      const tools = await listHttpMcpTools(endpoint);
      return tools.map((tool) => ({
        serverName: this.spec.name,
        name: tool.name,
        qualifiedName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    }
    if (!this.spec.command) throw new Error(`MCP server "${this.spec.name}" has no command or URL.`);
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

  function requestPermissionFromClient(title: string, kind: string, rawInput: unknown, allowContinue = true): Promise<boolean> {
    const id = nextClientRpcId++;
    const options = allowContinue
      ? [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        ]
      : [{ optionId: "reject-once", name: "Leave paused", kind: "reject_once" }];
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
          options,
        },
      });
    });
  }

  function sessionForDisk(state: SessionState): SessionState {
    return {
      ...state,
      mcpServers: state.mcpServers.map((spec) => ({
        name: spec.name,
        command: spec.command,
        args: spec.args,
        url: spec.url,
      })),
    };
  }

  async function saveSession(state: SessionState): Promise<void> {
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, `${state.sessionId}.json`), JSON.stringify(sessionForDisk(state), null, 2), "utf8");
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
        pinned: { facts: [], decisions: [], todos: [] },
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
      const pinnedTurn = takePins(promptText, state.pinned ?? { facts: [], decisions: [], todos: [] });
      state.pinned = pinnedTurn.pinned;
      state.messages.push({ role: "user", content: pinnedTurn.text || promptText });

      const bridges: McpClientBridge[] = [];
      const toolMap = new Map<string, { bridge: McpClientBridge; tool: McpTool }>();
      try {
        for (const spec of state.mcpServers) {
          const bridge = new McpClientBridge(spec, state.cwd);
          bridges.push(bridge);
          const tools = await bridge.start();
          if (spec.url) continue;
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
          const reply = [
            "No model is configured.",
            "OCP will not guess actions from keywords, create or delete bots, or write files while offline.",
            "Configure a provider in Settings (OpenRouter, a local OpenAI-compatible endpoint such as Ollama/LM Studio/vLLM, or a custom base URL) and try again.",
          ].join(" ");
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
        const routeMode = process.env.OCP_ROUTE_MODE === "cheap" || process.env.OCP_ROUTE_MODE === "strong" ? process.env.OCP_ROUTE_MODE : "auto";
        const cheapModel = process.env.OCP_CHEAP_MODEL?.trim() || undefined;
        const localProvider = usageProviderKind(config.provider, config.baseUrl) === "local";
        const choiceFor = (step: RouteStep) => selectStepModel({
          step,
          mode: routeMode,
          strongModel: activeModel,
          cheapModel: step === "summary" ? process.env.OCP_SUMMARY_MODEL?.trim() || cheapModel : cheapModel,
          local: localProvider,
        });
        let usageContinued = false;
        const recordStep = async (input: {
          model: string;
          step: RouteStep;
          tier: "cheap" | "strong";
          routeFallback: boolean;
          usage: unknown;
          promptText: string;
          completionText: string;
          sessionCache?: boolean;
        }): Promise<void> => {
          if (!process.env.OCP_DATA_DIR || !process.env.OCP_ACTOR_BOT_ID) return;
          const recorded = await noteModelUsage(process.env.OCP_DATA_DIR, {
            botId: process.env.OCP_ACTOR_BOT_ID,
            taskId: process.env.OCP_TASK_ID,
            model: input.model,
            provider: config.provider,
            baseUrl: config.baseUrl,
            usage: input.usage,
            promptText: input.promptText,
            completionText: input.completionText,
            step: input.step,
            tier: input.tier,
            routeFallback: input.routeFallback,
            sessionCache: input.sessionCache,
          });
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "usage",
                title: formatRouteUsage({
                  step: input.step,
                  tier: input.tier,
                  fallback: input.routeFallback,
                  model: recorded.model,
                  promptTokens: recorded.promptTokens,
                  completionTokens: recorded.completionTokens,
                  estimated: recorded.estimated,
                  costUsd: recorded.costUsd,
                  costBasis: recorded.costBasis,
                }),
              },
            },
          });
        };
        const takeModel = async (input: {
          model: string;
          messages: unknown;
          toolNames: string[];
          tools?: typeof openAiTools;
        }): Promise<{ message: ChatMessage; usage: unknown; sessionCache: boolean }> => {
          const key = modelCacheKey(input.model, input.messages, input.toolNames);
          const hit = lookupResponse(state.responseCache, "model", key);
          if (hit) {
            try {
              const message = JSON.parse(hit) as ChatMessage;
              if (message?.role === "assistant") return { message, usage: undefined, sessionCache: true };
            } catch {
              // A corrupt entry is a miss. The provider call below replaces it when the result is cacheable.
            }
          }
          const response = await fetch(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: input.model,
              messages: input.messages,
              ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
            }),
          });
          if (!response.ok) {
            const errText = (await response.text().catch(() => "")).slice(0, 600);
            throw new Error(`Provider HTTP ${response.status}: ${errText || response.statusText}`);
          }
          const payload = (await response.json()) as {
            choices?: Array<{ message?: ChatMessage }>;
            usage?: unknown;
          };
          const choice = payload.choices?.[0]?.message;
          if (!choice) throw new Error("Provider returned no completion choices.");
          const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
          const message: ChatMessage = {
            role: "assistant",
            content: typeof choice.content === "string" ? choice.content : null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          };
          if (modelResponseIsCacheable(toolCalls.map((call) => call.function.name))) {
            state.responseCache = storeResponse(state.responseCache, "model", key, JSON.stringify(message));
          }
          return { message, usage: payload.usage, sessionCache: false };
        };
        let retrievalFor = "";
        let retrievalText = "";
        const messagesForModel = async (cacheModel: string) => {
          const rest = state.messages.slice(1);
          const budget = recentTokenBudget(config.provider, config.baseUrl);
          const { older, recent } = splitRecent(rest, budget);
          const start = Math.min(state.foldedCount ?? 0, older.length);
          const portion = older.slice(start).map((message) => ({ role: message.role, content: message.content ?? "" }));
          if (portion.length > 0) {
            const folded = await summarizeTurns(portion, state.summary ?? "", async (prompt) => {
              const summaryChoice = choiceFor("summary");
              const summaryConfigured = Boolean(process.env.OCP_SUMMARY_MODEL?.trim() || cheapModel || localProvider);
              if (!summaryConfigured || !config.apiKey) return undefined;
              try {
                const summaryMessages = [{ role: "user", content: prompt }];
                const taken = await takeModel({ model: summaryChoice.model, messages: summaryMessages, toolNames: [] });
                const text = taken.message.content;
                await recordStep({
                  model: summaryChoice.model,
                  step: "summary",
                  tier: summaryChoice.tier,
                  routeFallback: summaryChoice.fallback,
                  usage: taken.usage,
                  promptText: prompt,
                  completionText: typeof text === "string" ? text : "",
                  sessionCache: taken.sessionCache,
                }).catch(() => undefined);
                return typeof text === "string" ? text : undefined;
              } catch {
                return undefined;
              }
            });
            state.summary = folded.summary;
            state.foldedCount = older.length;
          }
          const pinText = formatPins(state.pinned ?? { facts: [], decisions: [], todos: [] });
          const latestUser = [...state.messages].reverse().find((message) => message.role === "user")?.content ?? "";
          if (latestUser.trim() && latestUser !== retrievalFor) {
            retrievalFor = latestUser;
            retrievalText = await retrieveWorkspaceSnippets({
              workspace: state.cwd,
              dataDir: process.env.OCP_DATA_DIR,
              query: latestUser,
            }).catch(() => "");
          }
          return layoutCachedPrompt({
            system: state.rules,
            toolIndex: openAiTools.map((tool) => tool.function.name).join("\n"),
            pinned: pinText,
            summary: state.summary ?? "",
            retrieved: retrievalText,
            recent,
            model: cacheModel,
          }).messages;
        };
        let routeStep: RouteStep = routeMode === "cheap" ? "answer" : "edit";
        let classified = false;
        let budgetChecked = false;
        const stopBeforeModel = async (reason: string): Promise<void> => {
          const reply = `${reason} No further model call was made.`;
          state.messages.push({ role: "assistant", content: reply });
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } },
          });
          await saveSession(state);
          send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
        };
        for (let turn = 0; turn < 12; turn += 1) {
          if (process.env.OCP_DATA_DIR && process.env.OCP_ACTOR_BOT_ID) {
            const policy = await readUsagePolicy(process.env.OCP_DATA_DIR);
            const calls = await readUsageCalls(process.env.OCP_DATA_DIR);
            const day = new Date().toISOString().slice(0, 10);
            const botId = process.env.OCP_ACTOR_BOT_ID;
            const projection = projectSpend({
              promptText: state.messages.map((message) => message.content ?? "").join("\n"),
              model: routeMode === "cheap" && cheapModel ? cheapModel : activeModel,
              provider: usageProviderKind(config.provider, config.baseUrl),
              prices: policy.prices,
            });
            const decision = budgetDecision({
              projection,
              includeProjection: !budgetChecked,
              scopes: [
                { name: "This bot", cap: policy.caps.perBot.find((item) => item.botId === botId), ...spentTotals(calls.filter((call) => call.botId === botId)) },
                { name: "Today", cap: policy.caps.perDay, ...spentTotals(calls.filter((call) => call.createdAt.slice(0, 10) === day)) },
              ],
            });
            if (!budgetChecked && (projection.estimatedInputTokens >= BIG_TASK_ESTIMATED_TOKENS || decision.stop !== "ok")) {
              send({
                jsonrpc: "2.0",
                method: "session/update",
                params: { sessionId, update: { sessionUpdate: "usage", title: `Projected cost: ${projection.label}` } },
              });
            }
            if (decision.stop === "hard" && decision.reason) {
              await requestPermissionFromClient(decision.reason, "usage-hard-cap", { reason: decision.reason }, false);
              await stopBeforeModel(decision.reason);
              return;
            }
            if (!budgetChecked && decision.stop === "soft" && decision.reason) {
              const allowed = await requestPermissionFromClient(decision.reason, "usage-cap", { reason: decision.reason });
              if (!allowed) {
                await stopBeforeModel(decision.reason);
                return;
              }
            }
            budgetChecked = true;
          }
          if (!usageContinued && process.env.OCP_DATA_DIR && process.env.OCP_ACTOR_BOT_ID) {
            const reason = await usageCapReason(process.env.OCP_DATA_DIR, process.env.OCP_ACTOR_BOT_ID);
            if (reason) {
              const allowed = await requestPermissionFromClient(reason, "usage-cap", { reason });
              if (!allowed) {
                await stopBeforeModel(reason);
                return;
              }
              usageContinued = true;
            }
          }
          if (!classified) {
            classified = true;
            const classifyChoice = choiceFor("classify");
            if (routeMode !== "strong" && classifyChoice.tier === "cheap" && !classifyChoice.fallback) {
              const latestUser = [...state.messages].reverse().find((message) => message.role === "user")?.content ?? "";
              try {
                const taken = await takeModel({
                  model: classifyChoice.model,
                  messages: [{ role: "user", content: classifyPrompt(latestUser) }],
                  toolNames: [],
                });
                const classifyText = taken.message.content ?? "";
                await recordStep({
                  model: classifyChoice.model,
                  step: "classify",
                  tier: classifyChoice.tier,
                  routeFallback: classifyChoice.fallback,
                  usage: taken.usage,
                  promptText: latestUser,
                  completionText: typeof classifyText === "string" ? classifyText : "",
                  sessionCache: taken.sessionCache,
                });
                routeStep = (typeof classifyText === "string" ? parseRouteLabel(classifyText) : undefined) ?? routeStep;
              } catch {
                routeStep = routeMode === "cheap" ? "answer" : "edit";
              }
            }
          }
          const routeChoice = choiceFor(routeStep);
          const modelMessages = await messagesForModel(routeChoice.model);
          const promptText = JSON.stringify(modelMessages);
          const toolNames = openAiTools.map((tool) => tool.function.name);
          const taken = await takeModel({
            model: routeChoice.model,
            messages: modelMessages,
            toolNames,
            tools: openAiTools,
          });
          const assistantText = typeof taken.message.content === "string" ? taken.message.content : "";
          const toolCalls = taken.message.tool_calls ?? [];
          await recordStep({
            model: routeChoice.model,
            step: routeStep,
            tier: routeChoice.tier,
            routeFallback: routeChoice.fallback,
            usage: taken.usage,
            promptText,
            completionText: assistantText || JSON.stringify(toolCalls),
            sessionCache: taken.sessionCache,
          });

          state.messages.push(taken.message);

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

          const usedTools: string[] = [];
          const usedTexts: string[] = [];
          for (const call of toolCalls) {
            const toolName = call.function.name;
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
            } catch {
              parsedArgs = {};
            }
            const vaultArgs = vaultFillInvocation(toolName, parsedArgs);
            if (vaultArgs) {
              parsedArgs = toolName === "tool_call" ? { name: "vault_fill", arguments: vaultArgs } : vaultArgs;
            }
            const accountGate = accountToolNeedsApproval(toolName, parsedArgs);
            const accountToolName = accountGate
              ? (toolName === "tool_call" && typeof parsedArgs.name === "string" ? parsedArgs.name : toolName)
              : "";

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

            const externalTarget = externalToolNeedsApproval(toolName, parsedArgs)
              ? (toolName === "tool_call" && typeof parsedArgs.name === "string" ? parsedArgs.name : toolName)
              : undefined;
            const actionName = vaultArgs ? "vault_fill" : accountToolName || externalTarget || toolName;
            const consequential = Boolean(vaultArgs || accountGate || MUTATING_TOOLS.has(toolName) || externalTarget);
            const mode = consequential
              ? await resolveAction(process.env.OCP_DATA_DIR, process.env.OCP_ACTOR_BOT_ID, actionName)
              : "perform";
            if (mode === "handoff") {
              if (process.env.OCP_DATA_DIR) {
                await appendProductHandoff({
                  ...(process.env.OCP_ACTOR_BOT_ID ? { botId: process.env.OCP_ACTOR_BOT_ID } : {}),
                  action: actionName,
                  summary: `${actionName} was not performed.`,
                }, process.env.OCP_DATA_DIR);
              }
              state.messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: `Handed off ${actionName}. A person needs to do this. It was not performed.`,
              });
              continue;
            }
            if (mode === "ask") {
              const allowed = await requestPermissionFromClient(
                vaultArgs ? "Allow vault_fill on the virtual computer keyboard?" : accountGate ? `Allow ${accountToolName} on the connected account?` : externalTarget ? `Allow external MCP tool ${externalTarget}?` : `Allow ${toolName}?`,
                vaultArgs ? "vault-fill" : accountGate ? "account" : externalTarget ? "external-mcp" : "edit",
                parsedArgs,
              );
              if (!allowed) {
                state.messages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: `Permission denied by user for ${externalTarget ?? toolName}.`,
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
            const cacheKey = toolCacheKey(toolName, parsedArgs);
            const cachedText = isCacheableTool(toolName) ? lookupResponse(state.responseCache, "tool", cacheKey) : undefined;
            let toolResult: { text: string; isError: boolean };
            if (cachedText !== undefined) {
              send({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId,
                  update: { sessionUpdate: "tool_call", title: `session cache hit: ${toolName}` },
                },
              });
              toolResult = { text: cachedText, isError: false };
            } else {
              toolResult = await entry.bridge.callTool(toolName, parsedArgs);
              if (isCacheableTool(toolName) && !toolResult.isError) {
                state.responseCache = storeResponse(state.responseCache, "tool", cacheKey, toolResult.text);
              }
            }
            if (MUTATING_TOOLS.has(toolName) || accountWriteTool(toolName) || accountWriteTool(accountToolName)) state.responseCache = forgetToolResponses(state.responseCache);
            let content = toolResult.text;
            if (toolName !== "tool_output_read") {
              const presented = await presentToolOutput({
                dataDir: toolOutputDataDir(process.env, hermesHome),
                toolName,
                args: parsedArgs,
                text: toolResult.text,
                reads: state.reads ?? [],
              });
              state.reads = presented.reads;
              content = presented.display;
            }
            const shown = content.length > 16_000 ? content.slice(0, 16_000) : content;
            usedTools.push(toolName);
            usedTexts.push(shown);
            state.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: shown,
            });
          }
          routeStep = nextRouteStep(routeStep, usedTools, usedTexts);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNativeAcpAgent().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "OCP Agent ACP runtime failed."}\n`);
    process.exitCode = 1;
  });
}
