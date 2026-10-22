import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatRouteUsage } from "./routing.js";
import { startProductApp } from "./server.js";
import { noteModelUsage, readUsageCalls, usageCapReason, usageSnapshot } from "./usage.js";
import {
  forgetToolResponses,
  isCacheableTool,
  lookupResponse,
  modelCacheKey,
  modelResponseIsCacheable,
  RESPONSE_CACHE_VALUE_CAP,
  responseCacheKey,
  responseCacheReplayKept,
  responseCacheReplayTokens,
  storeResponse,
  toolCacheKey,
} from "./response-cache.js";

const distDir = path.dirname(fileURLToPath(import.meta.url));
const FILE_TEXT = "Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match.\nDecision: keep the draft reply.";

test("a repeated model call and tool read count once on the fixed replay", () => {
  const counts = responseCacheReplayTokens();
  process.stdout.write(`REPLAY_RESPONSE_CACHE_BEFORE_ESTIMATED_TOKENS=${counts.beforeEstimated}\nREPLAY_RESPONSE_CACHE_AFTER_ESTIMATED_TOKENS=${counts.afterEstimated}\n`);
  assert.equal(counts.beforeEstimated, 148);
  assert.equal(counts.afterEstimated, 74);
  const kept = responseCacheReplayKept();
  assert.match(kept.model, /packages\/product\/src\/server\.ts/);
  assert.match(kept.tool, /hunk did not match/);
  assert.match(kept.tool, /Decision: keep the draft reply/);

  const readKey = toolCacheKey("workspace_read", { path: "notes.txt" });
  const reversed = responseCacheKey("tool", { name: "workspace_read", args: { path: "notes.txt" } });
  assert.equal(readKey, reversed);
  assert.equal(toolCacheKey("workspace_read", { path: "notes.txt", start: 1 }), toolCacheKey("workspace_read", { start: 1, path: "notes.txt" }));
  assert.equal(isCacheableTool("workspace_read"), true);
  assert.equal(isCacheableTool("workspace_shell"), false);
  assert.equal(isCacheableTool("workspace_test"), false);
  assert.equal(modelResponseIsCacheable([]), true);
  assert.equal(modelResponseIsCacheable(["workspace_read"]), true);
  assert.equal(modelResponseIsCacheable(["workspace_write"]), false);

  const modelKey = modelCacheKey("stub-model", [{ role: "user", content: "Read notes.txt" }], ["workspace_read"]);
  const otherTurn = modelCacheKey("stub-model", [{ role: "user", content: "Read notes.txt" }, { role: "tool", content: FILE_TEXT }], ["workspace_read"]);
  assert.notEqual(modelKey, otherTurn);
  let entries = storeResponse(undefined, "model", modelKey, "Read notes.txt");
  entries = storeResponse(entries, "tool", readKey, FILE_TEXT);
  assert.equal(lookupResponse(entries, "tool", readKey), FILE_TEXT);
  assert.equal(lookupResponse(entries, "tool", readKey), FILE_TEXT);
  entries = storeResponse(entries, "tool", toolCacheKey("workspace_read", { path: "other.txt" }), "other");
  entries = forgetToolResponses(entries);
  assert.equal(lookupResponse(entries, "tool", readKey), undefined);
  assert.equal(lookupResponse(entries, "model", modelKey), "Read notes.txt");
  const oversized = storeResponse(entries, "tool", readKey, "x".repeat(RESPONSE_CACHE_VALUE_CAP + 1));
  assert.equal(lookupResponse(oversized, "tool", readKey), undefined);
  assert.equal(formatRouteUsage({
    step: "edit",
    tier: "strong",
    fallback: false,
    model: "stub-model",
    promptTokens: 0,
    completionTokens: 0,
    estimated: false,
    costUsd: 0,
    costBasis: "session-cache",
  }), "edit · strong · stub-model: 0 in / 0 out · session cache, no provider call");
});

test("a session cache hit is zero tokens and is not a provider cache or an unpriced call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-cache-usage-"));
  try {
    await noteModelUsage(root, {
      botId: "ada",
      model: "stub-model",
      provider: "custom",
      baseUrl: "http://127.0.0.1:9/v1",
      usage: { prompt_tokens: 40, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 30 } },
      promptText: "ignored",
      completionText: "ignored",
      sessionCache: true,
      step: "edit",
      tier: "strong",
    });
    const [call] = await readUsageCalls(root);
    assert.equal(call?.promptTokens, 0);
    assert.equal(call?.completionTokens, 0);
    assert.equal(call?.estimated, false);
    assert.equal(call?.costUsd, 0);
    assert.equal(call?.costBasis, "session-cache");
    assert.equal(call?.cachedPromptTokens, undefined);
    const snapshot = await usageSnapshot(root);
    assert.equal(snapshot.byBot[0]?.sessionCacheCalls, 1);
    assert.equal(snapshot.byBot[0]?.unpricedCalls, 0);
    assert.equal(snapshot.byBot[0]?.localDefaultCalls, 0);
    assert.equal(snapshot.byBot[0]?.cachedPromptTokens, 0);
    await writeFile(path.join(root, "settings.json"), `${JSON.stringify({ usageCaps: { perBot: [{ botId: "ada", maxCostUsd: 0 }], perDay: { maxTokens: 1 } } })}\n`);
    assert.equal(await usageCapReason(root, "ada"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the usage panel labels a session cache hit as no provider call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-cache-ui-"));
  await noteModelUsage(root, {
    botId: "ada",
    model: "stub-model",
    provider: "custom",
    baseUrl: "http://127.0.0.1:9/v1",
    usage: undefined,
    promptText: "ignored",
    completionText: "ignored",
    sessionCache: true,
    step: "edit",
    tier: "strong",
  });
  const app = await startProductApp({
    root,
    port: 0,
    env: { PATH: process.env.PATH, HOME: root, HERMES_HOME: root, OCP_DATA_DIR: root },
  });
  try {
    const html = await (await fetch(app.url)).text();
    assert.match(html, /session cache, no provider call/);
    const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    const scriptPath = path.join(root, "dash.js");
    await writeFile(scriptPath, script);
    const checked = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    const state = await (await fetch(`${app.url}/api/state`)).json() as {
      usage?: { recent?: Array<{ costBasis?: string; estimated?: boolean; promptTokens?: number; cachedPromptTokens?: number }>; today?: { sessionCacheCalls?: number } };
    };
    assert.equal(state.usage?.recent?.[0]?.costBasis, "session-cache");
    assert.equal(state.usage?.recent?.[0]?.estimated, false);
    assert.equal(state.usage?.recent?.[0]?.promptTokens, 0);
    assert.equal(state.usage?.recent?.[0]?.cachedPromptTokens, undefined);
    assert.equal(state.usage?.today?.sessionCacheCalls, 1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a second identical workspace read is served from the session cache", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-cache-acp-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "notes.txt"), FILE_TEXT);
  const seen: string[] = [];
  const titles: string[] = [];
  const llm = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push(raw);
      response.writeHead(200, { "content-type": "application/json" });
      const body = JSON.parse(raw) as { messages?: Array<{ role?: string }> };
      const hasTool = (body.messages ?? []).some((message) => message.role === "tool");
      if (!hasTool) {
        response.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "read_a", type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: "notes.txt" }) } },
                { id: "read_b", type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: "notes.txt" }) } },
              ],
            },
          }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }));
        return;
      }
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Read once." } }],
        usage: { prompt_tokens: 12, completion_tokens: 2 },
      }));
    });
  });
  await once(llm.listen(0, "127.0.0.1"), "listening");
  const address = llm.address();
  if (!address || typeof address === "string") throw new Error("stub model did not bind");
  const child = spawn(process.execPath, [path.join(distDir, "native-acp.js")], {
    cwd: workspace,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      HERMES_HOME: root,
      OCP_DATA_DIR: root,
      OCP_ACTOR_BOT_ID: "ada",
      OCP_ROUTE_MODE: "strong",
      OPENAI_API_KEY: "stub-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OCP_DEFAULT_MODEL: "stub-model",
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as { id?: number; method?: string; params?: { update?: { title?: string } } };
    if (message.method === "session/update" && message.params?.update?.title) titles.push(message.params.update.title);
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
    const created = await rpc("session/new", {
      cwd: workspace,
      mcpServers: [{
        name: "opencodingpartner-workspace",
        command: process.execPath,
        args: [path.join(distDir, "workspace-mcp.js"), workspace],
        env: [{ name: "OCP_DATA_DIR", value: root }],
      }],
    });
    const sessionId = (created.result as { sessionId?: string } | undefined)?.sessionId;
    assert.ok(sessionId);
    const prompt = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Read notes.txt" }] });
    assert.equal((prompt.result as { stopReason?: string } | undefined)?.stopReason, "end_turn");
    assert.equal(seen.length, 2);
    assert.equal(titles.filter((title) => title === "session cache hit: workspace_read").length, 1);
    const followUp = seen[1] ?? "";
    assert.equal(followUp.split("hunk did not match").length - 1, 1);
    assert.match(followUp, /Unchanged notes\.txt/);
    const saved = JSON.parse(await readFile(path.join(root, "sessions", `${sessionId}.json`), "utf8")) as {
      messages?: Array<{ role?: string; content?: string | null }>;
      responseCache?: Array<{ kind?: string; value?: string }>;
    };
    const toolMessages = (saved.messages ?? []).filter((message) => message.role === "tool");
    assert.equal(toolMessages.length, 2);
    assert.match(toolMessages[0]?.content ?? "", /hunk did not match/);
    assert.match(toolMessages[1]?.content ?? "", /Unchanged notes\.txt/);
    const cachedTool = (saved.responseCache ?? []).find((entry) => entry.kind === "tool");
    assert.match(cachedTool?.value ?? "", /packages\/product\/src\/server\.ts/);
    assert.match(cachedTool?.value ?? "", /hunk did not match/);
    const calls = await readUsageCalls(root);
    assert.equal(calls.length, 2);
    assert.equal(calls.every((call) => call.costBasis === "local-default" && call.cachedPromptTokens === undefined), true);
    assert.equal(calls.some((call) => call.costBasis === "session-cache"), false);
  } finally {
    rl.close();
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    llm.close();
    await rm(root, { recursive: true, force: true });
  }
});
