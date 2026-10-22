import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startProductApp } from "./server.js";
import {
  costForUsage,
  measureUsage,
  noteModelUsage,
  normalizeModelPrices,
  readUsageCalls,
  usageCapReason,
  usageProviderKind,
  usageSnapshot,
} from "./usage.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ocp-usage-"));
}

test("provider usage is recorded as given and a missing usage field is estimated", () => {
  const measured = measureUsage(
    { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } },
    "ignored",
    "ignored",
  );
  assert.equal(measured.estimated, false);
  assert.equal(measured.promptTokens, 11);
  assert.equal(measured.completionTokens, 7);
  assert.equal(measured.cachedPromptTokens, 4);

  const estimated = measureUsage(undefined, "hello", "yo");
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.promptTokens, Math.ceil("hello".length / 4));
  assert.equal(estimated.completionTokens, Math.ceil("yo".length / 4));
  assert.equal(estimated.cachedPromptTokens, undefined);
});

test("cost uses an entered price, local defaults to zero, and OpenRouter stays unpriced", () => {
  const prices = normalizeModelPrices([{ model: "openai/gpt-test", inputPerMillion: 2, outputPerMillion: 8 }]);
  const priced = costForUsage("openrouter", "openai/gpt-test", 1_000, 500, prices);
  assert.equal(priced.costBasis, "entered");
  assert.equal(priced.costUsd, 0.006);

  const local = costForUsage("local", "stub-model", 100, 20, []);
  assert.equal(local.costBasis, "local-default");
  assert.equal(local.costUsd, 0);

  const open = costForUsage("openrouter", "openai/gpt-test", 100, 20, []);
  assert.equal(open.costUsd, undefined);
  assert.equal(open.costBasis, undefined);
  assert.equal(usageProviderKind("custom", "http://127.0.0.1:9/v1"), "local");
  assert.equal(usageProviderKind("openrouter", "http://127.0.0.1:9/v1"), "openrouter");
});

test("a token cap counts estimated tokens and a cost cap ignores calls with no price", async () => {
  const root = await tempRoot();
  try {
    await noteModelUsage(root, {
      botId: "bot-a",
      taskId: "task-1",
      model: "openai/gpt-test",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      usage: undefined,
      promptText: "abcd",
      completionText: "abcd",
    });
    const calls = await readUsageCalls(root);
    assert.equal(calls[0]?.estimated, true);
    assert.equal(calls[0]?.costUsd, undefined);
    await writeFile(path.join(root, "settings.json"), `${JSON.stringify({
      usageCaps: { perDay: { maxTokens: 1, maxCostUsd: 0.01 }, perBot: [] },
    })}\n`);
    const reason = await usageCapReason(root, "bot-a");
    assert.match(reason ?? "", /Usage cap reached/);
    assert.match(reason ?? "", /estimated/);
    assert.doesNotMatch(reason ?? "", /known cost/);

    await writeFile(path.join(root, "settings.json"), `${JSON.stringify({
      modelPrices: [{ model: "openai/gpt-test", inputPerMillion: 3, outputPerMillion: 9 }],
      usageCaps: { perBot: [{ botId: "bot-a", maxCostUsd: 0.0001 }], perDay: { maxTokens: 100000 } },
    })}\n`);
    await noteModelUsage(root, {
      botId: "bot-a",
      model: "openai/gpt-test",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      usage: { prompt_tokens: 1000, completion_tokens: 0 },
      promptText: "",
      completionText: "",
    });
    const pricedReason = await usageCapReason(root, "bot-a");
    assert.match(pricedReason ?? "", /known cost/);
    assert.match(pricedReason ?? "", /\$0\.003/);
    const snapshot = await usageSnapshot(root);
    assert.equal(snapshot.byBot[0]?.unpricedCalls, 1);
    assert.equal(snapshot.byBot[0]?.enteredCostUsd, 0.003);
    assert.equal(snapshot.today.calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the usage panel keeps provider tokens, prices, and a cap pause separate from Credits", async () => {
  const root = await tempRoot();
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  let llmCalls = 0;
  const llm = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      llmCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_write",
              type: "function",
              function: { name: "workspace_write", arguments: JSON.stringify({ path: "note.txt", content: "hello from the meter" }) },
            }],
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }));
    });
  });
  await once(llm.listen(0, "127.0.0.1"), "listening");
  const address = llm.address();
  if (!address || typeof address === "string") throw new Error("stub model did not bind");
  const app = await startProductApp({
    root,
    port: 0,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      HERMES_HOME: root,
      OCP_DATA_DIR: root,
      OPENAI_API_KEY: "stub-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OCP_DEFAULT_MODEL: "stub-model",
    },
  });
  try {
    const html = await (await fetch(app.url)).text();
    assert.match(html, /data-tab="usage"/);
    assert.match(html, /data-tab="credits"/);
    assert.match(html, /no price entered/);
    assert.match(html, /local at \$0 default/);
    assert.match(html, /OCP does not invent prices/);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec((await fetch(app.url)).headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const botRes = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada", role: "coding", runtime: "ocp-agent", isolation: "host", workspace, instructions: "Write the note." }),
    });
    assert.equal(botRes.status, 201);
    const { bot } = await botRes.json() as { bot: { id: string } };
    const priced = await fetch(`${app.url}/api/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        modelPrices: [{ model: "openai/gpt-test", inputPerMillion: 2, outputPerMillion: 8 }],
      }),
    });
    assert.equal(priced.status, 200);
    await noteModelUsage(root, {
      botId: "priced-bot",
      model: "openai/gpt-test",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
      promptText: "",
      completionText: "",
    });
    const before = await (await fetch(`${app.url}/api/state`)).json() as {
      usage: { byBot: Array<{ key: string; enteredCostUsd?: number }> };
      modelPrices: Array<{ model: string }>;
    };
    assert.equal(before.usage.byBot.find((item) => item.key === "priced-bot")?.enteredCostUsd, 0.006);
    assert.equal(before.modelPrices[0]?.model, "openai/gpt-test");
    assert.doesNotMatch(JSON.stringify(before), /stub-key/);
    const capped = await fetch(`${app.url}/api/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ usageCaps: { perBot: [{ botId: bot.id, maxTokens: 1 }] } }),
    });
    assert.equal(capped.status, 200);

    const taskRes = await fetch(`${app.url}/api/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: bot.id, prompt: "Create note.txt" }),
    });
    assert.equal(taskRes.status, 202);
    const writeApproval = await waitForApproval(app.url, /workspace_write/);
    const always = await fetch(`${app.url}/api/tasks/${writeApproval.taskId}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: writeApproval.requestId, decision: "always" }),
    });
    assert.equal(always.status, 200);
    const capApproval = await waitForApproval(app.url, /Usage cap reached/);
    const during = await (await fetch(`${app.url}/api/state`)).json() as {
      tasks: Array<{ id: string; autoApproveRemaining?: boolean; pendingApproval?: { title?: string }; events?: Array<{ title?: string }> }>;
    };
    const running = during.tasks.find((task) => task.id === capApproval.taskId);
    assert.equal(running?.autoApproveRemaining, true);
    assert.match(running?.pendingApproval?.title ?? "", /Usage cap reached/);
    assert.match(running?.pendingApproval?.title ?? "", /25 tokens/);
    assert.match((running?.events ?? []).map((event) => event.title ?? "").join("\n"), /workspace_write/);
    assert.equal(llmCalls, 1);
    const denied = await fetch(`${app.url}/api/tasks/${capApproval.taskId}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: capApproval.requestId, decision: "cancelled" }),
    });
    assert.equal(denied.status, 200);
    const finished = await waitForStatus(app.url, capApproval.taskId);
    assert.equal(finished, "needs-attention");
    assert.equal(llmCalls, 1);
    const after = await (await fetch(`${app.url}/api/state`)).json() as {
      usage: { recent: Array<{ model: string; estimated: boolean; promptTokens: number; completionTokens: number; costBasis?: string }> };
    };
    const localCall = after.usage.recent.find((call) => call.model === "stub-model");
    assert.equal(localCall?.estimated, false);
    assert.equal(localCall?.promptTokens, 20);
    assert.equal(localCall?.completionTokens, 5);
    assert.equal(localCall?.costBasis, "local-default");
  } finally {
    await app.close();
    llm.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForApproval(url: string, title: RegExp): Promise<{ taskId: string; requestId: string }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await (await fetch(`${url}/api/state`)).json() as {
      tasks: Array<{ id: string; pendingApproval?: { id: string; title?: string } }>;
    };
    const task = state.tasks.find((item) => item.pendingApproval && title.test(item.pendingApproval.title ?? ""));
    if (task?.pendingApproval) return { taskId: task.id, requestId: task.pendingApproval.id };
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`No approval matched ${title}`);
}

async function waitForStatus(url: string, taskId: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await (await fetch(`${url}/api/state`)).json() as { tasks: Array<{ id: string; status: string }> };
    const status = state.tasks.find((task) => task.id === taskId)?.status;
    if (status && status !== "running" && status !== "awaiting-approval" && status !== "queued") return status;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Task did not finish.");
}
