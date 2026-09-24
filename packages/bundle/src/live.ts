import { spawn } from "node:child_process";
import { grokBuildArgv } from "./grok-argv.js";
import type { StackBins } from "./discover.js";

export interface LiveProbe {
  skipped: boolean;
  connected: boolean;
  transcript: string;
}

function run(bin: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("error", (error) => {
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

/**
 * Probe the installed OpenClaw and Grok Build binaries.
 * Missing binaries are a skip, not a fake success.
 * A version check does not mean a model call ran.
 */
export async function probeLiveStack(bins: StackBins): Promise<LiveProbe> {
  if (!bins.openclawBin || !bins.grokBin) {
    return {
      skipped: true,
      connected: false,
      transcript: [
        "Connected demo skipped.",
        "OpenClaw or Grok Build is not installed.",
        "Install the stack with: pnpm bundle:install",
        "The offline demo still works: pnpm exec ocp demo --sandbox .sandbox",
        "",
      ].join("\n"),
    };
  }

  const openclaw = await run(bins.openclawBin, ["--version"]);
  const grok = await run(bins.grokBin, ["--version"]);
  const codingArgv = grokBuildArgv("Say ready.", process.cwd());
  const lines = [
    "Connected stack",
    `OpenClaw: ${bins.openclawBin}`,
    `OpenClaw version: ${firstLine(openclaw.stdout || openclaw.stderr) || "(no output)"}`,
    `Grok Build: ${bins.grokBin}`,
    `Grok Build version: ${firstLine(grok.stdout || grok.stderr) || "(no output)"}`,
    "Chat agent hands orchestration to this OpenClaw binary.",
    `Coding and QA agents call: ${codingArgv.join(" ")}`,
    "This probe did not send a model prompt.",
  ];

  let layaNote = "Laya: not installed. The mock System-1 router still picks the route.";
  if (bins.layaPython) {
    const laya = await run(bins.layaPython, ["-c", "import laya; print(getattr(laya, '__version__', 'installed'))"]);
    layaNote =
      laya.code === 0
        ? `Laya: ${firstLine(laya.stdout) || "import ok"} via ${bins.layaPython}`
        : "Laya python is set, but import failed. The mock System-1 router still picks the route.";
  }
  lines.push(layaNote);

  const connected = openclaw.code === 0 && grok.code === 0;
  if (!connected) {
    lines.push("The binaries were found, but a version check failed. The stack is not connected.");
  } else {
    lines.push("OpenClaw and Grok Build answered. The stack is connected.");
  }
  return { skipped: false, connected, transcript: `${lines.join("\n")}\n` };
}
