import assert from "node:assert/strict";
import test from "node:test";
import { mockPredict, parseLayaAnswers, routeMessage, routeWithPredict } from "./index.js";

test("a build-and-sell message routes to all four agents", () => {
  const decision = routeMessage(
    "Stand up a coding agent, a QA agent, a security agent, and a computer agent. Sell the product.",
  );
  assert.equal(decision.route, "multi-agent");
  assert.deepEqual(decision.roles, ["coding", "qa", "security", "computer"]);
  const choice = decision.answers.find((answer) => answer.id === "route");
  assert.equal(choice?.type, "choice");
  if (choice?.type === "choice") {
    assert.equal(choice.choice, "multi-agent");
    assert.equal(choice.rl_agent, "mock-offline");
  }
});

test("a plain coding ask stands up the agents without a create-file template", () => {
  const decision = routeMessage("add a README section explaining install");
  assert.equal(decision.route, "multi-agent");
  assert.deepEqual(decision.roles, ["coding", "qa", "security", "computer"]);
});

test("a plain hello stays on the status route", () => {
  const decision = routeMessage("hello");
  assert.equal(decision.route, "status");
  assert.deepEqual(decision.roles, []);
});

test("a real Laya choice wins over the fallback router", async () => {
  const message = "add a README section explaining install";
  assert.equal(routeMessage(message).route, "multi-agent");
  const decision = await routeWithPredict(message, async () => ({
    answers: {
      route: { choice: "status", probabilities: { status: 0.97, "multi-agent": 0.03 }, confidence: 0.97, rl_agent: "laya" },
      stand_up_computer: { noul: 0.05 },
      write_risk: { score: 0.2, legend: "low" },
    },
    routing: { model: "english" },
  }));
  assert.equal(decision.route, "status");
  assert.deepEqual(decision.roles, []);
  assert.equal(decision.note, "System-1: real Laya.");
  const parsed = parseLayaAnswers({
    answers: { route: { choice: "multi-agent", confidence: 0.9 } },
  });
  assert.equal(parsed[0]?.type, "choice");
});

test("a failed Laya call says fallback", async () => {
  const decision = await routeWithPredict("add a function", async () => {
    throw new Error("laya missing");
  });
  assert.match(decision.note, /System-1: fallback/);
  assert.equal(decision.route, "multi-agent");
});

test("mock predict returns choice, noul, and score", () => {
  const answers = mockPredict("create a file", [
    { id: "c", type: "choice", text: "route", options: ["multi-agent", "status"] },
    { id: "n", type: "noul", text: "gtm" },
    { id: "s", type: "score", text: "risk" },
  ]);
  assert.deepEqual(
    answers.map((answer) => answer.type),
    ["choice", "noul", "score"],
  );
});
