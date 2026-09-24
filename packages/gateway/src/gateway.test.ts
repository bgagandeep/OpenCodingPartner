import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { CodingDispatch, CodingWorkerId, PolicyPrediction, PolicyState, QuestionSet, WorkerResult } from "@opencodingpartner/mesh";
import { MockLayaPolicyRouter, type PolicyRouter } from "@opencodingpartner/policy";
import { LocalSandboxWorker, type CodingWorker } from "@opencodingpartner/workers";

import { resolveBinding } from "./bindings.js";
import { BOARD_DEMO_FILE } from "./board-demo.js";
import { createFoundationMesh, runBoardDemo } from "./orchestrator.js";

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ocp-mesh-"));
}

test("binding resolves the Board CLI session", () => {
  const binding = resolveBinding("cli", "local");
  assert.equal(binding.agentId, "board");
  assert.equal(binding.sessionKey, "agent:board:main");
});

test("board demo writes one sandbox file after a status turn", async () => {
  const root = await sandbox();
  const mesh = createFoundationMesh({ sandboxRoot: root });
  const [status, write] = await runBoardDemo(mesh);

  assert.equal(status.ok, true);
  assert.equal(status.dispatched, false);
  assert.equal(status.prediction.answers.manager.choice, "conversation-manager");
  assert.equal(status.prediction.answers.worker.choice, "none");
  assert.equal(status.limits.ads, false);
  assert.equal(status.limits.payments, false);
  assert.equal(status.limits.speculativeSwarm, false);
  assert.equal(status.limits.maxWorkersPerTurn, 1);
  assert.equal(status.trace.some((event) => event.type === "worker.finished"), false);

  assert.equal(write.ok, true);
  assert.equal(write.dispatched, true);
  assert.equal(write.replayed, false);
  assert.deepEqual(write.filesChanged, [BOARD_DEMO_FILE.relativePath]);
  assert.equal(write.trace.filter((event) => event.type === "worker.finished").length, 1);
  assert.equal(await readFile(path.join(root, BOARD_DEMO_FILE.relativePath), "utf8"), BOARD_DEMO_FILE.contents);
  assert.deepEqual(await readdir(root), [BOARD_DEMO_FILE.relativePath]);

  const [statusAgain, writeAgain] = await runBoardDemo(mesh);
  assert.equal(statusAgain.replayed, true);
  assert.equal(writeAgain.replayed, true);
  assert.equal(await readFile(path.join(root, BOARD_DEMO_FILE.relativePath), "utf8"), BOARD_DEMO_FILE.contents);
});

test("decline, clarify, escape, and needs_human do not write", async () => {
  const root = await sandbox();
  const mesh = createFoundationMesh({ sandboxRoot: root });

  const declined = await mesh.handleTurn("add a checkout so users can pay", { idempotencyKey: "decline" });
  assert.equal(declined.disposition, "decline");
  assert.equal(declined.dispatched, false);

  const vague = await mesh.handleTurn("fix it", { idempotencyKey: "clarify" });
  assert.equal(vague.disposition, "clarify");
  assert.equal(vague.dispatched, false);

  const outsideName = `ocp-escape-${path.basename(root)}.txt`;
  const escape = await mesh.handleTurn(`create ../${outsideName} with content:\nnope\n`, {
    idempotencyKey: "escape",
  });
  assert.equal(escape.dispatched, false);
  assert.equal(escape.filesChanged.length, 0);
  await assert.rejects(readFile(path.join(path.dirname(root), outsideName), "utf8"));

  const blocked = createFoundationMesh({
    sandboxRoot: root,
    policy: new HighNeedsHumanPolicy(),
  });
  const held = await blocked.handleTurn("create notes/held.txt with content:\nheld\n", { idempotencyKey: "held" });
  assert.equal(held.disposition, "blocked");
  assert.equal(held.dispatched, false);
  assert.equal((await readdir(root)).length, 0);
});

test("cursor cloud selection fails closed without a transport", async () => {
  const root = await sandbox();
  const mesh = createFoundationMesh({ sandboxRoot: root });
  const turn = await mesh.handleTurn("Use Cursor Cloud to create NOTES.md with content:\nhello\n", {
    idempotencyKey: "cursor",
  });
  assert.equal(turn.ok, false);
  assert.equal(turn.dispatched, false);
  assert.match(turn.reply, /api\.cursor\.com/);
  assert.equal((await readdir(root)).length, 0);
});

test("one session lane runs a single worker at a time", async () => {
  const root = await sandbox();
  let active = 0;
  let maxActive = 0;
  const worker: CodingWorker = {
    id: "local-sandbox",
    async dispatch(input: CodingDispatch): Promise<WorkerResult> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => {
        setTimeout(resolve, 30);
      });
      active -= 1;
      return new LocalSandboxWorker().dispatch(input);
    },
  };
  const mesh = createFoundationMesh({
    sandboxRoot: root,
    workers: new Map<CodingWorkerId, CodingWorker>([["local-sandbox", worker]]),
  });
  const [first, second] = await Promise.all([
    mesh.handleTurn("create a.txt with content:\na\n", { idempotencyKey: "a" }),
    mesh.handleTurn("create b.txt with content:\nb\n", { idempotencyKey: "b" }),
  ]);
  assert.equal(maxActive, 1);
  assert.equal(first.ok && second.ok, true);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "a\n");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "b\n");
});

class HighNeedsHumanPolicy implements PolicyRouter {
  async predict(state: PolicyState, questions: QuestionSet): Promise<PolicyPrediction> {
    const prediction = await new MockLayaPolicyRouter().predict(state, questions);
    return {
      ...prediction,
      answers: {
        ...prediction.answers,
        needs_human: { type: "noul", noul: 0.99, rl_agent: { act_probability: 1 } },
      },
    };
  }
}
