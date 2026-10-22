import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens, formatPins, rollContext, takePins } from "./context.js";
import { recentTokenBudget } from "./provider-presets.js";
import { REPLAY_PINNED, REPLAY_RECENT_BUDGET, REPLAY_TURNS } from "./replay-transcript.js";

test("preset budgets keep a verbatim tail and do not claim a provider limit", () => {
  assert.equal(recentTokenBudget("openrouter", "https://openrouter.ai/api/v1"), 8_000);
  assert.equal(recentTokenBudget("custom", "http://127.0.0.1:11434/v1"), 4_096);
  assert.equal(recentTokenBudget("custom", "http://127.0.0.1:1234/v1"), 4_096);
  assert.equal(recentTokenBudget("custom", "http://127.0.0.1:8000/v1"), 8_192);
  assert.equal(recentTokenBudget("custom", "http://127.0.0.1:9/v1"), 4_096);
});

test("rolling context keeps the recent turn, pins, and faithful details on the fixed replay", async () => {
  const before = estimateTokens([formatPins(REPLAY_PINNED), ...REPLAY_TURNS.map((turn) => turn.content)].join("\n"));
  const rolled = await rollContext({
    turns: REPLAY_TURNS,
    budgetTokens: REPLAY_RECENT_BUDGET,
    pinned: REPLAY_PINNED,
    writeSummary: async () => "folded.",
  });
  const after = rolled.estimatedTokens;
  process.stdout.write(`REPLAY_BEFORE_ESTIMATED_TOKENS=${before}\nREPLAY_AFTER_ESTIMATED_TOKENS=${after}\n`);
  assert.equal(before, 775);
  assert.equal(after, 135);
  assert.ok(after < before);
  assert.equal(rolled.summarySource, "model");
  assert.equal(rolled.recent.map((turn) => turn.content).join("\n"), "Recent turn stays verbatim: check the draft reply.");
  assert.match(rolled.summary, /packages\/product\/src\/server\.ts/);
  assert.match(rolled.summary, /Error: workspace_patch failed in packages\/product\/src\/server\.ts: hunk did not match\./);
  assert.match(rolled.summary, /Decision: use workspace_patch on packages\/product\/src\/server\.ts instead of rewriting the file\./);
  assert.deepEqual(rolled.pinned, REPLAY_PINNED);
  assert.match(formatPins(rolled.pinned), /Keep pinned todos out of the summary/);
  assert.doesNotMatch(rolled.summary, /Keep pinned todos out of the summary/);
});

test("pin lines become structured notes and an extractive summary is labeled", async () => {
  const pinned = takePins("pin fact: loopback only\nplease continue\npin todo: show the draft");
  assert.deepEqual(pinned.pinned.facts, ["loopback only"]);
  assert.deepEqual(pinned.pinned.todos, ["show the draft"]);
  assert.equal(pinned.text, "please continue");
  const rolled = await rollContext({
    turns: [
      { role: "tool", content: "Error: failed reading packages/product/src/usage.ts" },
      { role: "user", content: "short" },
    ],
    budgetTokens: 2,
    pinned: pinned.pinned,
  });
  assert.equal(rolled.summarySource, "extractive");
  assert.match(rolled.summary, /Extractive summary \(no summary model configured\)/);
  assert.match(rolled.summary, /packages\/product\/src\/usage\.ts/);
  assert.match(rolled.summary, /Error: failed reading packages\/product\/src\/usage\.ts/);
  assert.deepEqual(rolled.pinned.todos, ["show the draft"]);
});
