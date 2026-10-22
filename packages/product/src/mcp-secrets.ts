import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface SecretFile {
  entries?: Record<string, string>;
}

export function mcpSecretKey(botId: string, serverName: string): string {
  return `${botId}\n${serverName}`;
}

function secretPath(root: string): string {
  return path.join(root, "mcp-secrets.json");
}

async function readSecrets(root: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(secretPath(root), "utf8")) as SecretFile;
    const entries = parsed?.entries;
    if (!entries || typeof entries !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === "string" && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeSecrets(root: string, entries: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  const target = secretPath(root);
  await writeFile(target, `${JSON.stringify({ entries }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
}

export async function listMcpSecretKeys(root: string): Promise<Set<string>> {
  return new Set(Object.keys(await readSecrets(root)));
}

export async function readMcpSecret(root: string, botId: string, serverName: string): Promise<string | undefined> {
  return (await readSecrets(root))[mcpSecretKey(botId, serverName)];
}

export async function writeMcpSecret(root: string, botId: string, serverName: string, token: string): Promise<void> {
  const entries = await readSecrets(root);
  entries[mcpSecretKey(botId, serverName)] = token;
  await writeSecrets(root, entries);
}

export async function deleteMcpSecret(root: string, botId: string, serverName: string): Promise<void> {
  const entries = await readSecrets(root);
  delete entries[mcpSecretKey(botId, serverName)];
  await writeSecrets(root, entries);
}

export async function deleteMcpSecretsForBot(root: string, botId: string): Promise<void> {
  const entries = await readSecrets(root);
  const prefix = `${botId}\n`;
  let changed = false;
  for (const key of Object.keys(entries)) {
    if (key.startsWith(prefix)) {
      delete entries[key];
      changed = true;
    }
  }
  if (changed) await writeSecrets(root, entries);
}
