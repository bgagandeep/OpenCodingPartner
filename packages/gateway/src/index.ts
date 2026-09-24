import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StoodUpAgent, SwarmSession } from "@opencodingpartner/mesh";
import { boardSession } from "@opencodingpartner/mesh";
import { routeMessage, type ManagerPlan, type RouteDecision } from "@opencodingpartner/policy";
import { OrchestrationSwarm } from "@opencodingpartner/swarm";
import {
  applyUnifiedDiff,
  commandDecision,
  deleteSandboxFile,
  renameSandboxFile,
  globSandbox,
  grepSandbox,
  listSandboxDir,
  parseCodingReply,
  readSandboxText,
  parseCreateFileInstruction,
  executeComputerVisit,
  planGtmActions,
  type BrowserDriver,
  changedSandboxFiles,
  fileExpectations,
  pageClaim,
  qaCheckFile,
  reviewFileExpectations,
  reviewChangedFiles,
  reviewComputerClaim,
  runOnGrokBuild,
  securityGate,
  snapshotSandbox,
  writeSandboxFile,
  type GateDecision,
  type GtmPlan,
  type QaResult,
  type InjectedRunner,
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
  codingVia?: "grok-build" | "openai-compatible" | "litellm";
  /** Real Laya route. When omitted, the turn uses the fallback router and says so. */
  layaPredict?: (message: string) => Promise<RouteDecision>;
  /** Ask the computer agent to open a named URL. Without a driver, actions stay executed: false. */
  computerExecute?: boolean;
  /** Live browser. Tests inject a fake. The CLI uses Playwright when execute is on. */
  browserDriver?: BrowserDriver;
  /** Operator URL. Wins over a URL in the message. */
  computerUrl?: string;
  /** When set, only these hosts (and their subdomains) may be opened. */
  computerAllowHosts?: readonly string[];
  /** Gateway `write` tool. Set when the product talks to OpenClaw. This process does not write the bytes. */
  openclawWrite?: (relativePath: string, content: string) => Promise<{ ok: boolean; detail: string }>;
  /** Bounded check runner. Tests inject this. The default does not use a shell. */
  checkExec?: (argv: readonly string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface ChatTurnResult {
  session: SwarmSession;
  decision: RouteDecision;
  agents: StoodUpAgent[];
  security: GateDecision | null;
  coding: { relativePath: string; wrote: boolean; via: CodingVia; note?: string } | null;
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
const sessionHistory = new Map<string, string[]>();
const HISTORY_TURNS = 6;
const HISTORY_CHARS = 4000;

type CodingVia = "local-sandbox" | "grok-build" | "openai-compatible" | "litellm" | "openclaw-write";

function idempotencyKey(input: ChatTurnInput, sessionKey: string): string {
  const mode = input.codingVia ?? (input.grokRunner ? "grok-build" : "local-sandbox");
  const remote = input.openclawWrite ? "openclaw-write" : "no-openclaw-write";
  const computer = input.computerExecute === true ? "computer-live" : "computer-plan";
  return `${sessionKey}\n${path.resolve(input.sandboxRoot)}\n${mode}\n${remote}\n${computer}\n${input.message}`;
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
    "After the session plan is accepted, the gateway write tool writes a create-file into the sandbox.",
    "The gateway still blocks fs_write, apply_patch, and sessions_spawn.",
    "General model edits still run in this process.",
    "Security gates path escape and secrets.",
    "The computer agent records a GTM plan and does not run a browser.",
  ];
}

function codingVia(input: ChatTurnInput): CodingVia {
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
    ? `ran: OpenClaw accepted the session plan. ${notice.detail} A create-file uses the gateway write tool. The gateway still blocks fs_write, apply_patch, and sessions_spawn. General model edits still run in this process.`
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
    await rememberTurn(session.key, input.sandboxRoot, input.message, coding, qa, security);
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
    } else if (input.grokRunner && openclawDrove && input.openclawWrite) {
      const runner = input.grokRunner;
      const write = input.openclawWrite;
      const stage = await mkdtemp(path.join(tmpdir(), "ocp-stage-"));
      try {
        const aware = await codingPrompt(input.sandboxRoot, input.message);
        const grok = await swarm.dispatch("coding", () => runOnGrokBuild(runner, aware, stage));
        const toolReply = await applyToolReply(input, swarm, grok.stdout, true, "openclaw-write");
        if (toolReply) {
          coding = toolReply.coding;
          security = toolReply.security ?? security;
          if (agents.some((agent) => agent.role === "qa")) {
            qa = toolReply.qa;
            const retried = await retryFileFix({
              input,
              swarm,
              openclawDrove: true,
              qa,
              coding,
              security,
            });
            qa = retried.qa;
            coding = retried.coding;
            security = retried.security;
          }
        } else {
        const staged = await snapshotSandbox(stage);
        const kept: string[] = [];
        const blocked: string[] = [];
        for (const [relativePath, content] of staged) {
          const gate = securityGate({ relativePath, content, sandboxRoot: input.sandboxRoot });
          if (!gate.allow) {
            blocked.push(relativePath);
            security = { allow: false, reasons: gate.reasons };
            continue;
          }
          const landed = await write(relativePath, content);
          if (landed.ok && (await fileMatches(input.sandboxRoot, relativePath, content))) kept.push(relativePath);
        }
        coding = {
          relativePath: kept.length > 0 ? kept.join(", ") : "no files",
          wrote: grok.exitCode === 0 && kept.length > 0,
          via: "openclaw-write",
          note:
            kept.length > 0
              ? "Write path: OpenClaw-driven. The gateway invoked the sandbox write bridge."
              : "Write path: OpenClaw-driven. The write bridge did not land the file. This process did not copy it into the sandbox.",
        };
        if (blocked.length > 0) {
          coding.note = `Security agent blocked ${blocked.join(", ")} before the OpenClaw write.`;
        }
        if (agents.some((agent) => agent.role === "qa")) {
          qa = await swarm.dispatch("qa", () => reviewChangedFiles(input.sandboxRoot, kept, grok.exitCode === 0));
          qa = await addFileExpectations(qa, input.message, input.sandboxRoot, kept, blocked);
          const retried = await retryFileFix({
            input,
            swarm,
            openclawDrove: true,
            qa,
            coding,
            security,
          });
          qa = retried.qa;
          coding = retried.coding;
          security = retried.security;
        }
        }
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    } else if (input.grokRunner) {
      const runner = input.grokRunner;
      const before = await snapshotSandbox(input.sandboxRoot);
      const aware = await codingPrompt(input.sandboxRoot, input.message);
      const grok = await swarm.dispatch("coding", () => runOnGrokBuild(runner, aware, input.sandboxRoot));
      const toolReply = await applyToolReply(input, swarm, grok.stdout, false, via);
      if (toolReply) {
        coding = toolReply.coding;
        security = toolReply.security ?? security;
        if (agents.some((agent) => agent.role === "qa")) {
          qa = toolReply.qa;
          const retried = await retryFileFix({ input, swarm, openclawDrove: false, qa, coding, security });
          qa = retried.qa;
          coding = retried.coding;
          security = retried.security;
        }
      }
      const after = toolReply ? new Map<string, string>() : await snapshotSandbox(input.sandboxRoot);
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
      if (!toolReply) {
      coding = {
        relativePath: kept.length > 0 ? kept.join(", ") : "no files",
        wrote: grok.exitCode === 0 && kept.length > 0,
        via,
      };
      if (agents.some((agent) => agent.role === "qa")) {
        qa = await swarm.dispatch("qa", () => reviewChangedFiles(input.sandboxRoot, kept, grok.exitCode === 0));
        qa = await addFileExpectations(qa, input.message, input.sandboxRoot, kept, blocked);
        const retried = await retryFileFix({
          input,
          swarm,
          openclawDrove: false,
          qa,
          coding,
          security,
        });
        qa = retried.qa;
        coding = retried.coding;
        security = retried.security;
      }
      }
      if (!toolReply && blocked.length > 0 && coding && !coding.note) {
        coding.note = `Security agent removed ${blocked.join(", ")} after the edit.`;
      }
    } else {
      coding = {
        relativePath: "general edit",
        wrote: false,
        via: "local-sandbox",
        note: "Coding agent did not edit files. General edits need LITELLM_API_KEY, or OPENAI_API_KEY and OPENAI_BASE_URL, or XAI_API_KEY and Grok Build. A simple create-file message still runs on the local sandbox.",
      };
    }
  }

  if (instruction && agents.some((agent) => agent.role === "coding")) {
    if (security?.allow && openclawDrove && input.openclawWrite) {
      const write = input.openclawWrite;
      const landed = await swarm.dispatch("coding", () => write(instruction.relativePath, instruction.content));
      const onDisk = await fileMatches(input.sandboxRoot, instruction.relativePath, instruction.content);
      const wrote = landed.ok && onDisk;
      coding = {
        relativePath: instruction.relativePath,
        wrote,
        via: "openclaw-write",
        note: wrote
          ? "Write path: OpenClaw-driven. The gateway invoked the sandbox write bridge."
          : "Write path: OpenClaw-driven. The write bridge did not land the file. This process did not write it locally.",
      };
      if (agents.some((agent) => agent.role === "qa")) {
        qa = await swarm.dispatch("qa", () => qaCheckFile(input.sandboxRoot, instruction.relativePath, instruction.content));
      }
    } else if (security?.allow && input.grokRunner) {
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
      coding = {
        relativePath: instruction.relativePath,
        wrote: true,
        via: "local-sandbox",
        note: "Write path: local sandbox. The OpenClaw gateway did not drive this write.",
      };
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
    const execute = input.computerExecute === true;
    computer = await swarm.dispatch("computer", () =>
      execute || pageClaim(input.message)
        ? executeComputerVisit({
            productName: "OpenCodingPartner",
            message: input.message,
            sandboxRoot: input.sandboxRoot,
            execute,
            envUrl: input.computerUrl,
            allowHosts: input.computerAllowHosts,
            driver: input.browserDriver,
          })
        : Promise.resolve(planGtmActions("OpenCodingPartner")),
    );
    const planPath = path.join(input.sandboxRoot, "gtm", "action-plan.json");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, `${JSON.stringify(computer, null, 2)}\n`);
    if (pageClaim(input.message) && agents.some((agent) => agent.role === "qa")) {
      let claimQa = await swarm.dispatch("qa", () => reviewComputerClaim(input.sandboxRoot));
      let retries = 0;
      while (!claimQa.pass && retries < FIX_RETRY_BUDGET && execute && input.browserDriver) {
        retries += 1;
        computer = await swarm.dispatch("computer", () =>
          executeComputerVisit({
            productName: "OpenCodingPartner",
            message: input.message,
            sandboxRoot: input.sandboxRoot,
            execute: true,
            envUrl: input.computerUrl,
            allowHosts: input.computerAllowHosts,
            driver: input.browserDriver,
          }),
        );
        await writeFile(planPath, `${JSON.stringify(computer, null, 2)}\n`);
        claimQa = await swarm.dispatch("qa", () => reviewComputerClaim(input.sandboxRoot));
      }
      claimQa = finishFixLoop(claimQa, retries);
      qa = qa ? { pass: qa.pass && claimQa.pass, summary: `${qa.summary}; ${claimQa.summary}` } : claimQa;
    }
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
  await rememberTurn(session.key, input.sandboxRoot, input.message, coding, qa, security);
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
    lines.push(result.coding.via === "openclaw-write" ? "Write path: OpenClaw-driven." : "Write path: local sandbox.");
    if (result.coding.note) lines.push(result.coding.note);
    lines.push(meterLine(result.coding.via));
  }
  if (result.qa) {
    lines.push(`QA agent: ${result.qa.pass ? "pass" : "fail"} (${result.qa.summary})`);
  }
  if (result.computer) {
    const ran = result.computer.actions.some((action) => action.executed);
    if (ran) {
      lines.push(result.computer.note);
    } else if (result.computerExecuteRequested) {
      lines.push(result.computer.note);
    } else {
      lines.push("Computer agent recorded a GTM plan. No live browser ran.");
    }
    for (const action of result.computer.actions) {
      const failed = action.passed === false ? `, failed: ${action.reason ?? "step failed"}` : "";
      const skipped = action.skipped ? ", skipped" : "";
      lines.push(`- ${action.kind} ${action.target} (executed: ${action.executed}${failed}${skipped})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const FIX_RETRY_BUDGET = 2;

function finishFixLoop(qa: QaResult, retries: number): QaResult {
  if (retries === 0) return qa;
  if (qa.pass) return { ...qa, summary: `${qa.summary}; fix loop passed on retry ${retries}` };
  return { ...qa, summary: `${qa.summary}; fix budget exhausted after ${retries} retries` };
}

async function retryFileFix(args: {
  input: ChatTurnInput;
  swarm: OrchestrationSwarm;
  openclawDrove: boolean;
  qa: QaResult | null;
  coding: ChatTurnResult["coding"];
  security: GateDecision | null;
}): Promise<{ qa: QaResult | null; coding: ChatTurnResult["coding"]; security: GateDecision | null }> {
  const expected = fileExpectations(args.input.message);
  const checkFailed = args.qa?.summary.startsWith("check failed") === true;
  if (!args.qa || args.qa.pass || (expected.length === 0 && !checkFailed) || !args.input.grokRunner) return args;
  let qa = args.qa;
  let coding = args.coding;
  let security = args.security;
  let retries = 0;
  while (!qa.pass && retries < FIX_RETRY_BUDGET) {
    retries += 1;
    const prompt = `QA failed: ${qa.summary}\nApply a fix for the original request.\n${args.input.message}`;
    const pass = await applyCodingPass(args.input, args.swarm, prompt, args.openclawDrove);
    coding = pass.coding
      ? { ...pass.coding, note: [coding?.note, pass.coding.note].filter((line) => line).join("\n") }
      : pass.coding;
    security = pass.security ?? security;
    qa = pass.qa ?? qa;
  }
  return { qa: finishFixLoop(qa, retries), coding, security };
}

async function applyCodingPass(
  input: ChatTurnInput,
  swarm: OrchestrationSwarm,
  prompt: string,
  openclawDrove: boolean,
): Promise<{ coding: ChatTurnResult["coding"]; qa: QaResult | null; security: GateDecision | null }> {
  const runner = input.grokRunner;
  if (!runner) return { coding: null, qa: null, security: null };
  if (openclawDrove && input.openclawWrite) {
    const write = input.openclawWrite;
    const stage = await mkdtemp(path.join(tmpdir(), "ocp-fix-"));
    try {
      const aware = await codingPrompt(input.sandboxRoot, prompt);
      const grok = await swarm.dispatch("coding", () => runOnGrokBuild(runner, aware, stage));
      const toolReply = await applyToolReply(input, swarm, grok.stdout, true, "openclaw-write");
      if (toolReply) return toolReply;
      const staged = await snapshotSandbox(stage);
      const kept: string[] = [];
      const blocked: string[] = [];
      let security: GateDecision | null = null;
      for (const [relativePath, content] of staged) {
        const gate = securityGate({ relativePath, content, sandboxRoot: input.sandboxRoot });
        if (!gate.allow) {
          blocked.push(relativePath);
          security = { allow: false, reasons: gate.reasons };
          continue;
        }
        const landed = await write(relativePath, content);
        if (landed.ok && (await fileMatches(input.sandboxRoot, relativePath, content))) kept.push(relativePath);
      }
      let qa = await swarm.dispatch("qa", () => reviewChangedFiles(input.sandboxRoot, kept, grok.exitCode === 0));
      qa = (await addFileExpectations(qa, input.message, input.sandboxRoot, kept, blocked)) ?? qa;
      return {
        coding: {
          relativePath: kept.length > 0 ? kept.join(", ") : "no files",
          wrote: grok.exitCode === 0 && kept.length > 0,
          via: "openclaw-write",
          note: "Write path: OpenClaw-driven. The gateway invoked the sandbox write bridge.",
        },
        qa,
        security,
      };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  const before = await snapshotSandbox(input.sandboxRoot);
  const aware = await codingPrompt(input.sandboxRoot, prompt);
  const grok = await swarm.dispatch("coding", () => runOnGrokBuild(runner, aware, input.sandboxRoot));
  const toolReply = await applyToolReply(input, swarm, grok.stdout, openclawDrove, openclawDrove ? "openclaw-write" : codingVia(input));
  if (toolReply) return toolReply;
  const after = await snapshotSandbox(input.sandboxRoot);
  const changed = changedSandboxFiles(before, after);
  const kept: string[] = [];
  const blocked: string[] = [];
  let security: GateDecision | null = null;
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
  for (const item of fileExpectations(input.message)) {
    if (kept.includes(item.path) || blocked.includes(item.path)) continue;
    if (after.has(item.path)) kept.push(item.path);
  }
  let qa = await swarm.dispatch("qa", () => reviewChangedFiles(input.sandboxRoot, kept, grok.exitCode === 0));
  qa = (await addFileExpectations(qa, input.message, input.sandboxRoot, kept, blocked)) ?? qa;
  return {
    coding: {
      relativePath: kept.length > 0 ? kept.join(", ") : "no files",
      wrote: grok.exitCode === 0 && kept.length > 0,
      via: codingVia(input),
      note: blocked.length > 0 ? `Security agent removed ${blocked.join(", ")} after the edit.` : undefined,
    },
    qa,
    security,
  };
}

async function addFileExpectations(
  qa: QaResult | null,
  message: string,
  sandboxRoot: string,
  kept: readonly string[],
  removed: readonly string[],
): Promise<QaResult | null> {
  const expected = fileExpectations(message);
  if (expected.length === 0) return qa;
  const extra = await reviewFileExpectations(sandboxRoot, kept, expected, removed);
  if (!qa) return extra;
  return { pass: qa.pass && extra.pass, summary: extra.pass ? qa.summary : `${qa.summary}; ${extra.summary}` };
}

function meterLine(via: CodingVia): string {
  if (via === "litellm") return "Meter: LiteLLM";
  if (via === "openai-compatible") return "Meter: OpenAI-compatible";
  if (via === "grok-build") return "Meter: Grok Build";
  return "Meter: none";
}

const TOOL_ROUND_CAP = 5;

async function applyToolReply(
  input: ChatTurnInput,
  swarm: OrchestrationSwarm,
  stdout: string,
  openclawDrove: boolean,
  via: CodingVia,
): Promise<{ coding: ChatTurnResult["coding"]; qa: QaResult | null; security: GateDecision | null } | null> {
  const runner = input.grokRunner;
  if (!runner) return null;
  const log: string[] = [];
  const observations: string[] = [];
  const kept: string[] = [];
  const blocked: string[] = [];
  let security: GateDecision | null = null;
  let check: { code: number; stdout: string; stderr: string } | null = null;
  let deletedLocal = false;
  let renamedLocal = false;
  let nextStdout = stdout;
  for (let round = 1; round <= TOOL_ROUND_CAP; round += 1) {
    const reply = parseCodingReply(nextStdout);
    if (!reply) {
      if (round === 1) return null;
      log.push(`Round ${round}: no more steps`);
      break;
    }
    log.push(`Round ${round}`);
    for (const step of reply.steps) {
      if (step.tool === "list") {
        const listed = await listSandboxDir(input.sandboxRoot, step.path ?? ".");
        const line = `Tool: list ${step.path || "."} (${listed.detail})`;
        log.push(line);
        observations.push(line);
      } else if (step.tool === "grep") {
        const found = await grepSandbox(input.sandboxRoot, step.query ?? step.content ?? "", step.path ?? ".");
        const hits = found.ok && found.detail !== "(no matches)" ? found.detail.split("\n").length : 0;
        const line = `Tool: grep ${step.query ?? step.content ?? ""} (${found.ok ? `${hits} hits` : found.detail})`;
        log.push(line);
        observations.push(found.ok ? `${line}\n${found.detail}` : line);
      } else if (step.tool === "glob") {
        const found = await globSandbox(input.sandboxRoot, step.query ?? step.content ?? "");
        const hits = found.ok && found.detail !== "(no matches)" ? found.detail.split("\n").length : 0;
        const line = `Tool: glob ${step.query ?? step.content ?? ""} (${found.ok ? `${hits} hits` : found.detail})`;
        log.push(line);
        observations.push(found.ok ? `${line}\n${found.detail}` : line);
      } else if (step.tool === "read" && step.path) {
        const read = await readSandboxText(input.sandboxRoot, step.path);
        const line = `Tool: read ${step.path} (${read.ok ? "ok" : read.detail})`;
        log.push(line);
        observations.push(read.ok ? `${line}\n${read.detail.slice(0, 4000)}` : line);
      } else if (step.tool === "run") {
        const decision = commandDecision(step.argv ?? []);
        if (!decision.allow) {
          const line = `Tool: run refused (${decision.reason})`;
          log.push(line);
          observations.push(line);
          check = { code: 1, stdout: "", stderr: decision.reason };
          continue;
        }
        const result = await (input.checkExec ?? defaultCheckExec)(step.argv ?? [], input.sandboxRoot);
        check = result;
        const line = `Tool: run ${(step.argv ?? []).join(" ")} (exit ${result.code})`;
        log.push(line);
        const detail = (result.stderr || result.stdout || "no output").slice(0, 500);
        observations.push(`${line}\n${detail}`);
      } else if ((step.tool === "write" || step.tool === "patch") && step.path) {
        let content = step.content ?? "";
        if (step.tool === "patch") {
          const current = await readSandboxText(input.sandboxRoot, step.path);
          const next = current.ok ? applyUnifiedDiff(current.detail, step.diff ?? "") : null;
          if (!current.ok || next === null) {
            const line = `Tool: patch ${step.path} (did not apply)`;
            log.push(line);
            observations.push(line);
            continue;
          }
          content = next;
        }
        const gate = securityGate({ relativePath: step.path, content, sandboxRoot: input.sandboxRoot });
        if (!gate.allow) {
          blocked.push(step.path);
          security = { allow: false, reasons: gate.reasons };
          const line = `Tool: ${step.tool} ${step.path} (blocked)`;
          log.push(line);
          observations.push(line);
          continue;
        }
        if (openclawDrove && input.openclawWrite) {
          const landed = await input.openclawWrite(step.path, content);
          const onDisk = landed.ok && (await fileMatches(input.sandboxRoot, step.path, content));
          if (!onDisk) {
            const line = `Tool: ${step.tool} ${step.path} (OpenClaw write did not land)`;
            log.push(line);
            observations.push(line);
            continue;
          }
        } else {
          await writeSandboxFile(input.sandboxRoot, step.path, content);
        }
        kept.push(step.path);
        const line = `Tool: ${step.tool} ${step.path}`;
        log.push(line);
        observations.push(line);
      } else if (step.tool === "delete" && step.path) {
        const removed = await deleteSandboxFile(input.sandboxRoot, step.path);
        const line = removed.ok ? `Tool: delete ${step.path}` : `Tool: delete ${step.path} (${removed.detail})`;
        log.push(line);
        observations.push(line);
        if (removed.ok) {
          deletedLocal = true;
          const index = kept.indexOf(step.path);
          if (index >= 0) kept.splice(index, 1);
        }
      } else if (step.tool === "rename" && step.path && step.to) {
        const moved = await renameSandboxFile(input.sandboxRoot, step.path, step.to);
        const line = moved.ok ? `Tool: rename ${step.path} → ${step.to}` : `Tool: rename ${step.path} → ${step.to} (${moved.detail})`;
        log.push(line);
        observations.push(line);
        if (moved.ok) {
          renamedLocal = true;
          const index = kept.indexOf(step.path);
          if (index >= 0) kept.splice(index, 1);
          kept.push(step.to);
        }
      }
    }
    if (reply.done || reply.steps.length === 0) break;
    if (check && check.code === 0) break;
    if (round === TOOL_ROUND_CAP) break;
    const follow = `Tool observations:\n${observations.join("\n")}\nContinue the same request. Reply with JSON steps, or {"done":true} when finished.\n${input.message}`;
    const aware = await codingPrompt(input.sandboxRoot, follow);
    const next = await swarm.dispatch("coding", () => runOnGrokBuild(runner, aware, input.sandboxRoot));
    nextStdout = next.stdout;
  }
  let qa = await reviewChangedFiles(input.sandboxRoot, kept, kept.length > 0 || check?.code === 0);
  qa = (await addFileExpectations(qa, input.message, input.sandboxRoot, kept, blocked)) ?? qa;
  if (check && check.code !== 0) {
    const detail = (check.stderr || check.stdout || "no output").slice(0, 500);
    qa = { pass: false, summary: `check failed (exit ${check.code}): ${detail}` };
  } else if (check && check.code === 0 && qa && !qa.pass && fileExpectations(input.message).length === 0) {
    qa = { pass: true, summary: "check passed" };
  } else if (deletedLocal && qa && !qa.pass && fileExpectations(input.message).length === 0 && !(check && check.code !== 0)) {
    qa = { pass: true, summary: "deleted the named file" };
  }
  const note = [
    ...log,
    openclawDrove ? "Write path: OpenClaw-driven. The gateway invoked the sandbox write bridge." : "Write path: local sandbox.",
    deletedLocal ? "Delete path: local sandbox. OpenClaw does not delete files." : "",
    renamedLocal ? "Rename path: local sandbox. OpenClaw does not rename files." : "",
    blocked.length > 0 ? `Security agent removed ${blocked.join(", ")} after the edit.` : "",
  ].filter((line) => line.length > 0).join("\n");
  return {
    coding: { relativePath: kept.length > 0 ? kept.join(", ") : "no files", wrote: kept.length > 0, via, note },
    qa,
    security,
  };
}

function defaultCheckExec(argv: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0] ?? "node", argv.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
    }, 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function historyKey(sessionKey: string, sandboxRoot: string): string {
  return `${sessionKey}\n${path.resolve(sandboxRoot)}`;
}

export function clearSessionMemory(): void {
  sessionHistory.clear();
}

async function priorTurns(sandboxRoot: string): Promise<string> {
  const key = historyKey(boardSession().key, sandboxRoot);
  if (!sessionHistory.has(key)) sessionHistory.set(key, await readHistory(sandboxRoot));
  const lines = sessionHistory.get(key) ?? [];
  if (lines.length === 0) return "";
  return `Prior turns:\n${lines.join("\n")}\n`;
}

async function readHistory(sandboxRoot: string): Promise<string[]> {
  try {
    const raw = await readFile(historyFile(sandboxRoot), "utf8");
    const parsed = JSON.parse(raw) as { turns?: unknown };
    if (!Array.isArray(parsed.turns)) return [];
    return parsed.turns
      .filter((line): line is string => typeof line === "string" && !line.includes("\0"))
      .filter((line) => securityGate({ relativePath: "turn.txt", content: line, sandboxRoot }).allow)
      .slice(-HISTORY_TURNS);
  } catch {
    return [];
  }
}

async function writeHistory(sandboxRoot: string, turns: readonly string[]): Promise<void> {
  const root = path.resolve(sandboxRoot);
  const target = historyFile(root);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!target.startsWith(rootPrefix)) return;
  const safe = turns.filter((line) => securityGate({ relativePath: "turn.txt", content: line, sandboxRoot: root }).allow);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ turns: safe }, null, 2)}\n`);
}

function historyFile(sandboxRoot: string): string {
  return path.join(path.resolve(sandboxRoot), ".ocp", "prior-turns.json");
}

async function rememberTurn(
  sessionKey: string,
  sandboxRoot: string,
  message: string,
  coding: ChatTurnResult["coding"],
  qa: QaResult | null,
  security: GateDecision | null,
): Promise<void> {
  const gate = securityGate({ relativePath: "turn.txt", content: message, sandboxRoot });
  const user = gate.allow ? message.replace(/\s+/g, " ").trim().slice(0, 400) : "[blocked]";
  const wrote = coding?.wrote && coding.relativePath !== "no files" ? `Wrote ${coding.relativePath}.` : "No file written.";
  const qaLine = qa ? (qa.pass ? "QA pass." : "QA fail.") : "QA not run.";
  const blocked = security && !security.allow ? " Security blocked a write." : "";
  const line = `User: ${user} Outcome: ${wrote} ${qaLine}${blocked}`;
  const key = historyKey(sessionKey, sandboxRoot);
  if (!sessionHistory.has(key)) sessionHistory.set(key, await readHistory(sandboxRoot));
  const next = [...(sessionHistory.get(key) ?? []), line].slice(-HISTORY_TURNS);
  while (next.join("\n").length > HISTORY_CHARS && next.length > 1) next.shift();
  sessionHistory.set(key, next);
  await writeHistory(sandboxRoot, next);
}

/** Put existing sandbox files and prior turns in the meter prompt. Secret files stay out. */
async function codingPrompt(sandboxRoot: string, message: string): Promise<string> {
  const files = await snapshotSandbox(sandboxRoot);
  const blocks: string[] = [];
  let used = 0;
  for (const relativePath of [...files.keys()].sort()) {
    if (relativePath.startsWith("gtm/") || relativePath.startsWith(`gtm${path.sep}`)) continue;
    if (relativePath === ".ocp" || relativePath.startsWith(`.ocp${path.sep}`)) continue;
    const content = files.get(relativePath) ?? "";
    if (content.includes("\0")) continue;
    const gate = securityGate({ relativePath, content, sandboxRoot });
    if (!gate.allow) continue;
    const block = `File ${relativePath}:\n${content}`;
    if (used + block.length > 12000) break;
    blocks.push(block);
    used += block.length;
  }
  const filesNote = message.startsWith("Tool observations:") || blocks.length === 0 ? "" : `Sandbox files already on disk:\n${blocks.join("\n")}\n`;
  const history = await priorTurns(sandboxRoot);
  return `${history}${filesNote}User request:\n${message}\nReply with JSON only: {"steps":[{"tool":"list"|"read"|"grep"|"glob"|"run"|"write"|"patch"|"delete"|"rename","to":"relative destination","query":"text or /regex/","path":"relative","content":"full text for write","diff":"unified diff for patch","argv":["node","--test","relative.test.ts"]}],"done":false}. One reply is one round. After you see Tool observations, send the next round. Set "done" to true when finished. List or read before you edit. Patch a file that already exists. Write only a new file. Allowed commands are node --test plus relative paths, pnpm test with no extra arguments, and tsc --noEmit plus relative paths.`;
}

async function fileMatches(sandboxRoot: string, relativePath: string, content: string): Promise<boolean> {
  try {
    return (await readFile(path.join(sandboxRoot, relativePath), "utf8")) === content;
  } catch {
    return false;
  }
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
