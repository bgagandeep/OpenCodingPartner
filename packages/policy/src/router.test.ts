import assert from "node:assert/strict";
import test from "node:test";
import { mockPredict, routeMessage } from "./index.js";

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

test("a plain hello stays on the status route", () => {
  const decision = routeMessage("hello");
  assert.equal(decision.route, "status");
  assert.deepEqual(decision.roles, []);
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
