import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BOARD_DEMO_FILE } from "@opencodingpartner/gateway";

test("ocp demo writes BOARD.md through the mesh", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-cli-"));
  const main = fileURLToPath(new URL("./main.js", import.meta.url));
  const result = spawnSync(process.execPath, [main, "demo", "--sandbox", root], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /conversation-manager/);
  assert.match(result.stdout, /local-sandbox/);
  assert.match(result.stdout, /mock-heuristic/);
  assert.equal(await readFile(path.join(root, BOARD_DEMO_FILE.relativePath), "utf8"), BOARD_DEMO_FILE.contents);
});
