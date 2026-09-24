import { access } from "node:fs/promises";
import path from "node:path";
import { resolveCodingMeter } from "./connected.js";
import type { StackBins } from "./discover.js";

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  bins: StackBins;
  repoRoot: string;
  gatewayHttp?: string;
  fetchImpl?: typeof fetch;
  playwrightPresent?: boolean;
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
  lines.push(await pluginLine(deps.repoRoot));
  lines.push(playwrightLine(deps.playwrightPresent === true));
  lines.push("Prove-it: pnpm exec ocp chat --sandbox .sandbox \"Use Grok Build to create hello.txt with content:");
  lines.push("hello");
  lines.push("\"");
  lines.push("The transcript says System-1: real Laya or System-1: fallback. It says Write path: OpenClaw-driven only after the gateway accepts the plan. Otherwise it says Write path: local sandbox. Meter: none means no live meter ran.");
  lines.push("The offline demo does not pretend Laya, the meter, or the gateway are live.");
  const transcript = `${lines.join("\n")}\n`;
  const red = lines.some((line) => line.startsWith("red "));
  return { code: red ? 1 : 0, transcript };
}

function layaLine(bins: StackBins): string {
  if (bins.layaPython && bins.layaHfHome) {
    return "green Laya weights: python and HF_HOME are present. A chat turn can say System-1: real Laya. If that call fails, the transcript says System-1: fallback.";
  }
  if (bins.layaPython) {
    return "yellow Laya weights: python is present but the English checkpoint directory is missing. The transcript will say System-1: fallback until pnpm bundle:install finishes the weight download.";
  }
  return "yellow Laya weights: not installed. System-1 will say fallback. Run pnpm bundle:install. System python is not Laya.";
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
    return "yellow Meter: XAI_API_KEY is set but grok is not installed. Set LITELLM_API_KEY, or install Grok Build with pnpm bundle:install. General edits will say Meter: none.";
  }
  return "yellow Meter: none. Set LITELLM_API_KEY or LITELLM_MASTER_KEY, or OPENAI_API_KEY and OPENAI_BASE_URL, or XAI_API_KEY with grok. A simple create-file still writes locally.";
}

async function gatewayLine(deps: DoctorDeps): Promise<string> {
  const gatewayHttp = (deps.gatewayHttp ?? deps.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789").replace(/\/$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${gatewayHttp}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (response.ok) {
      return `green OpenClaw /healthz: ${gatewayHttp} answered. Load integrations/openclaw-sandbox-write on that gateway before you expect an OpenClaw-driven write.`;
    }
    return `yellow OpenClaw /healthz: ${gatewayHttp} returned HTTP ${response.status}. The chat turn will use a local sandbox write.`;
  } catch {
    return `yellow OpenClaw /healthz: ${gatewayHttp} did not answer. Start it with docker compose up -d openclaw-gateway. The chat turn will use a local sandbox write.`;
  }
}

async function pluginLine(repoRoot: string): Promise<string> {
  const manifest = path.join(repoRoot, "integrations/openclaw-sandbox-write/openclaw.plugin.json");
  try {
    await access(manifest);
    return "green Write bridge plugin: integrations/openclaw-sandbox-write is in this repo. Load it on the gateway. This check does not prove the gateway loaded it. fs_write stays blocked.";
  } catch {
    return "red Write bridge plugin: integrations/openclaw-sandbox-write is missing. The gateway cannot invoke ocp_sandbox_write until that plugin is present.";
  }
}

function playwrightLine(present: boolean): string {
  if (present) return "green Playwright: installed. --computer-execute can open a page after you install Chromium with pnpm exec playwright install chromium.";
  return "yellow Playwright: not installed. Needed only for --computer-execute. The plan-only computer path still records executed: false.";
}
