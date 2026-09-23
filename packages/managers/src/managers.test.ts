import assert from "node:assert/strict";
import test from "node:test";

import type { PolicyPrediction } from "@opencodingpartner/mesh";

import { DeterministicCodingManager } from "./coding-manager.js";
import { PlanRejectedError, parseManagerPlan } from "./parse.js";

const policy = {} as PolicyPrediction;

test("coding manager plans the named file and nothing else", () => {
  const plan = new DeterministicCodingManager().plan({
    message: "create notes/hello.txt with content:\nHello from the mesh.\n",
    sessionKey: "agent:board:main",
    policy,
  });
  assert.equal(plan.dispatch, true);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0]?.relativePath, "notes/hello.txt");
  assert.equal(plan.tasks[0]?.contents, "Hello from the mesh.\n");
});

test("coding manager refuses a path that leaves the sandbox", () => {
  const plan = new DeterministicCodingManager().plan({
    message: "create ../secret.txt with content:\nnope\n",
    sessionKey: "agent:board:main",
    policy,
  });
  assert.equal(plan.dispatch, false);
  assert.equal(plan.tasks.length, 0);
});

test("parseManagerPlan rejects a second task", () => {
  assert.throws(
    () =>
      parseManagerPlan({
        managerId: "coding-manager",
        goal: "two writes",
        reply: "no",
        dispatch: true,
        tasks: [
          { id: "a", kind: "write_file", relativePath: "a.txt", contents: "a", rationale: "a" },
          { id: "b", kind: "write_file", relativePath: "b.txt", contents: "b", rationale: "b" },
        ],
      }),
    PlanRejectedError,
  );
});
