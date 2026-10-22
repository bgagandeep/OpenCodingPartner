import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clearAccountAccessTokens, runAccountTool } from "./accounts.js";
import { startProductApp } from "./server.js";

const GOOGLE_SECRET = "google-client-secret-!@#";
const GOOGLE_REFRESH = "refresh-google-secret-!@#";
const MICROSOFT_SECRET = "ms-client-secret-!@#";
const MICROSOFT_REFRESH = "refresh-ms-secret-!@#";
const PROVIDER_LEAK = "SECRET_PROVIDER_BODY";

interface Hit { method: string; url: string }

function startMock(): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    Buffer.concat(chunks);
    const url = req.url ?? "/";
    const pathOnly = url.split("?")[0] ?? url;
    hits.push({ method: req.method ?? "GET", url: pathOnly });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && (pathOnly === "/google/token" || pathOnly === "/microsoft/token")) {
      const refresh = pathOnly.startsWith("/google") ? GOOGLE_REFRESH : MICROSOFT_REFRESH;
      return json(200, { access_token: pathOnly.startsWith("/google") ? "access-google" : "access-ms", refresh_token: refresh, token_type: "Bearer" });
    }
    if (pathOnly === "/gmail/v1/users/me/profile") return json(200, { emailAddress: "ada@example.com" });
    if (pathOnly === "/gmail/v1/users/me/drafts" && req.method === "POST") return json(200, { id: "d1" });
    if (pathOnly === "/gmail/v1/users/me/drafts/d1/send" && req.method === "POST") return json(200, { id: "d1" });
    if (pathOnly === "/v1.0/me") return json(200, { mail: "ada@example.com" });
    if (pathOnly === "/v1.0/me/messages" && req.method === "POST") return json(201, { id: "od-fail", isDraft: true });
    if (pathOnly === "/v1.0/me/messages/od-fail/send") return json(500, { error: PROVIDER_LEAK });
    json(404, { error: "not_found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("mock did not bind");
      resolve({ url: `http://127.0.0.1:${address.port}`, hits, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function connect(appUrl: string, headers: Record<string, string>, provider: "google" | "microsoft", clientId: string, clientSecret: string): Promise<void> {
  const saved = await fetch(`${appUrl}/api/accounts/${provider}/client`, {
    method: "POST",
    headers,
    body: JSON.stringify({ clientId, clientSecret }),
  });
  assert.equal(saved.status, 200);
  const started = await (await fetch(`${appUrl}/api/accounts/${provider}/start`, {
    method: "POST",
    headers,
    body: JSON.stringify({ acceptScopes: true }),
  })).json() as { authorizeUrl: string };
  const authorize = new URL(started.authorizeUrl);
  const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  const callback = await fetch(`${redirect.origin}${redirect.pathname}?code=local-code&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`);
  assert.equal(callback.status, 200);
}

test("a person sends a queued mail draft, and a rejected send is not marked sent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-drafts-"));
  const mock = await startMock();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    HERMES_HOME: root,
    OCP_DATA_DIR: root,
    OCP_VAULT_BACKEND: "file",
    OCP_ACTOR_BOT_ID: "bot-ada",
    OCP_GOOGLE_AUTH_URL: `${mock.url}/google/authorize`,
    OCP_GOOGLE_TOKEN_URL: `${mock.url}/google/token`,
    OCP_GOOGLE_API_URL: mock.url,
    OCP_MICROSOFT_AUTH_URL: `${mock.url}/microsoft/authorize`,
    OCP_MICROSOFT_TOKEN_URL: `${mock.url}/microsoft/token`,
    OCP_MICROSOFT_API_URL: mock.url,
  };
  clearAccountAccessTokens();
  const app = await startProductApp({ root, port: 0, env });
  try {
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec((await fetch(app.url)).headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    await connect(app.url, headers, "google", "google-client-id", GOOGLE_SECRET);
    const before = mock.hits.length;
    const queued = await runAccountTool(root, "gmail_draft", { to: "ada@example.com", subject: "Invoice", body: "Please review" }, env);
    assert.match(queued.text, /Saved a Gmail draft/);
    assert.equal(mock.hits.slice(before).some((hit) => /drafts|send/.test(hit.url)), false);
    const state = await (await fetch(`${app.url}/api/state`)).json() as { channelLog: Array<{ id: string; channel: string; status: string; subject?: string }> };
    assert.equal(JSON.stringify(state).includes(GOOGLE_SECRET), false);
    assert.equal(JSON.stringify(state).includes(GOOGLE_REFRESH), false);
    const draft = state.channelLog.find((entry) => entry.channel === "gmail" && entry.status === "draft");
    assert.ok(draft);
    assert.equal(draft.subject, "Invoice");
    const sent = await fetch(`${app.url}/api/channels/drafts/${encodeURIComponent(draft.id)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "allow" }),
    });
    assert.equal(sent.status, 200);
    assert.equal(mock.hits.some((hit) => hit.url === "/gmail/v1/users/me/drafts/d1/send"), true);
    const afterSend = await (await fetch(`${app.url}/api/state`)).json() as { channelLog: Array<{ id: string; status: string }> };
    assert.equal(afterSend.channelLog.find((entry) => entry.id === draft.id)?.status, "sent");

    await connect(app.url, headers, "microsoft", "ms-client-id", MICROSOFT_SECRET);
    const denied = await runAccountTool(root, "outlook_draft", { to: "ada@example.com", subject: "Hold", body: "Do not send this" }, env);
    assert.match(denied.text, /Nothing was sent/);
    const heldState = await (await fetch(`${app.url}/api/state`)).json() as { channelLog: Array<{ id: string; channel: string; status: string; text: string }> };
    const held = heldState.channelLog.find((entry) => entry.channel === "outlook" && entry.status === "draft");
    assert.ok(held);
    const hitsBeforeDeny = mock.hits.length;
    const deny = await fetch(`${app.url}/api/channels/drafts/${encodeURIComponent(held.id)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "deny" }),
    });
    assert.equal(deny.status, 200);
    assert.equal(mock.hits.length, hitsBeforeDeny);
    const deniedState = await (await fetch(`${app.url}/api/state`)).json() as { channelLog: Array<{ id: string; status: string }> };
    assert.equal(deniedState.channelLog.find((entry) => entry.id === held.id)?.status, "denied");

    const failing = await runAccountTool(root, "outlook_draft", { to: "ada@example.com", subject: "Nope", body: "Provider will reject" }, env);
    assert.equal(failing.ok, true);
    const failState = await (await fetch(`${app.url}/api/state`)).json() as { channelLog: Array<{ id: string; channel: string; status: string; subject?: string }> };
    const failDraft = failState.channelLog.find((entry) => entry.channel === "outlook" && entry.status === "draft" && entry.subject === "Nope");
    assert.ok(failDraft);
    const failed = await fetch(`${app.url}/api/channels/drafts/${encodeURIComponent(failDraft.id)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "allow" }),
    });
    assert.equal(failed.status, 409);
    const finalState = await (await fetch(`${app.url}/api/state`)).text();
    assert.match(finalState, /"status":"failed"/);
    assert.equal(finalState.includes(PROVIDER_LEAK), false);
    assert.equal(finalState.includes(MICROSOFT_SECRET), false);
    assert.equal(finalState.includes(MICROSOFT_REFRESH), false);
    assert.equal(finalState.includes("access-ms"), false);
  } finally {
    clearAccountAccessTokens();
    await app.close();
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});
