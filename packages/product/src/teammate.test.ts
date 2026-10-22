import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { botComputerIdentity, resetBotComputer } from "./computer-desktop.js";
import { createProductRoutine, listChannelLog, productDataDir } from "./index.js";
import { startProductApp } from "./server.js";
import { correctMemory, createResponsibility, createThread, forgetMemory, gateTool, listAudit, listResponsibilities, reachThread, recordAudit, saveDenyRule } from "./teammate.js";

test("each bot gets its own computer and a reset leaves the other one", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-desk-"));
  const env = { ...process.env, OCP_DATA_DIR: await mkdtemp(path.join(tmpdir(), "ocp-desk-data-")) };
  try {
    const ada = botComputerIdentity(workspace, "ada", env);
    const linus = botComputerIdentity(workspace, "linus", env);
    assert.notEqual(ada.display, linus.display);
    assert.notEqual(ada.profileDir, linus.profileDir);
    assert.notEqual(ada.statePath, linus.statePath);
    await writeFile(ada.statePath, "{}\n").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(ada.statePath), { recursive: true });
      await mkdir(path.dirname(linus.statePath), { recursive: true });
      await writeFile(ada.statePath, "{}\n");
    });
    await writeFile(linus.statePath, "{}\n");
    await resetBotComputer(workspace, "ada");
    await assert.rejects(() => stat(ada.statePath));
    assert.equal((await stat(linus.statePath)).isFile(), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(env.OCP_DATA_DIR, { recursive: true, force: true });
  }
});

test("responsibilities, threads, reach, memory, and deny rules stay local", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-team-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-team-ws-"));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, HERMES_HOME: root, OCP_DATA_DIR: root };
  const previous = process.env.OCP_DATA_DIR;
  process.env.OCP_DATA_DIR = root;
  const app = await startProductApp({ root, port: 0, env });
  try {
    const page = await fetch(app.url);
    const html = await page.text();
    assert.match(html, /data-tab="audit"/);
    assert.match(html, /Save responsibility/);
    assert.match(html, /Start thread/);
    assert.match(html, /Draft reach/);
    assert.match(html, /Save deny rule/);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec(page.headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const botBody = { role: "general", runtime: "ocp-agent", isolation: "host", workspace, instructions: "Stay inside the workspace." };
    const ada = await (await fetch(`${app.url}/api/bots`, { method: "POST", headers, body: JSON.stringify({ ...botBody, name: "Ada" }) })).json() as { bot: { id: string } };
    const linus = await (await fetch(`${app.url}/api/bots`, { method: "POST", headers, body: JSON.stringify({ ...botBody, name: "Linus" }) })).json() as { bot: { id: string } };
    const shown = await Promise.all([ada.bot.id, linus.bot.id].map(async (id) => await (await fetch(`${app.url}/api/bots/${id}/computer`)).json() as { display: string; profileDir: string }));
    const adaComputer = shown[0];
    const linusComputer = shown[1];
    assert.ok(adaComputer && linusComputer);
    assert.notEqual(adaComputer.display, linusComputer.display);
    assert.notEqual(adaComputer.profileDir, linusComputer.profileDir);

    const responsibility = await createResponsibility(root, ada.bot.id, "Keep the README accurate");
    const routine = await createProductRoutine({ botId: ada.bot.id, prompt: `Work on ${responsibility.id}`, everyMs: 3_600_000 }, root);
    assert.match(routine.prompt, new RegExp(responsibility.id));
    assert.equal((await listResponsibilities(root))[0]?.goal, "Keep the README accurate");

    const thread = await createThread(root, [ada.bot.id, linus.bot.id], "Look at the package layout");
    assert.equal(thread.messages.filter((item) => item.role === "bot").length, 2);
    assert.match(thread.messages.map((item) => item.text).join("\n"), /Ada/);
    assert.match(thread.messages.map((item) => item.text).join("\n"), /Linus/);
    assert.match(thread.messages.map((item) => item.text).join("\n"), /No model is configured/);
    const reached = await reachThread(root, thread.id, "slack", "#project");
    assert.match(reached.messages.at(-1)?.text ?? "", /Nothing was sent/);
    const log = await listChannelLog(root);
    assert.equal(log.at(-1)?.status, "draft");
    assert.equal(log.at(-1)?.channel, "slack");

    const { mkdir, realpath, writeFile: write } = await import("node:fs/promises");
    const hashFile = (await import("node:crypto")).createHash("sha256").update(await realpath(workspace)).digest("hex").slice(0, 16);
    const target = path.join(root, "memories", hashFile, "MEMORY.md");
    await mkdir(path.dirname(target), { recursive: true });
    await write(target, "# Workspace Memory\n\n- [2026-10-22] The old fact\n");
    const corrected = await correctMemory(workspace, "old fact", "The app binds to loopback only.", root);
    assert.match(corrected.join("\n"), /loopback only/);
    assert.equal(await forgetMemory(workspace, "loopback", root), 1);

    const rule = await saveDenyRule(root, "workspace_delete", "src/");
    const refused = await gateTool(root, "workspace_delete", "src/app.ts");
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.ruleId, rule.id);
    assert.equal((await gateTool(root, "workspace_read", "src/app.ts")).ok, true);
    await writeFile(path.join(root, "deny-rules.json"), '[{"id":"bad"}]\n');
    const broken = await gateTool(root, "workspace_read", "src/app.ts");
    assert.equal(broken.ok, false);
    if (!broken.ok) assert.equal(broken.ruleId, "broken");

    await recordAudit(root, { outcome: "refused", action: "workspace_delete", ruleId: rule.id, detail: "token=sk-live-secret" });
    const audit = await listAudit(root);
    assert.equal(audit.some((row) => row.ruleId === rule.id), true);
    assert.equal(JSON.stringify(audit).includes("sk-live-secret"), false);

    const viaApi = await fetch(`${app.url}/api/threads`, { method: "POST", headers, body: JSON.stringify({ botIds: [ada.bot.id, linus.bot.id], text: "Second pass" }) });
    assert.equal(viaApi.status, 201);
    assert.equal(productDataDir(env), root);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.OCP_DATA_DIR;
    else process.env.OCP_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a deny rule refuses the workspace tool call and quotes the rule", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-rule-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-rule-ws-"));
  const rule = await saveDenyRule(root, "workspace_list");
  const child = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "workspace-mcp.js"), workspace], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OCP_DATA_DIR: root, PATH: process.env.PATH },
  });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
  });
  const rpc = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve) => {
    const id = pending.size + 1;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await rpc("initialize");
    const result = await rpc("tools/call", { name: "workspace_list", arguments: { path: "." } });
    const body = result.result as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(body.isError, true);
    assert.match(body.content?.[0]?.text ?? "", new RegExp(rule.id));
    const audit = JSON.parse(await readFile(path.join(root, "audit.json"), "utf8")) as Array<{ ruleId?: string }>;
    assert.equal(audit.some((row) => row.ruleId === rule.id), true);
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
