import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { externalToolNeedsApproval, probeConnectors } from "./connectors.js";
import { createBot, runBotSession } from "./index.js";
import { readMcpSecret } from "./mcp-secrets.js";
import { startProductApp } from "./server.js";

const SECRET = "connector-token-should-not-leak";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("mock server did not bind"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/mcp`);
    });
  });
}

function startMockMcp(token?: string): Promise<{ url: string; close: () => Promise<void>; calls: () => number }> {
  let calls = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const auth = request.headers.authorization;
      if (token && auth !== `Bearer ${token}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `unauthorized ${auth ?? ""}` }));
        return;
      }
      let message: { id?: number; method?: string; params?: { arguments?: { text?: string }; name?: string } } = {};
      try {
        message = JSON.parse(Buffer.concat(chunks).toString() || "{}") as typeof message;
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      const result = message.method === "initialize"
        ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "0" } }
        : message.method === "tools/list"
          ? { tools: [{ name: "ping", description: "Reply pong for connector tests", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
          : message.method === "tools/call"
            ? (calls += 1, { content: [{ type: "text", text: `pong:${message.params?.arguments?.text ?? ""}` }] })
            : undefined;
      if (!result) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { message: "unsupported" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  return listen(server).then((url) => ({
    url,
    calls: () => calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }));
}

test("external MCP tool calls are marked for the approval gate", () => {
  assert.equal(externalToolNeedsApproval("tool_call", { name: "mcp:docs/ping" }), true);
  assert.equal(externalToolNeedsApproval("mcp:docs/ping", {}), true);
  assert.equal(externalToolNeedsApproval("tool_call", { name: "workspace_read" }), false);
  assert.equal(externalToolNeedsApproval("workspace_write", {}), false);
});

test("connector probe reports auth rejection and a down server without hiding them", async () => {
  const mock = await startMockMcp(SECRET);
  try {
    const refused = await probeConnectors(
      [{ name: "docs", url: mock.url, authHeader: "Authorization" }],
      new Map([["docs", "wrong-token-value"]]),
    );
    assert.equal(refused.servers[0]?.status, "auth-rejected");
    assert.match(refused.errors[0] ?? "", /rejected authentication/);
    assert.doesNotMatch(refused.errors.join("\n"), /wrong-token-value/);
    assert.equal(refused.endpoints.length, 0);

    const closed = await probeConnectors([{ name: "gone", url: "http://127.0.0.1:9/mcp" }], new Map());
    assert.equal(closed.servers[0]?.status, "down");
    assert.match(closed.errors[0] ?? "", /MCP server "gone" is down/);
    assert.equal(closed.endpoints.length, 0);

    const ready = await probeConnectors([{ name: "docs", url: mock.url }], new Map([["docs", SECRET]]));
    assert.equal(ready.servers[0]?.status, "up");
    assert.deepEqual(ready.servers[0]?.toolNames, ["mcp:docs/ping"]);
    assert.equal(ready.errors.length, 0);
  } finally {
    await mock.close();
  }
});

test("dashboard connectors save a secret, list tools, and never echo the token", async () => {
  const root = await tempDir("ocp-connectors-");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const mock = await startMockMcp(SECRET);
  const app = await startProductApp({ root, port: 0 });
  try {
    const htmlRes = await fetch(app.url);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec(htmlRes.headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const html = await htmlRes.text();
    assert.match(html, /Connectors/);
    assert.match(html, /Test connection lists tools/);
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const botRes = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Connector", role: "general", runtime: "ocp-agent", isolation: "host", workspace }),
    });
    assert.equal(botRes.status, 201);
    const { bot } = (await botRes.json()) as { bot: { id: string } };
    const saved = await fetch(`${app.url}/api/bots/${bot.id}/connectors`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "docs", url: mock.url, authHeader: "Authorization", authToken: SECRET }),
    });
    const savedBody = await saved.text();
    assert.equal(saved.status, 201);
    assert.doesNotMatch(savedBody, new RegExp(SECRET));
    assert.match(savedBody, /authConfigured":true/);
    const stateRes = await fetch(`${app.url}/api/state`);
    const stateBody = await stateRes.text();
    assert.doesNotMatch(stateBody, new RegExp(SECRET));
    assert.match(stateBody, /mcp:docs\/ping|docs/);
    const onDisk = await readFile(path.join(root, "state.json"), "utf8");
    assert.doesNotMatch(onDisk, new RegExp(SECRET));
    const secretStat = await stat(path.join(root, "mcp-secrets.json"));
    assert.equal(secretStat.mode & 0o777, 0o600);
    assert.equal(await readMcpSecret(root, bot.id, "docs"), SECRET);

    const tested = await fetch(`${app.url}/api/bots/${bot.id}/connectors/test`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "docs" }),
    });
    const testedBody = await tested.json() as { connector?: { status?: string; toolNames?: string[] }; error?: string };
    assert.equal(tested.status, 200);
    assert.equal(testedBody.connector?.status, "up");
    assert.deepEqual(testedBody.connector?.toolNames, ["mcp:docs/ping"]);

    const poisoned = await fetch(`${app.url}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        name: "Connector",
        role: "general",
        runtime: "ocp-agent",
        isolation: "host",
        workspace,
        mcpServers: [{ name: "docs", url: mock.url, authToken: SECRET, headers: { Authorization: `Bearer ${SECRET}` } }],
      }),
    });
    const poisonedBody = await poisoned.text();
    assert.equal(poisoned.status, 200);
    assert.doesNotMatch(poisonedBody, new RegExp(SECRET));

    const removed = await fetch(`${app.url}/api/bots/${bot.id}/connectors/${encodeURIComponent("docs")}`, { method: "DELETE", headers });
    assert.equal(removed.status, 200);
    assert.equal(await readMcpSecret(root, bot.id, "docs"), undefined);
  } finally {
    await app.close();
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a down connector fails the bot run with a visible error", async () => {
  const root = await tempDir("ocp-connector-down-");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const script = path.join(root, "mock-acp.mjs");
  await writeFile(script, `#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  process.stdout.write("mock-acp 1.0.0\\n");
  process.exit(0);
}
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } }) + "\\n");
});
`, "utf8");
  await chmod(script, 0o755);
  const bot = await createBot({
    name: "Down",
    role: "general",
    runtime: "ocp-agent",
    isolation: "host",
    workspace,
    instructions: "Test bot",
    mcpServers: [{ name: "gone", url: "http://127.0.0.1:9/mcp" }],
  }, root);
  const events: string[] = [];
  await assert.rejects(
    () => runBotSession(bot, "hello", {
      dataDir: root,
      env: { ...process.env, OCP_AGENT_BIN: script },
      onUpdate: (update) => { if (update.kind === "connector_error") events.push(update.title ?? ""); },
    }),
    /MCP server "gone" is down/,
  );
  assert.match(events.join("\n"), /MCP server "gone" is down/);
  const stored = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as { bots: Array<{ mcpServers?: Array<{ status?: string; lastError?: string }> }> };
  assert.equal(stored.bots[0]?.mcpServers?.[0]?.status, "down");
  assert.match(stored.bots[0]?.mcpServers?.[0]?.lastError ?? "", /is down/);
  await rm(root, { recursive: true, force: true });
});

test("native runtime asks before an external MCP call and does not store the token", async () => {
  const root = await tempDir("ocp-native-mcp-");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const mock = await startMockMcp(SECRET);
  let llmCalls = 0;
  const llm = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      llm.unref();
      const count = Number(llmCalls);
      llmCalls += 1;
      const message = count === 0
        ? {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "tool_call", arguments: JSON.stringify({ name: "mcp:docs/ping", arguments: { text: "hi" } }) },
            }],
          }
        : { role: "assistant", content: "done" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await once(llm.listen(0, "127.0.0.1"), "listening");
  const llmAddress = llm.address();
  if (!llmAddress || typeof llmAddress === "string") throw new Error("llm did not bind");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./native-acp.js", import.meta.url))], {
    env: {
      ...process.env,
      HERMES_HOME: root,
      OPENAI_API_KEY: "stub-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${llmAddress.port}/v1`,
      OCP_DEFAULT_MODEL: "stub-model",
      OPENROUTER_API_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const lines: string[] = [];
  const rl = createInterface({ input: child.stdout });
  const pending: Array<(line: string) => void> = [];
  rl.on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  const nextLine = (): Promise<string> => {
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => pending.push(resolve));
  };
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    assert.match(await nextLine(), /"id":1/);
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {
        cwd: workspace,
        mcpServers: [
          {
            name: "opencodingpartner-workspace",
            command: process.execPath,
            args: [fileURLToPath(new URL("./workspace-mcp.js", import.meta.url)), workspace],
            env: [{ name: "OCP_EXTERNAL_MCP", value: JSON.stringify([{ name: "docs", url: mock.url, headers: { Authorization: `Bearer ${SECRET}` } }]) }],
          },
          { name: "docs", url: mock.url, headers: { Authorization: `Bearer ${SECRET}` } },
        ],
      },
    });
    const created = JSON.parse(await nextLine()) as { result?: { sessionId?: string } };
    const sessionId = created.result?.sessionId ?? "";
    assert.ok(sessionId);
    send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "ping the connector" }] } });
    let permissionId: number | undefined;
    let promptResult = "";
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !promptResult) {
      const line = await nextLine();
      if (line.includes("session/request_permission")) {
        const message = JSON.parse(line) as { id?: number };
        permissionId = message.id;
        assert.match(line, /Allow external MCP tool mcp:docs\/ping/);
        assert.equal(mock.calls(), 0);
        assert.doesNotMatch(line, new RegExp(SECRET));
        send({ jsonrpc: "2.0", id: permissionId, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
      } else if (line.includes("\"id\":3")) {
        promptResult = line;
      }
    }
    assert.match(promptResult, /end_turn/);
    assert.equal(mock.calls(), 1);
    const sessionFile = await readFile(path.join(root, "sessions", `${sessionId}.json`), "utf8");
    assert.doesNotMatch(sessionFile, new RegExp(SECRET));
    assert.doesNotMatch(sessionFile, /Authorization/);
  } finally {
    child.kill();
    rl.close();
    llm.close();
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace discovery searches, describes, and calls an attached connector", async () => {
  const workspace = await tempDir("ocp-ws-mcp-");
  const mock = await startMockMcp(SECRET);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./workspace-mcp.js", import.meta.url)), workspace], {
    env: {
      ...process.env,
      OCP_EXTERNAL_MCP: JSON.stringify([{ name: "docs", url: mock.url, headers: { Authorization: `Bearer ${SECRET}` } }]),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout! });
  const pending = new Map<number, (line: string) => void>();
  rl.on("line", (line) => {
    try {
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === "number") pending.get(message.id)?.(line);
    } catch {
      // ignore
    }
  });
  const rpc = (id: number, method: string, params: unknown) => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 8_000);
    pending.set(id, (line) => {
      clearTimeout(timer);
      resolve(line);
    });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    const searched = await rpc(2, "tools/call", { name: "tool_search", arguments: { query: "pong" } });
    assert.match(searched, /mcp:docs\/ping/);
    const described = await rpc(3, "tools/call", { name: "tool_describe", arguments: { names: ["mcp:docs/ping"] } });
    assert.match(described, /inputSchema/);
    assert.match(described, /Reply pong/);
    const called = await rpc(4, "tools/call", { name: "tool_call", arguments: { name: "mcp:docs/ping", arguments: { text: "hi" } } });
    assert.match(called, /pong:hi/);
    assert.equal(mock.calls(), 1);
  } finally {
    child.kill();
    rl.close();
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool search reports a dead connector instead of skipping it", async () => {
  const workspace = await tempDir("ocp-ws-down-");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./workspace-mcp.js", import.meta.url)), workspace], {
    env: { ...process.env, OCP_EXTERNAL_MCP: JSON.stringify([{ name: "gone", url: "http://127.0.0.1:9/mcp" }]) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout! });
  try {
    const got = once(rl, "line");
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tool_search", arguments: { query: "workspace_read" } } })}\n`);
    const line = String((await got)[0]);
    assert.match(line, /is down/);
    assert.match(line, /"isError":true/);
    assert.match(line, /gone/);
  } finally {
    child.kill();
    rl.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
