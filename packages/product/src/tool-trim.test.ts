import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  pageStoredToolOutput,
  presentToolOutput,
  replayTrimmedToolOutputs,
  storeToolOutput,
  TOOL_REPLAY_PATH,
  toolReplayFile,
  trimToolOutput,
} from "./tool-trim.js";

const distDir = path.dirname(fileURLToPath(import.meta.url));

test("the fixed tool replay keeps paths and failures and drops repeated output", async () => {
  const counts = replayTrimmedToolOutputs();
  process.stdout.write(`REPLAY_TRIM_BEFORE_ESTIMATED_TOKENS=${counts.beforeEstimated}\nREPLAY_TRIM_AFTER_ESTIMATED_TOKENS=${counts.afterEstimated}\n`);
  assert.equal(counts.beforeEstimated, 1788);
  assert.equal(counts.afterEstimated, 418);
  assert.equal(counts.displays.length, 4);
  const [first, second, third, tests] = counts.displays;
  assert.match(first ?? "", new RegExp(`^${TOOL_REPLAY_PATH}\nA{400}`));
  assert.match(first ?? "", /Retrieve with tool_output_read handle toolout:replay01/);
  assert.match(first ?? "", /B{400}$/);
  assert.doesNotMatch(first ?? "", /hunk did not match/);
  assert.match(counts.fulls[0] ?? "", /hunk did not match/);
  assert.match(counts.fulls[0] ?? "", /packages\/product\/src\/server\.ts/);
  assert.match(second ?? "", /^Unchanged packages\/product\/src\/server\.ts \(toolout:replay01, omitted \d+ characters\)\.$/);
  assert.doesNotMatch(second ?? "", /hunk did not match/);
  assert.match(third ?? "", /Changed packages\/product\/src\/server\.ts/);
  assert.match(third ?? "", /\+Error: workspace_patch failed in packages\/product\/src\/server\.ts: hunk did not match\. Decision: keep the draft reply in the app\./);
  assert.match(third ?? "", /Full text: toolout:replay03/);
  assert.doesNotMatch(third ?? "", /A{400}/);
  assert.match(tests ?? "", /Tests: 81 total, 80 passed, 1 failed, 0 skipped\./);
  assert.match(tests ?? "", /not ok 81 - draft reply/);
  assert.match(tests ?? "", /packages\/product\/src\/server\.ts:12:1/);
  assert.match(tests ?? "", /Full log: toolout:replay04/);
  assert.doesNotMatch(tests ?? "", /ok 1 - draft check/);
  assert.doesNotMatch(tests ?? "", /^ok /m);

  const tap = [
    "TAP version 13",
    "ok 1 - kept",
    "not ok 2 - boom",
    "  location: 'packages/product/src/server.ts:3:1'",
    "# tests 2",
    "# pass 1",
    "# fail 1",
  ].join("\n");
  const wrapped = trimToolOutput({
    toolName: "workspace_test",
    args: {},
    text: JSON.stringify({ ok: false, detail: "Command exited 1: node --test", code: 1, stdout: tap, stderr: "" }, null, 2),
    id: "jsont01",
  });
  assert.match(wrapped.display, /1 failed/);
  assert.match(wrapped.display, /packages\/product\/src\/server\.ts:3:1/);
  assert.doesNotMatch(wrapped.display, /ok 1 - kept/);
  const shell = trimToolOutput({
    toolName: "workspace_shell",
    args: { argv: ["node", "--test"] },
    text: tap,
    id: "shell01",
  });
  assert.match(shell.display, /not ok 2 - boom/);
  assert.doesNotMatch(shell.display, /ok 1 - kept/);
  const small = trimToolOutput({ toolName: "workspace_grep", args: { query: "draft" }, text: "short", id: "small01" });
  assert.equal(small.display, "short");
  assert.equal(small.store, false);
});

test("stored tool output is paged by handle and repeated reads collapse", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-trim-"));
  try {
    const file = toolReplayFile("same");
    const first = await presentToolOutput({
      dataDir: root,
      toolName: "workspace_read",
      args: { path: TOOL_REPLAY_PATH },
      text: file,
      reads: [],
      id: "replay01",
    });
    assert.match(first.display, /toolout:replay01/);
    assert.doesNotMatch(first.display, /hunk did not match/);
    const again = await presentToolOutput({
      dataDir: root,
      toolName: "workspace_read",
      args: { path: TOOL_REPLAY_PATH },
      text: file,
      reads: first.reads,
      id: "replay02",
    });
    assert.match(again.display, /Unchanged packages\/product\/src\/server\.ts \(toolout:replay01/);
    const changed = await presentToolOutput({
      dataDir: root,
      toolName: "workspace_read",
      args: { path: TOOL_REPLAY_PATH },
      text: toolReplayFile("changed"),
      reads: again.reads,
      id: "replay03",
    });
    assert.match(changed.display, /Decision: keep the draft reply in the app/);
    assert.match(changed.display, /toolout:replay03/);
    const page = await pageStoredToolOutput(root, "toolout:replay01");
    assert.match(page ?? "", /hunk did not match/);
    assert.match(page ?? "", /offset 0 length/);
    await storeToolOutput(root, "toolout:abcdef", "hello");
    const info = await stat(path.join(root, "tool-outputs", "abcdef"));
    assert.equal(info.mode & 0o777, 0o600);
    const middle = await pageStoredToolOutput(root, "abcdef", 1, 2);
    assert.match(middle ?? "", /offset 1 length 2 of 5\.\nel/);
    const past = await pageStoredToolOutput(root, "toolout:abcdef", 20, 4);
    assert.match(past ?? "", /past the end/);
    assert.equal(await pageStoredToolOutput(root, "toolout:../secret"), undefined);
    assert.equal(await pageStoredToolOutput(root, "toolout:NOPE01"), undefined);
    assert.equal(await pageStoredToolOutput(root, "toolout:missing"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a local stub model sees the trimmed read and can retrieve the middle", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-trim-acp-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "packages/product/src"), { recursive: true });
  await writeFile(path.join(workspace, TOOL_REPLAY_PATH), toolReplayFile("same"), "utf8");
  const seen: string[] = [];
  const llm = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push(raw);
      response.writeHead(200, { "content-type": "application/json" });
      if (raw.includes("Summarize earlier coding turns.")) {
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "folded." } }] }));
        return;
      }
      const body = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: unknown }> };
      const lastTool = [...(body.messages ?? [])].reverse().find((message) => message.role === "tool");
      const toolText = typeof lastTool?.content === "string" ? lastTool.content : "";
      if (!lastTool) {
        response.end(JSON.stringify(toolCall("call_read", "workspace_read", { path: TOOL_REPLAY_PATH })));
        return;
      }
      const handle = /toolout:[a-z0-9]+/.exec(toolText)?.[0];
      if (handle && !toolText.includes("offset ")) {
        response.end(JSON.stringify(toolCall("call_page", "tool_output_read", { handle })));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Retrieved the stored output." } }] }));
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
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const pending = new Map<number, { resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as Record<string, unknown>;
    if (typeof message.id === "number" && pending.has(message.id)) {
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    }
  });
  let seq = 0;
  const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out\n${stderr}`)), 15_000);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  try {
    const init = await rpc("initialize", {});
    assert.ok(init.result);
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
    const prompt = await rpc("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Read the server file." }],
    });
    assert.equal((prompt.result as { stopReason?: string } | undefined)?.stopReason, "end_turn");
    const modelCalls = seen.filter((body) => !body.includes("Summarize earlier coding turns."));
    assert.equal(modelCalls.length, 3);
    assert.doesNotMatch(modelCalls[1] ?? "", /hunk did not match/);
    assert.match(modelCalls[1] ?? "", /toolout:[a-z0-9]+/);
    assert.doesNotMatch(modelCalls[1] ?? "", /A{800}/);
    assert.match(modelCalls[2] ?? "", /hunk did not match/);
    const saved = JSON.parse(await readFile(path.join(root, "sessions", `${sessionId}.json`), "utf8")) as {
      reads?: Array<{ path?: string; handle?: string }>;
      messages?: Array<{ role?: string; content?: string }>;
    };
    assert.equal(saved.reads?.[0]?.path, TOOL_REPLAY_PATH);
    assert.match(saved.reads?.[0]?.handle ?? "", /^toolout:[a-z0-9]+$/);
    const toolMessages = (saved.messages ?? []).filter((message) => message.role === "tool");
    assert.doesNotMatch(toolMessages[0]?.content ?? "", /hunk did not match/);
    assert.match(toolMessages[1]?.content ?? "", /hunk did not match/);
    assert.match(toolMessages[1]?.content ?? "", /offset 0 length/);
  } finally {
    rl.close();
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    llm.close();
    await rm(root, { recursive: true, force: true });
  }
});

function toolCall(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}
