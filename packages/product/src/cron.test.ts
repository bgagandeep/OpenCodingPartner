import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { nextCronRun, signRoutineWebhook } from "./cron.js";
import { createBot, createProductRoutine, createTask, dueProductRoutines, listProductRoutines, updateProductRoutine, updateTask } from "./index.js";
import { startProductApp } from "./server.js";

test("five-field cron uses the timezone and keeps interval and event due checks", async () => {
  assert.equal(nextCronRun("0 9 * * 1", "America/New_York", Date.UTC(2026, 9, 22, 16, 0, 0)), Date.UTC(2026, 9, 26, 13, 0, 0));
  assert.equal(nextCronRun("*/15 * * * *", "UTC", Date.UTC(2026, 0, 1, 0, 7, 30)), Date.UTC(2026, 0, 1, 0, 15, 0));
  assert.equal(nextCronRun("0 0 * * 0", "UTC", Date.UTC(2026, 9, 24, 12, 0, 0)), Date.UTC(2026, 9, 25, 0, 0, 0));
  assert.equal(nextCronRun("0 0 * * 7", "UTC", Date.UTC(2026, 9, 24, 12, 0, 0)), Date.UTC(2026, 9, 25, 0, 0, 0));
  assert.equal(nextCronRun("0 0 1 * 1", "UTC", Date.UTC(2026, 9, 22, 0, 0, 0)), Date.UTC(2026, 9, 26, 0, 0, 0));
  assert.equal(nextCronRun("30 2 * * *", "America/New_York", Date.UTC(2026, 2, 8, 6, 0, 0)), Date.UTC(2026, 2, 9, 6, 30, 0));
  assert.equal(nextCronRun("30 1 * * *", "America/New_York", Date.UTC(2026, 10, 1, 5, 0, 0)), Date.UTC(2026, 10, 1, 5, 30, 0));
  assert.equal(nextCronRun("30 1 * * *", "America/New_York", Date.UTC(2026, 10, 1, 5, 30, 0)), Date.UTC(2026, 10, 1, 6, 30, 0));
  assert.throws(() => nextCronRun("60 * * * *", "UTC", 0), /Cron field is out of range/);
  assert.throws(() => nextCronRun("* * * *", "UTC", 0), /five fields/);
  assert.throws(() => nextCronRun("0 9 * * MON", "UTC", 0), /numeric/);
  assert.throws(() => nextCronRun("0 0 * * *", "Not/AZone", 0), /IANA/);
  assert.throws(() => nextCronRun("0 0 31 2 *", "UTC", Date.UTC(2026, 0, 1)), /no run in the next year/);

  const root = await mkdtemp(path.join(tmpdir(), "ocp-cron-due-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-cron-ws-"));
  try {
    const bot = await createBot({
      name: "Scheduler",
      role: "general",
      runtime: "ocp-agent",
      isolation: "host",
      workspace,
      instructions: "Stay inside the workspace.",
    }, root);
    const event = await createProductRoutine({ botId: bot.id, prompt: "On the event", event: "build-finished" }, root);
    const interval = await createProductRoutine({ botId: bot.id, prompt: "Every hour", everyMs: 3_600_000 }, root);
    const cron = await createProductRoutine({ botId: bot.id, prompt: "Weekday morning", cron: "0 9 * * 1", timezone: "America/New_York" }, root);
    assert.ok((cron.nextRunAt ?? 0) > Date.now());
    await updateProductRoutine(event.id, { nextRunAt: 1 }, root);
    await updateProductRoutine(interval.id, { nextRunAt: 1 }, root);
    await updateProductRoutine(cron.id, { nextRunAt: 1 }, root);
    const due = await dueProductRoutines(Date.now(), root);
    assert.deepEqual(due.map((item) => item.id).sort(), [cron.id, interval.id].sort());
    await assert.rejects(() => createProductRoutine({ botId: bot.id, prompt: "Both", everyMs: 1000, event: "build-finished" }, root), /not both/);
    await assert.rejects(() => createProductRoutine({ botId: bot.id, prompt: "Both", everyMs: 1000, cron: "0 9 * * 1", timezone: "UTC" }, root), /cron expression/);
    await assert.rejects(() => createProductRoutine({ botId: bot.id, prompt: "Missing zone", cron: "0 9 * * 1" }, root), /IANA timezone/);
    const listed = await listProductRoutines(root);
    assert.equal(listed.some((item) => JSON.stringify(item).includes("webhookSecret")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a signed webhook starts a routine and a bad signature does not", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-hook-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-hook-ws-"));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, HERMES_HOME: root, OCP_DATA_DIR: root };
  const app = await startProductApp({ root, port: 0, env });
  try {
    const page = await fetch(app.url);
    const html = await page.text();
    assert.match(html, /five-field cron/);
    assert.match(html, /x-ocp-signature/);
    assert.match(html, /shown once/);
    assert.match(html, /Signed inbound webhook/);
    const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    await writeFile(path.join(root, "dash.js"), script);
    const checked = spawnSync(process.execPath, ["--check", path.join(root, "dash.js")], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec(page.headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const botRes = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada", role: "general", runtime: "ocp-agent", isolation: "host", workspace, instructions: "Stay inside the workspace." }),
    });
    assert.equal(botRes.status, 201);
    const { bot } = await botRes.json() as { bot: { id: string } };
    const created = await fetch(`${app.url}/api/routines`, {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: bot.id, prompt: "Run the morning check", cron: "0 9 * * 1", timezone: "UTC", webhook: true }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { routine: { id: string; webhook?: boolean; cron?: string }; webhookSecret?: string; webhookPath?: string };
    const secret = createdBody.webhookSecret ?? "";
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.equal(createdBody.routine.webhook, true);
    assert.equal(createdBody.webhookPath, `/api/routines/hooks/${createdBody.routine.id}`);
    assert.equal(JSON.stringify(createdBody.routine).includes(secret), false);
    const stateText = JSON.stringify(await (await fetch(`${app.url}/api/state`)).json());
    const routinesText = JSON.stringify(await (await fetch(`${app.url}/api/routines`)).json());
    const stored = await readFile(path.join(root, "state.json"), "utf8");
    assert.equal(stateText.includes(secret), false);
    assert.equal(routinesText.includes(secret), false);
    assert.equal(stored.includes(secret), false);
    const hookStat = await stat(path.join(root, "routine-hooks.json"));
    assert.equal(hookStat.mode & 0o777, 0o600);
    const hookFile = await readFile(path.join(root, "routine-hooks.json"), "utf8");
    assert.equal(hookFile.includes(secret), true);

    const raw = JSON.stringify({ hello: "ocp" });
    const post = (timestamp: string, signature: string, body = raw) => fetch(`${app.url}/api/routines/hooks/${createdBody.routine.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocp-timestamp": timestamp, "x-ocp-signature": signature },
      body,
    });
    const bad = await post(String(Date.now()), "ab".repeat(32));
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /Nothing was started/);
    const staleStamp = String(Date.now() - 6 * 60 * 1000);
    const stale = await post(staleStamp, signRoutineWebhook(secret, staleStamp, raw));
    assert.equal(stale.status, 401);
    assert.equal((await (await fetch(`${app.url}/api/state`)).json() as { tasks: unknown[] }).tasks.length, 0);
    const blocker = await createTask({ botId: bot.id, prompt: "Hold the workspace" }, root);
    await updateTask(blocker.id, { status: "running" }, root);

    const timestamp = String(Date.now());
    const signature = signRoutineWebhook(secret, timestamp, raw);
    const ok = await post(timestamp, signature);
    assert.equal(ok.status, 202);
    const okBody = await ok.json() as { ok: boolean; started: boolean };
    assert.equal(okBody.ok, true);
    assert.equal(okBody.started, true);
    const replay = await post(timestamp, signature);
    assert.equal(replay.status, 401);
    assert.match(await replay.text(), /replayed/);
    const tasks = (await (await fetch(`${app.url}/api/state`)).json() as { tasks: { prompt: string }[] }).tasks;
    assert.equal(tasks.length, 2);
    const routineTask = tasks.find((item) => item.prompt.includes("Run the morning check"));
    assert.ok(routineTask);
    assert.equal(routineTask.prompt.includes(secret), false);

    const paused = await fetch(`${app.url}/api/routines`, {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: bot.id, prompt: "Paused hook", event: "ship-it", webhook: true, everyMs: "" }),
    });
    assert.equal(paused.status, 201);
    const pausedBody = await paused.json() as { routine: { id: string }; webhookSecret?: string };
    await fetch(`${app.url}/api/routines/${pausedBody.routine.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "paused" }),
    });
    const pausedStamp = String(Date.now());
    const pausedRaw = "{}";
    const pausedRes = await fetch(`${app.url}/api/routines/hooks/${pausedBody.routine.id}`, {
      method: "POST",
      headers: {
        "x-ocp-timestamp": pausedStamp,
        "x-ocp-signature": signRoutineWebhook(pausedBody.webhookSecret ?? "", pausedStamp, pausedRaw),
      },
      body: pausedRaw,
    });
    assert.equal(pausedRes.status, 409);
    assert.match(await pausedRes.text(), /Nothing was started/);
    assert.equal((await (await fetch(`${app.url}/api/state`)).json() as { tasks: unknown[] }).tasks.length, 2);

    const missing = await fetch(`${app.url}/api/routines/hooks/not-a-routine`, { method: "POST", body: "{}" });
    assert.equal(missing.status, 404);
    const stateAfter = JSON.stringify(await (await fetch(`${app.url}/api/state`)).json());
    assert.equal(stateAfter.includes(secret), false);
    assert.equal(stateAfter.includes(pausedBody.webhookSecret ?? "missing-secret"), false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
