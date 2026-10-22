import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startProductApp } from "./server.js";
import { normalizeModelPrices } from "./usage.js";
import {
  BIG_TASK_ESTIMATED_TOKENS,
  budgetDecision,
  budgetReplayPrompt,
  budgetReplayTokens,
  projectSpend,
  spentTotals,
} from "./budget.js";

test("the fixed budget replay pauses before the provider call", () => {
  const counts = budgetReplayTokens();
  process.stdout.write(`REPLAY_BUDGET_BEFORE_ESTIMATED_TOKENS=${counts.beforeEstimated}\nREPLAY_BUDGET_AFTER_ESTIMATED_TOKENS=${counts.afterEstimated}\n`);
  assert.equal(counts.beforeEstimated, 495);
  assert.equal(counts.afterEstimated, 0);
  assert.ok(counts.beforeEstimated >= BIG_TASK_ESTIMATED_TOKENS);
  const prompt = budgetReplayPrompt();
  assert.match(prompt, /packages\/product\/src\/server\.ts/);
  assert.match(prompt, /hunk did not match/);
  assert.match(prompt, /Decision: keep the draft reply/);

  const local = projectSpend({ promptText: prompt, model: "stub-model", provider: "local", prices: [] });
  assert.equal(local.estimated, true);
  assert.equal(local.estimatedInputTokens, 495);
  assert.match(local.label, /estimated 495 input tokens/);
  assert.match(local.label, /\$0 local default/);
  assert.match(local.label, /Output tokens are not included/);
  assert.doesNotMatch(local.label, /from entered prices/);

  const prices = normalizeModelPrices([{ model: "openai/gpt-test", inputPerMillion: 2, outputPerMillion: 8 }]);
  const priced = projectSpend({ promptText: "abcd", model: "openai/gpt-test", provider: "openrouter", prices });
  assert.equal(priced.estimated, true);
  assert.equal(priced.costBasis, "entered");
  assert.equal(priced.costUsd, 0.000002);
  assert.match(priced.label, /\$0\.000002 from entered prices on estimated tokens/);

  const open = projectSpend({ promptText: "abcd", model: "openai/gpt-test", provider: "openrouter", prices: [] });
  assert.equal(open.costUsd, undefined);
  assert.match(open.label, /no price entered/);
  assert.doesNotMatch(open.label, /\$/);

  const hard = budgetDecision({
    projection: local,
    includeProjection: true,
    scopes: [{ name: "This bot", cap: { hardMaxTokens: 1, softMaxTokens: 1 }, ...spentTotals([]) }],
  });
  assert.equal(hard.stop, "hard");
  assert.match(hard.reason ?? "", /Hard usage cap reached/);
  assert.match(hard.reason ?? "", /495 estimated/);
  assert.match(hard.reason ?? "", /Projected next call: estimated 495 input tokens/);
  assert.doesNotMatch(hard.reason ?? "", /Continue this task/);

  const soft = budgetDecision({
    projection: local,
    includeProjection: true,
    scopes: [{ name: "This bot", cap: { softMaxTokens: 1 }, ...spentTotals([]) }],
  });
  assert.equal(soft.stop, "soft");
  assert.match(soft.reason ?? "", /Continue this task, or leave it paused/);

  const zeroCost = budgetDecision({
    projection: local,
    includeProjection: true,
    scopes: [{ name: "This bot", cap: { hardMaxCostUsd: 0 }, ...spentTotals([]) }],
  });
  assert.equal(zeroCost.stop, "ok");

  const unpricedCost = budgetDecision({
    projection: open,
    includeProjection: true,
    scopes: [{ name: "This bot", cap: { hardMaxCostUsd: 0.01 }, ...spentTotals([]) }],
  });
  assert.equal(unpricedCost.stop, "ok");

  const pricedHard = budgetDecision({
    projection: priced,
    includeProjection: true,
    scopes: [{ name: "This bot", cap: { hardMaxCostUsd: 0.000001 }, ...spentTotals([]) }],
  });
  assert.equal(pricedHard.stop, "hard");
  assert.match(pricedHard.reason ?? "", /on estimated tokens/);
  assert.match(pricedHard.reason ?? "", /\$0\.000002/);
});

test("a hard cap pauses with no continue and cheap mode is a route toggle", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-budget-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  let llmCalls = 0;
  const llm = createServer((_request, response) => {
    llmCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Noted." } }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    }));
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
    assert.match(html, /Cheap mode/);
    assert.match(html, /usage-hard-cap/);
    assert.match(html, /A hard cap pauses and does not offer continue/);
    const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    const scriptPath = path.join(root, "dash.js");
    await writeFile(scriptPath, script);
    const checked = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec((await fetch(app.url)).headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const botRes = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada", role: "coding", runtime: "ocp-agent", isolation: "host", workspace, instructions: "Stay inside the workspace.", cheapModel: "stub-cheap", routeMode: "auto" }),
    });
    assert.equal(botRes.status, 201);
    const { bot } = await botRes.json() as { bot: { id: string; routeMode?: string } };
    const cheap = await fetch(`${app.url}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ routeMode: "cheap" }),
    });
    assert.equal(cheap.status, 200);
    const cheapState = await (await fetch(`${app.url}/api/state`)).json() as { bots: Array<{ id: string; routeMode?: string }> };
    assert.equal(cheapState.bots.find((item) => item.id === bot.id)?.routeMode, "cheap");
    const auto = await fetch(`${app.url}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ routeMode: "auto" }),
    });
    assert.equal(auto.status, 200);

    const capped = await fetch(`${app.url}/api/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ usageCaps: { perBot: [{ botId: bot.id, hardMaxTokens: 1 }] } }),
    });
    assert.equal(capped.status, 200);
    const taskRes = await fetch(`${app.url}/api/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: bot.id, prompt: budgetReplayPrompt() }),
    });
    assert.equal(taskRes.status, 202);
    const hardApproval = await waitForApproval(app.url, /Hard usage cap reached/);
    const during = await (await fetch(`${app.url}/api/state`)).json() as {
      tasks: Array<{ id: string; pendingApproval?: { title?: string; subject?: { kind?: string } }; events?: Array<{ title?: string }> }>;
      usageCaps?: { perBot?: Array<{ hardMaxTokens?: number }> };
    };
    const pending = during.tasks.find((task) => task.id === hardApproval.taskId)?.pendingApproval;
    assert.equal(pending?.subject?.kind, "usage-hard-cap");
    assert.match(pending?.title ?? "", /estimated \d+ input tokens/);
    assert.match(pending?.title ?? "", /\$0 local default/);
    assert.doesNotMatch(pending?.title ?? "", /Continue this task/);
    assert.equal(during.usageCaps?.perBot?.[0]?.hardMaxTokens, 1);
    assert.equal(llmCalls, 0);
    const continued = await fetch(`${app.url}/api/tasks/${hardApproval.taskId}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: hardApproval.requestId, decision: "allow-once" }),
    });
    assert.equal(continued.status, 400);
    const denied = await fetch(`${app.url}/api/tasks/${hardApproval.taskId}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: hardApproval.requestId, decision: "cancelled" }),
    });
    assert.equal(denied.status, 200);
    assert.equal(await waitForStatus(app.url, hardApproval.taskId), "needs-attention");
    assert.equal(llmCalls, 0);

    const softened = await fetch(`${app.url}/api/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ usageCaps: { perBot: [{ botId: bot.id, softMaxTokens: 1 }] } }),
    });
    assert.equal(softened.status, 200);
    const softTask = await fetch(`${app.url}/api/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: bot.id, prompt: "Create note.txt" }),
    });
    assert.equal(softTask.status, 202);
    const softApproval = await waitForApproval(app.url, /Soft usage cap reached/);
    const softPending = (await (await fetch(`${app.url}/api/state`)).json() as {
      tasks: Array<{ id: string; pendingApproval?: { title?: string; subject?: { kind?: string } } }>;
    }).tasks.find((task) => task.id === softApproval.taskId)?.pendingApproval;
    assert.equal(softPending?.subject?.kind, "usage-cap");
    assert.match(softPending?.title ?? "", /estimated \d+ input tokens/);
    assert.match(softPending?.title ?? "", /Continue this task, or leave it paused/);
    const allowed = await fetch(`${app.url}/api/tasks/${softApproval.taskId}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: softApproval.requestId, decision: "allow-once" }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(await waitForStatus(app.url, softApproval.taskId), "succeeded");
    assert.ok(llmCalls > 0);
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
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await (await fetch(`${url}/api/state`)).json() as { tasks: Array<{ id: string; status: string }> };
    const status = state.tasks.find((task) => task.id === taskId)?.status;
    if (status && !["running", "queued", "awaiting-approval"].includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Task ${taskId} did not finish`);
}
