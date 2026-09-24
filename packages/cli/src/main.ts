#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverStack, probeLiveStack } from "@opencodingpartner/bundle";
import { readFile } from "node:fs/promises";
import { runChatTurn, runDemo } from "@opencodingpartner/gateway";

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
      const probe = await probeLiveStack(bins);
      process.stdout.write(probe.transcript);
      return probe.skipped || probe.connected ? 0 : 1;
    }
    const sandbox = value ?? ".sandbox";
    const demo = await runDemo(sandbox);
    process.stdout.write(demo.transcript);
    return demo.code;
  }
  if (command === "chat") {
    const { value, rest } = takeFlag(tail, "--sandbox");
    const message = rest.join(" ");
    if (message.replace(/^\s+/, "").length === 0) {
      process.stderr.write("Usage: ocp chat --sandbox .sandbox \"your message\"\n");
      return 2;
    }
    const turn = await runChatTurn({ message, sandboxRoot: value ?? ".sandbox" });
    process.stdout.write(turn.transcript);
    return 0;
  }
  process.stdout.write(
    "OpenCodingPartner chat agent\n\n  ocp demo --sandbox .sandbox\n  ocp demo --live\n  ocp chat --sandbox .sandbox \"Stand up a coding agent and a QA agent.\"\n",
  );
  return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
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
