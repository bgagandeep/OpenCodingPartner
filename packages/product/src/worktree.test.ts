import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTaskWorktree,
  discardTaskWorktree,
  isGitRepository,
  listTaskWorktrees,
  reconcileTaskWorktree,
} from "./worktree.js";

async function initGitRepo(dir: string): Promise<void> {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# Initial\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
}

test("worktree lifecycle: creation, isolation, and instant rollback", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "ocp-worktree-test-"));
  try {
    assert.equal(await isGitRepository(tmp), false);
    await initGitRepo(tmp);
    assert.equal(await isGitRepository(tmp), true);

    const taskId = "task-alpha-1";
    const res = await createTaskWorktree(tmp, taskId);
    assert.ok(res.ok);
    assert.ok(res.worktree);
    assert.equal(res.worktree.taskId, taskId);
    assert.ok(res.worktree.worktreePath.includes(taskId));

    const list = await listTaskWorktrees(tmp);
    assert.equal(list.length, 1);
    assert.ok(list[0]?.path.includes(taskId));

    // Modify a file in the worktree
    const worktreeFile = path.join(res.worktree.worktreePath, "feature.txt");
    await writeFile(worktreeFile, "new feature content\n", "utf8");

    // Ensure the main workspace does NOT have this file (ISOLATION)
    const mainFile = path.join(tmp, "feature.txt");
    await assert.rejects(() => readFile(mainFile, "utf8"));

    // Instant rollback (Time Machine)
    const discard = await discardTaskWorktree(tmp, taskId);
    assert.ok(discard.ok);

    const remaining = await listTaskWorktrees(tmp);
    assert.equal(remaining.length, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("worktree reconciliation: merging changes back into main workspace", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "ocp-worktree-merge-"));
  try {
    await initGitRepo(tmp);

    const taskId = "task-merge-1";
    const res = await createTaskWorktree(tmp, taskId);
    assert.ok(res.ok);
    assert.ok(res.worktree);

    // Add and commit work inside worktree
    const worktreeFile = path.join(res.worktree.worktreePath, "feature.txt");
    await writeFile(worktreeFile, "feature ready for merge\n", "utf8");

    // Reconcile and merge
    const rec = await reconcileTaskWorktree(tmp, taskId, { message: "Add feature.txt" });
    assert.ok(rec.ok);
    assert.equal(rec.merged, true);

    // Ensure file is now in main workspace
    const mainContent = await readFile(path.join(tmp, "feature.txt"), "utf8");
    assert.equal(mainContent, "feature ready for merge\n");

    // Worktree should be cleanly removed
    const list = await listTaskWorktrees(tmp);
    assert.equal(list.length, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("parallel multi-agent worktrees: simultaneous concurrent edits and DAG reconciliation", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "ocp-worktree-parallel-"));
  try {
    await initGitRepo(tmp);

    const taskA = "task-parallel-frontend";
    const taskB = "task-parallel-backend";

    // Concurrently create two worktrees off main HEAD
    const [resA, resB] = await Promise.all([
      createTaskWorktree(tmp, taskA),
      createTaskWorktree(tmp, taskB),
    ]);

    assert.ok(resA.ok && resA.worktree);
    assert.ok(resB.ok && resB.worktree);

    // List shows both worktrees running in parallel
    const active = await listTaskWorktrees(tmp);
    assert.equal(active.length, 2);

    // Bot A writes frontend in worktree A
    await writeFile(path.join(resA.worktree.worktreePath, "frontend.js"), "console.log('UI ready');\n", "utf8");
    // Bot B writes backend in worktree B
    await writeFile(path.join(resB.worktree.worktreePath, "backend.js"), "console.log('API ready');\n", "utf8");

    // Verify isolation: Bot A does not see backend.js, Bot B does not see frontend.js
    await assert.rejects(() => readFile(path.join(resA.worktree!.worktreePath, "backend.js"), "utf8"));
    await assert.rejects(() => readFile(path.join(resB.worktree!.worktreePath, "frontend.js"), "utf8"));

    // Reconciler merges Bot A
    const recA = await reconcileTaskWorktree(tmp, taskA, { message: "Add frontend component" });
    assert.ok(recA.ok && recA.merged);

    // Reconciler merges Bot B
    const recB = await reconcileTaskWorktree(tmp, taskB, { message: "Add backend endpoint" });
    assert.ok(recB.ok && recB.merged);

    // Both files now exist in main workspace!
    const mainFrontend = await readFile(path.join(tmp, "frontend.js"), "utf8");
    const mainBackend = await readFile(path.join(tmp, "backend.js"), "utf8");
    assert.equal(mainFrontend, "console.log('UI ready');\n");
    assert.equal(mainBackend, "console.log('API ready');\n");

    // All worktrees cleaned up
    const remaining = await listTaskWorktrees(tmp);
    assert.equal(remaining.length, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

