import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { accountToolNeedsApproval, clearAccountAccessTokens, runAccountTool } from "./accounts.js";
import { startProductApp } from "./server.js";
import { readVaultSecret } from "./vault.js";

const GOOGLE_SECRET = "google-client-secret-!@#";
const GOOGLE_REFRESH = "refresh-google-secret-!@#";
const MICROSOFT_SECRET = "ms-client-secret-!@#";
const MICROSOFT_REFRESH = "refresh-ms-secret-!@#";

interface Hit { method: string; url: string; body: string; auth: string }

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ocp-accounts-"));
}

function startMock(): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = req.url ?? "/";
    const auth = String(req.headers.authorization ?? "");
    hits.push({ method: req.method ?? "GET", url, body, auth });
    const pathOnly = url.split("?")[0] ?? url;
    const allowed = auth === "Bearer access-google" || auth === "Bearer access-google-2" || auth === "Bearer access-ms" || auth === "Bearer access-ms-2";
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && pathOnly === "/google/token") {
      const params = new URLSearchParams(body);
      if (params.get("client_secret") !== GOOGLE_SECRET) return json(401, { error: "unauthorized_client" });
      if (params.get("grant_type") === "authorization_code" && !params.get("code_verifier")) return json(400, { error: "missing_verifier" });
      return json(200, {
        access_token: params.get("grant_type") === "refresh_token" ? "access-google-2" : "access-google",
        refresh_token: GOOGLE_REFRESH,
        token_type: "Bearer",
      });
    }
    if (req.method === "POST" && pathOnly === "/microsoft/token") {
      const params = new URLSearchParams(body);
      if (params.get("client_secret") !== MICROSOFT_SECRET) return json(401, { error: "unauthorized_client" });
      if (params.get("grant_type") === "authorization_code" && !params.get("code_verifier")) return json(400, { error: "missing_verifier" });
      return json(200, {
        access_token: params.get("grant_type") === "refresh_token" ? "access-ms-2" : "access-ms",
        refresh_token: MICROSOFT_REFRESH,
        token_type: "Bearer",
      });
    }
    if (!allowed) return json(401, { error: "bad_token" });
    if (pathOnly === "/gmail/v1/users/me/profile") return json(200, { emailAddress: "ada@example.com" });
    if (pathOnly === "/gmail/v1/users/me/messages" && req.method === "GET") return json(200, { messages: [{ id: "m1" }] });
    if (pathOnly === "/gmail/v1/users/me/messages/m1") {
      return json(200, { id: "m1", snippet: "Invoice 42", payload: { headers: [{ name: "Subject", value: "Invoice" }] } });
    }
    if (pathOnly === "/gmail/v1/users/me/drafts" && req.method === "POST") return json(200, { id: "d1" });
    if (pathOnly === "/calendar/v3/calendars/primary/events" && req.method === "GET") return json(200, { items: [{ id: "e1", summary: "Standup" }] });
    if (pathOnly === "/calendar/v3/calendars/primary/events" && req.method === "POST") return json(200, { id: "e2", summary: "Review" });
    if (pathOnly === "/drive/v3/files" && req.method === "GET") return json(200, { files: [{ id: "f1", name: "notes.txt" }] });
    if (pathOnly === "/drive/v3/files/f1") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello from drive");
      return;
    }
    if (pathOnly === "/v1.0/me" && req.method === "GET") return json(200, { mail: "ada@example.com" });
    if (pathOnly === "/v1.0/me/messages" && req.method === "GET") return json(200, { value: [{ id: "om1", subject: "Invoice" }] });
    if (pathOnly === "/v1.0/me/messages/om1") return json(200, { id: "om1", subject: "Invoice", bodyPreview: "Invoice 42" });
    if (pathOnly === "/v1.0/me/messages" && req.method === "POST") return json(201, { id: "od1", isDraft: true });
    if (pathOnly === "/v1.0/me/events" && req.method === "GET") return json(200, { value: [{ id: "oe1", subject: "Standup" }] });
    if (pathOnly === "/v1.0/me/events" && req.method === "POST") return json(201, { id: "oe2" });
    if (pathOnly.startsWith("/v1.0/me/drive/root/search")) return json(200, { value: [{ id: "of1", name: "notes.txt" }] });
    if (pathOnly === "/v1.0/me/drive/items/of1/content") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello from onedrive");
      return;
    }
    json(404, { error: "not_found", path: pathOnly });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("mock did not bind");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        hits,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("bring-your-own Google and Microsoft clients use loopback PKCE and keep tokens in the vault", async () => {
  const root = await tempRoot();
  const mock = await startMock();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    HERMES_HOME: root,
    OCP_DATA_DIR: root,
    OCP_VAULT_BACKEND: "file",
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
    const html = await (await fetch(app.url)).text();
    assert.match(html, /OCP ships no OAuth client/);
    assert.match(html, /Connect Google with these scopes/);
    assert.match(html, /Connect Microsoft with these scopes/);
    assert.match(html, /gmail\.readonly/);
    assert.match(html, /Files\.Read/);
    assert.doesNotMatch(html, /gmail\.send/);
    assert.doesNotMatch(html, /Mail\.Send/);
    const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    await writeFile(path.join(root, "dash.js"), script);
    const rechecked = spawnSync(process.execPath, ["--check", path.join(root, "dash.js")], { encoding: "utf8" });
    assert.equal(rechecked.status, 0, rechecked.stderr);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec((await fetch(app.url)).headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const refused = await fetch(`${app.url}/api/accounts/google/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ acceptScopes: true }),
    });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /OCP ships no client/);
    const unconfirmed = await fetch(`${app.url}/api/accounts/google/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ acceptScopes: false }),
    });
    assert.equal(unconfirmed.status, 400);

    const saved = await fetch(`${app.url}/api/accounts/google/client`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientId: "google-client-id", clientSecret: GOOGLE_SECRET }),
    });
    const savedText = await saved.text();
    assert.equal(saved.status, 200);
    assert.equal(savedText.includes(GOOGLE_SECRET), false);
    const startedRes = await fetch(`${app.url}/api/accounts/google/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ acceptScopes: true }),
    });
    const started = await startedRes.json() as { authorizeUrl: string; scopes: Array<{ id: string }> };
    const authorize = new URL(started.authorizeUrl);
    assert.equal(authorize.origin, mock.url);
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("response_type"), "code");
    assert.equal(authorize.searchParams.get("client_id"), "google-client-id");
    assert.equal(authorize.searchParams.has("client_secret"), false);
    const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    assert.equal(redirect.hostname, "127.0.0.1");
    assert.match(redirect.pathname, /\/api\/accounts\/google\/callback$/);
    const scopes = (authorize.searchParams.get("scope") ?? "").split(" ");
    assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.readonly"));
    assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.compose"));
    assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.readonly"));
    assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.events"));
    assert.ok(scopes.includes("https://www.googleapis.com/auth/drive.readonly"));
    assert.equal(scopes.includes("https://www.googleapis.com/auth/gmail.send"), false);
    assert.equal(scopes.includes("https://www.googleapis.com/auth/gmail.modify"), false);
    assert.equal(scopes.includes("https://www.googleapis.com/auth/drive"), false);
    assert.equal(started.scopes.map((scope) => scope.id).join(" "), scopes.join(" "));

    const callback = await fetch(`${redirect.origin}${redirect.pathname}?code=local-code&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`);
    const callbackText = await callback.text();
    assert.equal(callback.status, 200);
    assert.match(callbackText, /ada@example.com/);
    assert.equal(callbackText.includes(GOOGLE_SECRET), false);
    assert.equal(callbackText.includes(GOOGLE_REFRESH), false);
    const tokenHit = mock.hits.find((hit) => hit.url === "/google/token" && hit.body.includes("authorization_code"));
    assert.ok(tokenHit);
    const tokenBody = new URLSearchParams(tokenHit.body);
    const verifier = tokenBody.get("code_verifier") ?? "";
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), authorize.searchParams.get("code_challenge"));
    assert.equal(tokenBody.get("client_secret"), GOOGLE_SECRET);
    const state = await (await fetch(`${app.url}/api/state`)).text();
    assert.equal(state.includes(GOOGLE_SECRET), false);
    assert.equal(state.includes(GOOGLE_REFRESH), false);
    assert.equal(state.includes("access-google"), false);
    const disk = await readFile(path.join(root, "vault.enc"), "utf8");
    assert.equal(disk.includes(GOOGLE_SECRET), false);
    assert.equal(disk.includes(GOOGLE_REFRESH), false);
    assert.equal(await readVaultSecret(root, "google-oauth-refresh", env), GOOGLE_REFRESH);

    const search = await runAccountTool(root, "gmail_search", { query: "invoice" }, env);
    assert.equal(search.ok, true);
    assert.match(search.text, /Invoice/);
    assert.equal(search.text.includes(GOOGLE_REFRESH), false);
    assert.equal(search.text.includes("access-google"), false);
    clearAccountAccessTokens();
    const refreshed = await runAccountTool(root, "gmail_read", { id: "m1" }, env);
    assert.match(refreshed.text, /Invoice 42/);
    assert.ok(mock.hits.some((hit) => hit.url === "/google/token" && hit.body.includes("refresh_token")));
    const draft = await runAccountTool(root, "gmail_draft", { to: "ada@example.com", subject: "Invoice", body: "Please review" }, env);
    assert.match(draft.text, /was not sent/);
    const draftHit = mock.hits.find((hit) => hit.method === "POST" && hit.url === "/gmail/v1/users/me/drafts");
    assert.ok(draftHit);
    const raw = JSON.parse(draftHit.body).message.raw as string;
    assert.match(Buffer.from(raw, "base64url").toString("utf8"), /Subject: Invoice/);
    const created = await runAccountTool(root, "calendar_create", { summary: "Review", start: "2026-10-23T15:00:00Z", end: "2026-10-23T15:30:00Z" }, env);
    assert.match(created.text, /e2/);
    const drive = await runAccountTool(root, "drive_read", { id: "f1" }, env);
    assert.equal(drive.text, "hello from drive");
    assert.equal(mock.hits.some((hit) => /send/i.test(hit.url)), false);

    await fetch(`${app.url}/api/accounts/microsoft/client`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientId: "ms-client-id", clientSecret: MICROSOFT_SECRET }),
    });
    const msStarted = await (await fetch(`${app.url}/api/accounts/microsoft/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ acceptScopes: true }),
    })).json() as { authorizeUrl: string };
    const msAuth = new URL(msStarted.authorizeUrl);
    const msScopes = (msAuth.searchParams.get("scope") ?? "").split(" ");
    assert.ok(msScopes.includes("https://graph.microsoft.com/Mail.Read"));
    assert.ok(msScopes.includes("https://graph.microsoft.com/Mail.ReadWrite"));
    assert.ok(msScopes.includes("https://graph.microsoft.com/Calendars.Read"));
    assert.ok(msScopes.includes("https://graph.microsoft.com/Calendars.ReadWrite"));
    assert.ok(msScopes.includes("https://graph.microsoft.com/Files.Read"));
    assert.equal(msScopes.includes("https://graph.microsoft.com/Mail.Send"), false);
    assert.equal(msScopes.includes("https://graph.microsoft.com/Files.ReadWrite"), false);
    assert.equal(msAuth.searchParams.has("client_secret"), false);
    const msRedirect = new URL(msAuth.searchParams.get("redirect_uri") ?? "");
    assert.equal(msRedirect.hostname, "127.0.0.1");
    const msCallback = await fetch(`${msRedirect.origin}${msRedirect.pathname}?code=ms-code&state=${encodeURIComponent(msAuth.searchParams.get("state") ?? "")}`);
    assert.equal(msCallback.status, 200);
    assert.equal((await msCallback.text()).includes(MICROSOFT_REFRESH), false);
    const outlook = await runAccountTool(root, "outlook_draft", { to: "ada@example.com", subject: "Invoice", body: "Draft only" }, env);
    assert.match(outlook.text, /was not sent/);
    const outlookHit = mock.hits.find((hit) => hit.method === "POST" && hit.url === "/v1.0/me/messages");
    assert.ok(outlookHit);
    assert.equal(JSON.parse(outlookHit.body).isDraft, true);
    const one = await runAccountTool(root, "onedrive_read", { id: "of1" }, env);
    assert.equal(one.text, "hello from onedrive");
    assert.equal(mock.hits.some((hit) => /sendMail|\/send\b/i.test(hit.url)), false);
    const listed = await (await fetch(`${app.url}/api/state`)).text();
    assert.equal(listed.includes(MICROSOFT_SECRET), false);
    assert.equal(listed.includes(MICROSOFT_REFRESH), false);
    assert.equal((await readFile(path.join(root, "vault.enc"), "utf8")).includes(MICROSOFT_REFRESH), false);

    assert.equal(accountToolNeedsApproval("calendar_create", {}), true);
    assert.equal(accountToolNeedsApproval("gmail_search", {}), true);
    assert.equal(accountToolNeedsApproval("tool_call", { name: "outlook_calendar_create" }), true);
    assert.equal(accountToolNeedsApproval("workspace_read", {}), false);
    const runtime = await readFile(new URL("./native-acp.js", import.meta.url), "utf8");
    assert.match(runtime, /accountToolNeedsApproval/);
    const expired = await fetch(`${app.url}/api/accounts/google/callback?code=nope&state=missing`);
    assert.equal(expired.status, 400);
    assert.match(await expired.text(), /No token was stored/);
    await fetch(`${app.url}/api/accounts/google/disconnect`, { method: "POST", headers, body: "{}" });
    const after = await (await fetch(`${app.url}/api/accounts`)).json() as { google: { connected: boolean; clientConfigured: boolean } };
    assert.equal(after.google.connected, false);
    assert.equal(after.google.clientConfigured, true);
  } finally {
    clearAccountAccessTokens();
    await app.close();
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});
