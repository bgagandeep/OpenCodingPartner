import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRole } from "@opencodingpartner/mesh";
import { OrchestrationSwarm } from "./index.js";

test("one turn can stand up coding, QA, security, and computer agents", () => {
  const swarm = new OrchestrationSwarm();
  const agents = swarm.standUp(["coding", "qa", "security", "computer"]);
  assert.equal(agents.length, 4);
  assert.deepEqual(
    agents.map((agent) => agent.role),
    ["coding", "qa", "security", "computer"],
  );
  assert.equal(swarm.dispatch("coding", (agent) => agent.runtime), "grok-build");
  assert.equal(swarm.dispatch("qa", (agent) => agent.runtime), "grok-build");
  assert.equal(swarm.dispatch("security", (agent) => agent.runtime), "policy-security");
  assert.equal(swarm.dispatch("computer", (agent) => agent.runtime), "computer-use");
  assert.equal(swarm.session.key, "agent:board:main");
});

test("the temporary cap rejects a ninth agent and is not a one-worker rule", () => {
  const swarm = new OrchestrationSwarm();
  const roles = Array.from({ length: 9 }, () => "coding" as AgentRole);
  assert.throws(() => swarm.standUp(roles), /Temporary early-test cap/);
  assert.equal(swarm.list().length, 0);
  const many = swarm.standUp(["coding", "coding", "qa", "security", "computer"]);
  assert.equal(many.length, 5);
});
