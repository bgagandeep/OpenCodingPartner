import { spawn } from "node:child_process";
import { BOARD_SESSION_KEY } from "@opencodingpartner/mesh";
import { runOnGrokBuild, type InjectedRunner } from "@opencodingpartner/workers";
import type { StackBins } from "./discover.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ConnectedDeps {
  env: NodeJS.ProcessEnv;
  bins: StackBins;
  gatewayHttp?: string;
  fetchImpl?: typeof fetch;
  exec?: (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<ExecResult>;
  grokRunner?: InjectedRunner;
  cwd?: string;
}

export interface ConnectedReport {
  code: number;
  transcript: string;
}

const CHAT_MESSAGE = "Stand up a coding agent and a QA agent. Reply with ready.";

export interface OrchestrationNotice {
  state: "ran" | "skipped" | "failed";
  detail: string;
}

/** Send one user message to the OpenClaw gateway. Skip when it is down. */
export async function sendOrchestrationTurn(message: string, deps: ConnectedDeps): Promise<OrchestrationNotice> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const exec = deps.exec ?? defaultExec;
  const gatewayHttp = (deps.gatewayHttp ?? deps.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789").replace(/\/$/, "");
  const up = await gatewayIsUp(gatewayHttp, fetchImpl);
  if (!up) return { state: "skipped", detail: `OpenClaw gateway skipped (${gatewayHttp}/healthz did not answer).` };
  if (deps.bins.openclawBin) {
    const args = [
      "gateway",
      "call",
      "sessions.send",
      "--params",
      JSON.stringify({ key: BOARD_SESSION_KEY, message }),
      "--timeout",
      "15000",
      "--port",
      new URL(gatewayHttp).port || "18789",
    ];
    if (deps.env.OPENCLAW_GATEWAY_TOKEN) args.push("--token", deps.env.OPENCLAW_GATEWAY_TOKEN);
    const sent = await exec(deps.bins.openclawBin, args, deps.env);
    return sent.code === 0
      ? { state: "ran", detail: `OpenClaw session ${BOARD_SESSION_KEY} accepted the turn.` }
      : { state: "failed", detail: "OpenClaw gateway was up, but sessions.send did not succeed." };
  }
  const headers: Record<string, string> = { "content-type": "application/json", "x-openclaw-session-key": BOARD_SESSION_KEY };
  if (deps.env.OPENCLAW_GATEWAY_TOKEN) headers.authorization = `Bearer ${deps.env.OPENCLAW_GATEWAY_TOKEN}`;
  try {
    const response = await fetchImpl(`${gatewayHttp}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "openclaw/default", user: "conv:board", messages: [{ role: "user", content: message }] }),
      signal: AbortSignal.timeout(15000),
    });
    return response.ok
      ? { state: "ran", detail: `OpenClaw chat completions accepted session ${BOARD_SESSION_KEY}.` }
      : { state: "failed", detail: `OpenClaw chat completions returned HTTP ${response.status}.` };
  } catch {
    return { state: "failed", detail: "OpenClaw gateway was up, but the chat request did not finish." };
  }
}

export function grokRunnerForBin(bin: string, env: NodeJS.ProcessEnv, exec?: ConnectedDeps["exec"]): InjectedRunner {
  return spawnGrokRunner(bin, env, exec ?? defaultExec);
}

function defaultExec(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function spawnGrokRunner(bin: string, env: NodeJS.ProcessEnv, exec: ConnectedDeps["exec"]): InjectedRunner {
  const run = exec ?? defaultExec;
  return {
    async run(argv) {
      const args = argv[0] === "grok" ? argv.slice(1) : [...argv];
      const result = await run(bin, args, env);
      return { exitCode: result.code, stdout: result.stdout };
    },
  };
}

async function gatewayIsUp(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Talk to a live OpenClaw gateway and dispatch coding/QA through the Grok Build runner.
 * Each step says whether it ran or was skipped. Secrets are never printed.
 */
export async function runConnectedPath(deps: ConnectedDeps): Promise<ConnectedReport> {
  const exec = deps.exec ?? defaultExec;
  const lines: string[] = ["Connected path"];
  let failed = false;

  const orchestration = await sendOrchestrationTurn(CHAT_MESSAGE, deps);
  if (orchestration.state === "skipped") {
    lines.push(`OpenClaw gateway: skipped (${orchestration.detail})`);
    lines.push("Chat turn: skipped (gateway down). Start it with: docker compose up -d openclaw-gateway");
  } else if (orchestration.state === "ran") {
    lines.push(`OpenClaw gateway: ran. ${orchestration.detail}`);
    lines.push(`Chat turn: ran. ${orchestration.detail}`);
  } else {
    failed = true;
    lines.push(`Chat turn: failed. ${orchestration.detail}`);
  }

  if (!deps.bins.grokBin && !deps.grokRunner) {
    lines.push("Coding/QA on Grok Build: skipped (grok binary not installed). Run: pnpm bundle:install");
  } else if (!deps.env.XAI_API_KEY) {
    lines.push("Coding/QA on Grok Build: skipped (set XAI_API_KEY to the operator key; this repo does not store one).");
  } else {
    const runner = deps.grokRunner ?? spawnGrokRunner(deps.bins.grokBin ?? "grok", deps.env, exec);
    const cwd = deps.cwd ?? process.cwd();
    const coding = await runOnGrokBuild(runner, "Coding agent: say ready.", cwd);
    const qa = await runOnGrokBuild(runner, "QA agent: check the last change.", cwd);
    if (coding.exitCode === 0 && qa.exitCode === 0) {
      lines.push("Coding/QA on Grok Build: ran (two headless grok calls, streaming-json).");
    } else {
      failed = true;
      lines.push(`Coding/QA on Grok Build: failed (coding exit ${coding.exitCode}, QA exit ${qa.exitCode}).`);
    }
  }

  lines.push("The offline sandbox demo does not use this path.");
  return { code: failed ? 1 : 0, transcript: `${lines.join("\n")}\n` };
}
