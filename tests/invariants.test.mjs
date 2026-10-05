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

const docs = ["README.md", "ARCHITECTURE.md", "ROADMAP.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md", "NOTICE"].map(read).join("\n");

test("product docs name the tools and keep ads and payments off", () => {
  assert.match(read("THIRD_PARTY_NOTICES.md"), /openclaw\/openclaw/);
  assert.match(docs, /MIT/);
  assert.match(read("THIRD_PARTY_NOTICES.md"), /xai-org\/grok-build/);
  assert.match(docs, /Apache-2\.0/);
  assert.match(read("THIRD_PARTY_NOTICES.md"), /convaiinnovations\/laya/);
  assert.match(docs, /System-1/);
  assert.match(read("README.md"), /Open Coding Partner/);
  for (const name of ["ARCHITECTURE.md", "ROADMAP.md", "CONTRIBUTING.md", "PARTNER.md"]) {
    const page = read(name);
    assert.doesNotMatch(page, /OpenClaw|Grok Build|LiteLLM|\bLaya\b|Claude Code|Hermes|Trinity/);
  }
  const readmeBody = read("README.md").split("## Credits")[0];
  assert.doesNotMatch(readmeBody, /OpenClaw|Grok Build|LiteLLM|\bLaya\b|Claude Code|Hermes|Trinity/);
  assert.match(docs, /chat agent/);
  assert.match(docs, /orchestration agent swarm/);
  assert.match(docs, /coding agent/);
  assert.match(docs, /QA agent/);
  assert.match(docs, /computer agent/);
  assert.match(docs, /security agent/);
  assert.match(docs, /Ads are off/);
  assert.match(docs, /Payments are off/);
  assert.match(docs, /temporary/i);
  assert.match(docs, /multiple agents/);
  assert.doesNotMatch(docs, /maxWorkersPerTurn/);
  assert.doesNotMatch(docs, /\bcursor\b/i);
  assert.doesNotMatch(docs, /CBRE/);
  assert.doesNotMatch(docs, /monument/i);
});

test("worker source does not spawn a process", () => {
  const files = walk(path.join(root, "packages/workers/src"));
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /node:child_process/);
  assert.doesNotMatch(source, /child_process/);
});
