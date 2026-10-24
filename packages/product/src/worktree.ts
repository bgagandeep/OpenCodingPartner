import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface TaskWorktree {
  taskId: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}

export interface WorktreeResult {
  ok: boolean;
  worktree?: TaskWorktree;
  error?: string;
}

function runGit(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("git", ["-C", cwd, ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 124, stdout, stderr: "timed out" });
    }, 20_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export async function isGitRepository(workspace: string): Promise<boolean> {
  const res = await runGit(workspace, ["rev-parse", "--is-inside-work-tree"]);
  return res.code === 0 && res.stdout === "true";
}

export function worktreesDir(workspace: string): string {
  return path.join(workspace, ".ocp", "worktrees");
}

export async function createTaskWorktree(workspace: string, taskId: string): Promise<WorktreeResult> {
  const isRepo = await isGitRepository(workspace);
  if (!isRepo) {
    return { ok: false, error: "Workspace is not a valid Git repository." };
  }

  // Get current HEAD commit
  const headRes = await runGit(workspace, ["rev-parse", "--verify", "HEAD"]);
  if (headRes.code !== 0) {
    return { ok: false, error: "Repository has no HEAD commit. Make at least one initial commit first." };
  }
  const baseCommit = headRes.stdout;

  const targetDir = path.join(worktreesDir(workspace), taskId);
  const branch = `ocp/task-${taskId}`;

  // Ensure .ocp/worktrees exists
  await mkdir(path.dirname(targetDir), { recursive: true });

  // Delete previous worktree or branch if lingering from an aborted run
  await runGit(workspace, ["worktree", "remove", "--force", targetDir]).catch(() => undefined);
  await runGit(workspace, ["branch", "-D", branch]).catch(() => undefined);

  // git worktree add -b <branch> <path> HEAD
  const addRes = await runGit(workspace, ["worktree", "add", "-b", branch, targetDir, "HEAD"]);
  if (addRes.code !== 0) {
    return { ok: false, error: addRes.stderr || "Failed to create Git worktree." };
  }

  return {
    ok: true,
    worktree: {
      taskId,
      worktreePath: targetDir,
      branch,
      baseCommit,
    },
  };
}

export async function discardTaskWorktree(workspace: string, taskId: string): Promise<{ ok: boolean; error?: string }> {
  const targetDir = path.join(worktreesDir(workspace), taskId);
  const branch = `ocp/task-${taskId}`;

  // Force remove the worktree
  const rmRes = await runGit(workspace, ["worktree", "remove", "--force", targetDir]);
  // Clean up directory if still exists
  await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
  // Delete the task branch
  const branchRes = await runGit(workspace, ["branch", "-D", branch]);

  if (rmRes.code !== 0 && branchRes.code !== 0) {
    // If neither succeeded and path doesn't exist, it was already discarded
    const exists = await stat(targetDir).catch(() => undefined);
    if (!exists) return { ok: true };
    return { ok: false, error: rmRes.stderr || branchRes.stderr };
  }

  return { ok: true };
}

export async function reconcileTaskWorktree(
  workspace: string,
  taskId: string,
  options: { message?: string } = {},
): Promise<{ ok: boolean; merged?: boolean; error?: string }> {
  const targetDir = path.join(worktreesDir(workspace), taskId);
  const branch = `ocp/task-${taskId}`;

  // Commit any uncommitted changes inside the worktree
  await runGit(targetDir, ["add", "-A"]);
  const commitMsg = options.message ?? `OCP Task ${taskId}: automated changes`;
  await runGit(targetDir, ["commit", "-m", commitMsg]);

  // Merge the branch into the main workspace
  const mergeRes = await runGit(workspace, ["merge", "--no-ff", "-m", `Merge ${branch}: ${commitMsg}`, branch]);
  if (mergeRes.code !== 0) {
    return { ok: false, error: `Merge conflict or failure: ${mergeRes.stderr || mergeRes.stdout}` };
  }

  // Cleanup the worktree and branch
  await discardTaskWorktree(workspace, taskId);

  return { ok: true, merged: true };
}

export async function listTaskWorktrees(workspace: string): Promise<Array<{ path: string; branch: string; commit: string }>> {
  const isRepo = await isGitRepository(workspace);
  if (!isRepo) return [];

  const res = await runGit(workspace, ["worktree", "list", "--porcelain"]);
  if (res.code !== 0) return [];

  const lines = res.stdout.split("\n");
  const worktrees: Array<{ path: string; branch: string; commit: string }> = [];
  let currentPath = "";
  let currentCommit = "";
  let currentBranch = "";

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      if (currentPath && currentPath.includes(path.join(".ocp", "worktrees"))) {
        worktrees.push({ path: currentPath, branch: currentBranch, commit: currentCommit });
      }
      currentPath = line.slice("worktree ".length).trim();
      currentCommit = "";
      currentBranch = "";
    } else if (line.startsWith("HEAD ")) {
      currentCommit = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length).trim();
    }
  }

  if (currentPath && currentPath.includes(path.join(".ocp", "worktrees"))) {
    worktrees.push({ path: currentPath, branch: currentBranch, commit: currentCommit });
  }

  return worktrees;
}
