import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { companyAssertion, confineCoderLaunch } from "./category.js";
import { createThread, reachThread } from "./teammate.js";
import { listChannelLog } from "./index.js";
import { startProductApp } from "./server.js";

test("coder confinement refuses to run without bubblewrap and binds only the workspace", () => {
  assert.throws(() => confineCoderLaunch({ workspace: "/work/app", command: "ocp-coder", args: ["run"], bwrap: undefined }), /bubblewrap/);
  const plan = confineCoderLaunch({ workspace: "/work/app", command: "ocp-coder", args: ["run"], bwrap: "/usr/bin/bwrap" });
  assert.equal(plan.command, "/usr/bin/bwrap");
  assert.equal(plan.args.includes("--unshare-net"), true);
  assert.equal(plan.args.includes("--bind"), true);
  assert.equal(plan.args.includes(path.resolve("/work/app")), true);
  assert.equal(plan.args.includes("/work/other"), false);
});

test("category surfaces stay local: agents, components, directory, voice, pages, and WhatsApp drafts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-category-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-category-ws-"));
  const previous = process.env.OCP_DATA_DIR;
  process.env.OCP_DATA_DIR = root;
  const agent = createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      response.writeHead(request.method === "POST" ? 200 : 405, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "local agent said hello sk-live-secret" }));
    });
  });
  await new Promise<void>((resolve) => agent.listen(0, "127.0.0.1", () => resolve()));
  const address = agent.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const app = await startProductApp({ root, port: 0, env: { PATH: process.env.PATH, HOME: root, OCP_DATA_DIR: root } });
  try {
    const page = await fetch(app.url);
    const html = await page.text();
    assert.match(html, /data-tab="category"/);
    assert.match(html, /Register agent/);
    assert.match(html, /Add person/);
    assert.match(html, /Enable company sign-in/);
    assert.match(html, /Save page/);
    assert.match(html, /value="whatsapp"/);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec(page.headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const botBody = { role: "general", runtime: "ocp-agent", isolation: "host", workspace, instructions: "Stay inside the workspace." };
    const ada = await (await fetch(`${app.url}/api/bots`, { method: "POST", headers, body: JSON.stringify({ ...botBody, name: "Ada" }) })).json() as { bot: { id: string } };
    const linus = await (await fetch(`${app.url}/api/bots`, { method: "POST", headers, body: JSON.stringify({ ...botBody, name: "Linus" }) })).json() as { bot: { id: string } };

    const foreign = await fetch(`${app.url}/api/agents`, { method: "POST", headers, body: JSON.stringify({ name: "Remote", url: "http://10.1.2.3/agent" }) });
    assert.equal(foreign.status, 400);
    const registered = await (await fetch(`${app.url}/api/agents`, { method: "POST", headers, body: JSON.stringify({ name: "Local Agent", url: `http://127.0.0.1:${port}/agent` }) })).json() as { agent: { id: string } };
    const streamed = await fetch(`${app.url}/api/agui`, {
      method: "POST",
      headers,
      body: JSON.stringify({ threadId: "thread-1", runId: "run-1", messages: [], agentId: registered.agent.id }),
    });
    assert.equal(streamed.headers.get("content-type"), "text/event-stream");
    const events = (await streamed.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as { type: string; delta?: string; name?: string });
    assert.equal(events.some((event) => event.type === "RUN_STARTED"), true);
    assert.match(events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta ?? "", /local agent said hello/);
    assert.equal((events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta ?? "").includes("sk-live-secret"), false);
    assert.equal(events.some((event) => event.type === "CUSTOM" && event.name === "ocp.component"), true);
    assert.equal(events.at(-1)?.type, "RUN_FINISHED");
    const plain = await fetch(`${app.url}/api/agui`, { method: "POST", headers, body: JSON.stringify({ threadId: "thread-2", runId: "run-2", messages: [] }) });
    assert.match(await plain.text(), /will not invent an action/);

    const thread = await createThread(root, [ada.bot.id, linus.bot.id], "Look at the layout");
    const card = thread.messages.find((item) => item.role === "bot")?.components?.[0];
    assert.equal(card?.type, "card");
    assert.match(card?.body ?? "", /will not invent an action/);
    const reached = await reachThread(root, thread.id, "whatsapp", "+15551212");
    assert.match(reached.messages.at(-1)?.text ?? "", /Nothing was sent/);
    const draft = (await listChannelLog(root)).find((entry) => entry.channel === "whatsapp");
    assert.equal(draft?.status, "draft");
    const allowed = await fetch(`${app.url}/api/channels/drafts/${draft?.id}`, { method: "POST", headers, body: JSON.stringify({ decision: "allow" }) });
    const allowBody = await allowed.json() as { status: string };
    assert.equal(allowBody.status, "draft");
    const outbox = await readFile(path.join(root, "whatsapp-outbox.json"), "utf8");
    assert.match(outbox, /Nothing was sent|Look at the layout/);

    const secret = "company-assertion-key";
    const added = await fetch(`${app.url}/api/directory/users`, { method: "POST", headers, body: JSON.stringify({ name: "Ada Local", role: "admin", password: "local-pass-1" }) });
    assert.equal(added.status, 201);
    const wrong = await fetch(`${app.url}/api/directory/login`, { method: "POST", headers, body: JSON.stringify({ name: "Ada Local", password: "nope-nope" }) });
    assert.equal(wrong.status, 401);
    const signedIn = await fetch(`${app.url}/api/directory/login`, { method: "POST", headers, body: JSON.stringify({ name: "Ada Local", password: "local-pass-1" }) });
    assert.equal(signedIn.status, 200);
    await fetch(`${app.url}/api/directory/company`, { method: "POST", headers, body: JSON.stringify({ secret }) });
    const assertion = companyAssertion(secret, "Grace Local", "member", Date.now() + 60_000);
    const company = await (await fetch(`${app.url}/api/directory/login`, { method: "POST", headers, body: JSON.stringify({ assertion }) })).json() as { user: { name: string; role: string } };
    assert.equal(company.user.name, "Grace Local");
    assert.equal(company.user.role, "member");
    const directory = await (await fetch(`${app.url}/api/directory`)).text();
    assert.equal(directory.includes("local-pass-1"), false);
    assert.equal(directory.includes(secret), false);
    assert.equal(directory.includes("hash"), false);

    const voice = await (await fetch(`${app.url}/api/voice`, { method: "POST", headers, body: JSON.stringify({ transcript: "token=sk-voice-secret please ship it" }) })).json() as { spoken: string };
    assert.match(voice.spoken, /No model is configured/);
    assert.match(voice.spoken, /will not invent an action/);
    assert.equal(voice.spoken.includes("sk-voice-secret"), false);

    const saved = await (await fetch(`${app.url}/api/pages`, { method: "POST", headers, body: JSON.stringify({ title: "Launch note", body: "The app binds to loopback. secret=sk-page-secret" }) })).json() as { page: { body: string } };
    assert.match(saved.page.body, /loopback/);
    assert.equal(saved.page.body.includes("sk-page-secret"), false);
    assert.match(html, /data-component/);
  } finally {
    agent.close();
    await app.close();
    if (previous === undefined) delete process.env.OCP_DATA_DIR;
    else process.env.OCP_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
