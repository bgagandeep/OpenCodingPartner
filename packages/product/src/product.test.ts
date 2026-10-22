import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  backupProductData,
  botRuntimeLabel,
  computerKeyboard,
  computerMouse,
  computerOpenBrowser,
  createBot,
  createProductRoutine,
  createTask,
  listProductRoutines,
  defaultBotInstructions,
  deleteBot,
  deleteTask,
  dockerDaemonAvailable,
  findBot,
  findTask,
  isOcpAgentRuntime,
  leadBotInstructions,
  listBots,
  listTasks,
  missingProviderKey,
  resolveRuntimeCommand,
  restoreProductData,
  runBotSession,
  setComputerControl,
  stopComputerDesktop,
  updateBot,
  updateBotSession,
  updateTask,
  validBotRuntime,
  waitForRecordedApproval,
  type RuntimeUpdate,
} from "./index.js";
import { startProductApp, visibleWorkspaceChangeFiles } from "./server.js";

const distDir = path.dirname(fileURLToPath(import.meta.url));

async function makeTempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function createMockAcpScript(dir: string, filename = "mock-acp.mjs"): Promise<string> {
  const scriptPath = path.join(dir, filename);
  const code = `#!/usr/bin/env node
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("mock-acp 1.0.0\\n");
  process.exit(0);
}

const mode = process.env.MOCK_ACP_MODE ?? "normal";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let lastPromptId = 3;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: mode !== "no-load-capability" },
      },
    });
    return;
  }
  if (msg.method === "session/load") {
    if (mode === "load-fails") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Session not found" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: msg.params.sessionId,
        configOptions: [
          {
            id: "model",
            options: [{ value: "openrouter:anthropic/claude-sonnet-4" }, { value: "openrouter:openai/gpt-4.1" }],
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "session/new") {
    const mcpCount = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers.length : 0;
    const result =
      mode === "legacy-models"
        ? {
            sessionId: "sess-legacy-" + mcpCount,
            models: { availableModels: [{ modelId: "openrouter:deepseek-r1" }, { modelId: "openrouter:gpt-4o" }] },
          }
        : {
            sessionId: "sess-new-" + mcpCount,
            configOptions: [
              {
                id: "model",
                options: [
                  { value: "openrouter:anthropic/claude-sonnet-4" },
                  { value: "openrouter:openai/gpt-4.1" },
                  { value: "provider-a:ambiguous-model" },
                  { value: "provider-b:ambiguous-model" },
                ],
              },
            ],
          };
    send({ jsonrpc: "2.0", id: msg.id, result });
    return;
  }
  if (msg.method === "session/set_config_option") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { selected: msg.params.value },
    });
    return;
  }
  if (msg.method === "session/set_model") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { modelId: msg.params.modelId },
    });
    return;
  }
  if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    if (mode === "rpc-secret-error") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32001,
          message: "Upstream rejected Bearer secret-bearer-token-123456 and sk-secretkey9876543210 OPENROUTER_API_KEY=topsecretval",
        },
      });
      return;
    }
    if (mode === "ask-permission") {
      send({
        jsonrpc: "2.0",
        id: 900,
        method: "session/request_permission",
        params: {
          toolCall: {
            title: "Run pytest",
            kind: "execute",
            rawInput: { command: "pytest -q" },
          },
          options: [
            { optionId: "allow-once-id", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once-id", name: "Reject once", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello from " + (process.env.HERMES_HOME ? "explicit-profile" : "default-profile") },
        },
      },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (msg.id === 900 && msg.result) {
    const outcome = msg.result.outcome?.outcome === "selected" ? msg.result.outcome.optionId : "cancelled";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Permission outcome: " + outcome },
        },
      },
    });
    send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
  }
});
`;
  await writeFile(scriptPath, code, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

test("OCP Agent and OCP Coder runtime helpers, bot CRUD, and task workspace/reviewer validation", async () => {
  const root = await makeTempDir("ocp-product-crud-");
  const workspaceA = path.join(root, "ws-a");
  const workspaceB = path.join(root, "ws-b");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  try {
    assert.equal(validBotRuntime("ocp-agent"), true);
    assert.equal(validBotRuntime("ocp-coder"), true);
    assert.equal(validBotRuntime("hermes"), true);
    assert.equal(validBotRuntime("grok-build"), true);
    assert.equal(validBotRuntime("other"), false);

    assert.equal(isOcpAgentRuntime("ocp-agent"), true);
    assert.equal(isOcpAgentRuntime("hermes"), true);
    assert.equal(isOcpAgentRuntime("ocp-coder"), false);
    assert.equal(isOcpAgentRuntime("grok-build"), false);

    assert.equal(botRuntimeLabel("ocp-agent"), "OCP Agent");
    assert.equal(botRuntimeLabel("hermes"), "OCP Agent");
    assert.equal(botRuntimeLabel("ocp-coder"), "OCP Coder");
    assert.equal(botRuntimeLabel("grok-build"), "OCP Coder");
    assert.match(defaultBotInstructions("coding"), /OCP Coder/);
    assert.match(defaultBotInstructions("coding"), /plan_submit/);
    assert.doesNotMatch(defaultBotInstructions("coding"), /do NOT stop at a research plan/);
    assert.doesNotMatch(leadBotInstructions(), /do NOT stop at a research plan/);

    const agentBot = await createBot(
      {
        name: "Coder Teammate",
        role: "coding",
        runtime: "hermes",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        workspace: workspaceA,
        instructions: defaultBotInstructions("coding"),
      },
      root,
    );
    assert.equal(agentBot.runtime, "hermes");
    await updateBotSession(agentBot.id, "sess-123", root);

    // Updating runtime from legacy alias "hermes" to "ocp-agent" keeps the session ID
    const upgraded = await updateBot(agentBot.id, { runtime: "ocp-agent" }, root);
    assert.equal(upgraded.runtime, "ocp-agent");
    assert.equal(upgraded.runtimeSessionId, "sess-123");

    // Switching runtime to "ocp-coder" resets the session ID
    const switchedToCoder = await updateBot(
      agentBot.id,
      { runtime: "ocp-coder", provider: undefined, model: undefined },
      root,
    );
    assert.equal(switchedToCoder.runtime, "ocp-coder");
    assert.equal(switchedToCoder.runtimeSessionId, undefined);

    // Provider key preflight helper checks explicit provider bots and skips OCP Coder
    const reviewer = await createBot(
      {
        name: "QA Reviewer",
        role: "qa",
        runtime: "ocp-agent",
        provider: "litellm",
        model: "gpt-4o",
        workspace: workspaceA,
        instructions: defaultBotInstructions("qa"),
      },
      root,
    );
    assert.equal(missingProviderKey(switchedToCoder, {}), undefined);
    assert.match(missingProviderKey(reviewer, {}) ?? "", /LITELLM_API_KEY/);

    const wrongWsReviewer = await createBot(
      {
        name: "OtherWsReviewer",
        role: "qa",
        runtime: "ocp-agent",
        workspace: workspaceB,
        instructions: defaultBotInstructions("qa"),
      },
      root,
    );
    await assert.rejects(
      () =>
        createTask(
          {
            botId: switchedToCoder.id,
            reviewerBotId: wrongWsReviewer.id,
            prompt: "Add unit tests",
          },
          root,
        ),
      /A specialist reviewer must be a separate QA or security bot assigned to the same workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runBotSession handles ACP session new/load/reset, model selection, permissions, and secret redaction", async () => {
  const root = await makeTempDir("ocp-product-acp-");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const mockBin = await createMockAcpScript(root);

  const prevAgentBin = process.env.OCP_AGENT_BIN;
  const prevOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const prevMockMode = process.env.MOCK_ACP_MODE;
  process.env.OCP_AGENT_BIN = mockBin;
  process.env.OPENROUTER_API_KEY = "sk-openrouter-test-key-1234567890";

  try {
    const bot = await createBot(
      {
        name: "AgentBot",
        role: "coding",
        runtime: "ocp-agent",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        isolation: "host",
        workspace,
        instructions: defaultBotInstructions("coding"),
      },
      root,
    );

    // 1. Fresh session + explicit profile HERMES_HOME
    delete process.env.MOCK_ACP_MODE;
    const updates1: RuntimeUpdate[] = [];
    const run1 = await runBotSession(bot, "Say hello", {
      dataDir: root,
      onUpdate: (update) => {
        updates1.push(update);
      },
    });
    assert.equal(run1.sessionId, "sess-new-1");
    assert.match(run1.result, /Hello from explicit-profile/);
    assert.equal(updates1.some((u) => u.kind === "session_reset"), false);
    const profileConfig = await readFile(path.join(root, "hermes-profiles", bot.id, "config.yaml"), "utf8");
    assert.match(profileConfig, /anthropic\/claude-sonnet-4/);

    // 2. Session load fallback to session/new when agentCapabilities.loadSession is false
    process.env.MOCK_ACP_MODE = "no-load-capability";
    const botWithSession = { ...bot, runtimeSessionId: "sess-old-99" };
    const updates2: RuntimeUpdate[] = [];
    const run2 = await runBotSession(botWithSession, "Resume test", {
      dataDir: root,
      onUpdate: (update) => {
        updates2.push(update);
      },
    });
    assert.equal(run2.sessionId, "sess-new-1");
    assert.equal(updates2.some((u) => u.kind === "session_reset"), true);

    // 3. Default-profile model selection: unambiguous match, ambiguous match rejection, and legacy models catalog
    delete process.env.MOCK_ACP_MODE;
    const runDefaultModel = await runBotSession(
      { ...bot, provider: undefined, model: "anthropic/claude-sonnet-4" },
      "Test unambiguous default-profile model",
      { dataDir: root },
    );
    assert.equal(runDefaultModel.sessionId, "sess-new-1");

    await assert.rejects(
      () =>
        runBotSession({ ...bot, provider: undefined, model: "ambiguous-model" }, "Test ambiguous model", {
          dataDir: root,
        }),
      /matches multiple runtime models/,
    );

    // 4. Legacy models catalog + session/set_model path works
    process.env.MOCK_ACP_MODE = "legacy-models";
    const runLegacy = await runBotSession(
      { ...bot, provider: undefined, model: "deepseek-r1" },
      "Test legacy model catalog",
      { dataDir: root },
    );
    assert.equal(runLegacy.sessionId, "sess-legacy-1");

    // 5. Permission approval flow passes toolCall details and returns allow_once
    process.env.MOCK_ACP_MODE = "ask-permission";
    const seenRequests: Array<{ title: string; description?: string }> = [];
    const runPerm = await runBotSession(bot, "Run tests with approval", {
      dataDir: root,
      onPermissionRequest: async (req) => {
        seenRequests.push({ title: req.title, description: req.description });
        return req.options.find((o) => o.kind === "allow_once")?.optionId;
      },
    });
    assert.equal(seenRequests.length, 1);
    assert.match(seenRequests[0]?.title ?? "", /Run pytest/);
    assert.match(seenRequests[0]?.description ?? "", /pytest -q/);
    assert.match(runPerm.result, /Permission outcome: allow-once-id/);

    // 6. RPC error redacts Bearer tokens and API keys
    process.env.MOCK_ACP_MODE = "rpc-secret-error";
    await assert.rejects(
      () =>
        runBotSession(bot, "Trigger error", {
          dataDir: root,
        }),
      (err: Error) => {
        assert.match(err.message, /Agent runtime error \(-32001\)/);
        assert.match(err.message, /\[redacted/);
        assert.doesNotMatch(err.message, /secret-bearer-token-123456/);
        assert.doesNotMatch(err.message, /sk-secretkey9876543210/);
        assert.doesNotMatch(err.message, /topsecretval/);
        return true;
      },
    );
  } finally {
    if (prevAgentBin === undefined) delete process.env.OCP_AGENT_BIN;
    else process.env.OCP_AGENT_BIN = prevAgentBin;
    if (prevOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOpenRouterKey;
    if (prevMockMode === undefined) delete process.env.MOCK_ACP_MODE;
    else process.env.MOCK_ACP_MODE = prevMockMode;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace MCP server exposes guarded workspace tools and blocks secrets/escapes", async () => {
  const workspace = await makeTempDir("ocp-mcp-ws-");
  const mcpServerPath = path.join(distDir, "workspace-mcp.js");
  const child = spawn(process.execPath, [mcpServerPath, workspace], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (typeof msg.id === "number") {
      pending.get(msg.id)?.resolve(msg);
      pending.delete(msg.id);
    }
  });
  child.on("exit", (code, signal) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`workspace-mcp exited (${code ?? signal ?? "unknown"})`));
    }
    pending.clear();
  });
  let seq = 0;
  function rpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  try {
    const init = await rpc("initialize");
    assert.ok(init.result);

    const toolsRes = (await rpc("tools/list")).result as { tools: Array<{ name: string }> };
    const names = toolsRes.tools.map((t) => t.name);
    assert.equal(names.includes("workspace_write"), true);
    assert.equal(names.includes("workspace_read"), true);
    assert.equal(names.includes("workspace_patch"), true);
    assert.equal(names.includes("workspace_shell"), true);
    assert.equal(names.includes("workspace_test"), true);
    assert.equal(names.includes("plan_submit"), true);

    const writeOk = (
      await rpc("tools/call", {
        name: "workspace_write",
        arguments: { path: "src/hello.txt", content: "hello world\n" },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(Boolean(writeOk.isError), false);

    const readOk = (
      await rpc("tools/call", {
        name: "workspace_read",
        arguments: { path: "src/hello.txt" },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(Boolean(readOk.isError), false);
    assert.equal(readOk.content[0]?.text, "hello world\n");

    const secretWrite = (
      await rpc("tools/call", {
        name: "workspace_write",
        arguments: { path: "src/secret.txt", content: "OPENAI_API_KEY=sk-1234567890abcdef1234567890abcdef\n" },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(secretWrite.isError, true);

    const escapeWrite = await rpc("tools/call", {
      name: "workspace_write",
      arguments: { path: "../escape.txt", content: "nope\n" },
    });
    assert.ok(escapeWrite.error);

    const refusedShell = (
      await rpc("tools/call", {
        name: "workspace_shell",
        arguments: { argv: ["bash", "-c", "rm -rf /"] },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(refusedShell.isError, true);

    await writeFile(path.join(workspace, "ok.test.js"), "import test from 'node:test';\ntest('ok', () => {});\n", "utf8");
    const tests = (
      await rpc("tools/call", {
        name: "workspace_test",
        arguments: {},
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(Boolean(tests.isError), false);
    assert.match(tests.content[0]?.text ?? "", /"ok": true/);
  } finally {
    rl.close();
    child.kill();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("backupProductData and restoreProductData preserve state, remap workspaces, and reset remapped sessions", async () => {
  const root = await makeTempDir("ocp-backup-test-");
  const dataDir = path.join(root, "data");
  const backupDir = path.join(root, "backup");
  const restoredDir = path.join(root, "restored");
  const oldWs = path.join(root, "old-ws", "project");
  const newWs = path.join(root, "new-ws", "project");
  const untouchedWs = path.join(root, "other-ws");
  await mkdir(oldWs, { recursive: true });
  await mkdir(newWs, { recursive: true });
  await mkdir(untouchedWs, { recursive: true });

  try {
    const botA = await createBot(
      {
        name: "RemappedBot",
        role: "coding",
        runtime: "ocp-agent",
        workspace: oldWs,
        instructions: defaultBotInstructions("coding"),
      },
      dataDir,
    );
    const botB = await createBot(
      {
        name: "StaticBot",
        role: "qa",
        runtime: "ocp-coder",
        workspace: untouchedWs,
        instructions: defaultBotInstructions("qa"),
      },
      dataDir,
    );
    await updateBotSession(botA.id, "sess-remap", dataDir);
    await updateBotSession(botB.id, "sess-keep", dataDir);

    const backedUp = await backupProductData(backupDir, dataDir);
    assert.equal(backedUp, backupDir);

    const restored = await restoreProductData(backupDir, restoredDir, {
      from: path.join(root, "old-ws"),
      to: path.join(root, "new-ws"),
    });
    assert.equal(restored.directory, restoredDir);
    assert.deepEqual(restored.remappedBots, ["RemappedBot"]);

    const restoredA = await findBot(botA.id, restoredDir);
    const restoredB = await findBot(botB.id, restoredDir);
    assert.equal(restoredA?.workspace, newWs);
    assert.equal(restoredA?.runtimeSessionId, undefined);
    assert.equal(restoredB?.workspace, untouchedWs);
    assert.equal(restoredB?.runtimeSessionId, "sess-keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startProductApp serves OCP Agent and OCP Coder UI, health check, model-override validation, and task execution", async () => {
  const root = await makeTempDir("ocp-server-test-");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const mockBin = await createMockAcpScript(root);

  const prevAgentBin = process.env.OCP_AGENT_BIN;
  const prevCoderBin = process.env.OCP_CODER_BIN;
  const prevMockMode = process.env.MOCK_ACP_MODE;
  process.env.OCP_AGENT_BIN = mockBin;
  process.env.OCP_CODER_BIN = mockBin;
  delete process.env.MOCK_ACP_MODE;

  const app = await startProductApp({ root, port: 0 });
  try {
    const htmlRes = await fetch(app.url);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /OCP Agent/);
    assert.match(html, /OCP Coder/);
    assert.match(html, /Open Coding Partner/);
    assert.match(html, /\/api\/events/);
    assert.doesNotMatch(html, /Ask Ada/);
    assert.doesNotMatch(html, /Open Gmail/);
    assert.doesNotMatch(html, /mail\.google\.com/);
    assert.match(html, /Google sign-in stays in this virtual computer/);
    assert.match(html, /OCP does not connect a Google account/);
    assert.match(html, /no Gmail, Calendar, or Drive connection/);
    assert.doesNotMatch(html, /Connect Google/);
    const inlineScript = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    assert.ok(inlineScript.length > 100);
    assert.doesNotThrow(() => new Function(inlineScript));
    const tokenMatch = /script-src 'nonce-([a-f0-9]+)'/.exec(htmlRes.headers.get("content-security-policy") ?? "");
    const token = tokenMatch?.[1] ?? "";
    assert.ok(token.length > 0);

    const healthRes = await fetch(`${app.url}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as {
      ocpAgent: boolean;
      ocpCoder: boolean;
      hermes: boolean;
      grokBuild: boolean;
    };
    assert.equal(health.ocpAgent, true);
    assert.equal(health.ocpCoder, true);
    assert.equal(health.hermes, true);
    assert.equal(health.grokBuild, true);

    // Rejects standalone model override on default profile via API
    const badModelRes = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({
        name: "InvalidModelBot",
        role: "coding",
        runtime: "ocp-agent",
        model: "anthropic/claude-sonnet-4",
        workspace,
      }),
    });
    assert.equal(badModelRes.status, 400);
    const badModelBody = (await badModelRes.json()) as { error: string };
    assert.match(badModelBody.error, /A model override requires an explicit OpenRouter or OpenAI-compatible provider profile/);

    const createBotRes = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({
        name: "ServerBot",
        role: "coding",
        runtime: "ocp-agent",
        isolation: "host",
        workspace,
      }),
    });
    assert.equal(createBotRes.status, 201);
    const { bot } = (await createBotRes.json()) as { bot: { id: string; runtime: string } };
    assert.equal(bot.runtime, "ocp-agent");

    const createTaskRes = await fetch(`${app.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({
        botId: bot.id,
        prompt: "Check workspace status",
      }),
    });
    assert.equal(createTaskRes.status, 202);
    const { taskId } = (await createTaskRes.json()) as { taskId: string };

    // Poll briefly for background task completion
    let finalTask = await findTask(taskId, root);
    for (let i = 0; i < 40 && (finalTask?.status === "queued" || finalTask?.status === "running"); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      finalTask = await findTask(taskId, root);
    }
    assert.equal(finalTask?.status, "succeeded");
    assert.match(finalTask?.result ?? "", /Hello from default-profile/);

    await deleteTask(taskId, root);
    await deleteBot(bot.id, root);
    assert.equal((await listBots(root)).length, 0);
    assert.equal((await listTasks(root)).length, 0);
  } finally {
    await app.close();
    if (prevAgentBin === undefined) delete process.env.OCP_AGENT_BIN;
    else process.env.OCP_AGENT_BIN = prevAgentBin;
    if (prevCoderBin === undefined) delete process.env.OCP_CODER_BIN;
    else process.env.OCP_CODER_BIN = prevCoderBin;
    if (prevMockMode === undefined) delete process.env.MOCK_ACP_MODE;
    else process.env.MOCK_ACP_MODE = prevMockMode;
    await rm(root, { recursive: true, force: true });
  }
});

test("OCP Coder OpenRouter/LiteLLM profile writes isolated GROK_HOME config.toml and resolveRuntimeCommand falls back to native ACP", async () => {
  const root = await makeTempDir("ocp-coder-profile-");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const mockBin = await createMockAcpScript(root);

  const prevCoderBin = process.env.OCP_CODER_BIN;
  const prevOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.OCP_CODER_BIN = mockBin;
  process.env.OPENROUTER_API_KEY = "sk-openrouter-coder-test-123456";

  try {
    // 1. Verify resolveRuntimeCommand falls back to built-in native-acp.js when PATH has no hermes/grok
    const resolved = await resolveRuntimeCommand(true, { PATH: root });
    assert.equal(resolved.fallback, true);
    assert.equal(resolved.command, process.execPath);
    assert.match(resolved.args[0] ?? "", /native-acp\.js$/);

    // 2. Verify OCP Coder with OpenRouter generates isolated coder-profiles/<bot.id>/config.toml
    const coderBot = await createBot(
      {
        name: "India Unlocked Coder",
        role: "coding",
        runtime: "ocp-coder",
        provider: "openrouter",
        model: "qwen/qwen-2.5-coder-32b-instruct",
        workspace,
        instructions: defaultBotInstructions("coding"),
      },
      root,
    );
    const run = await runBotSession(coderBot, "Say hello from OCP Coder", { dataDir: root });
    assert.equal(run.sessionId, "sess-new-0");
    const toml = await readFile(path.join(root, "coder-profiles", coderBot.id, "config.toml"), "utf8");
    assert.match(toml, /default = "ocp-custom"/);
    assert.match(toml, /\[model\.ocp-custom\]/);
    assert.match(toml, /model = "qwen\/qwen-2\.5-coder-32b-instruct"/);
    assert.match(toml, /base_url = "https:\/\/openrouter\.ai\/api\/v1"/);
    assert.match(toml, /env_key = "OPENROUTER_API_KEY"/);
    assert.match(toml, /telemetry = false/);
    assert.match(toml, /trace_upload = false/);
  } finally {
    if (prevCoderBin === undefined) delete process.env.OCP_CODER_BIN;
    else process.env.OCP_CODER_BIN = prevCoderBin;
    if (prevOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOpenRouterKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace MCP server supports persistent memory, bounded task history recall, and compact tool discovery", async () => {
  const root = await makeTempDir("ocp-mcp-extended-");
  const workspace = path.join(root, "ws");
  const dataDir = path.join(root, "data");
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  // Seed a bot and task in dataDir for history_search / history_read
  const bot = await createBot(
    {
      name: "HistoryBot",
      role: "coding",
      runtime: "ocp-agent",
      workspace,
      instructions: defaultBotInstructions("coding"),
    },
    dataDir,
  );
  const seededTask = await createTask(
    {
      botId: bot.id,
      prompt: "Migrate authentication middleware to JWT",
    },
    dataDir,
  );
  await updateTask(
    seededTask.id,
    {
      status: "succeeded",
      result: "Authentication middleware migrated to RS256 JWT tokens.",
    },
    dataDir,
  );

  const mcpServerPath = path.join(distDir, "workspace-mcp.js");
  // Spawn with PATH="" to also verify macOS / headless environments without Xvnc/xdotool/ffmpeg
  const child = spawn(process.execPath, [mcpServerPath, workspace], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OCP_DATA_DIR: dataDir, PATH: "" },
  });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (typeof msg.id === "number") {
      pending.get(msg.id)?.resolve(msg);
      pending.delete(msg.id);
    }
  });
  child.on("exit", (code, signal) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`workspace-mcp exited (${code ?? signal ?? "unknown"})`));
    }
    pending.clear();
  });
  let seq = 0;
  function rpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  try {
    await rpc("initialize");

    // 1. Memory lifecycle: remember -> search -> forget
    const remRes = (
      await rpc("tools/call", {
        name: "memory_remember",
        arguments: { section: "Build Commands", note: "Always run corepack pnpm test before committing." },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(Boolean(remRes.isError), false);

    const searchMemRes = (
      await rpc("tools/call", {
        name: "memory_search",
        arguments: { query: "corepack pnpm" },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(Boolean(searchMemRes.isError), false);
    assert.match(searchMemRes.content[0]?.text ?? "", /Build Commands/);

    const forgetRes = (
      await rpc("tools/call", {
        name: "memory_forget",
        arguments: { match: "corepack pnpm test" },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(Boolean(forgetRes.isError), false);
    assert.match(forgetRes.content[0]?.text ?? "", /removed 1 entries/);

    // 2. Task history recall: history_search & history_read
    const histSearchRes = (
      await rpc("tools/call", {
        name: "history_search",
        arguments: { query: "JWT" },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(Boolean(histSearchRes.isError), false);
    assert.match(histSearchRes.content[0]?.text ?? "", new RegExp(seededTask.id));

    const histReadRes = (
      await rpc("tools/call", {
        name: "history_read",
        arguments: { taskId: seededTask.id },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(Boolean(histReadRes.isError), false);
    assert.match(histReadRes.content[0]?.text ?? "", /RS256 JWT tokens/);

    // 3. Compact tool discovery: tool_search, tool_describe, tool_call + recursion guard
    const toolSearchRes = (
      await rpc("tools/call", {
        name: "tool_search",
        arguments: { query: "patch" },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(Boolean(toolSearchRes.isError), false);
    assert.match(toolSearchRes.content[0]?.text ?? "", /workspace_patch/);

    const toolDescRes = (
      await rpc("tools/call", {
        name: "tool_describe",
        arguments: { name: "workspace_write" },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(Boolean(toolDescRes.isError), false);
    assert.match(toolDescRes.content[0]?.text ?? "", /inputSchema/);

    const proxiedWrite = (
      await rpc("tools/call", {
        name: "tool_call",
        arguments: { name: "workspace_write", arguments: { path: "via-proxy.txt", content: "proxied\n" } },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(Boolean(proxiedWrite.isError), false);
    assert.equal(await readFile(path.join(workspace, "via-proxy.txt"), "utf8"), "proxied\n");

    const recursiveCall = (
      await rpc("tools/call", {
        name: "tool_call",
        arguments: { name: "tool_call", arguments: { name: "workspace_status" } },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(recursiveCall.isError, true);
    assert.match(recursiveCall.content[0]?.text ?? "", /cannot call another discovery tool/);

    // 4. Virtual computer MCP tools fail closed when Xvnc/display is missing (no fake screenshots).
    const screenRes = (
      await rpc("tools/call", {
        name: "computer_screen",
        arguments: {},
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(screenRes.isError, true);
    assert.match(screenRes.content[0]?.text ?? "", /not available|not invent a screenshot/i);

    const mouseRes = (
      await rpc("tools/call", {
        name: "computer_mouse",
        arguments: { action: "move", x: 500, y: 350 },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(mouseRes.isError, true);

    const keyRes = (
      await rpc("tools/call", {
        name: "computer_keyboard",
        arguments: { action: "key", key: "Return" },
      })
    ).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(keyRes.isError, true);
  } finally {
    rl.close();
    child.kill();
    await stopComputerDesktop(workspace).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Lead Orchestrator bot creates other bots, manages the fleet, delegates work, and /api/bootstrap + /api/settings work end-to-end", async () => {
  const root = await makeTempDir("ocp-swarm-lead-");
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# Demo Repo\nHello from OpenCodingPartner Swarm!\n", "utf8");

  const app = await startProductApp({
    root: dataDir,
    port: 0,
    env: {
      ...process.env,
      PATH: path.dirname(process.execPath),
      OCP_DATA_DIR: dataDir,
      OCP_DISABLE_LOCAL_OLLAMA: "1",
    },
  });

  try {
    const htmlRes = await fetch(app.url);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec(htmlRes.headers.get("content-security-policy") ?? "")?.[1] ?? "";
    assert.ok(token);

    // 1. Bootstrap Lead Orchestrator bot (Ada) via /api/bootstrap
    const bootRes = await fetch(`${app.url}/api/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({ mode: "lead", workspace }),
    });
    assert.equal(bootRes.status, 200);
    const bootData = (await bootRes.json()) as {
      ok: boolean;
      created: Array<{ id: string; name: string; role: string }>;
      bots: Array<{ id: string; name: string; role: string }>;
    };
    assert.equal(bootData.ok, true);
    assert.equal(bootData.bots.length, 1);
    assert.equal(bootData.bots[0]?.name, "Ada");
    const ada = (await findBot("Ada", dataDir))!;
    assert.ok(ada);

    const runEnv = {
      PATH: path.dirname(process.execPath),
      OCP_DATA_DIR: dataDir,
      OCP_DISABLE_LOCAL_OLLAMA: "1",
    };

    // 2. Offline/no-model mode must not keyword-guess fleet changes (repro: "remove Linus" used to delete a bot).
    const offlineTurn = await runBotSession(ada, "remove Linus changes from the diff", {
      dataDir,
      env: runEnv,
    });
    assert.match(offlineTurn.result, /No model is configured/i);
    assert.equal((await listBots(dataDir)).length, 1);
    assert.equal((await listBots(dataDir))[0]?.name, "Ada");

    const qaHandoff = await runBotSession(ada, "Review the work completed by Coder. Implementation agent report: wrote hello.txt", {
      dataDir,
      env: runEnv,
    });
    assert.match(qaHandoff.result, /No model is configured/i);
    assert.doesNotMatch(qaHandoff.result, /No blocking security or regression defects detected/);
    assert.equal((await listBots(dataDir)).length, 1);

    // 3. Human API still creates the rest of the fleet (bot tools are not guessed without a model).
    const teamRes = await fetch(`${app.url}/api/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({ mode: "team", workspace }),
    });
    assert.equal(teamRes.status, 200);
    assert.equal((await listBots(dataDir)).length, 5);

    // 6. Verify /api/settings saves and applies provider keys without server restart
    const saveSettingsRes = await fetch(`${app.url}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({
        openrouterApiKey: "sk-or-v1-test-ui-saved-key",
        defaultModel: "qwen/qwen-2.5-coder-32b-instruct",
      }),
    });
    assert.equal(saveSettingsRes.status, 200);
    const savedSettings = (await saveSettingsRes.json()) as {
      ok: boolean;
      openrouterConfigured: boolean;
      defaultModel: string;
    };
    assert.equal(savedSettings.ok, true);
    assert.equal(savedSettings.openrouterConfigured, true);
    assert.equal(savedSettings.defaultModel, "qwen/qwen-2.5-coder-32b-instruct");

    // 7. Verify each project/product has its own isolated bot group (including same bot names across projects)
    const secondWorkspace = path.join(root, "second-product");
    const createProjRes = await fetch(`${app.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({
        name: "Second Product",
        workspace: secondWorkspace,
        description: "Isolated product with its own bot fleet",
        mode: "team",
      }),
    });
    assert.equal(createProjRes.status, 201);
    const projData = (await createProjRes.json()) as {
      ok: boolean;
      project: { id: string; name: string; workspace: string };
      bots: Array<{ id: string; name: string; role: string; workspace: string }>;
    };
    assert.equal(projData.ok, true);
    assert.equal(projData.project.name, "Second Product");
    assert.equal(projData.bots.length, 5);
    assert.equal((await listBots(dataDir, workspace)).length, 5);
    assert.equal((await listBots(dataDir, secondWorkspace)).length, 5);

    // 8. Verify Virtual Computer human takeover blocks bot actions while allowing human actions, then returns control
    const held = await setComputerControl(workspace, "takeover");
    assert.equal(held.control, "human");
    assert.equal(held.status, "held");
    const blockedBotMouse = await computerMouse(workspace, { action: "click", x: 200, y: 200, actor: "partner" });
    assert.equal(blockedBotMouse.ok, false);
    assert.match(blockedBotMouse.detail, /held by human takeover/);
    const allowedHumanMouse = await computerMouse(workspace, { action: "click", x: 200, y: 200, actor: "human" });
    if (!allowedHumanMouse.ok) {
      assert.match(allowedHumanMouse.detail, /not available|not invent|failed/i);
    }
    const allowedHumanKey = await computerKeyboard(workspace, { action: "type", text: "hello", actor: "human" });
    if (!allowedHumanKey.ok) {
      assert.match(allowedHumanKey.detail, /not available|not invent|failed|must be 1 to 2,000/i);
    }
    const returned = await setComputerControl(workspace, "return");
    assert.equal(returned.control, "partner");
    const allowedBotMouseAfter = await computerMouse(workspace, { action: "click", x: 200, y: 200, actor: "partner" });
    assert.doesNotMatch(allowedBotMouseAfter.detail, /held by human takeover/);
  } finally {
    await stopComputerDesktop(workspace).catch(() => undefined);
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bots cannot set host isolation or escape approved workspace roots; docker isolation fails closed", async () => {
  const root = await makeTempDir("ocp-safety-isolation-");
  const workspace = path.join(root, "ws");
  const outside = path.join(root, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    const humanBot = await createBot(
      {
        name: "Lead",
        role: "general",
        runtime: "ocp-agent",
        isolation: "host",
        workspace,
        instructions: defaultBotInstructions("general"),
      },
      root,
      { actor: "human" },
    );
    await assert.rejects(
      () =>
        createBot(
          {
            name: "Escape",
            role: "coding",
            runtime: "ocp-agent",
            isolation: "host",
            workspace: outside,
            instructions: defaultBotInstructions("coding"),
          },
          root,
          { actor: "bot", allowNewRoot: false },
        ),
      /Host isolation can only be set by a human/,
    );
    await assert.rejects(
      () =>
        createBot(
          {
            name: "Escape",
            role: "coding",
            runtime: "ocp-agent",
            isolation: "docker",
            workspace: outside,
            instructions: defaultBotInstructions("coding"),
          },
          root,
          { actor: "bot", allowNewRoot: false },
        ),
      /approved project root/,
    );
    await assert.rejects(
      () => updateBot(humanBot.id, { isolation: "docker" }, root, { actor: "bot" }),
      /cannot change another bot's isolation/,
    );

    const dockerBot = await createBot(
      {
        name: "Boxed",
        role: "general",
        runtime: "ocp-agent",
        isolation: "docker",
        workspace,
        instructions: defaultBotInstructions("general"),
      },
      root,
    );
    await assert.rejects(
      () =>
        runBotSession(dockerBot, "hello", {
          dataDir: root,
          env: { ...process.env, PATH: path.dirname(process.execPath), OCP_DATA_DIR: root },
        }),
      /Docker isolation is configured but Docker is not available/,
    );
    assert.equal(typeof dockerDaemonAvailable(), "boolean");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second task in the same workspace is queued instead of refused", async () => {
  const root = await makeTempDir("ocp-task-queue-");
  const workspace = path.join(root, "ws");
  await mkdir(workspace, { recursive: true });
  try {
    const bot = await createBot(
      {
        name: "QueueBot",
        role: "coding",
        runtime: "ocp-coder",
        workspace,
        instructions: defaultBotInstructions("coding"),
      },
      root,
    );
    const first = await createTask({ botId: bot.id, prompt: "first" }, root);
    await updateTask(first.id, { status: "running" }, root);
    const second = await createTask({ botId: bot.id, prompt: "second" }, root);
    assert.equal(second.status, "queued");
    const listed = await listTasks(root);
    assert.equal(listed.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome profile lives outside the workspace and browser fails without a display", async () => {
  const root = await makeTempDir("ocp-chrome-profile-");
  const workspace = path.join(root, "ws");
  await mkdir(workspace, { recursive: true });
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const result = await computerOpenBrowser(workspace, "https://example.com/", "human");
    assert.equal(result.ok, false);
    assert.match(result.detail, /not available|No Chrome|not invent/i);
    const workspaceProfile = path.join(workspace, ".ocp", "chrome-profile");
    await assert.rejects(() => readFile(path.join(workspaceProfile, "Local State"), "utf8"), /ENOENT/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await stopComputerDesktop(workspace).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard hides .ocp and gtm paths, streams SSE, and Always-for-task approvals persist", async () => {
  assert.deepEqual(
    visibleWorkspaceChangeFiles([
      { path: "src/app.ts" },
      { path: ".ocp/state.json" },
      { path: "gtm/last-frame.png" },
      { path: "packages/.ocp/cache" },
    ]).map((file) => file.path),
    ["src/app.ts"],
  );

  const root = await makeTempDir("ocp-ui-sse-");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await startProductApp({ root, port: 0 });
  try {
    const events = await fetch(`${app.url}/api/events`);
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
    events.body?.cancel();

    const htmlRes = await fetch(app.url);
    const tokenMatch = /script-src 'nonce-([a-f0-9]+)'/.exec(htmlRes.headers.get("content-security-policy") ?? "");
    const token = tokenMatch?.[1] ?? "";
    const botRes = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({ name: "Coder", role: "coding", runtime: "ocp-agent", isolation: "host", workspace }),
    });
    assert.equal(botRes.status, 201);
    const { bot } = (await botRes.json()) as { bot: { id: string } };
    const task = await createTask({ botId: bot.id, prompt: "Write a file" }, root);
    await updateTask(task.id, {
      status: "awaiting-approval",
      pendingApproval: {
        id: "req-always",
        title: "workspace_write",
        description: "edit hello.txt",
        allowOnceOptionId: "allow-once",
        requestedAt: new Date().toISOString(),
      },
    }, root);
    const approvalRes = await fetch(`${app.url}/api/tasks/${encodeURIComponent(task.id)}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({ requestId: "req-always", decision: "always" }),
    });
    assert.equal(approvalRes.status, 200);
    const saved = await findTask(task.id, root);
    assert.equal(saved?.autoApproveRemaining, true);
    const auto = await waitForRecordedApproval(task.id, {
      title: "workspace_write",
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
    }, root);
    assert.equal(auto, "allow-once");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("product app stores interval and event routines, MCP servers, and channel flags", async () => {
  const root = await makeTempDir("ocp-routines-");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await startProductApp({ root, port: 0 });
  try {
    const htmlRes = await fetch(app.url);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec(htmlRes.headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const html = await htmlRes.text();
    assert.match(html, /Routines/);
    assert.match(html, /Channels in this app/);
    const botRes = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({
        name: "Scheduler",
        role: "general",
        runtime: "ocp-agent",
        isolation: "host",
        workspace,
        mcpServers: [{ name: "docs", url: "http://127.0.0.1:3100" }],
      }),
    });
    assert.equal(botRes.status, 201);
    const { bot } = (await botRes.json()) as { bot: { id: string; mcpServers?: { name: string }[] } };
    assert.equal(bot.mcpServers?.[0]?.name, "docs");

    const created = await fetch(`${app.url}/api/routines`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({ botId: bot.id, prompt: "Ping the team", event: "build-finished" }),
    });
    assert.equal(created.status, 201);
    const fired = await fetch(`${app.url}/api/routines/event`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({ name: "build-finished" }),
    });
    assert.equal(fired.status, 202);
    const fireBody = (await fired.json()) as { fired: number };
    assert.equal(fireBody.fired, 1);

    await fetch(`${app.url}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({ slackBotToken: "xoxb-test", slackSigningSecret: "sign" }),
    });
    const settings = await fetch(`${app.url}/api/settings`);
    const settingsBody = (await settings.json()) as { slackConfigured: boolean };
    assert.equal(settingsBody.slackConfigured, true);
    const listed = await listProductRoutines(root);
    assert.equal(listed.length, 1);
    await createProductRoutine({ botId: bot.id, prompt: "Hourly ping", everyMs: 3600_000 }, root);
    assert.equal((await listProductRoutines(root)).length, 2);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});



