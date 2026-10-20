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
  createProject,
  deleteBot,
  deleteProject,
  defaultBotInstructions,
  captureWorkspaceBaseline,
  collectWorkspaceChanges,
  createTask,
  deleteTask,
  findBot,
  isOcpAgentRuntime,
  listBots,
  listProjects,
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
      const [projects, bots, tasks, settings] = await Promise.all([
        listProjects(root),
        listBots(root),
        listTasks(root),
        readProviderSettings(root),
      ]);
      const effectiveEnv = applyProviderSettingsToEnv(settings, env);
      sendJson(response, 200, {
        projects,
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
    if (request.method === "GET" && url.pathname === "/api/projects") {
      const projects = await listProjects(root);
      sendJson(response, 200, { projects });
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
        activeBrainLabel: effectiveEnv.LITELLM_BASE_URL
          ? `Local GPU (${effectiveEnv.OCP_DEFAULT_MODEL || "gemma4:latest"})`
          : effectiveEnv.OPENROUTER_API_KEY
            ? `OpenRouter (${effectiveEnv.OCP_DEFAULT_MODEL || "gpt-4.1-mini"})`
            : "Local Orchestrator",
        providerConfigured: Boolean(
          effectiveEnv.LITELLM_BASE_URL ||
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
    if (request.method === "POST" && url.pathname === "/api/projects") {
      const rawName = typeof body.name === "string" ? body.name.trim() : "";
      const rawWorkspace = typeof body.workspace === "string" ? body.workspace.trim() : "";
      const description = typeof body.description === "string" ? body.description.trim() : undefined;
      const mode = body.mode === "team" ? "team" : body.mode === "none" ? "none" : "lead";
      const targetWorkspace = rawWorkspace
        ? path.isAbsolute(rawWorkspace)
          ? rawWorkspace
          : path.resolve(path.dirname(process.cwd()), rawWorkspace)
        : rawName
          ? path.resolve(path.dirname(process.cwd()), rawName.replace(/[^A-Za-z0-9._-]+/g, "-"))
          : "";
      if (!targetWorkspace) {
        sendJson(response, 400, { error: "Enter a project name or workspace folder path." });
        return;
      }
      try {
        const project = await createProject(
          {
            name: rawName || path.basename(targetWorkspace),
            workspace: targetWorkspace,
            description,
            ensureDirectory: body.ensureDirectory !== false,
          },
          root,
        );
        const settings = await readProviderSettings(root);
        const effectiveEnv = applyProviderSettingsToEnv(settings, env);
        const fleet = mode !== "none"
          ? await bootstrapFleet(project.workspace, mode, root)
          : { created: [], bots: await listBots(root, project.workspace) };
        sendJson(response, 201, {
          ok: true,
          project,
          createdBots: fleet.created.map((bot) => publicBot(bot, effectiveEnv)),
          bots: fleet.bots.map((bot) => publicBot(bot, effectiveEnv)),
        });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not create project." });
      }
      return;
    }
    const deleteProjectMatch = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && deleteProjectMatch) {
      try {
        const deleteBotsFlag = url.searchParams.get("deleteBots") === "1" || body.deleteBots === true;
        await deleteProject(decodeURIComponent(deleteProjectMatch[1] ?? ""), { deleteBots: deleteBotsFlag }, root);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message : "Could not delete project." });
      }
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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenCodingPartner · Project Bot Studio</title>
<style nonce="${token}">
:root{color-scheme:dark;--bg:#0b0f17;--panel:#111722;--panel2:#161f2e;--line:#222e42;--muted:#8b9bb4;--text:#f1f5f9;--accent:#34d399;--accent-fg:#042419;--warn:#fbbf24;--danger:#f87171}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13.5px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{height:54px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 18px;background:#0d131d;flex-shrink:0;gap:12px}
.brand-row{display:flex;align-items:center;gap:14px}
.brand{display:flex;align-items:center;gap:9px}
.mark{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,var(--accent),#38bdf8);color:var(--accent-fg);display:grid;place-items:center;font-weight:900;font-size:14px}
.brand strong{font-size:14px;letter-spacing:-.01em}
.proj-bar{display:flex;align-items:center;gap:6px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:3px 6px 3px 10px}
.proj-bar span{font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.proj-bar select{background:transparent;border:0;color:var(--text);font-weight:700;font-size:13px;padding:4px 6px;width:auto;min-width:170px;cursor:pointer}
.proj-bar select:focus{outline:none}
.top-actions{display:flex;gap:7px;align-items:center}
.studio{display:grid;grid-template-columns:255px minmax(0,1fr) 360px;flex:1;min-height:0;overflow:hidden}
.sidebar{border-right:1px solid var(--line);background:#0d121b;display:flex;flex-direction:column;min-height:0;padding:12px;gap:12px;overflow-y:auto}
.center-col{display:flex;flex-direction:column;min-height:0;background:var(--bg)}
.inspector{border-left:1px solid var(--line);background:#0d121b;display:flex;flex-direction:column;min-height:0}
.sec-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:4px 4px 6px;display:flex;justify-content:space-between;align-items:center}
h1{font-size:15px;margin:0}
h2{font-size:14px;margin:0 0 8px;font-weight:700}
h3{font-size:12px;margin:12px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.sub{color:var(--muted);font-size:12px;margin:0 0 10px}
label{display:grid;gap:4px;font-size:12px;color:#cbd5e1;margin:8px 0}
input,select,textarea{width:100%;background:#090d14;border:1px solid #28354a;border-radius:7px;padding:8px 10px;color:var(--text);font:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
textarea{min-height:68px;resize:vertical}
button{border:0;border-radius:7px;background:var(--accent);color:var(--accent-fg);padding:7px 11px;font-weight:700;font-size:12px;cursor:pointer;transition:all .12s;white-space:nowrap}
button:hover{opacity:.92}
button.secondary{background:#182232;color:var(--text);border:1px solid #2a3950}
button.secondary:hover{border-color:#3e5473}
button.ghost{background:transparent;color:var(--muted);padding:4px 7px;font-weight:600}
button.ghost:hover{color:var(--text);background:#182232}
button.danger{background:#3b1d22;color:#fecaca;border:1px solid #5c2b33}
button.chip{background:#131c2b;color:#cbd5e1;border:1px solid #243349;border-radius:99px;padding:5px 11px;font-weight:500;font-size:12px}
button.chip:hover{border-color:var(--accent);color:var(--accent)}
.row{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.row.spread{justify-content:space-between}
.nav-list{display:grid;gap:4px}
.nav-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid transparent;cursor:pointer;color:#cbd5e1;transition:background .12s}
.nav-item:hover{background:#141d2b}
.nav-item.selected{background:#162234;border-color:#2c4260;color:var(--text)}
.nav-item .nav-main{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.nav-item strong{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav-actions{display:none;gap:3px}
.nav-item:hover .nav-actions{display:flex}
.meta{font-size:11px;color:var(--muted)}
.pill{font-size:10.5px;border:1px solid #293b52;background:#111a27;padding:1px 7px;border-radius:99px;color:var(--accent);white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
.pill.wait{color:var(--warn);border-color:#5c4822;background:#211a0d}
.pill.role{color:#93c5fd;border-color:#233b5c;background:#101c2e}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block;flex-shrink:0}
.dot.busy{background:#38bdf8;box-shadow:0 0 8px #38bdf8}
.dot.wait{background:var(--warn);box-shadow:0 0 8px var(--warn)}
.chat-head{height:52px;padding:0 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:10px;background:#0e141f;flex-shrink:0}
.chat-feed{flex:1;padding:18px 22px;overflow-y:auto;display:grid;gap:14px;align-content:start}
.welcome-box{border:1px solid #223247;border-radius:11px;padding:14px 16px;background:#101824}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.turn{display:grid;gap:8px}
.msg-user{justify-self:end;max-width:80%;background:#19273c;border:1px solid #2b4162;border-radius:12px 12px 3px 12px;padding:9px 13px}
.msg-bot{justify-self:stretch;background:var(--panel);border:1px solid var(--line);border-radius:12px 12px 12px 3px;padding:12px 15px;cursor:pointer;transition:border-color .12s}
.msg-bot:hover,.msg-bot.selected{border-color:#385173}
.msg-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:5px;font-size:11px;color:var(--muted)}
.msg-head strong{color:var(--text);font-size:13px;display:inline-flex;align-items:center;gap:6px}
.composer{padding:12px 18px;border-top:1px solid var(--line);background:#0d131d;flex-shrink:0}
.composer-bar{display:flex;gap:10px;align-items:center;margin-bottom:7px;font-size:12px;color:var(--muted)}
.composer-bar select{width:auto;padding:4px 8px;font-size:12px;background:#131c2b}
.composer-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:stretch}
.composer-row textarea{min-height:46px;max-height:140px;margin:0}
.composer-row button{padding:0 18px}
.activity{display:grid;gap:5px;margin:6px 0}
.event{font-size:11px;padding:5px 8px;border-left:2px solid #38bdf8;background:#0b1018;color:#cbd5e1;border-radius:0 5px 5px 0}
.event time{color:var(--muted);font-size:10px;margin-right:6px}
details.tools-fold{margin:6px 0;border:1px solid #1e2a3c;border-radius:7px;background:#0b1018;padding:5px 9px;font-size:11.5px;color:var(--muted)}
details.tools-fold summary{cursor:pointer;font-weight:600;color:#93c5fd}
.approval{border:1px solid #785c26;background:#221c10;border-radius:9px;padding:11px;margin:8px 0}
.approval h3{font-size:12.5px;margin:0 0 4px;color:var(--warn);text-transform:none}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:#070a0f;border:1px solid var(--line);border-radius:7px;padding:9px;max-height:280px;overflow:auto;margin:6px 0}
.result{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}
.status{color:var(--muted);font-size:11.5px;min-height:15px;margin-top:4px}
.tabs{display:flex;border-bottom:1px solid var(--line);background:#0b1018;padding:0 8px;flex-shrink:0;overflow-x:auto}
.tab{background:transparent;color:var(--muted);border:0;border-bottom:2px solid transparent;border-radius:0;padding:11px 10px;font-size:12px;font-weight:600}
.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.drawer-body{flex:1;padding:14px;overflow-y:auto}
.screen-wrap{position:relative;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:#05080c;margin:8px 0}
.screen-wrap img{display:block;width:100%;height:auto;cursor:crosshair}
.proj-meta-card{background:#121a27;border:1px solid #223147;border-radius:9px;padding:9px 11px}
.proj-meta-card strong{display:block;font-size:13px}
.sidebar-foot{margin-top:auto;padding-top:10px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;flex-wrap:wrap;gap:5px}
.hidden{display:none!important}
@media(max-width:1100px){.studio{grid-template-columns:220px minmax(0,1fr) 310px}}
@media(max-width:820px){body{overflow:auto;height:auto}.studio{grid-template-columns:1fr}}
</style></head><body>
<header>
  <div class="brand-row">
    <div class="brand">
      <div class="mark">O</div>
      <strong>OpenCodingPartner</strong>
    </div>
    <div class="proj-bar">
      <span>◈ Project</span>
      <select id="projectSelect" title="Switch active project &amp; its bot team"></select>
      <button type="button" class="ghost" id="openNewProjectBtn" title="Create or add a project">+ New Project</button>
    </div>
  </div>
  <div class="top-actions">
    <button type="button" id="spawnTeamBtn" title="Ensure Ada, Linus, Grace, Sentinel &amp; Atlas exist in this project">⚡ Spawn Project Team</button>
    <button type="button" class="secondary" id="openComputerTopBtn">▣ Computer</button>
    <button type="button" class="secondary" id="openNewBotBtn">+ New Bot</button>
    <button type="button" class="secondary" id="openSettingsBtn">⚙ API Keys</button>
  </div>
</header>

<main class="studio">
  <aside class="sidebar">
    <div class="proj-meta-card" id="activeProjectCard"></div>

    <div>
      <div class="sec-label"><span>Project Room</span></div>
      <div id="channelTeamHq" class="nav-item selected">
        <div class="nav-main">
          <strong>#</strong>
          <div>
            <strong>project-hq</strong>
            <div class="meta">All bots · Ada orchestrates</div>
          </div>
        </div>
      </div>
    </div>

    <div style="flex:1;min-height:0;display:flex;flex-direction:column">
      <div class="sec-label">
        <span>Project Bots</span>
        <button type="button" class="ghost" id="sidebarAddBotBtn">+ Add</button>
      </div>
      <div id="bots" class="nav-list"></div>
    </div>

    <div class="sidebar-foot" id="health">Checking OCP Agent &amp; OCP Coder…</div>
  </aside>

  <section class="center-col">
    <div class="chat-head">
      <div>
        <h1 id="activeRoomTitle"># project-hq</h1>
        <div class="meta" id="activeRoomSub">Shared project room · Ask Ada to create bots, delegate tasks, or @mention any bot.</div>
      </div>
      <div class="row">
        <button type="button" class="secondary hidden" id="allRoomBtn">← Back to #project-hq</button>
        <button type="button" class="ghost" id="refresh" title="Refresh state">↻ Refresh</button>
      </div>
    </div>

    <div id="chatFeed" class="chat-feed"></div>

    <div class="composer">
      <form id="taskForm">
        <div class="composer-bar">
          <span>To:</span>
          <select name="botId" id="botSelect" required></select>
          <span>QA Review:</span>
          <select name="reviewerBotId" id="reviewerSelect"><option value="">None</option></select>
          <span id="taskStatus" class="status"></span>
        </div>
        <div class="composer-row">
          <textarea name="prompt" id="promptInput" required placeholder="Message Ada or @mention a bot in this project… (Enter to send, Shift+Enter for newline)"></textarea>
          <button>Send ↵</button>
        </div>
      </form>
    </div>
  </section>

  <aside class="inspector">
    <div class="tabs">
      <button type="button" class="tab active" data-tab="detail">≡ Inspector</button>
      <button type="button" class="tab" data-tab="computer">▣ Computer</button>
      <button type="button" class="tab" data-tab="bot">+ Bot</button>
      <button type="button" class="tab" data-tab="project">◈ Project</button>
      <button type="button" class="tab" data-tab="settings">⚙ Keys</button>
    </div>

    <div class="drawer-body">
      <div id="tab-detail" class="tab-pane">
        <div id="detail"></div>
        <details style="margin-top:14px">
          <summary class="meta" style="cursor:pointer;font-weight:600">Recent project tasks (<span id="taskCount">0</span>)</summary>
          <div id="tasks" class="nav-list" style="margin-top:8px"></div>
        </details>
      </div>

      <div id="tab-computer" class="tab-pane hidden">
        <div id="computerPanel"></div>
      </div>

      <div id="tab-bot" class="tab-pane hidden">
        <h2 id="botFormTitle">Add Bot to Project</h2>
        <p class="sub">Each project has its own group of bots (OCP Agent or OCP Coder).</p>
        <form id="botForm">
          <input type="hidden" name="botId">
          <label>Bot Name<input name="name" required placeholder="e.g. Linus, Grace, Nova"></label>
          <div class="row">
            <label style="flex:1">Role<select name="role"><option value="general">general (Orchestrator)</option><option value="coding">coding (Coder)</option><option value="qa">qa (Reviewer)</option><option value="security">security (Auditor)</option><option value="research">research</option><option value="computer">computer</option></select></label>
            <label style="flex:1">Runtime<select name="runtime"><option value="ocp-agent">OCP Agent</option><option value="ocp-coder">OCP Coder</option></select></label>
          </div>
          <label>Instructions (optional)<textarea name="instructions" placeholder="Leave blank for role default instructions…"></textarea></label>
          <details style="margin:8px 0;padding:8px;border:1px solid var(--line);border-radius:7px">
            <summary class="meta" style="cursor:pointer;font-weight:600">Advanced Project Path, Sandbox &amp; Model Override</summary>
            <label>Project Workspace Path<input name="workspace" required value="${escapeAttribute(process.cwd())}"></label>
            <label>Tool Isolation<select name="isolation"><option value="host">Host process (fast local)</option><option value="docker">Docker container sandbox</option></select></label>
            <label id="networkField" class="hidden">Docker Network<select name="network"><option value="disabled">Disabled</option><option value="enabled">Enabled</option></select></label>
            <label>Provider Override<select name="provider"><option value="">Use global API key / default</option><option value="openrouter">OpenRouter</option><option value="litellm">LiteLLM</option></select></label>
            <label class="provider-field hidden">Model ID<input name="model" placeholder="openai/gpt-4.1-mini"></label>
            <label class="provider-field hidden">LiteLLM Endpoint<input name="endpoint" placeholder="http://127.0.0.1:4000/v1"></label>
            <label class="provider-field hidden">API Key Env<input name="apiKeyEnv" value="LITELLM_API_KEY"></label>
          </details>
          <div class="row" style="margin-top:10px">
            <button id="botSubmit">Save Bot</button>
            <button id="botEditCancel" type="button" class="secondary hidden">Reset</button>
          </div>
        </form>
        <div id="botStatus" class="status"></div>
      </div>

      <div id="tab-project" class="tab-pane hidden">
        <h2>New Project / Product</h2>
        <p class="sub">Every project gets its own workspace directory and its own dedicated team of bots.</p>
        <form id="projectForm">
          <label>Project / Product Name<input name="name" required placeholder="e.g. MobileApp, PaymentsAPI, SaaS-Landing"></label>
          <label>Workspace Folder Path (optional)<input name="workspace" placeholder="Leave blank to create folder automatically"></label>
          <label>Description (optional)<input name="description" placeholder="Short summary of this product"></label>
          <label>Starter Bot Team<select name="mode">
            <option value="team">⚡ Full 5-Bot Team (Ada, Linus, Grace, Sentinel, Atlas)</option>
            <option value="lead">✦ Lead Orchestrator Only (Ada)</option>
            <option value="none">Empty (Add bots manually)</option>
          </select></label>
          <button type="submit" style="margin-top:6px">Create Project &amp; Team</button>
        </form>
        <div id="projectStatus" class="status"></div>
      </div>

      <div id="tab-settings" class="tab-pane hidden">
        <h2>⚙ API Keys &amp; Local GPU</h2>
        <p class="sub">Switch to your local NVIDIA GPU (Ollama) in one click, or save cloud provider keys locally (mode 0600).</p>
        <div class="row" style="margin-bottom:10px">
          <button type="button" id="useLocalGpuBtn">⚡ Use Local GPU (gemma4:latest)</button>
          <button type="button" class="secondary" id="useOpenRouterPresetBtn">✦ Use OpenRouter</button>
        </div>
        <form id="settingsForm">
          <label>OpenRouter API Key<input type="password" name="openrouterApiKey" placeholder="sk-or-v1-..."></label>
          <label>OpenAI API Key<input type="password" name="openaiApiKey" placeholder="sk-..."></label>
          <label>LiteLLM / Custom API Key<input type="password" name="litellmApiKey" placeholder="sk-..."></label>
          <label>LiteLLM / Ollama Base URL<input name="litellmBaseUrl" placeholder="http://127.0.0.1:11434/v1"></label>
          <label>Default Model ID<input name="defaultModel" placeholder="gemma4:latest or openai/gpt-4.1-mini"></label>
          <button type="submit">Save &amp; Apply Immediately</button>
        </form>
        <div id="settingsStatus" class="status"></div>
      </div>
    </div>
  </aside>
</main>

<script nonce="${token}">const TOKEN='${token}',DEFAULT_WS='${escapeJs(process.cwd())}';let state={projects:[],bots:[],tasks:[]},activeWorkspace='',selected='',conversationBot='',computerBot='',computerMeta=null,bootstrapped=false,activeTab='detail';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isAgentRuntime=r=>r==='ocp-agent'||r==='hermes';
const runtimeLabel=r=>isAgentRuntime(r)?'OCP Agent':'OCP Coder';
const roleIcon=r=>({general:'✦',coding:'⚡',qa:'✔',security:'◆',research:'◎',computer:'▣'}[r]||'●');

function setTab(tabName){
  activeTab=tabName;
  document.querySelectorAll('.tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===tabName));
  document.querySelectorAll('.tab-pane').forEach(pane=>pane.classList.toggle('hidden',pane.id!=='tab-'+tabName));
}
document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>setTab(btn.dataset.tab)));

async function api(url,body,method){
  const r=await fetch(url,{method:method||(body?'POST':'GET'),headers:body?{'content-type':'application/json','x-ocp-token':TOKEN}:{},body:body?JSON.stringify(body):undefined});
  const data=await r.json();
  if(!r.ok)throw Error(data.error||'Request failed');
  return data;
}

function projectBots(){
  if(!activeWorkspace)return state.bots;
  return state.bots.filter(b=>b.workspace===activeWorkspace);
}

function projectTasks(){
  const botIds=new Set(projectBots().map(b=>b.id));
  return state.tasks.filter(t=>botIds.has(t.botId)||botIds.has(t.reviewerBotId));
}

async function load(){
  state=await api('/api/state');
  if(!bootstrapped&&state.bots.length===0){
    bootstrapped=true;
    try{await api('/api/bootstrap',{mode:'lead',workspace:DEFAULT_WS});state=await api('/api/state')}catch{}
  }
  const workspaces=(state.projects||[]).map(p=>p.workspace);
  if(!activeWorkspace||(!workspaces.includes(activeWorkspace)&&!state.bots.some(b=>b.workspace===activeWorkspace))){
    activeWorkspace=workspaces[0]||state.bots[0]?.workspace||DEFAULT_WS;
  }
  draw();
}

function showProviderFields(){
  const form=document.querySelector('#botForm'),provider=form.elements.provider.value;
  document.querySelectorAll('.provider-field').forEach(x=>x.classList.toggle('hidden',!provider));
  form.elements.endpoint.parentElement.classList.toggle('hidden',provider!=='litellm');
  form.elements.apiKeyEnv.parentElement.classList.toggle('hidden',provider!=='litellm');
}

function clearBotForm(){
  const form=document.querySelector('#botForm');
  form.reset();
  form.elements.botId.value='';
  form.elements.workspace.value=activeWorkspace||DEFAULT_WS;
  form.elements.isolation.value='host';
  form.elements.runtime.dispatchEvent(new Event('change'));
  document.querySelector('#botFormTitle').textContent='Add Bot to Project';
  document.querySelector('#botSubmit').textContent='Create Bot';
  document.querySelector('#botEditCancel').classList.add('hidden');
  showProviderFields();
}

function editBot(id){
  const bot=state.bots.find(item=>item.id===id);
  if(!bot)return;
  setTab('bot');
  const form=document.querySelector('#botForm');
  form.elements.botId.value=bot.id;
  form.elements.name.value=bot.name;
  form.elements.role.value=bot.role;
  form.elements.runtime.value=isAgentRuntime(bot.runtime)?'ocp-agent':'ocp-coder';
  form.elements.isolation.value=bot.isolation||'host';
  form.elements.network.value=bot.network||'disabled';
  form.elements.workspace.value=bot.workspace;
  form.elements.provider.value=bot.provider||'';
  form.elements.model.value=bot.model||'';
  form.elements.endpoint.value=bot.endpoint||'';
  form.elements.apiKeyEnv.value=bot.apiKeyEnv||'LITELLM_API_KEY';
  form.elements.instructions.value=bot.instructions||'';
  form.elements.runtime.dispatchEvent(new Event('change'));
  document.querySelector('#botFormTitle').textContent='Edit Bot: '+bot.name;
  document.querySelector('#botSubmit').textContent='Save Changes';
  document.querySelector('#botEditCancel').classList.remove('hidden');
  showProviderFields();
}

function draw(){
  const pSelect=document.querySelector('#projectSelect');
  const projects=state.projects?.length?state.projects:[{id:'default',name:DEFAULT_WS.split('/').pop()||'Project',workspace:DEFAULT_WS}];
  pSelect.innerHTML=projects.map(p=>{
    const count=state.bots.filter(b=>b.workspace===p.workspace).length;
    return '<option value="'+esc(p.workspace)+'">'+esc(p.name)+' ('+count+' bots)</option>';
  }).join('');
  if(projects.some(p=>p.workspace===activeWorkspace))pSelect.value=activeWorkspace;
  pSelect.onchange=()=>{
    activeWorkspace=pSelect.value;
    conversationBot='';
    selected='';
    computerBot='';
    document.querySelector('#botForm').elements.workspace.value=activeWorkspace;
    draw();
  };

  const activeProj=projects.find(p=>p.workspace===activeWorkspace)||projects[0];
  const pBots=projectBots();
  const pTasks=projectTasks();
  document.querySelector('#activeProjectCard').innerHTML='<strong>◈ '+esc(activeProj?.name||'Project')+'</strong><div class="meta" style="word-break:break-all">'+esc(activeWorkspace)+'</div>'+(activeProj?.description?'<div class="meta" style="margin-top:3px">'+esc(activeProj.description)+'</div>':'');

  const botsEl=document.querySelector('#bots'),select=document.querySelector('#botSelect'),reviewerSelect=document.querySelector('#reviewerSelect'),chosenBot=select.value,chosenReviewer=reviewerSelect.value;
  document.querySelector('#channelTeamHq').classList.toggle('selected',!conversationBot);
  document.querySelector('#allRoomBtn').classList.toggle('hidden',!conversationBot);

  botsEl.innerHTML=pBots.length?pBots.map(b=>{
    const activeTask=pTasks.find(t=>t.botId===b.id&&['queued','running','awaiting-approval'].includes(t.status));
    const dotClass=activeTask?(activeTask.status==='awaiting-approval'?'wait':'busy'):'';
    return '<div class="nav-item '+(conversationBot===b.id?'selected':'')+'" data-chat-bot="'+esc(b.id)+'"><div class="nav-main"><span class="dot '+dotClass+'"></span><span>'+roleIcon(b.role)+'</span><strong>'+esc(b.name)+'</strong><span class="pill role">'+esc(b.role)+'</span></div><div class="nav-actions"><button type="button" class="ghost" title="Edit bot" data-edit="'+esc(b.id)+'">✎</button><button type="button" class="ghost" title="Delete bot" data-delete-bot="'+esc(b.id)+'">×</button></div></div>';
  }).join(''):'<div class="meta" style="padding:8px">No bots in this project yet. Click <b>⚡ Spawn Project Team</b> above!</div>';

  select.innerHTML=pBots.map(b=>'<option value="'+esc(b.id)+'">'+roleIcon(b.role)+' '+esc(b.name)+' ('+esc(b.role)+')</option>').join('');
  if(conversationBot&&pBots.some(b=>b.id===conversationBot))select.value=conversationBot;
  else if(pBots.some(b=>b.id===chosenBot))select.value=chosenBot;

  const primary=pBots.find(b=>b.id===select.value);
  const reviewers=pBots.filter(b=>(b.role==='qa'||b.role==='security')&&b.id!==primary?.id);
  reviewerSelect.innerHTML='<option value="">None</option>'+reviewers.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+' ('+esc(b.role)+')</option>').join('');
  if(reviewers.some(b=>b.id===chosenReviewer))reviewerSelect.value=chosenReviewer;
  select.onchange=draw;

  document.querySelectorAll('[data-edit]').forEach(el=>el.addEventListener('click',e=>{e.stopPropagation();editBot(el.dataset.edit)}));
  document.querySelectorAll('[data-chat-bot]').forEach(el=>el.addEventListener('click',()=>{conversationBot=el.dataset.chatBot;select.value=conversationBot;draw()}));
  document.querySelectorAll('[data-delete-bot]').forEach(el=>el.addEventListener('click',async e=>{
    e.stopPropagation();
    const bot=state.bots.find(item=>item.id===el.dataset.deleteBot);
    if(!bot||!confirm('Remove '+bot.name+' from this project?'))return;
    try{await api('/api/bots/'+encodeURIComponent(bot.id),{},'DELETE');if(conversationBot===bot.id)conversationBot='';await load()}catch(error){alert(error.message)}
  }));

  document.querySelector('#taskCount').textContent=String(pTasks.length);
  document.querySelector('#tasks').innerHTML=pTasks.length?pTasks.map(t=>{
    const b=state.bots.find(x=>x.id===t.botId);
    return '<div class="nav-item '+(selected===t.id?'selected':'')+'" data-task="'+esc(t.id)+'"><div class="nav-main"><strong>'+esc(t.prompt.slice(0,55))+'</strong></div><span class="pill '+(t.status==='awaiting-approval'?'wait':'')+'">'+esc(b?.name||'')+' · '+esc(t.status)+'</span></div>';
  }).join(''):'<div class="meta">No tasks in this project yet.</div>';
  document.querySelectorAll('[data-task]').forEach(el=>el.addEventListener('click',()=>{selected=el.dataset.task;draw();drawDetail()}));

  drawChatFeed(activeProj,pBots,pTasks);
  drawComputer(pBots);
  drawDetail(pTasks);
}

function drawChatFeed(activeProj,pBots,pTasks){
  const feed=document.querySelector('#chatFeed'),activeBot=pBots.find(b=>b.id===conversationBot);
  document.querySelector('#activeRoomTitle').textContent=activeBot?(roleIcon(activeBot.role)+' '+activeBot.name+' · '+activeBot.role+' ('+runtimeLabel(activeBot.runtime)+')'):'# project-hq · '+(activeProj?.name||'Project');
  document.querySelector('#activeRoomSub').textContent=activeBot?('Direct 1-on-1 session in '+activeWorkspace):('All '+pBots.length+' bots in this project · Lead Bot (Ada) creates bots & delegates work');
  const visibleTasks=(activeBot?pTasks.filter(t=>t.botId===activeBot.id||t.reviewerBotId===activeBot.id):pTasks).slice().sort((a,b)=>a.createdAt.localeCompare(b.createdAt));

  const quickChips='<div class="welcome-box"><div class="row spread"><strong>✦ '+esc(activeProj?.name||'Project')+' Bot Team</strong><span class="meta">Quick prompts</span></div><div class="chips"><button type="button" class="chip" data-quick="Spin up a full team of bots for this project">⚡ Spin up full project team</button><button type="button" class="chip" data-quick="List all bots in this project and their roles">≡ List project bots</button><button type="button" class="chip" data-quick="Create a research bot named Nova and ask Nova to summarize package.json">+ Create Nova &amp; delegate research</button><button type="button" class="chip" data-quick="Inspect this project repository and summarize the architecture">◎ Summarize repo architecture</button></div></div>';

  feed.innerHTML=quickChips+(visibleTasks.length?visibleTasks.map(t=>{
    const b=state.bots.find(x=>x.id===t.botId),rev=state.bots.find(x=>x.id===t.reviewerBotId),p=t.pendingApproval,evts=t.events||[];
    const isRunning=t.status==='running'||t.status==='queued';
    const toolsHtml=evts.length?(isRunning?'<div class="activity">'+evts.slice(-4).map(e=>'<div class="event">⚙ '+esc(e.title||e.kind)+'</div>').join('')+'</div>':'<details class="tools-fold"><summary>⚙ '+evts.length+' tool step'+(evts.length===1?'':'s')+' executed</summary><div class="activity" style="margin-top:6px">'+evts.map(e=>'<div class="event">'+esc(e.title||e.kind)+'</div>').join('')+'</div></details>'):'';
    return '<div class="turn"><div class="msg-user"><div class="msg-head"><strong>You → @'+esc(b?.name||t.botId)+(rev?' (QA: @'+esc(rev.name)+')':'')+'</strong><span>'+esc(new Date(t.createdAt).toLocaleTimeString())+'</span></div><div class="result">'+esc(t.prompt)+'</div></div><div class="msg-bot '+(selected===t.id?'selected':'')+'" data-select-turn="'+esc(t.id)+'"><div class="msg-head"><strong>'+roleIcon(b?.role||'general')+' '+esc(b?.name||t.botId)+' <span class="pill role">'+esc(b?.role||'bot')+'</span></strong><span class="pill '+(t.status==='awaiting-approval'?'wait':'')+'">'+esc(t.status)+'</span></div>'+toolsHtml+(p?'<div class="approval"><h3>! Approval needed: '+esc(p.title)+'</h3>'+(p.description?'<div class="meta" style="margin-bottom:8px">'+esc(p.description)+'</div>':'')+'<div class="row"><button type="button" data-inline-approve="'+esc(t.id)+'" data-req="'+esc(p.id)+'">Allow once</button><button type="button" class="secondary" data-inline-deny="'+esc(t.id)+'" data-req="'+esc(p.id)+'">Deny</button></div></div>':'')+(t.result?'<div class="result">'+esc(t.result)+'</div>':(isRunning?'<div class="meta">Working…</div>':''))+(t.error?'<div class="result" style="color:var(--danger)">'+esc(t.error)+'</div>':'')+(t.workspaceChanges?.files?.length?'<div class="meta" style="margin-top:8px">◈ Changed: '+t.workspaceChanges.files.map(f=>esc(f.path)).join(', ')+'</div>':'')+'</div></div>';
  }).join(''):'');

  document.querySelectorAll('[data-quick]').forEach(el=>el.addEventListener('click',()=>{const inp=document.querySelector('#promptInput');inp.value=el.dataset.quick;inp.focus()}));
  document.querySelectorAll('[data-select-turn]').forEach(el=>el.addEventListener('click',()=>{selected=el.dataset.selectTurn;setTab('detail');drawDetail(pTasks)}));
  document.querySelectorAll('[data-inline-approve]').forEach(el=>el.addEventListener('click',async e=>{e.stopPropagation();await api('/api/tasks/'+encodeURIComponent(el.dataset.inlineApprove)+'/approval',{requestId:el.dataset.req,approved:true});await load()}));
  document.querySelectorAll('[data-inline-deny]').forEach(el=>el.addEventListener('click',async e=>{e.stopPropagation();await api('/api/tasks/'+encodeURIComponent(el.dataset.inlineDeny)+'/approval',{requestId:el.dataset.req,approved:false});await load()}));
}

async function refreshComputer(capture){
  const pBots=projectBots();
  if((!computerBot||!pBots.some(b=>b.id===computerBot))&&pBots[0])computerBot=pBots[0].id;
  if(!computerBot)return;
  try{computerMeta=await api('/api/bots/'+encodeURIComponent(computerBot)+'/computer'+(capture?'?refresh=1':''));drawComputer(pBots)}catch(e){computerMeta={detail:e.message};drawComputer(pBots)}
}

function drawComputer(pBots){
  const panel=document.querySelector('#computerPanel');
  const bot=pBots.find(item=>item.id===computerBot)||pBots[0];
  if(!bot){panel.innerHTML='<p class="sub">Spawn a bot in this project first to use the Virtual Computer.</p>';return}
  computerBot=bot.id;
  const m=computerMeta||{display:':50',width:1280,height:800,control:'partner',status:'live'};
  const held=m.control==='human';
  panel.innerHTML='<div class="row spread" style="margin-bottom:6px"><div><h2>🖥️ Virtual Computer ('+esc(m.display||':50')+')</h2><div class="meta">Click screen to interact · Active bot: '+esc(bot.name)+'</div></div><span class="pill '+(held?'wait':'')+'">'+esc(m.control||'partner')+'</span></div><div class="row"><button type="button" id="compRefresh" class="secondary">↻ Refresh</button>'+(held?'<button type="button" id="compReturn">Return control</button>':'<button type="button" id="compTakeover" class="secondary">Take over</button>')+'<button type="button" id="compScrollUp" class="secondary">↑</button><button type="button" id="compScrollDown" class="secondary">↓</button></div><div class="screen-wrap"><img id="computerScreenImg" src="/api/bots/'+encodeURIComponent(bot.id)+'/computer/frame?t='+(m.frameMtimeMs||Date.now())+'" alt="Virtual computer screen"></div><div class="row" style="flex-wrap:nowrap"><input id="compUrlInput" placeholder="https://example.com" value="'+esc(m.lastUrl||'')+'"><button type="button" id="compOpenUrl">Open URL</button></div><div class="row" style="margin-top:6px"><input id="compTypeInput" placeholder="Type text…" style="flex:1"><button type="button" id="compTypeBtn">Type</button><button type="button" class="secondary" data-comp-key="Return">↵</button><button type="button" class="secondary" data-comp-key="BackSpace">⌫</button></div><div class="status" id="compStatus">'+esc(m.detail||'')+'</div>';
  document.querySelector('#compRefresh').addEventListener('click',()=>refreshComputer(true));
  document.querySelector('#compTakeover')?.addEventListener('click',async()=>{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'takeover'});drawComputer(pBots)});
  document.querySelector('#compReturn')?.addEventListener('click',async()=>{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'return'});drawComputer(pBots)});
  document.querySelector('#compScrollUp').addEventListener('click',async()=>{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'mouse',action:'scroll',direction:'up',amount:4});drawComputer(pBots)});
  document.querySelector('#compScrollDown').addEventListener('click',async()=>{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'mouse',action:'scroll',direction:'down',amount:4});drawComputer(pBots)});
  document.querySelector('#compOpenUrl').addEventListener('click',async()=>{const u=document.querySelector('#compUrlInput').value.trim();if(!u)return;document.querySelector('#compStatus').textContent='Opening URL…';try{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'browser',url:u});drawComputer(pBots)}catch(e){document.querySelector('#compStatus').textContent=e.message}});
  document.querySelector('#compTypeBtn').addEventListener('click',async()=>{const t=document.querySelector('#compTypeInput').value;if(!t)return;try{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'keyboard',action:'type',text:t});drawComputer(pBots)}catch(e){document.querySelector('#compStatus').textContent=e.message}});
  document.querySelectorAll('[data-comp-key]').forEach(el=>el.addEventListener('click',async()=>{try{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'keyboard',action:'key',key:el.dataset.compKey});drawComputer(pBots)}catch(e){document.querySelector('#compStatus').textContent=e.message}}));
  document.querySelector('#computerScreenImg').addEventListener('click',async e=>{const rect=e.target.getBoundingClientRect();const w=m.width||1280,h=m.height||800;const x=Math.round((e.clientX-rect.left)/rect.width*w);const y=Math.round((e.clientY-rect.top)/rect.height*h);document.querySelector('#compStatus').textContent='Clicking ('+x+', '+y+')…';try{computerMeta=await api('/api/bots/'+encodeURIComponent(bot.id)+'/computer',{kind:'mouse',action:'click',x,y});drawComputer(pBots)}catch(err){document.querySelector('#compStatus').textContent=err.message}});
}

function drawDetail(pTasks){
  const panel=document.querySelector('#detail'),tasks=pTasks||projectTasks(),t=tasks.find(x=>x.id===selected)||tasks[0];
  if(!t){panel.innerHTML='<h2>Turn &amp; Diff Inspector</h2><p class="sub">Click any message in the chat to inspect its tool timeline, modified files, and Git diff.</p>';return}
  const b=state.bots.find(x=>x.id===t.botId),reviewer=state.bots.find(x=>x.id===t.reviewerBotId),agents=t.agents||[],p=t.pendingApproval;
  panel.innerHTML='<div class="row spread"><div><h2>'+esc(b?.name||t.botId)+' · '+esc(t.status)+'</h2><div class="meta">'+(reviewer?'Reviewed by '+esc(reviewer.name)+' · ':'')+esc(new Date(t.createdAt).toLocaleTimeString())+'</div></div><div class="row">'+(t.status==='running'||t.status==='awaiting-approval'||t.status==='queued'?'<button id="cancel" class="danger">Cancel</button>':((b&&['failed','cancelled','needs-attention'].includes(t.status))?'<button id="retry" class="secondary">Retry</button>':'')+'<button id="delete" class="ghost">Delete</button>')+'</div></div>'+(agents.length?'<div class="meta" style="margin-top:4px">Pipeline: '+agents.map(a=>esc(a.name)+' ('+esc(a.role)+')').join(' → ')+'</div>':'')+(p?'<div class="approval"><h3>Approval needed: '+esc(p.title)+'</h3>'+(p.description?'<p>'+esc(p.description)+'</p>':'')+'<div class="row"><button id="approve">Allow once</button><button id="deny" class="secondary">Deny</button></div></div>':'')+'<h3>Tool &amp; Handoff Timeline</h3><div class="activity">'+(t.events?.length?t.events.slice().reverse().map(e=>'<div class="event"><time>'+esc(new Date(e.createdAt).toLocaleTimeString())+'</time>'+esc(e.title||e.kind)+'</div>').join(''):'<div class="meta">No tool events recorded.</div>')+'</div>'+(t.workspaceChanges?'<h3>Workspace Changes</h3>'+(t.workspaceChanges.available?'<div class="activity">'+t.workspaceChanges.files.map(f=>'<div class="event"><button type="button" class="secondary" data-workspace-file="'+esc(f.path)+'">'+esc(f.status)+' · '+esc(f.path)+'</button></div>').join('')+'</div><div id="workspaceFileView"></div>':'<p class="meta">'+esc(t.workspaceChanges.diffOmittedReason||'No Git changes.')+'</p>')+(t.workspaceChanges.diff?'<details open><summary class="meta" style="cursor:pointer;font-weight:600">Git Diff</summary><pre>'+esc(t.workspaceChanges.diff)+'</pre></details>':''):'');
  document.querySelectorAll('[data-workspace-file]').forEach(el=>el.addEventListener('click',async()=>{const view=document.querySelector('#workspaceFileView'),filePath=el.dataset.workspaceFile;view.innerHTML='<p class="meta">Loading file…</p>';try{const file=await api('/api/workspace/file?botId='+encodeURIComponent(t.botId)+'&path='+encodeURIComponent(filePath));view.innerHTML='<h3>'+esc(filePath)+'</h3><pre>'+esc(file.content)+'</pre>'}catch(error){view.innerHTML='<p class="meta">'+esc(error.message)+'</p>'}}));
  const action=async(what,body)=>{try{await api('/api/tasks/'+encodeURIComponent(t.id)+'/'+what,body);await load()}catch(e){alert(e.message)}};
  document.querySelector('#approve')?.addEventListener('click',()=>action('approval',{requestId:p.id,approved:true}));
  document.querySelector('#deny')?.addEventListener('click',()=>action('approval',{requestId:p.id,approved:false}));
  document.querySelector('#cancel')?.addEventListener('click',()=>action('cancel',{}));
  document.querySelector('#retry')?.addEventListener('click',async()=>{try{const created=await api('/api/tasks',{botId:t.botId,reviewerBotId:t.reviewerBotId||'',prompt:t.prompt});selected=created.taskId;await load()}catch(error){alert(error.message)}});
  document.querySelector('#delete')?.addEventListener('click',async()=>{try{await api('/api/tasks/'+encodeURIComponent(t.id),{},'DELETE');if(selected===t.id)selected='';await load()}catch(e){alert(e.message)}});
}

document.querySelector('#channelTeamHq').addEventListener('click',()=>{conversationBot='';draw()});
document.querySelector('#allRoomBtn').addEventListener('click',()=>{conversationBot='';draw()});
document.querySelector('#spawnTeamBtn').addEventListener('click',async()=>{try{await api('/api/bootstrap',{mode:'team',workspace:activeWorkspace||DEFAULT_WS});await load()}catch(e){alert(e.message)}});
document.querySelector('#openComputerTopBtn').addEventListener('click',async()=>{setTab('computer');await refreshComputer(true)});
document.querySelector('#openNewBotBtn').addEventListener('click',()=>{clearBotForm();setTab('bot');document.querySelector('#botForm').elements.name.focus()});
document.querySelector('#sidebarAddBotBtn').addEventListener('click',()=>{clearBotForm();setTab('bot');document.querySelector('#botForm').elements.name.focus()});
document.querySelector('#openNewProjectBtn').addEventListener('click',()=>{setTab('project');document.querySelector('#projectForm').elements.name.focus()});
document.querySelector('#openSettingsBtn').addEventListener('click',async()=>{setTab('settings');try{const s=await api('/api/settings');const f=document.querySelector('#settingsForm');f.elements.litellmBaseUrl.value=s.litellmBaseUrl||'';f.elements.defaultModel.value=s.defaultModel||''}catch{}});

document.querySelector('#projectForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const f=new FormData(e.target),body=Object.fromEntries(f.entries());
  try{
    const res=await api('/api/projects',body,'POST');
    e.target.reset();
    activeWorkspace=res.project.workspace;
    conversationBot='';
    selected='';
    document.querySelector('#projectStatus').textContent='Created project '+res.project.name+' with '+res.bots.length+' bot(s)!';
    await load();
  }catch(err){document.querySelector('#projectStatus').textContent=err.message}
});

document.querySelector('#useLocalGpuBtn').addEventListener('click',async()=>{
  const f=document.querySelector('#settingsForm');
  f.elements.litellmBaseUrl.value='http://127.0.0.1:11434/v1';
  f.elements.defaultModel.value='gemma4:latest';
  try{
    await api('/api/settings',{litellmBaseUrl:'http://127.0.0.1:11434/v1',defaultModel:'gemma4:latest'},'POST');
    document.querySelector('#settingsStatus').textContent='Switched to Local GPU (gemma4:latest via Ollama)!';
    await load();await showHealth();
  }catch(err){document.querySelector('#settingsStatus').textContent=err.message}
});
document.querySelector('#useOpenRouterPresetBtn').addEventListener('click',async()=>{
  const f=document.querySelector('#settingsForm');
  f.elements.litellmBaseUrl.value='';
  f.elements.defaultModel.value='openai/gpt-4.1-mini';
  try{
    await api('/api/settings',{litellmBaseUrl:'',defaultModel:'openai/gpt-4.1-mini'},'POST');
    document.querySelector('#settingsStatus').textContent='Switched to OpenRouter!';
    await load();await showHealth();
  }catch(err){document.querySelector('#settingsStatus').textContent=err.message}
});
document.querySelector('#settingsForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const f=new FormData(e.target),body=Object.fromEntries(f.entries());
  try{await api('/api/settings',body,'POST');document.querySelector('#settingsStatus').textContent='Saved & applied immediately!';await load();await showHealth()}catch(err){document.querySelector('#settingsStatus').textContent=err.message}
});

document.querySelector('#botForm').elements.provider.addEventListener('change',showProviderFields);
document.querySelector('#botForm').elements.runtime.addEventListener('change',e=>{
  const form=document.querySelector('#botForm'),agent=isAgentRuntime(e.target.value);
  form.elements.isolation.parentElement.classList.toggle('hidden',!agent);
  if(!agent)form.elements.network.value='disabled';
  form.elements.network.parentElement.classList.toggle('hidden',!agent||form.elements.isolation.value!=='docker');
  showProviderFields();
});
document.querySelector('#botForm').elements.isolation.addEventListener('change',e=>{
  const form=document.querySelector('#botForm');
  if(e.target.value!=='docker')form.elements.network.value='disabled';
  form.elements.network.parentElement.classList.toggle('hidden',!isAgentRuntime(form.elements.runtime.value)||e.target.value!=='docker');
});
document.querySelector('#botEditCancel').addEventListener('click',clearBotForm);
document.querySelector('#botForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const f=new FormData(e.target),provider=f.get('provider');
  const body=Object.fromEntries(f.entries());
  body.provider=provider;
  if(!body.workspace)body.workspace=activeWorkspace||DEFAULT_WS;
  if(!provider)body.model='';
  if(provider!=='litellm'){delete body.endpoint;delete body.apiKeyEnv}
  try{
    const botId=String(f.get('botId')||'');
    await api(botId?'/api/bots/'+encodeURIComponent(botId):'/api/bots',body,botId?'PATCH':'POST');
    clearBotForm();
    document.querySelector('#botStatus').textContent=botId?'Bot updated.':'Bot added to project.';
    await load();
  }catch(err){document.querySelector('#botStatus').textContent=err.message}
});

document.querySelector('#promptInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.querySelector('#taskForm').requestSubmit()}});
document.querySelector('#taskForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const f=new FormData(e.target);
  let botId=String(f.get('botId')||'');
  let prompt=String(f.get('prompt')||'').trim();
  const pBots=projectBots();
  const mention=/^@([A-Za-z0-9_-]+)\s+([\s\S]+)$/.exec(prompt);
  if(mention){
    const target=pBots.find(b=>b.name.toLowerCase()===mention[1].toLowerCase());
    if(target){botId=target.id;prompt=mention[2].trim()}
  }
  try{
    const r=await api('/api/tasks',{botId,reviewerBotId:f.get('reviewerBotId'),prompt});
    e.target.prompt.value='';
    selected=r.taskId;
    document.querySelector('#taskStatus').textContent='Sent';
    await load();
  }catch(err){document.querySelector('#taskStatus').textContent=err.message}
});

document.querySelector('#refresh').addEventListener('click',load);
async function showHealth(){
  try{
    const h=await api('/api/health');
    const dot=ok=>'<span class="dot '+(ok?'':'wait')+'"></span>';
    document.querySelector('#health').innerHTML='<span class="pill">'+dot(true)+' '+esc(h.activeBrainLabel||(h.providerConfigured?'OpenRouter / Cloud':'Local Brain'))+'</span><span class="pill">'+dot(h.ocpAgent??h.hermes)+' OCP Agent</span><span class="pill">'+dot(h.ocpCoder??h.grokBuild)+' OCP Coder</span>';
  }catch(e){document.querySelector('#health').textContent=e.message}
}
load().catch(e=>document.querySelector('#tasks').textContent=e.message);
showHealth();
setInterval(()=>load().catch(()=>{}),2000);
setInterval(showHealth,30000);
</script></body></html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeJs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/</g, "\\x3c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
