import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const docs = ["README.md", "ARCHITECTURE.md", "ROADMAP.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md", "NOTICE", "docs/legacy-sandbox.md", "docs/onboarding.md", "docs/parity-path.md"].map(read).join("\n");

test("product docs name the tools and keep ads and payments off", () => {
  assert.match(read("THIRD_PARTY_NOTICES.md"), /openclaw\/openclaw/);
  assert.match(docs, /MIT/);
  assert.match(read("THIRD_PARTY_NOTICES.md"), /xai-org\/grok-build/);
  assert.match(docs, /Apache-2\.0/);
  assert.match(read("THIRD_PARTY_NOTICES.md"), /convaiinnovations\/laya/);
  assert.match(docs, /System-1/);
  assert.match(read("README.md"), /OpenCodingPartner|Open Coding Partner/);
  assert.match(read("README.md"), /OCP Agent/);
  assert.match(read("README.md"), /OCP Coder/);
  assert.match(read("ARCHITECTURE.md"), /OCP Agent/);
  assert.match(read("ARCHITECTURE.md"), /OCP Coder/);
  assert.doesNotMatch(read("PARTNER.md"), /OpenClaw|Grok Build|LiteLLM|\bLaya\b|Claude Code|Hermes|Trinity/);
  for (const name of ["README.md", "ARCHITECTURE.md", "ROADMAP.md", "CONTRIBUTING.md", "PARTNER.md"]) {
    const page = read(name);
    assert.doesNotMatch(page, /Claude Code|Trinity/);
  }
  assert.match(read("NOTICE"), /Hermes Agent/);
  assert.match(read("README.md").split("## Credits")[1] ?? "", /Hermes Agent/);
  assert.match(docs, /chat agent/i);
  assert.match(docs, /orchestration agent swarm/i);
  assert.match(docs, /coding agent/);
  assert.match(docs, /QA agent/);
  assert.match(docs, /computer agent/);
  assert.match(docs, /security agent/);
  assert.match(docs, /Ads are off/);
  assert.match(docs, /Payments are off/);
  assert.match(docs, /temporary/i);
  assert.doesNotMatch(docs, /maxWorkersPerTurn/);
  assert.doesNotMatch(docs, /\bcursor\b/i);
  assert.doesNotMatch(docs, /CBRE/);
  assert.doesNotMatch(docs, /monument/i);
});

test("onboarding states the public limits in plain language", () => {
  const page = read("docs/onboarding.md");
  assert.match(page, /127\.0\.0\.1:4317/);
  assert.match(page, /no default model/i);
  assert.match(page, /No model configured/);
  assert.match(page, /Take Control/);
  assert.match(page, /loopback/i);
  assert.match(page, /\bDark\b/);
  assert.match(page, /five-field cron|five numeric fields/);
  assert.doesNotMatch(page, /OpenClaw|Hermes|Grok Build|LiteLLM|\bLaya\b|Grok Bot|\bxAI\b|CBRE|Claude Code|Trinity|\bcursor\b/i);
  assert.match(read("README.md"), /docs\/onboarding\.md/);
  assert.match(read("ROADMAP.md"), /1 November 2026/);
  assert.match(read("ROADMAP.md"), /19 December 2026/);
  assert.match(read("ROADMAP.md"), /Ads are off/);
  assert.match(read("ROADMAP.md"), /Payments are off/);
  const pathPage = read("docs/parity-path.md");
  assert.match(pathPage, /fully local/i);
  assert.match(pathPage, /bring your own/i);
  assert.match(pathPage, /OpenBot/);
  assert.match(pathPage, /computer per bot/i);
  assert.match(pathPage, /not yet|still false/i);
  assert.match(pathPage, /127\.0\.0\.1:11434/);
  assert.doesNotMatch(pathPage, /we are OpenBot|replica of|affiliated with/i);
  assert.doesNotMatch(pathPage, /OpenClaw|Hermes|Grok Build|LiteLLM|\bLaya\b|\bxAI\b|CBRE|Claude Code|Trinity|\bcursor\b/i);
  assert.match(read("README.md"), /docs\/parity-path\.md/);
  assert.match(read("ROADMAP.md"), /docs\/parity-path\.md/);
  assert.match(read("docs/onboarding.md"), /parity-path\.md/);
});

test("worker source does not spawn a process", () => {
  const files = walk(path.join(root, "packages/workers/src"));
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /node:child_process/);
  assert.doesNotMatch(source, /child_process/);
});
