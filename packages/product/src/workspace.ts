import { spawn } from "node:child_process";
import { securityGate } from "@opencodingpartner/workers";

const MAX_DIFF_CHARS = 100_000;
const MAX_CAPTURE_CHARS = 600_000;
const MAX_CHANGED_PATHS = 300;
const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx))$/i;
const CREDENTIAL_TEXT = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

export interface WorkspaceChangeEntry {
  path: string;
  status: string;
  alreadyModified: boolean;
}

export interface WorkspaceChangeReview {
  available: boolean;
  files: WorkspaceChangeEntry[];
  dirtyAtStart: boolean;
  attributionComplete: boolean;
  pathsTruncated: boolean;
  diffTruncated: boolean;
  diff?: string;
  diffOmittedReason?: string;
}

export interface WorkspaceBaseline {
  paths: Map<string, string>;
  hasHead: boolean;
}

export async function captureWorkspaceBaseline(workspace: string): Promise<WorkspaceBaseline | undefined> {
  const [status, head] = await Promise.all([
    runGit(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
    runGit(workspace, ["rev-parse", "--verify", "HEAD"]),
  ]);
  if (status.code !== 0) return undefined;
  return { paths: parseStatus(status.output), hasHead: head.code === 0 };
}

export async function collectWorkspaceChanges(workspace: string, baseline: WorkspaceBaseline | undefined): Promise<WorkspaceChangeReview> {
  if (!baseline) {
    return {
      available: false,
      files: [],
      dirtyAtStart: false,
      attributionComplete: false,
      pathsTruncated: false,
      diffTruncated: false,
      diffOmittedReason: "This workspace is not a readable Git worktree.",
    };
  }
  const status = await runGit(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (status.code !== 0) {
    return {
      available: false,
      files: [],
      dirtyAtStart: baseline.paths.size > 0,
      attributionComplete: false,
      pathsTruncated: false,
      diffTruncated: false,
      diffOmittedReason: "Git status could not be read after the task.",
    };
  }
  const finalPaths = parseStatus(status.output);
  const dirtyAtStart = baseline.paths.size > 0;
  const changed = new Map<string, { status: string; alreadyModified: boolean }>();
  for (const [file, fileStatus] of finalPaths) changed.set(file, { status: fileStatus, alreadyModified: baseline.paths.has(file) });
  for (const [file, fileStatus] of baseline.paths) {
    if (!finalPaths.has(file)) changed.set(file, { status: `${fileStatus} → clean`, alreadyModified: true });
  }
  const allFiles = [...changed.entries()].sort(([left], [right]) => left.localeCompare(right));
  const pathsTruncated = allFiles.length > MAX_CHANGED_PATHS;
  const files = allFiles.slice(0, MAX_CHANGED_PATHS).map(([file, value]) => ({
    path: SENSITIVE_PATH.test(file) ? "[sensitive path redacted]" : file,
    status: value.status,
    alreadyModified: value.alreadyModified,
  }));
  if (!baseline.hasHead) {
    return {
      available: true,
      files,
      dirtyAtStart,
      attributionComplete: !dirtyAtStart,
      pathsTruncated,
      diffTruncated: false,
      diffOmittedReason: "This repository has no commit yet, so Git cannot produce a workspace diff.",
    };
  }
  const diffResult = await runGit(workspace, ["diff", "--no-ext-diff", "--no-color", "--no-textconv", "HEAD", "--", "."]);
  if (diffResult.code !== 0) {
    return {
      available: true,
      files,
      dirtyAtStart,
      attributionComplete: false,
      pathsTruncated,
      diffTruncated: false,
      diffOmittedReason: "Git could not produce the workspace diff.",
    };
  }
  const diff = diffResult.output;
  const sensitivePathChanged = allFiles.some(([file]) => SENSITIVE_PATH.test(file));
  const sensitiveContent = CREDENTIAL_TEXT.some((pattern) => pattern.test(diff)) || allFiles.some(([file]) => securityGate({ relativePath: file, content: diff, sandboxRoot: workspace }).reasons.includes("secret pattern"));
  if (sensitivePathChanged || sensitiveContent) {
    return {
      available: true,
      files,
      dirtyAtStart,
      attributionComplete: !dirtyAtStart,
      pathsTruncated,
      diffTruncated: false,
      diffOmittedReason: "The diff was omitted because it contains a sensitive path or credential-like content.",
    };
  }
  const diffTruncated = diff.length > MAX_DIFF_CHARS;
  return {
    available: true,
    files,
    dirtyAtStart,
    attributionComplete: !dirtyAtStart,
    pathsTruncated,
    diffTruncated,
    diff: diffTruncated ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]\n` : diff,
    ...(allFiles.some(([, item]) => item.status.startsWith("??")) ? { diffOmittedReason: "Untracked file names are listed above; their contents are not included in the Git diff." } : {}),
  };
}

function parseStatus(output: string): Map<string, string> {
  const parts = output.split("\0");
  const result = new Map<string, string>();
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index] ?? "";
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const file = record.slice(3);
    result.set(file, status);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return result;
}

function runGit(cwd: string, args: readonly string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn("git", ["-C", cwd, ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    });
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(124);
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < MAX_CAPTURE_CHARS) output += chunk.slice(0, MAX_CAPTURE_CHARS - output.length);
      if (output.length >= MAX_CAPTURE_CHARS) child.kill();
    });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}
