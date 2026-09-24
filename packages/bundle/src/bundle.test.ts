import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverStack } from "./discover.js";
import { installPlan } from "./install.js";
import { probeLiveStack } from "./live.js";
import { loadPins } from "./pins.js";

test("pins name the upstream packages and licenses", () => {
  const pins = loadPins();
  assert.equal(pins.openclaw.npm, "openclaw");
  assert.equal(pins.openclaw.version, "2026.9.6");
  assert.equal(pins.openclaw.license, "MIT");
  assert.equal(pins.grokBuild.npm, "@xai-official/grok");
  assert.equal(pins.grokBuild.license, "Apache-2.0");
  assert.equal(pins.laya.pypi, "laya");
  assert.equal(pins.laya.version, "0.3.13");
  const plan = installPlan("/work");
  assert.match(plan.join("\n"), /openclaw@2026\.9\.6/);
  assert.match(plan.join("\n"), /@xai-official\/grok@1\.0\.41/);
  assert.match(plan.join("\n"), /laya==0\.3\.13/);
});

test("a missing stack skips the connected demo", async () => {
  const probe = await probeLiveStack({});
  assert.equal(probe.skipped, true);
  assert.equal(probe.connected, false);
  assert.match(probe.transcript, /Connected demo skipped/);
  assert.match(probe.transcript, /pnpm bundle:install/);
});

test("fake OpenClaw and Grok Build binaries count as connected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-bundle-"));
  try {
    const openclaw = path.join(root, "openclaw");
    const grok = path.join(root, "grok");
    const laya = path.join(root, "python");
    await writeFile(openclaw, "#!/bin/sh\necho openclaw 2026.9.6\n");
    await writeFile(grok, "#!/bin/sh\necho grok 1.0.41\n");
    await writeFile(laya, "#!/bin/sh\necho 0.3.13\n");
    await chmod(openclaw, 0o755);
    await chmod(grok, 0o755);
    await chmod(laya, 0o755);
    const found = await discoverStack({
      env: { OCP_OPENCLAW_BIN: openclaw, OCP_GROK_BIN: grok, OCP_LAYA_PYTHON: laya },
      repoRoot: root,
    });
    const probe = await probeLiveStack(found);
    assert.equal(probe.skipped, false);
    assert.equal(probe.connected, true);
    assert.match(probe.transcript, /openclaw 2026\.9\.6/);
    assert.match(probe.transcript, /grok 1\.0\.41/);
    assert.match(probe.transcript, /streaming-json/);
    assert.match(probe.transcript, /did not send a model prompt/);
    await readFile(openclaw, "utf8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
