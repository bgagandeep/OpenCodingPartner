import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBot, findBot } from "./index.js";
import { readMcpSecret } from "./mcp-secrets.js";
import {
  checksumPrefix,
  installManifest,
  installPlugin,
  loadShippedCatalog,
  manifestChecksum,
  operatorCatalogDecision,
  PRODUCT_VERSION,
  shippedCatalogPath,
  skillBodyChecksum,
  toolClaimsSend,
  uninstallPlugin,
  versionAccepts,
  visibleSkillCatalog,
  type PluginManifest,
} from "./plugins.js";
import { startProductApp } from "./server.js";
import { skillIdFromName } from "./skills.js";
import { gateTool, listAudit, recordAudit, saveDenyRule } from "./teammate.js";
import { publicVault, readVaultSecret } from "./vault.js";

const SECRET = "sk-pluginsecretvalue";

const STARTER_IDS = [
  "github",
  "linear",
  "jira",
  "confluence",
  "slack-drafts",
  "telegram-drafts",
  "notion",
  "google",
  "microsoft",
  "figma",
  "sentry",
  "pagerduty",
  "teams-drafts",
  "whatsapp-drafts",
];

function fileEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: root,
    HERMES_HOME: root,
    OCP_DATA_DIR: root,
    OCP_VAULT_BACKEND: "file",
  };
}

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

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("mock server did not bind"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/mcp`);
    });
  });
}

function startMockMcp(mode: "ok" | "down" | "send", token?: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (mode === "down") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      const auth = request.headers.authorization;
      if (token && auth !== `Bearer ${token}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let message: { id?: number; method?: string } = {};
      try {
        message = JSON.parse(Buffer.concat(chunks).toString() || "{}") as typeof message;
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      const tools = mode === "send"
        ? [{ name: "message_send", description: "This sends a message", inputSchema: { type: "object", properties: {} } }]
        : [{ name: "ping", description: "Reply pong for plugin tests", inputSchema: { type: "object", properties: {} } }];
      const result = message.method === "initialize"
        ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "0" } }
        : message.method === "tools/list"
          ? { tools }
          : undefined;
      if (!result) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { message: "unsupported" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  return listen(server).then((url) => ({
    url,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }));
}

async function rawCatalog(): Promise<PluginManifest[]> {
  return JSON.parse(await readFile(shippedCatalogPath(), "utf8")) as PluginManifest[];
}

async function githubRaw(): Promise<PluginManifest> {
  const github = (await rawCatalog()).find((plugin) => plugin.id === "github");
  if (!github) throw new Error("github plugin missing");
  return github;
}

test("shipped plugins parse at product version 0.2.0 and a colliding operator id is refused", async () => {
  const packageJson = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
  assert.equal(PRODUCT_VERSION, "0.2.0");
  assert.equal(packageJson.version, PRODUCT_VERSION);
  assert.equal(versionAccepts("0.2.0", "0.1.0"), false);
  assert.equal(versionAccepts("0.2.0", "0.2.0"), true);
  const text = await readFile(shippedCatalogPath(), "utf8");
  assert.equal(text.includes("http"), false);
  assert.equal(text.includes("message.send"), false);
  assert.equal(text.includes("signature"), false);
  const catalog = await loadShippedCatalog();
  const raw = await rawCatalog();
  assert.deepEqual(catalog.map((plugin) => plugin.id), STARTER_IDS);
  for (const plugin of raw) {
    assert.equal(plugin.minOcpVersion, "0.2.0");
    assert.equal(plugin.checksum, manifestChecksum(plugin));
  }
  for (const plugin of catalog) {
    assert.equal(plugin.permissions.includes("message.send"), false);
    assert.equal(plugin.permissions.includes("payment"), false);
    assert.equal(plugin.permissions.includes("voice"), false);
    assert.equal(plugin.permissions.includes("meeting"), false);
  }
  assert.deepEqual(catalog.filter((plugin) => plugin.draftOnly).map((plugin) => plugin.id), ["teams-drafts", "whatsapp-drafts"]);
  const shipped = new Set(catalog.map((plugin) => plugin.id));
  assert.equal(operatorCatalogDecision(shipped, "github"), "refused");
  assert.equal(operatorCatalogDecision(shipped, "operator-notes"), "add");
  assert.equal(toolClaimsSend("ping", "Reply pong"), false);
  assert.equal(toolClaimsSend("message_send", "ok"), true);
  assert.equal(toolClaimsSend("ping", "This sends a message"), true);
  assert.equal(toolClaimsSend("ping", "Allowing it still sends nothing"), false);
});

test("invalid plugin manifests are refused before anything is written", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-plugin-refuse-"));
  const github = await githubRaw();
  const cases: Array<{ name: string; manifest: Record<string, unknown>; pattern: RegExp }> = [
    { name: "unknown key", manifest: { ...github, extra: true, checksum: manifestChecksum({ ...github, extra: true }) }, pattern: /Unknown key/ },
    { name: "bad id", manifest: { ...github, id: "Git Hub", checksum: manifestChecksum({ ...github, id: "Git Hub" }) }, pattern: /Plugin id/ },
    { name: "checksum", manifest: { ...github, checksum: `sha256:${"0".repeat(64)}` }, pattern: /checksum/i },
    { name: "signature", manifest: { ...github, signature: "abc", checksum: manifestChecksum({ ...github, signature: "abc" }) }, pattern: /signature/i },
    { name: "version", manifest: { ...github, minOcpVersion: "0.3.0", checksum: manifestChecksum({ ...github, minOcpVersion: "0.3.0" }) }, pattern: /0\.3\.0/ },
  ];
  for (const permission of ["message.send", "payment", "voice", "meeting"]) {
    const manifest = { ...github, permissions: [permission] };
    cases.push({ name: permission, manifest: { ...manifest, checksum: manifestChecksum(manifest) }, pattern: new RegExp(permission.replace(".", "\\.")) });
  }
  try {
    for (const entry of cases) {
      await assert.rejects(() => installManifest(root, entry.manifest, { botId: "missing" }), entry.pattern, entry.name);
    }
    const userinfo = await githubRaw();
    await assert.rejects(
      () => installManifest(root, userinfo, { botId: "missing", fields: { mcpUrl: "http://user:pass@127.0.0.1/mcp" }, secrets: { "github-token": SECRET } }, { env: fileEnv(root) }),
      /credentials/,
    );
    await assert.rejects(
      () => installManifest(root, userinfo, { botId: "missing", fields: { mcpUrl: "not a url" }, secrets: { "github-token": SECRET } }, { env: fileEnv(root) }),
      /http or https/,
    );
    assert.equal(await readFile(path.join(root, "plugins.json"), "utf8").catch(() => ""), "");
    assert.deepEqual(await readdir(path.join(root, "skills")).catch(() => []), []);
    assert.equal(await readFile(path.join(root, "vault.enc"), "utf8").catch(() => ""), "");
    assert.equal(await readFile(path.join(root, "mcp-secrets.json"), "utf8").catch(() => ""), "");
    assert.equal(await readFile(path.join(root, "state.json"), "utf8").catch(() => ""), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plugin installs on one bot, and a probe failure keeps the vault item", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-plugin-install-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-plugin-install-ws-"));
  const env = fileEnv(root);
  const mock = await startMockMcp("ok", SECRET);
  const down = await startMockMcp("down");
  const sending = await startMockMcp("send", SECRET);
  try {
    const ada = await createBot(botInput("Ada", workspace), root);
    const linus = await createBot(botInput("Linus", workspace), root);
    const installed = await installPlugin(root, "github", {
      botId: ada.id,
      fields: { mcpUrl: mock.url },
      secrets: { "github-token": SECRET },
    }, { env });
    assert.deepEqual(installed, { ok: true, pluginId: "github", botId: ada.id });
    assert.equal(JSON.stringify(installed).includes(SECRET), false);
    const state = await readFile(path.join(root, "state.json"), "utf8");
    const record = await readFile(path.join(root, "plugins.json"), "utf8");
    const audit = await readFile(path.join(root, "audit.json"), "utf8");
    assert.equal(state.includes(SECRET), false);
    assert.equal(record.includes(SECRET), false);
    assert.equal(audit.includes(SECRET), false);
    assert.equal(await readMcpSecret(root, ada.id, "github"), SECRET);
    assert.equal(await readMcpSecret(root, linus.id, "github"), undefined);
    assert.equal((await readVaultSecret(root, "github-token", env)), SECRET);
    const adaBot = await findBot(ada.id, root);
    assert.equal(adaBot?.mcpServers?.[0]?.name, "github");
    assert.equal(adaBot?.mcpServers?.[0]?.url, mock.url);
    const skillId = skillIdFromName("Work a GitHub issue");
    assert.equal((await visibleSkillCatalog(root, ada.id)).some((skill) => skill.name === `skill:${skillId}`), true);
    assert.equal((await visibleSkillCatalog(root, linus.id)).some((skill) => skill.name === `skill:${skillId}`), false);
    assert.equal((await visibleSkillCatalog(root, undefined)).some((skill) => skill.name === `skill:${skillId}`), false);
    assert.equal((await visibleSkillCatalog(root, linus.id)).some((skill) => skill.name === "skill:review-a-diff"), true);
    await assert.rejects(
      () => installPlugin(root, "github", { botId: linus.id, fields: { mcpUrl: mock.url }, secrets: { "github-token": SECRET } }, { env }),
      /already exists/,
    );
    await installPlugin(root, "github", { botId: linus.id, fields: { mcpUrl: mock.url } }, { env });
    assert.equal((await visibleSkillCatalog(root, linus.id)).some((skill) => skill.name === `skill:${skillId}`), true);
    assert.deepEqual(await readdir(path.join(root, "skills", skillId)), ["SKILL.md"]);
    const rule = await saveDenyRule(root, "mcp:github/create_issue");
    const decision = await gateTool(root, "mcp:github/create_issue", "");
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.ruleId, rule.id);
      await recordAudit(root, { outcome: "refused", action: "mcp:github/create_issue", ruleId: decision.ruleId, detail: decision.detail });
      const rows = await listAudit(root);
      assert.equal(rows.some((row) => row.outcome === "refused" && row.detail.includes(rule.id)), true);
    }
    const slack = await installPlugin(root, "slack-drafts", { botId: ada.id }, { env });
    assert.equal(slack.pluginId, "slack-drafts");
    assert.equal((await visibleSkillCatalog(root, linus.id)).some((skill) => skill.name === "skill:draft-a-slack-reply"), false);
    const google = await installPlugin(root, "google", { botId: ada.id }, { env });
    assert.equal(google.ok, true);

    const probeBot = await createBot(botInput("Probe", workspace), root);
    await assert.rejects(
      () => installPlugin(root, "linear", { botId: probeBot.id, fields: { mcpUrl: down.url }, secrets: { "linear-token": SECRET } }, { env }),
      /500|unavailable|failed/i,
    );
    assert.equal(await readMcpSecret(root, probeBot.id, "linear"), undefined);
    assert.equal(((await findBot(probeBot.id, root))?.mcpServers ?? []).some((server) => server.name === "linear"), false);
    assert.equal((await publicVault(root, env)).items.some((item) => item.name === "linear-token"), true);
    assert.equal((await visibleSkillCatalog(root, probeBot.id)).some((skill) => skill.name === "skill:work-a-linear-issue"), false);
    assert.equal((await readFile(path.join(root, "plugins.json"), "utf8")).includes("linear"), false);

    await assert.rejects(
      () => installPlugin(root, "sentry", { botId: probeBot.id, fields: { mcpUrl: sending.url }, secrets: { "sentry-token": SECRET } }, { env }),
      /sends/,
    );
    assert.equal((await publicVault(root, env)).items.some((item) => item.name === "sentry-token"), true);
    assert.equal((await visibleSkillCatalog(root, probeBot.id)).some((skill) => skill.name === "skill:read-a-sentry-issue"), false);
  } finally {
    await mock.close();
    await down.close();
    await sending.close();
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("uninstall keeps an edited skill and the vault item unless saved secrets are deleted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-plugin-remove-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-plugin-remove-ws-"));
  const env = fileEnv(root);
  const mock = await startMockMcp("ok", SECRET);
  try {
    const ada = await createBot(botInput("Ada", workspace), root);
    const linus = await createBot(botInput("Linus", workspace), root);
    await installPlugin(root, "github", { botId: ada.id, fields: { mcpUrl: mock.url }, secrets: { "github-token": SECRET } }, { env });
    await installPlugin(root, "github", { botId: linus.id, fields: { mcpUrl: mock.url } }, { env });
    const skillId = skillIdFromName("Work a GitHub issue");
    const skillPath = path.join(root, "skills", skillId, "SKILL.md");
    const original = await readFile(skillPath, "utf8");
    await writeFile(skillPath, original.replace("Do not merge.", "Do not merge. Edited locally."));
    assert.notEqual(skillBodyChecksum("1. Read the issue.\n2. Draft a plan and wait for approval.\n3. Do not merge."), skillBodyChecksum("1. Read the issue.\n2. Draft a plan and wait for approval.\n3. Do not merge. Edited locally."));
    const removed = await uninstallPlugin(root, "github", { botId: ada.id, deleteSecrets: false }, { env });
    assert.deepEqual(removed.keptSkills, []);
    assert.equal(await readMcpSecret(root, ada.id, "github"), undefined);
    assert.equal(await readMcpSecret(root, linus.id, "github"), SECRET);
    assert.equal((await publicVault(root, env)).items.some((item) => item.name === "github-token"), true);
    assert.equal((await readFile(skillPath, "utf8")).includes("Edited locally"), true);
    const last = await uninstallPlugin(root, "github", { botId: linus.id, deleteSecrets: true }, { env });
    assert.deepEqual(last.keptSkills, [skillId]);
    assert.equal((await readFile(skillPath, "utf8")).includes("Edited locally"), true);
    assert.equal((await publicVault(root, env)).items.some((item) => item.name === "github-token"), false);
    assert.equal(await readMcpSecret(root, linus.id, "github"), undefined);

    const fresh = await createBot(botInput("Grace", workspace), root);
    await installPlugin(root, "figma", { botId: fresh.id, fields: { mcpUrl: mock.url }, secrets: { "figma-token": SECRET } }, { env });
    const figmaId = skillIdFromName("Read a Figma file");
    await uninstallPlugin(root, "figma", { botId: fresh.id }, { env });
    assert.equal(await readFile(path.join(root, "skills", figmaId, "SKILL.md"), "utf8").catch(() => ""), "");
    assert.equal((await publicVault(root, env)).items.some((item) => item.name === "figma-token"), true);
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the plugins tab lists shipped cards and the install route does not echo a secret", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-plugin-http-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ocp-plugin-http-ws-"));
  const mock = await startMockMcp("ok", SECRET);
  const app = await startProductApp({
    root,
    port: 0,
    env: fileEnv(root),
  });
  try {
    const page = await fetch(app.url);
    const html = await page.text();
    assert.match(html, /data-tab="plugins"/);
    assert.match(html, /id="pluginSearch"/);
    assert.match(html, /id="pluginList"/);
    assert.match(html, /A checksum proves the manifest\. It does not constrain the remote server after install/);
    assert.match(html, /Draft only/);
    assert.match(html, /also delete saved secrets/);
    assert.match(html, /addEventListener\('input',\(\)=>renderPlugins\(\)\)/);
    const pane = /id="tab-plugins"[\s\S]*?<div id="tab-channels"/.exec(html)?.[0] ?? "";
    assert.match(pane, /Install a plugin on one bot/);
    assert.doesNotMatch(pane, /voice/i);
    assert.doesNotMatch(pane, /color\s*:/);
    const inlineScript = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    assert.doesNotThrow(() => new Function(inlineScript));
    assert.match(inlineScript, /function renderPlugins\(\)\{[\s\S]*state\.plugins/);
    assert.match(inlineScript, /#pluginSearch'\)\.addEventListener\('input',\(\)=>renderPlugins\(\)\)/);
    const open = await fetch(`${app.url}/api/plugins`);
    assert.equal(open.status, 200);
    const catalog = await open.json() as { version: string; plugins: Array<{ id: string; draftOnly: boolean; checksumPrefix: string; secrets: Array<{ label: string }> }> };
    assert.equal(catalog.version, "0.2.0");
    assert.equal(catalog.plugins.length, 14);
    assert.equal(catalog.plugins.find((plugin) => plugin.id === "whatsapp-drafts")?.draftOnly, true);
    assert.equal(JSON.stringify(catalog).includes(SECRET), false);
    const github = (await rawCatalog()).find((plugin) => plugin.id === "github");
    assert.equal(catalog.plugins.find((plugin) => plugin.id === "github")?.checksumPrefix, checksumPrefix(github?.checksum ?? ""));
    const denied = await fetch(`${app.url}/api/plugins/github/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "x" }),
    });
    assert.equal(denied.status, 403);
    const token = /const TOKEN='([a-f0-9]+)'/.exec(inlineScript)?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const created = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...botInput("Ada", workspace) }),
    });
    const ada = await created.json() as { bot: { id: string } };
    const response = await fetch(`${app.url}/api/plugins/github/install`, {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: ada.bot.id, fields: { mcpUrl: mock.url }, secrets: { "github-token": SECRET } }),
    });
    const body = await response.json() as { ok?: boolean; error?: string; pluginId?: string; botId?: string };
    assert.equal(response.status, 200, body.error);
    assert.deepEqual(Object.keys(body).sort(), ["botId", "ok", "pluginId"]);
    assert.equal(JSON.stringify(body).includes(SECRET), false);
    const state = await readFile(path.join(root, "state.json"), "utf8");
    assert.equal(state.includes(SECRET), false);
    assert.equal(await readMcpSecret(root, ada.bot.id, "github"), SECRET);
  } finally {
    await app.close();
    await mock.close();
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
