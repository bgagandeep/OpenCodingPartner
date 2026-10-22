import { createHash, randomBytes } from "node:crypto";
import { appendChannelLog } from "./index.js";
import { deleteVaultItemByName, publicVault, readVaultSecret, upsertVaultItem } from "./vault.js";

export type AccountProvider = "google" | "microsoft";

export interface AccountScope {
  id: string;
  label: string;
}

export const GOOGLE_SCOPES: AccountScope[] = [
  { id: "openid", label: "Sign-in" },
  { id: "email", label: "Account address" },
  { id: "https://www.googleapis.com/auth/gmail.readonly", label: "Gmail read and search" },
  { id: "https://www.googleapis.com/auth/gmail.compose", label: "Gmail drafts. A person sends from a draft card." },
  { id: "https://www.googleapis.com/auth/calendar.readonly", label: "Calendar read" },
  { id: "https://www.googleapis.com/auth/calendar.events", label: "Calendar create. OCP asks before creating an event." },
  { id: "https://www.googleapis.com/auth/drive.readonly", label: "Drive search and read" },
];

export const MICROSOFT_SCOPES: AccountScope[] = [
  { id: "offline_access", label: "Refresh token" },
  { id: "https://graph.microsoft.com/User.Read", label: "Signed-in account address" },
  { id: "https://graph.microsoft.com/Mail.Read", label: "Outlook read and search" },
  { id: "https://graph.microsoft.com/Mail.ReadWrite", label: "Outlook drafts. A person sends from a draft card." },
  { id: "https://graph.microsoft.com/Mail.Send", label: "Outlook send. Only a person sends, from a draft card." },
  { id: "https://graph.microsoft.com/Calendars.Read", label: "Outlook calendar read" },
  { id: "https://graph.microsoft.com/Calendars.ReadWrite", label: "Outlook calendar create. OCP asks before creating an event." },
  { id: "https://graph.microsoft.com/Files.Read", label: "OneDrive search and read" },
];

const ACCOUNT_TOOL_NAMES = new Set([
  "gmail_search",
  "gmail_read",
  "gmail_draft",
  "calendar_list",
  "calendar_create",
  "drive_search",
  "drive_read",
  "outlook_search",
  "outlook_read",
  "outlook_draft",
  "outlook_calendar_list",
  "outlook_calendar_create",
  "onedrive_search",
  "onedrive_read",
]);

const ACCOUNT_WRITE_NAMES = new Set(["gmail_draft", "calendar_create", "outlook_draft", "outlook_calendar_create"]);

export class AccountError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface PendingLogin {
  provider: AccountProvider;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

const pendingLogins = new Map<string, PendingLogin>();
const accessTokens = new Map<AccountProvider, string>();

export function clearAccountAccessTokens(): void {
  accessTokens.clear();
}

function clientName(provider: AccountProvider): string {
  return `${provider}-oauth-client`;
}

function refreshName(provider: AccountProvider): string {
  return `${provider}-oauth-refresh`;
}

function scopesFor(provider: AccountProvider): AccountScope[] {
  return provider === "google" ? GOOGLE_SCOPES : MICROSOFT_SCOPES;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, max) : "";
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function endpoint(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : fallback;
}

function googleAuthUrl(env: NodeJS.ProcessEnv): string {
  return endpoint(env, "OCP_GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth");
}

function googleTokenUrl(env: NodeJS.ProcessEnv): string {
  return endpoint(env, "OCP_GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token");
}

function googleApiUrl(env: NodeJS.ProcessEnv): string {
  return endpoint(env, "OCP_GOOGLE_API_URL", "https://www.googleapis.com");
}

function microsoftAuthUrl(env: NodeJS.ProcessEnv): string {
  return endpoint(env, "OCP_MICROSOFT_AUTH_URL", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
}

function microsoftTokenUrl(env: NodeJS.ProcessEnv): string {
  return endpoint(env, "OCP_MICROSOFT_TOKEN_URL", "https://login.microsoftonline.com/common/oauth2/v2.0/token");
}

function microsoftApiUrl(env: NodeJS.ProcessEnv): string {
  return endpoint(env, "OCP_MICROSOFT_API_URL", "https://graph.microsoft.com");
}

function assertLoopbackRedirect(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AccountError("OAuth redirect must be an http loopback URL.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || (host !== "127.0.0.1" && host !== "localhost" && host !== "::1")) {
    throw new AccountError("OAuth redirect must stay on loopback.");
  }
  return url.toString();
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function prunePending(now = Date.now()): void {
  for (const [state, pending] of pendingLogins) {
    if (now - pending.createdAt > 10 * 60_000) pendingLogins.delete(state);
  }
}

export async function publicAccounts(root: string, env: NodeJS.ProcessEnv = process.env): Promise<{
  note: string;
  google: { clientConfigured: boolean; clientId: string; connected: boolean; account: string };
  microsoft: { clientConfigured: boolean; clientId: string; connected: boolean; account: string };
  googleScopes: AccountScope[];
  microsoftScopes: AccountScope[];
}> {
  const vault = await publicVault(root, env);
  const byName = new Map(vault.items.map((item) => [item.name, item]));
  const view = (provider: AccountProvider) => {
    const client = byName.get(clientName(provider));
    const refresh = byName.get(refreshName(provider));
    return {
      clientConfigured: Boolean(client),
      clientId: client?.account ?? "",
      connected: Boolean(refresh),
      account: refresh?.account ?? "",
    };
  };
  return {
    note: "OCP ships no OAuth client. Paste a client you created.",
    google: view("google"),
    microsoft: view("microsoft"),
    googleScopes: GOOGLE_SCOPES,
    microsoftScopes: MICROSOFT_SCOPES,
  };
}

export async function saveAccountClient(
  root: string,
  provider: AccountProvider,
  clientId: unknown,
  clientSecret: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ clientConfigured: true; clientId: string }> {
  const id = clean(clientId, 200);
  const secret = typeof clientSecret === "string" ? clientSecret : "";
  if (!id) throw new AccountError("Paste an OAuth client id. OCP ships no client.");
  if (!secret || secret.length > 8_000) throw new AccountError("Paste an OAuth client secret. OCP ships no client.");
  await upsertVaultItem(root, { name: clientName(provider), kind: "oauth", account: id, secret }, env);
  return { clientConfigured: true, clientId: id };
}

export async function disconnectAccount(root: string, provider: AccountProvider, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await deleteVaultItemByName(root, refreshName(provider), env);
  accessTokens.delete(provider);
}

export async function startAccountLogin(
  root: string,
  provider: AccountProvider,
  acceptScopes: unknown,
  redirectUri: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ authorizeUrl: string; scopes: AccountScope[]; redirectUri: string }> {
  if (acceptScopes !== true) throw new AccountError("Scopes must be accepted before consent.");
  const redirect = assertLoopbackRedirect(redirectUri);
  const clientId = (await publicAccounts(root, env))[provider].clientId;
  const clientSecret = await readVaultSecret(root, clientName(provider), env);
  if (!clientId || !clientSecret) throw new AccountError("Paste an OAuth client id and secret first. OCP ships no client.");
  prunePending();
  const { verifier, challenge } = pkce();
  const state = randomBytes(24).toString("base64url");
  pendingLogins.set(state, { provider, verifier, redirectUri: redirect, createdAt: Date.now() });
  const scopes = scopesFor(provider).map((scope) => scope.id).join(" ");
  const url = new URL(provider === "google" ? googleAuthUrl(env) : microsoftAuthUrl(env));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (provider === "google") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  } else {
    url.searchParams.set("prompt", "select_account");
  }
  return { authorizeUrl: url.toString(), scopes: scopesFor(provider), redirectUri: redirect };
}

async function tokenRequest(url: string, body: URLSearchParams): Promise<{ accessToken: string; refreshToken?: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new AccountError("Could not reach the OAuth token endpoint. No token was stored.");
  }
  if (!response.ok) throw new AccountError("Token exchange failed. No token was stored.");
  const parsed = await response.json().catch(() => undefined) as { access_token?: unknown; refresh_token?: unknown } | undefined;
  const accessToken = typeof parsed?.access_token === "string" ? parsed.access_token : "";
  const refreshToken = typeof parsed?.refresh_token === "string" ? parsed.refresh_token : undefined;
  if (!accessToken) throw new AccountError("Token exchange did not return an access token. No token was stored.");
  return { accessToken, refreshToken };
}

async function authorizedGet(url: string, accessToken: string): Promise<{ ok: boolean; status: number; text: string }> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text: scrub(text, [accessToken]) };
}

async function authorizedSend(
  url: string,
  accessToken: string,
  method: "GET" | "POST",
  body?: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body,
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text: scrub(text, [accessToken]) };
}

async function accessTokenFor(root: string, provider: AccountProvider, env: NodeJS.ProcessEnv): Promise<string> {
  const cached = accessTokens.get(provider);
  if (cached) return cached;
  const refreshToken = await readVaultSecret(root, refreshName(provider), env);
  const clientId = (await publicAccounts(root, env))[provider].clientId;
  const clientSecret = await readVaultSecret(root, clientName(provider), env);
  if (!refreshToken || !clientId || !clientSecret) throw new AccountError(`${provider === "google" ? "Google" : "Microsoft"} is not connected.`);
  const tokenUrl = provider === "google" ? googleTokenUrl(env) : microsoftTokenUrl(env);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const issued = await tokenRequest(tokenUrl, body);
  if (issued.refreshToken) {
    const current = await publicAccounts(root, env);
    await upsertVaultItem(root, {
      name: refreshName(provider),
      kind: "oauth",
      account: current[provider].account,
      secret: issued.refreshToken,
    }, env);
  }
  accessTokens.set(provider, issued.accessToken);
  return issued.accessToken;
}

async function accountEmail(provider: AccountProvider, accessToken: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (provider === "google") {
    const profile = await authorizedGet(`${googleApiUrl(env)}/gmail/v1/users/me/profile`, accessToken);
    if (!profile.ok) return "";
    try {
      const parsed = JSON.parse(profile.text) as { emailAddress?: unknown };
      return typeof parsed.emailAddress === "string" ? clean(parsed.emailAddress, 200) : "";
    } catch {
      return "";
    }
  }
  const profile = await authorizedGet(`${microsoftApiUrl(env)}/v1.0/me`, accessToken);
  if (!profile.ok) return "";
  let parsed: { mail?: unknown; userPrincipalName?: unknown };
  try {
    parsed = JSON.parse(profile.text) as { mail?: unknown; userPrincipalName?: unknown };
  } catch {
    return "";
  }
  const mail = typeof parsed.mail === "string" && parsed.mail ? parsed.mail : parsed.userPrincipalName;
  return typeof mail === "string" ? clean(mail, 200) : "";
}

export async function completeAccountLogin(options: {
  root: string;
  provider: AccountProvider;
  code: string;
  state: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ account: string }> {
  const env = options.env ?? process.env;
  prunePending();
  const pending = pendingLogins.get(options.state);
  pendingLogins.delete(options.state);
  if (!pending || pending.provider !== options.provider) throw new AccountError("This sign-in session expired. No token was stored.");
  if (!options.code) throw new AccountError("The provider did not return a code. No token was stored.");
  const clientId = (await publicAccounts(options.root, env))[options.provider].clientId;
  const clientSecret = await readVaultSecret(options.root, clientName(options.provider), env);
  if (!clientId || !clientSecret) throw new AccountError("Paste an OAuth client id and secret first. OCP ships no client.");
  const tokenUrl = options.provider === "google" ? googleTokenUrl(env) : microsoftTokenUrl(env);
  const issued = await tokenRequest(tokenUrl, new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: pending.redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: pending.verifier,
  }));
  if (!issued.refreshToken) throw new AccountError("The provider did not return a refresh token. No token was stored.");
  let account = "";
  try {
    account = await accountEmail(options.provider, issued.accessToken, env);
  } catch {
    account = "";
  }
  await upsertVaultItem(options.root, {
    name: refreshName(options.provider),
    kind: "oauth",
    account: account || options.provider,
    secret: issued.refreshToken,
  }, env);
  accessTokens.set(options.provider, issued.accessToken);
  return { account };
}

function requireId(value: unknown): string {
  const id = clean(value, 128);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new AccountError("Item id must be 1 to 128 letters, numbers, dashes, or underscores.");
  return id;
}

async function queueMailDraft(
  root: string,
  channel: "gmail" | "outlook",
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; text: string }> {
  const to = clean(args.to, 200);
  const subject = clean(args.subject, 200);
  const body = typeof args.body === "string" ? args.body.slice(0, 8_000) : "";
  const label = channel === "gmail" ? "Gmail" : "Outlook";
  if (!to || !subject || !body) return { ok: false, text: `A ${label} draft needs to, subject, and body. Nothing was sent.` };
  await appendChannelLog({
    channel,
    direction: "out",
    text: body,
    subject,
    ...(env.OCP_ACTOR_BOT_ID ? { botId: env.OCP_ACTOR_BOT_ID } : {}),
    destination: to,
    status: "draft",
  }, root);
  return { ok: true, text: `Saved a ${label} draft for you to send. Nothing was sent.` };
}

export async function deliverMailDraft(
  root: string,
  channel: "gmail" | "outlook",
  to: string,
  subject: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    if (channel === "gmail") {
      const created = JSON.parse(await googleCall(root, env, "/gmail/v1/users/me/drafts", "POST", JSON.stringify({ message: { raw: rawMessage(to, subject, body) } }))) as { id?: string };
      const gmailId = providerDraftId(created.id);
      if (!gmailId) return { ok: false, detail: "Gmail did not return a draft id. Nothing was sent." };
      await googleCall(root, env, `/gmail/v1/users/me/drafts/${encodeURIComponent(gmailId)}/send`, "POST", "{}");
      return { ok: true };
    }
    const created = JSON.parse(await microsoftCall(root, env, "/v1.0/me/messages", "POST", JSON.stringify({
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: [{ emailAddress: { address: to } }],
      isDraft: true,
    }))) as { id?: string };
    const outlookId = providerDraftId(created.id);
    if (!outlookId) return { ok: false, detail: "Outlook did not return a draft id. Nothing was sent." };
    await microsoftCall(root, env, `/v1.0/me/messages/${encodeURIComponent(outlookId)}/send`, "POST", "{}");
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The provider rejected the send.";
    return { ok: false, detail: `${message} The message was not marked sent.`.slice(0, 300) };
  }
}

function providerDraftId(value: string | undefined): string {
  if (!value || value.length > 400 || /[\r\n/?#\\]/.test(value)) return "";
  return value;
}

function rawMessage(to: string, subject: string, body: string): string {
  return Buffer.from(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`).toString("base64url");
}

async function googleCall(
  root: string,
  env: NodeJS.ProcessEnv,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: string,
): Promise<string> {
  const accessToken = await accessTokenFor(root, "google", env);
  const result = await authorizedSend(`${googleApiUrl(env)}${path}`, accessToken, method, body);
  if (result.status === 401) {
    accessTokens.delete("google");
    const retryToken = await accessTokenFor(root, "google", env);
    const retry = await authorizedSend(`${googleApiUrl(env)}${path}`, retryToken, method, body);
    if (!retry.ok) throw new AccountError("Google rejected the request. Nothing was changed.");
    return retry.text;
  }
  if (!result.ok) throw new AccountError("Google rejected the request. Nothing was changed.");
  return result.text;
}

async function microsoftCall(
  root: string,
  env: NodeJS.ProcessEnv,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: string,
): Promise<string> {
  const accessToken = await accessTokenFor(root, "microsoft", env);
  const result = await authorizedSend(`${microsoftApiUrl(env)}${path}`, accessToken, method, body);
  if (!result.ok) throw new AccountError("Microsoft rejected the request. Nothing was changed.");
  return result.text;
}

export function isAccountTool(name: string): boolean {
  return ACCOUNT_TOOL_NAMES.has(name);
}

export const ACCOUNT_TOOL_DEFS = [
  { name: "gmail_search", description: "Search the connected Gmail account. Requires approval. Does not send mail.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "gmail_read", description: "Read one Gmail message by id. Requires approval. Does not send mail.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "gmail_draft", description: "Save a Gmail draft card for a person to send. Nothing is sent automatically.", inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] } },
  { name: "calendar_list", description: "List events on the connected Google calendar. Requires approval.", inputSchema: { type: "object", properties: {} } },
  { name: "calendar_create", description: "Create a Google calendar event. Requires approval before the event is created.", inputSchema: { type: "object", properties: { summary: { type: "string" }, start: { type: "string" }, end: { type: "string" } }, required: ["summary", "start", "end"] } },
  { name: "drive_search", description: "Search the connected Google Drive. Requires approval. Read only.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "drive_read", description: "Read one Google Drive file by id. Requires approval.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "outlook_search", description: "Search the connected Outlook mailbox. Requires approval. Does not send mail.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "outlook_read", description: "Read one Outlook message by id. Requires approval.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "outlook_draft", description: "Save an Outlook draft card for a person to send. Nothing is sent automatically.", inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] } },
  { name: "outlook_calendar_list", description: "List events on the connected Outlook calendar. Requires approval.", inputSchema: { type: "object", properties: {} } },
  { name: "outlook_calendar_create", description: "Create an Outlook calendar event. Requires approval before the event is created.", inputSchema: { type: "object", properties: { summary: { type: "string" }, start: { type: "string" }, end: { type: "string" } }, required: ["summary", "start", "end"] } },
  { name: "onedrive_search", description: "Search the connected OneDrive. Requires approval. Read only.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "onedrive_read", description: "Read one OneDrive file by id. Requires approval.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

export function accountToolNeedsApproval(toolName: string, args: Record<string, unknown>): boolean {
  if (ACCOUNT_TOOL_NAMES.has(toolName)) return true;
  return toolName === "tool_call" && typeof args.name === "string" && ACCOUNT_TOOL_NAMES.has(args.name);
}

export function accountWriteTool(toolName: string): boolean {
  return ACCOUNT_WRITE_NAMES.has(toolName);
}

export async function runAccountTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; text: string }> {
  try {
    if (name === "gmail_search") {
      const query = clean(args.query, 200);
      if (!query) return { ok: false, text: "Gmail search needs a query." };
      const text = await googleCall(root, env, `/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`);
      const parsed = JSON.parse(text) as { messages?: Array<{ id?: string }> };
      const messages = Array.isArray(parsed.messages) ? parsed.messages.slice(0, 5) : [];
      const lines: string[] = [];
      for (const message of messages) {
        if (!message.id) continue;
        const detail = JSON.parse(await googleCall(root, env, `/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}`)) as {
          snippet?: string;
          payload?: { headers?: Array<{ name?: string; value?: string }> };
        };
        const subject = detail.payload?.headers?.find((header) => header.name?.toLowerCase() === "subject")?.value ?? "";
        lines.push(`${message.id}: ${subject || detail.snippet || "message"}`);
      }
      return { ok: true, text: lines.join("\n") || "No Gmail messages matched." };
    }
    if (name === "gmail_read") {
      const id = requireId(args.id);
      const detail = JSON.parse(await googleCall(root, env, `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`)) as { snippet?: string };
      return { ok: true, text: detail.snippet || "Gmail message had no snippet." };
    }
    if (name === "gmail_draft") return queueMailDraft(root, "gmail", args, env);
    if (name === "calendar_list") {
      const text = await googleCall(root, env, "/calendar/v3/calendars/primary/events");
      const parsed = JSON.parse(text) as { items?: Array<{ id?: string; summary?: string }> };
      const lines = (parsed.items ?? []).slice(0, 10).map((item) => `${item.id ?? "event"}: ${item.summary ?? "Untitled"}`);
      return { ok: true, text: lines.join("\n") || "No calendar events." };
    }
    if (name === "calendar_create") {
      const summary = clean(args.summary, 200);
      const start = clean(args.start, 40);
      const end = clean(args.end, 40);
      if (!summary || !start || !end) return { ok: false, text: "Calendar create needs a summary, start, and end. Nothing was created." };
      const text = await googleCall(root, env, "/calendar/v3/calendars/primary/events", "POST", JSON.stringify({ summary, start: { dateTime: start }, end: { dateTime: end } }));
      const parsed = JSON.parse(text) as { id?: string };
      return { ok: true, text: `Calendar event ${parsed.id ?? "created"}.` };
    }
    if (name === "drive_search") {
      const query = clean(args.query, 200);
      if (!query) return { ok: false, text: "Drive search needs a query." };
      const text = await googleCall(root, env, `/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`);
      const parsed = JSON.parse(text) as { files?: Array<{ id?: string; name?: string }> };
      const lines = (parsed.files ?? []).slice(0, 10).map((file) => `${file.id ?? "file"}: ${file.name ?? "Untitled"}`);
      return { ok: true, text: lines.join("\n") || "No Drive files matched." };
    }
    if (name === "drive_read") {
      const id = requireId(args.id);
      const text = await googleCall(root, env, `/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
      return { ok: true, text: text.slice(0, 8_000) };
    }
    if (name === "outlook_search") {
      const query = clean(args.query, 200);
      if (!query || query.includes("'") || query.includes('"')) return { ok: false, text: "Outlook search needs a query without quotes." };
      const text = await microsoftCall(root, env, `/v1.0/me/messages?$search=${encodeURIComponent(`"${query}"`)}&$top=5`);
      const parsed = JSON.parse(text) as { value?: Array<{ id?: string; subject?: string }> };
      const lines = (parsed.value ?? []).map((item) => `${item.id ?? "message"}: ${item.subject ?? "Untitled"}`);
      return { ok: true, text: lines.join("\n") || "No Outlook messages matched." };
    }
    if (name === "outlook_read") {
      const id = requireId(args.id);
      const text = await microsoftCall(root, env, `/v1.0/me/messages/${encodeURIComponent(id)}`);
      const parsed = JSON.parse(text) as { subject?: string; bodyPreview?: string };
      return { ok: true, text: `${parsed.subject ?? "Untitled"}\n${parsed.bodyPreview ?? ""}`.trim() };
    }
    if (name === "outlook_draft") return queueMailDraft(root, "outlook", args, env);
    if (name === "outlook_calendar_list") {
      const text = await microsoftCall(root, env, "/v1.0/me/events?$top=10");
      const parsed = JSON.parse(text) as { value?: Array<{ id?: string; subject?: string }> };
      const lines = (parsed.value ?? []).map((item) => `${item.id ?? "event"}: ${item.subject ?? "Untitled"}`);
      return { ok: true, text: lines.join("\n") || "No Outlook calendar events." };
    }
    if (name === "outlook_calendar_create") {
      const summary = clean(args.summary, 200);
      const start = clean(args.start, 40);
      const end = clean(args.end, 40);
      if (!summary || !start || !end) return { ok: false, text: "Outlook calendar create needs a summary, start, and end. Nothing was created." };
      const text = await microsoftCall(root, env, "/v1.0/me/events", "POST", JSON.stringify({
        subject: summary,
        start: { dateTime: start, timeZone: "UTC" },
        end: { dateTime: end, timeZone: "UTC" },
      }));
      const parsed = JSON.parse(text) as { id?: string };
      return { ok: true, text: `Outlook calendar event ${parsed.id ?? "created"}.` };
    }
    if (name === "onedrive_search") {
      const query = clean(args.query, 200);
      if (!query || query.includes("'")) return { ok: false, text: "OneDrive search needs a query without quotes." };
      const text = await microsoftCall(root, env, `/v1.0/me/drive/root/search(q='${encodeURIComponent(query)}')`);
      const parsed = JSON.parse(text) as { value?: Array<{ id?: string; name?: string }> };
      const lines = (parsed.value ?? []).slice(0, 10).map((item) => `${item.id ?? "file"}: ${item.name ?? "Untitled"}`);
      return { ok: true, text: lines.join("\n") || "No OneDrive files matched." };
    }
    if (name === "onedrive_read") {
      const id = requireId(args.id);
      const text = await microsoftCall(root, env, `/v1.0/me/drive/items/${encodeURIComponent(id)}/content`);
      return { ok: true, text: text.slice(0, 8_000) };
    }
    return { ok: false, text: "Unknown account tool." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Account request failed.";
    return { ok: false, text: message };
  }
}
