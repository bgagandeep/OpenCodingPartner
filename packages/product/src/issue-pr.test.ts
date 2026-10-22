import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startProductApp } from "./server.js";

const GITHUB_TOKEN = "github-token-secret-!@#";
const LINEAR_TOKEN = "linear-token-secret-!@#";

interface Hit { method: string; url: string; body: string; auth: string }

function startMock(): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = req.url ?? "/";
    const auth = String(req.headers.authorization ?? "");
    hits.push({ method: req.method ?? "GET", url, body, auth });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (auth !== `Bearer ${GITHUB_TOKEN}` && auth !== `Bearer ${LINEAR_TOKEN}`) return json(401, { message: "bad token" });
    if (req.method === "GET" && url === "/repos/acme/app/issues/12") return json(200, { number: 12, title: "Fix the invoice total", body: "The total drops cents." });
    if (req.method === "POST" && url === "/graphql") {
      return json(200, { data: { searchIssues: { nodes: [{ identifier: "TEAM-12", title: "Linear invoice", description: "From Linear." }] } } });
    }
    if (req.method === "POST" && url === "/repos/acme/app/pulls") return json(201, { html_url: "http://127.0.0.1/pull/12" });
    if (req.method === "POST" && url === "/repos/acme/fail/pulls") return json(422, { message: "head missing" });
    json(404, { message: "missing" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("mock did not bind");
      resolve({ url: `http://127.0.0.1:${address.port}`, hits, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test("an issue becomes a task and a person opens the pull request without a merge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-issue-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-issue-ws-"));
  const mock = await startMock();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    HERMES_HOME: root,
    OCP_DATA_DIR: root,
    OCP_VAULT_BACKEND: "file",
    OCP_GITHUB_API_URL: mock.url,
    OCP_LINEAR_API_URL: `${mock.url}/graphql`,
  };
  await writeFile(path.join(workspace, "pass.test.mjs"), "import assert from 'node:assert/strict';\nassert.equal(1 + 1, 2);\n");
  spawnSync("git", ["init"], { cwd: workspace });
  const app = await startProductApp({ root, port: 0, env });
  try {
    const html = await (await fetch(app.url)).text();
    assert.match(html, /Issue to PR/);
    assert.match(html, /Merging stays with a person/);
    const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    await writeFile(path.join(root, "dash.js"), script);
    const checked = spawnSync(process.execPath, ["--check", path.join(root, "dash.js")], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec((await fetch(app.url)).headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const botRes = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada", role: "coding", runtime: "ocp-agent", isolation: "host", workspace, instructions: "Stay inside the workspace." }),
    });
    assert.equal(botRes.status, 201);
    const { bot } = await botRes.json() as { bot: { id: string } };
    const missing = await fetch(`${app.url}/api/issues/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "github", issue: "12", repo: "acme/app", botId: bot.id, vaultItem: "github-token" }),
    });
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /Nothing was fetched/);
    assert.equal((await fetch(`${app.url}/api/vault`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "github-token", kind: "token", secret: GITHUB_TOKEN, storage: "local" }),
    })).status, 201);
    assert.equal((await fetch(`${app.url}/api/vault`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "linear-token", kind: "token", secret: LINEAR_TOKEN, storage: "local" }),
    })).status, 201);

    const started = await fetch(`${app.url}/api/issues/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "github", issue: "12", repo: "acme/app", botId: bot.id, vaultItem: "github-token" }),
    });
    const startedText = await started.text();
    assert.equal(started.status, 201, startedText);
    assert.equal(startedText.includes(GITHUB_TOKEN), false);
    const run = (JSON.parse(startedText) as { run: { id: string; plan: string; taskId: string } }).run;
    assert.match(run.plan, /No model wrote this plan/);
    assert.match(run.plan, /Fix the invoice total/);
    const early = await fetch(`${app.url}/api/issues/${run.id}/pull-request`, { method: "POST", headers, body: "{}" });
    assert.equal(early.status, 400);
    assert.match(await early.text(), /Nothing was opened/);
    const approved = await fetch(`${app.url}/api/issues/${run.id}/approve`, { method: "POST", headers, body: "{}" });
    assert.equal(approved.status, 200);
    const untested = await fetch(`${app.url}/api/issues/${run.id}/pull-request`, { method: "POST", headers, body: "{}" });
    assert.equal(untested.status, 400);
    assert.match(await untested.text(), /Run tests/);
    const tested = await fetch(`${app.url}/api/issues/${run.id}/test`, { method: "POST", headers, body: "{}" });
    const testedText = await tested.text();
    assert.equal(tested.status, 200, testedText);
    assert.match(testedText, /"testExitCode":0/);
    const opened = await fetch(`${app.url}/api/issues/${run.id}/pull-request`, { method: "POST", headers, body: "{}" });
    const openedText = await opened.text();
    assert.equal(opened.status, 200, openedText);
    assert.match(openedText, /http:\/\/127\.0\.0\.1\/pull\/12/);
    assert.equal(openedText.includes(GITHUB_TOKEN), false);
    const pull = mock.hits.find((hit) => hit.method === "POST" && hit.url === "/repos/acme/app/pulls");
    assert.ok(pull);
    assert.match(pull.body, /No model wrote this plan/);
    assert.match(pull.body, /pass\.test\.mjs/);
    assert.match(pull.body, /The test command exited 0/);
    assert.equal(pull.body.includes(GITHUB_TOKEN), false);
    assert.equal(mock.hits.some((hit) => /merge/i.test(hit.url)), false);
    const state = await (await fetch(`${app.url}/api/state`)).text();
    assert.equal(state.includes(GITHUB_TOKEN), false);
    assert.equal(state.includes(LINEAR_TOKEN), false);
    const task = (JSON.parse(state) as { tasks: Array<{ id: string; status: string; result?: string }> }).tasks.find((item) => item.id === run.taskId);
    assert.equal(task?.status, "succeeded");
    assert.match(task?.result ?? "", /not merged/);

    const linear = await fetch(`${app.url}/api/issues/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "linear", issue: "TEAM-12", repo: "acme/fail", botId: bot.id, vaultItem: "linear-token", githubVaultItem: "github-token" }),
    });
    assert.equal(linear.status, 201);
    const linearRun = (JSON.parse(await linear.text()) as { run: { id: string; title: string } }).run;
    assert.equal(linearRun.title, "Linear invoice");
    await fetch(`${app.url}/api/issues/${linearRun.id}/approve`, { method: "POST", headers, body: "{}" });
    await fetch(`${app.url}/api/issues/${linearRun.id}/test`, { method: "POST", headers, body: "{}" });
    const failed = await fetch(`${app.url}/api/issues/${linearRun.id}/pull-request`, { method: "POST", headers, body: "{}" });
    const failedText = await failed.text();
    assert.equal(failed.status, 409);
    assert.match(failedText, /Nothing was marked open/);
    assert.equal(failedText.includes("html_url"), false);
    assert.equal(mock.hits.some((hit) => /merge/i.test(hit.url)), false);
  } finally {
    await app.close();
    await mock.close();
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
