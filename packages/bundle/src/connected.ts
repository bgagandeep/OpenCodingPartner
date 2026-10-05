import { spawn } from "node:child_process";
import path from "node:path";
import { BOARD_SESSION_KEY } from "@opencodingpartner/mesh";
import { openAiCompatibleRunner, runOnGrokBuild, securityGate, type InjectedRunner } from "@opencodingpartner/workers";
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
  driver: "openclaw" | "local-swarm";
}

export interface SessionPlanInput {
  sessionKey: string;
  roles: readonly string[];
  steps: readonly string[];
}

function sessionPlan(message: string, plan?: SessionPlanInput): string {
  if (plan) {
    return [
      `Session plan for ${plan.sessionKey}.`,
      `Roles: ${plan.roles.join(", ") || "none"}.`,
      ...plan.steps,
      "User request:",
      message,
      "Plan JSON:",
      JSON.stringify({ sessionKey: plan.sessionKey, roles: plan.roles, steps: plan.steps }),
    ].join("\n");
  }
  return [
    `Session plan for ${BOARD_SESSION_KEY}.`,
    "Stand up a coding agent, a QA agent, a security agent, and a computer agent.",
    "A create-file request uses the gateway write tool after the plan is accepted.",
    "The gateway still blocks fs_write, apply_patch, and sessions_spawn.",
    "General model edits still run in this process on the coding worker or the meter.",
    "Security gates path escape and secrets.",
    "The computer agent records a GTM plan and does not run a browser.",
    "User request:",
    message,
  ].join("\n");
}

/** Ask the Orchestration gateway to own the session plan. The local swarm runs only when the gateway is down. */
export async function sendOrchestrationTurn(
  message: string,
  deps: ConnectedDeps,
  plan?: SessionPlanInput,
): Promise<OrchestrationNotice> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const exec = deps.exec ?? defaultExec;
  const gatewayHttp = (deps.gatewayHttp ?? deps.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789").replace(/\/$/, "");
  const up = await gatewayIsUp(gatewayHttp, fetchImpl);
  if (!up) {
    return { state: "skipped", driver: "local-swarm", detail: `Orchestration gateway skipped (${gatewayHttp}/healthz did not answer).` };
  }
  const planText = sessionPlan(message, plan);
  if (deps.bins.openclawBin) {
    const port = new URL(gatewayHttp).port || "18789";
    const tokenArgs = deps.env.OPENCLAW_GATEWAY_TOKEN ? ["--token", deps.env.OPENCLAW_GATEWAY_TOKEN] : [];
    const sent = await exec(
      deps.bins.openclawBin,
      ["gateway", "call", "sessions.send", "--params", JSON.stringify({ key: plan?.sessionKey ?? BOARD_SESSION_KEY, message: planText }), "--timeout", "15000", "--port", port, ...tokenArgs],
      deps.env,
    );
    if (sent.code !== 0) {
      return { state: "failed", driver: "openclaw", detail: "sessions.send did not accept the session plan." };
    }
    const skills = await exec(
      deps.bins.openclawBin,
      ["gateway", "call", "tools.invoke", "--params", JSON.stringify({ name: "skills.status", sessionKey: BOARD_SESSION_KEY, args: { agentId: "board" } }), "--timeout", "15000", "--port", port, ...tokenArgs],
      deps.env,
    );
    const skillsNote = skills.code === 0 ? "skills.status ran on the session." : "skills.status did not succeed. The session plan still drove the turn.";
    return { state: "ran", driver: "openclaw", detail: `Session ${BOARD_SESSION_KEY} accepted the plan. ${skillsNote}` };
  }
  const headers: Record<string, string> = { "content-type": "application/json", "x-openclaw-session-key": BOARD_SESSION_KEY };
  if (deps.env.OPENCLAW_GATEWAY_TOKEN) headers.authorization = `Bearer ${deps.env.OPENCLAW_GATEWAY_TOKEN}`;
  try {
    const response = await fetchImpl(`${gatewayHttp}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "openclaw/default", user: "conv:board", messages: [{ role: "user", content: planText }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { state: "failed", driver: "openclaw", detail: `Chat completions returned HTTP ${response.status}.` };
    const tools = await fetchImpl(`${gatewayHttp}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: "skills.status", sessionKey: BOARD_SESSION_KEY, args: { agentId: "board" } }),
      signal: AbortSignal.timeout(15000),
    });
    const skillsNote = tools.ok ? "skills.status ran on the session." : "skills.status did not succeed. The session plan still drove the turn.";
    return { state: "ran", driver: "openclaw", detail: `Orchestration accepted session ${BOARD_SESSION_KEY}. ${skillsNote}` };
  } catch {
    return { state: "failed", driver: "openclaw", detail: "The orchestration gateway was up, but the session plan did not finish." };
  }
}

export const LITELLM_LOCAL_BASE_URL = "http://127.0.0.1:4000/v1";

export type CodingMeterVia = "litellm" | "openai-compatible" | "grok-build";

export interface CodingMeter {
  runner?: InjectedRunner;
  via?: CodingMeterVia;
  label?: "proxy" | "compatible" | "worker";
  baseUrl?: string;
  model?: string;
}

/** LiteLLM vars win. Then the OpenAI pair. Then native Grok. */
export function resolveCodingMeter(
  bins: StackBins,
  env: NodeJS.ProcessEnv,
  options?: { fetchImpl?: typeof fetch; exec?: ConnectedDeps["exec"] },
): CodingMeter {
  const litellmKey = env.LITELLM_API_KEY || env.LITELLM_MASTER_KEY;
  if (litellmKey) {
    const baseUrl = env.LITELLM_BASE_URL || LITELLM_LOCAL_BASE_URL;
    const model = env.LITELLM_MODEL || env.OPENAI_MODEL || "gpt-4o-mini";
    return {
      runner: openAiCompatibleRunner({ apiKey: litellmKey, baseUrl, model, fetchImpl: options?.fetchImpl }),
      via: "litellm",
      label: "proxy",
      baseUrl,
      model,
    };
  }
  if (env.OPENAI_API_KEY && env.OPENAI_BASE_URL) {
    return {
      runner: openAiCompatibleRunner({
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL,
        model: env.OPENAI_MODEL,
        fetchImpl: options?.fetchImpl,
      }),
      via: "openai-compatible",
      label: "compatible",
      baseUrl: env.OPENAI_BASE_URL,
      model: env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }
  if (bins.grokBin && env.XAI_API_KEY) {
    return { runner: grokRunnerForBin(bins.grokBin, env, options?.exec), via: "grok-build", label: "worker" };
  }
  return {};
}

export function codingRunnerForEnv(bins: StackBins, env: NodeJS.ProcessEnv): CodingMeter {
  return resolveCodingMeter(bins, env);
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

export interface OpenClawWriteResult {
  ok: boolean;
  detail: string;
}

/**
 * Ask the Orchestration gateway to invoke the sandbox write bridge.
 * This function does not write the file. `fs_write` is never sent.
 * If the bridge tool is missing, the built-in `write` tool is the fallback.
 */
export async function writeViaOpenClaw(
  deps: ConnectedDeps,
  sandboxRoot: string,
  relativePath: string,
  content: string,
): Promise<OpenClawWriteResult> {
  const gate = securityGate({ relativePath, content, sandboxRoot });
  if (!gate.allow) {
    return { ok: false, detail: `Security gate blocked the write (${gate.reasons.join(", ")}).` };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const exec = deps.exec ?? defaultExec;
  const gatewayHttp = (deps.gatewayHttp ?? deps.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789").replace(/\/$/, "");
  const up = await gatewayIsUp(gatewayHttp, fetchImpl);
  if (!up) {
    return { ok: false, detail: "Orchestration gateway is not up. The write tool did not run." };
  }
  const bridgeUrl = deps.env.OCP_WRITE_BRIDGE_URL;
  if (bridgeUrl) {
    const bridged = await invokeGatewayTool(deps, gatewayHttp, exec, fetchImpl, "ocp_sandbox_write", {
      bridgeUrl,
      relativePath,
      content,
    });
    if (bridged.ok) return { ok: true, detail: "Orchestration invoked the sandbox write bridge." };
    if (!bridged.missing) return { ok: false, detail: bridged.detail };
  }
  const absolute = path.resolve(sandboxRoot, relativePath);
  const direct = await invokeGatewayTool(deps, gatewayHttp, exec, fetchImpl, "write", { path: absolute, content });
  if (direct.ok) return { ok: true, detail: "Orchestration write tool accepted the file." };
  return { ok: false, detail: direct.detail };
}

export interface OpenClawFileResult {
  ok: boolean;
  missing: boolean;
  detail: string;
}

/**
 * Ask the gateway to invoke the delete bridge. This function does not unlink the file.
 * `fs_delete` is never sent. A missing plugin returns missing so the turn can delete locally.
 */
export async function deleteViaOpenClaw(
  deps: ConnectedDeps,
  sandboxRoot: string,
  relativePath: string,
): Promise<OpenClawFileResult> {
  return invokeSandboxAction(deps, sandboxRoot, "ocp_sandbox_delete", "/delete", { relativePath }, relativePath);
}

/**
 * Ask the gateway to invoke the mkdir bridge. This function does not create the directory.
 * A missing plugin returns missing so the turn can mkdir locally.
 */
export async function mkdirViaOpenClaw(
  deps: ConnectedDeps,
  sandboxRoot: string,
  relativePath: string,
): Promise<OpenClawFileResult> {
  return invokeSandboxAction(deps, sandboxRoot, "ocp_sandbox_mkdir", "/mkdir", { relativePath }, relativePath);
}

/**
 * Ask the gateway to invoke the rmdir bridge. This function does not remove the directory.
 * A missing plugin returns missing so the turn can rmdir locally.
 */
export async function rmdirViaOpenClaw(
  deps: ConnectedDeps,
  sandboxRoot: string,
  relativePath: string,
): Promise<OpenClawFileResult> {
  return invokeSandboxAction(deps, sandboxRoot, "ocp_sandbox_rmdir", "/rmdir", { relativePath }, relativePath);
}

/**
 * Ask the gateway to invoke the copy bridge. This function does not copy the file.
 * A missing plugin returns missing so the turn can copy locally.
 */
export async function copyViaOpenClaw(
  deps: ConnectedDeps,
  sandboxRoot: string,
  fromPath: string,
  toPath: string,
): Promise<OpenClawFileResult> {
  return invokeSandboxAction(deps, sandboxRoot, "ocp_sandbox_copy", "/copy", { from: fromPath, to: toPath }, fromPath, toPath);
}

/**
 * Ask the gateway to invoke the append bridge. This function does not append the text.
 * A missing plugin returns missing so the turn can append locally. A refusal does not append locally.
 */
export async function appendViaOpenClaw(
  deps: ConnectedDeps,
  sandboxRoot: string,
  relativePath: string,
  content: string,
): Promise<OpenClawFileResult> {
  const gate = securityGate({ relativePath, content, sandboxRoot });
  if (!gate.allow) {
    return { ok: false, missing: false, detail: `Security gate blocked the path (${gate.reasons.join(", ")}).` };
  }
  return invokeSandboxAction(deps, sandboxRoot, "ocp_sandbox_append", "/append", { relativePath, content }, relativePath);
}

/**
 * Ask the gateway to invoke the rename bridge. This function does not move the file.
 * `fs_move` is never sent. A missing plugin returns missing so the turn can rename locally.
 */
export async function renameViaOpenClaw(
  deps: ConnectedDeps,
  sandboxRoot: string,
  fromPath: string,
  toPath: string,
): Promise<OpenClawFileResult> {
  return invokeSandboxAction(deps, sandboxRoot, "ocp_sandbox_rename", "/rename", { from: fromPath, to: toPath }, fromPath, toPath);
}

async function invokeSandboxAction(
  deps: ConnectedDeps,
  sandboxRoot: string,
  tool: "ocp_sandbox_delete" | "ocp_sandbox_rename" | "ocp_sandbox_mkdir" | "ocp_sandbox_rmdir" | "ocp_sandbox_copy" | "ocp_sandbox_append",
  actionPath: "/delete" | "/rename" | "/mkdir" | "/rmdir" | "/copy" | "/append",
  args: Record<string, string>,
  ...paths: string[]
): Promise<OpenClawFileResult> {
  for (const relativePath of paths) {
    const gate = securityGate({ relativePath, content: "", sandboxRoot });
    if (!gate.allow) {
      return { ok: false, missing: false, detail: `Security gate blocked the path (${gate.reasons.join(", ")}).` };
    }
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const exec = deps.exec ?? defaultExec;
  const gatewayHttp = (deps.gatewayHttp ?? deps.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789").replace(/\/$/, "");
  const up = await gatewayIsUp(gatewayHttp, fetchImpl);
  if (!up) {
    return { ok: false, missing: true, detail: "Orchestration gateway is not up. The tool did not run." };
  }
  const bridgeUrl = deps.env.OCP_WRITE_BRIDGE_URL;
  if (!bridgeUrl) {
    return { ok: false, missing: true, detail: "Write bridge URL is not set." };
  }
  const bridged = await invokeGatewayTool(deps, gatewayHttp, exec, fetchImpl, tool, {
    ...args,
    bridgeUrl: bridgeUrl.replace(/\/write$/, actionPath),
  });
  if (bridged.ok) return { ok: true, missing: false, detail: `Orchestration invoked the sandbox ${tool} bridge.` };
  if (bridged.missing) return { ok: false, missing: true, detail: bridged.detail };
  return { ok: false, missing: false, detail: bridged.detail };
}

const GATEWAY_TOOLS = new Set(["ocp_sandbox_write", "ocp_sandbox_delete", "ocp_sandbox_rename", "ocp_sandbox_mkdir", "ocp_sandbox_rmdir", "ocp_sandbox_copy", "ocp_sandbox_append", "write"]);

async function invokeGatewayTool(
  deps: ConnectedDeps,
  gatewayHttp: string,
  exec: NonNullable<ConnectedDeps["exec"]>,
  fetchImpl: typeof fetch,
  tool: "ocp_sandbox_write" | "ocp_sandbox_delete" | "ocp_sandbox_rename" | "ocp_sandbox_mkdir" | "ocp_sandbox_rmdir" | "ocp_sandbox_copy" | "ocp_sandbox_append" | "write",
  args: Record<string, string>,
): Promise<{ ok: boolean; missing: boolean; detail: string }> {
  if (!GATEWAY_TOOLS.has(tool)) {
    return { ok: false, missing: true, detail: "Refused tool." };
  }
  if (deps.bins.openclawBin) {
    const port = new URL(gatewayHttp).port || "18789";
    const tokenArgs = deps.env.OPENCLAW_GATEWAY_TOKEN ? ["--token", deps.env.OPENCLAW_GATEWAY_TOKEN] : [];
    const sent = await exec(
      deps.bins.openclawBin,
      [
        "gateway",
        "call",
        "tools.invoke",
        "--params",
        JSON.stringify({ name: tool, sessionKey: BOARD_SESSION_KEY, args }),
        "--timeout",
        "15000",
        "--port",
        port,
        ...tokenArgs,
      ],
      deps.env,
    );
    if (sent.code !== 0) {
      const missing = /not available|not_found|404/i.test(`${sent.stdout}\n${sent.stderr}`);
      return { ok: false, missing, detail: `Orchestration ${tool} did not accept the call.` };
    }
    return { ok: true, missing: false, detail: "accepted" };
  }
  const headers: Record<string, string> = { "content-type": "application/json", "x-openclaw-session-key": BOARD_SESSION_KEY };
  if (deps.env.OPENCLAW_GATEWAY_TOKEN) headers.authorization = `Bearer ${deps.env.OPENCLAW_GATEWAY_TOKEN}`;
  try {
    const response = await fetchImpl(`${gatewayHttp}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool, sessionKey: BOARD_SESSION_KEY, args }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return { ok: false, missing: true, detail: `Orchestration ${tool} is not available.` };
    if (!response.ok) return { ok: false, missing: false, detail: `Orchestration ${tool} returned HTTP ${response.status}.` };
    let body: { ok?: boolean } = {};
    try {
      body = (await response.json()) as { ok?: boolean };
    } catch {
      body = {};
    }
    if (body.ok === false) return { ok: false, missing: false, detail: `Orchestration ${tool} refused the file.` };
    return { ok: true, missing: false, detail: "accepted" };
  } catch {
    return { ok: false, missing: false, detail: `Orchestration ${tool} did not finish.` };
  }
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
 * Talk to a live Orchestration gateway and dispatch coding/QA through the Grok Build runner.
 * Each step says whether it ran or was skipped. Secrets are never printed.
 */
export async function runConnectedPath(deps: ConnectedDeps): Promise<ConnectedReport> {
  const exec = deps.exec ?? defaultExec;
  const lines: string[] = ["Connected path"];
  let failed = false;

  const orchestration = await sendOrchestrationTurn(CHAT_MESSAGE, deps);
  if (orchestration.state === "skipped") {
    lines.push(`Orchestration gateway: skipped (${orchestration.detail})`);
    lines.push("Chat turn: skipped (gateway down). Start it with: docker compose up -d openclaw-gateway");
  } else if (orchestration.state === "ran") {
    lines.push(`Orchestration gateway: ran. ${orchestration.detail}`);
    lines.push(`Chat turn: ran. ${orchestration.detail}`);
  } else {
    failed = true;
    lines.push(`Chat turn: failed. ${orchestration.detail}`);
  }

  const meter = deps.grokRunner
    ? { runner: deps.grokRunner, via: "grok-build" as const, label: "worker" as const }
    : resolveCodingMeter(deps.bins, deps.env, { exec });
  if (!meter.runner) {
    lines.push(
      "Coding/QA: skipped (set XAI_API_KEY with grok, or LITELLM_API_KEY, or OPENAI_API_KEY and OPENAI_BASE_URL; this repo does not store a key).",
    );
  } else {
    const runner = meter.runner;
    const cwd = deps.cwd ?? process.cwd();
    const coding = await runOnGrokBuild(runner, "Coding agent: say ready.", cwd);
    const qa = await runOnGrokBuild(runner, "QA agent: check the last change.", cwd);
    if (coding.exitCode === 0 && qa.exitCode === 0) {
      lines.push(
        meter.via === "grok-build"
          ? "Coding/QA on the coding worker: ran (two headless calls, streaming-json)."
          : `Coding/QA: ran. Meter: ${meter.label}.`,
      );
    } else {
      failed = true;
      lines.push(`Coding/QA: failed (coding exit ${coding.exitCode}, QA exit ${qa.exitCode}). Meter: ${meter.label}.`);
    }
  }

  lines.push("The offline sandbox demo does not use this path.");
  return { code: failed ? 1 : 0, transcript: `${lines.join("\n")}\n` };
}
