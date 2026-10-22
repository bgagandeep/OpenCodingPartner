import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { layoutCachedPrompt } from "./prompt-cache.js";
import {
  RETRIEVAL_REPLAY_QUERY,
  replayRetrievalTokens,
  retrieveWorkspaceSnippets,
  workspaceMemoryFile,
} from "./retrieval.js";

const distDir = path.dirname(fileURLToPath(import.meta.url));
const FILLER = "Warehouse aisle inventory count remains steady across the morning shift. ";

test("the fixed retrieval replay returns top snippets instead of the whole corpus", () => {
  const replay = replayRetrievalTokens();
  process.stdout.write(`REPLAY_RETRIEVAL_BEFORE_ESTIMATED_TOKENS=${replay.beforeEstimated}\nREPLAY_RETRIEVAL_AFTER_ESTIMATED_TOKENS=${replay.afterEstimated}\n`);
  assert.equal(replay.beforeEstimated, 5502);
  assert.equal(replay.afterEstimated, 120);
  assert.match(replay.formatted, /local hashed n-gram index \(not a neural model\)/);
  assert.match(replay.formatted, /packages\/product\/src\/server\.ts:12/);
  assert.match(replay.formatted, /Error: workspace_patch failed in packages\/product\/src\/server\.ts: hunk did not match\./);
  assert.match(replay.formatted, /Decision: replies stay drafts until a person sends them\./);
  assert.match(replay.formatted, /Decision: keep the draft reply in the app\./);
  assert.doesNotMatch(replay.formatted, /Warehouse aisle/);
  assert.deepEqual(replay.hits.map((hit) => hit.source).sort(), ["history", "memory", "repo"]);

  const laid = layoutCachedPrompt({
    system: "You are OCP Agent.",
    toolIndex: "workspace_read",
    pinned: "Fact: The app binds to loopback only.",
    summary: "Earlier summary.",
    retrieved: replay.formatted,
    recent: [{ role: "user", content: RETRIEVAL_REPLAY_QUERY }],
    model: "anthropic/claude-sonnet-4",
  });
  const marker = laid.messages.findIndex((message) => Array.isArray(message.content));
  const retrievedAt = laid.messages.findIndex((message) => typeof message.content === "string" && message.content.includes("hashed n-gram"));
  const userAt = laid.messages.findIndex((message) => message.content === RETRIEVAL_REPLAY_QUERY);
  assert.ok(marker >= 0);
  assert.ok(retrievedAt > marker);
  assert.ok(userAt > retrievedAt);
  const plain = layoutCachedPrompt({
    system: "You are OCP Agent.",
    toolIndex: "workspace_read",
    pinned: "",
    summary: "",
    retrieved: "",
    recent: [{ role: "user", content: "hello" }],
    model: "openai/gpt-4.1",
  });
  assert.equal(plain.messages.some((message) => typeof message.content === "string" && message.content.includes("hashed n-gram")), false);
  assert.equal(plain.messages.at(-1)?.content, "hello");
});

test("workspace retrieval reads the repo, memory, and history and skips a secret file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-retrieve-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "packages/product/src"), { recursive: true });
  await mkdir(path.join(workspace, "notes"), { recursive: true });
  await writeFile(
    path.join(workspace, "packages/product/src/server.ts"),
    "Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match.\nThe hunk mismatch is in packages/product/src/server.ts.\n",
    "utf8",
  );
  await writeFile(path.join(workspace, "notes/aisle.txt"), FILLER.repeat(40), "utf8");
  await writeFile(path.join(workspace, "keys.ts"), "const api_key = sk-live-secret-value;\nThe hunk mismatch is in packages/product/src/server.ts.\n", "utf8");
  const memory = await workspaceMemoryFile(root, workspace);
  await mkdir(path.dirname(memory), { recursive: true });
  await writeFile(memory, "- [2026-10-22] Decision: replies stay drafts until a person sends them.\n", "utf8");
  await writeFile(path.join(root, "state.json"), `${JSON.stringify({
    bots: [{ id: "ada", name: "Ada", workspace }],
    tasks: [{
      id: "9",
      botId: "ada",
      prompt: "Edit the draft reply.",
      result: "Decision: keep the draft reply in the app.",
      error: "Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match.",
    }],
  })}\n`);
  try {
    const formatted = await retrieveWorkspaceSnippets({ workspace, dataDir: root, query: RETRIEVAL_REPLAY_QUERY });
    assert.match(formatted, /hashed n-gram index \(not a neural model\)/);
    assert.match(formatted, /workspace_patch failed/);
    assert.match(formatted, /Decision: replies stay drafts until a person sends them/);
    assert.match(formatted, /keep the draft reply in the app/);
    assert.doesNotMatch(formatted, /Warehouse aisle/);
    assert.doesNotMatch(formatted, /sk-live-secret-value/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a local stub model receives retrieved snippets and not the rest of the repo", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-retrieve-acp-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "packages/product/src"), { recursive: true });
  await mkdir(path.join(workspace, "notes"), { recursive: true });
  await writeFile(
    path.join(workspace, "packages/product/src/server.ts"),
    "Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match.\nThe hunk mismatch is in packages/product/src/server.ts.\n",
    "utf8",
  );
  await writeFile(path.join(workspace, "notes/aisle.txt"), FILLER.repeat(40), "utf8");
  const memory = await workspaceMemoryFile(root, workspace);
  await mkdir(path.dirname(memory), { recursive: true });
  await writeFile(memory, "- [2026-10-22] Decision: replies stay drafts until a person sends them.\n", "utf8");
  await writeFile(path.join(root, "state.json"), `${JSON.stringify({
    bots: [{ id: "ada", name: "Ada", workspace }],
    tasks: [{
      id: "9",
      botId: "ada",
      error: "Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match.",
      result: "Decision: keep the draft reply in the app.",
      prompt: "Edit the draft reply.",
    }],
  })}\n`);
  const seen: string[] = [];
  const llm = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Using the retrieved snippets." } }] }));
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
    const message = JSON.parse(line) as Record<string, unknown>;
    if (typeof message.id === "number") pending.get(message.id)?.(message);
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
    const created = await rpc("session/new", { cwd: workspace, mcpServers: [] });
    const sessionId = (created.result as { sessionId?: string } | undefined)?.sessionId;
    assert.ok(sessionId);
    const prompt = await rpc("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: RETRIEVAL_REPLAY_QUERY }],
    });
    assert.equal((prompt.result as { stopReason?: string } | undefined)?.stopReason, "end_turn");
    const body = seen.find((item) => !item.includes("Summarize earlier coding turns.") && !item.includes("Classify this user turn for OCP.")) ?? "";
    assert.match(body, /hashed n-gram index \(not a neural model\)/);
    assert.match(body, /workspace_patch failed/);
    assert.match(body, /Decision: replies stay drafts until a person sends them/);
    assert.match(body, /keep the draft reply in the app/);
    assert.doesNotMatch(body, /Warehouse aisle/);
    const saved = JSON.parse(await readFile(path.join(root, "sessions", `${sessionId}.json`), "utf8")) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    assert.equal(saved.messages?.some((message) => message.content?.includes("Warehouse aisle")), false);
  } finally {
    rl.close();
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    llm.close();
    await rm(root, { recursive: true, force: true });
  }
});
