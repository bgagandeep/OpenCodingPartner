import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const skip = new Set([".git", "node_modules", "dist", ".sandbox"]);

async function files(directory) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (skip.has(entry.name)) {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await files(full)));
      continue;
    }
    if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

test("source and docs stay free of forbidden product strings", async () => {
  const paths = await files(root);
  const hits = [];
  for (const file of paths) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) {
      continue;
    }
    const banned = ["cb", "re"].join("");
    if (new RegExp(`\\b${banned}\\b`, "i").test(text)) {
      hits.push(path.relative(root, file));
    }
  }
  assert.deepEqual(hits, []);
});

test("workers do not spawn processes", async () => {
  const directory = path.join(root, "packages", "workers", "src");
  const sources = await files(directory);
  for (const file of sources) {
    const text = await readFile(file, "utf8");
    assert.equal(text.includes("child_process"), false, path.relative(root, file));
  }
});

test("readme cites the real upstreams and the license", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  for (const needle of [
    "https://github.com/openclaw/openclaw",
    "https://github.com/xai-org/grok-build",
    "https://huggingface.co/convaiinnovations/laya",
    "Apache-2.0",
  ]) {
    assert.equal(readme.includes(needle), true, needle);
  }
  assert.equal(readme.includes("Cursor Cloud"), false);
  const architecture = await readFile(path.join(root, "ARCHITECTURE.md"), "utf8");
  assert.equal(architecture.includes("System-1"), true);
  assert.equal(architecture.includes("speculativeSwarm"), true);
  assert.equal(architecture.includes("Cursor Cloud"), false);
  assert.equal(/cursor\[/.test(architecture), false);
});
