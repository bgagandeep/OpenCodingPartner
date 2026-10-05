import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { slackSignature } from "@opencodingpartner/gateway";
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

test("ocp doctor --sandbox checks that sandbox frame, fleet, and approvals", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-doctor-sandbox-"));
  const other = mkdtempSync(path.join(tmpdir(), "ocp-doctor-other-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(root, "gtm"), { recursive: true });
    writeFileSync(path.join(root, "gtm", "last-frame.png"), Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    mkdirSync(path.join(root, ".ocp/fleet/coding/.ocp"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), `${JSON.stringify({ id: "coding", role: "coding" })}\n`);
    writeFileSync(
      path.join(root, ".ocp/approvals.json"),
      `${JSON.stringify({ cards: [{ id: "plan-1", kind: "plan", title: "Edit", detail: "password=hunter2", status: "pending" }] })}\n`,
    );
    const code = await main(["doctor", "--sandbox", root]);
    assert.ok(code === 0 || code === 1);
    assert.match(captured, /green Computer frame: a PNG is at gtm\/last-frame.png/);
    assert.match(captured, /This check does not start the browser/);
    assert.match(captured, /green Fleet: coding not started/);
    assert.match(captured, /yellow Approvals: 1 pending/);
    assert.match(captured, /does not decide a card/);
    mkdirSync(path.join(root, ".ocp/fleet/coding/.ocp/sdlc"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/.ocp/sdlc/review-hold"), "node --test exit 1 password=hunter2\n");
    captured = "";
    const held = await main(["doctor", "--sandbox", root]);
    assert.ok(held === 0 || held === 1);
    assert.match(captured, /yellow Review hold: 1/);
    assert.match(captured, /does not accept the plan/);
    assert.doesNotMatch(captured, /password=hunter2/);
    assert.match(captured, /Docker:/);
    assert.match(captured, /This check does not start containers/);
    assert.doesNotMatch(captured, /password=hunter2/);
    captured = "";
    const empty = await main(["doctor", "--sandbox", other]);
    assert.match(captured, /yellow Computer frame: none at gtm\/last-frame.png/);
    assert.match(captured, /yellow Fleet: no partners/);
    assert.match(captured, /green Approvals: none pending/);
    assert.equal(empty === 0 || empty === 1, true);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
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

test("ocp approve list shows a pending card and does not decide it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-approve-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const empty = await main(["approve", "list", "--sandbox", root]);
    assert.equal(empty, 0);
    assert.match(captured, /Approvals: none pending/);
    assert.match(captured, /Review hold: none/);
    const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    mkdirSync(path.join(root, ".ocp/sdlc"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/sdlc/review-hold"), "node --test exit 1\n");
    captured = "";
    const held = await main(["approve", "list", "--sandbox", root]);
    assert.equal(held, 0);
    assert.match(captured, /Review hold/);
    assert.match(captured, /session \. node --test exit 1/);
    assert.match(captured, /does not accept the plan/);
    assert.equal(readFileSync(path.join(root, ".ocp/sdlc/review-hold"), "utf8"), "node --test exit 1\n");
    captured = "";
    mkdirSync(path.join(root, ".ocp"), { recursive: true });
    const queue = `${JSON.stringify({ cards: [{ id: "plan-1", kind: "plan", title: "Edit after this plan", detail: "add a helper", status: "pending" }] })}\n`;
    writeFileSync(path.join(root, ".ocp", "approvals.json"), queue);
    const listed = await main(["approve", "list", "--sandbox", root, "--json"]);
    assert.equal(listed, 0);
    const body = JSON.parse(captured) as { id: string; status: string }[];
    assert.equal(body[0]?.id, "plan-1");
    assert.equal(body[0]?.status, "pending");
    assert.equal(readFileSync(path.join(root, ".ocp", "approvals.json"), "utf8"), queue);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp fleet status lists a partner and can print json", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-fleet-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const empty = await main(["fleet", "status", "--sandbox", root]);
    assert.equal(empty, 0);
    assert.match(captured, /Fleet: no partners/);
    assert.match(captured, /No telemetry is sent/);
    captured = "";
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(root, ".ocp/fleet/coding/.ocp"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), `${JSON.stringify({ id: "coding", role: "coding", desktop: "partner-sandbox" })}\n`);
    writeFileSync(path.join(root, ".ocp/fleet/coding/.ocp/container.json"), `${JSON.stringify({ state: "stopped", name: "ocp-coding" })}\n`);
    const listed = await main(["fleet", "status", "--sandbox", root]);
    assert.equal(listed, 0);
    assert.match(captured, /coding workspace \.ocp\/fleet\/coding container stopped frame none/);
    captured = "";
    const jsonCode = await main(["fleet", "status", "--sandbox", root, "--json"]);
    assert.equal(jsonCode, 0);
    const body = JSON.parse(captured) as { id: string; container: string; frame: string }[];
    assert.equal(body[0]?.id, "coding");
    assert.equal(body[0]?.container, "stopped");
    assert.equal(body[0]?.frame, "none");
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp channel telegram stays offline without credentials and posts when they are set", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-telegram-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  const originalFetch = globalThis.fetch;
  try {
    const missing = await main(["channel", "telegram", "--sandbox", root, "--text", "hello", "--channel", "42"]);
    assert.equal(missing, 0);
    assert.match(captured, /Telegram live: missing TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET/);
    assert.match(captured, /The offline turn still ran/);
    assert.match(captured, /Telegram adapter/);
    captured = "";
    process.env.TELEGRAM_BOT_TOKEN = "123:telegram-cli-secret";
    process.env.TELEGRAM_WEBHOOK_SECRET = "webhook-cli-secret";
    let body = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const posted = await main(["channel", "telegram", "--sandbox", root, "--text", "hello again", "--channel", "42"]);
    assert.equal(posted, 0);
    assert.match(body, /"chat_id":"42"/);
    assert.match(captured, /Telegram adapter/);
    assert.doesNotMatch(captured, /telegram-cli-secret/);
    assert.doesNotMatch(captured, /webhook-cli-secret/);
    assert.doesNotMatch(captured, /Telegram live: missing/);
  } finally {
    globalThis.fetch = originalFetch;
    if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = token;
    if (secret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
    else process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp channel slack receive rejects a bad signature and accepts a signed event", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-slack-receive-"));
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
  const { writeFileSync } = await import("node:fs");
  const bodyPath = path.join(root, "event.json");
  const raw = JSON.stringify({ type: "event_callback", event: { text: "hello", channel: "dev", ts: "1.2" } });
  writeFileSync(bodyPath, raw);
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  try {
    const missing = await main(["channel", "slack", "receive", "--sandbox", root, "--body", bodyPath, "--timestamp", timestamp, "--signature", "v0=nope"]);
    assert.equal(missing, 1);
    assert.match(captured, /Slack live: missing SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET/);
    assert.match(captured, /The update was not accepted/);
    assert.doesNotMatch(captured, /Chat agent/);
    captured = "";
    process.env.SLACK_BOT_TOKEN = "xoxb-receive-secret";
    process.env.SLACK_SIGNING_SECRET = "signing-receive-secret";
    const rejected = await main(["channel", "slack", "receive", "--sandbox", root, "--body", bodyPath, "--timestamp", timestamp, "--signature", "v0=nope"]);
    assert.equal(rejected, 1);
    assert.match(captured, /bad signature/);
    assert.match(captured, /The update was not accepted/);
    assert.doesNotMatch(captured, /Chat agent/);
    assert.doesNotMatch(captured, /signing-receive-secret/);
    captured = "";
    const signature = slackSignature("signing-receive-secret", timestamp, raw);
    let posted = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      posted = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const accepted = await main(["channel", "slack", "receive", "--sandbox", root, "--body", bodyPath, "--timestamp", timestamp, "--signature", signature]);
    assert.equal(accepted, 0);
    assert.match(captured, /Chat agent/);
    assert.match(posted, /"channel":"dev"/);
    assert.doesNotMatch(captured, /xoxb-receive-secret/);
    assert.doesNotMatch(captured, /signing-receive-secret/);
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

test("ocp computer qa fails a bad partner frame without opening a browser", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-fleet-frame-qa-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(root, "gtm"), { recursive: true });
    writeFileSync(path.join(root, "gtm", "last-frame.png"), Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    mkdirSync(path.join(root, ".ocp/fleet/coding/.ocp"), { recursive: true });
    mkdirSync(path.join(root, ".ocp/fleet/coding/gtm"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), `${JSON.stringify({ id: "coding", role: "coding", desktop: "partner-sandbox" })}\n`);
    writeFileSync(path.join(root, ".ocp/fleet/coding/gtm/last-frame.png"), Buffer.from("not-a-png"));
    const code = await main(["computer", "--sandbox", root, "qa"]);
    assert.equal(code, 1);
    assert.match(captured, /Last frame: gtm\/last-frame.png/);
    assert.match(captured, /Computer QA computer-frame: pass/);
    assert.match(captured, /not a PNG \(\.ocp\/fleet\/coding\/gtm\/last-frame.png\)/);
    assert.doesNotMatch(captured, /Browser is missing/);
  } finally {
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
    assert.match(captured, /Last frame: gtm\/last-frame.png/);
    assert.doesNotMatch(captured, /\.ocp\/fleet\//);
    captured = "";
    const { mkdirSync: mkdirPartner, writeFileSync: writePartner } = await import("node:fs");
    mkdirPartner(path.join(root, ".ocp/fleet/coding/gtm"), { recursive: true });
    writePartner(path.join(root, ".ocp/fleet/coding/gtm/last-frame.png"), Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const partner = await main(["computer", "--sandbox", root, "--partner", "coding", "qa"]);
    assert.equal(partner, 0);
    assert.match(captured, /Computer QA computer-frame: pass/);
    assert.match(captured, /Last frame: \.ocp\/fleet\/coding\/gtm\/last-frame.png/);
    assert.doesNotMatch(captured, /Last frame: gtm\/last-frame.png/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a partner orchestration write lands in the partner workspace", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-partner-write-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const previous = process.env.OPENCLAW_GATEWAY_URL;
  const server = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(chunks.length === 0 ? "{}" : Buffer.concat(chunks).toString("utf8")) as {
      tool?: string;
      args?: { bridgeUrl?: string; relativePath?: string; content?: string };
    };
    if (body.tool === "ocp_sandbox_write" && body.args?.bridgeUrl) {
      const forwarded = await fetch(body.args.bridgeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relativePath: body.args.relativePath, content: body.args.content }),
      });
      res.writeHead(forwarded.status, { "content-type": "application/json" });
      res.end(await forwarded.text());
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  process.env.OPENCLAW_GATEWAY_URL = `http://127.0.0.1:${port}`;
  try {
    const code = await main([
      "chat",
      "--sandbox",
      root,
      "--partner",
      "coding",
      "Use the coding worker to create hello.txt with content:\nfrom partner\n",
    ]);
    assert.equal(code, 0);
    assert.equal(readFileSync(path.join(root, ".ocp/fleet/coding/hello.txt"), "utf8"), "from partner\n");
    assert.throws(() => readFileSync(path.join(root, "hello.txt"), "utf8"));
    assert.match(captured, /Write path: orchestration/);
    assert.doesNotMatch(captured, /did not land the file/);
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = previous;
    process.stdout.write = original;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
