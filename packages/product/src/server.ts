import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { readWorkspaceFile } from "./workspace-mcp.js";
import {
  applyProviderSettingsToEnv,
  bootstrapFleet,
  captureComputerScreen,
  computerKeyboard,
  computerMouse,
  computerOpenBrowser,
  createBot,
  deleteBot,
  defaultBotInstructions,
  captureWorkspaceBaseline,
  collectWorkspaceChanges,
  createTask,
  deleteTask,
  findBot,
  isOcpAgentRuntime,
  listBots,
  listTasks,
  missingProviderKey,
  productDataDir,
  readDesktopState,
  readProviderSettings,
  recordTaskApproval,
  recordTaskEvent,
  resolveRuntimeCommand,
  runBotSession,
  saveProviderSettings,
  setComputerControl,
  stopComputerDesktop,
  updateBotSession,
  updateBot,
  updateTask,
  validBotProvider,
  validBotRole,
  validBotRuntime,
  validBotNetworkMode,
  workspacePathsMatch,
  type KeyboardActionInput,
  type MouseActionInput,
  type PendingTaskApproval,
  type RuntimePermissionRequest,
} from "./index.js";

interface AppOptions {
  host?: string;
  port?: number;
  root?: string;
  env?: NodeJS.ProcessEnv;
}

interface ActiveRun {
  controller: AbortController;
  done?: Promise<void>;
}

interface ApprovalWaiter {
  taskId: string;
  optionId: string;
  resolve: (optionId: string | undefined) => void;
}

export async function startProductApp(options: AppOptions = {}): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const root = options.root ?? productDataDir(options.env);
  const env = options.env ?? process.env;
  if (!isLoopback(host)) throw new Error("The OpenCodingPartner app can only bind to a loopback address.");
  const token = randomBytes(32).toString("hex");
  const activeRuns = new Map<string, ActiveRun>();
  const approvalWaiters = new Map<string, ApprovalWaiter>();
  let boundPort = port;
  let closing = false;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (response.headersSent) return response.destroy();
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Request failed." });
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) {
      sendJson(response, 503, { error: "OpenCodingPartner is shutting down." });
      return;
    }
    const hostHeader = request.headers.host ?? "";
    if (!validHostHeader(hostHeader, boundPort) || !validOrigin(request.headers.origin, hostHeader)) {
      sendJson(response, 403, { error: "This local app only accepts requests from its loopback origin." });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${hostHeader}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'nonce-${token}'; style-src 'nonce-${token}'; base-uri 'none'; frame-ancestors 'none'`,
      });
      response.end(renderApp(token));
      return;
    }
    const computerGetMatch = /^\/api\/bots\/([^/]+)\/computer$/.exec(url.pathname);
    if (request.method === "GET" && computerGetMatch) {
      const bot = await findBot(computerGetMatch[1] ?? "", root);
      if (!bot) {
        sendJson(response, 404, { error: "Bot not found." });
        return;
      }
      const refresh = url.searchParams.get("refresh") === "1";
      if (refresh) {
        const snap = await captureComputerScreen(bot.workspace);
        sendJson(response, 200, snap);
        return;
      }
      const state = await readDesktopState(bot.workspace);
      const frameInfo = await stat(path.join(bot.workspace, "gtm", "last-frame.png")).catch(() => undefined);
      sendJson(response, 200, {
        ok: true,
        display: state.display,
        width: state.width,
        height: state.height,
        control: state.control,
        status: state.status,
        lastUrl: state.lastUrl,
        screenshot: "gtm/last-frame.png",
        frameMtimeMs: frameInfo?.mtimeMs,
      });
      return;
    }
    const computerFrameMatch = /^\/api\/bots\/([^/]+)\/computer\/frame$/.exec(url.pathname);
    if (request.method === "GET" && computerFrameMatch) {
      const bot = await findBot(computerFrameMatch[1] ?? "", root);
      if (!bot) {
        sendJson(response, 404, { error: "Bot not found." });
        return;
      }
      const framePath = path.join(bot.workspace, "gtm", "last-frame.png");
      let bytes = await readFile(framePath).catch(() => undefined);
      if (!bytes) {
        await captureComputerScreen(bot.workspace);
        bytes = await readFile(framePath).catch(() => undefined);
      }
      if (!bytes) {
        sendJson(response, 404, { error: "Computer screen frame unavailable." });
        return;
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(bytes);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      const [bots, tasks, settings] = await Promise.all([listBots(root), listTasks(root), readProviderSettings(root)]);
      const effectiveEnv = applyProviderSettingsToEnv(settings, env);
      sendJson(response, 200, {
        bots: bots.map((bot) => publicBot(bot, effectiveEnv)),
        tasks: tasks.map((task) => ({
          id: task.id,
          botId: task.botId,
          reviewerBotId: task.reviewerBotId,
          agents: task.agents,
          prompt: task.prompt,
          status: task.status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          events: task.events,
          approvals: task.approvals,
          result: task.result,
          error: task.error,
          workspaceChanges: task.workspaceChanges,
          pendingApproval: task.pendingApproval ? {
            id: task.pendingApproval.id,
            title: task.pendingApproval.title,
            description: task.pendingApproval.description,
            subject: task.pendingApproval.subject,
            requestedAt: task.pendingApproval.requestedAt,
          } : undefined,
        })),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      const settings = await readProviderSettings(root);
      const effectiveEnv = applyProviderSettingsToEnv(settings, env);
      sendJson(response, 200, {
        openrouterConfigured: Boolean(effectiveEnv.OPENROUTER_API_KEY),
        litellmConfigured: Boolean(effectiveEnv.LITELLM_API_KEY || effectiveEnv.LITELLM_MASTER_KEY),
        openaiConfigured: Boolean(effectiveEnv.OPENAI_API_KEY),
        litellmBaseUrl: settings.litellmBaseUrl || effectiveEnv.LITELLM_BASE_URL || "http://127.0.0.1:4000/v1",
        defaultModel: settings.defaultModel || effectiveEnv.OCP_DEFAULT_MODEL || "openai/gpt-4.1-mini",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/workspace/file") {
      const botId = url.searchParams.get("botId") ?? "";
      const relativePath = url.searchParams.get("path") ?? "";
      const bot = await findBot(botId, root);
      if (!bot) {
        sendJson(response, 404, { error: "Bot not found." });
        return;
      }
      const file = await readWorkspaceFile(bot.workspace, relativePath);
      sendJson(response, file.ok ? 200 : 400, file.ok ? { content: file.content } : { error: file.error });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      const settings = await readProviderSettings(root);
      const effectiveEnv = applyProviderSettingsToEnv(settings, env);
      const agentCmd = resolveRuntimeCommand(true, effectiveEnv);
      const coderCmd = resolveRuntimeCommand(false, effectiveEnv);
      const [ocpAgent, ocpCoder, docker] = await Promise.all([
        probe(agentCmd.command, agentCmd.fallback ? [agentCmd.args[0]!, "--version"] : ["--version"]),
        probe(coderCmd.command, coderCmd.fallback ? [coderCmd.args[0]!, "--version"] : ["--version"]),
        probe("docker", ["info", "--format", "{{.ServerVersion}}"]),
      ]);
      sendJson(response, 200, {
        ocpAgent,
        ocpCoder,
        hermes: ocpAgent,
        grokBuild: ocpCoder,
        docker,
        providerConfigured: Boolean(
          effectiveEnv.OPENROUTER_API_KEY ||
          effectiveEnv.LITELLM_API_KEY ||
          effectiveEnv.LITELLM_MASTER_KEY ||
          effectiveEnv.OPENAI_API_KEY,
        ),
      });
      return;
    }
    if (request.method !== "POST" && request.method !== "PATCH" && request.method !== "DELETE") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    if (request.headers["x-ocp-token"] !== token) {
      sendJson(response, 403, { error: "Missing local app token." });
      return;
    }
    const body = await readJson(request);
    if (closing) {
      sendJson(response, 503, { error: "OpenCodingPartner is shutting down." });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings") {
      const saved = await saveProviderSettings(
        {
          ...(typeof body.openrouterApiKey === "string" ? { openrouterApiKey: body.openrouterApiKey } : {}),
          ...(typeof body.litellmApiKey === "string" ? { litellmApiKey: body.litellmApiKey } : {}),
          ...(typeof body.litellmBaseUrl === "string" ? { litellmBaseUrl: body.litellmBaseUrl } : {}),
          ...(typeof body.openaiApiKey === "string" ? { openaiApiKey: body.openaiApiKey } : {}),
          ...(typeof body.defaultModel === "string" ? { defaultModel: body.defaultModel } : {}),
        },
        root,
      );
      const effectiveEnv = applyProviderSettingsToEnv(saved, env);
      sendJson(response, 200, {
        ok: true,
        openrouterConfigured: Boolean(effectiveEnv.OPENROUTER_API_KEY),
        litellmConfigured: Boolean(effectiveEnv.LITELLM_API_KEY || effectiveEnv.LITELLM_MASTER_KEY),
        openaiConfigured: Boolean(effectiveEnv.OPENAI_API_KEY),
        litellmBaseUrl: saved.litellmBaseUrl || effectiveEnv.LITELLM_BASE_URL || "http://127.0.0.1:4000/v1",
        defaultModel: saved.defaultModel || effectiveEnv.OCP_DEFAULT_MODEL || "openai/gpt-4.1-mini",
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/bootstrap") {
      const mode = body.mode === "team" ? "team" : "lead";
      const workspace = typeof body.workspace === "string" && body.workspace.trim() ? body.workspace.trim() : process.cwd();
      const settings = await readProviderSettings(root);
      const effectiveEnv = applyProviderSettingsToEnv(settings, env);
      const result = await bootstrapFleet(workspace, mode, root);
      sendJson(response, 200, {
        ok: true,
        created: result.created.map((bot) => publicBot(bot, effectiveEnv)),
        bots: result.bots.map((bot) => publicBot(bot, effectiveEnv)),
      });
      return;
    }
    const deleteTaskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && deleteTaskMatch) {
      try {
        await deleteTask(deleteTaskMatch[1] ?? "", root);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message : "Could not delete task." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/bots") {
      const saved = await saveBotFromRequest(body, root);
      if (!saved.bot) {
        sendJson(response, 400, { error: saved.error });
        return;
      }
      const effectiveEnv = applyProviderSettingsToEnv(await readProviderSettings(root), env);
      sendJson(response, 201, { bot: publicBot(saved.bot, effectiveEnv) });
      return;
    }
    const computerPostMatch = /^\/api\/bots\/([^/]+)\/computer$/.exec(url.pathname);
    if (request.method === "POST" && computerPostMatch) {
      const bot = await findBot(computerPostMatch[1] ?? "", root);
      if (!bot) {
        sendJson(response, 404, { error: "Bot not found." });
        return;
      }
      const kind = typeof body.kind === "string" ? body.kind : "screen";
      if (kind === "takeover" || kind === "return" || kind === "allow") {
        const res = await setComputerControl(bot.workspace, kind);
        sendJson(response, 200, res);
        return;
      }
      if (kind === "stop") {
        await stopComputerDesktop(bot.workspace);
        const state = await readDesktopState(bot.workspace);
        sendJson(response, 200, { ok: true, detail: "Stopped virtual computer processes.", ...state });
        return;
      }
      if (kind === "browser") {
        const targetUrl = typeof body.url === "string" ? body.url : "";
        const res = await computerOpenBrowser(bot.workspace, targetUrl, "human");
        sendJson(response, res.ok ? 200 : 400, res);
        return;
      }
      if (kind === "mouse") {
        const action = (typeof body.action === "string" ? body.action : "click") as MouseActionInput["action"];
        const res = await computerMouse(bot.workspace, {
          action,
          x: typeof body.x === "number" ? body.x : undefined,
          y: typeof body.y === "number" ? body.y : undefined,
          fromX: typeof body.fromX === "number" ? body.fromX : undefined,
          fromY: typeof body.fromY === "number" ? body.fromY : undefined,
          button: typeof body.button === "string" ? (body.button as MouseActionInput["button"]) : undefined,
          direction: typeof body.direction === "string" ? (body.direction as MouseActionInput["direction"]) : undefined,
          amount: typeof body.amount === "number" ? body.amount : undefined,
          actor: "human",
        });
        sendJson(response, res.ok ? 200 : 400, res);
        return;
      }
      if (kind === "keyboard") {
        const action = (typeof body.action === "string" ? body.action : "type") as KeyboardActionInput["action"];
        const res = await computerKeyboard(bot.workspace, {
          action,
          text: typeof body.text === "string" ? body.text : undefined,
          key: typeof body.key === "string" ? body.key : undefined,
          actor: "human",
        });
        sendJson(response, res.ok ? 200 : 400, res);
        return;
      }
      const res = await captureComputerScreen(bot.workspace);
      sendJson(response, 200, res);
      return;
    }
    const botMatch = /^\/api\/bots\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && botMatch) {
      try {
        await deleteBot(botMatch[1] ?? "", root);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message : "Could not delete bot." });
      }
      return;
    }
    if (request.method === "PATCH" && botMatch) {
      const saved = await saveBotFromRequest(body, root, botMatch[1]);
      if (!saved.bot) {
        sendJson(response, 400, { error: saved.error });
        return;
      }
      const effectiveEnv = applyProviderSettingsToEnv(await readProviderSettings(root), env);
      sendJson(response, 200, { bot: publicBot(saved.bot, effectiveEnv) });
      return;
    }
    if (url.pathname === "/api/tasks") {
      const botId = typeof body.botId === "string" ? body.botId : "";
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const reviewerBotId = typeof body.reviewerBotId === "string" && body.reviewerBotId ? body.reviewerBotId : undefined;
      const bot = await findBot(botId, root);
      if (!bot || !prompt || prompt.length > 20_000) {
        sendJson(response, 400, { error: "Choose a bot and enter a request of 1 to 20,000 characters." });
        return;
      }
      const reviewer = reviewerBotId ? await findBot(reviewerBotId, root) : undefined;
      if (reviewerBotId && (!reviewer || reviewer.id === bot.id || !["qa", "security"].includes(reviewer.role) || !(await workspacePathsMatch(reviewer.workspace, bot.workspace)))) {
        sendJson(response, 400, { error: "Choose a separate QA or security bot assigned to the same workspace." });
        return;
      }
      const effectiveEnv = applyProviderSettingsToEnv(await readProviderSettings(root), env);
      const missingKey = missingProviderKey(bot, effectiveEnv) ?? (reviewer ? missingProviderKey(reviewer, effectiveEnv) : undefined);
      if (missingKey) {
        sendJson(response, 409, { error: `Set ${missingKey} in API Keys & Models (or the environment) before running this bot.` });
        return;
      }
      const workspaceBaseline = await captureWorkspaceBaseline(bot.workspace);
      if (closing) {
        sendJson(response, 503, { error: "OpenCodingPartner is shutting down." });
        return;
      }
      let task: Awaited<ReturnType<typeof createTask>>;
      try {
        task = await createTask({ botId: bot.id, prompt, reviewerBotId: reviewer?.id }, root);
      } catch (error) {
        if (error instanceof Error && error.message.includes("workspace already has an active task")) {
          sendJson(response, 409, { error: error.message });
          return;
        }
        throw error;
      }
      const currentBot = await findBot(bot.id, root);
      if (!currentBot) {
        sendJson(response, 409, { error: "The selected bot was removed." });
        return;
      }
      await updateTask(task.id, { status: "running", processId: process.pid }, root);
      if (closing) {
        await updateTask(task.id, { status: "cancelled", processId: undefined }, root);
        sendJson(response, 503, { error: "OpenCodingPartner is shutting down; the task was not started." });
        return;
      }
      launchTask(task.id, currentBot, reviewer, prompt, workspaceBaseline);
      sendJson(response, 202, { taskId: task.id });
      return;
    }
    const approvalMatch = /^\/api\/tasks\/([^/]+)\/approval$/.exec(url.pathname);
    if (approvalMatch) {
      const taskId = approvalMatch[1] ?? "";
      const task = (await listTasks(root)).find((item) => item.id === taskId);
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      const approved = body.approved === true;
      const waiter = approvalWaiters.get(requestId);
      if (!task?.pendingApproval || task.pendingApproval.id !== requestId || waiter?.taskId !== taskId) {
        sendJson(response, 409, { error: "That approval request is no longer pending." });
        return;
      }
      approvalWaiters.delete(requestId);
      await updateTask(taskId, { status: "running", pendingApproval: undefined }, root);
      waiter.resolve(approved ? waiter.optionId : undefined);
      sendJson(response, 200, { ok: true });
      return;
    }
    const cancelMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
    if (cancelMatch) {
      const taskId = cancelMatch[1] ?? "";
      const run = activeRuns.get(taskId);
      if (!run) {
        sendJson(response, 409, { error: "That task is not currently running." });
        return;
      }
      run.controller.abort();
      for (const [requestId, waiter] of approvalWaiters) {
        if (waiter.taskId === taskId) {
          approvalWaiters.delete(requestId);
          waiter.resolve(undefined);
        }
      }
      sendJson(response, 202, { ok: true });
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  }

  function launchTask(taskId: string, bot: NonNullable<Awaited<ReturnType<typeof findBot>>>, reviewer: NonNullable<Awaited<ReturnType<typeof findBot>>> | undefined, prompt: string, workspaceBaseline: Awaited<ReturnType<typeof captureWorkspaceBaseline>>): void {
    const controller = new AbortController();
    const run: ActiveRun = { controller };
    activeRuns.set(taskId, run);
    run.done = (async () => {
      let eventWrites = Promise.resolve();
      let eventError: unknown;
      let progressText = "";
      let progressTimer: NodeJS.Timeout | undefined;
      const persistProgress = () => {
        eventWrites = eventWrites.then(() => updateTask(taskId, { result: progressText }, root).then(() => undefined)).catch((error) => { eventError = error; });
      };
      const flushProgress = async () => {
        if (progressTimer) clearTimeout(progressTimer);
        progressTimer = undefined;
        if (progressText) persistProgress();
        await eventWrites;
      };
      try {
        const agents = reviewer ? [bot, reviewer] : [bot];
        const results: Array<{ sessionId: string; result: string; permissionDenied: boolean }> = [];
        let permissionDenied = false;
        for (let index = 0; index < agents.length; index += 1) {
          const agent = agents[index]!;
          let agentPrompt: string;
          if (index === 1) {
            await flushProgress();
            const implementation = results[0]!;
            const reviewWorkspace = await collectWorkspaceChanges(bot.workspace, workspaceBaseline);
            progressText = `Implementation:\n${implementation.result.slice(-8_000)}\n\n${agent.role === "security" ? "Security" : "QA"} review:\n`;
            await recordTaskEvent(taskId, { kind: "handoff", title: `Handing workspace to ${agent.name} for ${agent.role} review.` }, root);
            persistProgress();
            await eventWrites;
            const reviewContext = [
              `User request:\n${prompt.slice(0, 8_000)}`,
              `Implementation agent report:\n${implementation.result.slice(-8_000)}`,
              `Changed paths:\n${reviewWorkspace.files.map((file) => `${file.status} ${file.path}`).join("\n").slice(0, 4_000) || "No Git changes reported."}`,
              reviewWorkspace.diff ? `Git diff excerpt:\n${reviewWorkspace.diff.slice(0, 10_000)}` : `Git diff unavailable: ${reviewWorkspace.diffOmittedReason ?? "no diff"}`,
              "Review the current workspace against the request. Report concrete findings with file references, then note what you verified. Do not modify project files.",
            ].join("\n\n");
            agentPrompt = `${agent.instructions}\n\n${reviewContext}`;
          } else {
            agentPrompt = `${agent.instructions}\n\nTask from user:\n${prompt}`;
          }
          const result = await runBotSession(agent, agentPrompt, {
            env,
            dataDir: root,
            signal: controller.signal,
            onUpdate: (update) => {
              if (update.kind === "agent_message_chunk" && update.text) {
                progressText = `${progressText}${update.text}`.slice(-20_000);
                if (!progressTimer) progressTimer = setTimeout(() => {
                  progressTimer = undefined;
                  persistProgress();
                }, 400);
              }
              if (["tool_call", "tool_call_update", "permission_allowed", "permission_denied", "session_reset"].includes(update.kind)) {
                const title = update.title ? `${agent.name}: ${update.title}` : agent.name;
                eventWrites = eventWrites.then(() => recordTaskEvent(taskId, { kind: update.kind, title }, root)).catch((error) => { eventError = error; });
              }
            },
            onSessionReady: (sessionId) => updateBotSession(agent.id, sessionId, root),
            onPermissionRequest: (request) => waitForApproval(taskId, request),
            onPermissionResolved: (approval) => recordTaskApproval(taskId, approval, root),
          });
          results.push(result);
          permissionDenied ||= result.permissionDenied;
          if (result.permissionDenied) break;
        }
        await flushProgress();
        if (eventError) throw eventError;
        const result = reviewer && results.length > 1
          ? `Implementation by ${bot.name}:\n${results[0]!.result}\n\nReview by ${reviewer.name}:\n${results[1]!.result}`
          : results[0]!.result;
        const workspaceChanges = await collectWorkspaceChanges(bot.workspace, workspaceBaseline);
        await updateTask(taskId, {
          status: permissionDenied ? "needs-attention" : "succeeded",
          runtimeSessionId: results[0]!.sessionId,
          result: result.slice(-20_000),
          workspaceChanges,
          processId: undefined,
          pendingApproval: undefined,
        }, root);
      } catch (error) {
        await flushProgress().catch(() => undefined);
        const cancelled = controller.signal.aborted;
        const workspaceChanges = await collectWorkspaceChanges(bot.workspace, workspaceBaseline).catch(() => undefined);
        await updateTask(taskId, {
          status: cancelled ? "cancelled" : "failed",
          error: cancelled ? undefined : (error instanceof Error ? error.message : "Agent run failed."),
          processId: undefined,
          pendingApproval: undefined,
          workspaceChanges,
        }, root).catch(() => undefined);
      } finally {
        if (progressTimer) clearTimeout(progressTimer);
        activeRuns.delete(taskId);
        for (const [requestId, waiter] of approvalWaiters) {
          if (waiter.taskId === taskId) {
            approvalWaiters.delete(requestId);
            waiter.resolve(undefined);
          }
        }
      }
    })();
  }

  async function waitForApproval(taskId: string, request: RuntimePermissionRequest): Promise<string | undefined> {
    const allow = request.options.find((option) => option.kind === "allow_once");
    if (!allow) return undefined;
    const id = randomUUID();
    const pending: PendingTaskApproval = {
      id,
      title: request.title.slice(0, 500),
      description: request.description?.slice(0, 4000),
      subject: boundedJson(request.subject),
      allowOnceOptionId: allow.optionId,
      requestedAt: new Date().toISOString(),
    };
    await updateTask(taskId, { status: "awaiting-approval", pendingApproval: pending }, root);
    return new Promise((resolve) => {
      const waiter = { taskId, optionId: allow.optionId, resolve };
      approvalWaiters.set(id, waiter);
      const signal = activeRuns.get(taskId)?.controller.signal;
      if (signal?.aborted) {
        approvalWaiters.delete(id);
        resolve(undefined);
      } else {
        signal?.addEventListener("abort", () => {
          approvalWaiters.delete(id);
          resolve(undefined);
        }, { once: true });
      }
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  boundPort = actualPort;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return {
    server,
    url: `http://${displayHost}:${actualPort}`,
    close: async () => {
      closing = true;
      const serverClosed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const runs = [...activeRuns.values()];
      for (const run of runs) run.controller.abort();
      await Promise.allSettled(runs.map((run) => run.done).filter((done): done is Promise<void> => done !== undefined));
      await serverClosed;
    },
  };
}

async function saveBotFromRequest(body: Record<string, unknown>, root: string, id?: string): Promise<{ bot?: Awaited<ReturnType<typeof createBot>>; error?: string }> {
  const existing = id ? await findBot(id, root) : undefined;
  if (id && !existing) return { error: "Bot not found." };
  const name = typeof body.name === "string" ? body.name.trim() : existing?.name ?? "";
  const role = typeof body.role === "string" ? body.role : existing?.role ?? "general";
  const runtime = typeof body.runtime === "string" ? body.runtime : existing?.runtime ?? "ocp-agent";
  const isolation = typeof body.isolation === "string" ? body.isolation : existing?.isolation ?? "docker";
  const network = typeof body.network === "string" ? body.network : existing?.network ?? "disabled";
  const provider = typeof body.provider === "string" && body.provider ? body.provider : Object.hasOwn(body, "provider") ? undefined : existing?.provider;
  const model = typeof body.model === "string" ? body.model.trim() : existing?.model ?? "";
  const endpoint = typeof body.endpoint === "string" && body.endpoint.trim() ? body.endpoint.trim() : Object.hasOwn(body, "endpoint") ? undefined : existing?.endpoint;
  const apiKeyEnv = typeof body.apiKeyEnv === "string" && body.apiKeyEnv.trim() ? body.apiKeyEnv.trim() : provider === "litellm" ? existing?.apiKeyEnv || "LITELLM_API_KEY" : undefined;
  const workspace = path.resolve(typeof body.workspace === "string" && body.workspace.trim() ? body.workspace : existing?.workspace ?? process.cwd());
  const info = await stat(workspace).catch(() => undefined);
  const agentRuntime = isOcpAgentRuntime(runtime);
  if (!name || name.length > 100 || !validBotRole(role) || !validBotRuntime(runtime) || !info?.isDirectory()) return { error: "Enter a name, valid role/runtime, and an existing workspace directory." };
  if (agentRuntime && !["docker", "host"].includes(isolation)) return { error: "Choose Docker or host isolation." };
  if (!validBotNetworkMode(network) || (network === "enabled" && (!agentRuntime || isolation !== "docker"))) return { error: "Network access can only be enabled for an OCP Agent bot using Docker isolation." };
  if (provider && (!validBotProvider(provider) || !model)) return { error: "Provider routing requires an OpenRouter or LiteLLM provider and a model ID." };
  if (!provider && model) return { error: "A model override requires an explicit OpenRouter or LiteLLM provider profile." };
  if ((provider === "litellm" && !validEndpoint(endpoint)) || (provider !== "litellm" && endpoint)) return { error: "LiteLLM requires an HTTP(S) endpoint without credentials; other providers do not use one." };
  if ((provider === "litellm" && !validEnvName(apiKeyEnv)) || (provider !== "litellm" && body.apiKeyEnv)) return { error: "API key environment variable name is invalid or not supported for this provider." };
  const botInput = {
      name,
      role,
      runtime,
      isolation: agentRuntime ? isolation as "docker" | "host" : undefined,
      network: agentRuntime && isolation === "docker" ? network : undefined,
      workspace,
      instructions: typeof body.instructions === "string" ? body.instructions.trim().slice(0, 20_000) || defaultBotInstructions(role) : existing?.instructions ?? defaultBotInstructions(role),
      provider: provider as "openrouter" | "litellm" | undefined,
      model: model || undefined,
      endpoint,
      apiKeyEnv,
  };
  try {
    if (existing) return { bot: await updateBot(existing.id, botInput, root) };
    return { bot: await createBot(botInput, root) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not create bot." };
  }
}

function validEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function validEnvName(value: string | undefined): boolean {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function publicBot(bot: NonNullable<Awaited<ReturnType<typeof findBot>>>, env: NodeJS.ProcessEnv = process.env) {
  const { id, name, role, runtime, isolation, network, workspace, provider, endpoint, apiKeyEnv, model, instructions, createdAt, updatedAt } = bot;
  const effectiveIsolation = isOcpAgentRuntime(runtime) ? isolation ?? "docker" : undefined;
  const providerKeyConfigured = provider ? missingProviderKey(bot, env) === undefined : undefined;
  return { id, name, role, runtime, isolation: effectiveIsolation, network: effectiveIsolation === "docker" ? network ?? "disabled" : undefined, workspace, provider, endpoint, apiKeyEnv, model, instructions, providerKeyConfigured, createdAt, updatedAt };
}

function boundedJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > 12_000) return "[details omitted: too large]";
    return JSON.parse(serialized) as unknown;
  } catch { return "[details omitted: unavailable]"; }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function validHostHeader(value: string, port: number): boolean {
  const host = value.toLowerCase();
  return host === `localhost:${port}` || host === `127.0.0.1:${port}` || host === `[::1]:${port}` || host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function validOrigin(origin: string | undefined, host: string): boolean {
  return !origin || origin === `http://${host}`;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 1_000_000) throw new Error("Request body is too large.");
  }
  const parsed: unknown = body ? JSON.parse(body) : {};
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

function probe(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };
    const child = spawn(command, [...args], { shell: false, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2500);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

function renderApp(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenCodingPartner · Multi-Agent Studio</title>
<style nonce="${token}">
:root{color-scheme:dark;--bg:#090d13;--panel:#121822;--panel2:#171f2c;--line:#253042;--muted:#94a3b8;--text:#f1f5f9;--accent:#6ee7b7;--accent-fg:#062019;--warn:#fcd34d;--danger:#fca5a5}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at 15% 0%,#162432,var(--bg) 60%);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;flex-direction:column}
header{height:58px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 20px;background:rgba(12,17,25,.88);backdrop-filter:blur(10px);position:sticky;top:0;z-index:20}
.brand{display:flex;align-items:center;gap:11px}
.mark{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#38bdf8);color:var(--accent-fg);display:grid;place-items:center;font-weight:900;font-size:15px}
.brand strong{font-size:15px;letter-spacing:-.01em}
.brand span{color:var(--muted);font-size:12px}
.top-actions{display:flex;gap:8px;align-items:center}
.studio{display:grid;grid-template-columns:280px minmax(0,1fr) 370px;gap:16px;padding:16px;max-width:1760px;width:100%;margin:0 auto;flex:1;align-items:start}
.sidebar,.center-col,.inspector{display:grid;gap:14px;align-content:start}
.panel{background:color-mix(in srgb,var(--panel),transparent 6%);border:1px solid var(--line);border-radius:14px;padding:15px;box-shadow:0 12px 36px rgba(0,0,0,.22)}
h1{font-size:17px;margin:0 0 4px}
h2{font-size:14px;margin:0 0 10px;font-weight:700}
h3{font-size:13px;margin:12px 0 6px}
.sub{color:var(--muted);font-size:12px;margin:0 0 12px}
label{display:grid;gap:5px;font-size:12px;color:#cbd5e1;margin:8px 0}
input,select,textarea{width:100%;background:#0b1018;border:1px solid #2e3c51;border-radius:8px;padding:9px 11px;color:var(--text);font:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
textarea{min-height:76px;resize:vertical}
button{border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);padding:8px 12px;font-weight:700;font-size:12px;cursor:pointer;transition:opacity .15s}
button:hover{opacity:.92}
button.secondary{background:#222e3f;color:var(--text);border:1px solid #324258}
button.danger{background:#472328;color:#fecaca;border:1px solid #6b343b}
button.chip{background:#182332;color:#d8e6f3;border:1px solid #2b3c52;border-radius:99px;padding:6px 12px;font-weight:600;text-align:left}
button.chip:hover{border-color:var(--accent);color:var(--accent)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row.spread{justify-content:space-between}
.cards{display:grid;gap:7px}
.card{border:1px solid var(--line);border-radius:10px;padding:10px 11px;background:#0e141e;cursor:pointer;transition:border-color .15s}
.card:hover,.card.selected{border-color:var(--accent);background:#131c29}
.card strong{display:block;font-size:13px}
.meta{font-size:11px;color:var(--muted)}
.task{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start}
.pill{font-size:11px;border:1px solid #2f4358;background:#111a26;padding:2px 8px;border-radius:99px;color:var(--accent);white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.pill.wait{color:var(--warn);border-color:#645333;background:#221c11}
.pill.role{color:#93c5fd;border-color:#264063}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block}
.dot.busy{background:#38bdf8;box-shadow:0 0 8px #38bdf8}
.dot.wait{background:var(--warn);box-shadow:0 0 8px var(--warn)}
.chat-shell{display:flex;flex-direction:column;min-height:calc(100vh - 110px);padding:0;overflow:hidden}
.chat-head{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:10px;background:rgba(18,24,34,.9)}
.chat-feed{flex:1;padding:18px;overflow-y:auto;display:grid;gap:14px;align-content:start;max-height:calc(100vh - 295px)}
.welcome-box{border:1px dashed #33465e;border-radius:12px;padding:16px;background:rgba(16,24,36,.65)}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}
.turn{display:grid;gap:8px}
.msg-user{justify-self:end;max-width:85%;background:#1b283b;border:1px solid #2e4361;border-radius:12px 12px 3px 12px;padding:10px 13px}
.msg-bot{justify-self:stretch;background:#0e1520;border:1px solid var(--line);border-radius:12px 12px 12px 3px;padding:12px 14px}
.msg-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;font-size:11px;color:var(--muted)}
.msg-head strong{color:var(--text);font-size:13px}
.composer{padding:13px 16px;border-top:1px solid var(--line);background:#0d131c}
.activity{display:grid;gap:6px;margin:8px 0}
.event{font-size:11px;padding:6px 9px;border-left:2px solid #48867c;background:#0b1119;color:#cbd5e1;border-radius:0 6px 6px 0}
.event time{display:block;color:var(--muted);font-size:10px}
.approval{border:1px solid #785c26;background:#221c10;border-radius:10px;padding:12px;margin:8px 0}
.approval h3{font-size:13px;margin:0 0 5px;color:var(--warn)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:#070b10;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:300px;overflow:auto;margin:6px 0}
.result{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}
.status{color:var(--muted);font-size:12px;min-height:16px;margin-top:4px}
.screen-wrap{position:relative;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#05080c;margin:8px 0}
.screen-wrap img{display:block;width:100%;height:auto;cursor:crosshair}
.hidden{display:none!important}
@media(max-width:1200px){.studio{grid-template-columns:250px minmax(0,1fr)}.inspector{grid-column:1/-1}}
@media(max-width:820px){.studio{grid-template-columns:1fr;padding:10px}}
</style></head><body>
<header>
  <div class="brand">
    <div class="mark">O</div>
    <div>
      <strong>OpenCodingPartner</strong>
      <span> · Grok Bot &amp; OpenBot Local Multi-Agent Studio (OCP Agent &amp; OCP Coder)</span>
    </div>
  </div>
  <div class="top-actions">
    <button type="button" id="spawnTeamBtn">⚡ Spawn Full Team</button>
    <button type="button" class="secondary" id="openComputerTopBtn">🖥️ Virtual Computer</button>
    <button type="button" class="secondary" id="openSettingsBtn">🔑 API Keys &amp; Models</button>
    <button type="button" class="secondary" id="openNewBotBtn">+ New Bot</button>
  </div>
</header>
<main class="studio">
  <aside class="sidebar">
    <div class="panel">
      <h2>Channels</h2>
      <div id="channelTeamHq" class="card selected">
        <strong># team-hq</strong>
        <span class="meta">All bots in one room · Lead Bot creates &amp; coordinates bots</span>
      </div>
    </div>
    <div class="panel">
      <div class="row spread">
        <div>
          <h1>Your Bot Fleet</h1>
          <p class="sub" style="margin:0">Click a bot to chat 1-on-1 or manage.</p>
        </div>
      </div>
      <div id="bots" class="cards" style="margin-top:10px"></div>
    </div>
    <div class="panel" id="health">
      <h2>Local readiness</h2>
      <p class="sub">Checking OCP Agent, OCP Coder, Docker, and provider keys.</p>
    </div>
  </aside>

  <section class="center-col">
    <div class="panel chat-shell">
      <div class="chat-head">
        <div>
          <h1 id="activeRoomTitle"># team-hq · Shared Multi-Agent Room</h1>
          <div class="meta" id="activeRoomSub">Talk to Ada (Lead Orchestrator) to create bots, manage your fleet, or @mention any specialist bot.</div>
        </div>
        <div class="row">
          <button type="button" class="secondary" id="allRoomBtn">All Bots (#team-hq)</button>
          <button type="button" class="secondary" id="refresh">Refresh</button>
        </div>
      </div>
      <div id="chatFeed" class="chat-feed"></div>
      <div class="composer">
        <form id="taskForm">
          <div class="row" style="margin-bottom:8px">
            <label style="flex:1;margin:0">Send to Bot<select name="botId" id="botSelect" required></select></label>
            <label style="flex:1;margin:0">Auto-Handoff Review<select name="reviewerBotId" id="reviewerSelect"><option value="">No review handoff</option></select></label>
          </div>
          <div class="row">
            <textarea name="prompt" id="promptInput" required placeholder="Ask Ada to 'Spin up a full team', 'Create a QA bot named Grace', '@Linus inspect package.json', or describe any coding task… (Enter to send, Shift+Enter for newline)" style="flex:1;min-height:58px"></textarea>
            <button style="height:58px;padding:0 18px">Send ↵</button>
          </div>
        </form>
        <div id="taskStatus" class="status"></div>
      </div>
    </div>
    <div id="conversation" class="panel hidden"></div>
  </section>

  <aside class="inspector">
    <div id="computerPanel" class="panel hidden"></div>
    <div id="settingsPanel" class="panel hidden">
      <div class="row spread">
        <h2>🔑 API Keys &amp; Models</h2>
        <button type="button" class="secondary" id="closeSettingsBtn">Close</button>
      </div>
      <p class="sub">Save provider keys locally (mode 0600) without restarting the terminal. Leave blank to use the built-in Local Orchestrator or local Ollama.</p>
      <form id="settingsForm">
        <label>OpenRouter API Key (OPENROUTER_API_KEY)<input type="password" name="openrouterApiKey" placeholder="sk-or-v1-..."></label>
        <label>OpenAI API Key (OPENAI_API_KEY)<input type="password" name="openaiApiKey" placeholder="sk-..."></label>
        <label>LiteLLM / Custom API Key (LITELLM_API_KEY)<input type="password" name="litellmApiKey" placeholder="sk-..."></label>
        <label>LiteLLM / Ollama Base URL<input name="litellmBaseUrl" placeholder="http://127.0.0.1:4000/v1 or http://127.0.0.1:11434/v1"></label>
        <label>Default Model ID<input name="defaultModel" placeholder="openai/gpt-4.1-mini or qwen/qwen-2.5-coder-32b-instruct"></label>
        <button type="submit">Save keys &amp; apply immediately</button>
      </form>
      <div id="settingsStatus" class="status"></div>
    </div>
    <div id="detail" class="panel">
      <h2>Task &amp; Diff Inspector</h2>
      <p class="sub">Select any message or task to inspect live tool events, modified files, and Git diffs.</p>
    </div>
    <div class="panel" id="botDrawer">
      <h2 id="botFormTitle">Create a teammate</h2>
      <form id="botForm">
        <input type="hidden" name="botId">
        <label>Name<input name="name" required placeholder="Linus (OCP Coder)"></label>
        <div class="row">
          <label style="flex:1">Role<select name="role"><option>general</option><option>coding</option><option>qa</option><option>security</option><option>research</option><option>computer</option></select></label>
          <label style="flex:1">Runtime<select name="runtime"><option value="ocp-agent">OCP Agent</option><option value="ocp-coder">OCP Coder</option></select></label>
        </div>
        <label>Workspace path<input name="workspace" required value="${escapeAttribute(process.cwd())}"></label>
        <label>OCP Agent tool isolation<select name="isolation"><option value="host">Host process (fast local)</option><option value="docker">Docker workspace sandbox</option></select></label>
        <label id="networkField" class="hidden">Docker terminal network<select name="network"><option value="disabled">Disabled (default)</option><option value="enabled">Enabled for downloads</option></select></label>
        <label>Provider<select name="provider"><option value="">Use configured runtime / Local Orchestrator</option><option value="openrouter">OpenRouter</option><option value="litellm">LiteLLM</option></select></label>
        <label class="provider-field hidden">Model ID<input name="model" placeholder="provider/model or deployment"></label>
        <label class="provider-field hidden">LiteLLM endpoint<input name="endpoint" placeholder="http://127.0.0.1:4000/v1"></label>
        <label class="provider-field hidden">API key environment variable<input name="apiKeyEnv" value="LITELLM_API_KEY"></label>
        <label>Instructions<textarea name="instructions" placeholder="How should this teammate work?"></textarea></label>
        <div class="row">
          <button id="botSubmit">Create bot</button>
          <button id="botEditCancel" type="button" class="secondary hidden">Cancel edit</button>
        </div>
      </form>
      <div id="botStatus" class="status"></div>
    </div>
    <div class="panel">
      <div class="row spread">
        <h2>Work queue history</h2>
      </div>
      <div id="tasks" class="cards"></div>
    </div>
  </aside>
</main>
<script nonce="${token}">const TOKEN='${token}';let state={bots:[],tasks:[]};let selected='';let conversationBot='';let computerBot='';let computerMeta=null;let bootstrapped=false;const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const isAgentRuntime=r=>r==='ocp-agent'||r==='hermes';const runtimeLabel=r=>isAgentRuntime(r)?'OCP Agent':'OCP Coder';const roleIcon=r=>({general:'🧭',coding:'⚡',qa:'🧪',security:'🛡️',research:'🔎',computer:'🖥️'}[r]||'🤖');async function api(url,body,method){const r=await fetch(url,{method:method||(body?'POST':'GET'),headers:body?{'content-type':'application/json','x-ocp-token':TOKEN}:{},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data}async function load(){state=await api('/api/state');if(!bootstrapped&&state.bots.length===0){bootstrapped=true;try{await api('/api/bootstrap',{mode:'lead'});state=await api('/api/state')}catch{}}draw()}function showProviderFields(){const form=document.querySelector('#botForm'),provider=form.elements.provider.value;document.querySelectorAll('.provider-field').forEach(x=>x.classList.toggle('hidden',!provider));form.elements.endpoint.parentElement.classList.toggle('hidden',provider!=='litellm');form.elements.apiKeyEnv.parentElement.classList.toggle('hidden',provider!=='litellm')}function clearBotForm(){const form=document.querySelector('#botForm');form.reset();form.elements.botId.value='';form.elements.workspace.value='${escapeJs(process.cwd())}';form.elements.isolation.value='host';form.elements.runtime.dispatchEvent(new Event('change'));document.querySelector('#botFormTitle').textContent='Create a teammate';document.querySelector('#botSubmit').textContent='Create bot';document.querySelector('#botEditCancel').classList.add('hidden');form.elements.isolation.parentElement.classList.remove('hidden');showProviderFields()}function editBot(id){const bot=state.bots.find(item=>item.id===id);if(!bot)return;const form=document.querySelector('#botForm');form.elements.botId.value=bot.id;form.elements.name.value=bot.name;form.elements.role.value=bot.role;form.elements.runtime.value=isAgentRuntime(bot.runtime)?'ocp-agent':'ocp-coder';form.elements.isolation.value=bot.isolation||'host';form.elements.network.value=bot.network||'disabled';form.elements.workspace.value=bot.workspace;form.elements.provider.value=bot.provider||'';form.elements.model.value=bot.model||'';form.elements.endpoint.value=bot.endpoint||'';form.elements.apiKeyEnv.value=bot.apiKeyEnv||'LITELLM_API_KEY';form.elements.instructions.value=bot.instructions||'';form.elements.runtime.dispatchEvent(new Event('change'));document.querySelector('#botFormTitle').textContent='Edit teammate: '+bot.name;document.querySelector('#botSubmit').textContent='Save changes';document.querySelector('#botEditCancel').classList.remove('hidden');form.elements.isolation.parentElement.classList.toggle('hidden',!isAgentRuntime(bot.runtime));showProviderFields();form.scrollIntoView({behavior:'smooth',block:'center'})}function draw(){const bots=document.querySelector('#bots'),select=document.querySelector('#botSelect'),reviewerSelect=document.querySelector('#reviewerSelect'),chosenBot=select.value,chosenReviewer=reviewerSelect.value;document.querySelector('#channelTeamHq').classList.toggle('selected',!conversationBot);bots.innerHTML=state.bots.length?state.bots.map(b=>{const activeTask=state.tasks.find(t=>t.botId===b.id&&['queued','running','awaiting-approval'].includes(t.status));const dotClass=activeTask?(activeTask.status==='awaiting-approval'?'wait':'busy'):'';return '<div class="card '+(conversationBot===b.id?'selected':'')+'" data-chat-bot="'+esc(b.id)+'"><div class="row spread"><strong><span class="dot '+dotClass+'"></span> '+roleIcon(b.role)+' '+esc(b.name)+'</strong><span class="pill role">'+esc(b.role)+'</span></div><div class="meta">'+esc(runtimeLabel(b.runtime))+' · '+esc(b.provider||'auto')+(activeTask?' · '+esc(activeTask.status):'')+'</div><div class="row" style="margin-top:7px"><button type="button" class="secondary" data-conversation="'+esc(b.id)+'">Chat</button><button type="button" class="secondary" data-computer="'+esc(b.id)+'">Computer</button><button type="button" class="secondary" data-edit="'+esc(b.id)+'">Edit</button><button type="button" class="danger" data-delete-bot="'+esc(b.id)+'">×</button></div></div>'}).join(''):'<div class="meta">Bootstrapping Lead Bot…</div>';select.innerHTML=state.bots.map(b=>'<option value="'+esc(b.id)+'">'+roleIcon(b.role)+' '+esc(b.name)+' — '+esc(b.role)+'</option>').join('');if(conversationBot&&state.bots.some(b=>b.id===conversationBot))select.value=conversationBot;else if(state.bots.some(b=>b.id===chosenBot))select.value=chosenBot;const primary=state.bots.find(b=>b.id===select.value);const reviewers=state.bots.filter(b=>(b.role==='qa'||b.role==='security')&&b.id!==primary?.id&&b.workspace===primary?.workspace);reviewerSelect.innerHTML='<option value="">No review handoff</option>'+reviewers.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+' — '+esc(b.role)+'</option>').join('');if(reviewers.some(b=>b.id===chosenReviewer))reviewerSelect.value=chosenReviewer;select.onchange=draw;document.querySelectorAll('[data-edit]').forEach(el=>el.addEventListener('click',e=>{e.stopPropagation();editBot(el.dataset.edit)}));document.querySelectorAll('[data-computer]').forEach(el=>el.addEventListener('click',async e=>{e.stopPropagation();computerBot=el.dataset.computer;await refreshComputer(true);document.querySelector('#computerPanel').scrollIntoView({behavior:'smooth',block:'start'})}));document.querySelectorAll('[data-conversation],[data-chat-bot]').forEach(el=>el.addEventListener('click',e=>{e.stopPropagation();conversationBot=el.dataset.conversation||el.dataset.chatBot;select.value=conversationBot;draw()}));document.querySelectorAll('[data-delete-bot]').forEach(el=>el.addEventListener('click',async e=>{e.stopPropagation();const bot=state.bots.find(item=>item.id===el.dataset.deleteBot);if(!bot||!confirm('Delete '+bot.name+'?'))return;try{await api('/api/bots/'+encodeURIComponent(bot.id),{},'DELETE');if(conversationBot===bot.id)conversationBot='';if(document.querySelector('#botForm').elements.botId.value===bot.id)clearBotForm();await load()}catch(error){alert(error.message)}}));document.querySelector('#tasks').innerHTML=state.tasks.length?state.tasks.map(t=>{const b=state.bots.find(x=>x.id===t.botId);return '<div class="card task '+(selected===t.id?'selected':'')+'" data-task="'+esc(t.id)+'"><div><strong>'+esc(t.prompt.slice(0,90))+'</strong><div class="meta">'+esc(b?.name||t.botId)+' · '+new Date(t.createdAt).toLocaleTimeString()+'</div></div><span class="pill '+(t.status==='awaiting-approval'?'wait':'')+'">'+esc(t.status)+'</span></div>'}).join(''):'<div class="meta">No tasks yet.</div>';document.querySelectorAll('[data-task]').forEach(el=>el.addEventListener('click',()=>{selected=el.dataset.task;draw();drawDetail()}));drawChatFeed();drawComputer();drawConversation();drawDetail()}function drawChatFeed(){const feed=document.querySelector('#chatFeed'),activeBot=state.bots.find(b=>b.id===conversationBot);document.querySelector('#activeRoomTitle').textContent=activeBot?(roleIcon(activeBot.role)+' '+activeBot.name+' · '+activeBot.role+' ('+runtimeLabel(activeBot.runtime)+')'):'# team-hq · Shared Multi-Agent Room';document.querySelector('#activeRoomSub').textContent=activeBot?(activeBot.workspace+' · Direct persistent session thread'):'All bots in one room · Ask Ada to create bots, spin up a full team, or @mention any bot.';const visibleTasks=(activeBot?state.tasks.filter(t=>t.botId===activeBot.id||t.reviewerBotId===activeBot.id):state.tasks).slice().sort((a,b)=>a.createdAt.localeCompare(b.createdAt));const quickChips='<div class="welcome-box"><strong>👋 Welcome to OpenCodingPartner Studio</strong><p class="sub" style="margin:4px 0 8px">Your Lead Orchestrator <b>Ada</b> can create new specialist bots, manage your entire fleet, delegate tasks across bots, and control the Virtual Computer. Click any prompt below or type in the box:</p><div class="chips"><button type="button" class="chip" data-quick="Spin up a full team of bots for this repository">⚡ Spin up a full Coder, QA, Security &amp; Computer team</button><button type="button" class="chip" data-quick="Create a coding bot named Linus and a QA bot named Grace">🤖 Create a Coder bot (Linus) &amp; QA bot (Grace)</button><button type="button" class="chip" data-quick="List all bots in the fleet and their current status">📋 List &amp; manage all bots</button><button type="button" class="chip" data-quick="Inspect this repository and summarize the files">🔍 Inspect repository files</button><button type="button" class="chip" data-quick="Open https://example.com on the virtual computer">🌐 Open example.com on Virtual Computer</button></div></div>';feed.innerHTML=quickChips+(visibleTasks.length?visibleTasks.map(t=>{const b=state.bots.find(x=>x.id===t.botId),rev=state.bots.find(x=>x.id===t.reviewerBotId),p=t.pendingApproval,evts=(t.events||[]).slice(-6);return '<div class="turn"><div class="msg-user"><div class="msg-head"><strong>You → @'+esc(b?.name||t.botId)+(rev?' (review: @'+esc(rev.name)+')':'')+'</strong><span>'+esc(new Date(t.createdAt).toLocaleTimeString())+'</span></div><div class="result">'+esc(t.prompt)+'</div></div><div class="msg-bot '+(selected===t.id?'selected':'')+'" data-select-turn="'+esc(t.id)+'"><div class="msg-head"><strong>'+roleIcon(b?.role||'general')+' '+esc(b?.name||t.botId)+' <span class="pill role">'+esc(b?.role||'bot')+'</span></strong><span class="pill '+(t.status==='awaiting-approval'?'wait':'')+'">'+esc(t.status)+'</span></div>'+(evts.length?'<div class="activity">'+evts.map(e=>'<div class="event">⚙ '+esc(e.title||e.kind)+'</div>').join('')+'</div>':'')+(p?'<div class="approval"><h3>⚠️ Approval needed: '+esc(p.title)+'</h3>'+(p.description?'<div class="meta" style="margin-bottom:8px">'+esc(p.description)+'</div>':'')+'<div class="row"><button type="button" data-inline-approve="'+esc(t.id)+'" data-req="'+esc(p.id)+'">Allow once</button><button type="button" class="secondary" data-inline-deny="'+esc(t.id)+'" data-req="'+esc(p.id)+'">Deny</button></div></div>':'')+(t.result?'<div class="result">'+esc(t.result)+'</div>':(t.status==='running'||t.status==='queued'?'<div class="meta">Working…</div>':''))+(t.error?'<div class="result" style="color:var(--danger)">'+esc(t.error)+'</div>':'')+(t.workspaceChanges?.files?.length?'<div class="meta" style="margin-top:8px">📂 Modified files: '+t.workspaceChanges.files.map(f=>esc(f.path)).join(', ')+'</div>':'')+'</div></div>'}).join(''):'');document.querySelectorAll('[data-quick]').forEach(el=>el.addEventListener('click',()=>{const inp=document.querySelector('#promptInput');inp.value=el.dataset.quick;inp.focus()}));document.querySelectorAll('[data-select-turn]').forEach(el=>el.addEventListener('click',()=>{selected=el.dataset.selectTurn;drawDetail()}));document.querySelectorAll('[data-inline-approve]').forEach(el=>el.addEventListener('click',async e=>{e.stopPropagation();await api('/api/tasks/'+encodeURIComponent(el.dataset.inlineApprove)+'/approval',{requestId:el.dataset.req,approved:true});await load()}));document.querySelectorAll('[data-inline-deny]').forEach(el=>el.addEventListener('click',async e=>{e.stopPropagation();await api('/api/tasks/'+encodeURIComponent(el.dataset.inlineDeny)+'/approval',{requestId:el.dataset.req,approved:false});await load()}))}async function refreshComputer(capture){if(!computerBot&&state.bots[0])computerBot=state.bots[0].id;if(!computerBot)return;try{computerMeta=await api('/api/bots/'+encodeURIComponent(computerBot)+'/computer'+(capture?'?refresh=1':''));drawComputer()}catch(e){computerMeta={detail:e.message};drawComputer()}}function drawComputer(){const panel=document.querySelector('#computerPanel'),bot=state.bots.find(item=>item.id===computerBot);if(!bot){panel.classList.add('hidden');panel.innerHTML='';return}panel.classList.remove('hidden');const m=computerMeta||{display:':50',width:1280,height:800,control:'partner',status:'live'};const held=m.control==='human';panel.innerHTML='<div class="row spread"><div><h2>🖥️ '+esc(bot.name)+' · Virtual Computer ('+esc(m.display||':50')+')</h2><p class="sub">Click anywhere on the screen to click at (x, y). Use Take Over to pause bot mouse/keyboard access.</p></div><span class="pill '+(held?'wait':'')+'">Control: '+esc(m.control||'partner')+'</span><button type="button" class="secondary" id="closeComputer">Close</button></div><div class="row"><button type="button" id="compRefresh" class="secondary">Refresh screen</button>'+(held?'<button type="button" id="compReturn">Return control to bot</button>':'<button type="button" id="compTakeover" class="secondary">Take over mouse &amp; keyboard</button>')+'<button type="button" id="compScrollUp" class="secondary">Scroll Up</button><button type="button" id="compScrollDown" class="secondary">Scroll Down</button></div><div class="screen-wrap"><img id="computerScreenImg" src="/api/bots/'+encodeURIComponent(bot.id)+'/computer/frame?t='+(m.frameMtimeMs||Date.now())+'" alt="Virtual computer screen"></div><div class="row"><input id="compUrlInput" placeholder="https://example.com" value="'+esc(m.lastUrl||'')+'"><button type="button" id="compOpenUrl">Open URL</button></div><div class="row"><input id="compTypeInput" placeholder="Type text into active window…"><button type="button" id="compTypeBtn">Type</button><button type="button" class="secondary" data-comp-key="Return">Enter</button><button type="button" class="secondary" data-comp-key="Tab">Tab</button><button type="button" class="secondary" data-comp-key="Escape">Esc</button><button type="button" class="secondary" data-comp-key="BackSpace">⌫</button></div><div class="status" id="compStatus">'+esc(m.detail||'')+'</div>';document.querySelector('#closeComputer').addEventListener('click',()=>{computerBot='';drawComputer()});document.querySelector('#compRefresh').addEventListener('click',()=>refreshComputer(true));document.querySelector('#compTakeover')?.addEventListener('click',async()=>{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'takeover'});drawComputer()});document.querySelector('#compReturn')?.addEventListener('click',async()=>{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'return'});drawComputer()});document.querySelector('#compScrollUp').addEventListener('click',async()=>{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'mouse',action:'scroll',direction:'up',amount:4});drawComputer()});document.querySelector('#compScrollDown').addEventListener('click',async()=>{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'mouse',action:'scroll',direction:'down',amount:4});drawComputer()});document.querySelector('#compOpenUrl').addEventListener('click',async()=>{const u=document.querySelector('#compUrlInput').value.trim();if(!u)return;document.querySelector('#compStatus').textContent='Opening URL…';try{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'browser',url:u});drawComputer()}catch(e){document.querySelector('#compStatus').textContent=e.message}});document.querySelector('#compTypeBtn').addEventListener('click',async()=>{const t=document.querySelector('#compTypeInput').value;if(!t)return;try{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'keyboard',action:'type',text:t});drawComputer()}catch(e){document.querySelector('#compStatus').textContent=e.message}});document.querySelectorAll('[data-comp-key]').forEach(el=>el.addEventListener('click',async()=>{try{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'keyboard',action:'key',key:el.dataset.compKey});drawComputer()}catch(e){document.querySelector('#compStatus').textContent=e.message}}));document.querySelector('#computerScreenImg').addEventListener('click',async e=>{const rect=e.target.getBoundingClientRect();const w=m.width||1280,h=m.height||800;const x=Math.round((e.clientX-rect.left)/rect.width*w);const y=Math.round((e.clientY-rect.top)/rect.height*h);document.querySelector('#compStatus').textContent='Clicking ('+x+', '+y+')…';try{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'mouse',action:'click',x,y});drawComputer()}catch(err){document.querySelector('#compStatus').textContent=err.message}})}function drawConversation(){const panel=document.querySelector('#conversation');panel.classList.add('hidden')}function drawDetail(){const panel=document.querySelector('#detail'),t=state.tasks.find(x=>x.id===selected)||state.tasks[0];if(!t){panel.innerHTML='<h2>Task &amp; Diff Inspector</h2><p class="sub">Select a message or task to inspect its activity, files, and Git diff.</p>';return}const b=state.bots.find(x=>x.id===t.botId),reviewer=state.bots.find(x=>x.id===t.reviewerBotId),agents=t.agents||[];const p=t.pendingApproval;panel.innerHTML='<div class="row spread"><div><h2>Task detail</h2><div class="meta">'+esc(b?.name||t.botId)+' · '+esc(t.status)+(reviewer?' · review by '+esc(reviewer.name):'')+'</div></div>'+(t.status==='running'||t.status==='awaiting-approval'||t.status==='queued'?'<button id="cancel" class="danger">Cancel</button>':((b&&['failed','cancelled','needs-attention'].includes(t.status))?'<button id="retry" class="secondary">Retry</button>':'')+'<button id="delete" class="danger">Delete</button>')+'</div>'+(agents.length?'<div class="meta" style="margin-top:4px">Pipeline: '+agents.map(a=>esc(a.name)+' ('+esc(a.role)+')').join(' → ')+'</div>':'')+(p?'<div class="approval"><h3>Approval needed</h3><strong>'+esc(p.title)+'</strong>'+(p.description?'<p>'+esc(p.description)+'</p>':'')+'<div class="row"><button id="approve">Allow once</button><button id="deny" class="secondary">Deny</button></div></div>':'')+'<h3>Activity</h3><div class="activity">'+(t.events||[]).slice().reverse().map(e=>'<div class="event"><time>'+esc(new Date(e.createdAt).toLocaleTimeString())+'</time>'+esc(e.kind)+(e.title?' · '+esc(e.title):'')+'</div>').join('')+'</div>'+(t.workspaceChanges?'<h3>Workspace changes</h3>'+(t.workspaceChanges.available?'<div class="activity">'+t.workspaceChanges.files.map(f=>'<div class="event"><button type="button" class="secondary" data-workspace-file="'+esc(f.path)+'">'+esc(f.status)+' · '+esc(f.path)+'</button></div>').join('')+'</div><div id="workspaceFileView"></div>':'<p class="meta">'+esc(t.workspaceChanges.diffOmittedReason||'No Git changes.')+'</p>')+(t.workspaceChanges.diff?'<details><summary>Review Git diff</summary><pre>'+esc(t.workspaceChanges.diff)+'</pre></details>':''):'');document.querySelectorAll('[data-workspace-file]').forEach(el=>el.addEventListener('click',async()=>{const view=document.querySelector('#workspaceFileView'),filePath=el.dataset.workspaceFile;view.innerHTML='<p class="meta">Loading file…</p>';try{const file=await api('/api/workspace/file?botId='+encodeURIComponent(t.botId)+'&path='+encodeURIComponent(filePath));view.innerHTML='<h3>'+esc(filePath)+'</h3><pre>'+esc(file.content)+'</pre>'}catch(error){view.innerHTML='<p class="meta">'+esc(error.message)+'</p>'}}));const action=async(what,body)=>{try{await api('/api/tasks/'+encodeURIComponent(t.id)+'/'+what,body);await load()}catch(e){alert(e.message)}};document.querySelector('#approve')?.addEventListener('click',()=>action('approval',{requestId:p.id,approved:true}));document.querySelector('#deny')?.addEventListener('click',()=>action('approval',{requestId:p.id,approved:false}));document.querySelector('#cancel')?.addEventListener('click',()=>action('cancel',{}));document.querySelector('#retry')?.addEventListener('click',async()=>{try{const created=await api('/api/tasks',{botId:t.botId,reviewerBotId:t.reviewerBotId||'',prompt:t.prompt});selected=created.taskId;await load()}catch(error){alert(error.message)}});document.querySelector('#delete')?.addEventListener('click',async()=>{try{await api('/api/tasks/'+encodeURIComponent(t.id),{},'DELETE');if(selected===t.id)selected='';await load()}catch(e){alert(e.message)}})}document.querySelector('#channelTeamHq').addEventListener('click',()=>{conversationBot='';draw()});document.querySelector('#allRoomBtn').addEventListener('click',()=>{conversationBot='';draw()});document.querySelector('#spawnTeamBtn').addEventListener('click',async()=>{try{await api('/api/bootstrap',{mode:'team'});await load()}catch(e){alert(e.message)}});document.querySelector('#openComputerTopBtn').addEventListener('click',async()=>{if(!computerBot&&state.bots[0])computerBot=state.bots[0].id;await refreshComputer(true);document.querySelector('#computerPanel').scrollIntoView({behavior:'smooth',block:'start'})});document.querySelector('#openNewBotBtn').addEventListener('click',()=>{clearBotForm();document.querySelector('#botDrawer').scrollIntoView({behavior:'smooth',block:'start'});document.querySelector('#botForm').elements.name.focus()});document.querySelector('#openSettingsBtn').addEventListener('click',async()=>{const panel=document.querySelector('#settingsPanel');panel.classList.toggle('hidden');if(!panel.classList.contains('hidden')){try{const s=await api('/api/settings');const f=document.querySelector('#settingsForm');f.elements.litellmBaseUrl.value=s.litellmBaseUrl||'';f.elements.defaultModel.value=s.defaultModel||''}catch{}}});document.querySelector('#closeSettingsBtn').addEventListener('click',()=>document.querySelector('#settingsPanel').classList.add('hidden'));document.querySelector('#settingsForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target),body=Object.fromEntries(f.entries());try{await api('/api/settings',body,'POST');document.querySelector('#settingsStatus').textContent='Saved & applied! All bots can now use these credentials.';await load();await showHealth()}catch(err){document.querySelector('#settingsStatus').textContent=err.message}});document.querySelector('#botForm').elements.provider.addEventListener('change',showProviderFields);document.querySelector('#botForm').elements.runtime.addEventListener('change',e=>{const form=document.querySelector('#botForm'),agent=isAgentRuntime(e.target.value);form.elements.isolation.parentElement.classList.toggle('hidden',!agent);if(!agent)form.elements.network.value='disabled';form.elements.network.parentElement.classList.toggle('hidden',!agent||form.elements.isolation.value!=='docker');showProviderFields()});document.querySelector('#botForm').elements.isolation.addEventListener('change',e=>{const form=document.querySelector('#botForm');if(e.target.value!=='docker')form.elements.network.value='disabled';form.elements.network.parentElement.classList.toggle('hidden',!isAgentRuntime(form.elements.runtime.value)||e.target.value!=='docker')});document.querySelector('#botEditCancel').addEventListener('click',clearBotForm);document.querySelector('#botForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target),provider=f.get('provider');const body=Object.fromEntries(f.entries());body.provider=provider;if(!provider)body.model='';if(provider!=='litellm'){delete body.endpoint;delete body.apiKeyEnv}try{const botId=String(f.get('botId')||'');await api(botId?'/api/bots/'+encodeURIComponent(botId):'/api/bots',body,botId?'PATCH':'POST');clearBotForm();document.querySelector('#botStatus').textContent=botId?'Bot updated.':'Bot created.';await load()}catch(err){document.querySelector('#botStatus').textContent=err.message}});document.querySelector('#promptInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.querySelector('#taskForm').requestSubmit()}});document.querySelector('#taskForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);let botId=String(f.get('botId')||'');let prompt=String(f.get('prompt')||'').trim();const mention=/^@([A-Za-z0-9_-]+)\s+([\s\S]+)$/.exec(prompt);if(mention){const target=state.bots.find(b=>b.name.toLowerCase()===mention[1].toLowerCase());if(target){botId=target.id;prompt=mention[2].trim()}}try{const r=await api('/api/tasks',{botId,reviewerBotId:f.get('reviewerBotId'),prompt});e.target.prompt.value='';selected=r.taskId;document.querySelector('#taskStatus').textContent='Message sent.';await load()}catch(err){document.querySelector('#taskStatus').textContent=err.message}});document.querySelector('#refresh').addEventListener('click',load);async function showHealth(){try{const h=await api('/api/health');const row=(name,ready,label)=>'<span class="pill '+(ready?'':'wait')+'">'+esc(name)+': '+(label||(ready?'ready':'not ready'))+'</span>';document.querySelector('#health').innerHTML='<h2>Local readiness</h2><div class="row">'+row('OCP Agent',h.ocpAgent??h.hermes)+row('OCP Coder',h.ocpCoder??h.grokBuild)+row('Docker',h.docker)+row('Brain',true,h.providerConfigured?'Cloud/API Key':'Local Orchestrator')+'</div>'}catch(e){document.querySelector('#health').innerHTML='<h2>Local readiness</h2><p class="sub">'+esc(e.message)+'</p>'}}load().catch(e=>document.querySelector('#tasks').textContent=e.message);showHealth();setInterval(()=>load().catch(()=>{}),2000);setInterval(showHealth,30000);</script></body></html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeJs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/</g, "\\x3c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
