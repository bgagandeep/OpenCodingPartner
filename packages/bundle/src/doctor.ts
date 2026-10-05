import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { BOARD_SESSION_KEY } from "@opencodingpartner/mesh";
import { resolveCodingMeter } from "./connected.js";
import type { StackBins } from "./discover.js";

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  bins: StackBins;
  repoRoot: string;
  gatewayHttp?: string;
  fetchImpl?: typeof fetch;
  playwrightPresent?: boolean;
  fleetLine?: string;
  approveLine?: string;
  frameLine?: string;
  dockerLine?: string;
  reviewLine?: string;
  agreementLine?: string;
  todoLine?: string;
  runLine?: string;
}

export interface DoctorReport {
  code: number;
  transcript: string;
}

/** Green, yellow, or red lines. Secrets are not printed. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const lines: string[] = ["ocp doctor"];
  lines.push(layaLine(deps.bins));
  lines.push(meterLine(deps));
  lines.push(await gatewayLine(deps));
  lines.push(await pluginLine(deps));
  lines.push(playwrightLine(deps.playwrightPresent === true));
  lines.push(slackLine(deps.env));
  lines.push(telegramLine(deps.env));
  lines.push(deps.fleetLine ?? "yellow Fleet: no partners. This check does not start containers. No telemetry is sent.");
  lines.push(deps.approveLine ?? "green Approvals: none pending. This check does not decide a card.");
  lines.push(deps.frameLine ?? "yellow Computer frame: none at gtm/last-frame.png. This check does not start the browser.");
  lines.push(deps.dockerLine ?? dockerLine(false));
  lines.push(deps.reviewLine ?? "green Review hold: none. One coding worker is not forced.");
  lines.push(deps.agreementLine ?? "yellow Partner agreement: PARTNER.md is missing. Edits do not wait for approve. This check does not copy the file or decide a card.");
  lines.push(deps.todoLine ?? "green Todos: none open. This check does not change the list.");
  lines.push(deps.runLine ?? "yellow Computer run: none. This check does not open a page.");
  lines.push("Prove-it: pnpm exec ocp chat --sandbox .sandbox \"Use the coding worker to create hello.txt with content:");
  lines.push("hello");
  lines.push("\"");
  lines.push("The transcript says System-1: real or System-1: fallback. It says Write path: orchestration only after the gateway accepts the plan. Otherwise it says Write path: local sandbox. Meter: none means no live meter ran.");
  lines.push("The offline demo does not pretend System-1, the meter, or the gateway are live.");
  const transcript = `${lines.join("\n")}\n`;
  const red = lines.some((line) => line.startsWith("red "));
  return { code: red ? 1 : 0, transcript };
}

function layaLine(bins: StackBins): string {
  if (bins.layaPython && bins.layaHfHome) {
    return "green System-1: python and weights are present. A chat turn can say System-1: real. If that call fails, the transcript says System-1: fallback.";
  }
  if (bins.layaPython) {
    return "yellow System-1: python is present but the checkpoint directory is missing. The transcript will say System-1: fallback until pnpm bundle:install finishes the weight download.";
  }
  return "yellow System-1: not installed. The transcript will say System-1: fallback. Run pnpm bundle:install. System python is not System-1.";
}

function meterLine(deps: DoctorDeps): string {
  const meter = resolveCodingMeter(deps.bins, deps.env);
  if (meter.label) {
    return `green Meter: ${meter.label} is selected. The key is not printed. General edits use this meter. A create-file with the gateway down still writes on the local sandbox.`;
  }
  if (deps.env.OPENAI_API_KEY && !deps.env.OPENAI_BASE_URL) {
    return "yellow Meter: OPENAI_API_KEY is set but OPENAI_BASE_URL is missing. Set both, or set LITELLM_API_KEY. General edits will say Meter: none.";
  }
  if (deps.env.XAI_API_KEY && !deps.bins.grokBin) {
    return "yellow Meter: XAI_API_KEY is set but the coding worker binary is not installed. Set LITELLM_API_KEY, or run pnpm bundle:install. General edits will say Meter: none.";
  }
  return "yellow Meter: none. Set LITELLM_API_KEY or LITELLM_MASTER_KEY, or OPENAI_API_KEY and OPENAI_BASE_URL, or XAI_API_KEY with grok. A simple create-file still writes locally.";
}

async function gatewayLine(deps: DoctorDeps): Promise<string> {
  const gatewayHttp = (deps.gatewayHttp ?? deps.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789").replace(/\/$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${gatewayHttp}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (response.ok) {
      return `green orchestration /healthz: ${gatewayHttp} answered. Load integrations/openclaw-sandbox-write on that gateway before you expect Write path: orchestration.`;
    }
    return `yellow orchestration /healthz: ${gatewayHttp} returned HTTP ${response.status}. The chat turn will use a local sandbox write.`;
  } catch {
    return `yellow orchestration /healthz: ${gatewayHttp} did not answer. Start it with docker compose up -d openclaw-gateway. The chat turn will use a local sandbox write.`;
  }
}

async function pluginLine(deps: DoctorDeps): Promise<string> {
  const manifest = path.join(deps.repoRoot, "integrations/openclaw-sandbox-write/openclaw.plugin.json");
  try {
    await access(manifest);
  } catch {
    return "red Write bridge plugin: integrations/openclaw-sandbox-write is missing. The gateway cannot invoke ocp_sandbox_write until that plugin is present.";
  }
  const gatewayHttp = (deps.gatewayHttp ?? deps.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789").replace(/\/$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;
  let up = false;
  try {
    const health = await fetchImpl(`${gatewayHttp}/healthz`, { signal: AbortSignal.timeout(1500) });
    up = health.ok;
  } catch {
    up = false;
  }
  if (!up) {
    return "green Write bridge plugin: integrations/openclaw-sandbox-write is in this repo. The gateway did not answer, so this check does not prove it loaded. fs_write stays blocked.";
  }
  const headers: Record<string, string> = { "content-type": "application/json", "x-openclaw-session-key": BOARD_SESSION_KEY };
  if (deps.env.OPENCLAW_GATEWAY_TOKEN) headers.authorization = `Bearer ${deps.env.OPENCLAW_GATEWAY_TOKEN}`;
  try {
    const response = await fetchImpl(`${gatewayHttp}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: "ocp_sandbox_todo", sessionKey: BOARD_SESSION_KEY, args: { action: "status" } }),
      signal: AbortSignal.timeout(1500),
    });
    if (response.status === 404) {
      return "yellow Write bridge plugin: the gateway did not offer ocp_sandbox_todo. Load integrations/openclaw-sandbox-write on that gateway. This check does not update a list. fs_write stays blocked.";
    }
    return "green Write bridge plugin: the gateway offered ocp_sandbox_todo. This check does not update a list. fs_write stays blocked.";
  } catch {
    return "yellow Write bridge plugin: the gateway answered, but the tool check did not finish. This check does not update a list. fs_write stays blocked.";
  }
}

function telegramLine(env: NodeJS.ProcessEnv): string {
  const missing = [env.TELEGRAM_BOT_TOKEN ? "" : "TELEGRAM_BOT_TOKEN", env.TELEGRAM_WEBHOOK_SECRET ? "" : "TELEGRAM_WEBHOOK_SECRET"].filter((name) => name.length > 0);
  if (missing.length === 0) return "green Telegram: bot token and webhook secret are set. The values are not printed.";
  return `yellow Telegram: missing ${missing.join(", ")}. The offline channel path still runs.`;
}

/** Report whether `docker version` answered. This does not start a container. */
export function dockerLine(present: boolean): string {
  if (present) return "green Docker: the docker command answered. This check does not start containers. No telemetry is sent.";
  return "yellow Docker: docker is not available. ocp fleet start will not start a container. This check does not start containers.";
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read one frame file. This does not start a browser. */
export async function computerFrameLine(sandboxRoot: string): Promise<string> {
  const where = "gtm/last-frame.png";
  try {
    const bytes = await readFile(path.join(sandboxRoot, where));
    const png = bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
    if (!png) return `yellow Computer frame: ${where} is not a PNG. This check does not start the browser.`;
    return `green Computer frame: a PNG is at ${where}. This check does not start the browser.`;
  } catch {
    return `yellow Computer frame: none at ${where}. This check does not start the browser.`;
  }
}

function slackLine(env: NodeJS.ProcessEnv): string {
  const missing = [env.SLACK_BOT_TOKEN ? "" : "SLACK_BOT_TOKEN", env.SLACK_SIGNING_SECRET ? "" : "SLACK_SIGNING_SECRET"].filter((name) => name.length > 0);
  if (missing.length === 0) return "green Slack: bot token and signing secret are set. The values are not printed.";
  return `yellow Slack: missing ${missing.join(", ")}. The offline channel path still runs.`;
}

function playwrightLine(present: boolean): string {
  if (present) {
    return "green Computer capture: Playwright is installed. ocp computer capture can write a frame after Chromium is installed. This check does not start the browser.";
  }
  return "yellow Computer capture: Playwright is not installed. ocp computer capture and --computer-execute need it. Install Chromium with pnpm exec playwright install chromium. This check does not start the browser. The plan-only computer path still records executed: false.";
}
