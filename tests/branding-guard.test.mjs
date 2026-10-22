import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("branding guard rejects CBRE and keeps upstream names out of CLI/UI copy", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/branding-guard.mjs")], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, OCP_BRANDING_STRICT: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /branding-guard ok \(strict\)/);
});

test("lint script reports clean whitespace on the tree", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/lint.mjs")], {
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /lint ok/);
});
