import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROVIDER_PRESETS } from "./provider-presets.js";
import {
  applyProviderSettingsToEnv,
  bootstrapFleet,
  createBot,
  defaultBotInstructions,
  listBots,
  readProviderSettings,
  saveProviderSettings,
  type ProviderSettings,
} from "./index.js";
import { createResponsibility, listResponsibilities } from "./teammate.js";

const DESK_GOAL = "Keep this workspace building, and bring every change back for a person to review.";

export interface OnboardingRecord {
  dismissed: boolean;
  force: boolean;
  completedAt?: string;
  preset?: "desk" | "coder";
}

export interface OnboardingView {
  required: boolean;
  dismissed: boolean;
  modelConfigured: boolean;
  botCount: number;
  inDocker: boolean;
  workspace: string;
  limits: string[];
  local: string[];
  docker: string[];
  modelNote: string;
  presets: Array<{ id: "desk" | "coder"; title: string; detail: string }>;
}

const LOCAL_COMMANDS = [
  "git clone https://github.com/bgagandeep/OpenCodingPartner.git",
  "cd OpenCodingPartner",
  "sh scripts/start-local.sh",
];

const DOCKER_COMMANDS = [
  "git clone https://github.com/bgagandeep/OpenCodingPartner.git",
  "cd OpenCodingPartner",
  "sh scripts/start-docker.sh",
];

export function onboardingLimits(): string[] {
  return [
    "No model is included. The header stays No model configured until you save a model id.",
    "The app accepts loopback only. The Docker compose file publishes 127.0.0.1:4317 and no other address.",
    "Voice and meetings are not in this app.",
    "Slack and Telegram leave only after you send the draft. A WhatsApp draft is not sent, even after you allow it.",
    "Company sign-in checks a signed assertion on this machine and does not contact a company directory.",
  ];
}

export function onboardingCliText(): string {
  return [
    "Open Coding Partner starts on this machine or in Docker.",
    "",
    "On this machine:",
    ...LOCAL_COMMANDS.map((line) => `  ${line}`),
    "  Open http://127.0.0.1:4317",
    "",
    "In Docker, published on loopback only:",
    ...DOCKER_COMMANDS.map((line) => `  ${line}`),
    "  Open http://127.0.0.1:4317",
    "  Optional model server beside it: docker compose --profile ollama up -d",
    "",
    "The first page asks for a model id and can open a desk: a lead, a coder, a reviewer, a security bot, and a computer bot, plus one standing responsibility on the coder.",
    "Skipping leaves the header on No model configured until Settings has one.",
    "",
    ...onboardingLimits(),
    "",
  ].join("\n");
}

export async function readOnboardingRecord(root: string): Promise<OnboardingRecord> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "onboarding.json"), "utf8")) as Partial<OnboardingRecord>;
    const preset = parsed.preset === "desk" || parsed.preset === "coder" ? parsed.preset : undefined;
    return {
      dismissed: parsed.dismissed === true,
      force: parsed.force === true,
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
      preset,
    };
  } catch {
    return { dismissed: false, force: false };
  }
}

export async function writeOnboardingRecord(root: string, record: OnboardingRecord): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, "onboarding.json");
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
}

export function onboardingView(input: {
  settings: ProviderSettings;
  env: NodeJS.ProcessEnv;
  botCount: number;
  record: OnboardingRecord;
  workspace: string;
}): OnboardingView {
  const effective = applyProviderSettingsToEnv(input.settings, input.env);
  const model = (effective.OCP_DEFAULT_MODEL || input.settings.defaultModel || "").trim();
  const local = Boolean(effective.LITELLM_BASE_URL);
  const hosted = Boolean(effective.OPENROUTER_API_KEY || effective.OPENAI_API_KEY);
  const inDocker = input.env.OCP_DOCKER_BIND === "bridge";
  return {
    required: input.record.force || (!input.record.dismissed && input.botCount === 0),
    dismissed: input.record.dismissed,
    modelConfigured: Boolean(model && (local || hosted)),
    botCount: input.botCount,
    inDocker,
    workspace: input.workspace,
    limits: onboardingLimits(),
    local: LOCAL_COMMANDS,
    docker: DOCKER_COMMANDS,
    modelNote: inDocker
      ? "This process is the Docker image. Use http://ollama:11434/v1 with the ollama profile, or http://host.docker.internal:11434/v1 when the model server is on the host. 127.0.0.1 inside the container is the container itself."
      : "A model server on this machine uses 127.0.0.1. Ollama is http://127.0.0.1:11434/v1. LM Studio is http://127.0.0.1:1234/v1. vLLM is http://127.0.0.1:8000/v1.",
    presets: [
      {
        id: "desk",
        title: "Open the desk",
        detail: "Lead, coder, reviewer, security, and computer. One standing responsibility on the coder.",
      },
      {
        id: "coder",
        title: "Coder only",
        detail: "One coding teammate in this workspace.",
      },
    ],
  };
}

function modelId(value: unknown): string {
  const model = typeof value === "string" ? value.trim() : "";
  if (!model || model.length > 200 || /[\r\n\0]/.test(model)) {
    throw new Error("Enter the model id this server serves.");
  }
  return model;
}

function secret(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (key.length > 500 || /[\r\n\0]/.test(key)) throw new Error("That key is not usable.");
  return key;
}

function httpBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter an http or https base URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Enter an http or https base URL.");
  if (url.username || url.password) throw new Error("Put the key in the key field. The base URL cannot contain one.");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function presetBase(provider: string): string {
  const preset = PROVIDER_PRESETS.find((item) => item.id === provider);
  if (!preset?.baseUrl) throw new Error("Choose a model server.");
  return preset.baseUrl;
}

export async function applyOnboardingModel(
  root: string,
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const model = modelId(body.model);
  const provider = typeof body.provider === "string" ? body.provider : "";
  if (provider === "openrouter") {
    const key = secret(body.apiKey);
    const settings = await readProviderSettings(root);
    const effective = applyProviderSettingsToEnv(settings, env);
    if (!key && !effective.OPENROUTER_API_KEY) throw new Error("OpenRouter needs a key.");
    await saveProviderSettings({
      ...(key ? { openrouterApiKey: key } : {}),
      defaultModel: model,
    }, root);
    return;
  }
  const base = provider === "custom" ? httpBase(typeof body.baseUrl === "string" ? body.baseUrl : "") : presetBase(provider);
  const key = secret(body.apiKey);
  await saveProviderSettings({
    litellmBaseUrl: base,
    defaultModel: model,
    ...(key ? { litellmApiKey: key } : {}),
  }, root);
}

async function ensureCoder(root: string, workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  const existing = await listBots(root, workspace);
  if (existing.some((bot) => bot.name.toLocaleLowerCase() === "linus")) return;
  await createBot({
    name: "Linus",
    role: "coding",
    runtime: "ocp-coder",
    workspace,
    instructions: defaultBotInstructions("coding"),
  }, root);
}

async function ensureDesk(root: string, workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await bootstrapFleet(workspace, "team", root);
  const bots = await listBots(root, workspace);
  const coder = bots.find((bot) => bot.name.toLocaleLowerCase() === "linus");
  if (!coder) return;
  const open = (await listResponsibilities(root)).filter((item) => item.botId === coder.id && item.status === "open");
  if (open.some((item) => item.goal === DESK_GOAL)) return;
  await createResponsibility(root, coder.id, DESK_GOAL);
}

export async function handleOnboardingPost(
  root: string,
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<OnboardingView> {
  const action = typeof body.action === "string" ? body.action : "";
  const workspace = typeof body.workspace === "string" && body.workspace.trim()
    ? body.workspace.trim()
    : env.OCP_WORKSPACE?.trim() || process.cwd();
  if (action === "reopen") {
    await writeOnboardingRecord(root, { dismissed: false, force: true });
  } else if (action === "skip") {
    await writeOnboardingRecord(root, { dismissed: true, force: false, completedAt: new Date().toISOString() });
  } else if (action === "model") {
    await applyOnboardingModel(root, body, env);
  } else if (action === "desk" || action === "coder") {
    if (typeof body.model === "string" && body.model.trim()) await applyOnboardingModel(root, body, env);
    if (action === "desk") await ensureDesk(root, workspace);
    else await ensureCoder(root, workspace);
    await writeOnboardingRecord(root, {
      dismissed: true,
      force: false,
      completedAt: new Date().toISOString(),
      preset: action,
    });
  } else {
    throw new Error("Unknown onboarding action.");
  }
  return loadOnboardingView(root, env, workspace);
}

export async function loadOnboardingView(root: string, env: NodeJS.ProcessEnv, workspace?: string): Promise<OnboardingView> {
  const [settings, bots, record] = await Promise.all([
    readProviderSettings(root),
    listBots(root),
    readOnboardingRecord(root),
  ]);
  return onboardingView({
    settings,
    env,
    botCount: bots.length,
    record,
    workspace: workspace || env.OCP_WORKSPACE?.trim() || process.cwd(),
  });
}
