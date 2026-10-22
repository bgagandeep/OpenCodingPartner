import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function redactStored(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

export interface RegisteredAgent {
  id: string;
  name: string;
  url: string;
  createdAt: string;
}

export interface DirectoryUser {
  id: string;
  name: string;
  role: "admin" | "member";
}

export interface StudioPage {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

interface StoredUser extends DirectoryUser {
  salt: string;
  hash: string;
}

interface DirectoryFile {
  users: StoredUser[];
  assertionSecret?: string;
}

function file(root: string, name: string): string {
  return path.join(root, name);
}

async function readJson<T>(target: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
}

export function loopbackAgentUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return undefined;
  return url.toString();
}

export async function listAgents(root: string): Promise<RegisteredAgent[]> {
  const rows = await readJson<unknown>(file(root, "agents.json"), []);
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is RegisteredAgent => {
    if (!row || typeof row !== "object") return false;
    const agent = row as RegisteredAgent;
    return typeof agent.id === "string" && typeof agent.name === "string" && typeof agent.url === "string";
  });
}

export async function registerAgent(root: string, name: string, rawUrl: string): Promise<RegisteredAgent> {
  const label = name.trim();
  const url = loopbackAgentUrl(rawUrl);
  if (!label || label.length > 80 || !url) throw new Error("An agent needs a name and a loopback http URL.");
  const saved: RegisteredAgent = { id: randomUUID(), name: label, url, createdAt: new Date().toISOString() };
  const rows = await listAgents(root);
  rows.push(saved);
  await writeJson(file(root, "agents.json"), rows.slice(-50));
  return saved;
}

export interface AguiRunResult {
  status: number;
  contentType: string;
  body: string;
}

export async function executeAguiRun(root: string, input: unknown, fetchImpl: typeof fetch = fetch): Promise<AguiRunResult> {
  const reject = (status: number, error: string): AguiRunResult => ({
    status,
    contentType: "application/json",
    body: `${JSON.stringify({ error })}\n`,
  });
  if (!input || typeof input !== "object" || Array.isArray(input)) return reject(400, "Run input must be a JSON object.");
  const row = input as { threadId?: unknown; runId?: unknown; messages?: unknown; agentId?: unknown };
  if (typeof row.threadId !== "string" || !row.threadId || typeof row.runId !== "string" || !row.runId || !Array.isArray(row.messages)) {
    return reject(400, "threadId, runId, and messages are required.");
  }
  let text = "No model is configured. This run will not invent an action.";
  if (typeof row.agentId === "string" && row.agentId) {
    const agent = (await listAgents(root)).find((item) => item.id === row.agentId);
    if (!agent || !loopbackAgentUrl(agent.url)) return reject(404, "Unknown loopback agent.");
    try {
      const response = await fetchImpl(agent.url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ threadId: row.threadId, runId: row.runId, messages: row.messages }),
      });
      const payload = await response.json() as { text?: unknown };
      if (!response.ok || typeof payload.text !== "string" || !payload.text.trim()) {
        text = "The registered agent refused the run. This run will not invent an action.";
      } else {
        text = redactStored(payload.text).slice(0, 4_000);
      }
    } catch {
      text = "The registered agent refused the run. This run will not invent an action.";
    }
  }
  const messageId = randomUUID();
  const events = [
    { type: "RUN_STARTED", threadId: row.threadId, runId: row.runId, protocolVersion: "1.0" },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
    { type: "TEXT_MESSAGE_END", messageId },
    { type: "CUSTOM", name: "ocp.component", value: { type: "card", title: "Reply", body: text } },
    { type: "RUN_FINISHED", threadId: row.threadId, runId: row.runId },
  ];
  return {
    status: 200,
    contentType: "text/event-stream",
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  };
}

async function readDirectory(root: string): Promise<DirectoryFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file(root, "directory.json"), "utf8")) as DirectoryFile;
    if (!parsed || !Array.isArray(parsed.users)) return undefined;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { users: [] };
    return undefined;
  }
}

export async function listDirectory(root: string): Promise<{ users: DirectoryUser[]; companySignIn: boolean }> {
  const directory = await readDirectory(root);
  if (!directory) return { users: [], companySignIn: false };
  return {
    users: directory.users.map((user) => ({ id: user.id, name: user.name, role: user.role })),
    companySignIn: Boolean(directory.assertionSecret),
  };
}

export async function createDirectoryUser(root: string, name: string, role: "admin" | "member", password: string): Promise<DirectoryUser> {
  const directory = await readDirectory(root);
  if (!directory) throw new Error("The directory file is broken. Refusing to add a person.");
  const label = name.trim();
  if (!label || label.length > 80 || !/^[A-Za-z0-9 ._-]+$/.test(label)) throw new Error("A person needs a simple name.");
  if (role !== "admin" && role !== "member") throw new Error("Role must be admin or member.");
  if (password.length < 8 || password.length > 200) throw new Error("Password must be 8 to 200 characters.");
  if (directory.users.some((user) => user.name.toLowerCase() === label.toLowerCase())) throw new Error("That person is already in the directory.");
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  const saved: StoredUser = { id: randomUUID(), name: label, role, salt: salt.toString("base64url"), hash: hash.toString("base64url") };
  directory.users.push(saved);
  await writeJson(file(root, "directory.json"), directory);
  return { id: saved.id, name: saved.name, role: saved.role };
}

export async function loginDirectory(root: string, name: string, password: string): Promise<DirectoryUser> {
  const directory = await readDirectory(root);
  if (!directory) throw new Error("The directory file is broken. Refusing sign-in.");
  const user = directory.users.find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
  const salt = user ? Buffer.from(user.salt, "base64url") : randomBytes(16);
  const actual = user ? Buffer.from(user.hash, "base64url") : randomBytes(32);
  const candidate = scryptSync(password, salt, 32);
  const same = actual.length === candidate.length && timingSafeEqual(actual, candidate);
  if (!user || !same) throw new Error("Unknown person or password.");
  return { id: user.id, name: user.name, role: user.role };
}

export async function setCompanyAssertionSecret(root: string, secret: string): Promise<void> {
  const directory = await readDirectory(root);
  if (!directory) throw new Error("The directory file is broken. Refusing to store a company secret.");
  if (secret.length < 16 || secret.length > 200) throw new Error("Company assertion secret must be 16 to 200 characters.");
  directory.assertionSecret = secret;
  await writeJson(file(root, "directory.json"), directory);
}

export function companyAssertion(secret: string, name: string, role: "admin" | "member", exp: number): string {
  const payload = Buffer.from(JSON.stringify({ name, role, exp }), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export async function loginCompanyAssertion(root: string, assertion: string): Promise<DirectoryUser> {
  const directory = await readDirectory(root);
  if (!directory?.assertionSecret) throw new Error("Company sign-in is not configured.");
  const [payload, sig] = assertion.split(".");
  if (!payload || !sig) throw new Error("Company assertion was refused.");
  const expected = createHmac("sha256", directory.assertionSecret).update(payload).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("Company assertion was refused.");
  let claims: { name?: unknown; role?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { name?: unknown; role?: unknown; exp?: unknown };
  } catch {
    throw new Error("Company assertion was refused.");
  }
  const claimName = typeof claims.name === "string" ? claims.name : "";
  const claimRole = claims.role === "admin" || claims.role === "member" ? claims.role : undefined;
  if (!claimName || !claimRole || typeof claims.exp !== "number" || claims.exp < Date.now()) {
    throw new Error("Company assertion was refused.");
  }
  const existing = directory.users.find((user) => user.name.toLowerCase() === claimName.toLowerCase());
  if (existing) return { id: existing.id, name: existing.name, role: existing.role };
  const created = await createDirectoryUser(root, claimName, claimRole, randomBytes(24).toString("base64url"));
  return created;
}

export async function listPages(root: string): Promise<StudioPage[]> {
  const rows = await readJson<unknown>(file(root, "pages.json"), []);
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is StudioPage => {
    if (!row || typeof row !== "object") return false;
    const page = row as StudioPage;
    return typeof page.id === "string" && typeof page.title === "string" && typeof page.body === "string";
  });
}

export async function savePage(root: string, title: string, body: string): Promise<StudioPage> {
  const label = title.replace(/[\r\n]+/g, " ").trim();
  const text = body.replace(/\u0000/g, "").trim();
  if (!label || label.length > 120 || !text || text.length > 20_000) throw new Error("A page needs a title and a body.");
  const saved: StudioPage = { id: randomUUID(), title: label, body: redactStored(text), updatedAt: new Date().toISOString() };
  const rows = await listPages(root);
  rows.push(saved);
  await writeJson(file(root, "pages.json"), rows.slice(-100));
  return saved;
}

export async function appendWhatsappOutbox(root: string, text: string, destination: string): Promise<void> {
  const rows = await readJson<Array<{ text: string; destination: string; at: string }>>(file(root, "whatsapp-outbox.json"), []);
  rows.push({ text: redactStored(text), destination: destination.slice(0, 200), at: new Date().toISOString() });
  await writeJson(file(root, "whatsapp-outbox.json"), rows.slice(-100));
}

export function confineCoderLaunch(input: { workspace: string; command: string; args: string[]; bwrap?: string }): { command: string; args: string[] } {
  if (!input.bwrap) throw new Error("OCP Coder confinement needs bubblewrap. Refusing to run with the operator OS permissions.");
  const workspace = path.resolve(input.workspace);
  return {
    command: input.bwrap,
    args: [
      "--die-with-parent",
      "--unshare-net",
      "--ro-bind", "/usr", "/usr",
      "--bind", workspace, workspace,
      "--chdir", workspace,
      "--",
      input.command,
      ...input.args,
    ],
  };
}
