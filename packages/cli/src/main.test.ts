import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main } from "./main.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("ocp demo writes a file, blocks a secret, and records GTM actions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await main(["demo", "--sandbox", root]);
    assert.equal(code, 0);
    assert.match(captured, /Stood up:/);
    assert.match(captured, /coding agent/);
    assert.match(captured, /QA agent/);
    assert.match(captured, /security agent/);
    assert.match(captured, /computer agent/);
    assert.match(captured, /executed: false/);
    assert.match(captured, /No live browser ran/);
    const product = readFileSync(path.join(root, "PRODUCT.md"), "utf8");
    assert.equal(product, "OpenCodingPartner helps a team build and sell.\n");
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp doctor prints a status and does not print the meter key", async () => {
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const previous = process.env.LITELLM_API_KEY;
  process.env.LITELLM_API_KEY = "doctor-secret-value";
  try {
    const code = await main(["doctor"]);
    assert.ok(code === 0 || code === 1);
    assert.match(captured, /ocp doctor/);
    assert.match(captured, /Meter: LiteLLM/);
    assert.doesNotMatch(captured, /doctor-secret-value/);
  } finally {
    if (previous === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = previous;
    process.stdout.write = original;
  }
});

test("the cli file is the ocp entry when spawned", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-spawn-"));
  try {
    const script = path.join(repoRoot, "packages/cli/dist/main.js");
    const result = spawnSync(process.execPath, [script, "demo", "--sandbox", root], {
      encoding: "utf8",
      cwd: repoRoot,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Computer agent recorded a GTM plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
