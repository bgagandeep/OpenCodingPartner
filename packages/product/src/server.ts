import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { readWorkspaceFile } from "./workspace-mcp.js";
import { buildActivity, correctMemory, createResponsibility, createThread, forgetMemory, listAudit, listDenyRules, listMemory, listResponsibilities, listThreads, reachThread, recordAudit, saveDenyRule, scheduleResponsibilityCheck, updateResponsibility } from "./teammate.js";
import { appendTeamsOutbox, appendWhatsappOutbox, createDirectoryUser, executeAguiRun, listAgents, listDirectory, listPages, loginCompanyAssertion, loginDirectory, registerAgent, savePage, setCompanyAssertionSecret } from "./category.js";
import {
  postSlackReply,
  postTelegramReply,
  slackEventMessage,
  verifySlackRequest,
  verifyTelegramRequest,
  telegramUpdateMessage,
} from "@opencodingpartner/gateway";
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
  ensureComputerDisplay,
  captureWorkspaceBaseline,
  collectWorkspaceChanges,
  appendChannelLog,
  listProductHandoffs,
  createProductRoutine,
  createTask,
  findChannelExternal,
  listChannelLog,
  updateChannelLog,
  deleteProductRoutine,
  deleteTask,
  dueProductRoutines,
  findBot,
  findTask,
  isOcpAgentRuntime,
  listBots,
  listProductRoutines,
  listProjects,
  listTasks,
  missingProviderKey,
  productDataDir,
  botComputerIdentity,
  readDesktopState,
  readProviderSettings,
  resetBotComputer,
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
  writeBotMcpServers,
  validBotProvider,
  validBotRole,
  validBotRuntime,
  validBotNetworkMode,
  workspaceHasBusyTask,
  workspacePathsMatch,
  nextQueuedTaskForWorkspace,
  routinesForEvent,
  updateProductRoutine,
  noteRoutineOutcome,
  handOffTask,
  saveTaskAsRoutine,
  unattendedApprovalExpired,
  unattendedApprovalTtlMs,
  type BotMcpServer,
  type KeyboardActionInput,
  type MouseActionInput,
  type PendingTaskApproval,
  type RuntimePermissionRequest,
} from "./index.js";
import { handleOnboardingPost, loadOnboardingView } from "./onboarding.js";
import { probeConnectors, publicConnector, upsertConnectorSnapshot, validateConnectorInput } from "./connectors.js";
import { usageSnapshot } from "./usage.js";
import { deleteMcpSecret, listMcpSecretKeys, mcpSecretKey, readMcpSecret, writeMcpSecret } from "./mcp-secrets.js";
import { createVaultItem, deleteVaultItem, publicVault, VaultError } from "./vault.js";
import { parseActionRules } from "./action-rules.js";
import { createSkill, deleteSkill, exportSkillPack, importSkillGit, importSkillZip, listSkills, SkillError, updateSkill } from "./skills.js";
import { installPlugin, listPlugins, PluginError, uninstallPlugin } from "./plugins.js";
import { approveIssuePlan, IssuePrError, listIssueRuns, openIssuePullRequest, runIssueTests, startIssueRun } from "./issue-pr.js";
import { consumeWebhookReplay, followingRunAt, readWebhookSecret, verifyRoutineWebhook } from "./cron.js";
import { AccountError, completeAccountLogin, deliverMailDraft, disconnectAccount, GOOGLE_SCOPES, MICROSOFT_SCOPES, publicAccounts, saveAccountClient, startAccountLogin } from "./accounts.js";

interface AppOptions {
  host?: string;
  port?: number;
  root?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
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
  const port = options.port ?? 4317;
  const root = options.root ?? productDataDir(options.env);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = resolveBindHost(options.host ?? "127.0.0.1", env);
  const token = randomBytes(32).toString("hex");
  const activeRuns = new Map<string, ActiveRun>();
  const approvalWaiters = new Map<string, ApprovalWaiter>();
  const activeStreams = new Set<ChildProcess>();
  const sseClients = new Set<ServerResponse>();
  let boundPort = port;
  let closing = false;

  function oneHeader(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] ?? "" : value ?? "";
  }

  async function startInboundTask(taskId: string, bot: NonNullable<Awaited<ReturnType<typeof findBot>>>): Promise<void> {
    const current = await findTask(taskId, root);
    if (!current) return;
    if (await workspaceHasBusyTask(bot.workspace, root)) {
      notifySse();
      return;
    }
    const baseline = await captureWorkspaceBaseline(bot.workspace);
    await updateTask(taskId, { status: "running", processId: process.pid }, root);
    launchTask(taskId, bot, undefined, current.prompt, baseline);
    notifySse();
  }

  async function acceptSlackInbound(rawBody: string, timestamp: string | string[] | undefined, signature: string | string[] | undefined): Promise<{ status: number; body: unknown }> {
    const settings = await readProviderSettings(root);
    if (!settings.slackSigningSecret || !settings.slackBotToken) return { status: 409, body: { error: "Slack is not configured." } };
    const verified = verifySlackRequest({
      secret: settings.slackSigningSecret,
      timestamp: oneHeader(timestamp),
      signature: oneHeader(signature),
      rawBody,
      nowMs: Date.now(),
    });
    if (!verified.ok) return { status: 401, body: { error: verified.reason || "Slack signature was rejected." } };
    let parsed: { event_id?: string; event?: { bot_id?: string; subtype?: string; ts?: string } };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      return { status: 400, body: { error: "Slack event was not JSON." } };
    }
    const event = slackEventMessage(rawBody);
    if (!event) return { status: 400, body: { error: "Slack event had no text." } };
    if (event.challenge) return { status: 200, body: { challenge: event.challenge } };
    if (parsed.event?.bot_id || parsed.event?.subtype) return { status: 200, body: { ok: true, ignored: "bot or system message" } };
    const externalId = parsed.event_id || parsed.event?.ts || "";
    if (externalId) {
      const existing = await findChannelExternal("slack", externalId, root);
      if (existing && existing.status !== "failed") return { status: 200, body: { ok: true, duplicate: true } };
    }
    const bot = settings.slackBotId ? await findBot(settings.slackBotId, root) : undefined;
    if (!bot) {
      await appendChannelLog({ channel: "slack", direction: "in", text: event.text, destination: event.channel, thread: event.thread, externalId, status: "failed", error: "No bot is assigned to Slack." }, root);
      notifySse();
      return { status: 200, body: { ok: false, error: "No bot is assigned to Slack." } };
    }
    const task = await createTask({
      botId: bot.id,
      prompt: `Slack message in ${event.channel}:\n${event.text.slice(0, 8_000)}\n\nReply with the message to send back. Do not claim it was sent. A person approves the reply before it leaves this app.`,
      channelOrigin: { channel: "slack", destination: event.channel, thread: event.thread, externalId },
    }, root);
    await appendChannelLog({ channel: "slack", direction: "in", text: event.text, botId: bot.id, taskId: task.id, destination: event.channel, thread: event.thread, externalId, status: "received" }, root);
    await startInboundTask(task.id, bot);
    return { status: 202, body: { ok: true, taskId: task.id } };
  }

  async function acceptTelegramInbound(rawBody: string, secretHeader: string | string[] | undefined): Promise<{ status: number; body: unknown }> {
    const settings = await readProviderSettings(root);
    if (!settings.telegramWebhookSecret || !settings.telegramBotToken) return { status: 409, body: { error: "Telegram is not configured." } };
    const verified = verifyTelegramRequest({ secret: settings.telegramWebhookSecret, header: oneHeader(secretHeader) });
    if (!verified.ok) return { status: 401, body: { error: verified.reason || "Telegram secret was rejected." } };
    let parsed: { update_id?: number; message?: { from?: { is_bot?: boolean } } };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      return { status: 400, body: { error: "Telegram update was not JSON." } };
    }
    const update = telegramUpdateMessage(rawBody);
    if (!update) return { status: 400, body: { error: "Telegram update had no text." } };
    if (parsed.message?.from?.is_bot) return { status: 200, body: { ok: true, ignored: "bot message" } };
    const externalId = parsed.update_id === undefined ? "" : String(parsed.update_id);
    if (externalId) {
      const existing = await findChannelExternal("telegram", externalId, root);
      if (existing && existing.status !== "failed") return { status: 200, body: { ok: true, duplicate: true } };
    }
    const bot = settings.telegramBotId ? await findBot(settings.telegramBotId, root) : undefined;
    if (!bot) {
      await appendChannelLog({ channel: "telegram", direction: "in", text: update.text, destination: update.chatId, thread: update.replyTo, externalId, status: "failed", error: "No bot is assigned to Telegram." }, root);
      notifySse();
      return { status: 200, body: { ok: false, error: "No bot is assigned to Telegram." } };
    }
    const task = await createTask({
      botId: bot.id,
      prompt: `Telegram message in chat ${update.chatId}:\n${update.text.slice(0, 8_000)}\n\nReply with the message to send back. Do not claim it was sent. A person approves the reply before it leaves this app.`,
      channelOrigin: { channel: "telegram", destination: update.chatId, thread: update.replyTo, externalId },
    }, root);
    await appendChannelLog({ channel: "telegram", direction: "in", text: update.text, botId: bot.id, taskId: task.id, destination: update.chatId, thread: update.replyTo, externalId, status: "received" }, root);
    await startInboundTask(task.id, bot);
    return { status: 202, body: { ok: true, taskId: task.id } };
  }

  async function decideChannelDraft(id: string, decision: "allow" | "deny"): Promise<{ ok: boolean; error?: string; status: string }> {
    const entry = (await listChannelLog(root)).find((item) => item.id === id);
    if (!entry || entry.direction !== "out" || entry.status !== "draft") throw new Error("That reply draft is not pending.");
    if (decision === "deny") {
      await updateChannelLog(id, { status: "denied" }, root);
      return { ok: true, status: "denied" };
    }
    if (entry.channel === "whatsapp") {
      await appendWhatsappOutbox(root, entry.text, entry.destination);
      await updateChannelLog(id, { error: "Nothing was sent. The WhatsApp message stayed in the local outbox." }, root);
      return { ok: true, status: "draft" };
    }
    if (entry.channel === "teams") {
      await appendTeamsOutbox(root, entry.text, entry.destination);
      await updateChannelLog(id, { error: "Nothing was sent. The Teams message stayed in the local outbox." }, root);
      return { ok: true, status: "draft" };
    }
    if (entry.channel === "gmail" || entry.channel === "outlook") {
      const posted = await deliverMailDraft(root, entry.channel, entry.destination, entry.subject ?? "", entry.text, env);
      if (!posted.ok) {
        const detail = posted.detail ?? "Send failed.";
        await updateChannelLog(id, { status: "failed", error: detail }, root);
        return { ok: false, status: "failed", error: detail };
      }
      await updateChannelLog(id, { status: "sent" }, root);
      return { ok: true, status: "sent" };
    }
    const settings = await readProviderSettings(root);
    const posted = entry.channel === "slack"
      ? await postSlackReply(settings.slackBotToken ?? "", entry.destination, entry.text, entry.thread ?? "", fetchImpl)
      : await postTelegramReply(settings.telegramBotToken ?? "", entry.destination, entry.text, entry.thread ?? "", fetchImpl);
    if (!posted.ok) {
      await updateChannelLog(id, { status: "failed", error: posted.detail }, root);
      return { ok: false, status: "failed", error: posted.detail };
    }
    await updateChannelLog(id, { status: "sent" }, root);
    return { ok: true, status: "sent" };
  }

  function notifySse(kind = "state"): void {
    const chunk = `event: ${kind}\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`;
    for (const client of sseClients) {
      if (client.writableEnded) {
        sseClients.delete(client);
        continue;
      }
      try {
        client.write(chunk);
      } catch {
        sseClients.delete(client);
      }
    }
  }

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
    const requestUrl = new URL(request.url ?? "/", `http://${hostHeader || "127.0.0.1"}`);
    const channelWebhook = request.method === "POST" && (requestUrl.pathname === "/api/channels/slack" || requestUrl.pathname === "/api/channels/telegram");
    const routineWebhook = request.method === "POST" && /^\/api\/routines\/hooks\/[^/]+$/.test(requestUrl.pathname);
    if (!validHostHeader(hostHeader, boundPort) || (!channelWebhook && !routineWebhook && !validOrigin(request.headers.origin, hostHeader))) {
      sendJson(response, 403, { error: "This local app only accepts requests from its loopback origin." });
      return;
    }
    const url = requestUrl;
    if (request.method === "GET" && url.pathname === "/") {
      const settings = await readProviderSettings(root);
      const theme = themeFromCookie(request.headers.cookie) ?? studioTheme(settings.theme);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; script-src 'nonce-${token}'; style-src 'nonce-${token}'; base-uri 'none'; frame-ancestors 'none'`,
      });
      response.end(renderApp(token, theme));
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
      const state = await readDesktopState(bot.workspace, bot.id);
      const identity = botComputerIdentity(bot.workspace, bot.id);
      const frameInfo = await stat(path.join(bot.workspace, "gtm", "last-frame.png")).catch(() => undefined);
      sendJson(response, 200, {
        ok: true,
        display: state.display,
        profileDir: identity.profileDir,
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
    const computerStreamMatch = /^\/api\/bots\/([^/]+)\/computer\/stream$/.exec(url.pathname);
    if (request.method === "GET" && computerStreamMatch) {
      const bot = await findBot(computerStreamMatch[1] ?? "", root);
      if (!bot) {
        sendJson(response, 404, { error: "Bot not found." });
        return;
      }
      const state = await ensureComputerDisplay(bot.workspace);
      const displayActive = (state.status === "live" || state.status === "held") && !state.display.startsWith("macos:");
      if (!displayActive) {
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
      response.writeHead(200, {
        "content-type": "multipart/x-mixed-replace; boundary=ffmpeg",
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        "pragma": "no-cache",
        "connection": "close",
        "x-content-type-options": "nosniff",
      });
      const child = spawn(
        "ffmpeg",
        [
          "-nostdin",
          "-loglevel",
          "quiet",
          "-f",
          "x11grab",
          "-framerate",
          "20",
          "-video_size",
          `${state.width}x${state.height}`,
          "-i",
          state.display,
          "-f",
          "mpjpeg",
          "-q:v",
          "5",
          "-",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      activeStreams.add(child);
      const cleanup = () => {
        activeStreams.delete(child);
        if (!child.killed) {
          try {
            child.kill("SIGTERM");
          } catch {
            // Ignore
          }
        }
      };
      request.on("close", cleanup);
      response.on("close", cleanup);
      child.on("error", cleanup);
      child.on("close", () => {
        activeStreams.delete(child);
        if (!response.writableEnded) response.end();
      });
      child.stdout?.pipe(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      const [projects, bots, tasks, settings, routines, secretKeys] = await Promise.all([
        listProjects(root),
        listBots(root),
        listTasks(root),
        readProviderSettings(root),
        listProductRoutines(root),
        listMcpSecretKeys(root),
      ]);
      const effectiveEnv = applyProviderSettingsToEnv(settings, env);
      sendJson(response, 200, {
        projects,
        bots: bots.map((bot) => publicBot(bot, effectiveEnv, secretKeys)),
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
          autoApproveRemaining: task.autoApproveRemaining,
          workspaceChanges: task.workspaceChanges
            ? {
                ...task.workspaceChanges,
                files: visibleWorkspaceChangeFiles(task.workspaceChanges.files),
              }
            : undefined,
          pendingApproval: task.pendingApproval ? {
            id: task.pendingApproval.id,
            title: task.pendingApproval.title,
            description: task.pendingApproval.description,
            subject: task.pendingApproval.subject,
            requestedAt: task.pendingApproval.requestedAt,
          } : undefined,
        })),
        activeBrainLabel: brainLabel(effectiveEnv),
        activeModel: effectiveEnv.OCP_DEFAULT_MODEL || settings.defaultModel || "",
        routines,
        channelLog: await listChannelLog(root),
        handoffs: await listProductHandoffs(root),
        skills: await listSkills(root),
        issueRuns: await listIssueRuns(root),
        vault: await publicVault(root, env),
        accounts: await publicAccounts(root, env),
        usage: await usageSnapshot(root),
        modelPrices: settings.modelPrices ?? [],
        usageCaps: settings.usageCaps ?? { perBot: [] },
        channels: {
          slackConfigured: Boolean(settings.slackBotToken && settings.slackSigningSecret),
          telegramConfigured: Boolean(settings.telegramBotToken && settings.telegramWebhookSecret),
          slackBotId: settings.slackBotId ?? "",
          telegramBotId: settings.telegramBotId ?? "",
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.write("event: hello\ndata: {}\n\n");
      sseClients.add(response);
      request.on("close", () => {
        sseClients.delete(response);
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
        defaultModel: settings.defaultModel || effectiveEnv.OCP_DEFAULT_MODEL || "",
        slackConfigured: Boolean(settings.slackBotToken && settings.slackSigningSecret),
        telegramConfigured: Boolean(settings.telegramBotToken && settings.telegramWebhookSecret),
        modelPrices: settings.modelPrices ?? [],
        usageCaps: settings.usageCaps ?? { perBot: [] },
        theme: studioTheme(settings.theme),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/onboarding") {
      sendJson(response, 200, await loadOnboardingView(root, env));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/routines") {
      sendJson(response, 200, { routines: await listProductRoutines(root) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/audit") {
      sendJson(response, 200, { audit: await listAudit(root) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/activity") {
      sendJson(response, 200, await buildActivity(root));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/responsibilities") {
      sendJson(response, 200, { responsibilities: await listResponsibilities(root) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/threads") {
      sendJson(response, 200, { threads: await listThreads(root) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/rules") {
      sendJson(response, 200, await listDenyRules(root));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/agents") {
      sendJson(response, 200, { agents: await listAgents(root) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/directory") {
      sendJson(response, 200, await listDirectory(root));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/pages") {
      sendJson(response, 200, { pages: await listPages(root) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/memory") {
      const workspace = url.searchParams.get("workspace") ?? "";
      if (!workspace) {
        sendJson(response, 400, { error: "workspace is required" });
        return;
      }
      sendJson(response, 200, { facts: await listMemory(workspace, root) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/skills/export") {
      try {
        const zip = await exportSkillPack(root);
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": "attachment; filename=\"ocp-skills.zip\"",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(zip);
      } catch (error) {
        sendJson(response, error instanceof SkillError ? error.status : 400, { error: error instanceof Error ? error.message : "The skill pack could not be written." });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/skills") {
      sendJson(response, 200, { skills: await listSkills(root) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/plugins") {
      try {
        sendJson(response, 200, await listPlugins(root));
      } catch (error) {
        const status = error instanceof PluginError ? error.status : 500;
        sendJson(response, status, { error: error instanceof Error ? error.message : "Plugins could not be loaded." });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/vault") {
      sendJson(response, 200, await publicVault(root, env));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/accounts") {
      sendJson(response, 200, await publicAccounts(root, env));
      return;
    }
    if (request.method === "GET" && (url.pathname === "/api/accounts/google/callback" || url.pathname === "/api/accounts/microsoft/callback")) {
      const provider = url.pathname.includes("google") ? "google" : "microsoft";
      const providerLabel = provider === "google" ? "Google" : "Microsoft";
      try {
        if (url.searchParams.get("error")) throw new AccountError("Consent was denied. No token was stored.");
        const result = await completeAccountLogin({
          root,
          env,
          provider,
          code: url.searchParams.get("code") ?? "",
          state: url.searchParams.get("state") ?? "",
        });
        const who = result.account ? ` as ${escapeAttribute(result.account)}` : "";
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>Connected</title><p>${providerLabel} is connected${who}. You can close this window. No token is shown here.</p>`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sign-in failed. No token was stored.";
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>Not connected</title><p>${escapeAttribute(message)}</p>`);
      }
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
        activeBrainLabel: brainLabel(effectiveEnv),
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
    if (request.method === "POST" && (url.pathname === "/api/channels/slack" || url.pathname === "/api/channels/telegram")) {
      const rawBody = await readRaw(request);
      const result = url.pathname.endsWith("/slack")
        ? await acceptSlackInbound(rawBody, request.headers["x-slack-request-timestamp"], request.headers["x-slack-signature"])
        : await acceptTelegramInbound(rawBody, request.headers["x-telegram-bot-api-secret-token"]);
      sendJson(response, result.status, result.body);
      return;
    }
    const routineHookMatch = /^\/api\/routines\/hooks\/([^/]+)$/.exec(url.pathname);
    if (request.method === "POST" && routineHookMatch) {
      const routineId = decodeURIComponent(routineHookMatch[1] ?? "");
      const rawBody = await readRaw(request);
      const secret = await readWebhookSecret(root, routineId);
      if (!secret) {
        sendJson(response, 404, { ok: false, error: "This routine has no signed webhook. Nothing was started." });
        return;
      }
      const verified = verifyRoutineWebhook({
        secret,
        timestamp: oneHeader(request.headers["x-ocp-timestamp"]),
        signature: oneHeader(request.headers["x-ocp-signature"]),
        rawBody,
        nowMs: Date.now(),
      });
      if (!verified.ok) {
        sendJson(response, 401, { ok: false, error: "The signature was rejected. Nothing was started." });
        return;
      }
      const replayed = await consumeWebhookReplay(root, routineId, oneHeader(request.headers["x-ocp-timestamp"]), oneHeader(request.headers["x-ocp-signature"]), Date.now());
      if (replayed) {
        sendJson(response, 401, { ok: false, error: "The signature was replayed. Nothing was started." });
        return;
      }
      const routine = (await listProductRoutines(root)).find((item) => item.id === routineId);
      if (!routine || routine.status !== "active") {
        sendJson(response, 409, { ok: false, error: "That routine is not active. Nothing was started." });
        return;
      }
      await startRoutineTask(routine, "webhook");
      notifySse();
      sendJson(response, 202, { ok: true, started: true, routineId: routine.id });
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
    const channelDraftMatch = /^\/api\/channels\/drafts\/([^/]+)$/.exec(url.pathname);
    if (request.method === "POST" && channelDraftMatch) {
      const decision = body.decision === "allow" || body.decision === "deny" ? body.decision : "";
      if (!decision) {
        sendJson(response, 400, { error: "Choose allow or deny for this reply draft." });
        return;
      }
      try {
        const result = await decideChannelDraft(decodeURIComponent(channelDraftMatch[1] ?? ""), decision);
        notifySse();
        sendJson(response, result.ok ? 200 : 409, result);
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message : "Could not update that reply draft." });
      }
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
        const secretKeys = await listMcpSecretKeys(root);
        sendJson(response, 201, {
          ok: true,
          project,
          createdBots: fleet.created.map((bot) => publicBot(bot, effectiveEnv, secretKeys)),
          bots: fleet.bots.map((bot) => publicBot(bot, effectiveEnv, secretKeys)),
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
      try {
        if (Object.prototype.hasOwnProperty.call(body, "theme") && body.theme !== "dark" && body.theme !== "light" && body.theme !== "system") {
          sendJson(response, 400, { error: "Theme must be dark, light, or system." });
          return;
        }
        const saved = await saveProviderSettings(
          {
            ...(typeof body.openrouterApiKey === "string" ? { openrouterApiKey: body.openrouterApiKey } : {}),
            ...(typeof body.litellmApiKey === "string" ? { litellmApiKey: body.litellmApiKey } : {}),
            ...(typeof body.litellmBaseUrl === "string" ? { litellmBaseUrl: body.litellmBaseUrl } : {}),
            ...(typeof body.openaiApiKey === "string" ? { openaiApiKey: body.openaiApiKey } : {}),
            ...(typeof body.defaultModel === "string" ? { defaultModel: body.defaultModel } : {}),
            ...(typeof body.slackBotToken === "string" ? { slackBotToken: body.slackBotToken } : {}),
            ...(typeof body.slackSigningSecret === "string" ? { slackSigningSecret: body.slackSigningSecret } : {}),
            ...(typeof body.telegramBotToken === "string" ? { telegramBotToken: body.telegramBotToken } : {}),
            ...(typeof body.telegramWebhookSecret === "string" ? { telegramWebhookSecret: body.telegramWebhookSecret } : {}),
            ...(typeof body.slackBotId === "string" ? { slackBotId: body.slackBotId } : {}),
            ...(typeof body.telegramBotId === "string" ? { telegramBotId: body.telegramBotId } : {}),
            ...(Object.prototype.hasOwnProperty.call(body, "modelPrices") ? { modelPrices: body.modelPrices } : {}),
            ...(Object.prototype.hasOwnProperty.call(body, "usageCaps") ? { usageCaps: body.usageCaps } : {}),
            ...(body.theme === "dark" || body.theme === "light" || body.theme === "system" ? { theme: body.theme } : {}),
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
          defaultModel: saved.defaultModel || effectiveEnv.OCP_DEFAULT_MODEL || "",
          slackConfigured: Boolean(saved.slackBotToken && saved.slackSigningSecret),
          telegramConfigured: Boolean(saved.telegramBotToken && saved.telegramWebhookSecret),
          modelPrices: saved.modelPrices ?? [],
          usageCaps: saved.usageCaps ?? { perBot: [] },
          theme: studioTheme(saved.theme),
        });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not save settings." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/routines") {
      try {
        const created = await createProductRoutine({
          botId: typeof body.botId === "string" ? body.botId : "",
          prompt: typeof body.prompt === "string" ? body.prompt : "",
          everyMs: optionalNumber(body.everyMs),
          event: typeof body.event === "string" ? body.event : undefined,
          cron: typeof body.cron === "string" ? body.cron : undefined,
          timezone: typeof body.timezone === "string" ? body.timezone : undefined,
          webhook: body.webhook === true || body.webhook === "true" || body.webhook === "on",
        }, root);
        notifySse();
        const webhookSecret = created.webhookSecret;
        const routine = { ...created };
        delete routine.webhookSecret;
        sendJson(response, 201, webhookSecret
          ? { routine, webhookSecret, webhookPath: `/api/routines/hooks/${routine.id}` }
          : { routine });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not create routine." });
      }
      return;
    }
    if (request.method === "POST" && (url.pathname === "/api/accounts/google/client" || url.pathname === "/api/accounts/microsoft/client")) {
      const provider = url.pathname.includes("google") ? "google" : "microsoft";
      try {
        const saved = await saveAccountClient(root, provider, body.clientId, body.clientSecret, env);
        sendJson(response, 200, saved);
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "OAuth client was not stored." });
      }
      return;
    }
    if (request.method === "POST" && (url.pathname === "/api/accounts/google/start" || url.pathname === "/api/accounts/microsoft/start")) {
      const provider = url.pathname.includes("google") ? "google" : "microsoft";
      try {
        const started = await startAccountLogin(root, provider, body.acceptScopes, `http://127.0.0.1:${boundPort}/api/accounts/${provider}/callback`, env);
        sendJson(response, 200, { authorizeUrl: started.authorizeUrl, scopes: started.scopes, redirectUri: started.redirectUri });
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "Sign-in did not start." });
      }
      return;
    }
    if (request.method === "POST" && (url.pathname === "/api/accounts/google/disconnect" || url.pathname === "/api/accounts/microsoft/disconnect")) {
      const provider = url.pathname.includes("google") ? "google" : "microsoft";
      await disconnectAccount(root, provider, env);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/issues/start") {
      try {
        const run = await startIssueRun(root, body, env);
        sendJson(response, 201, { run });
      } catch (error) {
        const status = error instanceof IssuePrError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "The issue was not started." });
      }
      return;
    }
    const issueAction = /^\/api\/issues\/([^/]+)\/(approve|test|pull-request)$/.exec(url.pathname);
    if (issueAction && request.method === "POST") {
      const id = decodeURIComponent(issueAction[1] ?? "");
      const action = issueAction[2];
      try {
        const run = action === "approve"
          ? await approveIssuePlan(root, id)
          : action === "test"
            ? await runIssueTests(root, id)
            : await openIssuePullRequest(root, id, env);
        sendJson(response, action === "pull-request" && run.status !== "pr-opened" ? 409 : 200, { run });
      } catch (error) {
        const status = error instanceof IssuePrError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "The issue step failed." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/skills/import") {
      try {
        const imported = typeof body.zipBase64 === "string"
          ? await importSkillZip(root, Buffer.from(body.zipBase64, "base64"))
          : await importSkillGit(root, typeof body.gitUrl === "string" ? body.gitUrl : "");
        sendJson(response, 200, imported);
      } catch (error) {
        const status = error instanceof SkillError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "Nothing was imported." });
      }
      return;
    }
    const pluginInstallMatch = /^\/api\/plugins\/([^/]+)\/install$/.exec(url.pathname);
    if (request.method === "POST" && pluginInstallMatch) {
      try {
        const result = await installPlugin(root, decodeURIComponent(pluginInstallMatch[1] ?? ""), body, { fetchImpl, env });
        sendJson(response, 200, result);
      } catch (error) {
        const status = error instanceof PluginError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "Plugin install failed." });
      }
      return;
    }
    const pluginUninstallMatch = /^\/api\/plugins\/([^/]+)\/uninstall$/.exec(url.pathname);
    if (request.method === "POST" && pluginUninstallMatch) {
      try {
        const result = await uninstallPlugin(root, decodeURIComponent(pluginUninstallMatch[1] ?? ""), body, { env });
        sendJson(response, 200, result);
      } catch (error) {
        const status = error instanceof PluginError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "Plugin uninstall failed." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/skills") {
      try {
        const skill = await createSkill(root, body);
        sendJson(response, 201, { skill });
      } catch (error) {
        const status = error instanceof SkillError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "Skill was not saved." });
      }
      return;
    }
    const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(url.pathname);
    if (skillMatch && request.method === "PATCH") {
      try {
        const skill = await updateSkill(root, decodeURIComponent(skillMatch[1] ?? ""), body);
        sendJson(response, 200, { skill });
      } catch (error) {
        const status = error instanceof SkillError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "Skill was not saved." });
      }
      return;
    }
    if (skillMatch && request.method === "DELETE") {
      try {
        await deleteSkill(root, decodeURIComponent(skillMatch[1] ?? ""));
        sendJson(response, 200, { ok: true });
      } catch (error) {
        const status = error instanceof SkillError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "Skill was not deleted." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/vault") {
      try {
        const item = await createVaultItem(root, body, env);
        sendJson(response, 201, { item });
      } catch (error) {
        const status = error instanceof VaultError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "Vault item was not stored." });
      }
      return;
    }
    const vaultItemMatch = /^\/api\/vault\/([^/]+)$/.exec(url.pathname);
    if (vaultItemMatch && request.method === "DELETE") {
      try {
        await deleteVaultItem(root, decodeURIComponent(vaultItemMatch[1] ?? ""), env);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        const status = error instanceof VaultError ? error.status : 400;
        sendJson(response, status, { error: error instanceof Error ? error.message : "Vault item was not deleted." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/routines/event") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const matched = name ? await routinesForEvent(name, root) : [];
      sendJson(response, 202, { ok: true, fired: matched.length, routineIds: matched.map((item) => item.id) });
      for (const routine of matched) void startRoutineTask(routine);
      notifySse();
      return;
    }
    const routineMatch = /^\/api\/routines\/([^/]+)$/.exec(url.pathname);
    if (routineMatch && request.method === "PATCH") {
      try {
        const status = body.status === "paused" ? "paused" : body.status === "active" ? "active" : undefined;
        const routine = await updateProductRoutine(routineMatch[1] ?? "", status ? { status } : {}, root);
        notifySse();
        sendJson(response, 200, { routine });
      } catch (error) {
        sendJson(response, 404, { error: error instanceof Error ? error.message : "Unknown routine." });
      }
      return;
    }
    if (routineMatch && request.method === "DELETE") {
      await deleteProductRoutine(routineMatch[1] ?? "", root);
      notifySse();
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/onboarding") {
      try {
        const view = await handleOnboardingPost(root, body, env);
        notifySse();
        sendJson(response, 200, view);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not update the start guide." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/bootstrap") {
      const mode = body.mode === "team" ? "team" : "lead";
      const workspace = typeof body.workspace === "string" && body.workspace.trim() ? body.workspace.trim() : process.cwd();
      const settings = await readProviderSettings(root);
      const effectiveEnv = applyProviderSettingsToEnv(settings, env);
      const result = await bootstrapFleet(workspace, mode, root);
      const secretKeys = await listMcpSecretKeys(root);
      sendJson(response, 200, {
        ok: true,
        created: result.created.map((bot) => publicBot(bot, effectiveEnv, secretKeys)),
        bots: result.bots.map((bot) => publicBot(bot, effectiveEnv, secretKeys)),
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
      sendJson(response, 201, { bot: publicBot(saved.bot, effectiveEnv, await listMcpSecretKeys(root)) });
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
        const res = await setComputerControl(bot.workspace, kind, bot.id);
        sendJson(response, 200, res);
        return;
      }
      if (kind === "stop") {
        await stopComputerDesktop(bot.workspace, bot.id);
        const state = await readDesktopState(bot.workspace, bot.id);
        sendJson(response, 200, { ok: true, detail: "Stopped virtual computer processes.", ...state });
        return;
      }
      if (kind === "reset") {
        const identity = await resetBotComputer(bot.workspace, bot.id);
        sendJson(response, 200, { ok: true, ...identity });
        return;
      }
      if (kind === "browser") {
        const targetUrl = typeof body.url === "string" ? body.url : "";
        const res = await computerOpenBrowser(bot.workspace, targetUrl, "human", bot.id);
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
          fast: body.fast === true,
          botId: bot.id,
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
          fast: body.fast === true,
          botId: bot.id,
        });
        sendJson(response, res.ok ? 200 : 400, res);
        return;
      }
      const res = await captureComputerScreen(bot.workspace, "Captured live computer screen", bot.id);
      sendJson(response, 200, res);
      return;
    }
    const connectorTestMatch = /^\/api\/bots\/([^/]+)\/connectors\/test$/.exec(url.pathname);
    if (request.method === "POST" && connectorTestMatch) {
      const bot = await findBot(connectorTestMatch[1] ?? "", root);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const server = bot?.mcpServers?.find((item) => item.name === name);
      if (!bot || !server) {
        sendJson(response, 404, { error: "Connector not found." });
        return;
      }
      const token = await readMcpSecret(root, bot.id, server.name);
      const tokens = new Map<string, string>();
      if (token) tokens.set(server.name, token);
      const probed = await probeConnectors([server], tokens);
      const merged = (bot.mcpServers ?? []).map((item) => item.name === server.name ? probed.servers[0] ?? item : item);
      const saved = await writeBotMcpServers(bot.id, merged, root);
      const secretKeys = await listMcpSecretKeys(root);
      const connector = publicBot(saved, env, secretKeys).mcpServers.find((item) => item.name === server.name);
      notifySse();
      sendJson(response, probed.errors.length > 0 ? 409 : 200, { connector, error: probed.errors[0] });
      return;
    }
    const connectorItemMatch = /^\/api\/bots\/([^/]+)\/connectors\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && connectorItemMatch) {
      const bot = await findBot(connectorItemMatch[1] ?? "", root);
      const name = decodeURIComponent(connectorItemMatch[2] ?? "");
      if (!bot || !(bot.mcpServers ?? []).some((item) => item.name === name)) {
        sendJson(response, 404, { error: "Connector not found." });
        return;
      }
      await deleteMcpSecret(root, bot.id, name);
      const saved = await writeBotMcpServers(bot.id, (bot.mcpServers ?? []).filter((item) => item.name !== name), root);
      notifySse();
      sendJson(response, 200, { bot: publicBot(saved, env, await listMcpSecretKeys(root)) });
      return;
    }
    const connectorCollectionMatch = /^\/api\/bots\/([^/]+)\/connectors$/.exec(url.pathname);
    if (request.method === "POST" && connectorCollectionMatch) {
      const bot = await findBot(connectorCollectionMatch[1] ?? "", root);
      if (!bot) {
        sendJson(response, 404, { error: "Bot not found." });
        return;
      }
      const checked = validateConnectorInput({
        name: typeof body.name === "string" ? body.name : "",
        url: typeof body.url === "string" ? body.url : "",
        authHeader: typeof body.authHeader === "string" ? body.authHeader : undefined,
      });
      if (!checked.ok) {
        sendJson(response, 400, { error: checked.error });
        return;
      }
      if (typeof body.authToken === "string" && body.authToken.trim()) await writeMcpSecret(root, bot.id, checked.name, body.authToken.trim());
      if (body.clearAuth === true) await deleteMcpSecret(root, bot.id, checked.name);
      const previous = (bot.mcpServers ?? []).find((item) => item.name === checked.name);
      const sameTarget = previous && previous.url === checked.url;
      const record: BotMcpServer = {
        name: checked.name,
        url: checked.url,
        authHeader: checked.authHeader ?? (sameTarget ? previous.authHeader : undefined),
        status: sameTarget ? previous.status : "unknown",
        lastError: sameTarget ? previous.lastError : undefined,
        lastCheckedAt: sameTarget ? previous.lastCheckedAt : undefined,
        toolNames: sameTarget ? previous.toolNames : [],
      };
      const saved = await writeBotMcpServers(bot.id, upsertConnectorSnapshot(bot.mcpServers ?? [], record), root);
      notifySse();
      const secretKeys = await listMcpSecretKeys(root);
      sendJson(response, 201, {
        connector: publicBot(saved, env, secretKeys).mcpServers.find((item) => item.name === checked.name),
      });
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
      sendJson(response, 200, { bot: publicBot(saved.bot, effectiveEnv, await listMcpSecretKeys(root)) });
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
      const task = await createTask({ botId: bot.id, prompt, reviewerBotId: reviewer?.id }, root);
      const currentBot = await findBot(bot.id, root);
      if (!currentBot) {
        sendJson(response, 409, { error: "The selected bot was removed." });
        return;
      }
      if (await workspaceHasBusyTask(currentBot.workspace, root)) {
        notifySse();
        sendJson(response, 202, { taskId: task.id, queued: true });
        return;
      }
      await updateTask(task.id, { status: "running", processId: process.pid }, root);
      if (closing) {
        await updateTask(task.id, { status: "cancelled", processId: undefined }, root);
        sendJson(response, 503, { error: "OpenCodingPartner is shutting down; the task was not started." });
        return;
      }
      launchTask(task.id, currentBot, reviewer, prompt, workspaceBaseline);
      notifySse();
      sendJson(response, 202, { taskId: task.id });
      return;
    }
    const approvalMatch = /^\/api\/tasks\/([^/]+)\/approval$/.exec(url.pathname);
    if (approvalMatch) {
      const taskId = approvalMatch[1] ?? "";
      const task = (await listTasks(root)).find((item) => item.id === taskId);
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      const decisionRaw = typeof body.decision === "string" ? body.decision : "";
      const decision = decisionRaw === "always" || decisionRaw === "redirect" || decisionRaw === "allow-once" || decisionRaw === "cancelled"
        ? decisionRaw
        : body.approved === true ? "allow-once" : "cancelled";
      const waiter = approvalWaiters.get(requestId);
      if (!task?.pendingApproval || task.pendingApproval.id !== requestId) {
        sendJson(response, 409, { error: "That approval request is no longer pending." });
        return;
      }
      if (unattendedApprovalExpired(task, Date.now(), env)) {
        approvalWaiters.delete(requestId);
        waiter?.resolve(undefined);
        await updateTask(taskId, {
          status: "needs-attention",
          pendingApproval: undefined,
          error: "Unattended approval expired. The action did not run.",
        }, root);
        await recordAudit(root, {
          outcome: "refused",
          action: task.pendingApproval.title,
          ruleId: "expired",
          detail: "Unattended approval expired before a person answered.",
        });
        notifySse();
        sendJson(response, 409, { error: "Unattended approval expired. The action did not run." });
        return;
      }
      if (permissionSubjectKind(task.pendingApproval.subject) === "usage-hard-cap" && decision !== "cancelled") {
        sendJson(response, 400, { error: "A hard cap pauses the task. Leave it paused." });
        return;
      }
      if (waiter && waiter.taskId !== taskId) {
        sendJson(response, 409, { error: "That approval request is no longer pending." });
        return;
      }
      if (decision === "redirect") {
        const redirectBotId = typeof body.redirectBotId === "string" ? body.redirectBotId.trim() : "";
        const redirectBot = redirectBotId ? await findBot(redirectBotId, root) : undefined;
        if (!redirectBot) {
          sendJson(response, 400, { error: "Choose a bot to redirect this task to." });
          return;
        }
        approvalWaiters.delete(requestId);
        await recordTaskApproval(taskId, {
          title: task.pendingApproval.title,
          description: task.pendingApproval.description,
          decision: "redirect",
          createdAt: new Date().toISOString(),
          requestId,
          redirectBotId: redirectBot.id,
        }, root);
        const run = activeRuns.get(taskId);
        run?.controller.abort();
        waiter?.resolve(undefined);
        await updateTask(taskId, { status: "cancelled", pendingApproval: undefined, processId: undefined }, root);
        const spawned = await createTask({ botId: redirectBot.id, prompt: task.prompt, reviewerBotId: task.reviewerBotId }, root);
        if (!(await workspaceHasBusyTask(redirectBot.workspace, root))) {
          await updateTask(spawned.id, { status: "running", processId: process.pid }, root);
          const baseline = await captureWorkspaceBaseline(redirectBot.workspace);
          const reviewer = spawned.reviewerBotId ? await findBot(spawned.reviewerBotId, root) : undefined;
          launchTask(spawned.id, redirectBot, reviewer, spawned.prompt, baseline);
        }
        notifySse();
        sendJson(response, 200, { ok: true, redirectedTaskId: spawned.id });
        return;
      }
      approvalWaiters.delete(requestId);
      await recordTaskApproval(taskId, {
        title: task.pendingApproval.title,
        description: task.pendingApproval.description,
        decision,
        createdAt: new Date().toISOString(),
        requestId,
      }, root);
      const allow = decision === "allow-once" || decision === "always";
      const pendingKind = permissionSubjectKind(task.pendingApproval.subject);
      await updateTask(taskId, {
        status: "running",
        pendingApproval: undefined,
        autoApproveRemaining: decision === "always" && pendingKind !== "usage-cap" && pendingKind !== "usage-hard-cap" ? true : task.autoApproveRemaining,
      }, root);
      waiter?.resolve(allow ? waiter.optionId : undefined);
      await recordAudit(root, {
        outcome: allow ? "permitted" : "refused",
        action: task.pendingApproval.title,
        ruleId: allow ? undefined : "approval",
        detail: decision,
      });
      notifySse();
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
    const handMatch = /^\/api\/tasks\/([^/]+)\/hand$/.exec(url.pathname);
    if (request.method === "POST" && handMatch) {
      try {
        const task = await handOffTask(handMatch[1] ?? "", typeof body.botId === "string" ? body.botId : "", root);
        const bot = await findBot(task.botId, root);
        const busy = !bot || await workspaceHasBusyTask(bot.workspace, root);
        if (bot && !busy && !closing) {
          await updateTask(task.id, { status: "running", processId: process.pid }, root);
          launchTask(task.id, bot, undefined, task.prompt, await captureWorkspaceBaseline(bot.workspace));
        }
        notifySse();
        sendJson(response, 202, { taskId: task.id, queued: busy || closing });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not hand off the task." });
      }
      return;
    }
    const routineFromTaskMatch = /^\/api\/tasks\/([^/]+)\/routine$/.exec(url.pathname);
    if (request.method === "POST" && routineFromTaskMatch) {
      try {
        const everyMs = typeof body.everyMs === "number" ? body.everyMs : undefined;
        const routine = await saveTaskAsRoutine(routineFromTaskMatch[1] ?? "", {
          everyMs,
          cron: typeof body.cron === "string" ? body.cron : undefined,
          timezone: typeof body.timezone === "string" ? body.timezone : undefined,
        }, root);
        sendJson(response, 201, { routine });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not save the routine." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/proactive") {
      const botId = typeof body.botId === "string" ? body.botId : "";
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const bot = await findBot(botId, root);
      if (!bot || !prompt || prompt.length > 20_000) {
        sendJson(response, 400, { error: "Choose a bot and enter a read-only request of 1 to 20,000 characters." });
        return;
      }
      const task = await createTask({ botId: bot.id, prompt, initiator: "person", proactive: true }, root);
      const busy = await workspaceHasBusyTask(bot.workspace, root);
      if (!busy && !closing) {
        await updateTask(task.id, { status: "running", processId: process.pid }, root);
        launchTask(task.id, bot, undefined, prompt, await captureWorkspaceBaseline(bot.workspace));
      }
      notifySse();
      sendJson(response, 202, { taskId: task.id, proactive: true, queued: busy || closing });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/responsibilities") {
      try {
        const saved = await createResponsibility(root, typeof body.botId === "string" ? body.botId : "", typeof body.goal === "string" ? body.goal : "");
        sendJson(response, 201, { responsibility: saved });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not save the responsibility." });
      }
      return;
    }
    const responsibilityCheckMatch = /^\/api\/responsibilities\/([^/]+)\/check$/.exec(url.pathname);
    if (request.method === "POST" && responsibilityCheckMatch) {
      try {
        const everyMs = typeof body.everyMs === "number" ? body.everyMs : Number(body.everyMs);
        const saved = await scheduleResponsibilityCheck(root, responsibilityCheckMatch[1] ?? "", everyMs);
        sendJson(response, 201, saved);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not schedule the check." });
      }
      return;
    }
    const responsibilityMatch = /^\/api\/responsibilities\/([^/]+)$/.exec(url.pathname);
    if (request.method === "POST" && responsibilityMatch) {
      try {
        const saved = await updateResponsibility(root, responsibilityMatch[1] ?? "", {
          status: body.status === "done" || body.status === "open" ? body.status : undefined,
          progress: typeof body.progress === "string" ? body.progress : undefined,
        });
        sendJson(response, 200, { responsibility: saved });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not update the responsibility." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/threads") {
      try {
        const botIds = Array.isArray(body.botIds) ? body.botIds.filter((id): id is string => typeof id === "string") : [];
        const thread = await createThread(root, botIds, typeof body.text === "string" ? body.text : "");
        sendJson(response, 201, { thread });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not start the thread." });
      }
      return;
    }
    const reachMatch = /^\/api\/threads\/([^/]+)\/reach$/.exec(url.pathname);
    if (request.method === "POST" && reachMatch) {
      try {
        const channel = body.channel === "slack" || body.channel === "telegram" || body.channel === "whatsapp" || body.channel === "teams" ? body.channel : "";
        if (!channel) {
          sendJson(response, 400, { error: "Reach needs slack, telegram, whatsapp, or teams." });
          return;
        }
        const thread = await reachThread(root, reachMatch[1] ?? "", channel, typeof body.destination === "string" ? body.destination : "");
        sendJson(response, 200, { thread });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not draft the reach." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memory") {
      try {
        const workspace = typeof body.workspace === "string" ? body.workspace : "";
        const query = typeof body.query === "string" ? body.query : "";
        if (body.action === "forget") {
          sendJson(response, 200, { removed: await forgetMemory(workspace, query, root) });
          return;
        }
        const facts = await correctMemory(workspace, query, typeof body.replacement === "string" ? body.replacement : "", root);
        sendJson(response, 200, { facts });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not edit memory." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/agents") {
      try {
        const agent = await registerAgent(root, typeof body.name === "string" ? body.name : "", typeof body.url === "string" ? body.url : "");
        sendJson(response, 201, { agent });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not register the agent." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/agui") {
      const run = await executeAguiRun(root, body);
      response.writeHead(run.status, {
        "content-type": run.contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(run.body);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/directory/users") {
      try {
        const role = body.role === "admin" || body.role === "member" ? body.role : "member";
        const user = await createDirectoryUser(root, typeof body.name === "string" ? body.name : "", role, typeof body.password === "string" ? body.password : "");
        sendJson(response, 201, { user });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not add that person." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/directory/login") {
      try {
        const user = typeof body.assertion === "string" && body.assertion
          ? await loginCompanyAssertion(root, body.assertion)
          : await loginDirectory(root, typeof body.name === "string" ? body.name : "", typeof body.password === "string" ? body.password : "");
        sendJson(response, 200, { user });
      } catch (error) {
        sendJson(response, 401, { error: error instanceof Error ? error.message : "Sign-in was refused." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/directory/company") {
      try {
        await setCompanyAssertionSecret(root, typeof body.secret === "string" ? body.secret : "");
        sendJson(response, 200, { companySignIn: true });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not enable company sign-in." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/pages") {
      try {
        const page = await savePage(root, typeof body.title === "string" ? body.title : "", typeof body.body === "string" ? body.body : "");
        sendJson(response, 201, { page });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not save the page." });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/rules") {
      try {
        const rule = await saveDenyRule(
          root,
          typeof body.tool === "string" ? body.tool : "",
          typeof body.pathPrefix === "string" ? body.pathPrefix : undefined,
          {
            argvPrefix: typeof body.argvPrefix === "string" ? body.argvPrefix.split(/\s+/).filter(Boolean) : undefined,
            initiator: body.initiator === "person" || body.initiator === "routine" || body.initiator === "any" ? body.initiator : undefined,
          },
        );
        await recordAudit(root, { outcome: "permitted", action: "save deny rule", ruleId: rule.id, detail: rule.tool });
        sendJson(response, 201, { rule });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not save the rule." });
      }
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  }

  async function recordChannelOutcome(taskId: string, status: "draft" | "failed", text: string, error?: string): Promise<void> {
    const finished = await findTask(taskId, root);
    const origin = finished?.channelOrigin;
    if (!origin) return;
    await appendChannelLog({
      channel: origin.channel,
      direction: "out",
      text: text.slice(0, 4_000),
      error,
      botId: finished.botId,
      taskId,
      destination: origin.destination,
      thread: origin.thread,
      externalId: `reply:${taskId}`,
      status,
    }, root);
    notifySse();
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
            taskId,
            signal: controller.signal,
            onUpdate: (update) => {
              if (update.kind === "agent_message_chunk" && update.text) {
                progressText = `${progressText}${update.text}`.slice(-20_000);
                if (!progressTimer) progressTimer = setTimeout(() => {
                  progressTimer = undefined;
                  persistProgress();
                }, 400);
              }
              if (["tool_call", "tool_call_update", "permission_allowed", "permission_denied", "session_reset", "connector_error", "usage"].includes(update.kind)) {
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
        if (!permissionDenied) {
          const finished = await findTask(taskId, root);
          if (finished?.routineId) await noteRoutineOutcome(finished, "succeeded", root);
        }
        await recordChannelOutcome(taskId, permissionDenied ? "failed" : "draft", result, permissionDenied ? "Reply stayed in the app because the task needs attention." : undefined);
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
        if (!cancelled) {
          const failedTask = await findTask(taskId, root);
          if (failedTask?.routineId) await noteRoutineOutcome(failedTask, "failed", root).catch(() => undefined);
          await recordChannelOutcome(taskId, "failed", "", error instanceof Error ? error.message : "Agent run failed.").catch(() => undefined);
        }
      } finally {
        if (progressTimer) clearTimeout(progressTimer);
        activeRuns.delete(taskId);
        for (const [requestId, waiter] of approvalWaiters) {
          if (waiter.taskId === taskId) {
            approvalWaiters.delete(requestId);
            waiter.resolve(undefined);
          }
        }
        void drainWorkspaceQueue(bot.workspace);
      }
    })();
  }

  async function startRoutineTask(routine: Awaited<ReturnType<typeof listProductRoutines>>[number], source: "schedule" | "webhook" = "schedule"): Promise<void> {
    if (closing) return;
    const bot = await findBot(routine.botId, root);
    if (!bot) return;
    const task = await createTask({
      botId: bot.id,
      prompt: `[routine ${routine.id}] ${routine.prompt}`,
      initiator: "routine",
      routineId: routine.id,
      ...(routine.proactive ? { proactive: true } : {}),
    }, root);
    let nextRunAt = routine.nextRunAt;
    let status: "active" | "paused" | undefined;
    if (source === "schedule") {
      try {
        nextRunAt = followingRunAt(routine, Date.now());
      } catch {
        status = "paused";
      }
    }
    await updateProductRoutine(routine.id, { lastRunAt: new Date().toISOString(), nextRunAt, ...(status ? { status } : {}) }, root);
    if (await workspaceHasBusyTask(bot.workspace, root)) return;
    const baseline = await captureWorkspaceBaseline(bot.workspace);
    await updateTask(task.id, { status: "running", processId: process.pid }, root);
    launchTask(task.id, bot, undefined, task.prompt, baseline);
  }

  async function drainWorkspaceQueue(workspace: string): Promise<void> {
    if (closing) return;
    if (await workspaceHasBusyTask(workspace, root)) return;
    const next = await nextQueuedTaskForWorkspace(workspace, root);
    if (!next) return;
    const nextBot = await findBot(next.botId, root);
    if (!nextBot) return;
    const reviewer = next.reviewerBotId ? await findBot(next.reviewerBotId, root) : undefined;
    const baseline = await captureWorkspaceBaseline(nextBot.workspace);
    await updateTask(next.id, { status: "running", processId: process.pid }, root);
    launchTask(next.id, nextBot, reviewer, next.prompt, baseline);
  }

  async function waitForApproval(taskId: string, request: RuntimePermissionRequest): Promise<string | undefined> {
    const requestKind = permissionSubjectKind(request.subject);
    const allow = request.options.find((option) => option.kind === "allow_once");
    if (!allow && requestKind !== "usage-hard-cap") return undefined;
    const current = await findTask(taskId, root);
    if (allow && current?.autoApproveRemaining && requestKind !== "usage-cap" && requestKind !== "usage-hard-cap") return allow.optionId;
    const id = randomUUID();
    const pending: PendingTaskApproval = {
      id,
      title: request.title.slice(0, 500),
      description: request.description?.slice(0, 4000),
      subject: boundedJson(request.subject),
      allowOnceOptionId: allow?.optionId ?? "",
      requestedAt: new Date().toISOString(),
    };
    await updateTask(taskId, { status: "awaiting-approval", pendingApproval: pending }, root);
    notifySse();
    return new Promise((resolve) => {
      let settled = false;
      let expiry: NodeJS.Timeout | undefined;
      const finish = (optionId: string | undefined) => {
        if (settled) return;
        settled = true;
        if (expiry) clearTimeout(expiry);
        approvalWaiters.delete(id);
        resolve(optionId);
      };
      approvalWaiters.set(id, { taskId, optionId: allow?.optionId ?? "", resolve: finish });
      const ttl = unattendedApprovalTtlMs(current?.initiator, env);
      if (ttl !== undefined) {
        expiry = setTimeout(() => {
          if (settled) return;
          finish(undefined);
          void updateTask(taskId, {
            status: "needs-attention",
            pendingApproval: undefined,
            error: "Unattended approval expired. The action did not run.",
          }, root).then(() => recordAudit(root, {
            outcome: "refused",
            action: pending.title,
            ruleId: "expired",
            detail: "Unattended approval expired before a person answered.",
          })).then(() => notifySse()).catch(() => undefined);
        }, ttl);
        expiry.unref?.();
      }
      const signal = activeRuns.get(taskId)?.controller.signal;
      if (signal?.aborted) finish(undefined);
      else signal?.addEventListener("abort", () => finish(undefined), { once: true });
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
  let background: Promise<void> = Promise.resolve();
  const trackBackground = (work: Promise<unknown>) => {
    background = background.then(() => work).then(() => undefined, () => undefined);
  };
  const queueTimer = setInterval(() => {
    trackBackground((async () => {
      if (closing) return;
      const queued = (await listTasks(root)).filter((task) => task.status === "queued");
      if (closing) return;
      const seen = new Set<string>();
      for (const task of queued) {
        if (closing) return;
        const owner = await findBot(task.botId, root);
        if (!owner || seen.has(owner.workspace)) continue;
        seen.add(owner.workspace);
        await drainWorkspaceQueue(owner.workspace);
      }
    })());
  }, 400);
  queueTimer.unref?.();
  const routineTimer = setInterval(() => {
    trackBackground((async () => {
      if (closing) return;
      const due = await dueProductRoutines(Date.now(), root);
      if (closing) return;
      for (const routine of due) {
        if (closing) return;
        await startRoutineTask(routine);
      }
      if (due.length) notifySse();
    })());
  }, 1000);
  routineTimer.unref?.();
  return {
    server,
    url: `http://${displayHost}:${actualPort}`,
    close: async () => {
      closing = true;
      clearInterval(queueTimer);
      clearInterval(routineTimer);
      await background;
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // Ignore
        }
      }
      sseClients.clear();
      for (const streamChild of activeStreams) {
        try {
          streamChild.kill("SIGTERM");
        } catch {
          // Ignore
        }
      }
      activeStreams.clear();
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
      if (provider && (!validBotProvider(provider) || !model)) return { error: "Provider routing requires an OpenRouter or OpenAI-compatible provider and a model ID." };
  if (!provider && model) return { error: "A model override requires an explicit OpenRouter or OpenAI-compatible provider profile." };
  if ((provider === "litellm" && !validEndpoint(endpoint)) || (provider !== "litellm" && endpoint)) return { error: "An OpenAI-compatible endpoint must be HTTP(S) without credentials; OpenRouter does not use a custom endpoint." };
  if ((provider === "litellm" && !validEnvName(apiKeyEnv)) || (provider !== "litellm" && body.apiKeyEnv)) return { error: "API key environment variable name is invalid or not supported for this provider." };
  const routeMode = Object.hasOwn(body, "routeMode") || !existing
    ? normalizeRouteMode(body.routeMode)
    : existing.routeMode;
  if ((Object.hasOwn(body, "routeMode") || !existing) && body.routeMode !== undefined && body.routeMode !== "" && !routeMode) {
    return { error: "Route must be auto, cheap, or strong." };
  }
  const cheapModel = Object.hasOwn(body, "cheapModel")
    ? normalizeCheapModel(body.cheapModel)
    : existing?.cheapModel;
  if (typeof body.cheapModel === "string" && body.cheapModel.trim() && !cheapModel) return { error: "Cheap model id must be 1 to 200 characters." };
  const parsedRules = parseActionRules(body, existing?.actionRules);
  if (parsedRules.error) return { error: parsedRules.error };
  const mcpServers = parseMcpServers(body.mcpServers, existing?.mcpServers);
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
      cheapModel: cheapModel || undefined,
      routeMode,
      ...(parsedRules.touched ? { actionRules: parsedRules.rules } : {}),
      mcpServers,
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

function normalizeRouteMode(value: unknown): "auto" | "cheap" | "strong" | undefined {
  return value === "auto" || value === "cheap" || value === "strong" ? value : undefined;
}

function normalizeCheapModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || /[\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function publicBot(bot: NonNullable<Awaited<ReturnType<typeof findBot>>>, env: NodeJS.ProcessEnv = process.env, secretKeys: ReadonlySet<string> = new Set()) {
  const { id, name, role, runtime, isolation, network, workspace, provider, endpoint, apiKeyEnv, model, cheapModel, routeMode, actionRules, instructions, mcpServers, createdAt, updatedAt } = bot;
  const effectiveIsolation = isOcpAgentRuntime(runtime) ? isolation ?? "docker" : undefined;
  const providerKeyConfigured = provider ? missingProviderKey(bot, env) === undefined : undefined;
  return {
    id,
    name,
    role,
    runtime,
    isolation: effectiveIsolation,
    network: effectiveIsolation === "docker" ? network ?? "disabled" : undefined,
    workspace,
    provider,
    endpoint,
    apiKeyEnv,
    model,
    ...(cheapModel ? { cheapModel } : {}),
    ...(routeMode ? { routeMode } : {}),
    actionRules: actionRules ?? { defaultRule: "ask", byAction: {}, preapproved: [] },
    instructions,
    mcpServers: (mcpServers ?? []).map((server) => publicConnector(server, secretKeys.has(mcpSecretKey(bot.id, server.name)))),
    providerKeyConfigured,
    createdAt,
    updatedAt,
  };
}

function permissionSubjectKind(subject: unknown): string {
  if (!subject || typeof subject !== "object") return "";
  const kind = (subject as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : "";
}

function boundedJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > 12_000) return "[details omitted: too large]";
    return JSON.parse(serialized) as unknown;
  } catch { return "[details omitted: unavailable]"; }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function resolveBindHost(host: string, env: NodeJS.ProcessEnv): string {
  if (isLoopback(host)) return host;
  if ((host === "0.0.0.0" || host === "::") && env.OCP_DOCKER_BIND === "bridge") return host;
  throw new Error("The OpenCodingPartner app can only bind to a loopback address. Docker may bind all container interfaces only when OCP_DOCKER_BIND=bridge, and the published port must stay on 127.0.0.1.");
}

function validHostHeader(value: string, port: number): boolean {
  const host = value.toLowerCase();
  return host === `localhost:${port}` || host === `127.0.0.1:${port}` || host === `[::1]:${port}` || host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function validOrigin(origin: string | undefined, host: string): boolean {
  return !origin || origin === `http://${host}`;
}

async function readRaw(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 1_000_000) throw new Error("Request body is too large.");
  }
  return body;
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

export function isHiddenWorkspacePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.split("/").some((segment) => segment === ".ocp" || segment === "gtm");
}

export function visibleWorkspaceChangeFiles<T extends { path: string }>(files: readonly T[] | undefined): T[] {
  return (files ?? []).filter((file) => !isHiddenWorkspacePath(file.path));
}

function parseMcpServers(raw: unknown, fallback?: BotMcpServer[]): BotMcpServer[] | undefined {
  if (raw === undefined || raw === "") return fallback;
  const text = typeof raw === "string" ? raw.trim() : "";
  const list = Array.isArray(raw) ? raw : text ? (() => { try { return JSON.parse(text) as unknown; } catch { return null; } })() : [];
  if (!Array.isArray(list)) return fallback;
  const servers: BotMcpServer[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; url?: unknown; authHeader?: unknown };
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!name || !url) continue;
    try {
      const parsed = new URL(url);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) continue;
    } catch {
      continue;
    }
    const previous = fallback?.find((server) => server.name === name.slice(0, 80));
    const same = previous?.url === url;
    const header = typeof record.authHeader === "string" ? record.authHeader.trim().slice(0, 80) : undefined;
    servers.push({
      name: name.slice(0, 80),
      url,
      authHeader: header || (same ? previous?.authHeader : undefined),
      status: same ? previous?.status : "unknown",
      lastError: same ? previous?.lastError : undefined,
      lastCheckedAt: same ? previous?.lastCheckedAt : undefined,
      toolNames: same ? previous?.toolNames : [],
    });
  }
  return servers;
}

function brainLabel(env: NodeJS.ProcessEnv): string {
  const model = env.OCP_DEFAULT_MODEL;
  if (env.LITELLM_BASE_URL) return model ? `Local GPU (${model})` : "Local GPU";
  if (env.OPENROUTER_API_KEY) return model ? `OpenRouter (${model})` : "OpenRouter";
  return "No model configured";
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

type StudioTheme = "dark" | "light" | "system";

function studioTheme(value: unknown): StudioTheme {
  return value === "light" || value === "system" || value === "dark" ? value : "dark";
}

function themeFromCookie(header: string | undefined): StudioTheme | undefined {
  const match = /(?:^|;)\s*ocp-theme=(dark|light|system)\s*(?:;|$)/.exec(header ?? "");
  const value = match?.[1];
  return value === "light" || value === "system" || value === "dark" ? value : undefined;
}

function themeSwitch(theme: StudioTheme, label: string): string {
  const choice = (id: StudioTheme, text: string) =>
    `<button type="button" class="theme-choice${theme === id ? " active" : ""}" data-theme-choice="${id}" aria-pressed="${theme === id ? "true" : "false"}">${text}</button>`;
  return `<div class="theme-switch" role="radiogroup" aria-label="${label}">${choice("dark", "Dark")}${choice("light", "Light")}${choice("system", "System")}</div>`;
}

function renderApp(token: string, theme: StudioTheme = "dark"): string {
  return `<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Coding Partner · Studio</title>
<style nonce="${token}">
:root,html[data-theme="dark"]{color-scheme:dark;--bg:#06040f;--surface:#06040f;--surface-2:rgba(16,12,32,.82);--sidebar:rgba(8,6,18,.55);--inspector:rgba(8,6,18,.55);--line:rgba(255,255,255,.08);--muted:#9db0c9;--text:#eef2ff;--accent:#00d2ff;--accent-2:#c77dff;--accent-fg:#041018;--warn:#ffd166;--warn-fg:#1f1600;--danger:#ff4d6d;--danger-bg:#3b1d22;--danger-fg:#fecaca;--danger-line:#5c2b33;--glow:0 0 28px rgba(0,210,255,.22);--shadow:none;--focus:0 0 0 3px rgba(0,210,255,.28);--header-bg:rgba(8,6,18,.72);--mark-bg:linear-gradient(135deg,#00d2ff,#c77dff);--mark-fg:#041018;--mark-shadow:var(--glow);--segment-bg:rgba(6,4,15,.6);--segment-line:rgba(255,255,255,.08);--segment-fg:#9db0c9;--segment-hover:rgba(255,255,255,.06);--segment-active:linear-gradient(135deg,#00d2ff,#9b6dff);--segment-active-fg:#041018;--segment-shadow:var(--glow);--btn-bg:linear-gradient(135deg,#00d2ff,#9b6dff);--btn-hover:linear-gradient(135deg,#00d2ff,#9b6dff);--btn-fg:#041018;--btn-hover-shadow:var(--glow);--secondary-bg:rgba(255,255,255,.04);--secondary-fg:#eef2ff;--secondary-line:rgba(255,255,255,.08);--secondary-hover:rgba(255,255,255,.08);--secondary-hover-line:rgba(0,210,255,.45);--ghost-fg:#9db0c9;--ghost-hover:rgba(255,255,255,.06);--chip-bg:rgba(255,255,255,.04);--chip-fg:#d7e3f4;--chip-hover:rgba(255,255,255,.08);--field-bg:rgba(6,4,15,.72);--field-focus-bg:rgba(6,4,15,.9);--hover:rgba(255,255,255,.05);--selection-bg:rgba(0,210,255,.14);--selection-fg:#eef2ff;--selection-line:rgba(0,210,255,.35);--selection-shadow:0 0 18px rgba(0,210,255,.22);--selection-pill-bg:rgba(0,210,255,.16);--selection-pill-fg:#00d2ff;--selection-orb:0 0 10px rgba(0,210,255,.85);--card:rgba(17,14,32,.88);--card-line:rgba(255,255,255,.08);--card-shadow:none;--fold-bg:rgba(8,6,18,.55);--pill-bg:rgba(6,4,15,.55);--pill-fg:#00d2ff;--wait-fg:#ffd166;--wait-bg:rgba(50,36,8,.55);--wait-line:rgba(255,209,102,.35);--role-fg:#c4b5fd;--role-bg:rgba(40,18,64,.45);--role-line:rgba(199,125,255,.35);--live-fg:#041018;--live-bg:linear-gradient(135deg,#00ffa3,#00d2ff);--live-shadow:var(--glow);--orb-idle:#34d399;--orb-think:#c77dff;--orb-tool:#00ffa3;--orb-wait:#ffd166;--orb-shadow:0 0 10px rgba(0,210,255,.75);--orb-idle-shadow:0 0 10px rgba(52,211,153,.8);--orb-think-shadow:0 0 12px rgba(199,125,255,.9);--orb-tool-shadow:0 0 12px rgba(0,255,163,.8);--orb-wait-shadow:0 0 10px rgba(255,209,102,.85);--pulse:orb-glow-pulse 1.15s ease-in-out infinite;--code-bg:rgba(6,4,15,.9);--code-fg:#7dd3fc;--quote-bg:#0c131e;--quote-fg:#cbd5e1;--table-bg:#0a0f17;--table-alt:#0d1420;--table-head:#131d2c;--table-head-fg:#93c5fd;--table-line:#1e2b3e;--kbd-bg:rgba(6,4,15,.65);--approval-bg:linear-gradient(180deg,rgba(70,42,8,.78),rgba(24,16,8,.92));--approval-line:rgba(255,209,102,.5);--approval-shadow:0 0 24px rgba(255,209,102,.16);--badge-bg:#ffd166;--badge-fg:#1f1600;--grid:1;--page-bg:radial-gradient(900px 420px at 8% -10%,rgba(0,210,255,.16),transparent 55%),radial-gradient(800px 480px at 100% 0%,rgba(199,125,255,.18),transparent 50%),radial-gradient(600px 400px at 70% 110%,rgba(0,255,163,.08),transparent 45%),#06040f;--scrim:rgba(4,2,12,.55);--palette-bg:rgba(10,7,20,.94);--palette-line:rgba(0,210,255,.28);--palette-shadow:0 24px 80px rgba(0,0,0,.55),var(--glow);--palette-field:rgba(6,4,15,.72);--palette-item:rgba(0,210,255,.12);--human-bg:rgba(50,36,8,.78);--human-fg:#fde68a;--human-line:rgba(255,209,102,.45);--botbanner-bg:rgba(6,32,28,.72);--botbanner-fg:#a7f3d0;--botbanner-line:rgba(0,255,163,.35);--screen-bg:#040609;--screen-line:rgba(0,210,255,.4);--screen-shadow:var(--glow);--hud-bg:rgba(6,4,15,.92);--hud-fg:#00d2ff;--hud-line:#00d2ff;--click-line:#00d2ff;--click-fill:rgba(0,210,255,.28);--sheet:rgba(8,6,18,.96);--nav-bg:rgba(8,6,18,.94);--tab-rail:rgba(6,4,15,.55);--tab-active-bg:rgba(0,210,255,.16);--tab-active-fg:#00d2ff;--tab-active-shadow:var(--glow);--press:scale(.98);--group:#9db0c9;--chat-bg:transparent;--composer-bg:rgba(8,6,18,.62);--composer-field:rgba(6,4,15,.72);--graph-bg:rgba(0,210,255,.1);--graph-line:rgba(0,210,255,.3);--tool-bg:#0b1018;--tool-line:#1e2a3c;--tool-summary:#93c5fd;--md-h3:#93c5fd;--welcome-bg:linear-gradient(180deg,rgba(0,210,255,.1),rgba(12,10,24,.72));--welcome-line:rgba(0,210,255,.22);--welcome-blur:blur(12px);--welcome-anim:rise .45s cubic-bezier(.2,1.4,.3,1);--user-bg:rgba(0,210,255,.12);--user-fg:#eef2ff;--user-line:rgba(0,210,255,.32);--user-code:rgba(6,4,15,.55);--bot-bg:rgba(12,10,24,.78);--bot-line:rgba(255,255,255,.08);--event-bg:rgba(6,4,15,.65)}
html[data-theme="light"]{color-scheme:light;--bg:#f5f5f7;--surface:#ffffff;--surface-2:#f5f5f7;--sidebar:#f5f5f7;--inspector:#ffffff;--line:#d2d2d7;--muted:#6e6e73;--text:#1d1d1f;--accent:#0a66c2;--accent-2:#0a66c2;--accent-fg:#ffffff;--warn:#9a6700;--warn-fg:#1d1d1f;--danger:#d70015;--danger-bg:#fff2f1;--danger-fg:#d70015;--danger-line:#ffd1cd;--glow:none;--shadow:0 1px 2px rgba(0,0,0,.06);--focus:0 0 0 3px rgba(10,102,194,.28);--header-bg:rgba(255,255,255,.9);--mark-bg:#1d1d1f;--mark-fg:#f5f5f7;--mark-shadow:none;--segment-bg:#e8e8ed;--segment-line:transparent;--segment-fg:#1d1d1f;--segment-hover:rgba(255,255,255,.55);--segment-active:#ffffff;--segment-active-fg:#1d1d1f;--segment-shadow:0 1px 2px rgba(0,0,0,.08);--btn-bg:#0a66c2;--btn-hover:#005ec4;--btn-fg:#ffffff;--btn-hover-shadow:none;--secondary-bg:#e8e8ed;--secondary-fg:#1d1d1f;--secondary-line:transparent;--secondary-hover:#dedee3;--secondary-hover-line:transparent;--ghost-fg:#0a66c2;--ghost-hover:rgba(10,102,194,.08);--chip-bg:#ffffff;--chip-fg:#1d1d1f;--chip-hover:#f5f5f7;--field-bg:#ffffff;--field-focus-bg:#ffffff;--hover:rgba(0,0,0,.04);--selection-bg:#0a66c2;--selection-fg:#ffffff;--selection-line:transparent;--selection-shadow:none;--selection-pill-bg:rgba(255,255,255,.18);--selection-pill-fg:#ffffff;--selection-orb:0 0 0 2px rgba(255,255,255,.9);--card:#ffffff;--card-line:transparent;--card-shadow:var(--shadow);--fold-bg:#fbfbfd;--pill-bg:#f5f5f7;--pill-fg:#1d1d1f;--wait-fg:#9a6700;--wait-bg:#fff8eb;--wait-line:#f5d7a1;--role-fg:#6e6e73;--role-bg:#ffffff;--role-line:#d2d2d7;--live-fg:#146c2e;--live-bg:#e8f8ee;--live-shadow:none;--orb-idle:#34c759;--orb-think:#0a66c2;--orb-tool:#32ade6;--orb-wait:#ff9f0a;--orb-shadow:none;--orb-idle-shadow:none;--orb-think-shadow:none;--orb-tool-shadow:none;--orb-wait-shadow:none;--pulse:orb-soft-pulse 1.4s ease-in-out infinite;--code-bg:#f5f5f7;--code-fg:#1d1d1f;--quote-bg:#f5f5f7;--quote-fg:#6e6e73;--table-bg:#ffffff;--table-alt:#fbfbfd;--table-head:#f5f5f7;--table-head-fg:#1d1d1f;--table-line:#d2d2d7;--kbd-bg:#f5f5f7;--approval-bg:#ffffff;--approval-line:#d2d2d7;--approval-shadow:var(--shadow);--badge-bg:#d70015;--badge-fg:#ffffff;--grid:0;--page-bg:#f5f5f7;--scrim:rgba(0,0,0,.32);--palette-bg:#ffffff;--palette-line:#d2d2d7;--palette-shadow:0 24px 80px rgba(0,0,0,.18);--palette-field:#f5f5f7;--palette-item:#f5f5f7;--human-bg:#fff8eb;--human-fg:#6b4a00;--human-line:#f5d7a1;--botbanner-bg:#e8f8ee;--botbanner-fg:#146c2e;--botbanner-line:#b7ebc6;--screen-bg:#1d1d1f;--screen-line:#1d1d1f;--screen-shadow:0 12px 32px rgba(0,0,0,.12);--hud-bg:rgba(29,29,31,.9);--hud-fg:#f5f5f7;--hud-line:transparent;--click-line:#ffffff;--click-fill:rgba(10,102,194,.4);--sheet:#ffffff;--nav-bg:rgba(255,255,255,.94);--tab-rail:#f5f5f7;--tab-active-bg:#0a66c2;--tab-active-fg:#ffffff;--tab-active-shadow:none;--press:none;--group:#6e6e73;--chat-bg:#ffffff;--composer-bg:#ffffff;--composer-field:#f5f5f7;--graph-bg:#ffffff;--graph-line:#d2d2d7;--tool-bg:#fbfbfd;--tool-line:#d2d2d7;--tool-summary:#1d1d1f;--md-h3:#1d1d1f;--welcome-bg:#f5f5f7;--welcome-line:transparent;--welcome-blur:none;--welcome-anim:none;--user-bg:#0a66c2;--user-fg:#ffffff;--user-line:transparent;--user-code:rgba(255,255,255,.16);--bot-bg:#f5f5f7;--bot-line:transparent;--event-bg:#f5f5f7}
@media (prefers-color-scheme:light){html[data-theme="system"]{color-scheme:light;--bg:#f5f5f7;--surface:#ffffff;--surface-2:#f5f5f7;--sidebar:#f5f5f7;--inspector:#ffffff;--line:#d2d2d7;--muted:#6e6e73;--text:#1d1d1f;--accent:#0a66c2;--accent-2:#0a66c2;--accent-fg:#ffffff;--warn:#9a6700;--warn-fg:#1d1d1f;--danger:#d70015;--danger-bg:#fff2f1;--danger-fg:#d70015;--danger-line:#ffd1cd;--glow:none;--shadow:0 1px 2px rgba(0,0,0,.06);--focus:0 0 0 3px rgba(10,102,194,.28);--header-bg:rgba(255,255,255,.9);--mark-bg:#1d1d1f;--mark-fg:#f5f5f7;--mark-shadow:none;--segment-bg:#e8e8ed;--segment-line:transparent;--segment-fg:#1d1d1f;--segment-hover:rgba(255,255,255,.55);--segment-active:#ffffff;--segment-active-fg:#1d1d1f;--segment-shadow:0 1px 2px rgba(0,0,0,.08);--btn-bg:#0a66c2;--btn-hover:#005ec4;--btn-fg:#ffffff;--btn-hover-shadow:none;--secondary-bg:#e8e8ed;--secondary-fg:#1d1d1f;--secondary-line:transparent;--secondary-hover:#dedee3;--secondary-hover-line:transparent;--ghost-fg:#0a66c2;--ghost-hover:rgba(10,102,194,.08);--chip-bg:#ffffff;--chip-fg:#1d1d1f;--chip-hover:#f5f5f7;--field-bg:#ffffff;--field-focus-bg:#ffffff;--hover:rgba(0,0,0,.04);--selection-bg:#0a66c2;--selection-fg:#ffffff;--selection-line:transparent;--selection-shadow:none;--selection-pill-bg:rgba(255,255,255,.18);--selection-pill-fg:#ffffff;--selection-orb:0 0 0 2px rgba(255,255,255,.9);--card:#ffffff;--card-line:transparent;--card-shadow:var(--shadow);--fold-bg:#fbfbfd;--pill-bg:#f5f5f7;--pill-fg:#1d1d1f;--wait-fg:#9a6700;--wait-bg:#fff8eb;--wait-line:#f5d7a1;--role-fg:#6e6e73;--role-bg:#ffffff;--role-line:#d2d2d7;--live-fg:#146c2e;--live-bg:#e8f8ee;--live-shadow:none;--orb-idle:#34c759;--orb-think:#0a66c2;--orb-tool:#32ade6;--orb-wait:#ff9f0a;--orb-shadow:none;--orb-idle-shadow:none;--orb-think-shadow:none;--orb-tool-shadow:none;--orb-wait-shadow:none;--pulse:orb-soft-pulse 1.4s ease-in-out infinite;--code-bg:#f5f5f7;--code-fg:#1d1d1f;--quote-bg:#f5f5f7;--quote-fg:#6e6e73;--table-bg:#ffffff;--table-alt:#fbfbfd;--table-head:#f5f5f7;--table-head-fg:#1d1d1f;--table-line:#d2d2d7;--kbd-bg:#f5f5f7;--approval-bg:#ffffff;--approval-line:#d2d2d7;--approval-shadow:var(--shadow);--badge-bg:#d70015;--badge-fg:#ffffff;--grid:0;--page-bg:#f5f5f7;--scrim:rgba(0,0,0,.32);--palette-bg:#ffffff;--palette-line:#d2d2d7;--palette-shadow:0 24px 80px rgba(0,0,0,.18);--palette-field:#f5f5f7;--palette-item:#f5f5f7;--human-bg:#fff8eb;--human-fg:#6b4a00;--human-line:#f5d7a1;--botbanner-bg:#e8f8ee;--botbanner-fg:#146c2e;--botbanner-line:#b7ebc6;--screen-bg:#1d1d1f;--screen-line:#1d1d1f;--screen-shadow:0 12px 32px rgba(0,0,0,.12);--hud-bg:rgba(29,29,31,.9);--hud-fg:#f5f5f7;--hud-line:transparent;--click-line:#ffffff;--click-fill:rgba(10,102,194,.4);--sheet:#ffffff;--nav-bg:rgba(255,255,255,.94);--tab-rail:#f5f5f7;--tab-active-bg:#0a66c2;--tab-active-fg:#ffffff;--tab-active-shadow:none;--press:none;--group:#6e6e73;--chat-bg:#ffffff;--composer-bg:#ffffff;--composer-field:#f5f5f7;--graph-bg:#ffffff;--graph-line:#d2d2d7;--tool-bg:#fbfbfd;--tool-line:#d2d2d7;--tool-summary:#1d1d1f;--md-h3:#1d1d1f;--welcome-bg:#f5f5f7;--welcome-line:transparent;--welcome-blur:none;--welcome-anim:none;--user-bg:#0a66c2;--user-fg:#ffffff;--user-line:transparent;--user-code:rgba(255,255,255,.16);--bot-bg:#f5f5f7;--bot-line:transparent;--event-bg:#f5f5f7}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;color:var(--text);font:16px/1.47 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;letter-spacing:-.011em;height:100vh;display:flex;flex-direction:column;overflow:hidden;background:var(--page-bg)}
body::before{content:"";position:fixed;inset:0;pointer-events:none;opacity:var(--grid);background-image:linear-gradient(rgba(255,255,255,.015) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.015) 1px,transparent 1px);background-size:48px 48px;mask-image:radial-gradient(ellipse at center,black 40%,transparent 80%)}
header{min-height:52px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:var(--header-bg);backdrop-filter:saturate(160%) blur(18px);-webkit-backdrop-filter:saturate(160%) blur(18px);flex-shrink:0;gap:12px;z-index:5}
.brand-row{display:flex;align-items:center;gap:16px;min-width:0}
.brand{display:flex;align-items:center;gap:10px}
.mark{width:28px;height:28px;border-radius:8px;background:var(--mark-bg);color:var(--mark-fg);display:grid;place-items:center;font-weight:650;font-size:15px;letter-spacing:0;box-shadow:var(--mark-shadow)}
.brand strong{font-size:15px;font-weight:600;letter-spacing:-.02em}
.proj-bar{display:flex;align-items:center;gap:6px;background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:3px 6px 3px 12px}
.proj-bar span{font-size:12px;color:var(--muted);font-weight:500}
.proj-bar select{background:transparent;border:0;color:var(--text);font-weight:600;font-size:14px;padding:4px 6px;width:auto;min-width:140px;cursor:pointer}
.proj-bar select:focus{outline:none}
.stage-switch,.theme-switch{display:flex;background:var(--segment-bg);border:1px solid var(--segment-line);border-radius:10px;padding:2px;gap:2px}
.stage-btn,.theme-choice{background:transparent;color:var(--segment-fg);border:0;border-radius:8px;padding:6px 10px;font-weight:500;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:none}
.stage-btn:hover,.theme-choice:hover{background:var(--segment-hover);color:var(--text);box-shadow:none}
.stage-btn.active,.theme-choice.active{background:var(--segment-active);color:var(--segment-active-fg);box-shadow:var(--segment-shadow);font-weight:600}
.stage-btn:active,.theme-choice:active{transform:none;opacity:1}
.stage-btn:focus-visible,.theme-choice:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,.nav-item:focus-visible,.tab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.top-actions{display:flex;gap:8px;align-items:center}
.studio{display:grid;grid-template-columns:252px minmax(0,1fr) 560px;flex:1;min-height:0;overflow:hidden}
.studio.drawer-closed{grid-template-columns:252px minmax(0,1fr)}
.sidebar{border-right:1px solid var(--line);background:var(--sidebar);display:flex;flex-direction:column;min-height:0;padding:14px 12px;gap:14px;overflow-y:auto}
.sidebar-bots-wrap{flex:1;min-height:0;display:flex;flex-direction:column}
.center-col{display:flex;flex-direction:column;min-height:0;background:var(--surface);overflow:hidden}
.inspector{border-left:1px solid var(--line);background:var(--inspector);display:flex;flex-direction:column;min-height:0}
.inspector-shell{display:grid;grid-template-columns:176px minmax(0,1fr);flex:1;min-height:0}
.sec-label{font-size:12px;font-weight:600;letter-spacing:-.01em;color:var(--muted);margin:2px 8px 6px;display:flex;justify-content:space-between;align-items:center}
h1{font-size:17px;margin:0;font-weight:600;letter-spacing:-.022em}
h2{font-size:22px;margin:0 0 6px;font-weight:650;letter-spacing:-.022em}
h3{font-size:13px;margin:18px 0 6px;color:var(--muted);font-weight:600;letter-spacing:-.01em;text-transform:none}
.sub{color:var(--muted);font-size:14px;line-height:1.45;margin:0 0 14px}
label{display:grid;gap:6px;font-size:13px;font-weight:500;color:var(--text);margin:12px 0}
.col-flex{flex:1}
input,select,textarea{width:100%;background:var(--field-bg);border:1px solid var(--line);border-radius:10px;padding:9px 12px;color:var(--text);font:inherit;letter-spacing:-.011em}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:var(--focus);background:var(--field-focus-bg)}
textarea{min-height:72px;resize:vertical}
button{border:0;border-radius:10px;background:var(--btn-bg);color:var(--btn-fg);padding:8px 14px;font-weight:590;font-size:14px;letter-spacing:-.01em;cursor:pointer;box-shadow:none;white-space:nowrap}
button:hover{background:var(--btn-hover);box-shadow:var(--btn-hover-shadow)}
button:active{transform:var(--press);opacity:.92}
button.secondary{background:var(--secondary-bg);color:var(--secondary-fg);border:1px solid var(--secondary-line);box-shadow:none}
button.secondary:hover{background:var(--secondary-hover);border-color:var(--secondary-hover-line);box-shadow:none}
button.warn-btn{background:var(--warn);color:var(--warn-fg);border:0}
button.warn-btn:hover{filter:brightness(1.05)}
button.ghost{background:transparent;color:var(--ghost-fg);padding:4px 8px;font-weight:500;box-shadow:none}
button.ghost:hover{background:var(--ghost-hover);box-shadow:none}
button.danger{background:var(--danger-bg);color:var(--danger-fg);border:1px solid var(--danger-line);box-shadow:none}
button.danger:hover{filter:brightness(1.05);box-shadow:none}
button.chip{background:var(--chip-bg);color:var(--chip-fg);border:1px solid var(--line);border-radius:980px;padding:8px 14px;font-weight:500;font-size:13px;box-shadow:none}
button.chip:hover{background:var(--chip-hover);box-shadow:none}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row.nowrap{flex-wrap:nowrap}
.row.spread{justify-content:space-between}
.mt-sm{margin-top:8px}
.mb-sm{margin-bottom:8px}
.nav-list{display:grid;gap:2px}
.nav-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid transparent;cursor:pointer;color:var(--text)}
.nav-item:hover{background:var(--hover)}
.nav-item.selected{background:var(--selection-bg);color:var(--selection-fg);border-color:var(--selection-line);box-shadow:var(--selection-shadow)}
.nav-item.selected .meta,.nav-item.selected strong{color:var(--selection-fg)}
.nav-item.selected .pill{color:var(--selection-pill-fg);background:var(--selection-pill-bg);border-color:transparent}
.nav-item.selected button.ghost{color:var(--selection-fg)}
.nav-item.selected button.ghost:hover{background:var(--hover)}
.nav-item.selected .orb{box-shadow:var(--selection-orb)}
.nav-item .nav-main{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.nav-item strong{font-size:14px;font-weight:590;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav-actions{display:none;gap:2px}
.nav-item:hover .nav-actions,.nav-item:focus-within .nav-actions{display:flex}
.meta{font-size:12px;color:var(--muted);line-height:1.4}
.meta-break{font-size:12px;color:var(--muted);word-break:break-all}
.fold-box{margin:12px 0;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--fold-bg)}
.fold-summary{cursor:pointer;font-weight:590;font-size:13px;color:var(--text)}
.pill{font-size:12px;border:1px solid var(--line);background:var(--pill-bg);padding:2px 8px;border-radius:980px;color:var(--pill-fg);white-space:nowrap;display:inline-flex;align-items:center;gap:4px;font-weight:500}
.pill.wait{color:var(--wait-fg);border-color:var(--wait-line);background:var(--wait-bg)}
.pill.role{color:var(--role-fg);background:var(--role-bg);border-color:var(--role-line)}
.pill.live{color:var(--live-fg);background:var(--live-bg);border-color:transparent;box-shadow:var(--live-shadow);font-weight:700;letter-spacing:.04em}
.orb,.dot{width:8px;height:8px;border-radius:50%;background:var(--accent);display:inline-block;flex-shrink:0;box-shadow:var(--orb-shadow)}
.orb.idle,.dot{background:var(--orb-idle);box-shadow:var(--orb-idle-shadow)}
.orb.thinking,.dot.busy{background:var(--orb-think);box-shadow:var(--orb-think-shadow);animation:var(--pulse)}
.orb.tool{background:var(--orb-tool);box-shadow:var(--orb-tool-shadow);animation:var(--pulse)}
.orb.wait,.dot.wait{background:var(--orb-wait);box-shadow:var(--orb-wait-shadow);animation:var(--pulse)}
@keyframes orb-glow-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.35);opacity:.7}}
@keyframes orb-soft-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.chat-head{min-height:60px;padding:12px 22px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--surface);flex-shrink:0}
.chat-feed{flex:1;min-height:0;padding:28px 28px 18px;overflow-y:auto;display:grid;gap:16px;align-content:start;background:var(--chat-bg)}
.welcome-box{border:1px solid var(--welcome-line);border-radius:18px;padding:22px 22px 16px;background:var(--welcome-bg);backdrop-filter:var(--welcome-blur);-webkit-backdrop-filter:var(--welcome-blur);animation:var(--welcome-anim)}
.home-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:14px}
.home-card{padding:14px 16px;border-radius:14px;border:1px solid var(--card-line);background:var(--card);box-shadow:var(--card-shadow)}
.home-card strong{display:block;font-size:22px;font-weight:650;letter-spacing:-.03em;margin-top:2px}
.graph{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0}
.graph .node{padding:4px 10px;border-radius:980px;border:1px solid var(--graph-line);background:var(--graph-bg);font-size:13px}
.graph .edge{color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.turn{display:grid;gap:8px}
.msg-user{justify-self:end;max-width:72%;background:var(--user-bg);color:var(--user-fg);border:1px solid var(--user-line);border-radius:18px 18px 6px 18px;padding:10px 14px}
.msg-bot{justify-self:stretch;background:var(--bot-bg);border:1px solid var(--bot-line);border-radius:18px 18px 18px 6px;padding:14px 16px;cursor:pointer}
.msg-bot:hover,.msg-bot.selected{box-shadow:inset 0 0 0 1.5px var(--accent)}
.msg-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;font-size:12px;color:var(--muted)}
.msg-head strong{color:var(--text);font-size:14px;font-weight:600;display:inline-flex;align-items:center;gap:6px}
.msg-user .msg-head,.msg-user .msg-head strong,.msg-user .meta,.msg-user .md,.msg-user .md h1,.msg-user .md h2,.msg-user .md h3,.msg-user .md h4,.msg-user .md p,.msg-user .md li,.msg-user .md a{color:var(--user-fg)}
.msg-user .md code{background:var(--user-code);border-color:transparent;color:var(--user-fg)}
.composer{padding:12px 20px 16px;border-top:1px solid var(--line);background:var(--composer-bg);flex-shrink:0}
.composer-bar{display:flex;gap:10px;align-items:center;margin-bottom:8px;font-size:13px;color:var(--muted);flex-wrap:wrap}
.composer-bar select{width:auto;padding:6px 10px;font-size:13px;background:var(--composer-field);border-color:transparent}
.cheap-toggle{display:flex;align-items:center;gap:6px;margin:0;color:var(--text);font-weight:500}
.cheap-toggle input{width:auto;accent-color:var(--accent)}
.composer-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:stretch}
.composer-row textarea{min-height:48px;max-height:140px;margin:0;background:var(--composer-field);border-color:transparent;border-radius:14px}
.composer-row textarea:focus{background:var(--field-focus-bg);border-color:var(--accent)}
.composer-row button{padding:0 18px;border-radius:14px}
.activity{display:grid;gap:6px;margin:6px 0}
.event{font-size:13px;padding:8px 10px;border-left:3px solid var(--accent);background:var(--event-bg);color:var(--text);border-radius:0 10px 10px 0}
.event time{color:var(--muted);font-size:12px;margin-right:6px}
details.tools-fold{margin:8px 0;border:1px solid var(--tool-line);border-radius:10px;background:var(--tool-bg);padding:6px 10px;font-size:13px;color:var(--muted)}
details.tools-fold summary{cursor:pointer;font-weight:590;color:var(--tool-summary)}
.approval{border:1px solid var(--approval-line);background:var(--approval-bg);border-radius:16px;padding:14px;margin:10px 0;box-shadow:var(--approval-shadow);border-left:3px solid var(--warn)}
.approval h3{font-size:15px;margin:0 0 4px;color:var(--text);font-weight:650;letter-spacing:-.02em;text-transform:none}
.approval .kbd{font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--line);background:var(--kbd-bg);padding:2px 5px;border-radius:5px;color:var(--muted)}
.inbox-badge{min-width:18px;height:18px;border-radius:980px;background:var(--badge-bg);color:var(--badge-fg);font-size:11px;font-weight:650;display:inline-grid;place-items:center;padding:0 5px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code-bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;max-height:320px;overflow:auto;margin:8px 0;color:var(--text)}
.result{overflow-wrap:anywhere;line-height:1.5}
.err-text{color:var(--danger);margin-top:6px;white-space:pre-wrap}
.md h1,.md h2,.md h3,.md h4{color:var(--text);margin:12px 0 6px;line-height:1.25;text-transform:none;letter-spacing:-.02em}
.md h1{font-size:20px;border-bottom:1px solid var(--line);padding-bottom:6px}
.md h2{font-size:17px}
.md h3{font-size:15px;color:var(--md-h3)}
.md h4{font-size:14px;color:var(--text)}
.md p{margin:6px 0}
.md p:first-child{margin-top:0}
.md p:last-child{margin-bottom:0}
.md ul,.md ol{margin:6px 0;padding-left:20px}
.md li{margin:3px 0}
.md code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code-bg);border:1px solid var(--line);border-radius:6px;padding:1px 5px;color:var(--code-fg)}
.md pre code{background:transparent;border:0;padding:0;color:var(--text)}
.md blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid var(--accent);background:var(--quote-bg);color:var(--quote-fg);border-radius:0 8px 8px 0}
.md-table-wrap{overflow-x:auto;margin:8px 0}
.md-table{width:100%;border-collapse:collapse;font-size:13px;background:var(--table-bg);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.md-table th,.md-table td{border:1px solid var(--table-line);padding:6px 10px;text-align:left;vertical-align:top}
.md-table th{background:var(--table-head);color:var(--table-head-fg);font-weight:600}
.md-table tr:nth-child(even) td{background:var(--table-alt)}
.status{color:var(--muted);font-size:13px;min-height:16px;margin-top:6px}
.tabs{display:flex;flex-direction:column;gap:2px;border-right:1px solid var(--line);background:var(--tab-rail);padding:10px 8px 16px;overflow-y:auto;flex-shrink:0;min-height:0}
.tab-group{display:grid;gap:1px}
.tab-group-label{font-size:11px;font-weight:600;color:var(--group);letter-spacing:-.01em;padding:12px 10px 4px}
.tab{background:transparent;color:var(--text);border:0;border-radius:8px;padding:7px 10px;font-size:13px;font-weight:500;box-shadow:none;text-align:left;width:100%}
.tab:hover{background:var(--hover);box-shadow:none}
.tab.active{background:var(--tab-active-bg);color:var(--tab-active-fg);box-shadow:var(--tab-active-shadow);font-weight:590}
.tab:active{opacity:1;transform:none}
.drawer-body{flex:1;padding:22px 22px 28px;overflow-y:auto;min-height:0}
.drawer-body code,.drawer-body li{overflow-wrap:anywhere}
.comp-stage{flex:1;display:flex;flex-direction:column;min-height:0;padding:16px 20px;gap:12px;overflow-y:auto;background:var(--bg)}
.comp-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:10px 14px}
.comp-banner{border-radius:12px;padding:10px 14px;font-size:14px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.comp-banner.human{background:var(--human-bg);border:1px solid var(--human-line);color:var(--human-fg)}
.comp-banner.bot{background:var(--botbanner-bg);border:1px solid var(--botbanner-line);color:var(--botbanner-fg)}
.screen-stage-wrap{position:relative;flex:1;min-height:360px;border:1px solid var(--screen-line);border-radius:16px;overflow:hidden;background:var(--screen-bg);display:grid;place-items:center;outline:none;box-shadow:var(--screen-shadow)}
.screen-stage-wrap:focus{box-shadow:var(--focus),var(--screen-shadow)}
.screen-stage-wrap.human-mode{border-color:var(--warn)}
.screen-stage-wrap img{display:block;width:100%;max-height:calc(100vh - 285px);object-fit:contain;cursor:crosshair;user-select:none}
.click-dot{position:absolute;width:22px;height:22px;border:2px solid var(--click-line);background:var(--click-fill);border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;animation:ripple .45s ease-out}
@keyframes ripple{from{opacity:1;transform:translate(-50%,-50%) scale(.5)}to{opacity:0;transform:translate(-50%,-50%) scale(1.8)}}
.typing-hud{position:absolute;top:12px;left:12px;background:var(--hud-bg);border:1px solid var(--hud-line);color:var(--hud-fg);padding:6px 12px;border-radius:8px;font:500 12.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none;box-shadow:var(--glow)}
.screen-wrap{position:relative;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--screen-bg);margin:8px 0}
.screen-wrap img{display:block;width:100%;height:auto;cursor:crosshair}
.proj-meta-card{background:var(--card);border:1px solid var(--card-line);border-radius:14px;padding:12px 14px;box-shadow:var(--card-shadow)}
.proj-meta-card strong{display:block;font-size:15px;font-weight:650;letter-spacing:-.02em}
.sidebar-foot{margin-top:auto;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px}
.hidden{display:none!important}
.palette{position:fixed;inset:14vh 0 auto;margin:auto;width:min(560px,92vw);z-index:40;border-radius:16px;padding:8px;background:var(--palette-bg);border:1px solid var(--palette-line);box-shadow:var(--palette-shadow)}
.palette input{margin-bottom:6px;border:0;background:var(--palette-field);border-radius:10px}
.palette input:focus{box-shadow:none;background:var(--field-focus-bg);border:1px solid var(--accent)}
.palette-item{display:flex;justify-content:space-between;gap:8px;padding:9px 12px;border-radius:10px;cursor:pointer}
.palette-item[aria-selected="true"],.palette-item:hover{background:var(--palette-item)}
.palette-scrim{position:fixed;inset:0;background:var(--scrim);z-index:39}
.credits{font-size:14px;color:var(--muted);line-height:1.5}
.credits strong{color:var(--text)}
.mobile-nav{display:none}
.khint{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
ul{padding-left:18px}
li{margin:4px 0}
.onboard{position:fixed;inset:0;z-index:60;background:var(--scrim);display:grid;place-items:center;padding:20px}
.onboard-card{width:min(760px,100%);max-height:min(860px,calc(100vh - 40px));overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px 22px 18px}
.onboard-card h2{margin:0 0 8px;font-size:22px;letter-spacing:-.03em}
.onboard-paths{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
.onboard-paths strong{display:block;margin-bottom:6px}
.onboard-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
@media(max-width:820px){.onboard-paths{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important}
}
@media(max-width:1280px){
  .studio{grid-template-columns:228px minmax(0,1fr) 480px}
  .inspector-shell{grid-template-columns:156px minmax(0,1fr)}
}
@media(max-width:1100px){
  .studio{grid-template-columns:200px minmax(0,1fr) 420px}
  .inspector-shell{grid-template-columns:132px minmax(0,1fr)}
  .home-grid{grid-template-columns:1fr}
}
@media(max-width:820px){
  body{overflow:hidden}
  header{flex-wrap:wrap;height:auto;align-items:flex-start;padding:10px 12px}
  .brand{flex:0 0 auto}
  .brand strong{white-space:nowrap}
  .brand-row{flex-wrap:wrap;width:100%;gap:8px}
  .proj-bar{flex:1 1 100%;min-width:0}
  .proj-bar select{min-width:0;max-width:46vw}
  .top-actions{width:100%;flex-wrap:wrap}
  .top-actions .hide-sm,.stage-switch,#openComputerFromChatBtn{display:none}
  .theme-switch{order:-1}
  .chat-head{flex-wrap:wrap;align-items:flex-start;padding:12px 14px}
  .chat-head h1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .chat-feed{padding:16px}
  .welcome-box{padding:16px}
  .home-grid{grid-template-columns:1fr 1fr}
  .studio{grid-template-columns:1fr;padding-bottom:58px}
  .sidebar,.inspector{position:fixed;top:auto;bottom:58px;left:0;right:0;height:min(62vh,520px);z-index:8;border:1px solid var(--line);border-radius:16px 16px 0 0;display:none;background:var(--sheet);box-shadow:0 -8px 30px rgba(0,0,0,.18)}
  .studio.show-bots .sidebar,.studio.show-more .inspector{display:flex}
  .inspector-shell{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}
  .tabs{flex-direction:row;flex-wrap:nowrap;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);padding:8px;gap:6px;background:var(--sheet)}
  .tab-group{display:flex;gap:4px}
  .tab-group-label{display:none}
  .tab{width:auto}
  .mobile-nav{display:flex;position:fixed;left:0;right:0;bottom:0;height:58px;z-index:12;background:var(--nav-bg);border-top:1px solid var(--line);justify-content:space-around;align-items:center;padding:0 6px;backdrop-filter:saturate(160%) blur(18px)}
  .mobile-nav button{background:transparent;color:var(--muted);box-shadow:none;flex-direction:column;font-size:11px;font-weight:500;padding:6px}
  .mobile-nav button.active{color:var(--accent)}
  .mobile-nav button:hover{background:transparent;box-shadow:none}
}
</style></head><body>
<header>
  <div class="brand-row">
    <div class="brand">
      <div class="mark">O</div>
      <strong>Open Coding Partner</strong>
    </div>
    <div class="proj-bar">
      <span>Project</span>
      <select id="projectSelect" title="Switch active project &amp; its bot team"></select>
      <button type="button" class="ghost" id="openNewProjectBtn" title="Create or add a project">+ New Project</button>
    </div>
  </div>
  <div class="stage-switch" role="tablist" aria-label="Workspace View">
    <button type="button" class="stage-btn active" id="viewChatBtn" aria-selected="true">Team Chat</button>
    <button type="button" class="stage-btn" id="viewComputerBtn" aria-selected="false">Virtual Computer</button>
  </div>
  ${themeSwitch(theme, "Theme")}
  <div class="top-actions">
    <span id="modelChip" class="pill" title="Active model">No model configured</span>
    <button type="button" class="ghost hide-sm" id="openPaletteBtn" title="Command palette">⌘K</button>
    <button type="button" id="spawnTeamBtn" title="Create the starter team in this project">Spawn Team</button>
    <button type="button" class="secondary" id="openNewBotBtn">Add Bot</button>
    <button type="button" class="secondary" id="openInboxBtn">Inbox <span id="inboxCount" class="inbox-badge hidden">0</span></button>
    <button type="button" class="secondary hide-sm" id="openSettingsBtn">Settings</button>
    <button type="button" class="ghost hide-sm" id="toggleDrawerBtn" title="Show or hide side panel">Panel</button>
  </div>
</header>

<main class="studio" id="studioGrid">
  <aside class="sidebar" id="botsDrawer" aria-label="Team">
    <div class="proj-meta-card" id="activeProjectCard"></div>

    <div>
      <div class="sec-label"><span>Team Channel</span></div>
      <div id="channelTeamHq" class="nav-item selected">
        <div class="nav-main">
          <strong>#</strong>
          <div>
            <strong>project-hq</strong>
            <div class="meta">All bots · Ask the Team Lead</div>
          </div>
        </div>
      </div>
    </div>

    <div class="sidebar-bots-wrap">
      <div class="sec-label">
        <span>Your Project Bots</span>
        <button type="button" class="ghost" id="sidebarAddBotBtn">+ Add</button>
      </div>
      <div id="bots" class="nav-list"></div>
    </div>

    <div class="sidebar-foot" id="health">Checking OCP Agent &amp; OCP Coder…</div>
  </aside>

  <section class="center-col">
    <div id="chatStageView" class="center-col col-flex">
      <div class="chat-head">
        <div>
          <h1 id="activeRoomTitle"># project-hq</h1>
          <div class="meta" id="activeRoomSub">Shared project room · Ask the Team Lead to create bots, write code, or use the Virtual Computer.</div>
        </div>
        <div class="row">
          <button type="button" class="secondary hidden" id="allRoomBtn">Back to #project-hq</button>
          <button type="button" class="secondary" id="openComputerFromChatBtn">Open Virtual Computer</button>
          <button type="button" class="ghost" id="refresh" title="Refresh state">Refresh</button>
        </div>
      </div>

      <div id="chatFeed" class="chat-feed"></div>

      <div class="composer">
        <form id="taskForm">
          <div class="composer-bar">
            <span>Send to:</span>
            <select name="botId" id="botSelect" required></select>
            <span>Auto-Review by:</span>
            <select name="reviewerBotId" id="reviewerSelect"><option value="">No automatic review</option></select>
            <label class="cheap-toggle" for="cheapModeToggle"><input type="checkbox" id="cheapModeToggle"> Cheap mode</label>
            <span id="taskStatus" class="status"></span>
          </div>
          <div class="composer-row">
            <textarea name="prompt" id="promptInput" required placeholder="Tell your bots what to build, fix, or open on the Virtual Computer… (Press Enter to send)"></textarea>
            <button>Send</button>
          </div>
        </form>
      </div>
    </div>

    <div id="computerStageView" class="comp-stage hidden">
      <div id="computerStagePanel" class="col-flex"></div>
    </div>
  </section>

  <aside class="inspector" id="inspectorDrawer">
    <div class="inspector-shell">
    <nav class="tabs" aria-label="Inspector">
      <div class="tab-group">
        <div class="tab-group-label">Work</div>
        <button type="button" class="tab active" data-tab="detail">Activity</button>
        <button type="button" class="tab" data-tab="drafts">Drafts</button>
      </div>
      <div class="tab-group">
        <div class="tab-group-label">Team</div>
        <button type="button" class="tab" data-tab="bot">Bot</button>
        <button type="button" class="tab" data-tab="project">Project</button>
      </div>
      <div class="tab-group">
        <div class="tab-group-label">Computer</div>
        <button type="button" class="tab" data-tab="computer">Mini Screen</button>
      </div>
      <div class="tab-group">
        <div class="tab-group-label">Connect</div>
        <button type="button" class="tab" data-tab="connectors">Connectors</button>
        <button type="button" class="tab" data-tab="plugins">Plugins</button>
        <button type="button" class="tab" data-tab="channels">Channels</button>
        <button type="button" class="tab" data-tab="accounts">Accounts</button>
        <button type="button" class="tab" data-tab="vault">Vault</button>
      </div>
      <div class="tab-group">
        <div class="tab-group-label">Library</div>
        <button type="button" class="tab" data-tab="skills">Skills</button>
        <button type="button" class="tab" data-tab="routines">Routines</button>
        <button type="button" class="tab" data-tab="issue-pr">Issue to PR</button>
      </div>
      <div class="tab-group">
        <div class="tab-group-label">System</div>
        <button type="button" class="tab" data-tab="usage">Usage</button>
        <button type="button" class="tab" data-tab="audit">Audit</button>
        <button type="button" class="tab" data-tab="category">Category</button>
        <button type="button" class="tab" data-tab="settings">Settings</button>
        <button type="button" class="tab" data-tab="credits">Credits</button>
      </div>
    </nav>

    <div class="drawer-body">
      <div id="tab-detail" class="tab-pane">
        <div id="detail"></div>
        <details class="fold-box mt-sm">
          <summary class="fold-summary">Recent project tasks (<span id="taskCount">0</span>)</summary>
          <div id="tasks" class="nav-list mt-sm"></div>
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
          <label>Bot Name<input name="name" required placeholder="e.g. Lead, Coder, QA"></label>
          <div class="row">
            <label class="col-flex">Role<select name="role"><option value="general">Team Lead (Orchestrator)</option><option value="coding">Coder (Writes Code)</option><option value="qa">QA Tester (Verifies Work)</option><option value="security">Security Guard (Audits)</option><option value="computer">Computer Operator (Browser/GUI)</option><option value="research">Researcher</option></select></label>
            <label class="col-flex">Runtime<select name="runtime"><option value="ocp-agent">OCP Agent</option><option value="ocp-coder">OCP Coder</option></select></label>
          </div>
          <label>Instructions (optional)<textarea name="instructions" placeholder="Leave blank for smart default instructions…"></textarea></label>
          <details class="fold-box">
            <summary class="fold-summary">Advanced Project Path, Sandbox &amp; Model Override</summary>
            <label>Project Workspace Path<input name="workspace" required value="${escapeAttribute(process.cwd())}"></label>
            <label>Tool Isolation<select name="isolation"><option value="host">Host process (fast local)</option><option value="docker">Docker container sandbox</option></select></label>
            <label id="networkField" class="hidden">Docker Network<select name="network"><option value="disabled">Disabled</option><option value="enabled">Enabled</option></select></label>
            <label>Provider Override<select name="provider"><option value="">Use global API key / default</option><option value="openrouter">OpenRouter</option><option value="litellm">OpenAI-compatible</option></select></label>
            <label class="provider-field hidden">Model ID<input name="model" placeholder="Model id you configured"></label>
            <label>Cheap model id<input name="cheapModel" placeholder="Blank uses the strong model for cheap steps"></label>
            <label>Route<select name="routeMode"><option value="auto">Auto: cheap for classify, summary, and lint-fix</option><option value="cheap">Cheap model for every step</option><option value="strong">Strong model for every step</option></select></label>
            <label>Default action<select name="actionRule"><option value="ask">Ask before each action</option><option value="act">Act</option><option value="act-if-preapproved">Act if pre-approved</option><option value="handoff">Hand off</option></select></label>
            <label>Pre-approved actions<input name="preapproved" placeholder="calendar_create, vault_fill"></label>
            <label>Per-action rules<textarea name="actionBy" placeholder="calendar_create=act"></textarea></label>
            <p class="meta">Outbound email and chat stay draft cards. Act does not send them.</p>
            <label class="provider-field hidden">OpenAI-compatible endpoint<input name="endpoint" placeholder="http://127.0.0.1:11434/v1"></label>
            <label class="provider-field hidden">API Key Env<input name="apiKeyEnv" value="LITELLM_API_KEY"></label>
            <label>MCP servers (JSON name + url only; tokens belong in Connectors)<textarea name="mcpServers" placeholder='[{"name":"docs","url":"http://127.0.0.1:3100"}]'></textarea></label>
          </details>
          <div class="row mt-sm">
            <button id="botSubmit">Save Bot</button>
            <button id="botEditCancel" type="button" class="secondary hidden">Reset</button>
          </div>
        </form>
        <div id="botStatus" class="status"></div>
        <h3>Responsibility</h3>
        <p class="sub">A lasting goal for one bot. It stays until you mark it done. A routine can name its id in the prompt.</p>
        <form id="responsibilityForm">
          <label>Bot<select name="botId" id="responsibilityBot" required></select></label>
          <label>Goal<input name="goal" required placeholder="Keep the README accurate"></label>
          <button type="submit">Save responsibility</button>
        </form>
        <div id="responsibilityList" class="nav-list mt-sm"></div>
        <h3>Thread</h3>
        <p class="sub">Address two bots in one thread. With no model configured, each bot records that it will not invent an action.</p>
        <form id="threadForm">
          <label>First bot<select name="botA" id="threadBotA" required></select></label>
          <label>Second bot<select name="botB" id="threadBotB" required></select></label>
          <label>Message<input name="text" required placeholder="Look at this together"></label>
          <button type="submit">Start thread</button>
        </form>
        <form id="reachForm" class="mt-sm">
          <label>Thread id<input name="threadId" id="reachThread" required></label>
          <label>Channel<select name="channel"><option value="slack">Slack</option><option value="telegram">Telegram</option><option value="whatsapp">WhatsApp</option><option value="teams">Teams</option></select></label>
          <label>Destination<input name="destination" required placeholder="#project or a chat id"></label>
          <button type="submit" class="secondary">Draft reach</button>
        </form>
        <p class="meta">Draft reach does not send. Nothing is sent automatically. Allowing a Teams draft still sends nothing.</p>
        <div id="threadList" class="nav-list mt-sm"></div>
        <h3>Open work</h3>
        <p class="sub">Approvals waiting, unsent drafts, open responsibilities, and routines. This list does not send anything.</p>
        <div id="activityList" class="nav-list mt-sm"></div>
        <h3>Hand off</h3>
        <p class="sub">Give a finished task to another bot. The new task is queued for that bot.</p>
        <form id="handForm">
          <label>Finished task<input name="taskId" required></label>
          <label>Bot<select name="botId" id="handBot"></select></label>
          <button type="submit" class="secondary">Hand off</button>
        </form>
        <h3>Save as routine</h3>
        <form id="routineFromTaskForm" class="mt-sm">
          <label>Finished task<input name="taskId" required></label>
          <label>Every milliseconds<input name="everyMs" required placeholder="900000"></label>
          <button type="submit" class="secondary">Save routine</button>
        </form>
        <h3>Responsibility check</h3>
        <p class="sub">A standing check waits at least 15 minutes and stays read-only.</p>
        <form id="checkForm">
          <label>Responsibility id<input name="id" required></label>
          <label>Every milliseconds<input name="everyMs" required placeholder="900000"></label>
          <button type="submit" class="secondary">Schedule check</button>
        </form>
        <h3>Memory</h3>
        <p class="sub">Facts this workspace remembers. Correct or forget them here. The model is not the only writer.</p>
        <form id="memoryForm">
          <input type="hidden" name="workspace" id="memoryWorkspace">
          <label>Find<input name="query" required></label>
          <label>Replacement<input name="replacement" placeholder="Leave blank to forget"></label>
          <button type="submit">Update memory</button>
        </form>
        <div id="memoryList" class="meta mt-sm"></div>
      </div>

      <div id="tab-project" class="tab-pane hidden">
        <h2>New Project / Product</h2>
        <p class="sub">Every project gets its own workspace directory and its own dedicated team of bots.</p>
        <form id="projectForm">
          <label>Project / Product Name<input name="name" required placeholder="e.g. MobileApp, PaymentsAPI, SaaS-Landing"></label>
          <label>Workspace Folder Path (optional)<input name="workspace" placeholder="Leave blank to create folder automatically"></label>
          <label>Description (optional)<input name="description" placeholder="Short summary of this product"></label>
          <label>Starter Bot Team<select name="mode">
            <option value="team">Full 5-bot team (Lead, Coder, QA, Security, Computer)</option>
            <option value="lead">Team Lead only</option>
            <option value="none">Empty (Add bots manually)</option>
          </select></label>
          <button type="submit" class="mt-sm">Create Project &amp; Team</button>
        </form>
        <div id="projectStatus" class="status"></div>
      </div>

      <div id="tab-audit" class="tab-pane hidden">
        <h2>Audit</h2>
        <p class="sub">Permitted, refused, and failed actions. A refused row names the rule. Secrets are not stored here.</p>
        <form id="ruleForm">
          <label>Tool<input name="tool" required placeholder="workspace_shell"></label>
          <label>Path prefix<input name="pathPrefix" placeholder="src/"></label>
          <label>Command prefix<input name="argvPrefix" placeholder="git push"></label>
          <label>Who<select name="initiator"><option value="">Anyone</option><option value="person">A person</option><option value="routine">A routine</option></select></label>
          <button type="submit">Save deny rule</button>
        </form>
        <div id="auditList" class="nav-list mt-sm"></div>
      </div>

      <div id="tab-category" class="tab-pane hidden">
        <h2>Category</h2>
        <p class="sub">A foreign agent on this machine, component replies, a local directory, and pages. WhatsApp reach stays a draft. Allowing that draft still sends nothing. Teams reach stays a draft too. Company sign-in checks a signed assertion on this machine and does not contact a company directory.</p>
        <form id="agentForm">
          <label>Agent name<input name="name" required></label>
          <label>Loopback URL<input name="url" required placeholder="http://127.0.0.1:9/agent"></label>
          <button type="submit">Register agent</button>
        </form>
        <div id="agentList" class="meta mt-sm"></div>
        <div id="componentList" class="nav-list mt-sm"></div>
        <h3>Directory</h3>
        <form id="directoryForm">
          <label>Name<input name="name" required></label>
          <label>Role<select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label>
          <label>Password<input name="password" type="password" required></label>
          <button type="submit">Add person</button>
        </form>
        <form id="companyForm" class="mt-sm">
          <label>Company assertion secret<input name="secret" type="password" required></label>
          <button type="submit" class="secondary">Enable company sign-in</button>
        </form>
        <div id="directoryList" class="meta mt-sm"></div>
        <h3>Pages</h3>
        <form id="pageForm">
          <label>Title<input name="title" required></label>
          <label>Body<textarea name="body" required></textarea></label>
          <button type="submit">Save page</button>
        </form>
        <div id="pageList" class="nav-list mt-sm"></div>
      </div>

      <div id="tab-settings" class="tab-pane hidden">
        <h2>Model &amp; providers</h2>
        <div class="fold-box">
          <h3>Appearance</h3>
          <p class="sub">Dark is the first look. System follows this device.</p>
          ${themeSwitch(theme, "Appearance")}
        </div>
        <p class="sub">Point OCP at a local OpenAI-compatible server or a cloud provider. Keys stay on this machine (mode 0600).</p>
        <div class="row mb-sm">
          <button type="button" id="useLocalGpuBtn">Use local GPU (Ollama)</button>
          <button type="button" class="secondary" id="useOpenRouterPresetBtn">Use OpenRouter</button>
        </div>
        <form id="settingsForm">
          <label>OpenRouter API Key<input type="password" name="openrouterApiKey" placeholder="sk-or-v1-..."></label>
          <label>OpenAI API Key<input type="password" name="openaiApiKey" placeholder="sk-..."></label>
          <label>OpenAI-compatible API key<input type="password" name="litellmApiKey" placeholder="sk-..."></label>
          <label>Local / custom base URL<input name="litellmBaseUrl" placeholder="http://127.0.0.1:11434/v1"></label>
          <label>Default Model ID<input name="defaultModel" placeholder="Leave blank until you choose a model"></label>
          <button type="submit">Save &amp; Apply Immediately</button>
        </form>
        <div class="fold-box mt-sm">
          <h3>Channels in this app</h3>
          <p class="sub">Tokens stay in local settings.json (mode 0600). Empty fields are left unchanged.</p>
          <label>Slack bot token<input type="password" name="slackBotToken" form="settingsForm" placeholder="xoxb-…"></label>
          <label>Slack signing secret<input type="password" name="slackSigningSecret" form="settingsForm"></label>
          <label>Telegram bot token<input type="password" name="telegramBotToken" form="settingsForm"></label>
          <label>Telegram webhook secret<input type="password" name="telegramWebhookSecret" form="settingsForm"></label>
          <p class="meta" id="channelStatus">Slack and Telegram: not configured</p>
        </div>
        <div id="settingsStatus" class="status"></div>
      </div>

      <div id="tab-usage" class="tab-pane hidden">
        <h2>Usage</h2>
        <p class="sub">Tokens come from the provider. A number is marked estimated only when the provider sent none. Cost uses prices you enter. Local models stay at the $0 default until you enter one. OCP does not invent prices.</p>
        <div id="usagePanel"></div>
      </div>

      <div id="tab-credits" class="tab-pane hidden">
        <h2>Credits</h2>
        <p class="credits">User-facing product name: <strong>Open Coding Partner (OCP)</strong>.</p>
        <p class="credits">Third-party components documented in NOTICE / THIRD_PARTY_NOTICES: OpenClaw, Hermes, Grok Build, Laya, LiteLLM, and xAI. They are not product names in the rest of this app.</p>
        <p class="credits">OpenBot (MIT, CopilotKit) is credited for the coworker shape: a computer per coworker, a recorded gate, and taking the controls. This app implements that shape in its own code. No OpenBot source is copied.</p>
        <p class="credits">AG-UI is the public Agent User Interaction Protocol. This app speaks the HTTP and event-stream binding in its own code. No protocol SDK is copied.</p>
      </div>

      <div id="tab-routines" class="tab-pane hidden">
        <h2>Routines</h2>
        <p class="sub">Intervals, five-field cron with an IANA timezone, and named events enqueue a bot task. A signed webhook can start the same routine. The signing secret is shown once and is not kept in the page.</p>
        <p class="meta">Webhook requests send the raw body with headers x-ocp-timestamp (unix milliseconds) and x-ocp-signature (hex HMAC-SHA256 of timestamp + &quot;.&quot; + body). A bad or replayed signature does not start a task.</p>
        <form id="routineForm">
          <label>Bot<select name="botId" id="routineBotSelect" required></select></label>
          <label>Prompt<textarea name="prompt" required placeholder="What should run on a schedule or event?"></textarea></label>
          <label>Every (seconds)<input name="everySec" type="number" min="1" placeholder="Leave empty if using an event or cron"></label>
          <label>Event name<input name="event" placeholder="e.g. build-finished"></label>
          <label>Cron (minute hour day month weekday)<input name="cron" placeholder="0 9 * * 1" autocomplete="off"></label>
          <label>Timezone<input name="timezone" placeholder="America/New_York" autocomplete="off"></label>
          <label><input type="checkbox" name="webhook"> Signed inbound webhook</label>
          <button type="submit">Save routine</button>
        </form>
        <div id="routineStatus" class="status"></div>
        <div id="routineList" class="nav-list mt-sm"></div>
        <form id="routineEventForm" class="mt-sm">
          <label>Fire event<input name="name" required placeholder="build-finished"></label>
          <button type="submit" class="secondary">Fire now</button>
        </form>
      </div>

      <div id="tab-connectors" class="tab-pane hidden">
        <h2>Connectors</h2>
        <p class="sub">HTTP MCP servers for one bot. A token is stored locally and is never shown again. Test connection lists tools or shows the server error.</p>
        <label>Bot<select id="connectorBot"></select></label>
        <form id="connectorForm">
          <label>Name<input name="name" required placeholder="docs" pattern="[A-Za-z0-9._-]{1,80}"></label>
          <label>URL<input name="url" required placeholder="http://127.0.0.1:3100/mcp"></label>
          <label>Auth header name<input name="authHeader" placeholder="Authorization"></label>
          <label>Token<input type="password" name="authToken" autocomplete="off" placeholder="Leave blank to keep the saved token"></label>
          <button type="submit">Add connector</button>
        </form>
        <div id="connectorStatus" class="status"></div>
        <div id="connectorList" class="nav-list mt-sm"></div>
      </div>

      <div id="tab-plugins" class="tab-pane hidden">
        <h2>Plugins</h2>
        <p class="sub">Install a plugin on one bot. Skills and connectors stay on that bot. A checksum proves the manifest. It does not constrain the remote server after install.</p>
        <p class="meta">Drafts still wait for a person. Allowing a WhatsApp or Teams draft still sends nothing.</p>
        <label>Search<input id="pluginSearch" placeholder="Search plugins" autocomplete="off"></label>
        <div id="pluginStatus" class="status"></div>
        <div id="pluginList" class="nav-list mt-sm"></div>
      </div>

      <div id="tab-channels" class="tab-pane hidden">
        <h2>Channels</h2>
        <p class="sub">Slack and Telegram messages become tasks for the assigned bot. Replies stay as drafts until you send them. Nothing is sent automatically. Tokens stay in Settings.</p>
        <div id="channelPanel"></div>
      </div>

      <div id="tab-drafts" class="tab-pane hidden">
        <h2>Drafts</h2>
        <p class="sub">Every outbound email or message stays here until you send it. Nothing is sent automatically.</p>
        <div id="draftsPanel"></div>
      </div>

      <div id="tab-skills" class="tab-pane hidden">
        <h2>Skills</h2>
        <p class="sub">Reusable multi-step skills. A bot loads one on demand through tool search. Packs import from a zip or a git URL.</p>
        <form id="skillForm">
          <input type="hidden" name="skillId">
          <label>Name<input name="name" required placeholder="Review a diff"></label>
          <label>When to use<input name="whenToUse" required placeholder="Review a code change before a person opens a pull request."></label>
          <label>Steps<textarea name="body" required placeholder="1. Read the diff."></textarea></label>
          <div class="row">
            <button type="submit">Save skill</button>
            <button type="button" id="skillReset" class="secondary">Clear</button>
          </div>
        </form>
        <form id="skillImportForm" class="mt-sm">
          <label>Git URL<input name="gitUrl" placeholder="Local path or https git URL"></label>
          <label>Zip pack<input type="file" name="zip" accept=".zip,application/zip"></label>
          <div class="row">
            <button type="submit">Import pack</button>
            <button type="button" id="skillExport" class="secondary">Export zip</button>
          </div>
        </form>
        <div id="skillStatus" class="status"></div>
        <div id="skillList" class="nav-list mt-sm"></div>
      </div>

      <div id="tab-issue-pr" class="tab-pane hidden">
        <h2>Issue to PR</h2>
        <p class="sub">A GitHub or Linear issue becomes a task. Approve the plan, edit, run tests, then open a pull request with the plan, the diff, and the test output. Merging stays with a person.</p>
        <form id="issueForm">
          <label>Bot<select name="botId" id="issueBot" required></select></label>
          <label>Source<select name="provider"><option value="github">GitHub</option><option value="linear">Linear</option></select></label>
          <label>Issue<input name="issue" required placeholder="owner/name#12 or TEAM-12"></label>
          <label>Repository<input name="repo" required placeholder="owner/name"></label>
          <label>Base branch<input name="base" value="main"></label>
          <label>Issue token vault item<input name="vaultItem" required placeholder="github-token"></label>
          <label>GitHub token vault item<input name="githubVaultItem" placeholder="Same as the issue token when the source is GitHub"></label>
          <button type="submit">Start from issue</button>
        </form>
        <div id="issueStatus" class="status"></div>
        <div id="issueList" class="nav-list mt-sm"></div>
      </div>

      <div id="tab-vault" class="tab-pane hidden">
        <h2>Vault</h2>
        <p class="sub">Logins, tokens, and OAuth secrets stay in this vault. A bot fills a virtual-computer login by item name. The secret is not sent to the model and is not written in the task log. A sign-in, 2FA, or captcha asks you to Take Control.</p>
        <div id="vaultPanel"></div>
      </div>

      <div id="tab-accounts" class="tab-pane hidden">
        <h2>Accounts</h2>
        <p class="sub">OCP ships no OAuth client. Paste a Google or Microsoft client you created. These are the only scopes requested, and they are shown again before consent. See docs/oauth-setup.md. Refresh tokens stay in the vault.</p>
        <h3>Google scopes</h3>
        <ul>${GOOGLE_SCOPES.map((scope) => `<li><code>${escapeAttribute(scope.id)}</code> — ${escapeAttribute(scope.label)}</li>`).join("")}</ul>
        <h3>Microsoft scopes</h3>
        <ul>${MICROSOFT_SCOPES.map((scope) => `<li><code>${escapeAttribute(scope.id)}</code> — ${escapeAttribute(scope.label)}</li>`).join("")}</ul>
        <div id="accountsPanel"></div>
      </div>
    </div>
    </div>
  </aside>
</main>
<nav class="mobile-nav" aria-label="Primary">
  <button type="button" class="active" data-mobile="chat">Chat</button>
  <button type="button" data-mobile="bots">Team</button>
  <button type="button" data-mobile="computer">Desktop</button>
  <button type="button" data-mobile="inbox">Inbox</button>
  <button type="button" data-mobile="more">More</button>
</nav>
<div id="paletteScrim" class="palette-scrim hidden" hidden></div>
<div id="onboard" class="onboard hidden" hidden role="dialog" aria-modal="true" aria-labelledby="onboardTitle">
  <div class="onboard-card">
    <h2 id="onboardTitle">Start Open Coding Partner</h2>
    <p class="sub">A local coding partner. Pick a model, then open a desk on this machine or in Docker.</p>
    <div id="onboardBody"></div>
  </div>
</div>
<div id="palette" class="palette hidden" hidden role="dialog" aria-modal="true" aria-label="Command palette">
  <input id="paletteInput" placeholder="Jump to chat, computer, settings, spawn team…" aria-label="Command search">
  <div id="paletteList" role="listbox"></div>
</div>

<script nonce="${token}">const TOKEN='${token}',DEFAULT_WS='${escapeJs(process.cwd())}';let state={projects:[],bots:[],tasks:[],routines:[],channels:{},channelLog:[],handoffs:[],skills:[],plugins:[],issueRuns:[],vault:{items:[]},accounts:{},activeBrainLabel:'',activeModel:''},activeWorkspace='',selected='',conversationBot='',computerBot='',computerMeta=null,bootstrapped=false,activeTab='detail',centerView='chat',lastClickPt=null,renderedCompBot='',lastFrameSrc='',lastSyncedUrl='',lastSidebarSig='',lastChatSig='',lastDetailSig='',keyBuffer='',keyTimer=null,lastCompInteract=0,compQueue=Promise.resolve(),paletteIndex=0,sseLive=false,connectorBot='';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const googleSignInNote='Google and Microsoft connectors use an OAuth client you paste in Accounts. OCP ships no OAuth client. Take Control on this virtual computer to sign in on a page yourself.';
const isAgentRuntime=r=>r==='ocp-agent'||r==='hermes';
const runtimeLabel=r=>isAgentRuntime(r)?'OCP Agent':'OCP Coder';
const roleFriendly=r=>({general:'Team Lead',coding:'Coder',qa:'QA Tester',security:'Security',research:'Researcher',computer:'Computer'}[r]||r);
function hiddenPath(p){return String(p||'').replace(/\\\\/g,'/').split('/').some(s=>s==='.ocp'||s==='gtm')}
function visibleFiles(files){return (files||[]).filter(f=>!hiddenPath(f.path))}
function orbClass(bot,tasks){const t=tasks.find(x=>x.botId===bot.id&&['queued','running','awaiting-approval'].includes(x.status));if(!t)return 'orb idle';if(t.status==='awaiting-approval')return 'orb wait';if((t.events||[]).length)return 'orb tool';return 'orb thinking'}
function pendingApprovals(){return (state.tasks||[]).filter(t=>t.pendingApproval)}
function approvalCard(t,p){const title=String(p.title||'').toLowerCase();const risk=/delete|shell|browser|mouse|key/.test(title)?'High':'Normal';const bot=state.bots.find(x=>x.id===t.botId);const preview=p.description?'<pre>'+esc(typeof p.description==='string'?p.description:JSON.stringify(p.description,null,2))+'</pre>':'';const opts=projectBots().filter(b=>b.id!==t.botId).map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+'</option>').join('');const kind=p.subject&&p.subject.kind;const usageCap=kind==='usage-cap';const hardCap=kind==='usage-hard-cap';const allowLabel=usageCap?'Continue':'Allow once <span class="kbd">⌘↵</span>';const denyLabel=(usageCap||hardCap)?'Leave paused':'Deny <span class="kbd">Esc</span>';const allowBtn=hardCap?'':'<button type="button" data-appr="allow-once" data-tid="'+esc(t.id)+'" data-req="'+esc(p.id)+'">'+allowLabel+'</button>';const alwaysBtn=(usageCap||hardCap)?'':'<button type="button" class="secondary" data-appr="always" data-tid="'+esc(t.id)+'" data-req="'+esc(p.id)+'">Always for task</button>';const redirect=(usageCap||hardCap)?'':'<div class="row mt-sm"><select data-redirect-select="'+esc(t.id)+'"><option value="">Redirect to…</option>'+opts+'</select><button type="button" class="secondary" data-appr="redirect" data-tid="'+esc(t.id)+'" data-req="'+esc(p.id)+'">Redirect</button></div>';return '<div class="approval" role="alertdialog" aria-label="Approval needed"><h3>'+esc(p.title||'Permission requested')+'</h3><div class="meta mb-sm">Bot: '+esc(bot?.name||t.botId)+' · Action: '+esc(p.title||'')+(usageCap||hardCap?'':' · Risk: '+risk)+'</div>'+preview+'<div class="row">'+allowBtn+alwaysBtn+'<button type="button" class="danger" data-appr="cancelled" data-tid="'+esc(t.id)+'" data-req="'+esc(p.id)+'">'+denyLabel+'</button></div>'+redirect+'</div>'}
function bindApprovals(){document.querySelectorAll('[data-appr]').forEach(el=>el.addEventListener('click',async e=>{e.stopPropagation();const decision=el.dataset.appr;const body={requestId:el.dataset.req,decision,approved:decision==='allow-once'||decision==='always'};if(decision==='redirect'){const sel=document.querySelector('[data-redirect-select="'+el.dataset.tid+'"]');body.redirectBotId=sel&&sel.value}try{await api('/api/tasks/'+encodeURIComponent(el.dataset.tid)+'/approval',body);await load()}catch(err){alert(err.message)}}))}
function channelDrafts(){return (state.channelLog||[]).filter(m=>m.direction==='out'&&m.status==='draft')}
function draftCard(m){const bot=state.bots.find(b=>b.id===m.botId);const subject=m.subject?'<div class="meta">'+esc(m.subject)+'</div>':'';return '<div class="approval" role="alertdialog" aria-label="Reply draft"><h3>Send '+esc(m.channel)+' reply?</h3><div class="meta mb-sm">'+(bot?esc(bot.name)+' · ':'')+esc(m.destination)+'</div>'+subject+'<pre>'+esc(m.text||'')+'</pre><div class="row"><button type="button" data-draft="allow" data-draft-id="'+esc(m.id)+'">Send reply</button><button type="button" class="danger" data-draft="deny" data-draft-id="'+esc(m.id)+'">Do not send</button></div></div>'}
function bindDrafts(){document.querySelectorAll('[data-draft]').forEach(el=>{el.onclick=async()=>{try{await api('/api/channels/drafts/'+encodeURIComponent(el.dataset.draftId),{decision:el.dataset.draft});lastDraftsSig='';await load()}catch(err){alert(err.message)}}})}
let lastDraftsSig='';
function renderDrafts(){
  const box=document.querySelector('#draftsPanel');
  if(!box)return;
  const drafts=channelDrafts();
  const handoffs=state.handoffs||[];
  const sig=JSON.stringify([drafts,handoffs]);
  if(sig===lastDraftsSig)return;
  lastDraftsSig=sig;
  const cards=drafts.map(draftCard).join('')||'<div class="meta">No drafts waiting.</div>';
  const handed=handoffs.slice().reverse().map(h=>{const bot=state.bots.find(b=>b.id===h.botId);return '<div class="approval"><h3>Handed off '+esc(h.action)+'</h3><div class="meta">'+(bot?esc(bot.name)+' · ':'')+esc(h.createdAt||'')+'</div><p>'+esc(h.summary||'')+'</p><p class="meta">A person needs to do this. It was not performed.</p></div>'}).join('');
  box.innerHTML=cards+(handed?'<h3>Handoffs</h3>'+handed:'');
  bindDrafts();
}
let lastSkillsSig='';
function renderSkills(){
  const box=document.querySelector('#skillList');
  if(!box)return;
  const skills=state.skills||[];
  const sig=JSON.stringify(skills);
  if(sig===lastSkillsSig)return;
  lastSkillsSig=sig;
  box.innerHTML=skills.map(skill=>'<div class="nav-item"><div class="nav-main"><strong>'+esc(skill.name)+'</strong><div class="meta">'+(skill.builtin?'Starter · ':'')+esc(skill.whenToUse)+'</div></div><button type="button" class="ghost" data-skill-edit="'+esc(skill.id)+'">Edit</button><button type="button" class="ghost" data-skill-delete="'+esc(skill.id)+'">Delete</button></div>').join('')||'<div class="meta">No skills yet.</div>';
  box.querySelectorAll('[data-skill-edit]').forEach(el=>el.addEventListener('click',()=>{
    const skill=(state.skills||[]).find(item=>item.id===el.dataset.skillEdit);
    const form=document.querySelector('#skillForm');
    if(!skill||!form)return;
    form.elements.skillId.value=skill.id;
    form.elements.name.value=skill.name;
    form.elements.whenToUse.value=skill.whenToUse;
    form.elements.body.value=skill.body||'';
    setTab('skills');
  }));
  box.querySelectorAll('[data-skill-delete]').forEach(el=>el.addEventListener('click',async()=>{
    const status=document.querySelector('#skillStatus');
    try{await api('/api/skills/'+encodeURIComponent(el.dataset.skillDelete),{},'DELETE');lastSkillsSig='';if(status)status.textContent='Deleted.';await load()}catch(err){if(status)status.textContent=err.message}
  }));
}
let lastIssueSig='';
function renderIssueRuns(pBots){
  const select=document.querySelector('#issueBot');
  if(select){
    const current=select.value;
    select.innerHTML=(pBots||[]).map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+'</option>').join('');
    if(current)select.value=current;
  }
  const box=document.querySelector('#issueList');
  if(!box)return;
  const runs=state.issueRuns||[];
  const sig=JSON.stringify(runs);
  if(sig===lastIssueSig)return;
  lastIssueSig=sig;
  box.innerHTML=runs.slice().reverse().map(run=>{
    const tests=run.testResults!==undefined?(run.testExitCode===0?'Tests exited 0.':'Tests exited '+run.testExitCode+'. This is not a pass.'):'Tests have not been run.';
    const pr=run.prUrl?'<p class="meta">'+esc(run.prUrl)+'</p>':'';
    const err=run.error?'<p class="meta">'+esc(run.error)+'</p>':'';
    const approve=run.planApproved?'':'<button type="button" data-issue-approve="'+esc(run.id)+'">Approve plan</button>';
    const testBtn=run.planApproved?'<button type="button" class="secondary" data-issue-test="'+esc(run.id)+'">Run tests</button>':'';
    const openBtn=run.planApproved && run.status!=='pr-opened'?'<button type="button" data-issue-open="'+esc(run.id)+'">Open pull request</button>':'';
    return '<div class="approval"><h3>'+esc(run.title)+'</h3><div class="meta">'+esc(run.issue)+' · '+esc(run.status)+'</div><pre>'+esc(run.plan||'')+'</pre><p class="meta">'+esc(tests)+'</p>'+pr+err+'<div class="row">'+approve+testBtn+openBtn+'</div><p class="meta">Merging stays with a person. This screen does not merge.</p></div>';
  }).join('')||'<div class="meta">No issue runs yet. Merging stays with a person.</div>';
  const act=async(url,status)=>{try{await api(url,{});lastIssueSig='';if(status)status.textContent='Updated.';await load()}catch(err){if(status)status.textContent=err.message}};
  box.querySelectorAll('[data-issue-approve]').forEach(el=>el.addEventListener('click',()=>act('/api/issues/'+encodeURIComponent(el.dataset.issueApprove)+'/approve',document.querySelector('#issueStatus'))));
  box.querySelectorAll('[data-issue-test]').forEach(el=>el.addEventListener('click',()=>act('/api/issues/'+encodeURIComponent(el.dataset.issueTest)+'/test',document.querySelector('#issueStatus'))));
  box.querySelectorAll('[data-issue-open]').forEach(el=>el.addEventListener('click',()=>act('/api/issues/'+encodeURIComponent(el.dataset.issueOpen)+'/pull-request',document.querySelector('#issueStatus'))));
}
let lastChannelSig='';
let lastUsageSig='';
function usd(n){const r=Math.round(Number(n)*1e6)/1e6;return String(r)}
function tokenLine(b){
  if(!b||!b.calls)return '0 in / 0 out';
  const estimated=b.estimatedPromptTokens||b.estimatedCompletionTokens;
  const allEstimated=estimated&&b.estimatedPromptTokens===b.promptTokens&&b.estimatedCompletionTokens===b.completionTokens;
  const bits=[];
  if(!allEstimated)bits.push((b.promptTokens-b.estimatedPromptTokens)+' in / '+(b.completionTokens-b.estimatedCompletionTokens)+' out');
  if(estimated)bits.push('estimated '+b.estimatedPromptTokens+' in / '+b.estimatedCompletionTokens+' out');
  if(b.cachedPromptTokens)bits.push(b.cachedPromptTokens+' cached / '+Math.max(0,(b.promptTokens-b.estimatedPromptTokens)-b.cachedPromptTokens)+' uncached');
  return bits.join(' · ');
}
function costLine(b){
  if(!b||!b.calls)return 'No usage yet';
  const bits=[];
  if(b.enteredCostUsd!==undefined)bits.push('$'+usd(b.enteredCostUsd)+' from entered prices');
  if(b.localDefaultCalls)bits.push(b.localDefaultCalls+' local at $0 default');
  if(b.sessionCacheCalls)bits.push(b.sessionCacheCalls+' session cache, no provider call');
  if(b.unpricedCalls)bits.push(b.unpricedCalls+(b.unpricedCalls===1?' call has no price entered':' calls have no price entered'));
  return bits.join(' · ')||'No usage yet';
}
function usageRow(title,b){return '<div class="event"><strong>'+esc(title)+'</strong><div class="meta">'+esc(tokenLine(b))+'</div><div class="meta">'+esc(costLine(b))+'</div></div>'}
function renderUsage(pBots){
  const box=document.querySelector('#usagePanel');
  if(!box)return;
  const usage=state.usage||{byBot:[],byTask:[],today:{calls:0},recent:[]};
  const prices=state.modelPrices||[];
  const caps=state.usageCaps||{perBot:[]};
  const sig=JSON.stringify([usage,prices,caps,pBots.map(b=>[b.id,b.name])]);
  if(sig===lastUsageSig)return;
  lastUsageSig=sig;
  const botName=id=>{const b=(state.bots||[]).find(x=>x.id===id);return b?b.name:id};
  const tasks=(usage.byTask||[]).slice(-8).map(b=>usageRow('Task '+b.key.slice(0,8),b)).join('');
  const recent=(usage.recent||[]).slice(0,8).map(c=>{
    const cached=c.estimated||c.cachedPromptTokens===undefined?'':(' · '+c.cachedPromptTokens+' cached / '+Math.max(0,c.promptTokens-c.cachedPromptTokens)+' uncached');
    const label=(c.estimated?('estimated '+c.promptTokens+' in / '+c.completionTokens+' out'):(c.promptTokens+' in / '+c.completionTokens+' out'))+cached;
    const step=c.step?esc(c.step)+' · ':'';
    const tier=c.tier?esc(c.tier)+(c.routeFallback?' (no cheap model configured)':'')+' · ':'';
    const cost=c.costBasis==='entered'?'$'+usd(c.costUsd)+' from entered prices'+(c.estimated?' on estimated tokens':''):c.costBasis==='local-default'?'$0 local default':c.costBasis==='session-cache'?'session cache, no provider call':'no price entered';
    return '<div class="event"><time>'+esc(new Date(c.createdAt).toLocaleTimeString())+'</time>'+step+tier+esc(c.model)+' · '+esc(label)+'<div class="meta">'+esc(botName(c.botId))+' · '+esc(cost)+'</div></div>';
  }).join('')||'<div class="meta">No model calls yet.</div>';
  const priceRows=prices.map(p=>'<div class="nav-item"><div class="nav-main"><strong>'+esc(p.model)+'</strong><div class="meta">$'+esc(String(p.inputPerMillion))+' in / $'+esc(String(p.outputPerMillion))+' out per 1M tokens</div></div><button type="button" class="ghost" data-price-remove="'+esc(p.model)+'">Remove</button></div>').join('')||'<div class="meta">No prices entered.</div>';
  const day=caps.perDay||{};
  const capText=c=>{const bits=[];if(!c)return '';if(c.maxTokens!==undefined)bits.push(c.maxTokens+' token ask cap');if(c.maxCostUsd!==undefined)bits.push('$'+c.maxCostUsd+' cost ask cap');if(c.softMaxTokens!==undefined)bits.push(c.softMaxTokens+' soft token cap');if(c.softMaxCostUsd!==undefined)bits.push('$'+c.softMaxCostUsd+' soft cost cap');if(c.hardMaxTokens!==undefined)bits.push(c.hardMaxTokens+' hard token cap');if(c.hardMaxCostUsd!==undefined)bits.push('$'+c.hardMaxCostUsd+' hard cost cap');return bits.join(' · ')};const capList=(caps.perDay&&capText(caps.perDay)?'<div class="meta">Today · '+esc(capText(caps.perDay))+'</div>':'')+(caps.perBot||[]).map(c=>'<div class="meta">'+esc(botName(c.botId))+(capText(c)?' · '+esc(capText(c)):'')+'</div>').join('')||'<div class="meta">No bot caps.</div>';
  const botOptions=pBots.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+'</option>').join('');
  const botRows=(usage.byBot||[]).map(b=>usageRow(botName(b.key),b)).join('')||'<div class="meta">No bot usage yet.</div>';
  box.innerHTML=usageRow('Today',usage.today)+'<h3>Per bot</h3>'+botRows+(tasks?'<h3>Per task</h3>'+tasks:'')+'<h3>Recent calls</h3>'+recent+'<h3>Prices</h3><p class="meta">Enter USD per 1M tokens. Local models stay at the $0 default until you enter a price. A call with no matching price stays labeled no price entered.</p>'+priceRows+'<form id="usagePriceForm" class="mt-sm"><label>Model id<input name="model" required placeholder="openai/gpt-4.1 or a local model id"></label><label>Input USD per 1M<input name="inputPerMillion" type="number" min="0" step="any" required></label><label>Output USD per 1M<input name="outputPerMillion" type="number" min="0" step="any" required></label><button type="submit">Save price</button></form><h3>Caps</h3><p class="meta">A soft cap asks before the next model call. A hard cap pauses and does not offer continue. Neither stops an edit that already started. Always for task does not skip a soft cap or a hard cap. A projected cost is estimated from input characters and labeled estimated. A missing price stays no price entered.</p>'+capList+'<form id="usageCapForm"><label>Per-day token ask cap<input name="dayTokens" type="number" min="0" step="1" value="'+(day.maxTokens??'')+'" placeholder="blank means no cap"></label><label>Per-day cost ask cap USD<input name="dayCost" type="number" min="0" step="any" value="'+(day.maxCostUsd??'')+'" placeholder="blank means no cap"></label><label>Soft per-day token cap<input name="daySoftTokens" type="number" min="0" step="1" value="'+(day.softMaxTokens??'')+'" placeholder="asks, blank means no cap"></label><label>Soft per-day cost cap USD<input name="daySoftCost" type="number" min="0" step="any" value="'+(day.softMaxCostUsd??'')+'" placeholder="asks, blank means no cap"></label><label>Hard per-day token cap<input name="dayHardTokens" type="number" min="0" step="1" value="'+(day.hardMaxTokens??'')+'" placeholder="pauses, blank means no cap"></label><label>Hard per-day cost cap USD<input name="dayHardCost" type="number" min="0" step="any" value="'+(day.hardMaxCostUsd??'')+'" placeholder="pauses, blank means no cap"></label><label>Bot<select name="botId"><option value="">No bot cap</option>'+botOptions+'</select></label><label>Bot token ask cap<input name="botTokens" type="number" min="0" step="1" placeholder="blank means no cap"></label><label>Bot cost ask cap USD<input name="botCost" type="number" min="0" step="any" placeholder="blank means no cap"></label><label>Bot soft token cap<input name="botSoftTokens" type="number" min="0" step="1" placeholder="asks, blank means no cap"></label><label>Bot soft cost cap USD<input name="botSoftCost" type="number" min="0" step="any" placeholder="asks, blank means no cap"></label><label>Bot hard token cap<input name="botHardTokens" type="number" min="0" step="1" placeholder="pauses, blank means no cap"></label><label>Bot hard cost cap USD<input name="botHardCost" type="number" min="0" step="any" placeholder="pauses, blank means no cap"></label><button type="submit">Save caps</button></form><div id="usageStatus" class="status"></div>';
  box.querySelectorAll('[data-price-remove]').forEach(el=>el.addEventListener('click',async()=>{
    try{await api('/api/settings',{modelPrices:prices.filter(p=>p.model!==el.dataset.priceRemove)});lastUsageSig='';await load()}catch(err){const status=document.querySelector('#usageStatus');if(status)status.textContent=err.message}
  }));
  const priceForm=document.querySelector('#usagePriceForm');
  if(priceForm)priceForm.addEventListener('submit',async e=>{
    e.preventDefault();
    const f=new FormData(e.target);
    const model=String(f.get('model')||'').trim();
    const next=prices.filter(p=>p.model!==model).concat([{model,inputPerMillion:Number(f.get('inputPerMillion')),outputPerMillion:Number(f.get('outputPerMillion'))}]);
    try{await api('/api/settings',{modelPrices:next});lastUsageSig='';const status=document.querySelector('#usageStatus');if(status)status.textContent='Price saved.';await load()}catch(err){const status=document.querySelector('#usageStatus');if(status)status.textContent=err.message}
  });
  const capForm=document.querySelector('#usageCapForm');
  if(capForm)capForm.addEventListener('submit',async e=>{
    e.preventDefault();
    const f=new FormData(e.target);
    const num=(name)=>String(f.get(name)||'');
    const fill=(target,name,key)=>{const raw=num(name);if(raw!=='')target[key]=Number(raw)};
    const perDay={};
    fill(perDay,'dayTokens','maxTokens');
    fill(perDay,'dayCost','maxCostUsd');
    fill(perDay,'daySoftTokens','softMaxTokens');
    fill(perDay,'daySoftCost','softMaxCostUsd');
    fill(perDay,'dayHardTokens','hardMaxTokens');
    fill(perDay,'dayHardCost','hardMaxCostUsd');
    const botId=String(f.get('botId')||'');
    let perBot=(caps.perBot||[]).slice();
    if(botId){
      const entry={botId};
      fill(entry,'botTokens','maxTokens');
      fill(entry,'botCost','maxCostUsd');
      fill(entry,'botSoftTokens','softMaxTokens');
      fill(entry,'botSoftCost','softMaxCostUsd');
      fill(entry,'botHardTokens','hardMaxTokens');
      fill(entry,'botHardCost','hardMaxCostUsd');
      perBot=perBot.filter(item=>item.botId!==botId);
      if(Object.keys(entry).length>1)perBot.push(entry);
    }
    const body={perBot};
    if(Object.keys(perDay).length)body.perDay=perDay;
    try{await api('/api/settings',{usageCaps:body});lastUsageSig='';const status=document.querySelector('#usageStatus');if(status)status.textContent='Caps saved.';await load()}catch(err){const status=document.querySelector('#usageStatus');if(status)status.textContent=err.message}
  });
}
function renderChannels(pBots){
  const box=document.querySelector('#channelPanel');
  if(!box)return;
  const ch=state.channels||{};
  const sig=JSON.stringify([ch,state.channelLog,pBots.map(b=>[b.id,b.name])]);
  if(sig===lastChannelSig)return;
  lastChannelSig=sig;
  const options=pBots.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+'</option>').join('');
  const slackBot=pBots.find(b=>b.id===ch.slackBotId);
  const telegramBot=pBots.find(b=>b.id===ch.telegramBotId);
  const log=(state.channelLog||[]).slice(-12).reverse().map(m=>'<div class="event"><time>'+esc(new Date(m.createdAt).toLocaleTimeString())+'</time>'+esc(m.channel)+' '+esc(m.direction)+' · '+esc(m.status)+(m.error?' · '+esc(m.error):'')+'<div class="meta">'+esc(String(m.text||'').slice(0,180))+'</div></div>').join('')||'<div class="meta">No channel messages yet.</div>';
  box.innerHTML='<div class="home-grid"><div class="home-card"><span class="meta">Slack</span><strong>'+(ch.slackConfigured?'Configured':'Not configured')+'</strong><div class="meta">'+(slackBot?esc(slackBot.name):'No bot assigned')+'</div></div><div class="home-card"><span class="meta">Telegram</span><strong>'+(ch.telegramConfigured?'Configured':'Not configured')+'</strong><div class="meta">'+(telegramBot?esc(telegramBot.name):'No bot assigned')+'</div></div></div><form id="channelAssignForm" class="mt-sm"><label>Slack bot<select name="slackBotId"><option value="">Unassigned</option>'+options+'</select></label><label>Telegram bot<select name="telegramBotId"><option value="">Unassigned</option>'+options+'</select></label><button type="submit">Save assignment</button></form><div id="channelAssignStatus" class="status"></div><p class="meta">Inbound messages become tasks. Replies stay in the approval inbox until you click Send reply.</p>'+channelDrafts().map(draftCard).join('')+'<h3>Recent messages</h3><div class="activity">'+log+'</div>';
  const form=document.querySelector('#channelAssignForm');
  if(!form)return;
  if(ch.slackBotId)form.elements.slackBotId.value=ch.slackBotId;
  if(ch.telegramBotId)form.elements.telegramBotId.value=ch.telegramBotId;
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const f=new FormData(form);
    try{await api('/api/settings',{slackBotId:String(f.get('slackBotId')||''),telegramBotId:String(f.get('telegramBotId')||'')});lastChannelSig='';document.querySelector('#channelAssignStatus').textContent='Assignment saved.';await load()}catch(err){document.querySelector('#channelAssignStatus').textContent=err.message}
  });
  bindDrafts();
}
let lastVaultSig='';
function renderVault(){
  const box=document.querySelector('#vaultPanel');
  if(!box)return;
  const vault=state.vault||{backendLabel:'',items:[]};
  const sig=JSON.stringify(vault);
  if(sig===lastVaultSig)return;
  lastVaultSig=sig;
  const items=(vault.items||[]).map(item=>'<div class="nav-item"><div class="nav-main"><strong>'+esc(item.name)+'</strong><div class="meta">'+esc(item.kind)+' · '+esc(item.account||'no account')+' · '+esc(item.storage)+'</div></div><button type="button" class="ghost" data-vault-delete="'+esc(item.id)+'">Delete</button></div>').join('')||'<div class="meta">No vault items yet.</div>';
  box.innerHTML='<p class="meta">'+esc(vault.backendLabel||'Vault')+(vault.onePasswordCli?' · 1Password CLI is available.':' · 1Password CLI is not installed.')+'</p>'+items+'<form id="vaultForm" class="mt-sm"><label>Name<input name="name" required placeholder="Work mail"></label><label>Kind<select name="kind"><option value="login">Login</option><option value="oauth">OAuth</option><option value="token">Token</option><option value="note">Note</option></select></label><label>Account<input name="account" placeholder="name@example.com" autocomplete="off"></label><label>Secret<input type="password" name="secret" required autocomplete="off" placeholder="Stored encrypted. Never shown again."></label><label>Where<select name="storage"><option value="local">This computer</option><option value="1password">1Password CLI</option></select></label><button type="submit">Save in vault</button></form><div id="vaultStatus" class="status"></div>';
  const form=document.querySelector('#vaultForm');
  if(form)form.addEventListener('submit',async e=>{
    e.preventDefault();
    const f=new FormData(form);
    const status=document.querySelector('#vaultStatus');
    try{
      await api('/api/vault',{name:String(f.get('name')||''),kind:String(f.get('kind')||'login'),account:String(f.get('account')||''),secret:String(f.get('secret')||''),storage:String(f.get('storage')||'local')});
      lastVaultSig='';
      if(status)status.textContent='Saved. The secret is not shown again.';
      form.reset();
      await load();
    }catch(err){if(status)status.textContent=err.message}
  });
  box.querySelectorAll('[data-vault-delete]').forEach(el=>el.addEventListener('click',async()=>{
    const status=document.querySelector('#vaultStatus');
    try{await api('/api/vault/'+encodeURIComponent(el.dataset.vaultDelete),{},'DELETE');lastVaultSig='';if(status)status.textContent='Deleted.';await load()}catch(err){if(status)status.textContent=err.message}
  }));
}
let lastAccountsSig='';
function renderAccounts(){
  const box=document.querySelector('#accountsPanel');
  if(!box)return;
  const accounts=state.accounts||{};
  const sig=JSON.stringify(accounts);
  if(sig===lastAccountsSig)return;
  lastAccountsSig=sig;
  const block=(provider,label)=>{
    const info=accounts[provider]||{};
    const connected=info.connected?'Connected as '+esc(info.account||provider):'Not connected';
    const client=info.clientConfigured?'Client saved ('+esc(info.clientId)+'). The secret is not shown.':'No client saved. OCP ships no client.';
    return '<h3>'+label+'</h3><p class="meta">'+connected+'</p><p class="meta">'+client+'</p><form class="account-client-form" data-provider="'+provider+'"><label>Client id<input name="clientId" required autocomplete="off" value="'+esc(info.clientId||'')+'"></label><label>Client secret<input type="password" name="clientSecret" required autocomplete="off" placeholder="Paste the client secret. It is not shown again."></label><button type="submit">Save '+label+' client</button></form><label class="cheap-toggle"><input type="checkbox" data-accept="'+provider+'"> I reviewed the '+label+' scopes above</label><div class="row"><button type="button" data-connect="'+provider+'">'+(provider==='google'?'Connect Google with these scopes':'Connect Microsoft with these scopes')+'</button>'+(info.connected?'<button type="button" class="secondary" data-disconnect="'+provider+'">Disconnect</button>':'')+'</div>';
  };
  box.innerHTML=block('google','Google')+block('microsoft','Microsoft')+'<div id="accountsStatus" class="status"></div>';
  box.querySelectorAll('.account-client-form').forEach(form=>form.addEventListener('submit',async e=>{
    e.preventDefault();
    const provider=form.dataset.provider;
    const f=new FormData(form);
    const status=document.querySelector('#accountsStatus');
    try{
      await api('/api/accounts/'+provider+'/client',{clientId:String(f.get('clientId')||''),clientSecret:String(f.get('clientSecret')||'')});
      lastAccountsSig='';
      if(status)status.textContent='Client saved. The secret is not shown again.';
      await load();
    }catch(err){if(status)status.textContent=err.message}
  }));
  box.querySelectorAll('[data-connect]').forEach(el=>el.addEventListener('click',async()=>{
    const status=document.querySelector('#accountsStatus');
    const boxCheck=document.querySelector('[data-accept="'+el.dataset.connect+'"]');
    if(!boxCheck||!boxCheck.checked){if(status)status.textContent='Review the scopes and check the box before consent.';return}
    try{
      const data=await api('/api/accounts/'+el.dataset.connect+'/start',{acceptScopes:true});
      if(data.authorizeUrl)location.href=data.authorizeUrl;
    }catch(err){if(status)status.textContent=err.message}
  }));
  box.querySelectorAll('[data-disconnect]').forEach(el=>el.addEventListener('click',async()=>{
    const status=document.querySelector('#accountsStatus');
    try{await api('/api/accounts/'+el.dataset.disconnect+'/disconnect',{});lastAccountsSig='';if(status)status.textContent='Disconnected. The refresh token was removed.';await load()}catch(err){if(status)status.textContent=err.message}
  }));
}
function homeDashboard(pBots,pTasks){const running=pTasks.filter(t=>['running','queued','awaiting-approval'].includes(t.status)).length;const waiting=pTasks.filter(t=>t.status==='awaiting-approval').length;const done=pTasks.filter(t=>t.status==='succeeded').length;return '<div class="home-grid"><div class="home-card"><span class="meta">Active tasks</span><strong>'+running+'</strong></div><div class="home-card"><span class="meta">Waiting on you</span><strong>'+waiting+'</strong></div><div class="home-card"><span class="meta">Completed</span><strong>'+done+'</strong></div><div class="home-card"><span class="meta">Active model</span><strong style="font-size:13px">'+esc(state.activeBrainLabel||state.activeModel||'No model configured')+'</strong></div></div>'}
function graphHtml(t){const agents=t.agents||[];if(!agents.length)return '';return '<div class="graph" aria-label="Delegation graph">'+agents.map((a,i)=>(i?'<span class="edge">→</span>':'')+'<span class="node">'+esc(a.name)+' · '+esc(roleFriendly(a.role))+'</span>').join('')+'</div>'}

function inlineMd(s){
  return s
    .replace(/\`([^\`]+)\`/g,'<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>')
    .replace(/(^|[\\s(])\\*([^\\s*][^*]*?)\\*(?=[\\s).,!?:;]|$)/g,'$1<em>$2</em>');
}

function renderMd(raw){
  if(!raw)return '';
  const codeBlocks=[];
  let text=esc(raw).replace(/\`\`\`([a-zA-Z0-9_-]*)\\n([\\s\\S]*?)\`\`\`/g,(_,lang,code)=>{
    const idx=codeBlocks.length;
    codeBlocks.push('<pre><code>'+code.replace(/\\n$/,'')+'</code></pre>');
    return '@@CODEBLOCK_'+idx+'@@';
  });
  const lines=text.split('\\n');
  const out=[];
  let i=0;
  while(i<lines.length){
    const line=lines[i];
    const trimmed=line.trim();
    if(!trimmed){i++;continue}
    if(/^@@CODEBLOCK_\\d+@@$/.test(trimmed)){
      out.push(trimmed);i++;continue;
    }
    if(trimmed.startsWith('|')&&trimmed.endsWith('|')&&i+1<lines.length&&/^\\|[\\s:|-]+\\|$/.test(lines[i+1].trim())){
      const headers=trimmed.slice(1,-1).split('|').map(c=>inlineMd(c.trim()));
      i+=2;
      const rows=[];
      while(i<lines.length&&lines[i].trim().startsWith('|')&&lines[i].trim().endsWith('|')){
        rows.push(lines[i].trim().slice(1,-1).split('|').map(c=>inlineMd(c.trim())));
        i++;
      }
      out.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>');
      continue;
    }
    const hMatch=/^(#{1,4})\\s+(.+)$/.exec(trimmed);
    if(hMatch){
      const lvl=hMatch[1].length;
      out.push('<h'+lvl+'>'+inlineMd(hMatch[2])+'</h'+lvl+'>');
      i++;continue;
    }
    if(/^[-*]\\s+/.test(trimmed)){
      const items=[];
      while(i<lines.length&&/^[-*]\\s+/.test(lines[i].trim())){
        items.push('<li>'+inlineMd(lines[i].trim().replace(/^[-*]\\s+/,''))+'</li>');
        i++;
      }
      out.push('<ul>'+items.join('')+'</ul>');
      continue;
    }
    if(/^\\d+\\.\\s+/.test(trimmed)){
      const items=[];
      while(i<lines.length&&/^\\d+\\.\\s+/.test(lines[i].trim())){
        items.push('<li>'+inlineMd(lines[i].trim().replace(/^\\d+\\.\\s+/,''))+'</li>');
        i++;
      }
      out.push('<ol>'+items.join('')+'</ol>');
      continue;
    }
    if(trimmed.startsWith('&gt;')){
      const quotes=[];
      while(i<lines.length&&lines[i].trim().startsWith('&gt;')){
        quotes.push(inlineMd(lines[i].trim().replace(/^&gt;\\s?/,'')));
        i++;
      }
      out.push('<blockquote>'+quotes.join('<br>')+'</blockquote>');
      continue;
    }
    const para=[];
    while(i<lines.length&&lines[i].trim()&&!/^(#{1,4}\\s|[-*]\\s|\\d+\\.\\s|&gt;|@@CODEBLOCK_\\d+@@)/.test(lines[i].trim())&&!(lines[i].trim().startsWith('|')&&lines[i].trim().endsWith('|'))){
      para.push(inlineMd(lines[i]));
      i++;
    }
    out.push('<p>'+para.join('<br>')+'</p>');
  }
  return '<div class="md">'+out.join('').replace(/@@CODEBLOCK_(\\d+)@@/g,(_,idx)=>codeBlocks[Number(idx)]||'')+'</div>';
}

function setCenterView(mode){
  centerView=mode;
  document.querySelector('#viewChatBtn').classList.toggle('active',mode==='chat');
  document.querySelector('#viewComputerBtn').classList.toggle('active',mode==='computer');
  document.querySelector('#viewChatBtn').setAttribute('aria-selected',String(mode==='chat'));
  document.querySelector('#viewComputerBtn').setAttribute('aria-selected',String(mode==='computer'));
  document.querySelector('#chatStageView').classList.toggle('hidden',mode!=='chat');
  document.querySelector('#computerStageView').classList.toggle('hidden',mode!=='computer');
  if(mode==='computer')refreshComputer(true);
}

function setTab(tabName){
  activeTab=tabName;
  document.querySelector('#studioGrid').classList.remove('drawer-closed');
  document.querySelector('#inspectorDrawer').classList.remove('hidden');
  document.querySelectorAll('.tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===tabName));
  document.querySelectorAll('.tab-pane').forEach(pane=>pane.classList.toggle('hidden',pane.id!=='tab-'+tabName));
}
document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>setTab(btn.dataset.tab)));
document.querySelector('#pluginSearch').addEventListener('input',()=>renderPlugins());
document.querySelector('#viewChatBtn').addEventListener('click',()=>setCenterView('chat'));
document.querySelector('#viewComputerBtn').addEventListener('click',()=>setCenterView('computer'));
document.querySelector('#openComputerFromChatBtn').addEventListener('click',()=>setCenterView('computer'));
document.querySelector('#toggleDrawerBtn').addEventListener('click',()=>{
  const closed=document.querySelector('#studioGrid').classList.toggle('drawer-closed');
  document.querySelector('#inspectorDrawer').classList.toggle('hidden',closed);
});

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

let onboardPayload=null;
function onboardWorkspace(){return (onboardPayload&&onboardPayload.workspace)||DEFAULT_WS}
function onboardField(label,input){const wrap=document.createElement('label');wrap.appendChild(document.createTextNode(label));wrap.appendChild(input);return wrap}
function syncOnboardFields(){
  const form=document.querySelector('#onboardForm');
  if(!form)return;
  const provider=form.elements.provider.value;
  form.elements.baseUrl.parentElement.classList.toggle('hidden',provider!=='custom');
  form.elements.apiKey.parentElement.classList.toggle('hidden',provider!=='openrouter'&&provider!=='custom');
}
function renderOnboard(ob){
  onboardPayload=ob;
  const root=document.querySelector('#onboard');
  const body=document.querySelector('#onboardBody');
  if(!root||!body)return;
  if(!ob.required){root.classList.add('hidden');root.hidden=true;return}
  root.classList.remove('hidden');root.hidden=false;
  body.replaceChildren();
  const limits=document.createElement('ul');
  (ob.limits||[]).forEach(line=>{const li=document.createElement('li');li.textContent=line;limits.appendChild(li)});
  body.appendChild(limits);
  const paths=document.createElement('div');
  paths.className='onboard-paths';
  [['On this machine',ob.local],['In Docker',ob.docker]].forEach(pair=>{
    const box=document.createElement('div');
    const title=document.createElement('strong');title.textContent=pair[0];
    const pre=document.createElement('pre');pre.textContent=(pair[1]||[]).join('\\n');
    box.appendChild(title);box.appendChild(pre);paths.appendChild(box);
  });
  body.appendChild(paths);
  if(ob.modelNote){const note=document.createElement('p');note.className='sub';note.textContent=ob.modelNote;body.appendChild(note)}
  const form=document.createElement('form');
  form.id='onboardForm';
  const provider=document.createElement('select');
  provider.name='provider';
  [['ollama','Local Ollama'],['lmstudio','Local LM Studio'],['vllm','Local vLLM'],['openrouter','OpenRouter'],['custom','Other OpenAI-compatible URL']].forEach(pair=>{const opt=document.createElement('option');opt.value=pair[0];opt.textContent=pair[1];provider.appendChild(opt)});
  if(ob.inDocker)provider.value='custom';
  const model=document.createElement('input');model.name='model';model.placeholder='Model id this server serves';
  const apiKey=document.createElement('input');apiKey.name='apiKey';apiKey.type='password';apiKey.placeholder='Key, if this server asks for one';apiKey.autocomplete='off';
  const baseUrl=document.createElement('input');baseUrl.name='baseUrl';baseUrl.placeholder=ob.inDocker?'http://ollama:11434/v1':'http://127.0.0.1:11434/v1';
  form.appendChild(onboardField('Model server',provider));
  form.appendChild(onboardField('Model id',model));
  form.appendChild(onboardField('Base URL',baseUrl));
  form.appendChild(onboardField('Key',apiKey));
  provider.addEventListener('change',syncOnboardFields);
  body.appendChild(form);
  syncOnboardFields();
  const actions=document.createElement('div');actions.className='onboard-actions';
  (ob.presets||[]).forEach(preset=>{
    const button=document.createElement('button');button.type='button';button.textContent=preset.title;button.title=preset.detail;
    if(preset.id!=='desk')button.className='secondary';
    button.addEventListener('click',()=>finishOnboard(preset.id));
    actions.appendChild(button);
  });
  const skip=document.createElement('button');skip.type='button';skip.className='ghost';skip.textContent='Skip for now';skip.addEventListener('click',()=>finishOnboard('skip'));
  actions.appendChild(skip);
  body.appendChild(actions);
  const status=document.createElement('p');status.id='onboardStatus';status.className='status';body.appendChild(status);
}
async function finishOnboard(action){
  const status=document.querySelector('#onboardStatus');
  try{
    const form=document.querySelector('#onboardForm');
    const body={action,workspace:onboardWorkspace()};
    if(form&&action!=='skip'&&action!=='reopen'){
      body.provider=form.elements.provider.value;
      body.model=form.elements.model.value;
      body.apiKey=form.elements.apiKey.value;
      body.baseUrl=form.elements.baseUrl.value;
    }
    const ob=await api('/api/onboarding',body);
    renderOnboard(ob);
    if(action==='skip'&&state.bots.length===0){
      try{await api('/api/bootstrap',{mode:'lead',workspace:DEFAULT_WS})}catch{}
    }
    bootstrapped=true;
    await load();
  }catch(err){if(status)status.textContent=err.message}
}
async function load(){
  state=await api('/api/state');
  if(!bootstrapped){
    bootstrapped=true;
    try{
      const ob=await api('/api/onboarding');
      renderOnboard(ob);
      if(!ob.required&&state.bots.length===0){
        await api('/api/bootstrap',{mode:'lead',workspace:DEFAULT_WS});
        state=await api('/api/state');
      }
    }catch{}
  }
  const workspaces=(state.projects||[]).map(p=>p.workspace);
  if(!activeWorkspace||(!workspaces.includes(activeWorkspace)&&!state.bots.some(b=>b.workspace===activeWorkspace))){
    activeWorkspace=workspaces[0]||state.bots[0]?.workspace||DEFAULT_WS;
  }
  try{const catalog=await api('/api/plugins');state.plugins=catalog.plugins||[]}catch{state.plugins=[]}
  draw();
  refreshTeammate().catch(()=>{});
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
  form.elements.cheapModel.value=bot.cheapModel||'';
  form.elements.routeMode.value=bot.routeMode||'auto';
  form.elements.actionRule.value=bot.actionRules?.defaultRule||'ask';
  form.elements.preapproved.value=(bot.actionRules?.preapproved||[]).join(', ');
  form.elements.actionBy.value=Object.entries(bot.actionRules?.byAction||{}).map(pair=>pair[0]+'='+pair[1]).join('\\n');
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
  const activeProj=projects.find(p=>p.workspace===activeWorkspace)||projects[0];
  const pBots=projectBots();
  const pTasks=projectTasks();
  const select=document.querySelector('#botSelect'),reviewerSelect=document.querySelector('#reviewerSelect'),chosenBot=select.value,chosenReviewer=reviewerSelect.value;
  const sidebarSig=JSON.stringify([activeWorkspace,conversationBot,selected,chosenBot,projects.map(p=>[p.workspace,p.name]),pBots.map(b=>[b.id,b.name,b.role,b.routeMode||'auto']),pTasks.map(t=>[t.id,t.botId,t.status,t.prompt]),(state.routines||[]).map(r=>[r.id,r.status,r.cron||'',r.timezone||'',r.event||'',r.everyMs||0,r.webhook?1:0])]);

  if(sidebarSig!==lastSidebarSig){
    lastSidebarSig=sidebarSig;
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

    document.querySelector('#activeProjectCard').innerHTML='<strong>'+esc(activeProj?.name||'Project')+'</strong><div class="meta-break">'+esc(activeWorkspace)+'</div>'+(activeProj?.description?'<div class="meta mt-sm">'+esc(activeProj.description)+'</div>':'');

    const botsEl=document.querySelector('#bots');
    document.querySelector('#channelTeamHq').classList.toggle('selected',!conversationBot);
    document.querySelector('#allRoomBtn').classList.toggle('hidden',!conversationBot);

    botsEl.innerHTML=pBots.length?pBots.map(b=>{
      return '<div class="nav-item '+(conversationBot===b.id?'selected':'')+'" data-chat-bot="'+esc(b.id)+'"><div class="nav-main"><span class="'+orbClass(b,pTasks)+'" aria-hidden="true"></span><strong>'+esc(b.name)+'</strong><span class="pill role">'+esc(roleFriendly(b.role))+'</span></div><div class="nav-actions"><button type="button" class="ghost" title="Edit bot" data-edit="'+esc(b.id)+'">Edit</button><button type="button" class="ghost" title="Delete bot" data-delete-bot="'+esc(b.id)+'">×</button></div></div>';
    }).join(''):'<div class="meta">No bots in this project yet. Click <b>Spawn Team</b> above.</div>';

    select.innerHTML=pBots.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+' ('+esc(roleFriendly(b.role))+')</option>').join('');
    if(conversationBot&&pBots.some(b=>b.id===conversationBot))select.value=conversationBot;
    else if(pBots.some(b=>b.id===chosenBot))select.value=chosenBot;
    const cheapBox=document.querySelector('#cheapModeToggle');
    if(cheapBox){
      const cheapBot=pBots.find(b=>b.id===select.value);
      cheapBox.checked=cheapBot?.routeMode==='cheap';
      cheapBox.dataset.botId=cheapBot?.id||'';
    }

    const primary=pBots.find(b=>b.id===select.value);
    const reviewers=pBots.filter(b=>(b.role==='qa'||b.role==='security')&&b.id!==primary?.id);
    reviewerSelect.innerHTML='<option value="">No automatic review</option>'+reviewers.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+' ('+esc(roleFriendly(b.role))+')</option>').join('');
    if(reviewers.some(b=>b.id===chosenReviewer))reviewerSelect.value=chosenReviewer;
    const rsel=document.querySelector('#routineBotSelect');
    if(rsel)rsel.innerHTML=pBots.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+'</option>').join('');
    const rlist=document.querySelector('#routineList');
    if(rlist){
      const routines=state.routines||[];
      rlist.innerHTML=routines.length?routines.map(r=>{
        const owner=state.bots.find(b=>b.id===r.botId);
        const when=r.cron?(r.cron+' '+(r.timezone||'')):(r.event?('event '+r.event):('every '+Math.round((r.everyMs||0)/1000)+'s'));
        const hook=r.webhook?' · /api/routines/hooks/'+r.id:'';
        return '<div class="nav-item"><div class="nav-main"><strong>'+esc(owner?.name||r.botId)+'</strong><div class="meta">'+esc(when+hook)+' · '+esc(r.status)+'</div></div><button type="button" class="ghost" data-routine-toggle="'+esc(r.id)+'" data-status="'+esc(r.status==='active'?'paused':'active')+'">'+(r.status==='active'?'Pause':'Resume')+'</button></div>';
      }).join(''):'<div class="meta">No routines yet.</div>';
      rlist.querySelectorAll('[data-routine-toggle]').forEach(el=>el.addEventListener('click',async()=>{try{await api('/api/routines/'+encodeURIComponent(el.dataset.routineToggle),{status:el.dataset.status},'PATCH');await load()}catch(err){alert(err.message)}}));
    }
    const ch=document.querySelector('#channelStatus');
    if(ch)ch.textContent='Slack: '+(state.channels?.slackConfigured?'configured':'not configured')+' · Telegram: '+(state.channels?.telegramConfigured?'configured':'not configured');
    select.onchange=draw;

    document.querySelectorAll('[data-edit]').forEach(el=>el.addEventListener('click',e=>{e.stopPropagation();editBot(el.dataset.edit)}));
    document.querySelectorAll('[data-chat-bot]').forEach(el=>el.addEventListener('click',()=>{conversationBot=el.dataset.chatBot;select.value=conversationBot;if(state.bots.find(b=>b.id===conversationBot)?.role==='computer'){computerBot=conversationBot}draw()}));
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
  }

  renderChannels(pBots);
  renderDrafts();
  renderSkills();
  renderIssueRuns(pBots);
  renderVault();
  renderAccounts();
  renderUsage(pBots);
  drawChatFeed(activeProj,pBots,pTasks);
  drawComputer(pBots);
  drawDetail(pTasks);
  renderConnectors(pBots);
  renderPlugins();
}

function renderPlugins(){
  const box=document.querySelector('#pluginList');
  if(!box)return;
  const q=(document.querySelector('#pluginSearch').value||'').trim().toLowerCase();
  const bots=projectBots();
  const options=bots.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+'</option>').join('')||'<option value="">Add a bot first</option>';
  const plugins=(state.plugins||[]).filter(p=>!q||(p.name+' '+(p.description||'')).toLowerCase().includes(q));
  if(!plugins.length){box.innerHTML='<div class="meta">'+(q?'No plugins match.':'No plugins are available.')+'</div>';return}
  box.innerHTML=plugins.map(p=>{
    const draft=p.draftOnly?' <span class="pill">Draft only</span>':'';
    const installed=(p.installedBotIds||[]).some(id=>bots.some(b=>b.id===id))?' <span class="pill">Installed</span>':'';
    const perms=(p.permissions||[]).map(name=>'<span class="pill">'+esc(name)+'</span>').join(' ');
    const fields=(p.setupFields||[]).map(field=>'<label>'+esc(field.label)+'<input name="field:'+esc(field.name)+'" type="'+(field.kind==='url'?'url':'text')+'"'+(field.required?' required':'')+'></label>').join('');
    const secrets=(p.secrets||[]).map(secret=>'<label>'+esc(secret.label)+'<input type="password" name="secret:'+esc(secret.name)+'" autocomplete="off"></label>').join('');
    const accounts=(p.accounts||[]).length?'<p class="meta">Uses the '+esc(p.accounts.join(' and '))+' account already saved in Accounts. This plugin does not add another OAuth client.</p>':'';
    const skills=(p.skillNames||[]).length?'<div class="meta">Skill: '+esc(p.skillNames.join(', '))+'</div>':'';
    return '<div class="nav-item" data-plugin="'+esc(p.id)+'"><div class="nav-main"><strong>'+esc(p.name)+'</strong>'+draft+installed+' <span class="pill">Shipped</span></div><div class="meta">'+esc(p.version)+' · '+esc(p.checksumPrefix)+'</div><p>'+esc(p.description)+'</p>'+skills+'<div class="meta">'+perms+'</div>'+accounts+'<form data-plugin-install="'+esc(p.id)+'"><label>Bot<select name="botId" required>'+options+'</select></label>'+fields+secrets+'<button type="submit">Install</button></form><form data-plugin-uninstall="'+esc(p.id)+'"><label>Bot<select name="botId" required>'+options+'</select></label><label><input type="checkbox" name="deleteSecrets"> also delete saved secrets</label><button type="submit" class="secondary">Uninstall</button></form></div>';
  }).join('');
  box.querySelectorAll('[data-plugin-install]').forEach(form=>form.addEventListener('submit',async e=>{
    e.preventDefault();
    const fields={};const secrets={};
    new FormData(form).forEach((value,key)=>{
      if(key.indexOf('field:')===0)fields[key.slice(6)]=String(value);
      else if(key.indexOf('secret:')===0&&String(value))secrets[key.slice(7)]=String(value);
    });
    const status=document.querySelector('#pluginStatus');
    try{
      await api('/api/plugins/'+encodeURIComponent(form.dataset.pluginInstall)+'/install',{botId:form.elements.botId.value,fields,secrets});
      if(status)status.textContent='Installed on this bot.';
      await load();
    }catch(err){if(status)status.textContent=err.message}
  }));
  box.querySelectorAll('[data-plugin-uninstall]').forEach(form=>form.addEventListener('submit',async e=>{
    e.preventDefault();
    const status=document.querySelector('#pluginStatus');
    try{
      const result=await api('/api/plugins/'+encodeURIComponent(form.dataset.pluginUninstall)+'/uninstall',{botId:form.elements.botId.value,deleteSecrets:form.elements.deleteSecrets.checked});
      const kept=result.keptSkills&&result.keptSkills.length?' Kept edited skills: '+result.keptSkills.join(', ')+'.':'';
      if(status)status.textContent='Uninstalled.'+kept;
      await load();
    }catch(err){if(status)status.textContent=err.message}
  }));
}

function renderConnectors(pBots){
  const select=document.querySelector('#connectorBot');
  const list=document.querySelector('#connectorList');
  if(!select||!list)return;
  const chosen=connectorBot&&pBots.some(b=>b.id===connectorBot)?connectorBot:(pBots[0]?.id||'');
  connectorBot=chosen;
  select.innerHTML=pBots.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+'</option>').join('');
  if(chosen)select.value=chosen;
  select.onchange=()=>{connectorBot=select.value;renderConnectors(projectBots())};
  const bot=pBots.find(b=>b.id===chosen);
  const servers=bot?.mcpServers||[];
  list.innerHTML=servers.length?servers.map(server=>{
    const tools=(server.toolNames||[]).length?(server.toolNames||[]).map(name=>esc(name)).join(', '):'No tools listed yet. Test connection to load them.';
    const auth=server.authConfigured?'token saved':'no token';
    return '<div class="nav-item"><div class="nav-main"><strong>'+esc(server.name)+'</strong><div class="meta">'+esc(server.status||'unknown')+' · '+esc(auth)+(server.authHeader?' · '+esc(server.authHeader):'')+'</div><div class="meta">'+esc(server.url)+'</div>'+(server.lastError?'<div class="err-text">'+esc(server.lastError)+'</div>':'')+'<div class="meta">Tools: '+tools+'</div></div><div class="nav-actions"><button type="button" class="secondary" data-connector-test="'+esc(server.name)+'">Test</button><button type="button" class="ghost" data-connector-remove="'+esc(server.name)+'">Remove</button></div></div>';
  }).join(''):'<div class="meta">No connectors for this bot.</div>';
  list.querySelectorAll('[data-connector-test]').forEach(el=>el.addEventListener('click',async()=>{
    const status=document.querySelector('#connectorStatus');
    try{
      const data=await api('/api/bots/'+encodeURIComponent(chosen)+'/connectors/test',{name:el.dataset.connectorTest});
      const names=(data.connector?.toolNames||[]).join(', ')||'none';
      if(status)status.textContent='Connected. Tools: '+names;
    }catch(err){if(status)status.textContent=err.message}
    await load();
  }));
  list.querySelectorAll('[data-connector-remove]').forEach(el=>el.addEventListener('click',async()=>{
    try{await api('/api/bots/'+encodeURIComponent(chosen)+'/connectors/'+encodeURIComponent(el.dataset.connectorRemove),{},'DELETE');document.querySelector('#connectorStatus').textContent='Connector removed.';await load()}catch(err){document.querySelector('#connectorStatus').textContent=err.message}
  }));
}

function drawChatFeed(activeProj,pBots,pTasks){
  const feed=document.querySelector('#chatFeed'),activeBot=pBots.find(b=>b.id===conversationBot);
  document.querySelector('#activeRoomTitle').textContent=activeBot?(activeBot.name+' · '+roleFriendly(activeBot.role)+' ('+runtimeLabel(activeBot.runtime)+')'):'# project-hq · '+(activeProj?.name||'Project');
  const chip=document.querySelector('#modelChip');
  if(chip)chip.textContent=state.activeBrainLabel||state.activeModel||'No model configured';
  const waiting=pendingApprovals().length;
  const badge=document.querySelector('#inboxCount');
  if(badge){badge.textContent=String(waiting);badge.classList.toggle('hidden',waiting===0)}
  document.querySelector('#activeRoomSub').textContent=activeBot?('Direct 1-on-1 chat with '+activeBot.name+' in '+activeWorkspace):('All '+pBots.length+' bots in this project · Ask the Team Lead to create bots, delegate code, or use the Virtual Computer');
  const visibleTasks=(activeBot?pTasks.filter(t=>t.botId===activeBot.id||t.reviewerBotId===activeBot.id):pTasks).slice().sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  const sig=JSON.stringify([activeWorkspace,conversationBot,selected,visibleTasks.map(t=>[t.id,t.status,t.result?.length,t.error,t.events?.length,t.pendingApproval?.id,t.workspaceChanges?.files?.length])]);
  if(sig===lastChatSig)return;
  lastChatSig=sig;

  const quickChips='<div class="welcome-box"><div class="row spread"><strong>Welcome to '+esc(activeProj?.name||'Project')+' Studio</strong><span class="meta">Open Coding Partner</span></div>'+homeDashboard(pBots,pTasks)+'<div class="chips"><button type="button" class="chip" data-quick="Spin up a full team of bots for this project">1. Create my bot team</button><button type="button" class="chip" data-quick="List all bots in this project and explain what each one does in simple terms">2. Meet the bots</button><button type="button" class="chip" data-quick="Open https://example.com on the virtual computer browser and take a screenshot">3. Open the Virtual Computer</button><button type="button" class="chip" data-quick="Inspect this project repository and summarize what it does in plain English">4. Explain this project</button></div></div>';

  feed.innerHTML=quickChips+(visibleTasks.length?visibleTasks.map(t=>{
    const b=state.bots.find(x=>x.id===t.botId),rev=state.bots.find(x=>x.id===t.reviewerBotId),p=t.pendingApproval,evts=t.events||[];
    const isRunning=t.status==='running'||t.status==='queued';
    const toolsHtml=evts.length?(isRunning?'<div class="activity">'+evts.slice(-4).map(e=>'<div class="event">'+esc(e.title||e.kind)+(e.text?' — '+esc(String(e.text).slice(0,140)):'')+'</div>').join('')+'</div>':'<details class="tools-fold"><summary>'+evts.length+' step'+(evts.length===1?'':'s')+' (click to view)</summary><div class="activity mt-sm">'+evts.map(e=>'<div class="event">'+esc(e.title||e.kind)+'</div>').join('')+'</div></details>'):'';
    const files=visibleFiles(t.workspaceChanges?.files);
    return '<div class="turn"><div class="msg-user"><div class="msg-head"><strong>You → @'+esc(b?.name||t.botId)+(rev?' (Reviewed by @'+esc(rev.name)+')':'')+'</strong><span>'+esc(new Date(t.createdAt).toLocaleTimeString())+'</span></div><div class="result">'+renderMd(t.prompt)+'</div></div><div class="msg-bot '+(selected===t.id?'selected':'')+'" data-select-turn="'+esc(t.id)+'"><div class="msg-head"><strong><span class="'+(b?orbClass(b,pTasks):'orb idle')+'"></span> '+esc(b?.name||t.botId)+' <span class="pill role">'+esc(roleFriendly(b?.role||'bot'))+'</span></strong><span class="pill '+(t.status==='awaiting-approval'?'wait':'')+'">'+esc(t.status)+'</span></div>'+graphHtml(t)+toolsHtml+(p?approvalCard(t,p):'')+(t.result?'<div class="result">'+renderMd(t.result)+'</div>':(isRunning?'<div class="meta">Streaming tokens &amp; tools…</div>':''))+(t.error?'<div class="err-text">'+esc(t.error)+'</div>':'')+(files.length?'<div class="meta mt-sm">Files updated: '+files.map(f=>esc(f.path)).join(', ')+'</div>':'')+'</div></div>';
  }).join(''):'');

  document.querySelectorAll('[data-quick]').forEach(el=>el.addEventListener('click',()=>{const inp=document.querySelector('#promptInput');inp.value=el.dataset.quick;inp.focus()}));
  document.querySelectorAll('[data-select-turn]').forEach(el=>el.addEventListener('click',()=>{selected=el.dataset.selectTurn;drawDetail(pTasks)}));
  bindApprovals();
  bindDrafts();
}

function enqueueCompAction(botId,payload,statusMsg){
  lastCompInteract=Date.now();
  const statusEl=document.querySelector('#stageCompStatus');
  if(statusMsg&&statusEl)statusEl.textContent=statusMsg;
  compQueue=compQueue.then(async()=>{
    lastCompInteract=Date.now();
    computerMeta=await api('/api/bots/'+encodeURIComponent(botId)+'/computer',payload);
    lastCompInteract=Date.now();
    syncComputerDom();
  }).catch(err=>{
    if(statusEl)statusEl.textContent=err.message;
  });
  return compQueue;
}

function flushKeyBuffer(botId){
  if(keyTimer){clearTimeout(keyTimer);keyTimer=null}
  if(!keyBuffer)return;
  const text=keyBuffer;
  keyBuffer='';
  const hud=document.querySelector('#stageTypingHud');
  if(hud)hud.classList.add('hidden');
  enqueueCompAction(botId,{kind:'keyboard',action:'type',text,fast:true},'Typed "'+text+'"');
}

async function refreshComputer(capture){
  const pBots=projectBots();
  const preferred=pBots.find(b=>b.role==='computer')||pBots[0];
  if((!computerBot||!pBots.some(b=>b.id===computerBot))&&preferred)computerBot=preferred.id;
  if(!computerBot)return;
  if(!capture&&(keyBuffer.length>0||Date.now()-lastCompInteract<2000))return;
  try{computerMeta=await api('/api/bots/'+encodeURIComponent(computerBot)+'/computer'+(capture?'?refresh=1':''));drawComputer(pBots)}catch(e){computerMeta={detail:e.message};drawComputer(pBots)}
}

function syncComputerDom(){
  const pBots=projectBots();
  const preferred=pBots.find(item=>item.id===computerBot)||pBots.find(item=>item.role==='computer')||pBots[0];
  if(!preferred)return;
  const m=computerMeta||{display:':50',width:1280,height:800,control:'partner',status:'live'};
  const held=m.control==='human';
  const frameSrc='/api/bots/'+encodeURIComponent(preferred.id)+'/computer/frame?t='+(m.frameMtimeMs||Date.now());

  const miniTitle=document.querySelector('#miniCompTitle');
  if(miniTitle)miniTitle.textContent='Virtual Computer ('+(m.display||':50')+')';
  const miniPill=document.querySelector('#miniCompPill');
  if(miniPill){miniPill.className='pill '+(held?'wait':'');miniPill.textContent=held?'Human in Control':'Bot in Control'}
  const miniStatus=document.querySelector('#miniCompStatus');
  if(miniStatus&&!keyBuffer)miniStatus.textContent=m.detail||'Click Open Full-Screen View for easy mouse & keyboard control.';

  const stageTitle=document.querySelector('#stageCompTitle');
  if(stageTitle)stageTitle.textContent='Virtual Computer · '+(m.display||':50')+' ('+(m.width||1280)+'×'+(m.height||800)+')';
  const stagePill=document.querySelector('#stageCompPill');
  if(stagePill){stagePill.className='pill '+(held?'wait':'');stagePill.textContent=held?'You Have Control (Bots Paused)':'Bot Control ('+preferred.name+')'}
  document.querySelector('#stageTakeoverBtn')?.classList.toggle('hidden',held);
  document.querySelector('#stageReturnBtn')?.classList.toggle('hidden',!held);
  const banner=document.querySelector('#stageCompBanner');
  if(banner){
    banner.className='comp-banner '+(held?'human':'bot');
  }
  const bannerText=document.querySelector('#stageCompBannerText');
  if(bannerText){
    bannerText.innerHTML=held
      ?'<strong>You driving:</strong> Click any field on the screen below and type directly on your keyboard (or use the text box below). Bots are paused while you hold control.'
      :'<strong>Bot driving:</strong> <b>'+esc(preferred.name)+'</b> can operate this screen. Need to type a password or complete a sign-in? Click <b>Take Control</b> above.';
  }
  document.querySelector('#stageScreenWrap')?.classList.toggle('human-mode',held);

  const urlInp=document.querySelector('#stageUrlInput');
  if(urlInp&&document.activeElement!==urlInp&&m.lastUrl&&m.lastUrl!==lastSyncedUrl){
    urlInp.value=m.lastUrl;
    lastSyncedUrl=m.lastUrl;
  }
  const statusEl=document.querySelector('#stageCompStatus');
  if(statusEl&&!keyBuffer&&m.detail)statusEl.textContent=m.detail;

  if(frameSrc!==lastFrameSrc&&m.frameMtimeMs){
    lastFrameSrc=frameSrc;
    const pre=new Image();
    pre.onload=()=>{
      const mImg=document.querySelector('#miniScreenImg');
      if(mImg)mImg.src=frameSrc;
      const sImg=document.querySelector('#stageScreenImg');
      if(sImg&&sImg.dataset.streamFailed==='1')sImg.src=frameSrc;
    };
    pre.src=frameSrc;
  }
}

function drawComputer(pBots){
  const miniPanel=document.querySelector('#computerPanel');
  const stagePanel=document.querySelector('#computerStagePanel');
  const preferred=pBots.find(item=>item.id===computerBot)||pBots.find(item=>item.role==='computer')||pBots[0];
  if(!preferred){
    renderedCompBot='';
    const emptyMsg='<p class="sub">Click <b>Spawn Team</b> in the top bar first to create a Computer Operator bot.</p>';
    miniPanel.innerHTML=emptyMsg;
    stagePanel.innerHTML=emptyMsg;
    return;
  }
  computerBot=preferred.id;
  if(renderedCompBot===preferred.id&&document.querySelector('#stageScreenImg')){
    syncComputerDom();
    return;
  }
  renderedCompBot=preferred.id;
  const m=computerMeta||{display:':50',width:1280,height:800,control:'partner',status:'live'};
  const held=m.control==='human';
  const frameSrc='/api/bots/'+encodeURIComponent(preferred.id)+'/computer/frame?t='+(m.frameMtimeMs||Date.now());
  const streamSrc='/api/bots/'+encodeURIComponent(preferred.id)+'/computer/stream?t='+Date.now();
  lastFrameSrc=frameSrc;
  lastSyncedUrl=m.lastUrl||'';

  // 1. Mini sidebar preview (built once per bot)
  miniPanel.innerHTML='<div class="row spread mb-sm"><div><h2 id="miniCompTitle">Virtual Computer ('+esc(m.display||':50')+')</h2><div class="meta">Operator: '+esc(preferred.name)+'</div></div><span id="miniCompPill" class="pill live">LIVE</span></div><div class="row mb-sm"><button type="button" id="miniExpandBtn">Expand full screen</button><button type="button" id="miniRefreshBtn" class="secondary">Refresh</button></div><div class="screen-wrap"><img id="miniScreenImg" src="'+frameSrc+'" alt="Virtual computer mini preview"></div><div class="meta" id="miniCompStatus">'+esc(m.detail||(held?'You driving':'Bot driving · '+preferred.name))+'</div><p class="meta">'+googleSignInNote+'</p>';
  document.querySelector('#miniExpandBtn')?.addEventListener('click',()=>setCenterView('computer'));
  document.querySelector('#miniRefreshBtn')?.addEventListener('click',()=>refreshComputer(true));
  document.querySelector('#miniScreenImg')?.addEventListener('click',()=>setCenterView('computer'));

  // 2. Large Full-Stage Interactive Virtual Computer (20 FPS live MJPEG stream)
  stagePanel.innerHTML='<div class="comp-toolbar"><div class="row"><strong id="stageCompTitle">Virtual Computer · '+esc(m.display||':50')+' ('+(m.width||1280)+'×'+(m.height||800)+')</strong><span class="pill live">LIVE</span><span id="stageCompPill" class="pill '+(held?'wait':'')+'">'+(held?'You driving':'Bot driving · '+esc(preferred.name))+'</span></div><div class="row"><button type="button" id="stageReturnBtn" class="'+(held?'':'hidden')+'">Return control to '+esc(preferred.name)+'</button><button type="button" class="warn-btn '+(held?'hidden':'')+'" id="stageTakeoverBtn">Take Control</button><button type="button" class="secondary" id="stageRefreshBtn">Reconnect stream</button><button type="button" class="secondary" id="stageScrollUpBtn">Scroll up</button><button type="button" class="secondary" id="stageScrollDownBtn">Scroll down</button><button type="button" class="ghost" id="stageBackChatBtn">Back to chat</button></div></div>'
    +'<div id="stageCompBanner" class="comp-banner '+(held?'human':'bot')+'"><div id="stageCompBannerText">'+(held?'<strong>You driving:</strong> Click any field on the screen below and type directly. Bots are paused.':'<strong>Bot driving:</strong> <b>'+esc(preferred.name)+'</b> can operate this screen. Need to type a password or complete a sign-in? Click <b>Take Control</b>.')+'</div><p class="meta">'+googleSignInNote+'</p><div class="row"><button type="button" class="chip" data-stage-url="https://example.com">example.com</button><button type="button" class="chip" data-stage-url="https://github.com">GitHub</button></div></div>'
    +'<div class="row nowrap"><input id="stageUrlInput" placeholder="Enter website URL…" value="'+esc(m.lastUrl||'')+'"><button type="button" id="stageOpenUrlBtn">Go to website</button><input id="stageTypeInput" placeholder="Type or paste text, then Enter…"><button type="button" id="stageTypeBtn" class="secondary">Send text</button><button type="button" class="secondary" data-stage-key="Return" title="Press Enter">Enter</button><button type="button" class="secondary" data-stage-key="Tab" title="Press Tab">Tab</button><button type="button" class="secondary" data-stage-key="BackSpace" title="Press Backspace">⌫</button></div>'
    +'<div class="screen-stage-wrap '+(held?'human-mode':'')+'" id="stageScreenWrap" tabindex="0" title="Click anywhere on the screen to focus and type directly with your keyboard"><img id="stageScreenImg" src="'+streamSrc+'" alt="Full size virtual computer screen"><div id="stageTypingHud" class="typing-hud hidden"></div></div>'
    +'<div class="row spread"><div class="status" id="stageCompStatus">'+esc(m.detail||'Live 20 FPS stream active · Click the screen to interact directly.')+'</div><div class="row nowrap"><input id="stageBotPrompt" placeholder="Tell '+esc(preferred.name)+' what to do on this screen next…"><button type="button" id="stageAskBotBtn">Ask '+esc(preferred.name)+' ↵</button></div></div>';

  const stageImg=document.querySelector('#stageScreenImg');
  stageImg?.addEventListener('error',()=>{
    stageImg.dataset.streamFailed='1';
    stageImg.src='/api/bots/'+encodeURIComponent(preferred.id)+'/computer/frame?t='+Date.now();
  });

  document.querySelector('#stageBackChatBtn')?.addEventListener('click',()=>setCenterView('chat'));
  document.querySelector('#stageRefreshBtn')?.addEventListener('click',()=>{
    if(stageImg){delete stageImg.dataset.streamFailed;stageImg.src='/api/bots/'+encodeURIComponent(preferred.id)+'/computer/stream?t='+Date.now()}
    refreshComputer(true);
  });
  document.querySelector('#stageTakeoverBtn')?.addEventListener('click',()=>{enqueueCompAction(preferred.id,{kind:'takeover'},'Taking human control…');document.querySelector('#stageScreenWrap')?.focus()});
  document.querySelector('#stageReturnBtn')?.addEventListener('click',()=>enqueueCompAction(preferred.id,{kind:'return'},'Returning control to '+preferred.name+'…'));
  document.querySelector('#stageScrollUpBtn')?.addEventListener('click',()=>enqueueCompAction(preferred.id,{kind:'mouse',action:'scroll',direction:'up',amount:5,fast:true},'Scrolling up…'));
  document.querySelector('#stageScrollDownBtn')?.addEventListener('click',()=>enqueueCompAction(preferred.id,{kind:'mouse',action:'scroll',direction:'down',amount:5,fast:true},'Scrolling down…'));

  const openUrl=u=>{if(!u)return;lastSyncedUrl=u;enqueueCompAction(preferred.id,{kind:'browser',url:u},'Opening '+u+'…')};
  document.querySelector('#stageOpenUrlBtn')?.addEventListener('click',()=>openUrl(document.querySelector('#stageUrlInput').value.trim()));
  document.querySelector('#stageUrlInput')?.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();openUrl(e.target.value.trim())}});
  document.querySelectorAll('[data-stage-url]').forEach(el=>el.addEventListener('click',()=>{const u=el.dataset.stageUrl;const inp=document.querySelector('#stageUrlInput');if(inp)inp.value=u;openUrl(u)}));

  const sendType=()=>{const inp=document.querySelector('#stageTypeInput');const t=inp?.value;if(!t)return;inp.value='';enqueueCompAction(preferred.id,{kind:'keyboard',action:'type',text:t,fast:true},'Typed "'+t+'"')};
  document.querySelector('#stageTypeBtn')?.addEventListener('click',sendType);
  document.querySelector('#stageTypeInput')?.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();sendType()}});
  document.querySelectorAll('[data-stage-key]').forEach(el=>el.addEventListener('click',()=>{flushKeyBuffer(preferred.id);enqueueCompAction(preferred.id,{kind:'keyboard',action:'key',key:el.dataset.stageKey,fast:true},'Pressed '+el.dataset.stageKey)}));

  const stageWrap=document.querySelector('#stageScreenWrap');
  stageImg?.addEventListener('click',e=>{
    flushKeyBuffer(preferred.id);
    stageWrap?.focus();
    const rect=e.target.getBoundingClientRect();
    const mNow=computerMeta||{width:1280,height:800};
    const w=mNow.width||1280,h=mNow.height||800;
    const x=Math.round((e.clientX-rect.left)/rect.width*w);
    const y=Math.round((e.clientY-rect.top)/rect.height*h);
    const ripple=document.createElement('div');
    ripple.className='click-dot';
    ripple.style.left=(e.clientX-rect.left)+'px';
    ripple.style.top=(e.clientY-rect.top)+'px';
    stageWrap?.appendChild(ripple);
    setTimeout(()=>ripple.remove(),560);
    enqueueCompAction(preferred.id,{kind:'mouse',action:'click',x,y,fast:true},'Clicked ('+x+', '+y+') — type directly on your keyboard now');
  });
  stageImg?.addEventListener('dblclick',e=>{
    flushKeyBuffer(preferred.id);
    stageWrap?.focus();
    const rect=e.target.getBoundingClientRect();
    const mNow=computerMeta||{width:1280,height:800};
    const w=mNow.width||1280,h=mNow.height||800;
    const x=Math.round((e.clientX-rect.left)/rect.width*w);
    const y=Math.round((e.clientY-rect.top)/rect.height*h);
    enqueueCompAction(preferred.id,{kind:'mouse',action:'double_click',x,y,fast:true},'Double-clicked ('+x+', '+y+')');
  });
  stageWrap?.addEventListener('wheel',e=>{
    e.preventDefault();
    const direction=e.deltaY<0?'up':'down';
    enqueueCompAction(preferred.id,{kind:'mouse',action:'scroll',direction,amount:4,fast:true},'Scrolling '+direction+'…');
  },{passive:false});
  stageWrap?.addEventListener('keydown',e=>{
    if(['Shift','Control','Alt','Meta','CapsLock'].includes(e.key))return;
    e.preventDefault();
    lastCompInteract=Date.now();
    if(e.ctrlKey||e.metaKey){
      const k=e.key.toLowerCase();
      if(['a','c','v','x','l','r','t','w','z'].includes(k)){
        flushKeyBuffer(preferred.id);
        enqueueCompAction(preferred.id,{kind:'keyboard',action:'hotkey',key:'ctrl+'+k,fast:true},'Pressed Ctrl+'+k.toUpperCase());
        return;
      }
    }
    if(e.key==='Backspace'&&keyBuffer.length>0){
      keyBuffer=keyBuffer.slice(0,-1);
      const hud=document.querySelector('#stageTypingHud');
      if(hud){hud.textContent='⌨ Typing: '+keyBuffer;hud.classList.toggle('hidden',!keyBuffer)}
      if(keyTimer)clearTimeout(keyTimer);
      if(keyBuffer)keyTimer=setTimeout(()=>flushKeyBuffer(preferred.id),35);
      return;
    }
    if(e.key.length===1&&!e.ctrlKey&&!e.metaKey){
      keyBuffer+=e.key;
      const hud=document.querySelector('#stageTypingHud');
      if(hud){hud.textContent='⌨ Typing: '+keyBuffer;hud.classList.remove('hidden')}
      const statusEl=document.querySelector('#stageCompStatus');
      if(statusEl)statusEl.textContent='Typing: "'+keyBuffer+'"…';
      if(keyTimer)clearTimeout(keyTimer);
      keyTimer=setTimeout(()=>flushKeyBuffer(preferred.id),35);
      return;
    }
    flushKeyBuffer(preferred.id);
    const keyMap={Enter:'Return',Backspace:'BackSpace',Tab:'Tab',Escape:'Escape',Delete:'Delete',ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',Home:'Home',End:'End',PageUp:'Page_Up',PageDown:'Page_Down',' ':'space'};
    const mapped=keyMap[e.key]||e.key;
    enqueueCompAction(preferred.id,{kind:'keyboard',action:'key',key:mapped,fast:true},'Pressed '+mapped);
  });

  const askBotFromStage=async()=>{
    const inp=document.querySelector('#stageBotPrompt');
    const prompt=inp?.value?.trim();
    if(!prompt)return;
    inp.value='';
    flushKeyBuffer(preferred.id);
    if((computerMeta?.control||'')==='human'){
      await enqueueCompAction(preferred.id,{kind:'return'},'Returning control to '+preferred.name+'…');
    }
    const r=await api('/api/tasks',{botId:preferred.id,prompt});
    selected=r.taskId;
    await load();
  };
  document.querySelector('#stageAskBotBtn')?.addEventListener('click',askBotFromStage);
  document.querySelector('#stageBotPrompt')?.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();askBotFromStage()}});
}

function drawDetail(pTasks){
  const panel=document.querySelector('#detail'),tasks=pTasks||projectTasks(),t=tasks.find(x=>x.id===selected)||tasks[0];
  const inbox=pendingApprovals();
  const drafts=channelDrafts();
  if(!t && !inbox.length && !drafts.length){panel.innerHTML='<h2>Activity</h2><p class="sub">Click any message in the chat to inspect steps, diffs, and tests.</p>';return}
  const sig=JSON.stringify([t?.id,t?.status,t?.events?.length,t?.pendingApproval?.id,t?.workspaceChanges?.files?.length,inbox.map(i=>i.pendingApproval?.id),drafts.map(d=>d.id+d.status)]);
  if(sig===lastDetailSig)return;
  lastDetailSig=sig;
  const b=t&&state.bots.find(x=>x.id===t.botId),reviewer=t&&state.bots.find(x=>x.id===t.reviewerBotId),p=t&&t.pendingApproval;
  const files=visibleFiles(t?.workspaceChanges?.files);
  const inboxHtml=(inbox.length||drafts.length)?'<h3>Approvals inbox</h3>'+drafts.map(draftCard).join('')+inbox.map(item=>approvalCard(item,item.pendingApproval)).join(''):'';
  panel.innerHTML=inboxHtml+(t?'<div class="row spread"><div><h2>'+esc(b?.name||t.botId)+' · '+esc(t.status)+'</h2><div class="meta">'+(reviewer?'Reviewed by '+esc(reviewer.name)+' · ':'')+esc(new Date(t.createdAt).toLocaleTimeString())+'</div></div><div class="row">'+(t.status==='running'||t.status==='awaiting-approval'||t.status==='queued'?'<button id="cancel" class="danger">Cancel</button>':((b&&['failed','cancelled','needs-attention'].includes(t.status))?'<button id="retry" class="secondary">Retry</button>':'')+'<button id="delete" class="ghost">Delete</button>')+'</div></div>'+graphHtml(t)+(p?approvalCard(t,p):'')+'<h3>Timeline</h3><div class="activity">'+(t.events?.length?t.events.slice().reverse().map(e=>'<div class="event"><time>'+esc(new Date(e.createdAt).toLocaleTimeString())+'</time>'+esc(e.title||e.kind)+'</div>').join(''):'<div class="meta">No tool events recorded.</div>')+'</div>'+(t.workspaceChanges?'<h3>Diff &amp; tests</h3>'+(files.length?'<div class="activity">'+files.map(f=>'<div class="event"><button type="button" class="secondary" data-workspace-file="'+esc(f.path)+'">'+esc(f.status)+' · '+esc(f.path)+'</button></div>').join('')+'</div><div id="workspaceFileView"></div>':'<p class="meta">'+esc(t.workspaceChanges.diffOmittedReason||'No visible Git changes.')+'</p>')+(t.workspaceChanges.diff?'<details open class="fold-box"><summary class="fold-summary">Git Diff</summary><pre>'+esc(t.workspaceChanges.diff)+'</pre></details>':''):''):'');
  document.querySelectorAll('[data-workspace-file]').forEach(el=>el.addEventListener('click',async()=>{const view=document.querySelector('#workspaceFileView'),filePath=el.dataset.workspaceFile;view.innerHTML='<p class="meta">Loading file…</p>';try{const file=await api('/api/workspace/file?botId='+encodeURIComponent(t.botId)+'&path='+encodeURIComponent(filePath));view.innerHTML='<h3>'+esc(filePath)+'</h3><pre>'+esc(file.content)+'</pre>'}catch(error){view.innerHTML='<p class="meta">'+esc(error.message)+'</p>'}}));
  bindApprovals();
  bindDrafts();
  if(!t)return;
  const action=async(what,body)=>{try{await api('/api/tasks/'+encodeURIComponent(t.id)+'/'+what,body);await load()}catch(e){alert(e.message)}};
  document.querySelector('#cancel')?.addEventListener('click',()=>action('cancel',{}));
  document.querySelector('#retry')?.addEventListener('click',async()=>{try{const created=await api('/api/tasks',{botId:t.botId,reviewerBotId:t.reviewerBotId||'',prompt:t.prompt});selected=created.taskId;await load()}catch(error){alert(error.message)}});
  document.querySelector('#delete')?.addEventListener('click',async()=>{try{await api('/api/tasks/'+encodeURIComponent(t.id),{},'DELETE');if(selected===t.id)selected='';await load()}catch(e){alert(e.message)}});
}

document.querySelector('#channelTeamHq').addEventListener('click',()=>{conversationBot='';setCenterView('chat');draw()});
document.querySelector('#allRoomBtn').addEventListener('click',()=>{conversationBot='';draw()});
document.querySelector('#spawnTeamBtn').addEventListener('click',async()=>{try{await api('/api/bootstrap',{mode:'team',workspace:activeWorkspace||DEFAULT_WS});await load()}catch(e){alert(e.message)}});
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
  f.elements.defaultModel.value='';
  try{
    await api('/api/settings',{litellmBaseUrl:'http://127.0.0.1:11434/v1',defaultModel:''},'POST');
    document.querySelector('#settingsStatus').textContent='Switched to local GPU via Ollama.';
    await load();await showHealth();
  }catch(err){document.querySelector('#settingsStatus').textContent=err.message}
});
document.querySelector('#useOpenRouterPresetBtn').addEventListener('click',async()=>{
  const f=document.querySelector('#settingsForm');
  f.elements.litellmBaseUrl.value='';
  f.elements.defaultModel.value='';
  try{
    await api('/api/settings',{litellmBaseUrl:'',defaultModel:''},'POST');
    document.querySelector('#settingsStatus').textContent='Switched to OpenRouter!';
    await load();await showHealth();
  }catch(err){document.querySelector('#settingsStatus').textContent=err.message}
});
document.querySelector('#routineForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=new FormData(e.target);
  const everyRaw=String(f.get('everySec')||'').trim();
  const everySec=Number(everyRaw);
  const event=String(f.get('event')||'').trim();
  const cron=String(f.get('cron')||'').trim();
  const timezone=String(f.get('timezone')||'').trim();
  const body={botId:f.get('botId'),prompt:f.get('prompt'),webhook:f.get('webhook')==='on'};
  if(event)body.event=event;
  if(cron)body.cron=cron;
  if(timezone)body.timezone=timezone;
  if(!event&&!cron&&everyRaw)body.everyMs=everySec*1000;
  try{
    const res=await api('/api/routines',body);
    let note='Routine saved.';
    if(res.webhookSecret)note+=' Webhook '+res.webhookPath+'. Secret shown once: '+res.webhookSecret;
    document.querySelector('#routineStatus').textContent=note;
    e.target.reset();
    await load();
  }catch(err){document.querySelector('#routineStatus').textContent=err.message}
});
document.querySelector('#routineEventForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const name=new FormData(e.target).get('name');
  try{const r=await api('/api/routines/event',{name});document.querySelector('#routineStatus').textContent='Fired '+r.fired+' routine(s).';await load()}catch(err){document.querySelector('#routineStatus').textContent=err.message}
});
document.querySelector('#connectorForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=new FormData(e.target);
  const botId=document.querySelector('#connectorBot')?.value||connectorBot;
  const body={name:f.get('name'),url:f.get('url'),authHeader:f.get('authHeader')||undefined};
  const token=String(f.get('authToken')||'');
  if(token)body.authToken=token;
  try{
    await api('/api/bots/'+encodeURIComponent(botId)+'/connectors',body);
    document.querySelector('#connectorStatus').textContent='Connector saved. Token is not shown again.';
    e.target.reset();
    await load();
  }catch(err){document.querySelector('#connectorStatus').textContent=err.message}
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
document.querySelector('#skillForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const form=e.target;
  const f=new FormData(form);
  const status=document.querySelector('#skillStatus');
  const skillId=String(f.get('skillId')||'');
  const body={name:String(f.get('name')||''),whenToUse:String(f.get('whenToUse')||''),body:String(f.get('body')||'')};
  try{
    await api(skillId?'/api/skills/'+encodeURIComponent(skillId):'/api/skills',body,skillId?'PATCH':'POST');
    lastSkillsSig='';
    form.reset();
    if(status)status.textContent=skillId?'Skill updated.':'Skill saved.';
    await load();
  }catch(err){if(status)status.textContent=err.message}
});
document.querySelector('#skillReset')?.addEventListener('click',()=>{document.querySelector('#skillForm')?.reset()});
document.querySelector('#issueForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=new FormData(e.target);
  const status=document.querySelector('#issueStatus');
  const body={botId:String(f.get('botId')||''),provider:String(f.get('provider')||''),issue:String(f.get('issue')||''),repo:String(f.get('repo')||''),base:String(f.get('base')||'main'),vaultItem:String(f.get('vaultItem')||'')};
  const githubVaultItem=String(f.get('githubVaultItem')||'').trim();
  if(githubVaultItem)body.githubVaultItem=githubVaultItem;
  try{
    await api('/api/issues/start',body);
    lastIssueSig='';
    if(status)status.textContent='Issue started. Approve the plan before a pull request can open.';
    await load();
  }catch(err){if(status)status.textContent=err.message}
});
document.querySelector('#skillExport')?.addEventListener('click',async()=>{
  const status=document.querySelector('#skillStatus');
  try{
    const r=await fetch('/api/skills/export');
    if(!r.ok){const data=await r.json();throw Error(data.error||'Export failed')}
    const blob=await r.blob();
    const link=document.createElement('a');
    link.href=URL.createObjectURL(blob);
    link.download='ocp-skills.zip';
    link.click();
    if(status)status.textContent='Exported the skill pack.';
  }catch(err){if(status)status.textContent=err.message}
});
document.querySelector('#skillImportForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const form=e.target;
  const status=document.querySelector('#skillStatus');
  const file=form.elements.zip.files&&form.elements.zip.files[0];
  const gitUrl=String(new FormData(form).get('gitUrl')||'').trim();
  const body={};
  try{
    if(file){
      if(file.size>700000)throw Error('The zip pack must be under 700 KB. Nothing was imported.');
      const bytes=new Uint8Array(await file.arrayBuffer());
      let binary='';
      for(let i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
      body.zipBase64=btoa(binary);
    }else if(gitUrl)body.gitUrl=gitUrl;
    else throw Error('Choose a zip pack or a git URL. Nothing was imported.');
    const result=await api('/api/skills/import',body);
    lastSkillsSig='';
    form.reset();
    if(status)status.textContent='Imported '+result.imported+' skill'+(result.imported===1?'':'s')+'.';
    await load();
  }catch(err){if(status)status.textContent=err.message}
});
document.querySelector('#botForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const f=new FormData(e.target),provider=f.get('provider');
  const body=Object.fromEntries(f.entries());
  body.provider=provider;
  if(!body.workspace)body.workspace=activeWorkspace||DEFAULT_WS;
  if(!String(body.mcpServers||'').trim())delete body.mcpServers;
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

document.querySelector('#cheapModeToggle')?.addEventListener('change',async e=>{
  const botId=e.target.dataset.botId;
  if(!botId){e.target.checked=false;document.querySelector('#taskStatus').textContent='Choose a bot before turning on cheap mode.';return}
  try{
    await api('/api/bots/'+encodeURIComponent(botId),{routeMode:e.target.checked?'cheap':'auto'});
    await load();
  }catch(err){e.target.checked=!e.target.checked;document.querySelector('#taskStatus').textContent=err.message}
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
document.querySelector('#openInboxBtn')?.addEventListener('click',()=>{setTab('detail');lastDetailSig='';drawDetail()});
document.querySelector('#openPaletteBtn')?.addEventListener('click',openPalette);
document.querySelectorAll('[data-mobile]').forEach(btn=>btn.addEventListener('click',()=>{
  const v=btn.dataset.mobile;
  document.querySelectorAll('[data-mobile]').forEach(b=>b.classList.toggle('active',b===btn));
  const g=document.querySelector('#studioGrid');
  g.classList.remove('show-bots','show-more');
  if(v==='chat')setCenterView('chat');
  if(v==='computer')setCenterView('computer');
  if(v==='bots')g.classList.add('show-bots');
  if(v==='more'||v==='inbox'){g.classList.add('show-more');setTab(v==='inbox'?'detail':'settings')}
}));
function applyTheme(choice){
  if(choice!=='dark'&&choice!=='light'&&choice!=='system')return;
  document.documentElement.setAttribute('data-theme',choice);
  document.cookie='ocp-theme='+choice+'; Path=/; Max-Age=31536000; SameSite=Lax';
  document.querySelectorAll('[data-theme-choice]').forEach(btn=>{
    const on=btn.getAttribute('data-theme-choice')===choice;
    btn.classList.toggle('active',on);
    btn.setAttribute('aria-pressed',on?'true':'false');
  });
  api('/api/settings',{theme:choice},'POST').catch(()=>{});
}
document.querySelectorAll('[data-theme-choice]').forEach(btn=>btn.addEventListener('click',()=>applyTheme(btn.getAttribute('data-theme-choice'))));
async function refreshTeammate(){
  const bots=projectBots();
  const opts=bots.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+'</option>').join('');
  ['responsibilityBot','threadBotA','threadBotB','handBot'].forEach(id=>{const el=document.querySelector('#'+id);if(el)el.innerHTML=opts});
  const mem=document.querySelector('#memoryWorkspace');
  if(mem)mem.value=activeWorkspace||'';
  const activity=await api('/api/activity');
  const act=document.querySelector('#activityList');
  if(act)act.innerHTML=(activity.items||[]).slice(0,12).map(item=>'<div class="meta">'+esc(item.kind)+' '+esc(item.status)+' '+esc(item.title)+'</div>').join('')||'<div class="meta">No activity yet.</div>';
  const audit=await api('/api/audit');
  const box=document.querySelector('#auditList');
  if(box)box.innerHTML=(audit.audit||[]).slice(-12).map(row=>'<div class="meta">'+esc(row.outcome)+' '+esc(row.action)+(row.ruleId?' '+esc(row.ruleId):'')+'</div>').join('')||'<div class="meta">No audit rows yet.</div>';
  const resp=await api('/api/responsibilities');
  const rbox=document.querySelector('#responsibilityList');
  if(rbox)rbox.innerHTML=(resp.responsibilities||[]).map(item=>'<div class="meta"><strong>'+esc(item.goal)+'</strong> '+esc(item.id)+'</div>').join('')||'<div class="meta">No responsibilities yet.</div>';
  const threads=await api('/api/threads');
  const tbox=document.querySelector('#threadList');
  if(tbox)tbox.innerHTML=(threads.threads||[]).map(item=>'<div class="meta">'+esc(item.title)+'</div>').join('')||'<div class="meta">No threads yet.</div>';
  const cards=(threads.threads||[]).flatMap(item=>(item.messages||[]).flatMap(msg=>msg.components||[]));
  const cbox=document.querySelector('#componentList');
  if(cbox)cbox.innerHTML=cards.map(card=>'<article class="meta" data-component="'+esc(card.type)+'"><strong>'+esc(card.title)+'</strong> '+esc(card.body)+'</article>').join('')||'<div class="meta">No component replies yet.</div>';
  const agents=await api('/api/agents');
  const abox=document.querySelector('#agentList');
  if(abox)abox.textContent=(agents.agents||[]).map(agent=>agent.name).join(', ')||'No agents yet.';
  const directory=await api('/api/directory');
  const dbox=document.querySelector('#directoryList');
  if(dbox)dbox.textContent=(directory.users||[]).map(user=>user.name+' ('+user.role+')').join(', ')||'No people yet.';
  const pages=await api('/api/pages');
  const pbox=document.querySelector('#pageList');
  if(pbox)pbox.innerHTML=(pages.pages||[]).map(page=>'<article class="meta"><strong>'+esc(page.title)+'</strong> '+esc(page.body)+'</article>').join('')||'<div class="meta">No pages yet.</div>';
  if(activeWorkspace){
    const memory=await api('/api/memory?workspace='+encodeURIComponent(activeWorkspace));
    const mbox=document.querySelector('#memoryList');
    if(mbox)mbox.textContent=(memory.facts||[]).slice(-8).join('\\n')||'No memories yet.';
  }
}
document.querySelector('#responsibilityForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  await api('/api/responsibilities',{botId:f.elements.botId.value,goal:f.elements.goal.value},'POST');
  f.elements.goal.value='';
  await refreshTeammate();
});
document.querySelector('#threadForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  const thread=await api('/api/threads',{botIds:[f.elements.botA.value,f.elements.botB.value],text:f.elements.text.value},'POST');
  const slot=document.querySelector('#reachThread');
  if(slot&&thread.thread)slot.value=thread.thread.id;
  await refreshTeammate();
});
document.querySelector('#reachForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  await api('/api/threads/'+encodeURIComponent(f.elements.threadId.value)+'/reach',{channel:f.elements.channel.value,destination:f.elements.destination.value},'POST');
  await refreshTeammate();
});
document.querySelector('#memoryForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  const replacement=f.elements.replacement.value.trim();
  await api('/api/memory',{workspace:f.elements.workspace.value,query:f.elements.query.value,replacement,action:replacement?'correct':'forget'},'POST');
  await refreshTeammate();
});
document.querySelector('#handForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  await api('/api/tasks/'+encodeURIComponent(f.elements.taskId.value)+'/hand',{botId:f.elements.botId.value},'POST');
  f.elements.taskId.value='';
  await refreshTeammate();
});
document.querySelector('#routineFromTaskForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  await api('/api/tasks/'+encodeURIComponent(f.elements.taskId.value)+'/routine',{everyMs:Number(f.elements.everyMs.value)},'POST');
  f.reset();
  await refreshTeammate();
});
document.querySelector('#checkForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  await api('/api/responsibilities/'+encodeURIComponent(f.elements.id.value)+'/check',{everyMs:Number(f.elements.everyMs.value)},'POST');
  f.reset();
  await refreshTeammate();
});
document.querySelector('#ruleForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  await api('/api/rules',{tool:f.elements.tool.value,pathPrefix:f.elements.pathPrefix.value,argvPrefix:f.elements.argvPrefix.value,initiator:f.elements.initiator.value},'POST');
  f.reset();
  await refreshTeammate();
});
document.querySelector('#agentForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  await api('/api/agents',{name:f.elements.name.value,url:f.elements.url.value},'POST');
  f.reset();
  await refreshTeammate();
});
document.querySelector('#directoryForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  await api('/api/directory/users',{name:f.elements.name.value,role:f.elements.role.value,password:f.elements.password.value},'POST');
  f.reset();
  await refreshTeammate();
});
document.querySelector('#companyForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  await api('/api/directory/company',{secret:f.elements.secret.value},'POST');
  f.reset();
  await refreshTeammate();
});
document.querySelector('#pageForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target;
  await api('/api/pages',{title:f.elements.title.value,body:f.elements.body.value},'POST');
  f.reset();
  await refreshTeammate();
});
const paletteCommands=[
  {id:'chat',label:'Team Chat',run:()=>setCenterView('chat')},
  {id:'theme-dark',label:'Theme Dark',run:()=>applyTheme('dark')},
  {id:'theme-light',label:'Theme Light',run:()=>applyTheme('light')},
  {id:'theme-system',label:'Theme System',run:()=>applyTheme('system')},
  {id:'computer',label:'Virtual Computer',run:()=>setCenterView('computer')},
  {id:'spawn',label:'Spawn Team',run:()=>document.querySelector('#spawnTeamBtn').click()},
  {id:'start',label:'Start guide',run:async()=>{const ob=await api('/api/onboarding',{action:'reopen'});renderOnboard(ob)}},
  {id:'bot',label:'Add Bot',run:()=>document.querySelector('#openNewBotBtn').click()},
  {id:'settings',label:'Settings',run:()=>document.querySelector('#openSettingsBtn').click()},
  {id:'usage',label:'Usage',run:()=>setTab('usage')},
  {id:'credits',label:'Credits',run:()=>setTab('credits')},
  {id:'routines',label:'Routines',run:()=>setTab('routines')},
  {id:'connectors',label:'Connectors',run:()=>setTab('connectors')},
  {id:'channels',label:'Channels',run:()=>setTab('channels')},
  {id:'drafts',label:'Drafts',run:()=>setTab('drafts')},
  {id:'skills',label:'Skills',run:()=>setTab('skills')},
  {id:'issue-pr',label:'Issue to PR',run:()=>setTab('issue-pr')},
  {id:'vault',label:'Vault',run:()=>setTab('vault')},
  {id:'accounts',label:'Accounts',run:()=>setTab('accounts')},
  {id:'inbox',label:'Approvals inbox',run:()=>{setTab('detail');lastDetailSig='';drawDetail()}}
];
function paletteVisible(){return !document.querySelector('#palette').classList.contains('hidden')}
function closePalette(){document.querySelector('#palette').classList.add('hidden');document.querySelector('#palette').hidden=true;document.querySelector('#paletteScrim').classList.add('hidden');document.querySelector('#paletteScrim').hidden=true}
function renderPalette(q){
  const items=paletteCommands.filter(c=>c.label.toLowerCase().includes(String(q||'').toLowerCase()));
  if(!items.length)paletteIndex=0;
  paletteIndex=Math.max(0,Math.min(paletteIndex,items.length-1));
  document.querySelector('#paletteList').innerHTML=items.map((c,i)=>'<div class="palette-item" role="option" aria-selected="'+(i===paletteIndex)+'" data-pal="'+c.id+'"><span>'+esc(c.label)+'</span></div>').join('')||'<div class="meta">No matches</div>';
  document.querySelectorAll('[data-pal]').forEach(el=>el.addEventListener('click',()=>{const cmd=paletteCommands.find(c=>c.id===el.dataset.pal);closePalette();cmd?.run()}));
}
function openPalette(){
  document.querySelector('#palette').classList.remove('hidden');document.querySelector('#palette').hidden=false;
  document.querySelector('#paletteScrim').classList.remove('hidden');document.querySelector('#paletteScrim').hidden=false;
  paletteIndex=0;renderPalette('');
  const inp=document.querySelector('#paletteInput');inp.value='';inp.focus();
}
document.querySelector('#paletteScrim')?.addEventListener('click',closePalette);
document.querySelector('#paletteInput')?.addEventListener('input',e=>{paletteIndex=0;renderPalette(e.target.value)});
document.querySelector('#paletteInput')?.addEventListener('keydown',e=>{
  const items=[...document.querySelectorAll('[data-pal]')];
  if(e.key==='ArrowDown'){e.preventDefault();paletteIndex++;renderPalette(e.target.value)}
  if(e.key==='ArrowUp'){e.preventDefault();paletteIndex--;renderPalette(e.target.value)}
  if(e.key==='Enter'){e.preventDefault();items[paletteIndex]?.click()}
  if(e.key==='Escape'){e.preventDefault();closePalette()}
});
window.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();paletteVisible()?closePalette():openPalette();return}
  if(paletteVisible())return;
  const pending=pendingApprovals()[0];
  if(!pending?.pendingApproval)return;
  if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();if(pending.pendingApproval.subject&&pending.pendingApproval.subject.kind==='usage-hard-cap')return;api('/api/tasks/'+encodeURIComponent(pending.id)+'/approval',{requestId:pending.pendingApproval.id,decision:'allow-once',approved:true}).then(load).catch(err=>alert(err.message))}
  if(e.key==='Escape'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){e.preventDefault();api('/api/tasks/'+encodeURIComponent(pending.id)+'/approval',{requestId:pending.pendingApproval.id,decision:'cancelled',approved:false}).then(load).catch(err=>alert(err.message))}
});
async function showHealth(){
  try{
    const h=await api('/api/health');
    const dot=ok=>'<span class="orb '+(ok?'idle':'wait')+'"></span>';
    document.querySelector('#health').innerHTML='<span class="pill">'+dot(true)+' '+esc(h.activeBrainLabel||state.activeBrainLabel||'No model configured')+'</span><span class="pill">'+dot(h.ocpAgent??h.hermes)+' OCP Agent</span><span class="pill">'+dot(h.ocpCoder??h.grokBuild)+' OCP Coder</span>';
  }catch(e){document.querySelector('#health').textContent=e.message}
}
function connectEvents(){
  try{
    const es=new EventSource('/api/events');
    es.addEventListener('hello',()=>{sseLive=true});
    es.addEventListener('state',()=>{load().catch(()=>{});if(centerView==='computer')refreshComputer(false).catch(()=>{})});
    es.onerror=()=>{sseLive=false};
  }catch(e){sseLive=false}
}
load().then(()=>{if(location.hash==='#computer'||new URLSearchParams(location.search).get('view')==='computer')setCenterView('computer')}).catch(e=>document.querySelector('#tasks').textContent=e.message);
showHealth();
connectEvents();
setInterval(()=>{if(!sseLive)load().catch(()=>{});if(centerView==='computer')refreshComputer(false).catch(()=>{})},8000);
setInterval(showHealth,30000);
</script></body></html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeJs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/</g, "\\x3c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
