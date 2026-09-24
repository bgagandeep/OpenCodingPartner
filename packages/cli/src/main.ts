#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { codingRunnerForEnv, discoverStack, predictWithLaya, runConnectedPath, runDoctor, sendOrchestrationTurn, startSandboxWriteBridge, writeViaOpenClaw } from "@opencodingpartner/bundle";
import { access, readFile } from "node:fs/promises";
import { runChatTurn, runDemo, type ChatTurnInput } from "@opencodingpartner/gateway";
import { playwrightBrowserDriver } from "@opencodingpartner/workers";
import { routeWithPredict } from "@opencodingpartner/policy";
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
    const sandbox = value ?? ".sandbox";
    const message = rest.join(" ");
    const turn = (text: string) => runProductTurn(text, sandbox, computerExecute);
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
    "OpenCodingPartner chat agent\n\n  ocp chat --sandbox .sandbox\n  ocp chat --sandbox .sandbox \"Use Grok Build to create hello.txt with content:\nhello\n\"\n  ocp chat --sandbox .sandbox --computer-execute \"Open https://example.com\"\n  ocp demo --sandbox .sandbox\n  ocp doctor\n\nOpenClaw owns the session plan. After it accepts the plan, it invokes the sandbox write bridge. The transcript says Write path: OpenClaw-driven. When the gateway is down, the transcript says Write path: local sandbox. fs_write, apply_patch, and sessions_spawn stay blocked.\nThe computer agent opens a browser only with --computer-execute or OCP_COMPUTER_EXECUTE=1. It opens a named http(s) URL, reads the screen, and types into one selector when you ask.\n",
  );
  return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
}

async function runProductTurn(message: string, sandbox: string, computerExecute: boolean) {
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
    browserDriver: computerExecute ? playwrightBrowserDriver() : undefined,
    orchestration: (plan) => sendOrchestrationTurn(message, { env, bins }, plan),
    openclawWrite: (relativePath, content) => writeViaOpenClaw({ env, bins }, sandbox, relativePath, content),
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
