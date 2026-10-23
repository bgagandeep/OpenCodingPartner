import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listBots, readProviderSettings } from "./index.js";
import { handleOnboardingPost, loadOnboardingView, onboardingCliText } from "./onboarding.js";
import { listResponsibilities } from "./teammate.js";
import { startProductApp } from "./server.js";

async function rootDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ocp-onboard-"));
}

function statusOf(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers,
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("the start guide is required until a bot exists, and it does not echo a key", async () => {
  const root = await rootDir();
  const env = { PATH: process.env.PATH, HOME: root, OCP_DATA_DIR: root };
  try {
    const first = await loadOnboardingView(root, env, path.join(root, "workspace"));
    assert.equal(first.required, true);
    assert.equal(first.modelConfigured, false);
    assert.match(onboardingCliText(), /scripts\/start-local\.sh/);
    assert.match(onboardingCliText(), /scripts\/start-docker\.sh/);
    assert.match(first.limits.join("\n"), /WhatsApp draft is not sent/);

    const saved = await handleOnboardingPost(root, {
      action: "model",
      provider: "openrouter",
      model: "qwen/qwen-2.5-coder-32b-instruct",
      apiKey: "sk-or-secret-value",
    }, env);
    assert.equal(saved.modelConfigured, true);
    assert.equal(JSON.stringify(saved).includes("sk-or-secret-value"), false);
    const settings = await readProviderSettings(root);
    assert.equal(settings.openrouterApiKey, "sk-or-secret-value");
    assert.equal(settings.defaultModel, "qwen/qwen-2.5-coder-32b-instruct");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the desk opens five teammates and one coder responsibility, and a second open does not duplicate it", async () => {
  const root = await rootDir();
  const workspace = path.join(root, "workspace");
  const env = { PATH: process.env.PATH, HOME: root, OCP_DATA_DIR: root };
  try {
    const opened = await handleOnboardingPost(root, {
      action: "desk",
      workspace,
      provider: "ollama",
      model: "qwen2.5-coder",
    }, env);
    assert.equal(opened.required, false);
    assert.equal(opened.modelConfigured, true);
    const bots = await listBots(root, workspace);
    assert.deepEqual(bots.map((bot) => bot.name).sort(), ["Ada", "Atlas", "Grace", "Linus", "Sentinel"]);
    const coder = bots.find((bot) => bot.name === "Linus");
    const duties = (await listResponsibilities(root)).filter((item) => item.botId === coder?.id);
    assert.equal(duties.length, 1);
    await handleOnboardingPost(root, { action: "reopen" }, env);
    await handleOnboardingPost(root, { action: "desk", workspace, model: "" }, env);
    const again = (await listResponsibilities(root)).filter((item) => item.botId === coder?.id && item.status === "open");
    assert.equal(again.length, 1);
    const settings = await readProviderSettings(root);
    assert.equal(settings.litellmBaseUrl, "http://127.0.0.1:11434/v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coder only creates Linus, skip closes the guide, and a base URL cannot carry a key", async () => {
  const root = await rootDir();
  const workspace = path.join(root, "workspace");
  const env = { PATH: process.env.PATH, HOME: root, OCP_DATA_DIR: root };
  try {
    const coder = await handleOnboardingPost(root, { action: "coder", workspace }, env);
    assert.equal(coder.required, false);
    assert.deepEqual((await listBots(root, workspace)).map((bot) => bot.name), ["Linus"]);
    await handleOnboardingPost(root, { action: "reopen" }, env);
    const reopened = await loadOnboardingView(root, env, workspace);
    assert.equal(reopened.required, true);
    const skipped = await handleOnboardingPost(root, { action: "skip" }, env);
    assert.equal(skipped.required, false);
    await assert.rejects(
      () => handleOnboardingPost(root, {
        action: "model",
        provider: "custom",
        model: "local",
        baseUrl: "http://user:secret@127.0.0.1:11434/v1",
      }, env),
      /key field/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the dashboard serves the start guide and docker bridge bind still rejects a foreign host", async () => {
  const root = await rootDir();
  const env = { PATH: process.env.PATH, HOME: root, OCP_DATA_DIR: root, OCP_DOCKER_BIND: "bridge" };
  await assert.rejects(() => startProductApp({ host: "0.0.0.0", port: 0, root, env: { ...env, OCP_DOCKER_BIND: "" } }), /loopback/);
  const app = await startProductApp({ host: "0.0.0.0", port: 0, root, env });
  try {
    const port = new URL(app.url).port;
    const base = `http://127.0.0.1:${port}`;
    const htmlRes = await fetch(base);
    const html = await htmlRes.text();
    assert.equal(htmlRes.status, 200);
    assert.match(html, /id="onboard"/);
    assert.match(html, /Start Open Coding Partner/);
    assert.match(html, /finishOnboard/);
    const inlineScript = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    assert.doesNotThrow(() => new Function(inlineScript));
    const guide = await (await fetch(`${base}/api/onboarding`)).json() as { required: boolean; local: string[] };
    assert.equal(guide.required, true);
    assert.ok(guide.local.some((line) => line.includes("start-local.sh")));
    const foreign = await statusOf(base, { host: "evil.example" });
    assert.equal(foreign, 403);
    const token = /const TOKEN='([a-f0-9]+)'/.exec(html)?.[1] ?? "";
    const opened = await fetch(`${base}/api/onboarding`, {
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "x-ocp-token": token },
      body: JSON.stringify({ action: "coder", workspace: path.join(root, "workspace"), provider: "ollama", model: "qwen2.5-coder" }),
    });
    const body = await opened.json() as { required: boolean; modelConfigured: boolean };
    assert.equal(opened.status, 200);
    assert.equal(body.required, false);
    assert.equal(body.modelConfigured, true);
    assert.equal(JSON.stringify(body).includes("sk-"), false);
    const stored = await readFile(path.join(root, "settings.json"), "utf8");
    assert.match(stored, /qwen2\.5-coder/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
