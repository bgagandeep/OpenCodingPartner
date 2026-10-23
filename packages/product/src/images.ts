import { installedPlugin } from "./plugins.js";
import { noteModelUsage, usageCapReason } from "./usage.js";
import { readVaultSecret } from "./vault.js";

const PLUGIN_ID = "image-generation";
const SECRET_NAME = "image-model-key";
const MAX_BODY = 1_000_000;

export async function generateOperatorImage(
  root: string,
  input: { botId: string; prompt: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv },
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 4_000) return { ok: false, detail: "Image prompt must be 1 to 4,000 characters." };
  const botId = input.botId.trim();
  const install = botId ? await installedPlugin(root, PLUGIN_ID, botId) : undefined;
  const baseUrl = install?.fields.imageUrl?.trim() ?? "";
  const model = install?.fields.modelId?.trim() ?? "";
  if (!install || !baseUrl || !model) {
    return { ok: false, detail: "No image provider is configured. Install Image generation and supply your own endpoint and key." };
  }
  const env = input.env ?? process.env;
  const apiKey = await readVaultSecret(root, SECRET_NAME, env);
  if (!apiKey) return { ok: false, detail: "No image provider is configured. The model key is missing from the vault." };
  const cap = await usageCapReason(root, botId);
  if (cap) return { ok: false, detail: cap };

  let endpoint: string;
  try {
    endpoint = imageGenerationsUrl(baseUrl);
  } catch {
    return { ok: false, detail: "The saved image endpoint URL is not usable." };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ model, prompt, n: 1 }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ok: false, detail: scrub(error instanceof Error ? error.message : "Image endpoint failed.", apiKey) };
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, detail: "Image endpoint redirected. The saved URL must be the image endpoint itself." };
  }
  const raw = await response.text();
  const usage = readUsage(raw);
  await noteModelUsage(root, {
    botId,
    model,
    provider: "custom",
    baseUrl,
    usage,
    promptText: prompt,
    completionText: "image",
    step: "image",
  });
  if (raw.length > MAX_BODY) return { ok: false, detail: "The image endpoint response was too large to keep." };
  if (!response.ok) return { ok: false, detail: `Image endpoint returned ${response.status}.` };
  const link = imageLink(raw);
  if (link && link.includes(apiKey)) return { ok: true, detail: "Image created on the operator endpoint. The link was omitted because it contained the key." };
  if (link) return { ok: true, detail: `Image created on the operator endpoint. ${link}`.slice(0, 2_000) };
  if (hasImageBytes(raw)) return { ok: true, detail: "Image bytes were returned by the operator endpoint. They were not written into the workspace." };
  return { ok: true, detail: "The operator endpoint accepted the image call. No image link was returned." };
}

function imageGenerationsUrl(base: string): string {
  const url = new URL(base);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Image endpoint URL is not usable.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/images/generations")) url.pathname = `${path}/images/generations`;
  return url.toString();
}

function readUsage(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as { usage?: unknown };
    return parsed && typeof parsed === "object" ? parsed.usage : undefined;
  } catch {
    return undefined;
  }
}

function imageLink(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { data?: unknown };
    const first = parsed && typeof parsed === "object" && Array.isArray(parsed.data) ? parsed.data[0] : undefined;
    if (!first || typeof first !== "object") return "";
    const url = (first as { url?: unknown }).url;
    return typeof url === "string" ? url : "";
  } catch {
    return "";
  }
}

function hasImageBytes(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { data?: unknown };
    const first = parsed && typeof parsed === "object" && Array.isArray(parsed.data) ? parsed.data[0] : undefined;
    return Boolean(first && typeof first === "object" && typeof (first as { b64_json?: unknown }).b64_json === "string");
  } catch {
    return false;
  }
}

function scrub(message: string, secret: string): string {
  if (secret.length < 4) return message.slice(0, 400);
  return message.split(secret).join("[redacted]").slice(0, 400);
}
