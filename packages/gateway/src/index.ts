import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StoodUpAgent, SwarmSession } from "@opencodingpartner/mesh";
import { boardSession, type AgentRole } from "@opencodingpartner/mesh";
import { routeMessage, type ManagerPlan, type RouteDecision } from "@opencodingpartner/policy";
import { OrchestrationSwarm } from "@opencodingpartner/swarm";
import {
  acceptPlan,
  acceptedPlanText,
  approveVerb,
  decidePlanCard,
  formatApproveCards,
  loadPartnerRules,
  partnerAgreementOn,
  partnerRuleBlock,
  pendingPlanCard,
  redirectNote,
  planIsAccepted,
  returnToIntent,
  reviewHoldOn,
  rolesUnderReviewHold,
  queueComputerCard,
  writePlanChain,
  writeReviewSplit,
} from "./sdlc.js";
import { allowComputerUse, computerTabText, markComputerLive, publishLastFrame, readComputerTab } from "./computer-tab.js";
export { captureComputerFrame, computerTabText, returnComputer, takeoverComputer } from "./computer-tab.js";
export { fleetIds, isolatePartner, partnerContainerArgv, partnerWorkspace, readPartnerIdentity } from "./fleet.js";
export { startPartnerContainer, stopPartnerContainer } from "./fleet-run.js";
export { createRoutine, fireDueRoutines, fireEvent, formatRoutineList, listRoutines, pauseRoutine, resumeRoutine } from "./routines.js";
export { applySwarmManifest, parseSwarmManifest, validateSwarmManifest } from "./swarm-manifest.js";
export { channelPartnerId, discordTurn, slackTurn, telegramTurn } from "./channels.js";
import { isolatePartner as openPartnerWorkspace } from "./fleet.js";
import { noopAcpBackend, type AcpBackend } from "./acp.js";
export { acpOptIn, formatSettings, noopAcpBackend } from "./acp.js";
export { coreIsOpen, readPackaging } from "./packaging.js";
import {
  applyUnifiedDiff,
  commandDecision,
  deleteSandboxFile,
  applySandboxTodo,
  formatTodoBlock,
  mkdirSandboxDir,
  rmdirSandboxDir,
  appendSandboxFile,
  copySandboxFile,
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
Use the coding worker to create PRODUCT.md with content:
OpenCodingPartner helps a team build and sell.
`;

export const DEMO_BLOCKED_MESSAGE = `Stand up a coding agent and a security agent.
Use the coding worker to create ../secret.txt with content:
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
  codingVia?: "grok-build" | "openai-compatible" | "litellm" | "scripted";
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
  /** When set, this turn uses that partner's own workspace, not the shared session root. */
  partnerId?: string;
  /** Opt-in alternate orchestration. Off by default. A missing backend does not replace the local swarm. */
  acp?: boolean;
  acpBackend?: AcpBackend;
  /** Gateway `write` tool. Set when the product talks to OpenClaw. This process does not write the bytes. */
  openclawWrite?: (relativePath: string, content: string) => Promise<{ ok: boolean; detail: string }>;
  /** Gateway delete tool. `missing` means the plugin is absent and a local delete is allowed. */
  openclawDelete?: (relativePath: string) => Promise<{ ok: boolean; missing: boolean; detail: string }>;
  /** Gateway rename tool. `missing` means the plugin is absent and a local rename is allowed. */
  openclawRename?: (fromPath: string, toPath: string) => Promise<{ ok: boolean; missing: boolean; detail: string }>;
  /** Gateway mkdir tool. `missing` means the plugin is absent and a local mkdir is allowed. */
  openclawMkdir?: (relativePath: string) => Promise<{ ok: boolean; missing: boolean; detail: string }>;
  /** Gateway rmdir tool. `missing` means the plugin is absent and a local rmdir is allowed. */
  openclawRmdir?: (relativePath: string) => Promise<{ ok: boolean; missing: boolean; detail: string }>;
  /** Gateway copy tool. `missing` means the plugin is absent and a local copy is allowed. */
  openclawCopy?: (fromPath: string, toPath: string) => Promise<{ ok: boolean; missing: boolean; detail: string }>;
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

type CodingVia = "local-sandbox" | "grok-build" | "openai-compatible" | "litellm" | "openclaw-write" | "scripted";

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
  if (input.partnerId) {
    const workspace = await openPartnerWorkspace(input.sandboxRoot, input.partnerId);
    input = { ...input, sandboxRoot: workspace };
  }
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
    : { state: "skipped" as const, detail: "The orchestration gateway was not used. The local swarm ran this turn.", driver: "local-swarm" as const };
  if (input.acp === true) {
    const acp = await (input.acpBackend ?? noopAcpBackend()).start({ sessionKey: session.key, message: input.message });
    notice.detail = `${notice.detail} Advanced ACP: ${acp.detail}`;
  }
  const openclawDrove = notice.driver === "openclaw" && notice.state === "ran";
  const openclawFailed = notice.driver === "openclaw" && notice.state === "failed";
  if (openclawDrove) plan = { ...plan, source: "openclaw" };
  if (await partnerAgreementOn(input.sandboxRoot)) {
    const verb = approveVerb(input.message);
    const approved = verb === "approve" ? await decidePlanCard(input.sandboxRoot, "approved") : undefined;
    if (approved?.kind === "computer") await allowComputerUse(input.sandboxRoot);
    const pending = verb === "deny" || verb === "redirect" ? await pendingPlanCard(input.sandboxRoot) : undefined;
    if ((approved?.kind === "plan" && (await acceptPlan(input.sandboxRoot))) || pending) {
      if (!plan.roles.includes("coding")) {
        plan = { ...plan, roles: ["coding", "qa", "security", "computer"] };
      }
    }
  }
  if (await reviewHoldOn(input.sandboxRoot)) {
    plan = { ...plan, roles: rolesUnderReviewHold(plan.roles as AgentRole[]) };
  }
  const agents = openclawFailed ? [] : swarm.standUp(plan.roles);
  const orchestration = openclawDrove
    ? `ran: Orchestration accepted the session plan. ${notice.detail} A create-file uses the gateway write tool. The gateway still blocks fs_write, apply_patch, and sessions_spawn. General model edits still run in this process.`
    : openclawFailed
      ? `failed: The orchestration gateway was up but did not accept the session plan. ${notice.detail} The local swarm did not take over.`
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
    const partnerOn = await partnerAgreementOn(input.sandboxRoot);
    const ruleHit = partnerOn ? partnerRuleBlock(await loadPartnerRules(input.sandboxRoot), input.message) : undefined;
    const verb = approveVerb(input.message);
    if (!messageGate.allow) {
      coding = { relativePath: "the request", wrote: false, via };
    } else if (ruleHit) {
      coding = { relativePath: "the request", wrote: false, via, note: `Partner rule blocked this request (${ruleHit}).` };
    } else if (partnerOn && verb === "deny") {
      await decidePlanCard(input.sandboxRoot, "denied");
      coding = {
        relativePath: "plan",
        wrote: false,
        via,
        note: `Approve denied. No edit.\n${await formatApproveCards(input.sandboxRoot)}`,
      };
    } else if (partnerOn && verb === "redirect") {
      const note = redirectNote(input.message);
      await decidePlanCard(input.sandboxRoot, "redirected", note);
      await writePlanChain(input.sandboxRoot, note || input.message);
      coding = {
        relativePath: "plan",
        wrote: false,
        via,
        note: `Approve redirected. Plan is waiting.\n${await formatApproveCards(input.sandboxRoot)}`,
      };
    } else if (partnerOn && !(await planIsAccepted(input.sandboxRoot))) {
      await writePlanChain(input.sandboxRoot, input.message);
      coding = {
        relativePath: "plan",
        wrote: false,
        via,
        note: `Plan is waiting. Say approve, deny, or redirect.\n${await formatApproveCards(input.sandboxRoot)}\nSDLC: .ocp/sdlc/intent.md, .ocp/sdlc/spec.md, .ocp/sdlc/plan.md`,
      };
    } else if (input.grokRunner && openclawDrove && (input.openclawWrite || input.openclawDelete || input.openclawRename || input.openclawMkdir || input.openclawRmdir || input.openclawCopy)) {
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
          if (!write) continue;
          const landed = await write(relativePath, content);
          if (landed.ok && (await fileMatches(input.sandboxRoot, relativePath, content))) kept.push(relativePath);
        }
        coding = {
          relativePath: kept.length > 0 ? kept.join(", ") : "no files",
          wrote: grok.exitCode === 0 && kept.length > 0,
          via: "openclaw-write",
          note:
            kept.length > 0
              ? "Write path: orchestration. The gateway invoked the sandbox write bridge."
              : "Write path: orchestration. The write bridge did not land the file. This process did not copy it into the sandbox.",
        };
        if (blocked.length > 0) {
          coding.note = `Security agent blocked ${blocked.join(", ")} before the orchestration write.`;
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
        note: "Coding agent did not edit files. General edits need a meter key. A simple create-file message still runs on the local sandbox.",
      };
    }
  }

  if ((await partnerAgreementOn(input.sandboxRoot)) && coding?.wrote && (await planIsAccepted(input.sandboxRoot))) {
    const argv = ["node", "--test"] as const;
    const decision = commandDecision(argv);
    const result = decision.allow
      ? await (input.checkExec ?? defaultCheckExec)([...argv], input.sandboxRoot)
      : { code: 1, stdout: "", stderr: decision.reason };
    const mechanical = `QA ${qa?.pass === false ? "fail" : "pass"}. Self-verify node --test exit ${result.code}.`;
    await writeReviewSplit(input.sandboxRoot, mechanical);
    const verifyLine = `Self-verify: node --test (exit ${result.code}). Review: mechanical. Human intent and risk are not decided here.`;
    coding = { ...coding, note: [coding.note, verifyLine].filter((line) => line && line.length > 0).join("\n") };
    if (result.code !== 0 || (qa && !qa.pass)) {
      const reason = result.code !== 0 ? `node --test exit ${result.code}` : (qa?.summary ?? "QA fail");
      await returnToIntent(input.sandboxRoot, reason);
      coding = { ...coding, note: `${coding.note}\nReview hold: one coding worker. Returned to intent.` };
      if (!qa || qa.pass) qa = { pass: false, summary: reason };
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
          ? "Write path: orchestration. The gateway invoked the sandbox write bridge."
          : "Write path: orchestration. The write bridge did not land the file. This process did not write it locally.",
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
        note: "Write path: local sandbox. The orchestration gateway did not drive this write.",
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
    let execute = input.computerExecute === true;
    let gateNote = "";
    if (await partnerAgreementOn(input.sandboxRoot)) {
      const tab = await readComputerTab(input.sandboxRoot);
      if (tab.control === "human") {
        execute = false;
        gateNote = "Computer tab: human has control. The partner did not run the browser. Use the Computer tab return command to hand it back.";
      } else if (input.computerExecute === true && !tab.approved) {
        await queueComputerCard(input.sandboxRoot, input.message.replace(/\s+/g, " ").trim().slice(0, 400));
        execute = false;
        gateNote = `Computer tab: waiting for Approve before the browser starts.\n${await formatApproveCards(input.sandboxRoot)}`;
      }
    }
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
    if (execute) {
      await markComputerLive(input.sandboxRoot);
      await publishLastFrame(input.sandboxRoot);
    }
    const tabLine = await computerTabText(input.sandboxRoot);
    computer.note = [computer.note, gateNote, tabLine].filter((line) => line && line.length > 0).join("\n");
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
    lines.push(result.coding.via === "openclaw-write" ? "Write path: orchestration." : "Write path: local sandbox.");
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
          note: "Write path: orchestration. The gateway invoked the sandbox write bridge.",
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
  if (via === "litellm") return "Meter: proxy";
  if (via === "openai-compatible") return "Meter: compatible";
  if (via === "grok-build") return "Meter: worker";
  if (via === "scripted") return "Meter: scripted";
  return "Meter: none";
}

const TOOL_ROUND_CAP = 10;

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
  let deletedRemote = false;
  let renamedLocal = false;
  let renamedRemote = false;
  let copiedLocal = false;
  let appendedLocal = false;
  let copiedRemote = false;
  let madeDirLocal = false;
  let madeDirRemote = false;
  let removedDirLocal = false;
  let removedDirRemote = false;
  let todoBlock = "";
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
        const detail = capRunOutput(result.stderr || result.stdout || "no output");
        const line = `Tool: run ${(step.argv ?? []).join(" ")} (exit ${result.code}${detail.endsWith("(truncated)") ? ", truncated" : ""})`;
        log.push(line);
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
            const line = `Tool: ${step.tool} ${step.path} (orchestration write did not land)`;
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
      } else if (step.tool === "mkdir" && step.path) {
        const made = await mkdirThroughTurn(input, openclawDrove, step.path);
        const line = made.ok ? `Tool: mkdir ${step.path}` : `Tool: mkdir ${step.path} (${made.detail})`;
        log.push(line);
        observations.push(line);
        if (made.ok) {
          if (made.via === "openclaw") madeDirRemote = true;
          else madeDirLocal = true;
        }
      } else if (step.tool === "rmdir" && step.path) {
        const removed = await rmdirThroughTurn(input, openclawDrove, step.path);
        const line = removed.ok ? `Tool: rmdir ${step.path}` : `Tool: rmdir ${step.path} (${removed.detail})`;
        log.push(line);
        observations.push(line);
        if (removed.ok) {
          if (removed.via === "openclaw") removedDirRemote = true;
          else removedDirLocal = true;
        }
      } else if (step.tool === "todo") {
        const changed = await applySandboxTodo(input.sandboxRoot, step.action ?? "", step.content ?? "");
        const line = changed.ok ? `Todo: ${changed.detail}` : `Todo: ${step.action || "todo"} (${changed.detail})`;
        log.push(line);
        observations.push(line);
        todoBlock = formatTodoBlock(changed.todos);
        if (todoBlock) observations.push(todoBlock);
      } else if (step.tool === "delete" && step.path) {
        const removed = await deleteThroughTurn(input, openclawDrove, step.path);
        const line = removed.ok ? `Tool: delete ${step.path}` : `Tool: delete ${step.path} (${removed.detail})`;
        log.push(line);
        observations.push(line);
        if (removed.ok) {
          if (removed.via === "openclaw") deletedRemote = true;
          else deletedLocal = true;
          const index = kept.indexOf(step.path);
          if (index >= 0) kept.splice(index, 1);
        }
      } else if (step.tool === "rename" && step.path && step.to) {
        const moved = await renameThroughTurn(input, openclawDrove, step.path, step.to);
        const line = moved.ok ? `Tool: rename ${step.path} → ${step.to}` : `Tool: rename ${step.path} → ${step.to} (${moved.detail})`;
        log.push(line);
        observations.push(line);
        if (moved.ok) {
          if (moved.via === "openclaw") renamedRemote = true;
          else renamedLocal = true;
          const index = kept.indexOf(step.path);
          if (index >= 0) kept.splice(index, 1);
          kept.push(step.to);
        }
      } else if (step.tool === "copy" && step.path && step.to) {
        const copied = await copyThroughTurn(input, openclawDrove, step.path, step.to);
        const line = copied.ok ? `Tool: copy ${step.path} → ${step.to}` : `Tool: copy ${step.path} → ${step.to} (${copied.detail})`;
        log.push(line);
        observations.push(line);
        if (copied.ok) {
          if (copied.via === "openclaw") copiedRemote = true;
          else copiedLocal = true;
          kept.push(step.to);
        }
      } else if (step.tool === "append" && step.path) {
        if (step.content === undefined) {
          const line = `Tool: append ${step.path} (content missing)`;
          log.push(line);
          observations.push(line);
        } else {
          const added = await appendSandboxFile(input.sandboxRoot, step.path, step.content);
          const line = added.ok ? `Tool: append ${step.path}` : `Tool: append ${step.path} (${added.detail})`;
          log.push(line);
          observations.push(line);
          if (added.ok) {
            appendedLocal = true;
            if (!kept.includes(step.path)) kept.push(step.path);
          }
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
  } else if ((deletedLocal || deletedRemote) && qa && !qa.pass && fileExpectations(input.message).length === 0 && !(check && check.code !== 0)) {
    qa = { pass: true, summary: "deleted the named file" };
  }
  const note = [
    ...log,
    openclawDrove ? "Write path: orchestration. The gateway invoked the sandbox write bridge." : "Write path: local sandbox.",
    deletedRemote ? "Delete path: orchestration." : "",
    deletedLocal ? "Delete path: local sandbox." : "",
    renamedRemote ? "Rename path: orchestration." : "",
    renamedLocal ? "Rename path: local sandbox." : "",
    copiedRemote ? "Copy path: orchestration." : "",
    copiedLocal ? "Copy path: local sandbox." : "",
    appendedLocal ? "Append path: local sandbox." : "",
    madeDirRemote ? "Mkdir path: orchestration." : "",
    madeDirLocal ? "Mkdir path: local sandbox." : "",
    removedDirRemote ? "Rmdir path: orchestration." : "",
    removedDirLocal ? "Rmdir path: local sandbox." : "",
    todoBlock,
    blocked.length > 0 ? `Security agent removed ${blocked.join(", ")} after the edit.` : "",
  ].filter((line) => line.length > 0).join("\n");
  return {
    coding: { relativePath: kept.length > 0 ? kept.join(", ") : "no files", wrote: kept.length > 0, via, note },
    qa,
    security,
  };
}

const RUN_OUTPUT_CAP = 2000;

function capRunOutput(text: string): string {
  if (text.length <= RUN_OUTPUT_CAP) return text;
  return `${text.slice(0, RUN_OUTPUT_CAP)}\n(truncated)`;
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
    if (relativePath === "PARTNER.rules" || relativePath === "PARTNER.md") continue;
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
  const planText = (await planIsAccepted(sandboxRoot)) ? await acceptedPlanText(sandboxRoot) : "";
  const planNote = planText ? `Accepted plan:\n${planText}\n` : "";
  const rules = await loadPartnerRules(sandboxRoot);
  const rulesNote = rules ? `Partner rules:\n${rules}\n` : "";
  return `${history}${filesNote}${planNote}${rulesNote}User request:\n${message}\nReply with JSON only: {"steps":[{"tool":"list"|"read"|"grep"|"glob"|"run"|"write"|"patch"|"delete"|"rename"|"copy"|"append"|"mkdir"|"rmdir"|"todo","action":"add or complete","to":"relative destination","query":"text or /regex/","path":"relative","content":"full text for write, or todo text, or a 1-based todo index","diff":"unified diff for patch","argv":["node","--test","relative.test.ts"]}],"done":false}. One reply is one round. After you see Tool observations, send the next round. Set "done" to true when finished. List or read before you edit. Patch a file that already exists. Write only a new file. Append adds text to one existing file and does not create a file. Copy copies one existing file to a new relative path and leaves the source. The orchestration gateway does not append. A todo step uses action add with the task text, or action complete with a 1-based index or id. At most 12 todos. Allowed commands are node --test plus relative paths, pnpm test with no extra arguments, tsc --noEmit plus relative paths, git status, git status -sb, git status --short --branch, git diff plus relative paths, and git log --oneline -n N with N from 1 to 20, and git show HEAD: plus one relative path.`;
}

async function mkdirThroughTurn(
  input: ChatTurnInput,
  openclawDrove: boolean,
  relativePath: string,
): Promise<{ ok: boolean; via: "openclaw" | "local"; detail: string }> {
  if (openclawDrove && input.openclawMkdir) {
    const remote = await input.openclawMkdir(relativePath);
    if (remote.ok && (await dirExists(input.sandboxRoot, relativePath))) {
      return { ok: true, via: "openclaw", detail: remote.detail };
    }
    if (remote.ok || !remote.missing) {
      return { ok: false, via: "openclaw", detail: remote.ok ? "Orchestration mkdir did not create the directory." : remote.detail };
    }
  }
  const local = await mkdirSandboxDir(input.sandboxRoot, relativePath);
  return { ok: local.ok, via: "local", detail: local.detail };
}

async function rmdirThroughTurn(
  input: ChatTurnInput,
  openclawDrove: boolean,
  relativePath: string,
): Promise<{ ok: boolean; via: "openclaw" | "local"; detail: string }> {
  if (openclawDrove && input.openclawRmdir) {
    const remote = await input.openclawRmdir(relativePath);
    if (remote.ok && !(await dirExists(input.sandboxRoot, relativePath))) {
      return { ok: true, via: "openclaw", detail: remote.detail };
    }
    if (remote.ok || !remote.missing) {
      return { ok: false, via: "openclaw", detail: remote.ok ? "Orchestration rmdir did not remove the directory." : remote.detail };
    }
  }
  const local = await rmdirSandboxDir(input.sandboxRoot, relativePath);
  return { ok: local.ok, via: "local", detail: local.detail };
}

async function dirExists(sandboxRoot: string, relativePath: string): Promise<boolean> {
  try {
    const info = await stat(path.join(sandboxRoot, relativePath));
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function deleteThroughTurn(
  input: ChatTurnInput,
  openclawDrove: boolean,
  relativePath: string,
): Promise<{ ok: boolean; via: "openclaw" | "local"; detail: string }> {
  if (openclawDrove && input.openclawDelete) {
    const remote = await input.openclawDelete(relativePath);
    if (remote.ok && (await fileGone(input.sandboxRoot, relativePath))) {
      return { ok: true, via: "openclaw", detail: remote.detail };
    }
    if (remote.ok || !remote.missing) {
      return { ok: false, via: "openclaw", detail: remote.ok ? "Orchestration delete did not remove the file." : remote.detail };
    }
  }
  const local = await deleteSandboxFile(input.sandboxRoot, relativePath);
  return { ok: local.ok, via: "local", detail: local.detail };
}

async function copyThroughTurn(
  input: ChatTurnInput,
  openclawDrove: boolean,
  fromPath: string,
  toPath: string,
): Promise<{ ok: boolean; via: "openclaw" | "local"; detail: string }> {
  if (openclawDrove && input.openclawCopy) {
    const remote = await input.openclawCopy(fromPath, toPath);
    if (remote.ok && (await fileExists(input.sandboxRoot, fromPath)) && (await fileExists(input.sandboxRoot, toPath))) {
      return { ok: true, via: "openclaw", detail: remote.detail };
    }
    if (remote.ok || !remote.missing) {
      return { ok: false, via: "openclaw", detail: remote.ok ? "Orchestration copy did not copy the file." : remote.detail };
    }
  }
  const local = await copySandboxFile(input.sandboxRoot, fromPath, toPath);
  return { ok: local.ok, via: "local", detail: local.detail };
}

async function renameThroughTurn(
  input: ChatTurnInput,
  openclawDrove: boolean,
  fromPath: string,
  toPath: string,
): Promise<{ ok: boolean; via: "openclaw" | "local"; detail: string }> {
  if (openclawDrove && input.openclawRename) {
    const remote = await input.openclawRename(fromPath, toPath);
    if (remote.ok && (await fileGone(input.sandboxRoot, fromPath)) && (await fileExists(input.sandboxRoot, toPath))) {
      return { ok: true, via: "openclaw", detail: remote.detail };
    }
    if (remote.ok || !remote.missing) {
      return { ok: false, via: "openclaw", detail: remote.ok ? "Orchestration rename did not move the file." : remote.detail };
    }
  }
  const local = await renameSandboxFile(input.sandboxRoot, fromPath, toPath);
  return { ok: local.ok, via: "local", detail: local.detail };
}

async function fileGone(sandboxRoot: string, relativePath: string): Promise<boolean> {
  try {
    await readFile(path.join(sandboxRoot, relativePath));
    return false;
  } catch {
    return true;
  }
}

async function fileExists(sandboxRoot: string, relativePath: string): Promise<boolean> {
  try {
    await readFile(path.join(sandboxRoot, relativePath));
    return true;
  } catch {
    return false;
  }
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
  if (agent.runtime === "grok-build") return "coding worker";
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
