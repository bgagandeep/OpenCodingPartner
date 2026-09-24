import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { PolicyPrediction, PolicyState } from "@opencodingpartner/mesh";

import { classifyMessage } from "./classify.js";
import { evaluateRoute } from "./evaluate.js";
import { buildLayaPythonCommand } from "./laya-python.js";
import { MockLayaPolicyRouter } from "./mock-router.js";
import { MESH_ROUTE_QUESTIONS } from "./questions.js";
import { LayaCheckpointRouter } from "./router.js";

const state = (message: string): PolicyState => ({
  channel: "cli",
  accountId: "local",
  sessionKey: "agent:board:main",
  agentId: "board",
  message,
});

function probabilitySum(values: Readonly<Record<string, number>>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}

test("mock router returns a Laya-shaped payload and stays offline", async () => {
  const router = new MockLayaPolicyRouter();
  const prediction = await router.predict(
    state("create BOARD.md with content:\nready\n"),
    MESH_ROUTE_QUESTIONS,
  );
  assert.equal(prediction.routing.backend, "mock-heuristic");
  assert.equal(prediction.routing.model, "mock");
  assert.equal(prediction.routing.repo, null);
  assert.equal(prediction.usage.input_tokens, 0);
  assert.equal(prediction.usage.output_tokens, 0);
  assert.equal(prediction.answers.disposition.choice, "dispatch");
  assert.equal(prediction.answers.manager.choice, "coding-manager");
  assert.equal(prediction.answers.worker.choice, "local-sandbox");
  assert.ok(Math.abs(probabilitySum(prediction.answers.disposition.probabilities) - 1) < 1e-9);
  assert.equal(evaluateRoute(prediction).kind, "dispatch");
});

test("classifyMessage keeps payments, status, and vague text away from workers", () => {
  assert.equal(classifyMessage("add a checkout so users can pay").disposition, "decline");
  assert.equal(classifyMessage("Summarize the mesh status for Board review. Do not edit files.").worker, "none");
  assert.equal(classifyMessage("fix it").disposition, "clarify");
  assert.equal(
    classifyMessage("Use Cursor Cloud to create NOTES.md with content:\nhello\n").worker,
    "cursor-cloud",
  );
  assert.equal(classifyMessage("Use Grok Build to create NOTES.md with content:\nhello\n").worker, "grok-build");
});

test("evaluateRoute blocks a confident dispatch that still needs a human", () => {
  const prediction = {
    answers: {
      disposition: { type: "choice", choice: "dispatch", probabilities: { dispatch: 1 }, confidence: 0.9, rl_agent: { act_probability: 1 } },
      manager: { type: "choice", choice: "coding-manager", probabilities: { "coding-manager": 1 }, confidence: 0.9, rl_agent: { act_probability: 1 } },
      worker: { type: "choice", choice: "local-sandbox", probabilities: { "local-sandbox": 1 }, confidence: 0.9, rl_agent: { act_probability: 1 } },
      urgency: { type: "score", score: 1, legend: { "0": "low" }, probabilities: { "0": 1 }, confidence: 1, rl_agent: { act_probability: 1 } },
      needs_human: { type: "noul", noul: 0.99, rl_agent: { act_probability: 1 } },
    },
    routing: { backend: "laya", model: "english", repo: "convaiinnovations/laya", reason: "test" },
    usage: { input_tokens: 1, output_tokens: 0 },
  } satisfies PolicyPrediction;
  const decision = evaluateRoute(prediction);
  assert.equal(decision.kind, "blocked");
});

test("Laya bridge command points at the python call site and does not spawn", async () => {
  const command = buildLayaPythonCommand();
  assert.deepEqual(command.argv[0], "python3");
  const script = await readFile(command.scriptPath, "utf8");
  assert.match(script, /from laya import Router/);
  assert.match(script, /router\.predict\(state, questions, model=model\)/);
  assert.match(script, /convaiinnovations\/laya/);
});

test("LayaCheckpointRouter stamps the live backend", async () => {
  const router = new LayaCheckpointRouter({
    async predict(args) {
      assert.equal(args.model, "english");
      const mock = await new MockLayaPolicyRouter().predict(args.state, args.questions);
      return mock;
    },
  });
  const prediction = await router.predict(state("fix it"), MESH_ROUTE_QUESTIONS);
  assert.equal(prediction.routing.backend, "laya");
  assert.equal(prediction.answers.disposition.choice, "clarify");
});
