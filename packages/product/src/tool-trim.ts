import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { estimateTokens } from "./context.js";

/** Head and tail kept when a tool result is too long to replay in full. */
export const TOOL_TRIM_HEAD = 400;
export const TOOL_TRIM_TAIL = 400;
export const TOOL_TRIM_THRESHOLD = 1_500;
const STORE_CAP = 500_000;
const FAILURE_CAP = 4_000;

export interface ReadStamp {
  path: string;
  handle: string;
  sha256: string;
}

export interface TrimmedToolOutput {
  display: string;
  full: string;
  handle: string;
  omittedChars: number;
  path?: string;
  store: boolean;
}

const ERROR_LINE = "Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match.";
const PAD = 800;

export const TOOL_REPLAY_PATH = "packages/product/src/server.ts";

export function toolOutputDataDir(env: NodeJS.ProcessEnv = process.env, fallbackHome?: string): string {
  if (env.OCP_DATA_DIR) return path.resolve(env.OCP_DATA_DIR);
  if (env.HERMES_HOME) return path.resolve(env.HERMES_HOME);
  if (fallbackHome) return fallbackHome;
  return path.join(homedir(), ".local", "share", "opencodingpartner", "agent-home");
}

export function newToolOutputId(): string {
  return randomBytes(8).toString("hex");
}

export function parseToolOutputHandle(handle: string): string | undefined {
  const raw = handle.trim();
  const id = raw.startsWith("toolout:") ? raw.slice("toolout:".length) : raw;
  return /^[a-z0-9]{6,32}$/.test(id) ? id : undefined;
}

export function readPathOf(toolName: string, args: Record<string, unknown>): string | undefined {
  const nested = toolName === "tool_call" && args.name === "workspace_read" ? record(args.arguments).path : undefined;
  const direct = toolName === "workspace_read" ? args.path : undefined;
  const value = typeof direct === "string" ? direct : typeof nested === "string" ? nested : undefined;
  if (!value) return undefined;
  const pathName = value.replaceAll("\\", "/").trim();
  if (!pathName || pathName.includes("\n") || pathName.includes("\0")) return undefined;
  return pathName;
}

export function trimToolOutput(input: {
  toolName: string;
  args: Record<string, unknown>;
  text: string;
  previous?: { path: string; text: string; handle: string };
  id: string;
}): TrimmedToolOutput {
  const handle = `toolout:${input.id}`;
  const pathName = readPathOf(input.toolName, input.args);
  if (pathName && input.previous?.path === pathName && input.previous.text === input.text) {
    return {
      display: `Unchanged ${pathName} (${input.previous.handle}, omitted ${input.text.length} characters).`,
      full: input.text,
      handle: input.previous.handle,
      omittedChars: input.text.length,
      path: pathName,
      store: false,
    };
  }
  if (pathName && input.previous?.path === pathName && input.previous.text !== input.text) {
    return diffRead(pathName, input.previous.text, input.text, handle);
  }
  if (shouldSummarizeTest(input.toolName, input.args, input.text)) {
    return summarizeTest(input.text, handle);
  }
  if (input.text.length <= TOOL_TRIM_THRESHOLD) {
    return {
      display: input.text,
      full: input.text,
      handle: pathName ? handle : "",
      omittedChars: 0,
      path: pathName,
      store: Boolean(pathName),
    };
  }
  const shown = headTail(input.text, handle, pathName ? `${pathName}\n` : "");
  return {
    display: shown.display,
    full: input.text,
    handle,
    omittedChars: shown.omittedChars,
    path: pathName,
    store: true,
  };
}

export async function presentToolOutput(input: {
  dataDir: string;
  toolName: string;
  args: Record<string, unknown>;
  text: string;
  reads: ReadStamp[];
  id?: string;
}): Promise<{ display: string; reads: ReadStamp[]; handle: string }> {
  const pathName = readPathOf(input.toolName, input.args);
  const previous = pathName ? input.reads.find((stamp) => stamp.path === pathName) : undefined;
  const same = previous !== undefined && previous.sha256 === sha256(input.text);
  const previousText = previous && !same ? await pageBody(input.dataDir, previous.handle) : undefined;
  const trimmed = trimToolOutput({
    toolName: input.toolName,
    args: input.args,
    text: input.text,
    previous: pathName && previous && (same || previousText !== undefined)
      ? { path: pathName, text: same ? input.text : previousText ?? "", handle: previous.handle }
      : undefined,
    id: input.id ?? newToolOutputId(),
  });
  let display = trimmed.display;
  if (trimmed.store) {
    const capped = trimmed.full.length > STORE_CAP ? trimmed.full.slice(0, STORE_CAP) : trimmed.full;
    if (capped.length !== trimmed.full.length) {
      display = `${display}\nStored copy truncated at ${STORE_CAP} characters.`;
    }
    await storeToolOutput(input.dataDir, trimmed.handle, capped);
  }
  const reads = pathName && trimmed.handle
    ? [...input.reads.filter((stamp) => stamp.path !== pathName), { path: pathName, handle: trimmed.handle, sha256: sha256(input.text) }].slice(-40)
    : input.reads;
  return { display, reads, handle: trimmed.handle };
}

export async function storeToolOutput(dataDir: string, handle: string, text: string): Promise<void> {
  const target = outputPath(dataDir, handle);
  if (!target) throw new Error("Tool output handle is not valid.");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, { encoding: "utf8", mode: 0o600 });
}

export async function pageStoredToolOutput(dataDir: string, handle: string, offset = 0, limit = 8_000): Promise<string | undefined> {
  const target = outputPath(dataDir, handle);
  if (!target) return undefined;
  const text = await readFile(target, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const size = Number.isFinite(limit) ? Math.max(1, Math.min(16_000, Math.floor(limit))) : 8_000;
  if (text.length > 0 && start >= text.length) {
    const id = parseToolOutputHandle(handle);
    return `toolout:${id} is ${text.length} characters. offset ${start} is past the end.`;
  }
  const slice = text.slice(start, start + size);
  const id = parseToolOutputHandle(handle);
  return `toolout:${id} offset ${start} length ${slice.length} of ${text.length}.\n${slice}`;
}

/** Fixed tool-output transcript. Separate from the rolling-context replay. */
export function toolReplayFile(variant: "same" | "changed"): string {
  const middle = variant === "changed"
    ? `${ERROR_LINE} Decision: keep the draft reply in the app.`
    : ERROR_LINE;
  return `${"A".repeat(PAD)}\n${middle}\n${"B".repeat(PAD)}`;
}

export function toolReplayTestLog(): string {
  const lines = ["TAP version 13"];
  for (let index = 1; index <= 80; index += 1) lines.push(`ok ${index} - draft check ${index}`);
  lines.push(
    "not ok 81 - draft reply",
    "  error: 'Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match.'",
    "  location: 'packages/product/src/server.ts:12:1'",
    "# tests 81",
    "# pass 80",
    "# fail 1",
    "# skipped 0",
  );
  return lines.join("\n");
}

export function replayTrimmedToolOutputs(): {
  beforeEstimated: number;
  afterEstimated: number;
  displays: string[];
  fulls: string[];
} {
  const file = toolReplayFile("same");
  const steps = [
    { toolName: "workspace_read", args: { path: TOOL_REPLAY_PATH }, text: file, id: "replay01" },
    { toolName: "workspace_read", args: { path: TOOL_REPLAY_PATH }, text: file, id: "replay02" },
    { toolName: "workspace_read", args: { path: TOOL_REPLAY_PATH }, text: toolReplayFile("changed"), id: "replay03" },
    { toolName: "workspace_test", args: {}, text: toolReplayTestLog(), id: "replay04" },
  ];
  let previous: { path: string; text: string; handle: string } | undefined;
  const displays: string[] = [];
  const fulls: string[] = [];
  for (const step of steps) {
    const pathName = readPathOf(step.toolName, step.args);
    const trimmed = trimToolOutput({
      toolName: step.toolName,
      args: step.args,
      text: step.text,
      previous: pathName && previous?.path === pathName ? previous : undefined,
      id: step.id,
    });
    displays.push(trimmed.display);
    fulls.push(trimmed.full);
    if (pathName) previous = { path: pathName, text: step.text, handle: trimmed.handle };
  }
  return {
    beforeEstimated: estimateTokens(steps.map((step) => step.text).join("\n")),
    afterEstimated: estimateTokens(displays.join("\n")),
    displays,
    fulls,
  };
}

function diffRead(pathName: string, before: string, after: string, handle: string): TrimmedToolOutput {
  const { diff, added } = unifiedDiff(pathName, before, after);
  const diffShown = diff.length > TOOL_TRIM_THRESHOLD
    ? `${diff.slice(0, TOOL_TRIM_HEAD)}\n… omitted ${diff.length - TOOL_TRIM_HEAD - TOOL_TRIM_TAIL} characters of the diff.\n${diff.slice(-TOOL_TRIM_TAIL)}`
    : diff;
  const shownChars = added.filter((line) => diffShown.includes(line)).reduce((sum, line) => sum + line.length, 0);
  const omittedChars = Math.max(0, after.length - shownChars);
  return {
    display: `Changed ${pathName}.\n${diffShown}\nFull text: ${handle} (omitted ${omittedChars} characters).`,
    full: after,
    handle,
    omittedChars,
    path: pathName,
    store: true,
  };
}

function summarizeTest(text: string, handle: string): TrimmedToolOutput {
  const parsed = parseCommandPayload(text);
  const body = parsed ? [parsed.stdout, parsed.stderr].filter(Boolean).join("\n") : text;
  const counts = tapCounts(body);
  const blocks = tapFailures(body);
  let failureText = blocks.join("\n\n");
  if (failureText.length > FAILURE_CAP) {
    failureText = `${failureText.slice(0, 2_000)}\n… failure excerpt truncated.\n${failureText.slice(-1_500)}`;
  }
  for (const line of body.split("\n")) {
    if ((/^not ok\b/.test(line) || /[\w.@+-]+\/[\w.@+-]+\.[A-Za-z0-9]{1,8}/.test(line)) && !failureText.includes(line)) {
      failureText = failureText ? `${failureText}\n${line}` : line;
    }
  }
  if (!failureText && parsed && !parsed.ok) {
    failureText = [parsed.detail, parsed.stderr].filter(Boolean).join("\n").slice(0, 1_500);
  }
  const copied = failureText.split("\n").filter((line) => line && text.includes(line)).join("\n");
  const omittedChars = Math.max(0, text.length - copied.length);
  const summary = counts
    ? `Tests: ${counts.total} total, ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped.`
    : "Test log.";
  const display = [
    summary,
    failureText || "No failing tests in this log.",
    `Full log: ${handle} (omitted ${omittedChars} characters).`,
  ].join("\n");
  return { display, full: text, handle, omittedChars, store: true };
}

function shouldSummarizeTest(toolName: string, args: Record<string, unknown>, text: string): boolean {
  if (toolName === "workspace_test" || (toolName === "tool_call" && args.name === "workspace_test")) return true;
  const argv = shellArgv(toolName, args);
  if (argv.includes("--test")) return true;
  return argv.includes("test") && looksLikeTap(commandBody(text));
}

function headTail(text: string, handle: string, label: string): { display: string; omittedChars: number } {
  const omittedChars = text.length - TOOL_TRIM_HEAD - TOOL_TRIM_TAIL;
  const display = `${label}${text.slice(0, TOOL_TRIM_HEAD)}\n… omitted ${omittedChars} characters. Retrieve with tool_output_read handle ${handle}.\n${text.slice(-TOOL_TRIM_TAIL)}`;
  return { display, omittedChars };
}

function unifiedDiff(pathName: string, before: string, after: string): { diff: string; added: string[] } {
  const older = before.split("\n");
  const newer = after.split("\n");
  let start = 0;
  const maxStart = Math.min(older.length, newer.length);
  while (start < maxStart && older[start] === newer[start]) start += 1;
  let endOlder = older.length - 1;
  let endNewer = newer.length - 1;
  while (endOlder >= start && endNewer >= start && older[endOlder] === newer[endNewer]) {
    endOlder -= 1;
    endNewer -= 1;
  }
  const removed = older.slice(start, endOlder + 1);
  const added = newer.slice(start, endNewer + 1);
  const diff = [
    `--- ${pathName}`,
    `+++ ${pathName}`,
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
  return { diff, added };
}

function tapCounts(body: string): { total: number; passed: number; failed: number; skipped: number } | undefined {
  const tests = /^# tests (\d+)/m.exec(body);
  const pass = /^# pass (\d+)/m.exec(body);
  const fail = /^# fail (\d+)/m.exec(body);
  const skipped = /^# skipped (\d+)/m.exec(body);
  if (!tests && !pass && !fail) {
    const passed = body.split("\n").filter((line) => /^ok\b/.test(line)).length;
    const failed = body.split("\n").filter((line) => /^not ok\b/.test(line)).length;
    if (passed + failed === 0) return undefined;
    return { total: passed + failed, passed, failed, skipped: 0 };
  }
  const passed = pass ? Number(pass[1]) : 0;
  const failed = fail ? Number(fail[1]) : 0;
  return {
    total: tests ? Number(tests[1]) : passed + failed,
    passed,
    failed,
    skipped: skipped ? Number(skipped[1]) : 0,
  };
}

function tapFailures(body: string): string[] {
  const summary = /^# (?:tests|pass|fail|skipped|todo|duration_ms|duration)\b/;
  const blocks: string[] = [];
  let current: string[] | undefined;
  const flush = (): void => {
    if (current && current.length > 0) blocks.push(current.join("\n"));
    current = undefined;
  };
  for (const line of body.split("\n")) {
    if (/^not ok\b/.test(line)) {
      flush();
      current = [line];
      continue;
    }
    if (!current) continue;
    if (/^ok\b/.test(line) || summary.test(line) || line.startsWith("TAP version")) {
      flush();
      continue;
    }
    if (/^\s/.test(line) || line === "---" || line === "..." || line.startsWith("#") || line === "") {
      current.push(line);
      continue;
    }
    flush();
  }
  flush();
  return blocks;
}

function looksLikeTap(body: string): boolean {
  return /^(?:ok \d|not ok |TAP version |# tests )/m.test(body);
}

function commandBody(text: string): string {
  const parsed = parseCommandPayload(text);
  return parsed ? [parsed.stdout, parsed.stderr].filter(Boolean).join("\n") : text;
}

function parseCommandPayload(text: string): { stdout: string; stderr: string; detail: string; ok: boolean } | undefined {
  if (!text.trimStart().startsWith("{")) return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.stdout !== "string" && typeof value.stderr !== "string") return undefined;
    return {
      stdout: typeof value.stdout === "string" ? value.stdout : "",
      stderr: typeof value.stderr === "string" ? value.stderr : "",
      detail: typeof value.detail === "string" ? value.detail : "",
      ok: value.ok === true,
    };
  } catch {
    return undefined;
  }
}

function shellArgv(toolName: string, args: Record<string, unknown>): string[] {
  const raw = toolName === "workspace_shell"
    ? args.argv
    : toolName === "tool_call" && args.name === "workspace_shell"
      ? record(args.arguments).argv
      : undefined;
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function outputPath(dataDir: string, handle: string): string | undefined {
  const id = parseToolOutputHandle(handle);
  if (!id) return undefined;
  const root = path.resolve(dataDir, "tool-outputs");
  const target = path.join(root, id);
  return target.startsWith(`${root}${path.sep}`) ? target : undefined;
}

async function pageBody(dataDir: string, handle: string): Promise<string | undefined> {
  const target = outputPath(dataDir, handle);
  if (!target) return undefined;
  return readFile(target, "utf8").catch(() => undefined);
}
