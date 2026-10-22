import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatPins, rollContext } from "./context.js";
import { layoutCachedPrompt, replayCacheTokens } from "./prompt-cache.js";
import { REPLAY_PINNED, REPLAY_RECENT_BUDGET, REPLAY_TURNS } from "./replay-transcript.js";
import { measureUsage, noteModelUsage, usageSnapshot } from "./usage.js";

const SYSTEM = "You are OCP Agent. Use the workspace tools.";
const TOOL_INDEX = "tool_search\ntool_describe\ntool_call\nworkspace_read\nworkspace_patch";

test("the fixed replay puts a stable prefix first and records cached versus uncached tokens", async () => {
  const rolled = await rollContext({
    turns: REPLAY_TURNS,
    budgetTokens: REPLAY_RECENT_BUDGET,
    pinned: REPLAY_PINNED,
    writeSummary: async () => "folded.",
  });
  const counts = replayCacheTokens({
    system: SYSTEM,
    toolIndex: TOOL_INDEX,
    pinned: formatPins(REPLAY_PINNED),
    summary: rolled.summary,
    recent: rolled.recent,
    model: "anthropic/claude-sonnet-4",
  });
  process.stdout.write(`REPLAY_CACHE_BEFORE_ESTIMATED_TOKENS=${counts.beforeEstimated}\nREPLAY_CACHE_STABLE_ESTIMATED_TOKENS=${counts.stableEstimated}\nREPLAY_CACHE_VOLATILE_ESTIMATED_TOKENS=${counts.volatileEstimated}\n`);
  assert.equal(counts.beforeEstimated, 163);
  assert.equal(counts.stableEstimated, 72);
  assert.equal(counts.volatileEstimated, 105);
  const anthropic = layoutCachedPrompt({
    system: SYSTEM,
    toolIndex: TOOL_INDEX,
    pinned: formatPins(REPLAY_PINNED),
    summary: rolled.summary,
    recent: rolled.recent,
    model: "anthropic/claude-sonnet-4",
  });
  assert.equal(anthropic.cache.provider, "anthropic");
  assert.equal(anthropic.cache.mode, "explicit");
  const marker = anthropic.messages.find((message) => Array.isArray(message.content));
  assert.ok(marker);
  assert.deepEqual(Array.isArray(marker?.content) ? marker.content[0]?.cache_control : undefined, { type: "ephemeral" });
  const recent = anthropic.messages.at(-1);
  assert.equal(recent?.content, "Recent turn stays verbatim: check the draft reply.");
  assert.equal(Array.isArray(recent?.content), false);
  assert.ok(anthropic.messages.findIndex((message) => message.content === recent?.content) > anthropic.messages.findIndex((message) => Array.isArray(message.content)));

  const openai = layoutCachedPrompt({
    system: SYSTEM,
    toolIndex: TOOL_INDEX,
    pinned: formatPins(rolled.pinned),
    summary: "",
    recent: [{ role: "user", content: "hello" }],
    model: "openai/gpt-4.1",
  });
  assert.equal(openai.cache.mode, "automatic");
  assert.equal(openai.messages.every((message) => typeof message.content === "string"), true);
  assert.equal(openai.messages.at(-1)?.content, "hello");
  assert.equal(promptName("deepseek-chat"), "deepseek");
  assert.equal(promptName("gemini-2.5-flash"), "gemini");

  const deepseek = measureUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 80 }, "", "");
  assert.equal(deepseek.estimated, false);
  assert.equal(deepseek.cachedPromptTokens, 80);
  assert.equal(deepseek.promptTokens - (deepseek.cachedPromptTokens ?? 0), 20);
  const gemini = measureUsage({
    prompt_tokens: 50,
    completion_tokens: 5,
    usage_metadata: { cached_content_token_count: 30 },
  }, "", "");
  assert.equal(gemini.cachedPromptTokens, 30);

  const root = await mkdtemp(path.join(tmpdir(), "ocp-cache-"));
  try {
    await noteModelUsage(root, {
      botId: "ada",
      model: "openai/gpt-4.1",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } },
      promptText: "",
      completionText: "",
    });
    const snapshot = await usageSnapshot(root);
    assert.equal(snapshot.byBot[0]?.cachedPromptTokens, 80);
    assert.equal(snapshot.byBot[0]?.promptTokens - snapshot.byBot[0]!.cachedPromptTokens, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function promptName(model: string): string {
  return layoutCachedPrompt({
    system: "system",
    toolIndex: "",
    pinned: "",
    summary: "",
    recent: [],
    model,
  }).cache.provider;
}
