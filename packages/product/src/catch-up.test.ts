import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  appendChannelLog,
  createBot,
  createProductRoutine,
  createTask,
  findTask,
  handOffTask,
  listProductRoutines,
  noteRoutineOutcome,
  ROUTINE_FAILURE_PAUSE,
  saveTaskAsRoutine,
  unattendedApprovalExpired,
  unattendedApprovalTtlMs,
  updateTask,
} from "./index.js";
import { startProductApp } from "./server.js";
import { buildActivity, createResponsibility, gateTool, listAudit, reachThread, saveDenyRule, scheduleResponsibilityCheck } from "./teammate.js";
import { proactiveBlock, proactiveToolAllowed, runGatedShell } from "./workspace-mcp.js";

function botInput(name: string, workspace: string) {
  return {
    name,
    role: "general" as const,
    runtime: "ocp-agent" as const,
    isolation: "host" as const,
    workspace,
    instructions: "Stay inside the workspace.",
  };
}

test("a routine command rule refuses the shell before it runs, and a person is not refused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-gate-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-gate-ws-"));
  const previousTask = process.env.OCP_TASK_ID;
  try {
    const bot = await createBot(botInput("Ada", workspace), root);
    const routineTask = await createTask({ botId: bot.id, prompt: "status", initiator: "routine" }, root);
    const personTask = await createTask({ botId: bot.id, prompt: "status", initiator: "person" }, root);
    await saveDenyRule(root, "workspace_shell", "src/", { argvPrefix: ["git", "status"], initiator: "routine" });
    process.env.OCP_TASK_ID = routineTask.id;
    const withPath = await runGatedShell(workspace, ["git", "status"], root);
    assert.equal(withPath.detail.startsWith("Refused by rule"), false);

    await rm(path.join(root, "deny-rules.json"));
    const rule = await saveDenyRule(root, "workspace_shell", undefined, { argvPrefix: ["git", "status"], initiator: "routine" });
    const refused = await runGatedShell(workspace, ["git", "status"], root);
    assert.equal(refused.ok, false);
    assert.equal(refused.detail, `Refused by rule ${rule.id}.`);
    assert.equal(refused.detail.includes("On branch"), false);
    assert.equal(refused.detail.includes("not a git repository"), false);

    process.env.OCP_TASK_ID = personTask.id;
    const person = await runGatedShell(workspace, ["git", "status"], root);
    assert.equal(person.detail.startsWith("Refused by rule"), false);
    assert.match(person.detail, /not a git repository|Could not start git|Command exited/);

    await writeFile(path.join(root, "deny-rules.json"), '[{"id":"x","tool":"workspace_shell","argvPrefix":"git"}]\n');
    const broken = await runGatedShell(workspace, ["git", "status"], root);
    assert.equal(broken.ok, false);
    assert.equal(broken.detail, "Refused by rule broken.");
    assert.equal(broken.detail.includes("not a git repository"), false);

    await rm(path.join(root, "deny-rules.json"));
    const pathRule = await saveDenyRule(root, "workspace_delete", "src/");
    const still = await gateTool(root, "workspace_delete", "src/app.ts");
    assert.equal(still.ok, false);
    if (!still.ok) assert.equal(still.ruleId, pathRule.id);
  } finally {
    if (previousTask === undefined) delete process.env.OCP_TASK_ID;
    else process.env.OCP_TASK_ID = previousTask;
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a proactive pass does not run the shell or a write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-proactive-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-proactive-ws-"));
  const previousTask = process.env.OCP_TASK_ID;
  try {
    const bot = await createBot(botInput("Ada", workspace), root);
    const task = await createTask({ botId: bot.id, prompt: "Read the README", initiator: "person", proactive: true }, root);
    process.env.OCP_TASK_ID = task.id;
    assert.equal(proactiveToolAllowed("workspace_read"), true);
    assert.equal(proactiveToolAllowed("workspace_shell"), false);
    assert.equal(proactiveToolAllowed("computer_mouse"), false);
    const shell = await runGatedShell(workspace, ["git", "status"], root);
    assert.equal(shell.ok, false);
    assert.equal(shell.detail, "A proactive pass is read-only. This tool was not called.");
    assert.equal(shell.detail.includes("not a git repository"), false);
    const write = await proactiveBlock("workspace_write", root);
    assert.equal(write?.ok, false);
    assert.equal(await proactiveBlock("workspace_read", root), undefined);
    const audit = await listAudit(root);
    assert.equal(audit.some((row) => row.ruleId === "proactive" && row.action === "workspace_shell"), true);
  } finally {
    if (previousTask === undefined) delete process.env.OCP_TASK_ID;
    else process.env.OCP_TASK_ID = previousTask;
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ten routine failures pause the routine and a success clears the count", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-pause-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-pause-ws-"));
  try {
    const bot = await createBot(botInput("Ada", workspace), root);
    const routine = await createProductRoutine({ botId: bot.id, prompt: "Check the build", everyMs: 900_000 }, root);
    for (let count = 1; count < ROUTINE_FAILURE_PAUSE; count += 1) {
      const updated = await noteRoutineOutcome({ routineId: routine.id }, "failed", root);
      assert.equal(updated?.failureCount, count);
      assert.equal(updated?.status, "active");
    }
    const paused = await noteRoutineOutcome({ routineId: routine.id }, "failed", root);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.failureCount, ROUTINE_FAILURE_PAUSE);
    const held = await noteRoutineOutcome({ routineId: routine.id }, "failed", root);
    assert.equal(held?.status, "paused");
    assert.equal(held?.failureCount, ROUTINE_FAILURE_PAUSE);
    const cleared = await noteRoutineOutcome({ routineId: routine.id }, "succeeded", root);
    assert.equal(cleared?.failureCount, 0);
    assert.equal(cleared?.status, "paused");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("hand off queues another bot, and a finished task can become a routine", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-hand-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-hand-ws-"));
  try {
    const ada = await createBot(botInput("Ada", workspace), root);
    const linus = await createBot(botInput("Linus", workspace), root);
    const task = await createTask({ botId: ada.id, prompt: "[routine old] Keep the README accurate", initiator: "person" }, root);
    await updateTask(task.id, { status: "succeeded", result: "Updated src/app.ts" }, root);
    const handed = await handOffTask(task.id, linus.id, root);
    assert.equal(handed.status, "queued");
    assert.equal(handed.botId, linus.id);
    assert.equal(handed.channelOrigin, undefined);
    assert.match(handed.prompt, /Updated src\/app.ts/);
    assert.match(handed.prompt, /Keep the README accurate/);
    await assert.rejects(() => handOffTask(handed.id, ada.id, root), /finished/);
    const routine = await saveTaskAsRoutine(task.id, { everyMs: 900_000 }, root);
    assert.equal(routine.botId, ada.id);
    assert.equal(routine.prompt, "Keep the README accurate");
    assert.equal(routine.prompt.includes("[routine"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("activity lists work without draft text or a webhook secret, and a check waits 15 minutes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-activity-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-activity-ws-"));
  try {
    const bot = await createBot(botInput("Ada", workspace), root);
    const task = await createTask({ botId: bot.id, prompt: "Review", initiator: "person" }, root);
    await updateTask(task.id, {
      status: "awaiting-approval",
      pendingApproval: {
        id: "req-secret",
        title: "send sk-live-secret",
        allowOnceOptionId: "allow",
        requestedAt: new Date().toISOString(),
      },
    }, root);
    await appendChannelLog({
      channel: "slack",
      direction: "out",
      text: "token=sk-live-secret",
      destination: "#secret",
      status: "draft",
    }, root);
    const responsibility = await createResponsibility(root, bot.id, "Keep the README accurate");
    await assert.rejects(() => scheduleResponsibilityCheck(root, responsibility.id, 60_000), /15 minutes/);
    const scheduled = await scheduleResponsibilityCheck(root, responsibility.id, 900_000);
    assert.ok(scheduled.responsibility.nextCheckAt);
    const routines = await listProductRoutines(root);
    assert.equal(routines.find((item) => item.id === scheduled.routineId)?.proactive, true);
    const webhook = await createProductRoutine({ botId: bot.id, prompt: "Hourly", cron: "0 * * * *", timezone: "UTC", webhook: true }, root);
    const activity = await buildActivity(root);
    const kinds = new Set(activity.items.map((item) => item.kind));
    assert.equal(kinds.has("approval"), true);
    assert.equal(kinds.has("draft"), true);
    assert.equal(kinds.has("responsibility"), true);
    assert.equal(kinds.has("routine"), true);
    const body = JSON.stringify(activity);
    assert.equal(body.includes("sk-live-secret"), false);
    assert.equal(body.includes(webhook.webhookSecret ?? "missing-secret"), false);
    assert.equal(body.includes("#secret"), false);
    assert.equal(unattendedApprovalTtlMs("person"), undefined);
    assert.equal(unattendedApprovalTtlMs("routine", {}), 600_000);
    assert.equal(unattendedApprovalTtlMs("routine", { OCP_APPROVAL_TTL_MS: "1500" }), 1500);
    const stale = { id: "x", title: "read", allowOnceOptionId: "allow", requestedAt: new Date(Date.now() - 5_000).toISOString() };
    assert.equal(unattendedApprovalExpired({ initiator: "person", pendingApproval: stale }, Date.now(), { OCP_APPROVAL_TTL_MS: "1000" }), false);
    assert.equal(unattendedApprovalExpired({ initiator: "routine", pendingApproval: stale }, Date.now(), { OCP_APPROVAL_TTL_MS: "1000" }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the app expires a routine approval, keeps a Teams draft unsent, and queues a handoff", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-catchup-app-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-catchup-app-ws-"));
  let networkCalls = 0;
  const app = await startProductApp({
    root,
    port: 0,
    env: { PATH: process.env.PATH, HOME: root, OCP_DATA_DIR: root, OCP_APPROVAL_TTL_MS: "1000" },
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("network");
    },
  });
  try {
    const page = await fetch(app.url);
    const html = await page.text();
    assert.match(html, /id="activityList"/);
    assert.match(html, /Hand off/);
    assert.match(html, /Schedule check/);
    assert.match(html, /value="teams"/);
    assert.match(html, /Allowing a Teams draft still sends nothing/);
    assert.doesNotMatch(html, /voiceForm|\/api\/voice|id="voiceResult"/);
    const inlineScript = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    assert.doesNotThrow(() => new Function(inlineScript));
    const token = /const TOKEN='([a-f0-9]+)'/.exec(inlineScript)?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const botBody = { role: "general", runtime: "ocp-agent", isolation: "host", workspace, instructions: "Stay inside the workspace." };
    const ada = await (await fetch(`${app.url}/api/bots`, { method: "POST", headers, body: JSON.stringify({ ...botBody, name: "Ada" }) })).json() as { bot: { id: string } };
    const linus = await (await fetch(`${app.url}/api/bots`, { method: "POST", headers, body: JSON.stringify({ ...botBody, name: "Linus" }) })).json() as { bot: { id: string } };

    const routineTask = await createTask({ botId: ada.bot.id, prompt: "Ship", initiator: "routine" }, root);
    await updateTask(routineTask.id, {
      status: "awaiting-approval",
      pendingApproval: { id: "old-routine", title: "git push", allowOnceOptionId: "allow", requestedAt: new Date(Date.now() - 5_000).toISOString() },
    }, root);
    const expired = await fetch(`${app.url}/api/tasks/${routineTask.id}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: "old-routine", decision: "allow-once" }),
    });
    assert.equal(expired.status, 409);
    const expiredTask = await findTask(routineTask.id, root);
    assert.equal(expiredTask?.status, "needs-attention");
    assert.equal(expiredTask?.pendingApproval, undefined);
    assert.match(expiredTask?.error ?? "", /did not run/);
    const audit = await listAudit(root);
    assert.equal(audit.some((row) => row.ruleId === "expired"), true);

    const personTask = await createTask({ botId: ada.bot.id, prompt: "Wait", initiator: "person" }, root);
    await updateTask(personTask.id, {
      status: "awaiting-approval",
      pendingApproval: { id: "old-person", title: "read a file", allowOnceOptionId: "allow", requestedAt: new Date(Date.now() - 5_000).toISOString() },
    }, root);
    const allowedPerson = await fetch(`${app.url}/api/tasks/${personTask.id}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: "old-person", decision: "allow-once" }),
    });
    assert.equal(allowedPerson.status, 200);
    assert.equal((await findTask(personTask.id, root))?.status, "running");

    const holder = await createTask({ botId: ada.bot.id, prompt: "Hold the workspace", initiator: "person" }, root);
    await updateTask(holder.id, { status: "running", processId: process.pid }, root);
    const finished = await createTask({ botId: ada.bot.id, prompt: "Write the note", initiator: "person" }, root);
    await updateTask(finished.id, { status: "succeeded", result: "Note written" }, root);
    const handed = await fetch(`${app.url}/api/tasks/${finished.id}/hand`, {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: linus.bot.id }),
    });
    const handedBody = await handed.json() as { taskId: string; queued: boolean };
    assert.equal(handed.status, 202);
    assert.equal(handedBody.queued, true);
    assert.equal((await findTask(handedBody.taskId, root))?.status, "queued");
    const saved = await fetch(`${app.url}/api/tasks/${finished.id}/routine`, {
      method: "POST",
      headers,
      body: JSON.stringify({ everyMs: 900_000 }),
    });
    assert.equal(saved.status, 201);
    const proactive = await fetch(`${app.url}/api/proactive`, {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: ada.bot.id, prompt: "Read the workspace only" }),
    });
    const proactiveBody = await proactive.json() as { taskId: string; proactive: boolean; queued: boolean };
    assert.equal(proactive.status, 202);
    assert.equal(proactiveBody.proactive, true);
    assert.equal(proactiveBody.queued, true);
    assert.equal((await findTask(proactiveBody.taskId, root))?.proactive, true);

    const responsibility = await createResponsibility(root, ada.bot.id, "Watch the build");
    const tooSoon = await fetch(`${app.url}/api/responsibilities/${responsibility.id}/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ everyMs: 1_000 }),
    });
    assert.equal(tooSoon.status, 400);
    const checked = await fetch(`${app.url}/api/responsibilities/${responsibility.id}/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ everyMs: 900_000 }),
    });
    assert.equal(checked.status, 201);

    const threadBots = [ada.bot.id, linus.bot.id];
    const { createThread } = await import("./teammate.js");
    const thread = await createThread(root, threadBots, "Ping the channel");
    const reached = await reachThread(root, thread.id, "teams", "Engineering");
    assert.match(reached.messages.at(-1)?.text ?? "", /Nothing was sent/);
    const draftId = /Reach draft for teams\. Nothing was sent\. (\S+)/.exec(reached.messages.at(-1)?.text ?? "")?.[1] ?? "";
    const allowed = await fetch(`${app.url}/api/channels/drafts/${draftId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "allow" }),
    });
    const allowBody = await allowed.json() as { status: string };
    assert.equal(allowBody.status, "draft");
    const outbox = await readFile(path.join(root, "teams-outbox.json"), "utf8");
    assert.match(outbox, /Ping the channel/);
    assert.equal(networkCalls, 0);

    const activity = await (await fetch(`${app.url}/api/activity`)).json() as { items: Array<{ kind: string }> };
    assert.equal(activity.items.some((item) => item.kind === "responsibility"), true);
    assert.equal(activity.items.some((item) => item.kind === "routine"), true);
    assert.equal(JSON.stringify(activity).includes("sk-"), false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
