import { readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { securityGate } from "./security.js";

export interface ToolStep {
  tool: "list" | "read" | "grep" | "run" | "write" | "patch" | "delete";
  path?: string;
  query?: string;
  content?: string;
  diff?: string;
  argv?: string[];
}

export interface CodingReply {
  steps: ToolStep[];
  done: boolean;
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
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as { steps?: unknown; done?: unknown };
    const done = parsed.done === true;
    if (!Array.isArray(parsed.steps) || (parsed.steps.length === 0 && !done)) return null;
    const steps: ToolStep[] = [];
    for (const item of parsed.steps) {
      if (!item || typeof item !== "object") return null;
      const record = item as { tool?: unknown; path?: unknown; query?: unknown; content?: unknown; diff?: unknown; argv?: unknown };
      if (record.tool !== "list" && record.tool !== "read" && record.tool !== "grep" && record.tool !== "run" && record.tool !== "write" && record.tool !== "patch" && record.tool !== "delete") {
        return null;
      }
      const step: ToolStep = { tool: record.tool };
      if (typeof record.path === "string") step.path = record.path;
      if (typeof record.query === "string") step.query = record.query;
      if (typeof record.content === "string") step.content = record.content;
      if (typeof record.diff === "string") step.diff = record.diff;
      if (Array.isArray(record.argv) && record.argv.every((part) => typeof part === "string")) step.argv = record.argv;
      steps.push(step);
    }
    return { steps, done };
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

const GREP_HIT_CAP = 20;
const GREP_SNIPPET = 120;

/** Substring search, or a `/pattern/` regex. In-process. Skips secrets, binaries, and gtm/. */
export async function grepSandbox(
  sandboxRoot: string,
  query: string,
  relativePath = ".",
): Promise<{ ok: boolean; detail: string }> {
  const needle = query.trim();
  if (!needle || needle.length > 80) return { ok: false, detail: "query missing or too long" };
  const gate = securityGate({ relativePath: relativePath || ".", content: "", sandboxRoot });
  if (!gate.allow) return { ok: false, detail: `blocked (${gate.reasons.join(", ")})` };
  let matcher: (line: string) => boolean;
  if (needle.startsWith("/") && needle.endsWith("/") && needle.length > 2) {
    const source = needle.slice(1, -1);
    if (source.length > 40 || /[+*]{2,}|\{/.test(source)) return { ok: false, detail: "regex is not simple" };
    try {
      const pattern = new RegExp(source);
      matcher = (line) => pattern.test(line);
    } catch {
      return { ok: false, detail: "regex is not simple" };
    }
  } else {
    matcher = (line) => line.includes(needle);
  }
  const root = path.resolve(sandboxRoot);
  const start = path.resolve(root, relativePath || ".");
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (start !== root && !start.startsWith(rootPrefix)) return { ok: false, detail: "path left the sandbox" };
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= GREP_HIT_CAP) return;
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const name of names) {
      if (hits.length >= GREP_HIT_CAP) return;
      const abs = path.join(dir, name.name);
      const rel = path.relative(root, abs);
      if (rel === "gtm" || rel.startsWith(`gtm${path.sep}`) || rel.split(path.sep).includes("gtm")) continue;
      if (name.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!name.isFile()) continue;
      let text = "";
      try {
        text = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0") || text.length > 200_000) continue;
      const fileGate = securityGate({ relativePath: rel, content: text, sandboxRoot });
      if (!fileGate.allow) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (!matcher(line)) continue;
        const snippet = line.trim().slice(0, GREP_SNIPPET);
        hits.push(`${rel}:${i + 1}: ${snippet}`);
        if (hits.length >= GREP_HIT_CAP) return;
      }
    }
  };
  await walk(start);
  return { ok: true, detail: hits.length > 0 ? hits.join("\n") : "(no matches)" };
}

/** Unlink one file inside the sandbox. Directories and gtm/ evidence stay. */
export async function deleteSandboxFile(sandboxRoot: string, relativePath: string): Promise<{ ok: boolean; detail: string }> {
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(root, relativePath);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!target.startsWith(rootPrefix)) return { ok: false, detail: "path left the sandbox" };
  const rel = path.relative(root, target);
  if (rel === "gtm" || rel.startsWith(`gtm${path.sep}`)) return { ok: false, detail: "gtm evidence is kept" };
  let content = "";
  try {
    const info = await stat(target);
    if (info.isDirectory()) return { ok: false, detail: "directories are not deleted" };
    content = await readFile(target, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { ok: false, detail: "file missing" };
    return { ok: false, detail: "file could not be read" };
  }
  if (content.includes("\0")) return { ok: false, detail: "not a text file" };
  const gate = securityGate({ relativePath, content, sandboxRoot });
  if (!gate.allow) return { ok: false, detail: `blocked (${gate.reasons.join(", ")})` };
  await unlink(target);
  return { ok: true, detail: "deleted" };
}
