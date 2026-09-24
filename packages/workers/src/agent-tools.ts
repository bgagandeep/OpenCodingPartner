import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { securityGate } from "./security.js";

export interface ToolStep {
  tool: "list" | "read" | "run" | "write" | "patch";
  path?: string;
  content?: string;
  diff?: string;
  argv?: string[];
}

export interface CodingReply {
  steps: ToolStep[];
}

/** Only `node --test` plus relative paths. No shell. */
export function commandDecision(argv: readonly string[]): { allow: boolean; reason: string } {
  if (argv.length < 2 || argv.length > 8) return { allow: false, reason: "command is not on the allow list" };
  if (argv[0] !== "node" || argv[1] !== "--test") return { allow: false, reason: "only node --test is allowed" };
  for (const arg of argv.slice(2)) {
    if (!arg || arg.startsWith("-") || arg.startsWith("/") || arg.includes("..") || arg.includes("\n") || arg.includes("\0") || /[;&|`$><\\]/.test(arg)) {
      return { allow: false, reason: "command argument is not a relative test path" };
    }
  }
  return { allow: true, reason: "" };
}

export function parseCodingReply(stdout: string): CodingReply | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as { steps?: unknown };
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
    const steps: ToolStep[] = [];
    for (const item of parsed.steps) {
      if (!item || typeof item !== "object") return null;
      const record = item as { tool?: unknown; path?: unknown; content?: unknown; diff?: unknown; argv?: unknown };
      if (record.tool !== "list" && record.tool !== "read" && record.tool !== "run" && record.tool !== "write" && record.tool !== "patch") {
        return null;
      }
      const step: ToolStep = { tool: record.tool };
      if (typeof record.path === "string") step.path = record.path;
      if (typeof record.content === "string") step.content = record.content;
      if (typeof record.diff === "string") step.diff = record.diff;
      if (Array.isArray(record.argv) && record.argv.every((part) => typeof part === "string")) step.argv = record.argv;
      steps.push(step);
    }
    return { steps };
  } catch {
    return null;
  }
}

/** Apply one unified diff. Returns null when the context does not match. */
export function applyUnifiedDiff(source: string, diff: string): string | null {
  const hadTrailing = source.endsWith("\n");
  const lines = source.replace(/\n$/, "").split("\n");
  const diffLines = diff.split("\n");
  let index = 0;
  while (index < diffLines.length && !diffLines[index]?.startsWith("@@")) index += 1;
  if (index >= diffLines.length) return null;
  const out = [...lines];
  while (index < diffLines.length) {
    const header = diffLines[index] ?? "";
    const match = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!match?.[1]) return null;
    index += 1;
    let cursor = Number(match[1]) - 1;
    while (index < diffLines.length && !diffLines[index]?.startsWith("@@")) {
      const line = diffLines[index] ?? "";
      index += 1;
      if (line.startsWith("\\")) continue;
      const prefix = line[0];
      const text = line.slice(1);
      if (prefix === " ") {
        if (out[cursor] !== text) return null;
        cursor += 1;
      } else if (prefix === "-") {
        if (out[cursor] !== text) return null;
        out.splice(cursor, 1);
      } else if (prefix === "+") {
        out.splice(cursor, 0, text);
        cursor += 1;
      } else if (line === "") {
        continue;
      } else {
        return null;
      }
    }
  }
  const next = out.join("\n");
  return hadTrailing || diff.endsWith("\n") ? `${next}\n` : next;
}

export async function listSandboxDir(sandboxRoot: string, relativePath: string): Promise<{ ok: boolean; detail: string }> {
  const gate = securityGate({ relativePath: relativePath || ".", content: "", sandboxRoot });
  if (!gate.allow) return { ok: false, detail: `blocked (${gate.reasons.join(", ")})` };
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(root, relativePath || ".");
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(rootPrefix)) return { ok: false, detail: "path left the sandbox" };
  try {
    const names = await readdir(target);
    return { ok: true, detail: names.join(", ") || "(empty)" };
  } catch {
    return { ok: false, detail: "directory missing" };
  }
}

export async function readSandboxText(sandboxRoot: string, relativePath: string): Promise<{ ok: boolean; detail: string }> {
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(root, relativePath);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!target.startsWith(rootPrefix)) return { ok: false, detail: "path left the sandbox" };
  let content = "";
  try {
    content = await readFile(target, "utf8");
  } catch {
    return { ok: false, detail: "file missing" };
  }
  const gate = securityGate({ relativePath, content, sandboxRoot });
  if (!gate.allow) return { ok: false, detail: `blocked (${gate.reasons.join(", ")})` };
  return { ok: true, detail: content };
}
