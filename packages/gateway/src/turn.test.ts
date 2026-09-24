import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEMO_MESSAGE, runChatTurn, runDemo } from "./index.js";

test("chat stands up agents, writes, checks QA, gates security, and records GTM", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-turn-"));
  try {
    const turn = await runChatTurn({ message: DEMO_MESSAGE, sandboxRoot: root });
    assert.equal(turn.session.key, "agent:board:main");
    assert.deepEqual(
      turn.agents.map((agent) => agent.role),
      ["coding", "qa", "security", "computer"],
    );
    assert.equal(turn.security?.allow, true);
    assert.equal(turn.coding?.wrote, true);
    assert.equal(turn.qa?.pass, true);
    assert.equal(turn.computer?.actions.every((action) => action.executed === false), true);
    const product = await readFile(path.join(root, "PRODUCT.md"), "utf8");
    assert.equal(product, "OpenCodingPartner helps a team build and sell.\n");
    const plan = JSON.parse(await readFile(path.join(root, "gtm", "action-plan.json"), "utf8")) as {
      actions: { executed: boolean; liveBrowser: boolean }[];
      note: string;
    };
    assert.match(plan.note, /No live browser ran/);
    assert.ok(plan.actions.every((action) => action.executed === false && action.liveBrowser === false));

    const blocked = await runChatTurn({
      message: "Stand up a security agent and a coding agent.\nUse Grok Build to create ../secret.txt with content:\npassword=hunter2\n",
      sandboxRoot: root,
    });
    assert.equal(blocked.security?.allow, false);
    assert.equal(blocked.coding?.wrote, false);
    await assert.rejects(access(path.join(root, "secret.txt")));

    await writeFile(path.join(root, "PRODUCT.md"), "changed\n");
    const replay = await runChatTurn({ message: DEMO_MESSAGE, sandboxRoot: root });
    assert.equal(replay.replayed, true);
    assert.equal(await readFile(path.join(root, "PRODUCT.md"), "utf8"), "changed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("demo command path writes the product file and blocks the secret", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-demo-"));
  try {
    const demo = await runDemo(root);
    assert.equal(demo.code, 0);
    assert.match(demo.transcript, /coding agent/);
    assert.match(demo.transcript, /QA agent/);
    assert.match(demo.transcript, /security agent/);
    assert.match(demo.transcript, /computer agent/);
    assert.match(demo.transcript, /executed: false/);
    assert.match(demo.transcript, /blocked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
