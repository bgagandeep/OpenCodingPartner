import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_ROLES,
  PRODUCT_FLAGS,
  TEMPORARY_EARLY_TEST_AGENT_CAP,
  boardSession,
} from "./index.js";

test("product stands up four agent roles and the early cap is not one", () => {
  assert.deepEqual([...AGENT_ROLES], ["coding", "qa", "security", "computer"]);
  assert.ok(TEMPORARY_EARLY_TEST_AGENT_CAP > 1);
  assert.equal(TEMPORARY_EARLY_TEST_AGENT_CAP, 8);
  assert.equal(PRODUCT_FLAGS.ads, false);
  assert.equal(PRODUCT_FLAGS.payments, false);
});

test("board session follows the OpenClaw key shape", () => {
  const session = boardSession();
  assert.equal(session.key, "agent:board:main");
  assert.deepEqual(session.binding, {
    channel: "cli",
    accountId: "local",
    agentId: "board",
  });
});
