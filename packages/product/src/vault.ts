import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readDesktopState, writeDesktopState } from "./computer-desktop.js";

export type VaultKind = "login" | "oauth" | "token" | "note";
export type VaultStorage = "local" | "1password";
export type VaultBackend = "os-keychain" | "encrypted-file";
export type VaultChallenge = "signin" | "2fa" | "captcha";

export interface VaultItemPublic {
  id: string;
  name: string;
  kind: VaultKind;
  account: string;
  storage: VaultStorage;
  updatedAt: string;
}

export interface VaultStatus {
  backend: VaultBackend;
  backendLabel: string;
  onePasswordCli: boolean;
  items: VaultItemPublic[];
}

export class VaultError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface StoredItem {
  id: string;
  name: string;
  kind: VaultKind;
  account: string;
  storage: VaultStorage;
  nonce?: string;
  ciphertext?: string;
  tag?: string;
  updatedAt: string;
}

interface VaultFile {
  items: StoredItem[];
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const SERVICE = "opencodingpartner";
const ACCOUNT = "vault-master";

function vaultPath(root: string): string {
  return path.join(root, "vault.enc");
}

function masterKeyPath(root: string): string {
  return path.join(root, "vault-master.key");
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv, input?: string, timeoutMs = 800): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 16_000) stdout = stdout.slice(0, 16_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 2_000) stderr = stderr.slice(0, 2_000);
    });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function commandExists(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await runCommand("which", [name], env, undefined, 1500);
  return result.code === 0 && result.stdout.trim().length > 0;
}

function keychainUnusable(result: CommandResult): boolean {
  if (result.code === 124 || result.code === 127) return true;
  const err = result.stderr.toLowerCase();
  return err.includes("d-bus") || err.includes("dbus") || err.includes("locked") || err.includes("prompt") || err.includes("not available");
}

async function readKeychain(env: NodeJS.ProcessEnv): Promise<{ ok: true; value?: string } | { ok: false }> {
  if (await commandExists("secret-tool", env)) {
    const result = await runCommand("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], env, undefined, 800);
    if (keychainUnusable(result)) return { ok: false };
    if (result.code === 0 && result.stdout.trim()) return { ok: true, value: result.stdout.trim() };
    if (result.code === 0 || result.code === 1) return { ok: true };
    return { ok: false };
  }
  if (process.platform === "darwin" && (await commandExists("security", env))) {
    const result = await runCommand("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], env, undefined, 800);
    if (keychainUnusable(result)) return { ok: false };
    if (result.code === 0 && result.stdout.trim()) return { ok: true, value: result.stdout.trim() };
    if (result.code === 0 || result.code === 44) return { ok: true };
    return { ok: false };
  }
  return { ok: false };
}

async function writeKeychain(value: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (await commandExists("secret-tool", env)) {
    const result = await runCommand(
      "secret-tool",
      ["store", "--label", "Open Coding Partner vault", "service", SERVICE, "account", ACCOUNT],
      env,
      value,
      800,
    );
    return result.code === 0 && !keychainUnusable(result);
  }
  if (process.platform === "darwin" && (await commandExists("security", env))) {
    const result = await runCommand(
      "security",
      ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", value],
      env,
      undefined,
      800,
    );
    return result.code === 0 && !keychainUnusable(result);
  }
  return false;
}

async function readMasterKeyFile(root: string): Promise<Buffer | undefined> {
  try {
    const raw = (await readFile(masterKeyPath(root), "utf8")).trim();
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : undefined;
  } catch {
    return undefined;
  }
}

async function writeMasterKeyFile(root: string, key: Buffer): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  const target = masterKeyPath(root);
  await writeFile(target, `${key.toString("base64")}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
}

function decodeKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const key = Buffer.from(value.trim(), "base64");
  return key.length === 32 ? key : undefined;
}

const FILE_LABEL = "Encrypted file with a master key file because no OS keychain is available.";
const KEYCHAIN_LABEL = "OS keychain holds the vault master key. Item secrets are encrypted with it.";

function forcedBackend(env: NodeJS.ProcessEnv): "file" | "keychain" | "auto" {
  if (env.OCP_VAULT_BACKEND === "file") return "file";
  if (env.OCP_VAULT_BACKEND === "keychain") return "keychain";
  return "auto";
}

async function describeBackend(root: string, env: NodeJS.ProcessEnv): Promise<{ backend: VaultBackend; backendLabel: string }> {
  const forced = forcedBackend(env);
  if (forced !== "keychain" && (await readMasterKeyFile(root))) {
    return { backend: "encrypted-file", backendLabel: FILE_LABEL };
  }
  if (forced !== "file") {
    const existing = await readKeychain(env);
    if (existing.ok && decodeKey(existing.value)) return { backend: "os-keychain", backendLabel: KEYCHAIN_LABEL };
    if (existing.ok && existing.value === undefined) {
      return { backend: "os-keychain", backendLabel: "OS keychain is available. Item secrets are encrypted with a master key stored there." };
    }
    if (forced === "keychain") return { backend: "encrypted-file", backendLabel: "OS keychain is not available." };
  }
  return { backend: "encrypted-file", backendLabel: FILE_LABEL };
}

async function openVaultKey(root: string, env: NodeJS.ProcessEnv): Promise<{ key: Buffer; backend: VaultBackend; backendLabel: string }> {
  const forced = forcedBackend(env);
  if (forced !== "keychain") {
    const fromFile = await readMasterKeyFile(root);
    if (fromFile) return { key: fromFile, backend: "encrypted-file", backendLabel: FILE_LABEL };
  }
  if (forced !== "file") {
    const existing = await readKeychain(env);
    if (existing.ok) {
      const decoded = decodeKey(existing.value);
      if (decoded) return { key: decoded, backend: "os-keychain", backendLabel: KEYCHAIN_LABEL };
      if (existing.value) throw new VaultError("OS keychain returned a vault key that could not be used. The secret was not stored.");
      const key = randomBytes(32);
      const stored = await writeKeychain(key.toString("base64"), env);
      if (stored) return { key, backend: "os-keychain", backendLabel: KEYCHAIN_LABEL };
      if (forced === "keychain") throw new VaultError("OS keychain is not available. The secret was not stored.");
    } else if (forced === "keychain") {
      throw new VaultError("OS keychain is not available. The secret was not stored.");
    }
  }
  const key = randomBytes(32);
  await writeMasterKeyFile(root, key);
  return { key, backend: "encrypted-file", backendLabel: FILE_LABEL };
}

function encryptSecret(key: Buffer, secret: string): { nonce: string; ciphertext: string; tag: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptSecret(key: Buffer, item: StoredItem): string {
  if (!item.nonce || !item.ciphertext || !item.tag) throw new VaultError("Vault item could not be decrypted.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(item.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(item.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(item.ciphertext, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw new VaultError("Vault item could not be decrypted.");
  }
}

async function readVaultFile(root: string): Promise<VaultFile> {
  try {
    const parsed = JSON.parse(await readFile(vaultPath(root), "utf8")) as VaultFile;
    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
    throw new VaultError("Vault could not be read.");
  }
}

async function writeVaultFile(root: string, file: VaultFile): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  const target = vaultPath(root);
  await writeFile(target, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
}

function toPublic(item: StoredItem): VaultItemPublic {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    account: item.account,
    storage: item.storage,
    updatedAt: item.updatedAt,
  };
}

function validKind(value: unknown): value is VaultKind {
  return value === "login" || value === "oauth" || value === "token" || value === "note";
}

function cleanLine(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, max) : "";
}

export async function onePasswordAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return commandExists("op", env);
}

export async function publicVault(root: string, env: NodeJS.ProcessEnv = process.env): Promise<VaultStatus> {
  const onePasswordCli = await onePasswordAvailable(env);
  try {
    const described = await describeBackend(root, env);
    const file = await readVaultFile(root);
    return {
      backend: described.backend,
      backendLabel: described.backendLabel,
      onePasswordCli,
      items: file.items.map(toPublic).sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (error) {
    const message = error instanceof VaultError ? error.message : "Vault could not be read.";
    return {
      backend: "encrypted-file",
      backendLabel: message,
      onePasswordCli,
      items: [],
    };
  }
}

async function opItemTemplate(name: string, account: string, secret: string): Promise<string> {
  return JSON.stringify({
    title: name,
    category: "LOGIN",
    fields: [
      { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: account },
      { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: secret },
    ],
  });
}

async function createOnePasswordItem(name: string, account: string, secret: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!(await onePasswordAvailable(env))) {
    throw new VaultError("1Password CLI (op) is not available. The secret was not stored.");
  }
  const result = await runCommand("op", ["item", "create", "--template", "-", "--format", "json"], env, await opItemTemplate(name, account, secret), 4000);
  if (result.code !== 0) throw new VaultError("1Password CLI could not store the item. The secret was not stored.");
}

async function readOnePasswordSecret(name: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (!(await onePasswordAvailable(env))) throw new VaultError("1Password CLI (op) is not available. The secret was not read.");
  const result = await runCommand("op", ["item", "get", name, "--fields", "label=password", "--reveal"], env, undefined, 4000);
  const secret = result.stdout.trim();
  if (result.code !== 0 || !secret) throw new VaultError("1Password CLI could not read the item. The secret was not typed.");
  return secret;
}

async function deleteOnePasswordItem(name: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!(await onePasswordAvailable(env))) throw new VaultError("1Password CLI (op) is not available. The item was not deleted.");
  const result = await runCommand("op", ["item", "delete", name], env, undefined, 4000);
  if (result.code !== 0) throw new VaultError("1Password CLI could not delete the item.");
}

export async function createVaultItem(
  root: string,
  input: { name?: unknown; kind?: unknown; account?: unknown; secret?: unknown; storage?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VaultItemPublic> {
  const name = cleanLine(input.name, 80);
  const account = cleanLine(input.account, 200);
  const secret = typeof input.secret === "string" ? input.secret : "";
  const storage: VaultStorage = input.storage === "1password" ? "1password" : "local";
  if (!name || /[\r\n]/.test(name)) throw new VaultError("Vault item name must be 1 to 80 characters.");
  if (!validKind(input.kind)) throw new VaultError("Vault item kind must be login, oauth, token, or note.");
  if (!secret || secret.length > 8_000) throw new VaultError("Vault secret must be 1 to 8,000 characters.");
  const opened = await openVaultKey(root, env);
  const file = await readVaultFile(root);
  if (file.items.some((item) => item.name === name)) throw new VaultError("A vault item with that name already exists.", 409);
  if (storage === "1password") await createOnePasswordItem(name, account, secret, env);
  const item: StoredItem = {
    id: randomUUID(),
    name,
    kind: input.kind,
    account,
    storage,
    updatedAt: new Date().toISOString(),
    ...(storage === "local" ? encryptSecret(opened.key, secret) : {}),
  };
  file.items.push(item);
  try {
    await writeVaultFile(root, file);
  } catch (error) {
    if (storage === "1password") await deleteOnePasswordItem(name, env).catch(() => undefined);
    throw error instanceof VaultError ? error : new VaultError("Vault item could not be stored. The secret was not kept.");
  }
  return toPublic(item);
}

export async function deleteVaultItem(root: string, id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = await readVaultFile(root);
  const item = file.items.find((entry) => entry.id === id);
  if (!item) throw new VaultError("Vault item not found.", 404);
  if (item.storage === "1password") await deleteOnePasswordItem(item.name, env);
  await writeVaultFile(root, { items: file.items.filter((entry) => entry.id !== id) });
}

export async function readVaultSecret(root: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const file = await readVaultFile(root);
  const item = file.items.find((entry) => entry.name === name);
  if (!item) return undefined;
  if (item.storage === "1password") return readOnePasswordSecret(name, env);
  const opened = await openVaultKey(root, env);
  return decryptSecret(opened.key, item);
}

export interface VaultFillOutcome {
  ok: boolean;
  handoff: boolean;
  text: string;
}

function scrub(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

async function handoffChallenge(workspace: string): Promise<void> {
  const state = await readDesktopState(workspace);
  state.control = "human";
  state.status = "held";
  await writeDesktopState(workspace, state);
}

export async function fillVaultLogin(options: {
  root: string;
  workspace: string;
  name: string;
  field?: "username" | "password";
  challenge?: VaultChallenge | "";
  env?: NodeJS.ProcessEnv;
  typeText?: (text: string) => Promise<{ ok: boolean; detail: string }>;
}): Promise<VaultFillOutcome> {
  const challenge = options.challenge === "signin" || options.challenge === "2fa" || options.challenge === "captcha" ? options.challenge : "";
  if (challenge) {
    await handoffChallenge(options.workspace);
    return {
      ok: false,
      handoff: true,
      text: "This page is a sign-in, 2FA, or captcha. Take Control and finish it yourself. The vault secret was not typed and is not included.",
    };
  }
  const name = options.name.trim();
  if (!name) return { ok: false, handoff: false, text: "Vault item name is required. The secret was not typed." };
  const file = await readVaultFile(options.root);
  const item = file.items.find((entry) => entry.name === name);
  if (!item) return { ok: false, handoff: false, text: `No vault item named ${name}. The secret was not typed.` };
  const field = options.field === "username" ? "username" : "password";
  if (field === "username") {
    if (!item.account) return { ok: false, handoff: false, text: `Vault item ${name} has no account name.` };
    const typed = await (options.typeText ?? (async () => ({ ok: false, detail: "No keyboard is available." })))(item.account);
    if (!typed.ok) return { ok: false, handoff: false, text: `Could not type the account name into the virtual computer. ${scrub(typed.detail, item.account)}` };
    return { ok: true, handoff: false, text: `Filled the username field for ${item.account} from vault item ${name}.` };
  }
  let secret = "";
  try {
    secret = (await readVaultSecret(options.root, name, options.env)) ?? "";
  } catch (error) {
    const message = error instanceof Error ? error.message : "The secret was not typed.";
    return { ok: false, handoff: false, text: scrub(message, secret) };
  }
  if (!secret) return { ok: false, handoff: false, text: `Vault item ${name} has no secret. Nothing was typed.` };
  const typed = await (options.typeText ?? (async () => ({ ok: false, detail: "No keyboard is available." })))(secret);
  if (!typed.ok) {
    return { ok: false, handoff: false, text: `Could not type into the virtual computer. ${scrub(typed.detail, secret)} The secret was not included.` };
  }
  return {
    ok: true,
    handoff: false,
    text: `Filled the password field for ${item.account || name} from vault item ${name}. The secret was not included.`,
  };
}

export function publicVaultFillArgs(args: Record<string, unknown>): Record<string, unknown> {
  const name = typeof args.name === "string" ? args.name.replace(/[\r\n]+/g, " ").trim().slice(0, 80) : "";
  const field = args.field === "username" ? "username" : "password";
  const challenge = args.challenge === "signin" || args.challenge === "2fa" || args.challenge === "captcha" ? args.challenge : undefined;
  return challenge ? { name, field, challenge } : { name, field };
}

/** Sanitized vault_fill arguments when this tool call fills from the vault. */
export function vaultFillInvocation(toolName: string, args: Record<string, unknown>): Record<string, unknown> | undefined {
  if (toolName === "vault_fill") return publicVaultFillArgs(args);
  if (toolName !== "tool_call" || args.name !== "vault_fill") return undefined;
  const inner = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
    ? args.arguments as Record<string, unknown>
    : {};
  return publicVaultFillArgs(inner);
}

export async function vaultMasterKeyMode(root: string): Promise<number | undefined> {
  try {
    const info = await stat(masterKeyPath(root));
    return info.mode & 0o777;
  } catch {
    return undefined;
  }
}
