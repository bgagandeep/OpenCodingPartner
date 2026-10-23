import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generateOperatorImage } from "./images.js";
import { createBot } from "./index.js";
import { installPlugin } from "./plugins.js";
import { noteModelUsage, readUsageCalls } from "./usage.js";
import { createVaultItem, deleteVaultItemByName } from "./vault.js";
import { proactiveToolAllowed } from "./workspace-mcp.js";

const SECRET = "sk-pluginsecretvalue";

function fileEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: root,
    HERMES_HOME: root,
    OCP_DATA_DIR: root,
    OCP_VAULT_BACKEND: "file",
    OPENAI_BASE_URL: "https://example.invalid/v1",
    OPENAI_API_KEY: "sk-default-should-not-be-used",
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("image server did not bind"));
        return;
      }
      resolve(address.port);
    });
  });
}

function startImageServer(): Promise<{ base: string; seen: () => Array<{ url?: string; authorization?: string; body?: string }>; close: () => Promise<void> }> {
  const seen: Array<{ url?: string; authorization?: string; body?: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        url: request.url,
        authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: [{ url: "http://127.0.0.1/picture.png" }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }));
    });
  });
  return listen(server).then((port) => ({
    base: `http://127.0.0.1:${port}/v1`,
    seen: () => seen,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }));
}

test("image generation uses the operator endpoint and records the usage meter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-image-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-image-ws-"));
  const env = fileEnv(root);
  const mock = await startImageServer();
  try {
    const bot = await createBot({
      name: "Ada",
      role: "general",
      runtime: "ocp-agent",
      isolation: "host",
      workspace,
      instructions: "Stay inside the workspace.",
    }, root);
    await installPlugin(root, "image-generation", {
      botId: bot.id,
      fields: { imageUrl: mock.base, modelId: "operator-model" },
      secrets: { "image-model-key": SECRET },
    }, { env });
    const result = await generateOperatorImage(root, { botId: bot.id, prompt: "a small mark", env, fetchImpl: fetch });
    assert.equal(result.ok, true);
    assert.match(result.detail, /127\.0\.0\.1\/picture\.png/);
    assert.equal(result.detail.includes(SECRET), false);
    assert.equal(result.detail.includes("example.invalid"), false);
    const [hit] = mock.seen();
    assert.equal(hit?.url, "/v1/images/generations");
    assert.equal(hit?.authorization, `Bearer ${SECRET}`);
    assert.equal(JSON.parse(hit?.body ?? "{}").model, "operator-model");
    const [call] = await readUsageCalls(root);
    assert.equal(call?.model, "operator-model");
    assert.equal(call?.provider, "local");
    assert.equal(call?.step, "image");
    assert.equal(call?.promptTokens, 4);
    assert.equal(call?.completionTokens, 2);
    assert.equal(call?.estimated, false);
    assert.equal(JSON.stringify(call).includes(SECRET), false);
    assert.equal(proactiveToolAllowed("image_generate"), false);
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("image generation does not call a host without an install, a key, or meter room", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-image-skip-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-image-skip-ws-"));
  const env = fileEnv(root);
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    throw new Error("host was called");
  };
  try {
    const missing = await generateOperatorImage(root, { botId: "missing", prompt: "a mark", env, fetchImpl });
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /No image provider/);
    const bot = await createBot({
      name: "Ada",
      role: "general",
      runtime: "ocp-agent",
      isolation: "host",
      workspace,
      instructions: "Stay inside the workspace.",
    }, root);
    await installPlugin(root, "image-generation", {
      botId: bot.id,
      fields: { imageUrl: "http://127.0.0.1:9/v1", modelId: "operator-model" },
      secrets: { "image-model-key": SECRET },
    }, { env });
    const blank = await generateOperatorImage(root, { botId: bot.id, prompt: "   ", env, fetchImpl });
    assert.match(blank.detail, /prompt/);
    await deleteVaultItemByName(root, "image-model-key", env);
    const noKey = await generateOperatorImage(root, { botId: bot.id, prompt: "a mark", env, fetchImpl });
    assert.match(noKey.detail, /model key/);
    await createVaultItem(root, {
      name: "image-model-key",
      kind: "token",
      account: "",
      secret: SECRET,
      storage: "local",
    }, env);
    await noteModelUsage(root, {
      botId: bot.id,
      model: "operator-model",
      provider: "custom",
      baseUrl: "http://127.0.0.1:9/v1",
      usage: { prompt_tokens: 8, completion_tokens: 8 },
      promptText: "a mark",
      completionText: "image",
    });
    await writeFile(path.join(root, "settings.json"), `${JSON.stringify({
      usageCaps: { perBot: [{ botId: bot.id, maxTokens: 1 }] },
    })}\n`);
    const capped = await generateOperatorImage(root, { botId: bot.id, prompt: "a mark", env, fetchImpl });
    assert.match(capped.detail, /Usage cap reached/);
    assert.equal(calls, 0);
    const callsAfter = await readUsageCalls(root);
    assert.equal(callsAfter.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
