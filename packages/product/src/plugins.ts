import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeConnectors, upsertConnectorSnapshot, validateConnectorInput, type ConnectorSnapshot } from "./connectors.js";
import { connectorAuthHeaders, listHttpMcpTools, type HttpMcpEndpoint } from "./http-mcp.js";
import { findBot, writeBotMcpServers } from "./index.js";
import { deleteMcpSecret, writeMcpSecret } from "./mcp-secrets.js";
import { createSkill, deleteSkill, listSkills, skillIdFromName, type SkillRecord } from "./skills.js";
import { recordAudit } from "./teammate.js";
import { createVaultItem, deleteVaultItemByName, readVaultSecret, VaultError } from "./vault.js";

export const PRODUCT_VERSION = "0.2.0";

const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const REJECTED_PERMISSIONS = new Set(["message.send", "payment", "voice", "meeting"]);
const PERMISSIONS = new Set([
  "network",
  "workspace.read",
  "workspace.write",
  "draft.message",
  "account.read",
  "account.draft",
  "computer",
  "vault.fill",
]);
const TOP_KEYS = new Set([
  "id",
  "name",
  "description",
  "version",
  "minOcpVersion",
  "checksum",
  "signature",
  "mcpServers",
  "skills",
  "secrets",
  "setupFields",
  "permissions",
  "accounts",
  "draftOnly",
]);
const SERVER_KEYS = new Set(["name", "authHeader", "urlField"]);
const SKILL_KEYS = new Set(["name", "whenToUse", "body"]);
const SECRET_KEYS = new Set(["name", "kind", "label", "storage"]);
const SETUP_KEYS = new Set(["name", "label", "kind", "required", "account"]);
const VAULT_KINDS = new Set(["login", "oauth", "token", "note"]);
const ACCOUNT_NAMES = new Set(["google", "microsoft"]);

export class PluginError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "PluginError";
  }
}

export interface PluginSkill {
  name: string;
  whenToUse: string;
  body: string;
}

export interface PluginMcpServer {
  name: string;
  authHeader: string;
  urlField: string;
}

export interface PluginSecret {
  name: string;
  kind: "login" | "oauth" | "token" | "note";
  label: string;
  storage: "vault";
}

export interface PluginSetupField {
  name: string;
  label: string;
  kind: "url" | "text" | "account";
  required: boolean;
  account?: "google" | "microsoft";
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  minOcpVersion: string;
  checksum: string;
  draftOnly: boolean;
  mcpServers: PluginMcpServer[];
  skills: PluginSkill[];
  secrets: PluginSecret[];
  setupFields: PluginSetupField[];
  permissions: string[];
  accounts: Array<"google" | "microsoft">;
}

export interface BotPluginInstall {
  pluginId: string;
  version: string;
  checksum: string;
  botId: string;
  connectorNames: string[];
  skillIds: string[];
  skillChecksums: Record<string, string>;
  vaultItemNames: string[];
  fields: Record<string, string>;
  installedAt: string;
}

export interface PublicPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  minOcpVersion: string;
  permissions: string[];
  draftOnly: boolean;
  checksumPrefix: string;
  setupFields: PluginSetupField[];
  secrets: Array<{ name: string; kind: string; label: string }>;
  accounts: Array<"google" | "microsoft">;
  skillNames: string[];
  connectorNames: string[];
  installedBotIds: string[];
  origin: "shipped";
}

export interface PluginCallOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export function shippedCatalogPath(): string {
  return fileURLToPath(new URL("../catalog/plugins.json", import.meta.url));
}

export function canonicalManifestBytes(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function manifestChecksum(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalManifestBytes(value), "utf8").digest("hex")}`;
}

export function checksumPrefix(checksum: string): string {
  const hex = checksum.startsWith("sha256:") ? checksum.slice("sha256:".length) : checksum;
  return `sha256:${hex.slice(0, 12)}`;
}

export function skillBodyChecksum(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

export function versionAccepts(minOcpVersion: string, productVersion = PRODUCT_VERSION): boolean {
  if (!VERSION_PATTERN.test(minOcpVersion) || !VERSION_PATTERN.test(productVersion)) return false;
  return compareVersions(minOcpVersion, productVersion) <= 0;
}

/** A shipped id always wins. An operator catalog cannot replace it. */
export function operatorCatalogDecision(shippedIds: ReadonlySet<string>, id: string): "add" | "refused" {
  return shippedIds.has(id) ? "refused" : "add";
}

export function toolClaimsSend(name: string, description: string): boolean {
  if (/[_-]send$/i.test(name)) return true;
  const scrubbed = description.toLowerCase()
    .replaceAll("still sends nothing", "")
    .replaceAll("sends nothing", "")
    .replaceAll("does not send", "")
    .replaceAll("do not send", "")
    .replaceAll("nothing is sent", "");
  return /\bsends\b/.test(scrubbed) || /\bsend\b/.test(scrubbed);
}

export function parseManifest(input: unknown): PluginManifest {
  const record = plainObject(input, "Plugin manifest");
  assertOnlyKeys(record, TOP_KEYS);
  if ("signature" in record) throw new PluginError("A signature is not accepted until a public key is pinned.");
  const checksum = requiredString(record, "checksum", 7, 80, "Plugin checksum");
  if (!CHECKSUM_PATTERN.test(checksum) || checksum !== manifestChecksum(record)) {
    throw new PluginError("Plugin checksum does not match.");
  }
  const id = requiredString(record, "id", 1, 80, "Plugin id");
  if (!PLUGIN_ID.test(id)) throw new PluginError("Plugin id must be 1 to 80 lowercase letters, numbers, and single hyphens.");
  const name = requiredString(record, "name", 1, 80, "Plugin name");
  const description = requiredString(record, "description", 1, 300, "Plugin description");
  if (claimsDelivered(description)) throw new PluginError("Plugin description must not claim that a message was sent.");
  const version = requiredString(record, "version", 5, 20, "Plugin version");
  const minOcpVersion = requiredString(record, "minOcpVersion", 5, 20, "Minimum OCP version");
  if (!VERSION_PATTERN.test(version)) throw new PluginError("Plugin version must be MAJOR.MINOR.PATCH.");
  if (!VERSION_PATTERN.test(minOcpVersion)) throw new PluginError("Minimum OCP version must be MAJOR.MINOR.PATCH.");
  if (!versionAccepts(minOcpVersion)) {
    throw new PluginError(`This plugin requires OCP ${minOcpVersion} or newer. This app is ${PRODUCT_VERSION}.`);
  }
  const draftOnly = record.draftOnly === undefined ? false : record.draftOnly;
  if (typeof draftOnly !== "boolean") throw new PluginError("draftOnly must be true or false.");
  const mcpServers = parseServers(record.mcpServers);
  const skills = parseSkills(record.skills);
  const secrets = parseSecrets(record.secrets);
  const setupFields = parseSetupFields(record.setupFields);
  const permissions = parsePermissions(record.permissions);
  const accounts = parseAccounts(record.accounts);
  if (mcpServers.length === 0 && skills.length === 0) throw new PluginError("A plugin needs a skill or an MCP server.");
  if (mcpServers.length > 0 && !permissions.includes("network")) throw new PluginError("An MCP server requires the network permission.");
  for (const server of mcpServers) {
    const field = setupFields.find((item) => item.name === server.urlField);
    if (!field || field.kind !== "url") throw new PluginError(`Connector ${server.name} needs a url setup field named ${server.urlField}.`);
  }
  return {
    id,
    name,
    description,
    version,
    minOcpVersion,
    checksum,
    draftOnly,
    mcpServers,
    skills,
    secrets,
    setupFields,
    permissions,
    accounts,
  };
}

export async function loadShippedCatalog(): Promise<PluginManifest[]> {
  const raw = await readCatalogRaw();
  const seen = new Set<string>();
  const plugins: PluginManifest[] = [];
  for (const item of raw) {
    const parsed = parseManifest(item);
    if (seen.has(parsed.id)) throw new PluginError(`Shipped plugin id ${parsed.id} is duplicated.`, 500);
    seen.add(parsed.id);
    plugins.push(parsed);
  }
  return plugins;
}

export async function listPlugins(root: string): Promise<{ version: string; plugins: PublicPlugin[] }> {
  const [catalog, installs] = await Promise.all([loadShippedCatalog(), readInstalls(root)]);
  return {
    version: PRODUCT_VERSION,
    plugins: catalog.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      minOcpVersion: plugin.minOcpVersion,
      permissions: plugin.permissions,
      draftOnly: plugin.draftOnly,
      checksumPrefix: checksumPrefix(plugin.checksum),
      setupFields: plugin.setupFields,
      secrets: plugin.secrets.map((secret) => ({ name: secret.name, kind: secret.kind, label: secret.label })),
      accounts: plugin.accounts,
      skillNames: plugin.skills.map((skill) => skill.name),
      connectorNames: plugin.mcpServers.map((server) => server.name),
      installedBotIds: installs.filter((item) => item.pluginId === plugin.id).map((item) => item.botId).sort(),
      origin: "shipped" as const,
    })),
  };
}

export async function installPlugin(root: string, pluginId: string, input: unknown, options: PluginCallOptions = {}): Promise<{ ok: true; pluginId: string; botId: string }> {
  const raw = await readCatalogRaw();
  const match = raw.find((item) => isPlainObject(item) && item.id === pluginId);
  if (!match) throw new PluginError("Unknown plugin.", 404);
  return installManifest(root, match, input, options);
}

export async function installManifest(
  root: string,
  manifestInput: unknown,
  input: unknown,
  options: PluginCallOptions = {},
): Promise<{ ok: true; pluginId: string; botId: string }> {
  const manifest = parseManifest(manifestInput);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = plainObject(input, "Install request");
  const botId = typeof body.botId === "string" ? body.botId.trim() : "";
  if (!botId) throw new PluginError("Choose a bot.");
  const fields = stringMap(body.fields, "Setup fields");
  const secrets = stringMap(body.secrets, "Secrets");
  for (const key of Object.keys(fields)) {
    if (!manifest.setupFields.some((field) => field.name === key)) throw new PluginError(`Unknown setup field ${key}.`);
  }
  for (const key of Object.keys(secrets)) {
    if (!manifest.secrets.some((secret) => secret.name === key)) throw new PluginError(`Unknown secret ${key}.`);
  }
  const normalizedFields: Record<string, string> = {};
  for (const field of manifest.setupFields) {
    const value = (fields[field.name] ?? "").trim();
    if (field.required && !value) throw new PluginError(`Enter ${field.label}.`);
    if (!value) continue;
    if (value.length > 2_000) throw new PluginError(`${field.label} is too long.`);
    if (field.kind === "url") {
      const checked = validateConnectorInput({ name: "plugin", url: value, authHeader: "Authorization" });
      if (!checked.ok) throw new PluginError(checked.error);
      normalizedFields[field.name] = checked.url;
    } else if (field.kind === "account") {
      if (field.account && value !== field.account) throw new PluginError(`${field.label} must use the ${field.account} account in Accounts.`);
      normalizedFields[field.name] = value;
    } else {
      normalizedFields[field.name] = value;
    }
  }
  const secretValues: string[] = [];
  const vaultWrites: Array<{ secret: PluginSecret; value: string }> = [];
  for (const secret of manifest.secrets) {
    const provided = (secrets[secret.name] ?? "").trim();
    if (provided.length > 8_000) throw new PluginError(`The secret for ${secret.label} is too long.`);
    const existing = await readVaultSecret(root, secret.name, env);
    if (existing && provided) throw new PluginError("A vault item with that name already exists.", 409);
    if (!existing && !provided) throw new PluginError(`Enter a secret for ${secret.label}.`);
    const value = provided || existing;
    if (!value) throw new PluginError(`Enter a secret for ${secret.label}.`);
    secretValues.push(value);
    if (provided) vaultWrites.push({ secret, value: provided });
  }
  const bot = await findBot(botId, root);
  if (!bot) throw new PluginError("Unknown bot.", 404);
  const installs = await readInstalls(root);
  if (installs.some((item) => item.pluginId === manifest.id && item.botId === botId)) {
    throw new PluginError("This plugin is already installed on that bot.", 409);
  }
  const taken = new Set((bot.mcpServers ?? []).map((server) => server.name));
  for (const server of manifest.mcpServers) {
    if (taken.has(server.name)) throw new PluginError(`Connector ${server.name} is already on that bot.`, 409);
    if (!normalizedFields[server.urlField]) throw new PluginError(`Enter ${server.urlField}.`);
  }
  const library = await listSkills(root);
  const skillPlans: Array<{ skill: PluginSkill; id: string; checksum: string; create: boolean }> = [];
  for (const skill of manifest.skills) {
    const id = skillIdFromName(skill.name);
    const checksum = skillBodyChecksum(skill.body);
    const existing = library.find((item) => item.id === id);
    if (existing && skillBodyChecksum(existing.body) !== checksum) throw new PluginError("A skill with that name already exists.", 409);
    skillPlans.push({ skill, id, checksum, create: !existing });
  }

  let wrote = false;
  const createdSkillIds: string[] = [];
  const writtenSecrets: string[] = [];
  let savedServers: ConnectorSnapshot[] | undefined;
  const rollback = async (): Promise<void> => {
    if (savedServers) await writeBotMcpServers(botId, savedServers, root).catch(() => undefined);
    for (const name of writtenSecrets) await deleteMcpSecret(root, botId, name).catch(() => undefined);
    for (const skillId of createdSkillIds) await deleteSkill(root, skillId).catch(() => undefined);
  };
  try {
    wrote = true;
    const account = normalizedFields.email ?? "";
    for (const vaultWrite of vaultWrites) {
      try {
        await createVaultItem(root, {
          name: vaultWrite.secret.name,
          kind: vaultWrite.secret.kind,
          account,
          secret: vaultWrite.value,
          storage: "local",
        }, env);
      } catch (error) {
        const status = error instanceof VaultError ? error.status : 400;
        throw new PluginError(error instanceof Error ? error.message : "Vault item was not saved.", status);
      }
    }
    for (const plan of skillPlans) {
      if (!plan.create) continue;
      await createSkill(root, { name: plan.skill.name, whenToUse: plan.skill.whenToUse, body: plan.skill.body });
      createdSkillIds.push(plan.id);
    }
    const connectorNames: string[] = [];
    for (const server of manifest.mcpServers) {
      const url = normalizedFields[server.urlField] ?? "";
      const draft: ConnectorSnapshot = { name: server.name, url, authHeader: server.authHeader };
      const token = secretValues[0];
      const endpoint: HttpMcpEndpoint = { name: server.name, url, headers: connectorAuthHeaders(server.authHeader, token) };
      let snapshot = draft;
      try {
        const tools = await listHttpMcpTools(endpoint, fetchImpl);
        for (const tool of tools) {
          if (toolClaimsSend(tool.name, tool.description)) throw new PluginError(`Plugin tool "${tool.name}" is refused because it sends.`);
        }
        const probed = await probeConnectors([draft], new Map(token ? [[server.name, token]] : []), fetchImpl);
        const checked = probed.servers[0];
        if (!checked || probed.errors.length > 0 || checked.status !== "up") {
          throw new PluginError(scrub(probed.errors[0] ?? `MCP server "${server.name}" failed.`, secretValues));
        }
        snapshot = checked;
      } catch (error) {
        if (error instanceof PluginError) throw error;
        throw new PluginError(scrub(error instanceof Error ? error.message : `MCP server "${server.name}" failed.`, secretValues));
      }
      if (token) {
        await writeMcpSecret(root, botId, server.name, token);
        writtenSecrets.push(server.name);
      }
      savedServers = [...(bot.mcpServers ?? [])];
      await writeBotMcpServers(botId, upsertConnectorSnapshot(savedServers, snapshot), root);
      connectorNames.push(server.name);
    }
    const record: BotPluginInstall = {
      pluginId: manifest.id,
      version: manifest.version,
      checksum: manifest.checksum,
      botId,
      connectorNames,
      skillIds: skillPlans.map((plan) => plan.id),
      skillChecksums: Object.fromEntries(skillPlans.map((plan) => [plan.id, plan.checksum])),
      vaultItemNames: manifest.secrets.map((secret) => secret.name),
      fields: normalizedFields,
      installedAt: new Date().toISOString(),
    };
    await writeInstalls(root, [...installs, record]);
    wrote = false;
    await recordAudit(root, {
      outcome: "permitted",
      action: "plugin.install",
      detail: `plugin ${manifest.id} bot ${botId}`,
    }).catch(() => undefined);
    return { ok: true, pluginId: manifest.id, botId };
  } catch (error) {
    if (wrote) await rollback();
    if (error instanceof PluginError) throw error;
    throw new PluginError(error instanceof Error ? error.message : "Plugin install failed.");
  }
}

export async function uninstallPlugin(
  root: string,
  pluginId: string,
  input: unknown,
  options: PluginCallOptions = {},
): Promise<{ ok: true; pluginId: string; botId: string; keptSkills: string[] }> {
  const env = options.env ?? process.env;
  const body = plainObject(input, "Uninstall request");
  const botId = typeof body.botId === "string" ? body.botId.trim() : "";
  if (!botId) throw new PluginError("Choose a bot.");
  const deleteSecrets = body.deleteSecrets === true;
  const installs = await readInstalls(root);
  const current = installs.find((item) => item.pluginId === pluginId && item.botId === botId);
  if (!current) throw new PluginError("This plugin is not installed on that bot.", 404);
  const rest = installs.filter((item) => item !== current);
  const keptSkills: string[] = [];
  for (const skillId of current.skillIds) {
    if (rest.some((item) => item.skillIds.includes(skillId))) continue;
    const skill = (await listSkills(root)).find((item) => item.id === skillId);
    if (!skill) continue;
    const recorded = current.skillChecksums[skillId];
    if (recorded && recorded !== skillBodyChecksum(skill.body)) {
      keptSkills.push(skillId);
      continue;
    }
    await deleteSkill(root, skillId);
  }
  const bot = await findBot(botId, root);
  if (bot) {
    const names = new Set(current.connectorNames);
    await writeBotMcpServers(botId, (bot.mcpServers ?? []).filter((server) => !names.has(server.name)), root);
  }
  for (const name of current.connectorNames) await deleteMcpSecret(root, botId, name);
  if (deleteSecrets) {
    for (const name of current.vaultItemNames) await deleteVaultItemByName(root, name, env);
  }
  await writeInstalls(root, rest);
  await recordAudit(root, {
    outcome: "permitted",
    action: "plugin.uninstall",
    detail: `plugin ${pluginId} bot ${botId}${deleteSecrets ? " secrets deleted" : ""}`,
  }).catch(() => undefined);
  return { ok: true, pluginId, botId, keptSkills };
}

export async function visibleSkillCatalog(root: string, botId?: string): Promise<Array<{ name: string; description: string; body: string }>> {
  const skills = await listSkills(root);
  let installs: BotPluginInstall[];
  try {
    installs = await readInstalls(root);
  } catch {
    return skills.filter((skill) => skill.builtin).map(toCatalogEntry);
  }
  const pluginSkillIds = new Set(installs.flatMap((item) => item.skillIds));
  const enabled = new Set(installs.filter((item) => botId !== undefined && item.botId === botId).flatMap((item) => item.skillIds));
  return skills
    .filter((skill) => !pluginSkillIds.has(skill.id) || enabled.has(skill.id))
    .map(toCatalogEntry);
}

function toCatalogEntry(skill: SkillRecord): { name: string; description: string; body: string } {
  return {
    name: `skill:${skill.id}`,
    description: `${skill.name}. ${skill.whenToUse}`,
    body: skill.body.length > 8_000 ? `${skill.body.slice(0, 8_000)}\n…` : skill.body,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "checksum" || key === "signature") continue;
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part));
  const b = right.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function claimsDelivered(text: string): boolean {
  const scrubbed = text.toLowerCase()
    .replaceAll("still sends nothing", "")
    .replaceAll("sends nothing", "")
    .replaceAll("does not send", "")
    .replaceAll("do not send", "")
    .replaceAll("nothing is sent", "")
    .replaceAll("was not sent", "");
  return /was sent|has been sent|message was delivered|i sent/.test(scrubbed);
}

function scrub(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, 400);
}

function parseServers(value: unknown): PluginMcpServer[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new PluginError("Plugin MCP servers must be a list of at most 8.");
  const names = new Set<string>();
  return value.map((item) => {
    const record = plainObject(item, "MCP server");
    assertOnlyKeys(record, SERVER_KEYS);
    const name = requiredString(record, "name", 1, 80, "Connector name");
    if (record.authHeader !== undefined && typeof record.authHeader !== "string") throw new PluginError("Auth header name is invalid.");
    const checked = validateConnectorInput({ name, url: "http://127.0.0.1", authHeader: typeof record.authHeader === "string" ? record.authHeader : "Authorization" });
    if (!checked.ok) throw new PluginError(checked.error);
    const urlField = requiredString(record, "urlField", 1, 41, "Connector URL field");
    if (!FIELD_NAME.test(urlField)) throw new PluginError("Connector URL field name is invalid.");
    if (names.has(checked.name)) throw new PluginError(`Connector ${checked.name} is listed twice.`);
    names.add(checked.name);
    return { name: checked.name, authHeader: checked.authHeader ?? "Authorization", urlField };
  });
}

function parseSkills(value: unknown): PluginSkill[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 40) throw new PluginError("A plugin may contain at most 40 skills.");
  return value.map((item) => {
    const record = plainObject(item, "Plugin skill");
    assertOnlyKeys(record, SKILL_KEYS);
    const name = requiredString(record, "name", 1, 80, "Skill name");
    const whenToUse = requiredString(record, "whenToUse", 1, 300, "When to use");
    const body = requiredString(record, "body", 1, 20_000, "Skill steps");
    try {
      skillIdFromName(name);
    } catch (error) {
      throw new PluginError(error instanceof Error ? error.message : "Skill name needs a letter or number.");
    }
    return { name, whenToUse, body };
  });
}

function parseSecrets(value: unknown): PluginSecret[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new PluginError("Plugin secrets must be a list of at most 20.");
  const names = new Set<string>();
  return value.map((item) => {
    const record = plainObject(item, "Plugin secret");
    assertOnlyKeys(record, SECRET_KEYS);
    const name = requiredString(record, "name", 1, 80, "Vault item name");
    const label = requiredString(record, "label", 1, 200, "Secret label");
    const kind = record.kind;
    if (typeof kind !== "string" || !VAULT_KINDS.has(kind)) throw new PluginError("Vault item kind must be login, oauth, token, or note.");
    if (record.storage !== undefined && record.storage !== "vault") throw new PluginError("Plugin secrets are stored in the vault.");
    if (names.has(name)) throw new PluginError(`Vault item ${name} is listed twice.`);
    names.add(name);
    return { name, kind: kind as PluginSecret["kind"], label, storage: "vault" };
  });
}

function parseSetupFields(value: unknown): PluginSetupField[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new PluginError("Setup fields must be a list of at most 20.");
  const names = new Set<string>();
  return value.map((item) => {
    const record = plainObject(item, "Setup field");
    assertOnlyKeys(record, SETUP_KEYS);
    const name = requiredString(record, "name", 1, 41, "Setup field name");
    if (!FIELD_NAME.test(name)) throw new PluginError("Setup field name is invalid.");
    const label = requiredString(record, "label", 1, 120, "Setup field label");
    const kind = record.kind;
    if (kind !== "url" && kind !== "text" && kind !== "account") throw new PluginError("Setup field kind must be url, text, or account.");
    if (typeof record.required !== "boolean") throw new PluginError("Setup field required must be true or false.");
    if (record.account !== undefined && kind !== "account") throw new PluginError("Setup field account is only valid when kind is account.");
    let account: "google" | "microsoft" | undefined;
    if (kind === "account") {
      if (record.account !== "google" && record.account !== "microsoft") throw new PluginError("An account setup field must be google or microsoft.");
      account = record.account;
    }
    if (names.has(name)) throw new PluginError(`Setup field ${name} is listed twice.`);
    names.add(name);
    return account ? { name, label, kind, required: record.required, account } : { name, label, kind, required: record.required };
  });
}

function parsePermissions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new PluginError("Plugin permissions must be a list.");
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new PluginError("Plugin permissions must be strings.");
    if (REJECTED_PERMISSIONS.has(item)) throw new PluginError(`Permission ${item} is rejected.`);
    if (!PERMISSIONS.has(item)) throw new PluginError(`Unknown permission ${item}.`);
    if (seen.has(item)) throw new PluginError(`Permission ${item} is listed twice.`);
    seen.add(item);
  }
  return [...seen];
}

function parseAccounts(value: unknown): Array<"google" | "microsoft"> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) throw new PluginError("Plugin accounts must be a list of google, microsoft, or both.");
  const accounts: Array<"google" | "microsoft"> = [];
  for (const item of value) {
    if (typeof item !== "string" || !ACCOUNT_NAMES.has(item)) throw new PluginError("Plugin accounts must be google or microsoft.");
    const account = item as "google" | "microsoft";
    if (accounts.includes(account)) throw new PluginError(`Account ${account} is listed twice.`);
    accounts.push(account);
  }
  return accounts;
}

async function readCatalogRaw(): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(shippedCatalogPath(), "utf8");
  } catch (error) {
    const missing = error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
    throw new PluginError(missing ? "Shipped plugin catalog is missing." : "Shipped plugin catalog is unreadable.", 500);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not a list");
    return parsed;
  } catch {
    throw new PluginError("Shipped plugin catalog is unreadable.", 500);
  }
}

function installsPath(root: string): string {
  return path.join(root, "plugins.json");
}

async function readInstalls(root: string): Promise<BotPluginInstall[]> {
  try {
    const parsed = JSON.parse(await readFile(installsPath(root), "utf8")) as unknown;
    if (!isPlainObject(parsed) || !Array.isArray(parsed.installs)) throw new PluginError("Plugin install records are unreadable.", 500);
    return parsed.installs.map((item) => assertInstallRecord(item));
  } catch (error) {
    const missing = error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
    if (missing) return [];
    if (error instanceof PluginError) throw error;
    throw new PluginError("Plugin install records are unreadable.", 500);
  }
}

async function writeInstalls(root: string, installs: BotPluginInstall[]): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  const target = installsPath(root);
  await writeFile(target, `${JSON.stringify({ installs }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
}

function assertInstallRecord(value: unknown): BotPluginInstall {
  const record = plainObject(value, "Plugin install record");
  const pluginId = typeof record.pluginId === "string" ? record.pluginId : "";
  const version = typeof record.version === "string" ? record.version : "";
  const checksum = typeof record.checksum === "string" ? record.checksum : "";
  const botId = typeof record.botId === "string" ? record.botId : "";
  const installedAt = typeof record.installedAt === "string" ? record.installedAt : "";
  if (!pluginId || !version || !checksum || !botId || !installedAt) throw new PluginError("Plugin install records are unreadable.", 500);
  const connectorNames = stringList(record.connectorNames);
  const skillIds = stringList(record.skillIds);
  const vaultItemNames = stringList(record.vaultItemNames);
  if (!connectorNames || !skillIds || !vaultItemNames) throw new PluginError("Plugin install records are unreadable.", 500);
  const skillChecksums = stringMap(record.skillChecksums ?? {}, "Skill checksums");
  const fields = stringMap(record.fields ?? {}, "Install fields");
  return { pluginId, version, checksum, botId, connectorNames, skillIds, skillChecksums, vaultItemNames, fields, installedAt };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new PluginError(`${label} must be an object.`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new PluginError(`${label} must be text.`);
    out[key] = item;
  }
  return out;
}

function requiredString(record: Record<string, unknown>, key: string, min: number, max: number, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new PluginError(`${label} is required.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new PluginError(`${label} must be ${min} to ${max} characters.`);
  return trimmed;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new PluginError(`Unknown key "${key}" in plugin manifest.`);
  }
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new PluginError(`${label} must be an object.`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
