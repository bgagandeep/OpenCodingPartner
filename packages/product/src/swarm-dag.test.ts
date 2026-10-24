import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBot, listTaskWorktrees } from "./index.js";

async function initGitRepo(dir: string): Promise<void> {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# Initial Project\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
}

test("swarm_parallel_dispatch and swarm_reconcile MCP tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-swarm-dag-"));
  const workspace = path.join(root, "project");
  const dataDir = path.join(root, "data");

  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await initGitRepo(workspace);

    // Create Coder and Reviewer bots
    const coder = await createBot({
      name: "Linus",
      role: "coding",
      runtime: "ocp-agent",
      workspace,
      instructions: "Implement features in workspace",
    }, dataDir);

    const reviewer = await createBot({
      name: "Grace",
      role: "qa",
      runtime: "ocp-agent",
      workspace,
      instructions: "Review changes",
    }, dataDir);

    // Start MCP server over stdio
    const script = path.resolve(fileURLToPath(new URL("workspace-mcp.js", import.meta.url)));
    const child = spawn(process.execPath, [script, workspace], {
      env: { ...process.env, OCP_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: child.stdout! });

    try {
      // 1. Dispatch parallel DAG tasks via MCP
      const dispatchCall = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "swarm_parallel_dispatch",
          arguments: {
            tasks: [
              { bot: coder.name, prompt: "Build feature A", reviewer: reviewer.name, useWorktree: true },
              { bot: coder.name, prompt: "Build feature B", useWorktree: true },
            ],
          },
        },
      };

      const gotDispatch = once(rl, "line");
      child.stdin!.write(`${JSON.stringify(dispatchCall)}\n`);
      const [dispatchLine] = await gotDispatch;
      const dispatchRes = JSON.parse(String(dispatchLine));

      assert.equal(dispatchRes.id, 1);
      const parsedContent = JSON.parse(dispatchRes.result.content[0].text);
      assert.equal(parsedContent.ok, true);
      assert.equal(parsedContent.dispatchedCount, 2);
      assert.equal(parsedContent.tasks.length, 2);

      const taskA = parsedContent.tasks[0];
      const taskB = parsedContent.tasks[1];
      assert.ok(taskA.worktreePath.includes(taskA.taskId));
      assert.ok(taskB.worktreePath.includes(taskB.taskId));

      // Verify worktrees are registered
      const activeWorktrees = await listTaskWorktrees(workspace);
      assert.equal(activeWorktrees.length, 2);

      // 2. Perform isolated edits in task A
      await writeFile(path.join(taskA.worktreePath, "feature_a.ts"), "export const a = 1;\n", "utf8");

      // 3. Reconcile and merge task A
      const mergeCall = {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "swarm_reconcile",
          arguments: {
            taskId: taskA.taskId,
            action: "merge",
            message: "Merge feature A",
          },
        },
      };

      const gotMerge = once(rl, "line");
      child.stdin!.write(`${JSON.stringify(mergeCall)}\n`);
      const [mergeLine] = await gotMerge;
      const mergeRes = JSON.parse(String(mergeLine));
      assert.equal(mergeRes.id, 2);
      assert.match(mergeRes.result.content[0].text, /successfully merged/);

      // Verify feature_a.ts now exists in main workspace
      const mainContent = await readFile(path.join(workspace, "feature_a.ts"), "utf8");
      assert.equal(mainContent, "export const a = 1;\n");

      // 4. Discard task B (rollback)
      const discardCall = {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "swarm_reconcile",
          arguments: {
            taskId: taskB.taskId,
            action: "discard",
          },
        },
      };

      const gotDiscard = once(rl, "line");
      child.stdin!.write(`${JSON.stringify(discardCall)}\n`);
      const [discardLine] = await gotDiscard;
      const discardRes = JSON.parse(String(discardLine));
      assert.equal(discardRes.id, 3);
      assert.match(discardRes.result.content[0].text, /successfully discarded/);

      // Verify all worktrees are cleanly removed
      const remainingWorktrees = await listTaskWorktrees(workspace);
      assert.equal(remainingWorktrees.length, 0);
    } finally {
      child.kill();
      rl.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
