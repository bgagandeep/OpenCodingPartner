import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoodUpAgent, SwarmSession } from "@opencodingpartner/mesh";
import { boardSession } from "@opencodingpartner/mesh";
import { routeMessage, type ManagerPlan, type RouteDecision } from "@opencodingpartner/policy";
import { OrchestrationSwarm } from "@opencodingpartner/swarm";
import {
  parseCreateFileInstruction,
  planGtmActions,
  changedSandboxFiles,
  qaCheckFile,
  reviewChangedFiles,
  runOnGrokBuild,
  securityGate,
  snapshotSandbox,
  writeSandboxFile,
  type GateDecision,
  type GtmPlan,
  type InjectedRunner,
  type QaResult,
} from "@opencodingpartner/workers";

export const DEMO_MESSAGE = `Stand up a coding agent, a QA agent, a security agent, and a computer agent.
Use Grok Build to create PRODUCT.md with content:
OpenCodingPartner helps a team build and sell.
`;

export const DEMO_BLOCKED_MESSAGE = `Stand up a coding agent and a security agent.
Use Grok Build to create ../secret.txt with content:
password=hunter2
`;

export interface ChatTurnInput {
  message: string;
  sandboxRoot: string;
  /** When set, the turn sends this manager plan to OpenClaw. The plan is the only standup list. */
  orchestration?: (plan: ManagerPlan) => Promise<{
    state: "ran" | "skipped" | "failed";
    detail: string;
    driver?: "openclaw" | "local-swarm";
  }>;
  /** When set, the coding agent edits the sandbox through Grok Build or an OpenAI-compatible meter. */
  grokRunner?: InjectedRunner;
  /** Which meter the runner uses. Defaults to grok-build when a runner is set. */
  codingVia?: "grok-build" | "openai-compatible";
  /** Real Laya route. When omitted, the turn uses the fallback router and says so. */
  layaPredict?: (message: string) => Promise<RouteDecision>;
  /** Ask the computer agent to run. The stub still records executed: false. */
  computerExecute?: boolean;
}

export interface ChatTurnResult {
  session: SwarmSession;
  decision: RouteDecision;
  agents: StoodUpAgent[];
  security: GateDecision | null;
  coding: { relativePath: string; wrote: boolean; via: "local-sandbox" | "grok-build" | "openai-compatible"; note?: string } | null;
  plan: ManagerPlan;
  qa: QaResult | null;
  computer: GtmPlan | null;
  orchestration: string;
  computerExecuteRequested: boolean;
  replayed: boolean;
  transcript: string;
}

const lanes = new Map<string, Promise<void>>();
const completed = new Map<string, ChatTurnResult>();

function idempotencyKey(input: ChatTurnInput, sessionKey: string): string {
  const mode = input.codingVia ?? (input.grokRunner ? "grok-build" : "local-sandbox");
  return `${sessionKey}\n${path.resolve(input.sandboxRoot)}\n${mode}\n${input.message}`;
}

export function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const session = boardSession();
  const key = idempotencyKey(input, session.key);
  const cached = completed.get(key);
  if (cached) {
    return Promise.resolve({ ...cached, replayed: true, transcript: `${cached.transcript}Replayed the same turn.\n` });
  }
  const previous = lanes.get(session.key) ?? Promise.resolve();
  const run = previous.then(() => executeTurn(input, session, key));
  lanes.set(
    session.key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function stepsFor(decision: RouteDecision): string[] {
  if (decision.roles.length === 0) return ["No agents stand up. This turn stays on the status route."];
  return [
    "Stand up the roles in this plan. Do not add a second plan.",
    "OpenClaw does not write sandbox files.",
    "Coding and QA edit the sandbox from this process with Grok Build or the OpenAI-compatible meter.",
    "Security gates path escape and secrets.",
    "The computer agent records a GTM plan and does not run a browser.",
  ];
}

function codingVia(input: ChatTurnInput): "local-sandbox" | "grok-build" | "openai-compatible" {
  if (!input.grokRunner) return "local-sandbox";
  return input.codingVia ?? "grok-build";
}

async function executeTurn(input: ChatTurnInput, session: SwarmSession, key: string): Promise<ChatTurnResult> {
  const decision = input.layaPredict ? await input.layaPredict(input.message) : routeMessage(input.message);
  const swarm = new OrchestrationSwarm(session);
  const instruction = parseCreateFileInstruction(input.message);
  let security: GateDecision | null = null;
  let coding: ChatTurnResult["coding"] = null;
  let qa: QaResult | null = null;
  let computer: GtmPlan | null = null;
  let plan: ManagerPlan = {
    sessionKey: session.key,
    source: "local-manager",
    roles: [...decision.roles],
    steps: stepsFor(decision),
  };
  const notice = input.orchestration
    ? await input.orchestration(plan)
    : { state: "skipped" as const, detail: "OpenClaw gateway was not used. The local swarm ran this turn.", driver: "local-swarm" as const };
  const openclawDrove = notice.driver === "openclaw" && notice.state === "ran";
  const openclawFailed = notice.driver === "openclaw" && notice.state === "failed";
  if (openclawDrove) plan = { ...plan, source: "openclaw" };
  const agents = openclawFailed ? [] : swarm.standUp(plan.roles);
  const orchestration = openclawDrove
    ? `ran: OpenClaw accepted the session plan. ${notice.detail} OpenClaw does not write sandbox files. Coding workers in this process write them after the plan is accepted. The gateway blocks remote fs_write and sessions_spawn.`
    : openclawFailed
      ? `failed: OpenClaw gateway was up but did not accept the session plan. ${notice.detail} The local swarm did not take over.`
      : `${notice.state}: ${notice.detail}`;

  if (openclawFailed) {
    const failedResult: ChatTurnResult = {
      session,
      decision,
      agents,
      plan,
      security,
      coding,
      qa,
      computer,
      orchestration,
      computerExecuteRequested: input.computerExecute === true,
      replayed: false,
      transcript: "",
    };
    failedResult.transcript = formatTranscript(failedResult);
    completed.set(key, failedResult);
    return failedResult;
  }

  if (instruction && agents.some((agent) => agent.role === "security")) {
    security = swarm.dispatch("security", () =>
      securityGate({
        relativePath: instruction.relativePath,
        content: instruction.content,
        sandboxRoot: input.sandboxRoot,
      }),
    );
  }

  const via = codingVia(input);
  const generalEdit = !instruction && agents.some((agent) => agent.role === "coding");
  if (generalEdit) {
    const messageGate = securityGate({
      relativePath: "request.txt",
      content: input.message,
      sandboxRoot: input.sandboxRoot,
    });
    if (/(^|[\s"'`])\.\.\//.test(input.message)) messageGate.reasons.push("path escape");
    messageGate.allow = messageGate.reasons.length === 0;
    security = messageGate;
    if (!messageGate.allow) {
      coding = { relativePath: "the request", wrote: false, via };
    } else if (input.grokRunner) {
      const runner = input.grokRunner;
      const before = await snapshotSandbox(input.sandboxRoot);
      const grok = await swarm.dispatch("coding", () => runOnGrokBuild(runner, input.message, input.sandboxRoot));
      const after = await snapshotSandbox(input.sandboxRoot);
      const changed = changedSandboxFiles(before, after);
      const kept: string[] = [];
      const blocked: string[] = [];
      for (const relativePath of changed) {
        const content = after.get(relativePath) ?? "";
        const gate = securityGate({ relativePath, content, sandboxRoot: input.sandboxRoot });
        if (gate.allow) kept.push(relativePath);
        else {
          blocked.push(relativePath);
          await unlink(path.join(input.sandboxRoot, relativePath)).catch(() => undefined);
          security = { allow: false, reasons: gate.reasons };
        }
      }
      coding = {
        relativePath: kept.length > 0 ? kept.join(", ") : "no files",
        wrote: grok.exitCode === 0 && kept.length > 0,
        via,
      };
      if (agents.some((agent) => agent.role === "qa")) {
        qa = await swarm.dispatch("qa", () => reviewChangedFiles(input.sandboxRoot, kept, grok.exitCode === 0));
      }
      if (blocked.length > 0) {
        coding.note = `Security agent removed ${blocked.join(", ")} after the edit.`;
      }
    } else {
      coding = {
        relativePath: "general edit",
        wrote: false,
        via: "local-sandbox",
        note: "Coding agent did not edit files. General edits need XAI_API_KEY and Grok Build, or OPENAI_API_KEY and OPENAI_BASE_URL. A simple create-file message still runs on the local sandbox.",
      };
    }
  }

  if (instruction && agents.some((agent) => agent.role === "coding")) {
    if (security?.allow && input.grokRunner) {
      const runner = input.grokRunner;
      const prompt = `Coding agent: write ${instruction.relativePath} with this exact content and nothing else:\n${instruction.content}`;
      const grok = await swarm.dispatch("coding", () => runOnGrokBuild(runner, prompt, input.sandboxRoot));
      coding = { relativePath: instruction.relativePath, wrote: grok.exitCode === 0, via };
      if (agents.some((agent) => agent.role === "qa")) {
        qa = await swarm.dispatch("qa", () => qaCheckFile(input.sandboxRoot, instruction.relativePath, instruction.content));
      }
    } else if (security?.allow) {
      await swarm.dispatch("coding", async () => {
        await writeSandboxFile(input.sandboxRoot, instruction.relativePath, instruction.content);
      });
      coding = { relativePath: instruction.relativePath, wrote: true, via: "local-sandbox" };
      if (agents.some((agent) => agent.role === "qa")) {
        qa = await swarm.dispatch("qa", () =>
          qaCheckFile(input.sandboxRoot, instruction.relativePath, instruction.content),
        );
      }
    } else {
      coding = { relativePath: instruction.relativePath, wrote: false, via };
    }
  }

  if (agents.some((agent) => agent.role === "computer")) {
    computer = swarm.dispatch("computer", () => planGtmActions("OpenCodingPartner"));
    const planPath = path.join(input.sandboxRoot, "gtm", "action-plan.json");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, `${JSON.stringify(computer, null, 2)}\n`);
  }

  const result: ChatTurnResult = {
    session,
    decision,
    agents,
    plan,
    security,
    coding,
    qa,
    computer,
    orchestration,
    computerExecuteRequested: input.computerExecute === true,
    replayed: false,
    transcript: formatTranscript({
      session,
      decision,
      agents,
      plan,
      security,
      coding,
      qa,
      computer,
      orchestration,
      computerExecuteRequested: input.computerExecute === true,
      replayed: false,
      transcript: "",
    }),
  };
  completed.set(key, result);
  return result;
}

export function formatTranscript(result: ChatTurnResult): string {
  const lines: string[] = [
    "Chat agent",
    `Session: ${result.session.key}`,
    `Binding: channel=${result.session.binding.channel} account=${result.session.binding.accountId} agent=${result.session.binding.agentId}`,
    `Route: ${result.decision.route}`,
    result.decision.note,
    `Manager plan (${result.plan.source}):`,
    JSON.stringify(result.plan),
    `Orchestration: ${result.orchestration}`,
    "Stood up:",
  ];
  if (result.agents.length === 0) {
    lines.push("- no agents");
  }
  for (const agent of result.agents) {
    lines.push(`- ${labelFor(agent)} (${agent.id}) on ${runtimeLabel(agent)}`);
  }
  if (result.security) {
    lines.push(
      result.security.allow
        ? `Security gate: allowed ${result.coding?.relativePath ?? "the write"}`
        : `Security gate: blocked ${result.coding?.relativePath ?? "the write"} (${result.security.reasons.join(", ")})`,
    );
  }
  if (result.coding) {
    lines.push(
      result.coding.wrote
        ? `Coding agent wrote ${result.coding.relativePath} via ${result.coding.via}`
        : `Coding agent did not write ${result.coding.relativePath}`,
    );
    if (result.coding.note) lines.push(result.coding.note);
  }
  if (result.qa) {
    lines.push(`QA agent: ${result.qa.pass ? "pass" : "fail"} (${result.qa.summary})`);
  }
  if (result.computer) {
    if (result.computerExecuteRequested) {
      lines.push("Computer execute was requested. No live browser ran. Actions stay executed: false.");
    }
    lines.push("Computer agent recorded a GTM plan. No live browser ran.");
    for (const action of result.computer.actions) {
      lines.push(`- ${action.kind} ${action.target} (executed: false)`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function labelFor(agent: StoodUpAgent): string {
  if (agent.role === "qa") return "QA agent";
  if (agent.role === "coding") return "coding agent";
  if (agent.role === "security") return "security agent";
  return "computer agent";
}

function runtimeLabel(agent: StoodUpAgent): string {
  if (agent.runtime === "grok-build") return "Grok Build";
  if (agent.runtime === "computer-use") return "the computer-use seam";
  return "the policy seam";
}

export async function runDemo(sandboxRoot: string): Promise<{ code: number; transcript: string }> {
  const good = await runChatTurn({ message: DEMO_MESSAGE, sandboxRoot });
  const blocked = await runChatTurn({ message: DEMO_BLOCKED_MESSAGE, sandboxRoot });
  const transcript = `${good.transcript}\n${blocked.transcript}`;
  const ok =
    good.agents.length === 4 &&
    good.coding?.wrote === true &&
    good.qa?.pass === true &&
    good.computer !== null &&
    good.computer.actions.every((action) => action.executed === false) &&
    blocked.security?.allow === false &&
    blocked.coding?.wrote === false;
  return { code: ok ? 0 : 1, transcript };
}
