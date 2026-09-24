import { appendFile, copyFile, mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { securityGate } from "./security.js";

export interface ToolStep {
  tool: "list" | "read" | "grep" | "glob" | "run" | "write" | "patch" | "delete" | "rename" | "copy" | "append" | "mkdir" | "rmdir" | "todo";
  path?: string;
  to?: string;
  query?: string;
  content?: string;
  diff?: string;
  argv?: string[];
  action?: string;
}

export interface CodingReply {
  steps: ToolStep[];
  done: boolean;
}

/** `node --test`, `pnpm test`, `tsc --noEmit`, `git status`, `git diff`, `git log --oneline -n N`, or `git show HEAD:path`. Argv only. No shell. */
export function commandDecision(argv: readonly string[]): { allow: boolean; reason: string } {
  if (argv.length < 2 || argv.length > 8) return { allow: false, reason: "command is not on the allow list" };
  const unsafe = (arg: string) => !arg || arg.startsWith("/") || arg.includes("..") || /[\n\r\0;&|`$><\\]/.test(arg);
  if (argv.some(unsafe)) return { allow: false, reason: "command argument is not a relative path" };
  const [bin, sub, ...rest] = argv;
  const relative = (arg: string) => !arg.startsWith("-");
  if (bin === "node" && sub === "--test" && rest.every(relative)) return { allow: true, reason: "" };
  if (bin === "pnpm" && sub === "test" && rest.length === 0) return { allow: true, reason: "" };
  if (bin === "tsc" && sub === "--noEmit" && rest.every(relative)) return { allow: true, reason: "" };
  if (bin === "git" && gitReadOnly(sub, rest)) return { allow: true, reason: "" };
  return { allow: false, reason: "only node --test, pnpm test, tsc --noEmit, git status, git diff, git log --oneline -n N, and git show HEAD:path are allowed" };
}

/** Read-only git. `git log` is only `--oneline -n N` with N from 1 to 20. `git show` is only `HEAD:` plus one relative path. */
function gitReadOnly(sub: string | undefined, rest: readonly string[]): boolean {
  if (sub === "status") {
    if (rest.length === 0) return true;
    if (rest.length === 1 && rest[0] === "-sb") return true;
    return rest.length === 2 && rest[0] === "--short" && rest[1] === "--branch";
  }
  if (sub === "diff") return rest.every((arg) => !arg.startsWith("-"));
  if (sub === "log") {
    if (rest.length !== 3 || rest[0] !== "--oneline" || rest[1] !== "-n") return false;
    const count = Number(rest[2]);
    return Number.isInteger(count) && count >= 1 && count <= 20;
  }
  if (sub === "show") return gitShowHead(rest);
  return false;
}

/** `git show HEAD:relative/path` only. No flags, no other revision, no extra args. */
function gitShowHead(rest: readonly string[]): boolean {
  if (rest.length !== 1) return false;
  const spec = rest[0] ?? "";
  if (!spec.startsWith("HEAD:")) return false;
  const rel = spec.slice("HEAD:".length);
  if (!rel || rel.startsWith("/") || rel.startsWith("-") || rel.includes("..") || rel.includes(":") || rel.includes("\\")) return false;
  return true;
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
      const record = item as { tool?: unknown; path?: unknown; to?: unknown; query?: unknown; content?: unknown; diff?: unknown; argv?: unknown; action?: unknown };
      if (record.tool !== "list" && record.tool !== "read" && record.tool !== "grep" && record.tool !== "glob" && record.tool !== "run" && record.tool !== "write" && record.tool !== "patch" && record.tool !== "delete" && record.tool !== "rename" && record.tool !== "copy" && record.tool !== "append" && record.tool !== "mkdir" && record.tool !== "rmdir" && record.tool !== "todo") {
        return null;
      }
      const step: ToolStep = { tool: record.tool };
      if (typeof record.action === "string") step.action = record.action;
      if (typeof record.path === "string") step.path = record.path;
      if (typeof record.to === "string") step.to = record.to;
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
    const names = (await readdir(target)).filter((name) => name !== ".ocp" && name !== "gtm");
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
      if (rel === ".ocp" || rel.startsWith(`.ocp${path.sep}`) || rel.split(path.sep).includes(".ocp")) continue;
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

const GLOB_CAP = 40;

/** Relative glob. `*` stays in one segment. `**` crosses directories. No shell. */
export async function globSandbox(sandboxRoot: string, pattern: string): Promise<{ ok: boolean; detail: string }> {
  const matcher = globMatcher(pattern);
  if (!matcher) return { ok: false, detail: "pattern is not a relative glob" };
  const root = path.resolve(sandboxRoot);
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= GLOB_CAP) return;
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const name of names) {
      if (hits.length >= GLOB_CAP) return;
      const abs = path.join(dir, name.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (rel === "gtm" || rel.startsWith("gtm/") || rel === ".ocp" || rel.startsWith(".ocp/")) continue;
      if (name.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!name.isFile()) continue;
      if (matcher.test(rel)) hits.push(rel);
    }
  };
  await walk(root);
  return { ok: true, detail: hits.length > 0 ? hits.join("\n") : "(no matches)" };
}

function globMatcher(pattern: string): RegExp | null {
  if (!pattern || pattern.length > 120 || pattern.startsWith("/") || pattern.includes("..")) return null;
  if (/[\n\r\0;&|`$><\\]/.test(pattern)) return null;
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

/** Create one directory inside the sandbox. Parents are created. An existing directory is a no-op. */
export async function mkdirSandboxDir(sandboxRoot: string, relativePath: string): Promise<{ ok: boolean; detail: string }> {
  const gate = securityGate({ relativePath, content: relativePath, sandboxRoot });
  if (!gate.allow) return { ok: false, detail: `blocked (${gate.reasons.join(", ")})` };
  const place = await sandboxFile(sandboxRoot, relativePath);
  if (!place.ok) return place;
  try {
    const info = await stat(place.target);
    if (info.isDirectory()) return { ok: true, detail: "already exists" };
    return { ok: false, detail: "path is a file" };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") return { ok: false, detail: "path could not be checked" };
  }
  try {
    await mkdir(place.target, { recursive: true });
  } catch {
    return { ok: false, detail: "directory was not created" };
  }
  return { ok: true, detail: "created" };
}

/** Remove one empty directory inside the sandbox. A file or a non-empty directory stays. */
export async function rmdirSandboxDir(sandboxRoot: string, relativePath: string): Promise<{ ok: boolean; detail: string }> {
  const gate = securityGate({ relativePath, content: relativePath, sandboxRoot });
  if (!gate.allow) return { ok: false, detail: `blocked (${gate.reasons.join(", ")})` };
  const place = await sandboxFile(sandboxRoot, relativePath);
  if (!place.ok) return place;
  try {
    const info = await stat(place.target);
    if (!info.isDirectory()) return { ok: false, detail: "path is a file" };
    const names = await readdir(place.target);
    if (names.length > 0) return { ok: false, detail: "directory is not empty" };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { ok: false, detail: "directory missing" };
    return { ok: false, detail: "directory could not be checked" };
  }
  try {
    await rmdir(place.target);
  } catch {
    return { ok: false, detail: "directory was not removed" };
  }
  return { ok: true, detail: "removed" };
}

export const TODO_CAP = 12;

export interface SandboxTodo {
  id: string;
  text: string;
  done: boolean;
}

const TODOS_FILE = path.join(".ocp", "todos.json");

/** Add or complete one todo for this sandbox. Stored in `.ocp/todos.json`. Cap is 12. */
export async function applySandboxTodo(
  sandboxRoot: string,
  action: string,
  text: string,
): Promise<{ ok: boolean; detail: string; todos: SandboxTodo[] }> {
  const todos = await readTodos(sandboxRoot);
  const body = text.trim();
  if (action === "add") {
    if (!body || body.includes("\0") || body.includes("../") || body.startsWith("/") || body.startsWith("\\")) {
      return { ok: false, detail: "todo text refused", todos };
    }
    const gate = securityGate({ relativePath: "todo.txt", content: body, sandboxRoot });
    if (!gate.allow) return { ok: false, detail: `blocked (${gate.reasons.join(", ")})`, todos };
    if (todos.length >= TODO_CAP) return { ok: false, detail: "todo cap is 12", todos };
    todos.push({ id: String(todos.length + 1), text: body, done: false });
    await writeTodos(sandboxRoot, todos);
    return { ok: true, detail: `add ${body}`, todos };
  }
  if (action === "complete") {
    const index = Number(body);
    const hit = Number.isInteger(index) && index >= 1 && index <= todos.length
      ? todos[index - 1]
      : todos.find((item) => item.id === body);
    if (!hit) return { ok: false, detail: "todo missing", todos };
    if (hit.done) return { ok: false, detail: "todo already done", todos };
    hit.done = true;
    await writeTodos(sandboxRoot, todos);
    return { ok: true, detail: `complete ${hit.id}`, todos };
  }
  return { ok: false, detail: "todo action refused", todos };
}

/** Short list for the transcript. Empty when there are no todos. */
export function formatTodoBlock(todos: readonly SandboxTodo[]): string {
  if (todos.length === 0) return "";
  const lines = todos.map((item) => `${item.id}. [${item.done ? "done" : "open"}] ${item.text}`);
  return `Todos:\n${lines.join("\n")}`;
}

async function readTodos(sandboxRoot: string): Promise<SandboxTodo[]> {
  try {
    const raw = await readFile(path.join(sandboxRoot, TODOS_FILE), "utf8");
    const parsed = JSON.parse(raw) as { todos?: unknown };
    if (!Array.isArray(parsed.todos)) return [];
    return parsed.todos.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as { id?: unknown; text?: unknown; done?: unknown };
      if (typeof record.id !== "string" || typeof record.text !== "string") return [];
      return [{ id: record.id, text: record.text, done: record.done === true }];
    });
  } catch {
    return [];
  }
}

async function writeTodos(sandboxRoot: string, todos: readonly SandboxTodo[]): Promise<void> {
  const dir = path.join(sandboxRoot, ".ocp");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "todos.json"), `${JSON.stringify({ todos }, null, 2)}\n`);
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

/** Move one file inside the sandbox. Does not overwrite, and does not move directories. */
export async function renameSandboxFile(
  sandboxRoot: string,
  fromPath: string,
  toPath: string,
): Promise<{ ok: boolean; detail: string }> {
  const from = await sandboxFile(sandboxRoot, fromPath);
  if (!from.ok) return from;
  const dest = await sandboxFile(sandboxRoot, toPath);
  if (!dest.ok) return dest;
  let content = "";
  try {
    const info = await stat(from.target);
    if (info.isDirectory()) return { ok: false, detail: "directories are not renamed" };
    content = await readFile(from.target, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { ok: false, detail: "file missing" };
    return { ok: false, detail: "file could not be read" };
  }
  if (content.includes("\0")) return { ok: false, detail: "not a text file" };
  const sourceGate = securityGate({ relativePath: fromPath, content, sandboxRoot });
  if (!sourceGate.allow) return { ok: false, detail: `blocked (${sourceGate.reasons.join(", ")})` };
  const destGate = securityGate({ relativePath: toPath, content, sandboxRoot });
  if (!destGate.allow) return { ok: false, detail: `blocked (${destGate.reasons.join(", ")})` };
  try {
    await stat(dest.target);
    return { ok: false, detail: "target already exists" };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") return { ok: false, detail: "target could not be checked" };
  }
  await mkdir(path.dirname(dest.target), { recursive: true });
  await rename(from.target, dest.target);
  return { ok: true, detail: "renamed" };
}

/** Copy one file inside the sandbox. The source stays. Does not overwrite, and does not copy directories. */
export async function copySandboxFile(
  sandboxRoot: string,
  fromPath: string,
  toPath: string,
): Promise<{ ok: boolean; detail: string }> {
  const from = await sandboxFile(sandboxRoot, fromPath);
  if (!from.ok) return from;
  const dest = await sandboxFile(sandboxRoot, toPath);
  if (!dest.ok) return dest;
  let content = "";
  try {
    const info = await stat(from.target);
    if (info.isDirectory()) return { ok: false, detail: "directories are not copied" };
    content = await readFile(from.target, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { ok: false, detail: "file missing" };
    return { ok: false, detail: "file could not be read" };
  }
  if (content.includes("\0")) return { ok: false, detail: "not a text file" };
  const sourceGate = securityGate({ relativePath: fromPath, content, sandboxRoot });
  if (!sourceGate.allow) return { ok: false, detail: `blocked (${sourceGate.reasons.join(", ")})` };
  const destGate = securityGate({ relativePath: toPath, content, sandboxRoot });
  if (!destGate.allow) return { ok: false, detail: `blocked (${destGate.reasons.join(", ")})` };
  try {
    await stat(dest.target);
    return { ok: false, detail: "target already exists" };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") return { ok: false, detail: "target could not be checked" };
  }
  await mkdir(path.dirname(dest.target), { recursive: true });
  await copyFile(from.target, dest.target);
  return { ok: true, detail: "copied" };
}

/** Add text to one existing file. Does not create a file, and does not append to a directory. */
export async function appendSandboxFile(
  sandboxRoot: string,
  relativePath: string,
  content: string,
): Promise<{ ok: boolean; detail: string }> {
  const file = await sandboxFile(sandboxRoot, relativePath);
  if (!file.ok) return file;
  let existing = "";
  try {
    const info = await stat(file.target);
    if (info.isDirectory()) return { ok: false, detail: "directories are not appended" };
    existing = await readFile(file.target, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { ok: false, detail: "file missing" };
    return { ok: false, detail: "file could not be read" };
  }
  if (existing.includes("\0") || content.includes("\0")) return { ok: false, detail: "not a text file" };
  const gate = securityGate({ relativePath, content: `${existing}${content}`, sandboxRoot });
  if (!gate.allow) return { ok: false, detail: `blocked (${gate.reasons.join(", ")})` };
  await appendFile(file.target, content);
  return { ok: true, detail: "appended" };
}

async function sandboxFile(
  sandboxRoot: string,
  relativePath: string,
): Promise<{ ok: true; target: string } | { ok: false; detail: string }> {
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(root, relativePath);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!target.startsWith(rootPrefix)) return { ok: false, detail: "path left the sandbox" };
  const rel = path.relative(root, target);
  if (rel === "gtm" || rel.startsWith(`gtm${path.sep}`) || rel === ".ocp" || rel.startsWith(`.ocp${path.sep}`)) {
    return { ok: false, detail: "gtm and .ocp stay" };
  }
  return { ok: true, target };
}
