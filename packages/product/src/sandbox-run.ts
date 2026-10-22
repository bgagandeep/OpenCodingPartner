import { spawn } from "node:child_process";
import path from "node:path";
import { commandDecision } from "@opencodingpartner/workers";

export interface SandboxCommandResult {
  ok: boolean;
  detail: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Approval-gated, argv-only command inside a workspace. No shell. */
export async function runWorkspaceCommand(
  workspaceRoot: string,
  argv: readonly string[],
  timeoutMs = 60_000,
): Promise<SandboxCommandResult> {
  const decision = commandDecision(argv);
  if (!decision.allow) {
    return { ok: false, detail: decision.reason, code: null, stdout: "", stderr: "" };
  }
  const cwd = path.resolve(workspaceRoot);
  return await new Promise((resolve) => {
    const child = spawn(argv[0] ?? "node", argv.slice(1), {
      cwd,
      env: { ...process.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 80_000) stdout = stdout.slice(-80_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        detail: `Could not start ${argv[0]}: ${error.message}`,
        code: 127,
        stdout,
        stderr,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0;
      resolve({
        ok,
        detail: ok ? `Command exited 0: ${argv.join(" ")}` : `Command exited ${code ?? "unknown"}: ${argv.join(" ")}`,
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

export async function runWorkspaceTests(workspaceRoot: string): Promise<SandboxCommandResult> {
  return runWorkspaceCommand(workspaceRoot, ["node", "--test"]);
}
