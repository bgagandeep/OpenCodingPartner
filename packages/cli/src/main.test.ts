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

test("ocp settings shows advanced ACP off and does not name the backend", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-settings-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const previous = process.env.OCP_ACP;
  delete process.env.OCP_ACP;
  try {
    assert.equal(await main(["settings", "--sandbox", root]), 0);
    assert.match(captured, /Advanced ACP: off/);
    assert.match(captured, /Packaging: free OSS core/);
    assert.match(captured, /Billing: inert/);
    assert.match(captured, /Core: full/);
    assert.match(captured, /No charge is made/);
    assert.doesNotMatch(captured, /Hermes/);
  } finally {
    if (previous === undefined) delete process.env.OCP_ACP;
    else process.env.OCP_ACP = previous;
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp channel slack stays offline without credentials and posts when they are set", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-slack-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const token = process.env.SLACK_BOT_TOKEN;
  const signing = process.env.SLACK_SIGNING_SECRET;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_SIGNING_SECRET;
  const originalFetch = globalThis.fetch;
  try {
    const missing = await main(["channel", "slack", "--sandbox", root, "--text", "hello", "--channel", "dev"]);
    assert.equal(missing, 0);
    assert.match(captured, /Slack live: missing SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET/);
    assert.match(captured, /The offline turn still ran/);
    captured = "";
    process.env.SLACK_BOT_TOKEN = "xoxb-cli-secret";
    process.env.SLACK_SIGNING_SECRET = "signing-cli-secret";
    let bearer = "";
    let body = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as { authorization?: string } | undefined;
      bearer = headers?.authorization ?? "";
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const posted = await main(["channel", "slack", "--sandbox", root, "--text", "hello again", "--channel", "dev"]);
    assert.equal(posted, 0);
    assert.equal(bearer, "Bearer xoxb-cli-secret");
    assert.match(body, /"channel":"dev"/);
    assert.doesNotMatch(captured, /xoxb-cli-secret/);
    assert.doesNotMatch(captured, /signing-cli-secret/);
    assert.doesNotMatch(captured, /Slack live: missing/);
  } finally {
    globalThis.fetch = originalFetch;
    if (token === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = token;
    if (signing === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = signing;
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp computer qa prints pass or fail and does not open a page", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-computer-qa-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const missing = await main(["computer", "--sandbox", root, "qa"]);
    assert.equal(missing, 1);
    assert.match(captured, /Computer QA computer-frame: fail/);
    assert.match(captured, /frame file is missing/);
    assert.match(captured, /Live stream: not in this build/);
    captured = "";
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(root, "gtm"), { recursive: true });
    writeFileSync(path.join(root, "gtm", "last-frame.png"), Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const passed = await main(["computer", "--sandbox", root, "qa"]);
    assert.equal(passed, 0);
    assert.match(captured, /Computer QA computer-frame: pass/);
    assert.match(captured, /The frame is a PNG/);
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
