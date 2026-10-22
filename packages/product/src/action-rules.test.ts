import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveAction } from "./action-rules.js";
import { appendProductHandoff, createBot } from "./index.js";
import { startProductApp } from "./server.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("outbound mail stays a draft and other actions follow the bot rule", async () => {
  const root = await tempDir("ocp-rules-");
  const workspace = await tempDir("ocp-rules-ws-");
  try {
    const bot = await createBot({
      name: "Ada",
      role: "general",
      runtime: "ocp-agent",
      isolation: "host",
      workspace,
      instructions: "Stay inside the workspace.",
      actionRules: {
        defaultRule: "act",
        byAction: { calendar_create: "handoff", vault_fill: "act-if-preapproved" },
        preapproved: ["workspace_write"],
      },
    }, root);
    assert.equal(await resolveAction(root, bot.id, "gmail_draft"), "draft");
    assert.equal(await resolveAction(root, bot.id, "outlook_draft"), "draft");
    assert.equal(await resolveAction(root, bot.id, "slack_reply"), "draft");
    assert.equal(await resolveAction(root, bot.id, "telegram_reply"), "draft");
    assert.equal(await resolveAction(root, bot.id, "calendar_create"), "handoff");
    assert.equal(await resolveAction(root, bot.id, "vault_fill"), "ask");
    assert.equal(await resolveAction(root, bot.id, "workspace_write"), "perform");
    assert.equal(await resolveAction(root, bot.id, "drive_read"), "perform");
    assert.equal(await resolveAction(root, undefined, "workspace_write"), "ask");
    assert.equal(await resolveAction(undefined, bot.id, "calendar_create"), "ask");
    const handoff = await appendProductHandoff({ botId: bot.id, action: "calendar_create", summary: "calendar_create was not performed." }, root);
    assert.match(handoff.summary, /was not performed/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bot action rules survive a cheap-mode patch and reject an unknown rule", async () => {
  const root = await tempDir("ocp-rules-app-");
  const workspace = await tempDir("ocp-rules-app-ws-");
  const app = await startProductApp({
    root,
    port: 0,
    env: { PATH: process.env.PATH, HOME: root, HERMES_HOME: root, OCP_DATA_DIR: root, OCP_VAULT_BACKEND: "file" },
  });
  try {
    const html = await (await fetch(app.url)).text();
    assert.match(html, /Every outbound email or message stays here until you send it/);
    assert.match(html, /Outbound email and chat stay draft cards\. Act does not send them/);
    assert.match(html, /data-tab="drafts"/);
    assert.match(html, /Send reply/);
    assert.match(html, /Do not send/);
    const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    const scriptPath = path.join(root, "dash.js");
    await writeFile(scriptPath, script);
    const checked = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
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
        instructions: "Stay inside the workspace.",
        actionRule: "act",
        preapproved: "workspace_write",
        actionBy: "calendar_create=handoff\nvault_fill=act-if-preapproved",
      }),
    });
    assert.equal(created.status, 201);
    const { bot } = await created.json() as { bot: { id: string; actionRules: { defaultRule: string; byAction: Record<string, string>; preapproved: string[] } } };
    assert.equal(bot.actionRules.defaultRule, "act");
    assert.equal(bot.actionRules.byAction.calendar_create, "handoff");
    assert.deepEqual(bot.actionRules.preapproved, ["workspace_write"]);
    const cheap = await fetch(`${app.url}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ routeMode: "cheap" }),
    });
    assert.equal(cheap.status, 200);
    const state = await (await fetch(`${app.url}/api/state`)).json() as { bots: Array<{ id: string; routeMode?: string; actionRules: { defaultRule: string; byAction: Record<string, string> } }> };
    const saved = state.bots.find((item) => item.id === bot.id);
    assert.equal(saved?.routeMode, "cheap");
    assert.equal(saved?.actionRules.defaultRule, "act");
    assert.equal(saved?.actionRules.byAction.calendar_create, "handoff");
    const bad = await fetch(`${app.url}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ actionRule: "yolo" }),
    });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /act, act-if-preapproved, ask, or handoff/);
    const runtime = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./native-acp.js", import.meta.url), "utf8"));
    assert.match(runtime, /resolveAction/);
    assert.match(runtime, /Handed off/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
