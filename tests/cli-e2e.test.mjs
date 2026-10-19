import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const bin of ["ocp", "opencodingpartner"]) {
  test(`${bin} demo stands up the four agents`, () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), `ocp-${bin}-`));
    try {
      const result = spawnSync("corepack", ["pnpm", "exec", bin, "demo", "--sandbox", sandbox], {
        encoding: "utf8",
        cwd: root,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /coding agent/);
      assert.match(result.stdout, /QA agent/);
      assert.match(result.stdout, /security agent/);
      assert.match(result.stdout, /computer agent/);
      assert.match(result.stdout, /executed: false/);
      const product = readFileSync(path.join(sandbox, "PRODUCT.md"), "utf8");
      assert.equal(product, "OpenCodingPartner helps a team build and sell.\n");
      const plan = JSON.parse(readFileSync(path.join(sandbox, "gtm", "action-plan.json"), "utf8"));
      assert.equal(plan.actions.every((action) => action.executed === false), true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
}
