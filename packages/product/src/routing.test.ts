import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readUsageCalls } from "./usage.js";
import { startProductApp } from "./server.js";
import {
  formatRouteUsage,
  nextRouteStep,
  parseRouteLabel,
  routingReplayTokens,
  selectStepModel,
} from "./routing.js";

const distDir = path.dirname(fileURLToPath(import.meta.url));

test("routing sends cheap steps to the cheap model and keeps plan and edit on the strong model", () => {
  const replay = routingReplayTokens();
  process.stdout.write(`REPLAY_ROUTE_BEFORE_ESTIMATED_TOKENS=${replay.beforeEstimated}\nREPLAY_ROUTE_STRONG_ESTIMATED_TOKENS=${replay.strongEstimated}\nREPLAY_ROUTE_CHEAP_ESTIMATED_TOKENS=${replay.cheapEstimated}\n`);
  assert.equal(replay.beforeEstimated, 180);
  assert.equal(replay.strongEstimated, 35);
  assert.equal(replay.cheapEstimated, 145);

  const auto = { mode: "auto" as const, strongModel: "stub-strong", cheapModel: "stub-cheap" };
  assert.deepEqual(selectStepModel({ ...auto, step: "classify" }), { model: "stub-cheap", tier: "cheap", step: "classify", fallback: false });
  assert.deepEqual(selectStepModel({ ...auto, step: "lint-fix" }), { model: "stub-cheap", tier: "cheap", step: "lint-fix", fallback: false });
  assert.deepEqual(selectStepModel({ ...auto, step: "plan" }), { model: "stub-strong", tier: "strong", step: "plan", fallback: false });
  assert.deepEqual(selectStepModel({ ...auto, step: "edit" }), { model: "stub-strong", tier: "strong", step: "edit", fallback: false });
  assert.equal(selectStepModel({ step: "summary", mode: "auto", strongModel: "stub-strong" }).fallback, true);
  assert.equal(selectStepModel({ step: "summary", mode: "auto", strongModel: "local-model", local: true }).tier, "cheap");
  assert.equal(selectStepModel({ step: "edit", mode: "cheap", strongModel: "stub-strong", cheapModel: "stub-cheap" }).model, "stub-cheap");
  assert.equal(selectStepModel({ step: "classify", mode: "strong", strongModel: "stub-strong", cheapModel: "stub-cheap" }).model, "stub-strong");
  assert.equal(parseRouteLabel("lint-fix"), "lint-fix");
  assert.equal(nextRouteStep("answer", ["workspace_test"], ["not ok 1 - draft reply"]), "lint-fix");
  assert.equal(nextRouteStep("lint-fix", ["workspace_patch"], ["patched"]), "edit");
  assert.equal(formatRouteUsage({
    step: "edit",
    tier: "strong",
    fallback: false,
    model: "stub-strong",
    promptTokens: 11,
    completionTokens: 3,
    estimated: false,
    costUsd: 0,
    costBasis: "local-default",
  }), "edit · strong · stub-strong: 11 in / 3 out · $0 local default");
});

test("a bot can override cheap routing and the usage list names the step", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-route-ui-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const app = await startProductApp({
    root,
    port: 0,
    env: { PATH: process.env.PATH, HOME: root, HERMES_HOME: root, OCP_DATA_DIR: root },
  });
  try {
    const html = await (await fetch(app.url)).text();
    assert.match(html, /Cheap model id/);
    assert.match(html, /Auto: cheap for classify, summary, and lint-fix/);
    assert.match(html, /no cheap model configured/);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec((await fetch(app.url)).headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const created = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Ada",
        role: "coding",
        runtime: "ocp-agent",
        isolation: "host",
        workspace,
        instructions: "Route cheap steps.",
        cheapModel: "stub-cheap",
        routeMode: "auto",
      }),
    });
    assert.equal(created.status, 201);
    const { bot } = await created.json() as { bot: { id: string; cheapModel?: string; routeMode?: string } };
    assert.equal(bot.cheapModel, "stub-cheap");
    assert.equal(bot.routeMode, "auto");
    const bad = await fetch(`${app.url}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Ada", role: "coding", runtime: "ocp-agent", isolation: "host", workspace, routeMode: "sometimes" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a local stub cheap model classifies and the strong model handles the edit", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-route-acp-"));
  const seen: Array<{ model?: string; raw: string }> = [];
  const titles: string[] = [];
  const llm = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw) as { model?: string };
      seen.push({ model: body.model, raw });
      let content = "Lint noted.";
      if (raw.includes("Classify this user turn for OCP.")) content = raw.includes("Rewrite the patch") ? "edit" : "lint-fix";
      else if (raw.includes("Summarize earlier coding turns.")) content = "folded.";
      else if (body.model === "stub-strong") content = "Edit planned.";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }));
    });
  });
  await once(llm.listen(0, "127.0.0.1"), "listening");
  const address = llm.address();
  if (!address || typeof address === "string") throw new Error("stub model did not bind");
  const child = spawn(process.execPath, [path.join(distDir, "native-acp.js")], {
    cwd: root,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      HERMES_HOME: root,
      OCP_DATA_DIR: root,
      OCP_ACTOR_BOT_ID: "ada",
      OCP_CHEAP_MODEL: "stub-cheap",
      OCP_ROUTE_MODE: "auto",
      OPENAI_API_KEY: "stub-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OCP_DEFAULT_MODEL: "stub-strong",
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as { id?: number; method?: string; params?: { update?: { sessionUpdate?: string; title?: string } } };
    if (message.method === "session/update" && message.params?.update?.sessionUpdate === "usage" && message.params.update.title) {
      titles.push(message.params.update.title);
    }
    if (typeof message.id === "number") pending.get(message.id)?.(message as unknown as Record<string, unknown>);
  });
  let seq = 0;
  const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out\n${stderr}`)), 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  try {
    assert.ok((await rpc("initialize", {})).result);
    const first = await rpc("session/new", { cwd: root, mcpServers: [] });
    const firstId = (first.result as { sessionId?: string } | undefined)?.sessionId;
    assert.ok(firstId);
    const lint = await rpc("session/prompt", { sessionId: firstId, prompt: [{ type: "text", text: "Fix the failing test." }] });
    assert.equal((lint.result as { stopReason?: string } | undefined)?.stopReason, "end_turn");
    const second = await rpc("session/new", { cwd: root, mcpServers: [] });
    const secondId = (second.result as { sessionId?: string } | undefined)?.sessionId;
    assert.ok(secondId);
    const edit = await rpc("session/prompt", { sessionId: secondId, prompt: [{ type: "text", text: "Rewrite the patch in packages/product/src/server.ts." }] });
    assert.equal((edit.result as { stopReason?: string } | undefined)?.stopReason, "end_turn");
    assert.deepEqual(seen.map((call) => call.model), ["stub-cheap", "stub-cheap", "stub-cheap", "stub-strong"]);
    assert.match(titles.join("\n"), /classify · cheap · stub-cheap: 11 in \/ 3 out · \$0 local default/);
    assert.match(titles.join("\n"), /lint-fix · cheap · stub-cheap/);
    assert.match(titles.join("\n"), /edit · strong · stub-strong: 11 in \/ 3 out · \$0 local default/);
    const calls = await readUsageCalls(root);
    assert.deepEqual(calls.map((call) => `${call.step}:${call.tier}:${call.model}`), [
      "classify:cheap:stub-cheap",
      "lint-fix:cheap:stub-cheap",
      "classify:cheap:stub-cheap",
      "edit:strong:stub-strong",
    ]);
    assert.equal(calls.every((call) => call.estimated === false && call.costBasis === "local-default" && call.costUsd === 0), true);
  } finally {
    rl.close();
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    llm.close();
    await rm(root, { recursive: true, force: true });
  }
});
