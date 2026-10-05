#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { codingRunnerForEnv, copyViaOpenClaw, deleteViaOpenClaw, discoverStack, mkdirViaOpenClaw, predictWithLaya, renameViaOpenClaw, rmdirViaOpenClaw, runConnectedPath, runDoctor, sendOrchestrationTurn, startSandboxWriteBridge, writeViaOpenClaw } from "@opencodingpartner/bundle";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { acpOptIn, applySwarmManifest, captureComputerFrame, computerTabText, createRoutine, fireDueRoutines, fireEvent, formatRoutineList, formatSettings, isolatePartner, listRoutines, parseSwarmManifest, pauseRoutine, postSlackReply, readPackaging, resumeRoutine, returnComputer, runChatTurn, runDemo, slackCredentialStatus, slackTurn, startPartnerContainer, stopPartnerContainer, takeoverComputer, telegramTurn, validateSwarmManifest, type ChatTurnInput } from "@opencodingpartner/gateway";
import { playwrightBrowserDriver } from "@opencodingpartner/workers";
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
    } else if (action) {
      process.stdout.write("Usage: ocp computer [--sandbox .sandbox] [--partner name] [takeover|return|capture]\n");
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
    const dryRun = tail.includes("--dry-run");
    const args = tail.filter((arg) => arg !== "--dry-run");
    const sub = args[0];
    const sand = takeFlag(args.slice(1), "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const partner = takeFlag(sand.rest, "--partner");
    if (!partner.value || (sub !== "start" && sub !== "stop")) {
      process.stdout.write("Usage: ocp fleet start|stop --partner name [--sandbox .sandbox] [--dry-run]\n");
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
    const sand = takeFlag(tail.slice(1), "--sandbox");
    const sandbox = sand.value ?? ".sandbox";
    const text = takeFlag(sand.rest, "--text");
    const channel = takeFlag(text.rest, "--channel");
    if ((kind !== "slack" && kind !== "telegram") || !text.value || !channel.value) {
      process.stdout.write("Usage: ocp channel slack|telegram --sandbox .sandbox --text \"...\" --channel name\n");
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
  if (command === "doctor") {
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
    const report = await runDoctor({ env: process.env, bins, repoRoot, playwrightPresent });
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
    "Open Coding Partner chat\n\n  ocp chat --sandbox .sandbox\n  ocp chat --sandbox .sandbox \"Use the coding worker to create hello.txt with content:\nhello\n\"\n  ocp chat --sandbox .sandbox --computer-execute \"Open https://example.com\"\n  ocp demo --sandbox .sandbox\n  ocp doctor\n  ocp prove coding\n  ocp prove computer\n  ocp computer --sandbox .sandbox\n  ocp computer --sandbox .sandbox takeover\n  ocp computer --sandbox .sandbox return\n\nThe Computer tab shows the sandbox desktop status and the last frame path. There is no live pixel stream in this build. takeover hands the browser to you. return hands it back to the partner.\nOrchestration owns the session plan. After it accepts the plan, it invokes the sandbox write bridge. The transcript says Write path: orchestration. Delete and rename use the same bridge when the gateway drove the turn. When the gateway is down, the transcript says Write path: local sandbox. fs_write, apply_patch, and sessions_spawn stay blocked.\nThe computer agent opens a browser only with --computer-execute or OCP_COMPUTER_EXECUTE=1, and only after an Approve card when the sandbox has PARTNER.md. It opens a named http(s) URL, reads the screen, and types into one selector when you ask. A live stream is not in this build.\n",
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
  const bridge = await startSandboxWriteBridge(sandbox);
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
    openclawWrite: (relativePath, content) => writeViaOpenClaw({ env, bins }, sandbox, relativePath, content),
    openclawDelete: (relativePath) => deleteViaOpenClaw({ env, bins }, sandbox, relativePath),
    openclawMkdir: (relativePath) => mkdirViaOpenClaw({ env, bins }, sandbox, relativePath),
    openclawRmdir: (relativePath) => rmdirViaOpenClaw({ env, bins }, sandbox, relativePath),
    openclawRename: (fromPath, toPath) => renameViaOpenClaw({ env, bins }, sandbox, fromPath, toPath),
    openclawCopy: (fromPath, toPath) => copyViaOpenClaw({ env, bins }, sandbox, fromPath, toPath),
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
