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
    assert.match(captured, /Meter: proxy/);
    assert.doesNotMatch(captured, /doctor-secret-value/);
  } finally {
    if (previous === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = previous;
    process.stdout.write = original;
  }
});

test("ocp prove coding passes with a scripted runner and does not print a key", async () => {
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const previous = process.env.LITELLM_API_KEY;
  process.env.LITELLM_API_KEY = "prove-secret-value";
  try {
    const code = await main(["prove", "coding"]);
    assert.equal(code, 0);
    assert.match(captured, /Passed\./);
    assert.match(captured, /Tool: mkdir src/);
    assert.match(captured, /Tool: glob src\/\*\*\/\*\.mjs/);
    assert.match(captured, /Tool: patch src\/math\.mjs/);
    assert.match(captured, /Tool: copy src\/math\.mjs → src\/math\.copy\.mjs/);
    assert.match(captured, /Copy path: local sandbox/);
    assert.doesNotMatch(captured, /Copy path: OpenClaw-driven/);
    assert.match(captured, /Tool: run node --test src\/math\.test\.mjs \(exit 0\)/);
    assert.match(captured, /Mkdir path: local sandbox/);
    assert.match(captured, /Meter: scripted/);
    assert.doesNotMatch(captured, /prove-secret-value/);
    assert.doesNotMatch(captured, /Meter: Grok Build/);
  } finally {
    if (previous === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = previous;
    process.stdout.write = original;
  }
});

test("ocp prove computer passes with a fake browser and does not print a key", async () => {
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const previous = process.env.LITELLM_API_KEY;
  process.env.LITELLM_API_KEY = "prove-computer-secret";
  try {
    const code = await main(["prove", "computer"]);
    assert.equal(code, 0);
    assert.match(captured, /Passed\./);
    assert.match(captured, /scroll/);
    assert.match(captured, /press Enter/);
    assert.match(captured, /hover #buy/);
    assert.match(captured, /double-click #buy/);
    assert.match(captured, /right-click #buy/);
    assert.match(captured, /fill #email/);
    assert.match(captured, /select #plan/);
    assert.match(captured, /check #agree/);
    assert.match(captured, /executed: true/);
    assert.match(captured, /not a full go-to-market run/);
    assert.match(captured, /Orchestration did not run the browser/);
    assert.doesNotMatch(captured, /OpenClaw ran the browser/);
    assert.doesNotMatch(captured, /prove-computer-secret/);
  } finally {
    if (previous === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = previous;
    process.stdout.write = original;
  }
});

test("ocp computer shows the sandbox tab and takeover", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-computer-tab-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await main(["computer", "--sandbox", root]), 0);
    assert.match(captured, /Computer tab/);
    assert.match(captured, /Desktop: sandbox/);
    assert.match(captured, /Control: partner/);
    assert.match(captured, /Last frame: none/);
    assert.match(captured, /Live stream: not in this build/);
    captured = "";
    assert.equal(await main(["computer", "--sandbox", root, "takeover"]), 0);
    assert.match(captured, /Control: human/);
    captured = "";
    assert.equal(await main(["computer", "--sandbox", root, "return"]), 0);
    assert.match(captured, /Control: partner/);
    captured = "";
    assert.equal(await main(["computer", "--sandbox", root, "--partner", "coding"]), 0);
    assert.match(captured, /Partner: coding/);
    assert.match(captured, /Desktop: partner sandbox/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
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
