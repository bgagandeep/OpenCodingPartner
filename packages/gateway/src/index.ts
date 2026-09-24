import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoodUpAgent, SwarmSession } from "@opencodingpartner/mesh";
import { boardSession } from "@opencodingpartner/mesh";
import { routeMessage, type RouteDecision } from "@opencodingpartner/policy";
import { OrchestrationSwarm } from "@opencodingpartner/swarm";
import {
  parseCreateFileInstruction,
  planGtmActions,
  qaCheckFile,
  securityGate,
  writeSandboxFile,
  type GateDecision,
  type GtmPlan,
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
}

export interface ChatTurnResult {
  session: SwarmSession;
  decision: RouteDecision;
  agents: StoodUpAgent[];
  security: GateDecision | null;
  coding: { relativePath: string; wrote: boolean } | null;
  qa: QaResult | null;
  computer: GtmPlan | null;
  replayed: boolean;
  transcript: string;
}

const lanes = new Map<string, Promise<void>>();
const completed = new Map<string, ChatTurnResult>();

function idempotencyKey(sessionKey: string, sandboxRoot: string, message: string): string {
  return `${sessionKey}\n${path.resolve(sandboxRoot)}\n${message}`;
}

export function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const session = boardSession();
  const key = idempotencyKey(session.key, input.sandboxRoot, input.message);
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

async function executeTurn(input: ChatTurnInput, session: SwarmSession, key: string): Promise<ChatTurnResult> {
  const decision = routeMessage(input.message);
  const swarm = new OrchestrationSwarm(session);
  const agents = swarm.standUp(decision.roles);
  const instruction = parseCreateFileInstruction(input.message);
  let security: GateDecision | null = null;
  let coding: ChatTurnResult["coding"] = null;
  let qa: QaResult | null = null;
  let computer: GtmPlan | null = null;

  if (instruction && agents.some((agent) => agent.role === "security")) {
    security = swarm.dispatch("security", () =>
      securityGate({
        relativePath: instruction.relativePath,
        content: instruction.content,
        sandboxRoot: input.sandboxRoot,
      }),
    );
  }

  if (instruction && agents.some((agent) => agent.role === "coding")) {
    if (security?.allow) {
      await swarm.dispatch("coding", async () => {
        await writeSandboxFile(input.sandboxRoot, instruction.relativePath, instruction.content);
      });
      coding = { relativePath: instruction.relativePath, wrote: true };
      if (agents.some((agent) => agent.role === "qa")) {
        qa = await swarm.dispatch("qa", () =>
          qaCheckFile(input.sandboxRoot, instruction.relativePath, instruction.content),
        );
      }
    } else {
      coding = { relativePath: instruction.relativePath, wrote: false };
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
    security,
    coding,
    qa,
    computer,
    replayed: false,
    transcript: formatTranscript({
      session,
      decision,
      agents,
      security,
      coding,
      qa,
      computer,
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
        ? `Coding agent wrote ${result.coding.relativePath}`
        : `Coding agent did not write ${result.coding.relativePath}`,
    );
  }
  if (result.qa) {
    lines.push(`QA agent: ${result.qa.pass ? "pass" : "fail"} (${result.qa.summary})`);
  }
  if (result.computer) {
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
