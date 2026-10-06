#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { codingRunnerForEnv, appendViaOpenClaw, copyViaOpenClaw, deleteViaOpenClaw, discoverStack, dockerLine, mkdirViaOpenClaw, predictWithLaya, renameViaOpenClaw, rmdirViaOpenClaw, runConnectedPath, runDoctor, sendOrchestrationTurn, startSandboxWriteBridge, todoViaOpenClaw, writeViaOpenClaw } from "@opencodingpartner/bundle";
import { access, copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { acpOptIn, applySwarmManifest, doctorSwarmLine, approveDoctorLine, captureComputerFrame, checkComputerFrame, checkComputerFrames, computerTabText, doctorComputerControlLine, doctorComputerFrameLine, doctorComputerRunLine, doctorComputerStatusLine, allowedCheckArgv, doctorLastCheckLine, doctorLastQaLine, runAllowedCheck, doctorLastWriteLine, doctorRoutineLine, doctorSharedMountLine, createRoutine, fireDueRoutines, fireEvent, formatApproveQueue, formatApproveQueueJson, formatReviewHolds, formatRoutineList, formatTodoQueue, formatTodoQueueJson, formatSettings, fleetDoctorLine, formatFleetStatus, formatFleetStatusJson, isolatePartner, listApproveQueue, listReviewHolds, listRoutines, listTodoQueue, partnerAgreementDoctorLine, partnerAgreementStatus, parseSwarmManifest, pauseRoutine, postSlackReply, postTelegramReply, readFleetStatus, readPackaging, resumeRoutine, returnComputer, reviewHoldDoctorLine, doctorPlanLine, runChatTurn, todoDoctorLine, runDemo, slackCredentialStatus, slackTurn, startPartnerContainer, stopPartnerContainer, takeoverComputer, telegramCredentialStatus, telegramTurn, deliverSlackEvent, deliverTelegramUpdate, validateSwarmManifest, type ChatTurnInput } from "@opencodingpartner/gateway";
import { appendSandboxFile, applySandboxTodo, applyUnifiedDiff, commandDecision, copySandboxFile, deleteSandboxFile, globSandbox, grepSandbox, listSandboxDir, mkdirSandboxDir, playwrightBrowserDriver, readSandboxText, renameSandboxFile, rmdirSandboxDir, securityGate, writeSandboxFile } from "@opencodingpartner/workers";
import { routeWithPredict } from "@opencodingpartner/policy";
import { proveCoding, proveComputer } from "./prove.js";
import { runChatRepl } from "./repl.js";

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function redactGrepLine(line: string): string {
  const gate = securityGate({ relativePath: "hit.txt", content: line, sandboxRoot: "." });
  return gate.reasons.includes("secret pattern") ? "[redacted]" : line;
}

function refusedSandboxRead(relativePath: string): boolean {
  const text = relativePath.replace(/\\/g, "/").trim();
  if (!text || text.startsWith("/") || text.includes("..") || text.includes("\0")) return true;
  return text.split("/").some((part) => part === "" || part === ".ocp" || part === "gtm");
}

function refusedSandboxList(relativePath: string): boolean {
  if (relativePath === "" || relativePath === ".") return false;
  return refusedSandboxRead(relativePath);
}

function splitKeptLines(text: string): { lines: string[]; trailing: boolean } {
  if (text.length === 0) return { lines: [], trailing: false };
  const trailing = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailing) lines.pop();
  return { lines, trailing };
}

function joinKeptLines(lines: string[], trailing: boolean): string {
  if (lines.length === 0) return "";
  return trailing ? `${lines.join("\n")}\n` : lines.join("\n");
}

function unnestLine(line: string): string {
  if (line.trim().length === 0) return line;
  if (line.startsWith("\t")) return line.slice(1);
  if (line.startsWith("  ")) return line.slice(2);
  if (line.startsWith(" ")) return line.slice(1);
  return line;
}

function runGitArgv(cwd: string, argv: readonly string[]): Promise<{ code: number; output: string; missing: boolean }> {
  if (!commandDecision([...argv]).allow) return Promise.resolve({ code: 2, output: "", missing: true });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { code: number; output: string; missing: boolean }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("NODE_TEST") || key.startsWith("NODE_CHANNEL")) delete env[key];
    }
    const child = spawn(argv[0] ?? "git", argv.slice(1), { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish({ code: 127, output: "", missing: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code: code ?? 1, output, missing: false });
    });
  });
}

function redactListName(name: string): string {
  const gate = securityGate({ relativePath: "name.txt", content: name, sandboxRoot: "." });
  return gate.reasons.includes("secret pattern") ? "[redacted]" : name;
}

function takeFlag(argv: readonly string[], name: string): { value: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) {
      value = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg !== undefined) rest.push(arg);
  }
  return { value, rest };
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...tail] = argv;
  if (command === "demo") {
    const live = tail.includes("--live");
    const { value } = takeFlag(
      tail.filter((arg) => arg !== "--live"),
      "--sandbox",
    );
    if (live) {
      const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
      let stack: { openclawBin?: string; grokBin?: string; layaPython?: string } | undefined;
      try {
        stack = JSON.parse(await readFile(path.join(repoRoot, ".bundle/stack.json"), "utf8")) as {
          openclawBin?: string;
          grokBin?: string;
          layaPython?: string;
        };
      } catch {
        stack = undefined;
      }
      const bins = await discoverStack({ env: process.env, repoRoot, stack });
      const report = await runConnectedPath({ env: process.env, bins, cwd: path.resolve(value ?? ".sandbox") });
      process.stdout.write(report.transcript);
      return report.code;
    }
    const sandbox = value ?? ".sandbox";
    const demo = await runDemo(sandbox);
    process.stdout.write(demo.transcript);
    return demo.code;
  }
  if (command === "prove" && tail[0] === "coding") {
    const proof = await proveCoding();
    process.stdout.write(proof.text);
    return proof.code;
  }
  if (command === "prove" && tail[0] === "computer") {
    const proof = await proveComputer();
    process.stdout.write(proof.text);
    return proof.code;
  }
  if (command === "computer") {
    const { value, rest } = takeFlag(tail, "--sandbox");
    const sandbox = value ?? ".sandbox";
    const partnerFlag = takeFlag(rest, "--partner");
    const target = partnerFlag.value ? await isolatePartner(sandbox, partnerFlag.value) : sandbox;
    const action = partnerFlag.rest[0];
    if (action === "takeover") await takeoverComputer(target);
    else if (action === "return") await returnComputer(target);
    else if (action === "capture") {
      const shot = await captureComputerFrame(target);
      process.stdout.write(`${shot.text}\n`);
      if (!shot.ok) return 1;
    } else if (action === "qa") {
      const check = partnerFlag.value ? await checkComputerFrame(target) : await checkComputerFrames(sandbox);
      process.stdout.write(`${check.summary}\n`);
      process.stdout.write(`${await computerTabText(target)}\n`);
      return check.pass ? 0 : 1;
    } else if (action) {
      process.stdout.write("Usage: ocp computer [--sandbox .sandbox] [--partner name] [takeover|return|capture|qa]\n");
      return 2;
    }
    process.stdout.write(`${await computerTabText(target)}\n`);
    return 0;
  }
  if (command === "swarm") {
    const dryRun = tail.includes("--dry-run");
    const args = tail.filter((arg) => arg !== "--dry-run");
    const sub = args[0];
    const sand = takeFlag(args.slice(1), "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const fileFlag = takeFlag(sand.rest, "--file");
    if (!fileFlag.value || (sub !== "validate" && sub !== "apply")) {
      process.stdout.write("Usage: ocp swarm validate|apply --file docs/examples/swarm.json [--sandbox .sandbox] [--dry-run]\n");
      return 2;
    }
    let manifest;
    try {
      manifest = parseSwarmManifest(await readFile(fileFlag.value, "utf8"));
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "swarm manifest failed"}\n`);
      return 1;
    }
    if (sub === "validate") {
      const errors = validateSwarmManifest(manifest);
      process.stdout.write(errors.length === 0 ? `Swarm ${manifest.system} ok\n` : `${errors.join("\n")}\n`);
      return errors.length === 0 ? 0 : 1;
    }
    const result = await applySwarmManifest(sandbox, manifest, { dryRun });
    process.stdout.write(`${result.text}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === "fleet") {
    const json = tail.includes("--json");
    const dryRun = tail.includes("--dry-run");
    const args = tail.filter((arg) => arg !== "--dry-run" && arg !== "--json");
    const sub = args[0];
    const sand = takeFlag(args.slice(1), "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    if (sub === "status") {
      const rows = await readFleetStatus(sandbox);
      process.stdout.write(json ? formatFleetStatusJson(rows) : formatFleetStatus(rows));
      return 0;
    }
    const partner = takeFlag(sand.rest, "--partner");
    if (!partner.value || (sub !== "start" && sub !== "stop")) {
      process.stdout.write("Usage: ocp fleet status [--sandbox .sandbox] [--json]\n       ocp fleet start|stop --partner name [--sandbox .sandbox] [--dry-run]\n");
      return 2;
    }
    const result = sub === "start"
      ? await startPartnerContainer(sandbox, partner.value, { dryRun })
      : await stopPartnerContainer(sandbox, partner.value);
    process.stdout.write(`${result.text}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === "routine") {
    const sub = tail[0];
    const sand = takeFlag(tail.slice(1), "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const every = takeFlag(partner.rest, "--every");
    const event = takeFlag(every.rest, "--event");
    const messageFlag = takeFlag(event.rest, "--message");
    const id = messageFlag.rest[0];
    const runOne = async (routine: { message: string; partnerId: string }) => {
      const result = await runProductTurn(routine.message, sandbox, false, routine.partnerId);
      return result.transcript;
    };
    if (sub === "add") {
      const routine = await createRoutine(sandbox, {
        partnerId: partner.value ?? "coding",
        message: messageFlag.value ?? "",
        everyMs: every.value ? Number(every.value) : undefined,
        event: event.value,
        now: Date.now(),
      });
      process.stdout.write(`${routine.id} ${routine.status}\n`);
      return 0;
    }
    if (sub === "list") {
      process.stdout.write(`${formatRoutineList(await listRoutines(sandbox))}\n`);
      return 0;
    }
    if (sub === "pause" && id) {
      const routine = await pauseRoutine(sandbox, id);
      process.stdout.write(`${routine.id} paused\n`);
      return 0;
    }
    if (sub === "resume" && id) {
      const routine = await resumeRoutine(sandbox, id);
      process.stdout.write(`${routine.id} active\n`);
      return 0;
    }
    if (sub === "run") {
      const replies = await fireDueRoutines(sandbox, Date.now(), runOne);
      process.stdout.write(replies.join("\n") || "Routines: none due\n");
      return 0;
    }
    if (sub === "event" && id) {
      const replies = await fireEvent(sandbox, id, runOne);
      process.stdout.write(replies.join("\n") || "Routines: none for that event\n");
      return 0;
    }
    process.stdout.write("Usage: ocp routine add|list|pause|resume|run|event\n");
    return 2;
  }
  if (command === "channel") {
    const kind = tail[0];
    if ((kind === "slack" || kind === "telegram") && tail[1] === "receive") {
      return receiveChannel(kind, tail.slice(2));
    }
    const sand = takeFlag(tail.slice(1), "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const text = takeFlag(sand.rest, "--text");
    const channel = takeFlag(text.rest, "--channel");
    if ((kind !== "slack" && kind !== "telegram") || !text.value || !channel.value) {
      process.stdout.write("Usage: ocp channel slack|telegram --sandbox .sandbox --text \"...\" --channel name\n       ocp channel slack receive --sandbox .sandbox --body event.json --timestamp SECONDS --signature v0=...\n       ocp channel telegram receive --sandbox .sandbox --body update.json --secret-header VALUE\n");
      return 2;
    }
    const adapt = kind === "slack" ? slackTurn : telegramTurn;
    const result = await adapt({ text: text.value, channel: channel.value }, async (message, partnerId) => {
      const turn = await runProductTurn(message, sandbox, false, partnerId);
      return turn.transcript;
    });
    if (kind === "slack") {
      const creds = slackCredentialStatus(process.env);
      if (!creds.ready) {
        process.stdout.write(`Slack live: missing ${creds.missing.join(", ")}. The offline turn still ran.\n`);
      } else {
        const posted = await postSlackReply(process.env.SLACK_BOT_TOKEN ?? "", channel.value, result.reply, "");
        if (!posted.ok) process.stdout.write(`${posted.detail}\n`);
      }
    }
    if (kind === "telegram") {
      const creds = telegramCredentialStatus(process.env);
      if (!creds.ready) {
        process.stdout.write(`Telegram live: missing ${creds.missing.join(", ")}. The offline turn still ran.\n`);
      } else {
        const posted = await postTelegramReply(process.env.TELEGRAM_BOT_TOKEN ?? "", channel.value, result.reply, "");
        if (!posted.ok) process.stdout.write(`${posted.detail}\n`);
      }
    }
    process.stdout.write(result.reply);
    return 0;
  }
  if (command === "settings") {
    const { value } = takeFlag(tail, "--sandbox");
    const sandbox = value ?? ".sandbox";
    const on = await acpOptIn(sandbox, process.env);
    process.stdout.write(formatSettings(on, await readPackaging(sandbox)));
    return 0;
  }
  if (command === "approve") {
    const json = tail.includes("--json");
    const args = tail.filter((arg) => arg !== "--json");
    const sub = args[0];
    const sand = takeFlag(args.slice(1), "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const note = takeFlag(partner.rest, "--note");
    if (sub === "accept" || sub === "deny" || sub === "redirect") {
      if (sub === "redirect" && !note.value?.trim()) {
        process.stdout.write("Usage: ocp approve redirect --note \"text\" [--sandbox .sandbox] [--partner name]\n");
        return 2;
      }
      const message = sub === "accept" ? "approve" : sub === "deny" ? "deny" : `redirect: ${note.value?.trim()}`;
      const result = await runProductTurn(message, sandbox, false, partner.value);
      process.stdout.write(result.transcript);
      return 0;
    }
    if (sub !== "list") {
      process.stdout.write("Usage: ocp approve list [--sandbox .sandbox] [--json]\n       ocp approve accept|deny [--sandbox .sandbox] [--partner name]\n       ocp approve redirect --note \"text\" [--sandbox .sandbox] [--partner name]\n");
      return 2;
    }
    const items = await listApproveQueue(sandbox);
    const holds = await listReviewHolds(sandbox);
    if (json) {
      process.stdout.write(formatApproveQueueJson(items));
      return 0;
    }
    process.stdout.write(`${formatApproveQueue(items)}${formatReviewHolds(holds)}`);
    return 0;
  }
  if (command === "todo") {
    const json = tail.includes("--json");
    const args = tail.filter((arg) => arg !== "--json");
    const sub = args[0];
    const sand = takeFlag(args.slice(1), "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    if (sub === "add" || sub === "complete") {
      const partner = takeFlag(sand.rest, "--partner");
      const textFlag = takeFlag(partner.rest, "--text");
      const text = (textFlag.value ?? textFlag.rest.join(" ")).trim();
      if (!text) {
        process.stdout.write("Usage: ocp todo add|complete --text \"...\" [--sandbox .sandbox] [--partner name]\n");
        return 2;
      }
      let root = sandbox;
      try {
        if (partner.value) root = await isolatePartner(sandbox, partner.value);
      } catch (error) {
        process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
        return 1;
      }
      const changed = await applySandboxTodo(root, sub, text);
      process.stdout.write(`${changed.detail}\n`);
      if (!changed.ok) return 1;
      const items = await listTodoQueue(sandbox);
      process.stdout.write(json ? formatTodoQueueJson(items) : formatTodoQueue(items));
      return 0;
    }
    if (sub !== "list") {
      process.stdout.write("Usage: ocp todo list [--sandbox .sandbox] [--json]\n       ocp todo add|complete --text \"...\" [--sandbox .sandbox] [--partner name]\n");
      return 2;
    }
    const items = await listTodoQueue(sandbox);
    process.stdout.write(json ? formatTodoQueueJson(items) : formatTodoQueue(items));
    return 0;
  }
  if (command === "check") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const name = partner.rest[0] ?? "node";
    if (partner.rest.length > 1 || !allowedCheckArgv(name)) {
      process.stdout.write("Usage: ocp check [--sandbox .sandbox] [--partner name] [node|pnpm|tsc]\n");
      return 2;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    await mkdir(root, { recursive: true });
    const result = await runAllowedCheck(root, name);
    process.stdout.write(`${result.detail}\n`);
    return result.code;
  }
  if (command === "read") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const pathFlag = takeFlag(partner.rest, "--path");
    const relative = (pathFlag.value ?? pathFlag.rest.join(" ")).trim();
    if (!relative) {
      process.stdout.write("Usage: ocp read [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const read = await readSandboxText(root, relative);
    if (!read.ok) {
      process.stdout.write(`${read.detail}\n`);
      return 1;
    }
    const body = read.detail.length > 4000 ? `${read.detail.slice(0, 4000)}\n(truncated)` : read.detail;
    process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
    return 0;
  }
  if (command === "list") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const pathFlag = takeFlag(partner.rest, "--path");
    const relative = (pathFlag.value ?? pathFlag.rest.join(" ")).trim();
    if ((pathFlag.value && pathFlag.rest.length > 0) || pathFlag.rest.length > 1) {
      process.stdout.write("Usage: ocp list [--sandbox .sandbox] [--partner name] [path]\n");
      return 2;
    }
    if (refusedSandboxList(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    await mkdir(root, { recursive: true });
    const listed = await listSandboxDir(root, relative || ".");
    if (!listed.ok) {
      process.stdout.write(`${listed.detail}\n`);
      return 1;
    }
    const names = listed.detail === "(empty)" ? "(empty)" : listed.detail.split(", ").map(redactListName).join(", ");
    process.stdout.write(`${names}\n`);
    return 0;
  }
  if (command === "grep") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const textFlag = takeFlag(partner.rest, "--text");
    const pathFlag = takeFlag(textFlag.rest, "--path");
    const query = (textFlag.value ?? "").trim();
    const relative = (pathFlag.value ?? pathFlag.rest.join(" ")).trim();
    if (!query || (pathFlag.value && pathFlag.rest.length > 0) || pathFlag.rest.length > 1) {
      process.stdout.write("Usage: ocp grep --text \"...\" [--sandbox .sandbox] [--partner name] [path]\n");
      return 2;
    }
    if (relative && refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const found = await grepSandbox(root, query, relative || ".");
    if (!found.ok) {
      process.stdout.write(`${found.detail}\n`);
      return 1;
    }
    const body = found.detail === "(no matches)" ? "(no matches)" : found.detail.split("\n").map(redactGrepLine).join("\n");
    process.stdout.write(`${body}\n`);
    return 0;
  }
  if (command === "glob") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const patternFlag = takeFlag(partner.rest, "--pattern");
    const pattern = (patternFlag.value ?? "").trim();
    if (!pattern || patternFlag.rest.length > 0) {
      process.stdout.write("Usage: ocp glob --pattern \"*.txt\" [--sandbox .sandbox] [--partner name]\n");
      return 2;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const found = await globSandbox(root, pattern);
    if (!found.ok) {
      process.stdout.write(`${found.detail}\n`);
      return 1;
    }
    const body = found.detail === "(no matches)" ? "(no matches)" : found.detail.split("\n").map(redactListName).join("\n");
    process.stdout.write(`${body}\n`);
    return 0;
  }
  if (command === "git") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const countFlag = takeFlag(partner.rest, "--n");
    const sub = countFlag.rest[0];
    const diffPath = countFlag.rest.slice(1).join(" ");
    const showPath = diffPath;
    const count = countFlag.value === undefined ? 10 : Number(countFlag.value);
    const logOk = sub === "log" && countFlag.rest.length === 1 && Number.isInteger(count) && count >= 1 && count <= 20;
    const statusOk = sub === "status" && countFlag.value === undefined && countFlag.rest.length === 1;
    const diffOk = sub === "diff" && countFlag.value === undefined && countFlag.rest.length <= 2;
    const showRefused = sub === "show" && countFlag.value === undefined && countFlag.rest.length === 2 && refusedSandboxRead(showPath);
    const showOk = sub === "show" && countFlag.value === undefined && countFlag.rest.length === 2 && !showRefused;
    if (showRefused || (diffOk && diffPath && refusedSandboxRead(diffPath))) {
      process.stdout.write("path refused\n");
      return 1;
    }
    if (!logOk && !statusOk && !diffOk && !showOk) {
      process.stdout.write("Usage: ocp git status [--sandbox .sandbox] [--partner name]\n       ocp git log [--n N] [--sandbox .sandbox] [--partner name]\n       ocp git diff [--sandbox .sandbox] [--partner name] [path]\n       ocp git show [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    await mkdir(root, { recursive: true });
    const argv = showOk
      ? ["git", "show", `HEAD:${showPath}`]
      : diffOk
        ? (diffPath ? ["git", "diff", diffPath] : ["git", "diff"])
        : logOk
          ? ["git", "log", "--oneline", "-n", String(count)]
          : ["git", "status", "-sb"];
    const result = await runGitArgv(root, argv);
    const name = showOk ? "git show" : diffOk ? "git diff" : logOk ? "git log" : "git status";
    if (result.missing) {
      process.stdout.write(`${name} did not run.\n`);
      return 1;
    }
    const text = result.output.trim();
    const capped = text.length > 2000 ? `${text.slice(0, 2000)}\n(truncated)` : text;
    const lines = capped
      ? capped.split("\n").filter((line) => logOk || showOk || (!line.includes(".ocp") && !line.includes("gtm"))).map(redactListName)
      : [`${name} exit ${result.code}`];
    process.stdout.write(`${lines.filter((line) => line.length > 0).join("\n")}\n`);
    return result.code === 0 ? 0 : 1;
  }
  if (command === "turns") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    if (partner.rest.length > 0) {
      process.stdout.write("Usage: ocp turns [--sandbox .sandbox] [--partner name]\n");
      return 2;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    let raw: string;
    try {
      raw = await readFile(path.join(root, ".ocp", "prior-turns.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("Turns: none\n");
        return 0;
      }
      process.stdout.write("Turns: unreadable\n");
      return 1;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      process.stdout.write("Turns: unreadable\n");
      return 1;
    }
    const turns = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { turns?: unknown }).turns : undefined;
    if (!Array.isArray(turns) || turns.some((item) => typeof item !== "string")) {
      process.stdout.write("Turns: unreadable\n");
      return 1;
    }
    if (turns.length === 0) {
      process.stdout.write("Turns: none\n");
      return 0;
    }
    const outcomes: string[] = [];
    for (const line of turns) {
      const marker = " Outcome: ";
      const at = line.lastIndexOf(marker);
      if (at < 0) {
        process.stdout.write("Turns: unreadable\n");
        return 1;
      }
      outcomes.push(redactListName(line.slice(at + marker.length).trim()));
    }
    process.stdout.write(`${outcomes.join("\n")}\n`);
    return 0;
  }
  if (command === "append") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const textFlag = takeFlag(partner.rest, "--text");
    const relative = textFlag.rest.join(" ").trim();
    if (textFlag.value === undefined || textFlag.value.length === 0 || !relative) {
      process.stdout.write("Usage: ocp append --text \"...\" [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const appended = await appendSandboxFile(root, relative, textFlag.value);
    if (!appended.ok) {
      process.stdout.write(`${redactListName(appended.detail)}\n`);
      return 1;
    }
    process.stdout.write("appended\n");
    return 0;
  }
  if (command === "mkdir") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const relative = partner.rest.join(" ").trim();
    if (!relative) {
      process.stdout.write("Usage: ocp mkdir [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const made = await mkdirSandboxDir(root, relative);
    if (!made.ok) {
      process.stdout.write(`${redactListName(made.detail)}\n`);
      return 1;
    }
    process.stdout.write(`${made.detail}\n`);
    return 0;
  }
  if (command === "delete") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const relative = partner.rest.join(" ").trim();
    if (!relative) {
      process.stdout.write("Usage: ocp delete [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const removed = await deleteSandboxFile(root, relative);
    if (!removed.ok) {
      process.stdout.write(`${redactListName(removed.detail)}\n`);
      return 1;
    }
    process.stdout.write("deleted\n");
    return 0;
  }
  if (command === "rmdir") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const relative = partner.rest.join(" ").trim();
    if (!relative) {
      process.stdout.write("Usage: ocp rmdir [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const removed = await rmdirSandboxDir(root, relative);
    if (!removed.ok) {
      process.stdout.write(`${redactListName(removed.detail)}\n`);
      return 1;
    }
    process.stdout.write(`${removed.detail}\n`);
    return 0;
  }
  if (command === "rename") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const fromFlag = takeFlag(partner.rest, "--from");
    const toFlag = takeFlag(fromFlag.rest, "--to");
    const fromPath = (fromFlag.value ?? "").trim();
    const toPath = (toFlag.value ?? "").trim();
    if (!fromPath || !toPath || toFlag.rest.length > 0) {
      process.stdout.write("Usage: ocp rename --from path --to path [--sandbox .sandbox] [--partner name]\n");
      return 2;
    }
    if (refusedSandboxRead(fromPath) || refusedSandboxRead(toPath)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const moved = await renameSandboxFile(root, fromPath, toPath);
    if (!moved.ok) {
      process.stdout.write(`${redactListName(moved.detail)}\n`);
      return 1;
    }
    process.stdout.write("renamed\n");
    return 0;
  }
  if (command === "copy") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const fromFlag = takeFlag(partner.rest, "--from");
    const toFlag = takeFlag(fromFlag.rest, "--to");
    const fromPath = (fromFlag.value ?? "").trim();
    const toPath = (toFlag.value ?? "").trim();
    if (!fromPath || !toPath || toFlag.rest.length > 0) {
      process.stdout.write("Usage: ocp copy --from path --to path [--sandbox .sandbox] [--partner name]\n");
      return 2;
    }
    if (refusedSandboxRead(fromPath) || refusedSandboxRead(toPath)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const copied = await copySandboxFile(root, fromPath, toPath);
    if (!copied.ok) {
      process.stdout.write(`${redactListName(copied.detail)}\n`);
      return 1;
    }
    process.stdout.write("copied\n");
    return 0;
  }
  if (command === "write") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const textFlag = takeFlag(partner.rest, "--text");
    const relative = textFlag.rest.join(" ").trim();
    if (textFlag.value === undefined || textFlag.value.length === 0 || !relative) {
      process.stdout.write("Usage: ocp write --text \"...\" [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    if (textFlag.value.includes("\0")) {
      process.stdout.write("not a text file\n");
      return 1;
    }
    const gate = securityGate({ relativePath: relative, content: textFlag.value, sandboxRoot: root });
    if (!gate.allow) {
      process.stdout.write(`${redactListName(`blocked (${gate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    try {
      const info = await stat(path.join(root, relative));
      process.stdout.write(info.isDirectory() ? "path is a directory\n" : "file already exists\n");
      return 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stdout.write("path could not be checked\n");
        return 1;
      }
    }
    await writeSandboxFile(root, relative, textFlag.value);
    process.stdout.write("wrote\n");
    return 0;
  }
  if (command === "patch") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const textFlag = takeFlag(partner.rest, "--text");
    const relative = textFlag.rest.join(" ").trim();
    if (textFlag.value === undefined || textFlag.value.length === 0 || !relative) {
      process.stdout.write("Usage: ocp patch --text \"...\" [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const target = path.join(root, relative);
    let source = "";
    try {
      const info = await stat(target);
      if (info.isDirectory()) {
        process.stdout.write("path is a directory\n");
        return 1;
      }
      source = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("file missing\n");
        return 1;
      }
      process.stdout.write("file could not be read\n");
      return 1;
    }
    const sourceGate = securityGate({ relativePath: relative, content: source, sandboxRoot: root });
    if (!sourceGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${sourceGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    const next = applyUnifiedDiff(source, textFlag.value);
    if (next === null) {
      process.stdout.write("patch did not match\n");
      return 1;
    }
    const nextGate = securityGate({ relativePath: relative, content: next, sandboxRoot: root });
    if (!nextGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${nextGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    await writeSandboxFile(root, relative, next);
    process.stdout.write("patched\n");
    return 0;
  }
  if (command === "replace") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const textFlag = takeFlag(partner.rest, "--text");
    const relative = textFlag.rest.join(" ").trim();
    if (textFlag.value === undefined || textFlag.value.length === 0 || !relative) {
      process.stdout.write("Usage: ocp replace --text \"...\" [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    if (textFlag.value.includes("\0")) {
      process.stdout.write("not a text file\n");
      return 1;
    }
    const gate = securityGate({ relativePath: relative, content: textFlag.value, sandboxRoot: root });
    if (!gate.allow) {
      process.stdout.write(`${redactListName(`blocked (${gate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    try {
      const info = await stat(path.join(root, relative));
      if (info.isDirectory()) {
        process.stdout.write("path is a directory\n");
        return 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("file missing\n");
        return 1;
      }
      process.stdout.write("path could not be checked\n");
      return 1;
    }
    const existing = await readFile(path.join(root, relative), "utf8");
    const existingGate = securityGate({ relativePath: relative, content: existing, sandboxRoot: root });
    if (!existingGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${existingGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    await writeSandboxFile(root, relative, textFlag.value);
    process.stdout.write("replaced\n");
    return 0;
  }
  if (command === "stat") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const relative = partner.rest.join(" ").trim();
    if (!relative) {
      process.stdout.write("Usage: ocp stat [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const gate = securityGate({ relativePath: relative, content: relative, sandboxRoot: root });
    if (!gate.allow) {
      process.stdout.write(`${redactListName(`blocked (${gate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    try {
      const info = await stat(path.join(root, relative));
      process.stdout.write(info.isDirectory() ? "directory\n" : "file\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("missing\n");
        return 0;
      }
      process.stdout.write("path could not be checked\n");
      return 1;
    }
    return 0;
  }
  if (command === "same") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const fromFlag = takeFlag(partner.rest, "--from");
    const toFlag = takeFlag(fromFlag.rest, "--to");
    const fromPath = (fromFlag.value ?? "").trim();
    const toPath = (toFlag.value ?? "").trim();
    if (!fromPath || !toPath || toFlag.rest.length > 0) {
      process.stdout.write("Usage: ocp same --from path --to path [--sandbox .sandbox] [--partner name]\n");
      return 2;
    }
    if (refusedSandboxRead(fromPath) || refusedSandboxRead(toPath)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const readCompared = async (relativePath: string): Promise<string | { blocked: string }> => {
      const target = path.join(root, relativePath);
      try {
        const info = await stat(target);
        if (info.isDirectory()) return { blocked: "path is a directory" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { blocked: "file missing" };
        return { blocked: "file could not be read" };
      }
      const text = await readFile(target, "utf8");
      const gate = securityGate({ relativePath, content: text, sandboxRoot: root });
      if (!gate.allow) return { blocked: `blocked (${gate.reasons.join(", ")})` };
      return text;
    };
    const left = await readCompared(fromPath);
    if (typeof left !== "string") {
      process.stdout.write(`${redactListName(left.blocked)}\n`);
      return 1;
    }
    const right = await readCompared(toPath);
    if (typeof right !== "string") {
      process.stdout.write(`${redactListName(right.blocked)}\n`);
      return 1;
    }
    process.stdout.write(left === right ? "same\n" : "different\n");
    return 0;
  }
  if (command === "contains") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const textFlag = takeFlag(partner.rest, "--text");
    const relative = textFlag.rest.join(" ").trim();
    const query = textFlag.value ?? "";
    if (query.length === 0 || !relative) {
      process.stdout.write("Usage: ocp contains --text \"...\" [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const queryGate = securityGate({ relativePath: "query.txt", content: query, sandboxRoot: root });
    if (!queryGate.allow) {
      process.stdout.write("query refused\n");
      return 1;
    }
    const target = path.join(root, relative);
    let source = "";
    try {
      const info = await stat(target);
      if (info.isDirectory()) {
        process.stdout.write("path is a directory\n");
        return 1;
      }
      source = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("file missing\n");
        return 1;
      }
      process.stdout.write("file could not be read\n");
      return 1;
    }
    const sourceGate = securityGate({ relativePath: relative, content: source, sandboxRoot: root });
    if (!sourceGate.allow) {
      process.stdout.write("skipped\n");
      return 0;
    }
    process.stdout.write(source.includes(query) ? "yes\n" : "no\n");
    return 0;
  }
  if (command === "lines") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const relative = partner.rest.join(" ").trim();
    if (!relative) {
      process.stdout.write("Usage: ocp lines [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const nameGate = securityGate({ relativePath: relative, content: relative, sandboxRoot: root });
    if (!nameGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${nameGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    const target = path.join(root, relative);
    let text = "";
    try {
      const info = await stat(target);
      if (info.isDirectory()) {
        process.stdout.write("path is a directory\n");
        return 1;
      }
      text = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("file missing\n");
        return 1;
      }
      process.stdout.write("file could not be read\n");
      return 1;
    }
    if (text.includes("\0")) {
      process.stdout.write("not a text file\n");
      return 1;
    }
    const gate = securityGate({ relativePath: relative, content: text, sandboxRoot: root });
    if (!gate.allow) {
      process.stdout.write("skipped\n");
      return 0;
    }
    const parts = text.length === 0 ? [] : text.split("\n");
    if (text.endsWith("\n")) parts.pop();
    process.stdout.write(`lines ${parts.length}\n`);
    return 0;
  }
  if (command === "bytes") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const relative = partner.rest.join(" ").trim();
    if (!relative) {
      process.stdout.write("Usage: ocp bytes [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const nameGate = securityGate({ relativePath: relative, content: relative, sandboxRoot: root });
    if (!nameGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${nameGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    const target = path.join(root, relative);
    let size = 0;
    try {
      const info = await stat(target);
      if (info.isDirectory()) {
        process.stdout.write("path is a directory\n");
        return 1;
      }
      size = info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("file missing\n");
        return 1;
      }
      process.stdout.write("path could not be checked\n");
      return 1;
    }
    let text = "";
    try {
      text = await readFile(target, "utf8");
    } catch {
      process.stdout.write("file could not be read\n");
      return 1;
    }
    const gate = securityGate({ relativePath: relative, content: text, sandboxRoot: root });
    if (!gate.allow) {
      process.stdout.write("skipped\n");
      return 0;
    }
    process.stdout.write(`bytes ${size}\n`);
    return 0;
  }
  if (command === "count") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const pathFlag = takeFlag(partner.rest, "--path");
    const relative = (pathFlag.value ?? pathFlag.rest.join(" ")).trim();
    if ((pathFlag.value && pathFlag.rest.length > 0) || pathFlag.rest.length > 1) {
      process.stdout.write("Usage: ocp count [--sandbox .sandbox] [--partner name] [path]\n");
      return 2;
    }
    if (refusedSandboxList(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const nameGate = securityGate({ relativePath: relative || ".", content: relative, sandboxRoot: root });
    if (!nameGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${nameGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    const target = path.join(root, relative || ".");
    try {
      const info = await stat(target);
      if (!info.isDirectory()) {
        process.stdout.write("path is a file\n");
        return 1;
      }
      const names = (await readdir(target)).filter((name) => name !== ".ocp" && name !== "gtm");
      process.stdout.write(`count ${names.length}\n`);
      return 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("directory missing\n");
        return 1;
      }
      process.stdout.write("path could not be checked\n");
      return 1;
    }
  }
  if (command === "trail") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const relative = partner.rest.join(" ").trim();
    if (!relative) {
      process.stdout.write("Usage: ocp trail [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const nameGate = securityGate({ relativePath: relative, content: relative, sandboxRoot: root });
    if (!nameGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${nameGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    const target = path.join(root, relative);
    let text = "";
    try {
      const info = await stat(target);
      if (info.isDirectory()) {
        process.stdout.write("path is a directory\n");
        return 1;
      }
      text = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("file missing\n");
        return 1;
      }
      process.stdout.write("file could not be read\n");
      return 1;
    }
    if (text.includes("\0")) {
      process.stdout.write("not a text file\n");
      return 1;
    }
    const gate = securityGate({ relativePath: relative, content: text, sandboxRoot: root });
    if (!gate.allow) {
      process.stdout.write("skipped\n");
      return 0;
    }
    const trailed = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").some((line) => /[ \t]$/.test(line));
    process.stdout.write(trailed ? "trail\n" : "clean\n");
    return 0;
  }
  if (command === "keep" || command === "drop" || command === "uniq") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const textFlag = command === "uniq" ? { value: undefined as string | undefined, rest: partner.rest } : takeFlag(partner.rest, "--text");
    const relative = textFlag.rest.join(" ").trim();
    const query = textFlag.value ?? "";
    const usage = command === "uniq"
      ? "Usage: ocp uniq [--sandbox .sandbox] [--partner name] path\n"
      : `Usage: ocp ${command} --text "..." [--sandbox .sandbox] [--partner name] path\n`;
    if (!relative || (command !== "uniq" && query.length === 0)) {
      process.stdout.write(usage);
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    if (command !== "uniq") {
      const queryGate = securityGate({ relativePath: "query.txt", content: query, sandboxRoot: sandbox });
      if (!queryGate.allow) {
        process.stdout.write("query refused\n");
        return 1;
      }
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const nameGate = securityGate({ relativePath: relative, content: relative, sandboxRoot: root });
    if (!nameGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${nameGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    const target = path.join(root, relative);
    let source = "";
    try {
      const info = await stat(target);
      if (info.isDirectory()) {
        process.stdout.write("path is a directory\n");
        return 1;
      }
      source = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("file missing\n");
        return 1;
      }
      process.stdout.write("file could not be read\n");
      return 1;
    }
    if (source.includes("\0")) {
      process.stdout.write("not a text file\n");
      return 1;
    }
    const sourceGate = securityGate({ relativePath: relative, content: source, sandboxRoot: root });
    if (!sourceGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${sourceGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    const split = splitKeptLines(source);
    let lines = split.lines;
    if (command === "keep") lines = lines.filter((line) => line.includes(query));
    else if (command === "drop") lines = lines.filter((line) => !line.includes(query));
    else {
      const seen = new Set<string>();
      lines = lines.filter((line) => {
        if (seen.has(line)) return false;
        seen.add(line);
        return true;
      });
    }
    const next = joinKeptLines(lines, split.trailing);
    const nextGate = securityGate({ relativePath: relative, content: next, sandboxRoot: root });
    if (!nextGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${nextGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    if (next === source) {
      process.stdout.write("clean\n");
      return 0;
    }
    await writeSandboxFile(root, relative, next);
    process.stdout.write(command === "keep" ? "kept\n" : command === "drop" ? "dropped\n" : "unique\n");
    return 0;
  }
  if (command === "mtime") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const relative = partner.rest.join(" ").trim();
    if (!relative) {
      process.stdout.write("Usage: ocp mtime [--sandbox .sandbox] [--partner name] path\n");
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const nameGate = securityGate({ relativePath: relative, content: relative, sandboxRoot: root });
    if (!nameGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${nameGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    const target = path.join(root, relative);
    let info;
    try {
      info = await stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("file missing\n");
        return 1;
      }
      process.stdout.write("path could not be checked\n");
      return 1;
    }
    if (!info.isDirectory()) {
      let text = "";
      try {
        text = await readFile(target, "utf8");
      } catch {
        process.stdout.write("file could not be read\n");
        return 1;
      }
      const gate = securityGate({ relativePath: relative, content: text, sandboxRoot: root });
      if (!gate.allow) {
        process.stdout.write("skipped\n");
        return 0;
      }
    }
    process.stdout.write(`mtime ${info.mtime.toISOString()}\n`);
    return 0;
  }
  if (command === "nest" || command === "unnest") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    const relative = partner.rest.join(" ").trim();
    if (!relative) {
      process.stdout.write(`Usage: ocp ${command} [--sandbox .sandbox] [--partner name] path\n`);
      return 2;
    }
    if (refusedSandboxRead(relative)) {
      process.stdout.write("path refused\n");
      return 1;
    }
    let root = sandbox;
    try {
      if (partner.value) root = await isolatePartner(sandbox, partner.value);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : "partner refused"}\n`);
      return 1;
    }
    const nameGate = securityGate({ relativePath: relative, content: relative, sandboxRoot: root });
    if (!nameGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${nameGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    const target = path.join(root, relative);
    let source = "";
    try {
      const info = await stat(target);
      if (info.isDirectory()) {
        process.stdout.write("path is a directory\n");
        return 1;
      }
      source = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write("file missing\n");
        return 1;
      }
      process.stdout.write("file could not be read\n");
      return 1;
    }
    if (source.includes("\0")) {
      process.stdout.write("not a text file\n");
      return 1;
    }
    const sourceGate = securityGate({ relativePath: relative, content: source, sandboxRoot: root });
    if (!sourceGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${sourceGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    const split = splitKeptLines(source);
    const lines = split.lines.map((line) => {
      if (line.trim().length === 0) return line;
      return command === "nest" ? `  ${line}` : unnestLine(line);
    });
    const next = joinKeptLines(lines, split.trailing);
    const nextGate = securityGate({ relativePath: relative, content: next, sandboxRoot: root });
    if (!nextGate.allow) {
      process.stdout.write(`${redactListName(`blocked (${nextGate.reasons.join(", ")})`)}\n`);
      return 1;
    }
    if (next === source) {
      process.stdout.write("clean\n");
      return 0;
    }
    await writeSandboxFile(root, relative, next);
    process.stdout.write(command === "nest" ? "nested\n" : "unnested\n");
    return 0;
  }
  if (command === "doctor") {
    const sand = takeFlag(tail, "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    let stack: { openclawBin?: string; grokBin?: string; layaPython?: string; layaHfHome?: string } | undefined;
    try {
      stack = JSON.parse(await readFile(path.join(repoRoot, ".bundle/stack.json"), "utf8")) as {
        openclawBin?: string;
        grokBin?: string;
        layaPython?: string;
        layaHfHome?: string;
      };
    } catch {
      stack = undefined;
    }
    const bins = await discoverStack({ env: process.env, repoRoot, stack });
    let playwrightPresent = false;
    try {
      await access(path.join(repoRoot, "node_modules/playwright/package.json"));
      playwrightPresent = true;
    } catch {
      playwrightPresent = false;
    }
    const fleetLine = fleetDoctorLine(await readFleetStatus(sandbox));
    const pendingItems = await listApproveQueue(sandbox);
    const frameLine = await doctorComputerFrameLine(sandbox);
    const runLine = await doctorComputerRunLine(sandbox);
    const controlLine = await doctorComputerControlLine(sandbox);
    const statusLine = await doctorComputerStatusLine(sandbox);
    const mountLine = await doctorSharedMountLine(sandbox);
    const checkLine = await doctorLastCheckLine(sandbox);
    const qaLine = await doctorLastQaLine(sandbox);
    const routineLine = await doctorRoutineLine(sandbox);
    const writeLine = await doctorLastWriteLine(sandbox);
    const swarmLine = await doctorSwarmLine(sandbox);
    const report = await runDoctor({
      env: process.env,
      bins,
      repoRoot,
      playwrightPresent,
      fleetLine,
      approveLine: approveDoctorLine(pendingItems.length, pendingItems),
      frameLine,
      runLine,
      controlLine,
      statusLine,
      mountLine,
      checkLine,
      qaLine,
      routineLine,
      writeLine,
      swarmLine,
      dockerLine: dockerLine(await dockerAnswers()),
      reviewLine: reviewHoldDoctorLine((await listReviewHolds(sandbox)).length),
      planLine: await doctorPlanLine(sandbox),
      agreementLine: partnerAgreementDoctorLine(await partnerAgreementStatus(sandbox)),
      todoLine: todoDoctorLine((await listTodoQueue(sandbox)).filter((item) => !item.done).length),
    });
    process.stdout.write(report.transcript);
    return report.code;
  }
  if (command === "chat") {
    const computerExecute = tail.includes("--computer-execute") || process.env.OCP_COMPUTER_EXECUTE === "1";
    const { value, rest } = takeFlag(
      tail.filter((arg) => arg !== "--computer-execute"),
      "--sandbox",
    );
    const partnerFlag = takeFlag(rest, "--partner");
    const sandbox = value ?? ".sandbox";
    const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    await mkdir(sandbox, { recursive: true });
    try {
      await access(path.join(sandbox, "PARTNER.md"));
    } catch {
      await copyFile(path.join(repoRoot, "PARTNER.md"), path.join(sandbox, "PARTNER.md")).catch(() => undefined);
    }
    const message = partnerFlag.rest.join(" ");
    const turn = (text: string) => runProductTurn(text, sandbox, computerExecute, partnerFlag.value);
    if (message.replace(/^\s+/, "").length === 0) {
      if (!stdin.isTTY) {
        process.stderr.write("Usage: ocp chat --sandbox .sandbox \"your message\"\n");
        return 2;
      }
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        return await runChatRepl({
          read: async () => rl.question(""),
          write: (text) => process.stdout.write(text),
          turn,
        });
      } finally {
        rl.close();
      }
    }
    const result = await turn(message);
    process.stdout.write(result.transcript);
    return 0;
  }
  process.stdout.write(
    "Open Coding Partner chat\n\n  ocp chat --sandbox .sandbox\n  ocp chat --sandbox .sandbox \"Use the coding worker to create hello.txt with content:\nhello\n\"\n  ocp chat --sandbox .sandbox --computer-execute \"Open https://example.com\"\n  ocp demo --sandbox .sandbox\n  ocp doctor\n  ocp check --sandbox .sandbox\n  ocp read --sandbox .sandbox path\n  ocp list --sandbox .sandbox\n  ocp grep --text \"...\" --sandbox .sandbox\n  ocp glob --pattern \"*.txt\" --sandbox .sandbox\n  ocp git status --sandbox .sandbox\n  ocp git log --sandbox .sandbox\n  ocp git diff --sandbox .sandbox\n  ocp git show --sandbox .sandbox path\n  ocp turns --sandbox .sandbox\n  ocp append --text \"...\" --sandbox .sandbox path\n  ocp mkdir --sandbox .sandbox path\n  ocp delete --sandbox .sandbox path\n  ocp rmdir --sandbox .sandbox path\n  ocp rename --from path --to path --sandbox .sandbox\n  ocp copy --from path --to path --sandbox .sandbox\n  ocp write --text \"...\" --sandbox .sandbox path\n  ocp patch --text \"...\" --sandbox .sandbox path\n  ocp replace --text \"...\" --sandbox .sandbox path\n  ocp stat --sandbox .sandbox path\n  ocp same --from path --to path --sandbox .sandbox\n  ocp contains --text \"...\" --sandbox .sandbox path\n  ocp lines --sandbox .sandbox path\n  ocp bytes --sandbox .sandbox path\n  ocp count --sandbox .sandbox\n  ocp trail --sandbox .sandbox path\n  ocp keep --text \"...\" --sandbox .sandbox path\n  ocp drop --text \"...\" --sandbox .sandbox path\n  ocp uniq --sandbox .sandbox path\n  ocp mtime --sandbox .sandbox path\n  ocp nest --sandbox .sandbox path\n  ocp unnest --sandbox .sandbox path\n  ocp prove coding\n  ocp prove computer\n  ocp computer --sandbox .sandbox\n  ocp computer --sandbox .sandbox takeover\n  ocp computer --sandbox .sandbox return\n  ocp computer --sandbox .sandbox qa\n\nThe Computer tab shows the sandbox desktop status and the last frame path. There is no live pixel stream in this build. takeover hands the browser to you. return hands it back to the partner. ocp computer qa checks the frame file and does not open a page.\nOrchestration owns the session plan. After it accepts the plan, it invokes the sandbox write bridge. The transcript says Write path: orchestration. Delete and rename use the same bridge when the gateway drove the turn. When the gateway is down, the transcript says Write path: local sandbox. fs_write, apply_patch, and sessions_spawn stay blocked.\nThe computer agent opens a browser only with --computer-execute or OCP_COMPUTER_EXECUTE=1, and only after an Approve card when the sandbox has PARTNER.md. It opens a named http(s) URL, reads the screen, and types into one selector when you ask. A live stream is not in this build.\n",
  );
  return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
}

async function runProductTurn(message: string, sandbox: string, computerExecute: boolean, partnerId?: string) {
  const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  let stack: { openclawBin?: string; grokBin?: string; layaPython?: string; layaHfHome?: string } | undefined;
  try {
    stack = JSON.parse(await readFile(path.join(repoRoot, ".bundle/stack.json"), "utf8")) as {
      openclawBin?: string;
      grokBin?: string;
      layaPython?: string;
      layaHfHome?: string;
    };
  } catch {
    stack = undefined;
  }
  const bins = await discoverStack({ env: process.env, repoRoot, stack });
  const writeRoot = partnerId ? await isolatePartner(sandbox, partnerId) : sandbox;
  const bridge = await startSandboxWriteBridge(writeRoot);
  const env = { ...process.env, OCP_WRITE_BRIDGE_URL: bridge.url };
  try {
  const input: ChatTurnInput = {
    message,
    sandboxRoot: sandbox,
    computerExecute,
    computerUrl: process.env.OCP_COMPUTER_URL,
    computerAllowHosts: process.env.OCP_COMPUTER_ALLOW_HOSTS?.split(","),
    partnerId,
    acp: await acpOptIn(sandbox, process.env),
    browserDriver: computerExecute ? playwrightBrowserDriver() : undefined,
    orchestration: (plan) => sendOrchestrationTurn(message, { env, bins }, plan),
    openclawWrite: (relativePath, content) => writeViaOpenClaw({ env, bins }, writeRoot, relativePath, content),
    openclawDelete: (relativePath) => deleteViaOpenClaw({ env, bins }, writeRoot, relativePath),
    openclawMkdir: (relativePath) => mkdirViaOpenClaw({ env, bins }, writeRoot, relativePath),
    openclawRmdir: (relativePath) => rmdirViaOpenClaw({ env, bins }, writeRoot, relativePath),
    openclawRename: (fromPath, toPath) => renameViaOpenClaw({ env, bins }, writeRoot, fromPath, toPath),
    openclawCopy: (fromPath, toPath) => copyViaOpenClaw({ env, bins }, writeRoot, fromPath, toPath),
    openclawAppend: (relativePath, content) => appendViaOpenClaw({ env, bins }, writeRoot, relativePath, content),
    openclawTodo: (action, content) => todoViaOpenClaw({ env, bins }, writeRoot, action, content),
  };
  if (bins.layaPython) {
    const pythonBin = bins.layaPython;
    const script = path.join(repoRoot, "integrations/laya/predict.py");
    const hfHome = bins.layaHfHome;
    input.layaPredict = (text) =>
      routeWithPredict(text, (state, questions) =>
        predictWithLaya(pythonBin, script, state, questions, undefined, hfHome ? { HF_HOME: hfHome } : undefined),
      );
  }
  const meter = codingRunnerForEnv(bins, process.env);
  if (meter.runner && meter.via) {
    input.grokRunner = meter.runner;
    input.codingVia = meter.via;
  }
  return await runChatTurn(input);
  } finally {
    await bridge.close();
  }
}

function dockerAnswers(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 1500);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && stdout.trim().length > 0);
    });
  });
}

async function receiveChannel(kind: "slack" | "telegram", argv: readonly string[]): Promise<number> {
  const sand = takeFlag(argv, "--sandbox");
  const sandbox = sand.value ?? ".sandbox";
  const bodyFlag = takeFlag(sand.rest, "--body");
  const timestamp = takeFlag(bodyFlag.rest, "--timestamp");
  const signature = takeFlag(timestamp.rest, "--signature");
  const header = takeFlag(signature.rest, "--secret-header");
  if (!bodyFlag.value || (kind === "slack" && (!timestamp.value || !signature.value)) || (kind === "telegram" && !header.value)) {
    process.stdout.write("Usage: ocp channel slack receive --sandbox .sandbox --body event.json --timestamp SECONDS --signature v0=...\n       ocp channel telegram receive --sandbox .sandbox --body update.json --secret-header VALUE\n");
    return 2;
  }
  const rawBody = await readFile(bodyFlag.value, "utf8");
  const run = async (message: string, partnerId: string) => {
    const turn = await runProductTurn(message, sandbox, false, partnerId);
    return turn.transcript;
  };
  if (kind === "slack") {
    const creds = slackCredentialStatus(process.env);
    if (!creds.ready) {
      process.stdout.write(`Slack live: missing ${creds.missing.join(", ")}. The update was not accepted.\n`);
      return 1;
    }
    const result = await deliverSlackEvent({
      rawBody,
      timestamp: timestamp.value ?? "",
      signature: signature.value ?? "",
      signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
      botToken: process.env.SLACK_BOT_TOKEN ?? "",
      nowMs: Date.now(),
    }, run);
    return writeChannelDelivery("Slack", result);
  }
  const creds = telegramCredentialStatus(process.env);
  if (!creds.ready) {
    process.stdout.write(`Telegram live: missing ${creds.missing.join(", ")}. The update was not accepted.\n`);
    return 1;
  }
  const result = await deliverTelegramUpdate({
    rawBody,
    secretHeader: header.value ?? "",
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  }, run);
  return writeChannelDelivery("Telegram", result);
}

function writeChannelDelivery(name: "Slack" | "Telegram", result: { ok: boolean; reply: string; posted: boolean }): number {
  const refused = new Set([
    "missing signature",
    "bad signature",
    "stale timestamp",
    "missing secret",
    "bad secret",
    "Slack event had no text.",
    "Telegram update had no text.",
  ]);
  if (refused.has(result.reply)) {
    process.stdout.write(`${result.reply}\nThe update was not accepted.\n`);
    return 1;
  }
  if (!result.posted) process.stdout.write(`${name} post was not sent.\n`);
  process.stdout.write(result.reply);
  return result.ok ? 0 : 1;
}

const entry = process.argv[1];
const isDirect = entry !== undefined && sameFile(fileURLToPath(import.meta.url), entry);
if (isDirect) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    },
  );
}
