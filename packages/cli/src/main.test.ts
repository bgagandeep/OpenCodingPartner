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
    assert.doesNotMatch(captured, /partner frame/);
    mkdirSync(path.join(root, ".ocp/fleet/coding/gtm"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/gtm/last-frame.png"), Buffer.from("not-a-png"));
    captured = "";
    const framed = await main(["doctor", "--sandbox", root]);
    assert.ok(framed === 0 || framed === 1);
    assert.match(captured, /yellow Computer frame:/);
    assert.match(captured, /\.ocp\/fleet\/coding\/gtm\/last-frame.png is not a PNG/);
    assert.match(captured, /This check does not start the browser/);
    assert.doesNotMatch(captured, /Browser is missing/);
    assert.match(captured, /green Fleet: coding not started/);
    assert.match(captured, /yellow Approvals: 1 pending/);
    assert.match(captured, /does not decide a card/);
    assert.match(captured, /yellow Partner agreement: PARTNER.md is missing/);
    assert.match(captured, /does not copy the file/);
    mkdirSync(path.join(root, ".ocp/fleet/coding/.ocp/sdlc"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/.ocp/sdlc/review-hold"), "node --test exit 1 password=hunter2\n");
    captured = "";
    const held = await main(["doctor", "--sandbox", root]);
    assert.ok(held === 0 || held === 1);
    assert.match(captured, /yellow Review hold: 1/);
    assert.match(captured, /does not accept the plan/);
    assert.doesNotMatch(captured, /password=hunter2/);
    writeFileSync(path.join(root, "PARTNER.md"), "partner\n");
    writeFileSync(path.join(root, "PARTNER.rules"), "block: password=hunter2\n");
    writeFileSync(path.join(root, ".ocp/fleet/coding/PARTNER.md"), "partner\n");
    captured = "";
    const agreed = await main(["doctor", "--sandbox", root]);
    assert.ok(agreed === 0 || agreed === 1);
    assert.match(captured, /green Partner agreement: present/);
    assert.match(captured, /1 block rule/);
    assert.doesNotMatch(captured, /password=hunter2/);
    assert.match(captured, /Docker:/);
    assert.match(captured, /This check does not start containers/);
    assert.doesNotMatch(captured, /password=hunter2/);
    captured = "";
    const empty = await main(["doctor", "--sandbox", other]);
    assert.match(captured, /yellow Computer frame: none at gtm\/last-frame.png/);
    assert.match(captured, /yellow Computer run: none/);
    assert.match(captured, /green Computer control: partner/);
    assert.match(captured, /green Shared mount: no partners/);
    assert.match(captured, /does not take or return the browser/);
    assert.match(captured, /does not open a page/);
    assert.match(captured, /yellow Fleet: no partners/);
    assert.match(captured, /green Approvals: none pending/);
    assert.match(captured, /yellow Partner agreement: PARTNER.md is missing/);
    assert.match(captured, /green Todos: none open/);
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

test("ocp approve accept deny and redirect run the chat turn", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-approve-decide-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { writeFileSync, readFileSync } = await import("node:fs");
    writeFileSync(path.join(root, "PARTNER.md"), "partner\n");
    assert.equal(await main(["chat", "--sandbox", root, "add a helper"]), 0);
    assert.match(captured, /Approve card plan-1 pending/);
    captured = "";
    assert.equal(await main(["approve", "accept", "--sandbox", root]), 0);
    const plan = JSON.parse(readFileSync(path.join(root, ".ocp/sdlc/plan.json"), "utf8")) as { accepted?: boolean };
    assert.equal(plan.accepted, true);
    const cards = JSON.parse(readFileSync(path.join(root, ".ocp/approvals.json"), "utf8")) as { cards: { status: string }[] };
    assert.equal(cards.cards[0]?.status, "approved");

    captured = "";
    assert.equal(await main(["chat", "--sandbox", root, "--partner", "coding", "add a helper"]), 0);
    assert.match(captured, /Approve card plan-1 pending/);
    captured = "";
    assert.equal(await main(["approve", "deny", "--sandbox", root, "--partner", "coding"]), 0);
    assert.match(captured, /Approve denied/);
    const denied = JSON.parse(readFileSync(path.join(root, ".ocp/fleet/coding/.ocp/approvals.json"), "utf8")) as { cards: { status: string }[] };
    assert.equal(denied.cards[0]?.status, "denied");

    captured = "";
    assert.equal(await main(["chat", "--sandbox", root, "--partner", "coding", "add a helper again"]), 0);
    captured = "";
    const missing = await main(["approve", "redirect", "--sandbox", root, "--partner", "coding"]);
    assert.equal(missing, 2);
    assert.match(captured, /Usage: ocp approve redirect/);
    captured = "";
    assert.equal(await main(["approve", "redirect", "--sandbox", root, "--partner", "coding", "--note", "use a smaller helper"]), 0);
    assert.match(captured, /Approve redirected/);
    assert.match(readFileSync(path.join(root, ".ocp/fleet/coding/.ocp/sdlc/intent.md"), "utf8"), /smaller helper/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp approve accept clears a review hold and leaves the intent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-accept-again-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    const intent = "add a helper\n";
    writeFileSync(path.join(root, "PARTNER.md"), "partner\n");
    mkdirSync(path.join(root, ".ocp/sdlc"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/sdlc/intent.md"), intent);
    writeFileSync(path.join(root, ".ocp/sdlc/plan.json"), `${JSON.stringify({ accepted: false, check: ["node", "--test"] })}\n`);
    writeFileSync(path.join(root, ".ocp/sdlc/review-hold"), "password=hunter2\n");
    captured = "";
    assert.equal(await main(["approve", "list", "--sandbox", root]), 0);
    assert.match(captured, /does not accept the plan/);
    assert.equal(readFileSync(path.join(root, ".ocp/sdlc/review-hold"), "utf8"), "password=hunter2\n");
    captured = "";
    assert.equal(await main(["approve", "accept", "--sandbox", root]), 0);
    assert.match(captured, /Plan accepted again/);
    assert.doesNotMatch(captured, /hunter2/);
    const plan = JSON.parse(readFileSync(path.join(root, ".ocp/sdlc/plan.json"), "utf8")) as { accepted?: boolean };
    assert.equal(plan.accepted, true);
    assert.throws(() => readFileSync(path.join(root, ".ocp/sdlc/review-hold"), "utf8"));
    assert.equal(readFileSync(path.join(root, ".ocp/sdlc/intent.md"), "utf8"), intent);
    captured = "";
    assert.equal(await main(["approve", "list", "--sandbox", root]), 0);
    assert.match(captured, /Review hold: none/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp check runs the sandbox check and does not store the output", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-check-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    const testFile = "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\ntest(\"adds\", () => { assert.equal(1, 2, \"password=hunter2\"); });\n";
    writeFileSync(path.join(root, "add.test.mjs"), testFile);
    const bad = await main(["check", "--sandbox", root, "bash"]);
    assert.equal(bad, 2);
    assert.match(captured, /Usage: ocp check/);
    captured = "";
    assert.equal(await main(["check", "--sandbox", root]), 1);
    assert.match(captured, /node --test exit 1/);
    assert.doesNotMatch(captured, /hunter2/);
    const saved = JSON.parse(readFileSync(path.join(root, ".ocp/last-check.json"), "utf8")) as { code: number; kind: string };
    assert.equal(saved.code, 1);
    assert.equal(saved.kind, "node --test");
    assert.doesNotMatch(JSON.stringify(saved), /hunter2/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/add.test.mjs"), "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\ntest(\"adds\", () => { assert.equal(1 + 1, 2); });\n");
    captured = "";
    assert.equal(await main(["check", "--sandbox", root, "--partner", "coding"]), 0);
    assert.match(captured, /node --test exit 0/);
    const partner = JSON.parse(readFileSync(path.join(root, ".ocp/fleet/coding/.ocp/last-check.json"), "utf8")) as { code: number; kind: string };
    assert.equal(partner.code, 0);
    assert.equal(partner.kind, "node --test");
    const session = JSON.parse(readFileSync(path.join(root, ".ocp/last-check.json"), "utf8")) as { code: number };
    assert.equal(session.code, 1);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp todo list shows the checklist and does not change it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-todo-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const empty = await main(["todo", "list", "--sandbox", root]);
    assert.equal(empty, 0);
    assert.match(captured, /Todos: none/);
    const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    mkdirSync(path.join(root, ".ocp"), { recursive: true });
    const file = `${JSON.stringify({ todos: [{ id: "1", text: "write the test", done: false }] })}\n`;
    writeFileSync(path.join(root, ".ocp/todos.json"), file);
    captured = "";
    const listed = await main(["todo", "list", "--sandbox", root, "--json"]);
    assert.equal(listed, 0);
    const body = JSON.parse(captured) as { id: string; text: string; done: boolean }[];
    assert.equal(body[0]?.id, "1");
    assert.equal(body[0]?.text, "write the test");
    assert.equal(body[0]?.done, false);
    assert.equal(readFileSync(path.join(root, ".ocp/todos.json"), "utf8"), file);
    captured = "";
    const text = await main(["todo", "list", "--sandbox", root]);
    assert.equal(text, 0);
    assert.match(captured, /session \. 1 open write the test/);
    assert.match(captured, /does not add or complete/);
    assert.equal(readFileSync(path.join(root, ".ocp/todos.json"), "utf8"), file);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp todo add and complete change the checklist and refuse a secret", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-todo-change-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { readFileSync } = await import("node:fs");
    const missing = await main(["todo", "add", "--sandbox", root]);
    assert.equal(missing, 2);
    assert.match(captured, /Usage: ocp todo add/);
    captured = "";
    assert.equal(await main(["todo", "add", "--sandbox", root, "--text", "write the test"]), 0);
    assert.match(captured, /add write the test/);
    captured = "";
    assert.equal(await main(["todo", "add", "--sandbox", root, "--partner", "coding", "--text", "check the partner"]), 0);
    assert.match(captured, /coding/);
    const partnerFile = JSON.parse(readFileSync(path.join(root, ".ocp/fleet/coding/.ocp/todos.json"), "utf8")) as { todos: { text: string }[] };
    assert.equal(partnerFile.todos[0]?.text, "check the partner");
    captured = "";
    const secret = await main(["todo", "add", "--sandbox", root, "--text", "password=hunter2"]);
    assert.equal(secret, 1);
    assert.match(captured, /blocked/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.doesNotMatch(readFileSync(path.join(root, ".ocp/todos.json"), "utf8"), /hunter2/);
    captured = "";
    assert.equal(await main(["todo", "complete", "--sandbox", root, "--text", "1"]), 0);
    assert.match(captured, /complete 1/);
    const saved = JSON.parse(readFileSync(path.join(root, ".ocp/todos.json"), "utf8")) as { todos: { done: boolean }[] };
    assert.equal(saved.todos[0]?.done, true);
    captured = "";
    const listed = await main(["todo", "list", "--sandbox", root]);
    assert.equal(listed, 0);
    assert.match(listed === 0 ? captured : "", /does not add or complete/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp read prints a sandbox file and refuses a secret", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-read-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const missing = await main(["read", "--sandbox", root]);
    assert.equal(missing, 2);
    assert.match(captured, /Usage: ocp read/);
    writeFileSync(path.join(root, "hello.txt"), "hello from the sandbox\n");
    writeFileSync(path.join(root, "secret.txt"), "password=hunter2\n");
    mkdirSync(path.join(root, ".ocp"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/note.txt"), "board note\n");
    writeFileSync(path.join(root, "outside.txt"), "password=hunter2\n");
    captured = "";
    assert.equal(await main(["read", "--sandbox", root, "hello.txt"]), 0);
    assert.match(captured, /hello from the sandbox/);
    captured = "";
    const secret = await main(["read", "--sandbox", root, "secret.txt"]);
    assert.equal(secret, 1);
    assert.match(captured, /blocked/);
    assert.doesNotMatch(captured, /hunter2/);
    captured = "";
    assert.equal(await main(["read", "--sandbox", root, "../outside.txt"]), 1);
    assert.match(captured, /path refused/);
    assert.doesNotMatch(captured, /hunter2/);
    captured = "";
    assert.equal(await main(["read", "--sandbox", root, ".ocp/note.txt"]), 1);
    assert.match(captured, /path refused/);
    assert.doesNotMatch(captured, /board note/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "partner note\n");
    captured = "";
    assert.equal(await main(["read", "--sandbox", root, "--partner", "coding", "note.txt"]), 0);
    assert.match(captured, /partner note/);
    captured = "";
    assert.equal(await main(["read", "--sandbox", root, "note.txt"]), 1);
    assert.match(captured, /file missing/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp list names sandbox files and does not print contents", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-list-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    assert.equal(await main(["list", "--sandbox", root]), 0);
    assert.match(captured, /\(empty\)/);
    writeFileSync(path.join(root, "hello.txt"), "password=hunter2\n");
    writeFileSync(path.join(root, "password=hunter2.txt"), "hidden\n");
    mkdirSync(path.join(root, ".ocp"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/note.txt"), "board note\n");
    mkdirSync(path.join(root, "gtm"), { recursive: true });
    writeFileSync(path.join(root, "gtm/last-run.json"), "{}\n");
    captured = "";
    assert.equal(await main(["list", "--sandbox", root]), 0);
    assert.match(captured, /hello.txt/);
    assert.match(captured, /\[redacted\]/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.doesNotMatch(captured, /board note/);
    assert.doesNotMatch(captured, /\.ocp/);
    assert.doesNotMatch(captured, /gtm/);
    captured = "";
    assert.equal(await main(["list", "--sandbox", root, "../"]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "partner body\n");
    captured = "";
    assert.equal(await main(["list", "--sandbox", root, "--partner", "coding"]), 0);
    assert.match(captured, /note.txt/);
    assert.doesNotMatch(captured, /partner body/);
    captured = "";
    assert.equal(await main(["list", "--sandbox", root]), 0);
    assert.doesNotMatch(captured, /note.txt/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp grep prints a short hit and skips a secret file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-grep-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const missing = await main(["grep", "--sandbox", root]);
    assert.equal(missing, 2);
    assert.match(captured, /Usage: ocp grep/);
    writeFileSync(path.join(root, "hello.txt"), "hello from the sandbox\n");
    writeFileSync(path.join(root, "secret.txt"), "password=hunter2\n");
    mkdirSync(path.join(root, ".ocp"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/note.txt"), "board note\n");
    captured = "";
    assert.equal(await main(["grep", "--sandbox", root, "--text", "hello"]), 0);
    assert.match(captured, /hello.txt:1: hello from the sandbox/);
    assert.doesNotMatch(captured, /hunter2/);
    captured = "";
    assert.equal(await main(["grep", "--sandbox", root, "--text", "hunter2"]), 0);
    assert.match(captured, /\(no matches\)/);
    assert.doesNotMatch(captured, /hunter2/);
    captured = "";
    assert.equal(await main(["grep", "--sandbox", root, "--text", "board"]), 0);
    assert.match(captured, /\(no matches\)/);
    assert.doesNotMatch(captured, /board note/);
    captured = "";
    assert.equal(await main(["grep", "--sandbox", root, "--text", "hello", "../"]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "partner line\n");
    captured = "";
    assert.equal(await main(["grep", "--sandbox", root, "--partner", "coding", "--text", "partner"]), 0);
    assert.match(captured, /note.txt:1: partner line/);
    captured = "";
    assert.equal(await main(["grep", "--sandbox", root, "--text", "partner"]), 0);
    assert.match(captured, /\(no matches\)/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp glob names matching files and does not print contents", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-glob-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const missing = await main(["glob", "--sandbox", root]);
    assert.equal(missing, 2);
    assert.match(captured, /Usage: ocp glob/);
    writeFileSync(path.join(root, "hello.txt"), "password=hunter2\n");
    writeFileSync(path.join(root, "password=hunter2.txt"), "hidden\n");
    mkdirSync(path.join(root, ".ocp"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/note.txt"), "board note\n");
    mkdirSync(path.join(root, "gtm"), { recursive: true });
    writeFileSync(path.join(root, "gtm/last-run.json"), "{}\n");
    captured = "";
    assert.equal(await main(["glob", "--sandbox", root, "--pattern", "*.txt"]), 0);
    assert.match(captured, /hello.txt/);
    assert.match(captured, /\[redacted\]/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.doesNotMatch(captured, /board note/);
    assert.doesNotMatch(captured, /\.ocp/);
    assert.doesNotMatch(captured, /gtm/);
    captured = "";
    assert.equal(await main(["glob", "--sandbox", root, "--pattern", "../secret"]), 1);
    assert.match(captured, /pattern is not a relative glob/);
    assert.doesNotMatch(captured, /hunter2/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "partner body\n");
    captured = "";
    assert.equal(await main(["glob", "--sandbox", root, "--partner", "coding", "--pattern", "*.txt"]), 0);
    assert.match(captured, /note.txt/);
    assert.doesNotMatch(captured, /partner body/);
    captured = "";
    assert.equal(await main(["glob", "--sandbox", root, "--pattern", "note.txt"]), 0);
    assert.match(captured, /\(no matches\)/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp git status shows sandbox changes and does not commit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-git-cli-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    const refused = await main(["git", "commit", "--sandbox", root]);
    assert.equal(refused, 2);
    assert.match(captured, /Usage: ocp git status/);
    assert.equal(spawnSync("git", ["init"], { cwd: root, encoding: "utf8" }).status, 0);
    writeFileSync(path.join(root, "hello.txt"), "hello\n");
    writeFileSync(path.join(root, "password=hunter2.txt"), "hidden\n");
    mkdirSync(path.join(root, ".ocp"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/note.txt"), "board note\n");
    captured = "";
    assert.equal(await main(["git", "status", "--sandbox", root]), 0);
    assert.match(captured, /hello.txt/);
    assert.match(captured, /\[redacted\]/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.doesNotMatch(captured, /\.ocp/);
    assert.doesNotMatch(captured, /board note/);
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    const partnerRoot = path.join(root, ".ocp/fleet/coding");
    assert.equal(spawnSync("git", ["init"], { cwd: partnerRoot, encoding: "utf8" }).status, 0);
    writeFileSync(path.join(partnerRoot, "note.txt"), "partner body\n");
    captured = "";
    assert.equal(await main(["git", "status", "--sandbox", root, "--partner", "coding"]), 0);
    assert.match(captured, /note.txt/);
    assert.doesNotMatch(captured, /partner body/);
    assert.doesNotMatch(captured, /hunter2/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp git log shows short commits and does not commit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-git-log-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  try {
    const { existsSync, writeFileSync, mkdirSync } = await import("node:fs");
    const wide = await main(["git", "log", "--sandbox", root, "--n", "21"]);
    assert.equal(wide, 2);
    assert.match(captured, /ocp git log/);
    assert.equal(git(root, ["init"]).status, 0);
    assert.equal(git(root, ["config", "user.email", "test@example.com"]).status, 0);
    assert.equal(git(root, ["config", "user.name", "test"]).status, 0);
    writeFileSync(path.join(root, "hello.txt"), "hello\n");
    assert.equal(git(root, ["add", "hello.txt"]).status, 0);
    assert.equal(git(root, ["commit", "-m", "add hello"]).status, 0);
    writeFileSync(path.join(root, "secret.txt"), "hidden\n");
    assert.equal(git(root, ["add", "secret.txt"]).status, 0);
    assert.equal(git(root, ["commit", "-m", "password=hunter2"]).status, 0);
    captured = "";
    assert.equal(await main(["git", "log", "--sandbox", root, "--n", "2"]), 0);
    assert.match(captured, /add hello/);
    assert.match(captured, /\[redacted\]/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    const partnerRoot = path.join(root, ".ocp/fleet/coding");
    assert.equal(git(partnerRoot, ["init"]).status, 0);
    assert.equal(git(partnerRoot, ["config", "user.email", "test@example.com"]).status, 0);
    assert.equal(git(partnerRoot, ["config", "user.name", "test"]).status, 0);
    writeFileSync(path.join(partnerRoot, "note.txt"), "partner body\n");
    assert.equal(git(partnerRoot, ["add", "note.txt"]).status, 0);
    assert.equal(git(partnerRoot, ["commit", "-m", "partner note"]).status, 0);
    captured = "";
    assert.equal(await main(["git", "log", "--sandbox", root, "--partner", "coding"]), 0);
    assert.match(captured, /partner note/);
    assert.doesNotMatch(captured, /partner body/);
    assert.doesNotMatch(captured, /add hello/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp git diff shows a tracked change and hides a secret line", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-git-diff-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    const refused = await main(["git", "commit", "--sandbox", root]);
    assert.equal(refused, 2);
    assert.match(captured, /ocp git diff/);
    assert.equal(git(root, ["init"]).status, 0);
    assert.equal(git(root, ["config", "user.email", "test@example.com"]).status, 0);
    assert.equal(git(root, ["config", "user.name", "test"]).status, 0);
    writeFileSync(path.join(root, "hello.txt"), "hello\n");
    assert.equal(git(root, ["add", "hello.txt"]).status, 0);
    assert.equal(git(root, ["commit", "-m", "add hello"]).status, 0);
    writeFileSync(path.join(root, "hello.txt"), "hello\nchanged\npassword=hunter2\n");
    captured = "";
    assert.equal(await main(["git", "diff", "--sandbox", root, "hello.txt"]), 0);
    assert.match(captured, /changed/);
    assert.match(captured, /\[redacted\]/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    captured = "";
    assert.equal(await main(["git", "diff", "--sandbox", root, "../secret"]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    const partnerRoot = path.join(root, ".ocp/fleet/coding");
    assert.equal(git(partnerRoot, ["init"]).status, 0);
    assert.equal(git(partnerRoot, ["config", "user.email", "test@example.com"]).status, 0);
    assert.equal(git(partnerRoot, ["config", "user.name", "test"]).status, 0);
    writeFileSync(path.join(partnerRoot, "note.txt"), "one\n");
    assert.equal(git(partnerRoot, ["add", "note.txt"]).status, 0);
    assert.equal(git(partnerRoot, ["commit", "-m", "add note"]).status, 0);
    writeFileSync(path.join(partnerRoot, "note.txt"), "one\npartner line\n");
    captured = "";
    assert.equal(await main(["git", "diff", "--sandbox", root, "--partner", "coding"]), 0);
    assert.match(captured, /partner line/);
    assert.doesNotMatch(captured, /hunter2/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp git show prints a committed file and hides a secret line", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-git-show-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    const missing = await main(["git", "show", "--sandbox", root]);
    assert.equal(missing, 2);
    assert.match(captured, /ocp git show/);
    assert.equal(git(root, ["init"]).status, 0);
    assert.equal(git(root, ["config", "user.email", "test@example.com"]).status, 0);
    assert.equal(git(root, ["config", "user.name", "test"]).status, 0);
    writeFileSync(path.join(root, "hello.txt"), "hello\npassword=hunter2\n");
    assert.equal(git(root, ["add", "hello.txt"]).status, 0);
    assert.equal(git(root, ["commit", "-m", "add hello"]).status, 0);
    captured = "";
    assert.equal(await main(["git", "show", "--sandbox", root, "hello.txt"]), 0);
    assert.match(captured, /hello/);
    assert.match(captured, /\[redacted\]/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    captured = "";
    assert.equal(await main(["git", "show", "--sandbox", root, "../secret"]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    const partnerRoot = path.join(root, ".ocp/fleet/coding");
    assert.equal(git(partnerRoot, ["init"]).status, 0);
    assert.equal(git(partnerRoot, ["config", "user.email", "test@example.com"]).status, 0);
    assert.equal(git(partnerRoot, ["config", "user.name", "test"]).status, 0);
    writeFileSync(path.join(partnerRoot, "note.txt"), "partner line\n");
    assert.equal(git(partnerRoot, ["add", "note.txt"]).status, 0);
    assert.equal(git(partnerRoot, ["commit", "-m", "add note"]).status, 0);
    captured = "";
    assert.equal(await main(["git", "show", "--sandbox", root, "--partner", "coding", "note.txt"]), 0);
    assert.match(captured, /partner line/);
    assert.doesNotMatch(captured, /hunter2/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp turns lists stored outcomes and does not print the request", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-turns-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    assert.equal(await main(["turns", "--sandbox", root]), 0);
    assert.match(captured, /Turns: none/);
    mkdirSync(path.join(root, ".ocp"), { recursive: true });
    writeFileSync(
      path.join(root, ".ocp/prior-turns.json"),
      `${JSON.stringify({ turns: ["User: please add password=hunter2 to the note Outcome: Wrote hello.txt. QA pass."] }, null, 2)}\n`,
    );
    captured = "";
    assert.equal(await main(["turns", "--sandbox", root]), 0);
    assert.match(captured, /Wrote hello\.txt\. QA pass\./);
    assert.doesNotMatch(captured, /please add/);
    assert.doesNotMatch(captured, /hunter2/);
    writeFileSync(
      path.join(root, ".ocp/prior-turns.json"),
      `${JSON.stringify({ turns: ["User: add the note Outcome: Wrote password=hunter2. QA fail."] }, null, 2)}\n`,
    );
    captured = "";
    assert.equal(await main(["turns", "--sandbox", root]), 0);
    assert.match(captured, /\[redacted\]/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.doesNotMatch(captured, /add the note/);
    writeFileSync(path.join(root, ".ocp/prior-turns.json"), "{ not json password=hunter2\n");
    captured = "";
    assert.equal(await main(["turns", "--sandbox", root]), 1);
    assert.match(captured, /Turns: unreadable/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.doesNotMatch(captured, /not json/);
    mkdirSync(path.join(root, ".ocp/fleet/coding/.ocp"), { recursive: true });
    writeFileSync(
      path.join(root, ".ocp/fleet/coding/.ocp/prior-turns.json"),
      `${JSON.stringify({ turns: ["User: partner request Outcome: Wrote note.txt. QA pass."] }, null, 2)}\n`,
    );
    captured = "";
    assert.equal(await main(["turns", "--sandbox", root, "--partner", "coding"]), 0);
    assert.match(captured, /Wrote note\.txt\. QA pass\./);
    assert.doesNotMatch(captured, /partner request/);
    assert.doesNotMatch(captured, /Wrote hello\.txt/);
    captured = "";
    assert.equal(await main(["turns", "--sandbox", root, "extra"]), 2);
    assert.match(captured, /Usage: ocp turns/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp append adds text to an existing file and does not create one", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-append-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    assert.equal(await main(["append", "--sandbox", root]), 2);
    assert.match(captured, /Usage: ocp append/);
    captured = "";
    assert.equal(await main(["append", "--text", "more\n", "--sandbox", root, "missing.txt"]), 1);
    assert.match(captured, /file missing/);
    assert.equal(existsSync(path.join(root, "missing.txt")), false);
    writeFileSync(path.join(root, "hello.txt"), "hello\n");
    captured = "";
    assert.equal(await main(["append", "--text", "more\n", "--sandbox", root, "hello.txt"]), 0);
    assert.match(captured, /^appended\n$/);
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "hello\nmore\n");
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    captured = "";
    assert.equal(await main(["append", "--text", "password=hunter2\n", "--sandbox", root, "hello.txt"]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "hello\nmore\n");
    mkdirSync(path.join(root, "subdir"));
    captured = "";
    assert.equal(await main(["append", "--text", "more\n", "--sandbox", root, "subdir"]), 1);
    assert.match(captured, /directories are not appended/);
    captured = "";
    assert.equal(await main(["append", "--text", "more\n", "--sandbox", root, "../secret"]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "one\n");
    captured = "";
    assert.equal(await main(["append", "--text", "partner\n", "--sandbox", root, "--partner", "coding", "note.txt"]), 0);
    assert.match(captured, /^appended\n$/);
    assert.equal(readFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "utf8"), "one\npartner\n");
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "hello\nmore\n");
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp mkdir creates a directory and does not replace a file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-mkdir-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, statSync, writeFileSync } = await import("node:fs");
    assert.equal(await main(["mkdir", "--sandbox", root]), 2);
    assert.match(captured, /Usage: ocp mkdir/);
    captured = "";
    assert.equal(await main(["mkdir", "--sandbox", root, "src/lib"]), 0);
    assert.match(captured, /created/);
    assert.equal(statSync(path.join(root, "src/lib")).isDirectory(), true);
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    captured = "";
    assert.equal(await main(["mkdir", "--sandbox", root, "src/lib"]), 0);
    assert.match(captured, /already exists/);
    writeFileSync(path.join(root, "hello.txt"), "hello\n");
    captured = "";
    assert.equal(await main(["mkdir", "--sandbox", root, "hello.txt"]), 1);
    assert.match(captured, /path is a file/);
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "hello\n");
    captured = "";
    assert.equal(await main(["mkdir", "--sandbox", root, "password=hunter2"]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(existsSync(path.join(root, "password=hunter2")), false);
    captured = "";
    assert.equal(await main(["mkdir", "--sandbox", root, "../secret"]), 1);
    assert.match(captured, /path refused/);
    captured = "";
    assert.equal(await main(["mkdir", "--sandbox", root, "--partner", "coding", "notes"]), 0);
    assert.match(captured, /created/);
    assert.equal(statSync(path.join(root, ".ocp/fleet/coding/notes")).isDirectory(), true);
    assert.equal(existsSync(path.join(root, "notes")), false);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp delete removes one file and leaves a secret file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-delete-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    assert.equal(await main(["delete", "--sandbox", root]), 2);
    assert.match(captured, /Usage: ocp delete/);
    captured = "";
    assert.equal(await main(["delete", "--sandbox", root, "missing.txt"]), 1);
    assert.match(captured, /file missing/);
    writeFileSync(path.join(root, "hello.txt"), "hello\n");
    captured = "";
    assert.equal(await main(["delete", "--sandbox", root, "hello.txt"]), 0);
    assert.match(captured, /deleted/);
    assert.equal(existsSync(path.join(root, "hello.txt")), false);
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    writeFileSync(path.join(root, "secret.txt"), "password=hunter2\n");
    captured = "";
    assert.equal(await main(["delete", "--sandbox", root, "secret.txt"]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(readFileSync(path.join(root, "secret.txt"), "utf8"), "password=hunter2\n");
    mkdirSync(path.join(root, "subdir"));
    captured = "";
    assert.equal(await main(["delete", "--sandbox", root, "subdir"]), 1);
    assert.match(captured, /directories are not deleted/);
    assert.equal(existsSync(path.join(root, "subdir")), true);
    captured = "";
    assert.equal(await main(["delete", "--sandbox", root, "../secret"]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "partner\n");
    writeFileSync(path.join(root, "keep.txt"), "keep\n");
    captured = "";
    assert.equal(await main(["delete", "--sandbox", root, "--partner", "coding", "note.txt"]), 0);
    assert.match(captured, /deleted/);
    assert.equal(existsSync(path.join(root, ".ocp/fleet/coding/note.txt")), false);
    assert.equal(readFileSync(path.join(root, "keep.txt"), "utf8"), "keep\n");
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp rmdir removes one empty directory and leaves the rest", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-rmdir-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    assert.equal(await main(["rmdir", "--sandbox", root]), 2);
    assert.match(captured, /Usage: ocp rmdir/);
    captured = "";
    assert.equal(await main(["rmdir", "--sandbox", root, "missing"]), 1);
    assert.match(captured, /directory missing/);
    mkdirSync(path.join(root, "empty"));
    captured = "";
    assert.equal(await main(["rmdir", "--sandbox", root, "empty"]), 0);
    assert.match(captured, /removed/);
    assert.equal(existsSync(path.join(root, "empty")), false);
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    mkdirSync(path.join(root, "full"));
    writeFileSync(path.join(root, "full/keep.txt"), "keep\n");
    captured = "";
    assert.equal(await main(["rmdir", "--sandbox", root, "full"]), 1);
    assert.match(captured, /directory is not empty/);
    assert.equal(readFileSync(path.join(root, "full/keep.txt"), "utf8"), "keep\n");
    writeFileSync(path.join(root, "hello.txt"), "hello\n");
    captured = "";
    assert.equal(await main(["rmdir", "--sandbox", root, "hello.txt"]), 1);
    assert.match(captured, /path is a file/);
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "hello\n");
    captured = "";
    assert.equal(await main(["rmdir", "--sandbox", root, "password=hunter2"]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    captured = "";
    assert.equal(await main(["rmdir", "--sandbox", root, "../secret"]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding/notes"), { recursive: true });
    captured = "";
    assert.equal(await main(["rmdir", "--sandbox", root, "--partner", "coding", "notes"]), 0);
    assert.match(captured, /removed/);
    assert.equal(existsSync(path.join(root, ".ocp/fleet/coding/notes")), false);
    assert.equal(existsSync(path.join(root, "full")), true);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp rename moves one file and does not overwrite", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-rename-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    assert.equal(await main(["rename", "--sandbox", root]), 2);
    assert.match(captured, /Usage: ocp rename/);
    writeFileSync(path.join(root, "hello.txt"), "hello\n");
    captured = "";
    assert.equal(await main(["rename", "--from", "hello.txt", "--to", "note.txt", "--sandbox", root]), 0);
    assert.match(captured, /renamed/);
    assert.equal(existsSync(path.join(root, "hello.txt")), false);
    assert.equal(readFileSync(path.join(root, "note.txt"), "utf8"), "hello\n");
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    writeFileSync(path.join(root, "keep.txt"), "keep\n");
    captured = "";
    assert.equal(await main(["rename", "--from", "note.txt", "--to", "keep.txt", "--sandbox", root]), 1);
    assert.match(captured, /target already exists/);
    assert.equal(readFileSync(path.join(root, "note.txt"), "utf8"), "hello\n");
    assert.equal(readFileSync(path.join(root, "keep.txt"), "utf8"), "keep\n");
    writeFileSync(path.join(root, "secret.txt"), "password=hunter2\n");
    captured = "";
    assert.equal(await main(["rename", "--from", "secret.txt", "--to", "safe.txt", "--sandbox", root]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(existsSync(path.join(root, "secret.txt")), true);
    assert.equal(existsSync(path.join(root, "safe.txt")), false);
    mkdirSync(path.join(root, "subdir"));
    captured = "";
    assert.equal(await main(["rename", "--from", "subdir", "--to", "other", "--sandbox", root]), 1);
    assert.match(captured, /directories are not renamed/);
    assert.equal(existsSync(path.join(root, "subdir")), true);
    captured = "";
    assert.equal(await main(["rename", "--from", "../secret", "--to", "note.txt", "--sandbox", root]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/one.txt"), "partner\n");
    captured = "";
    assert.equal(await main(["rename", "--from", "one.txt", "--to", "two.txt", "--sandbox", root, "--partner", "coding"]), 0);
    assert.match(captured, /renamed/);
    assert.equal(existsSync(path.join(root, ".ocp/fleet/coding/one.txt")), false);
    assert.equal(readFileSync(path.join(root, ".ocp/fleet/coding/two.txt"), "utf8"), "partner\n");
    assert.equal(readFileSync(path.join(root, "note.txt"), "utf8"), "hello\n");
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp copy duplicates one file and leaves the source", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-copy-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    assert.equal(await main(["copy", "--sandbox", root]), 2);
    assert.match(captured, /Usage: ocp copy/);
    writeFileSync(path.join(root, "hello.txt"), "hello\n");
    captured = "";
    assert.equal(await main(["copy", "--from", "hello.txt", "--to", "note.txt", "--sandbox", root]), 0);
    assert.match(captured, /copied/);
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "hello\n");
    assert.equal(readFileSync(path.join(root, "note.txt"), "utf8"), "hello\n");
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    captured = "";
    assert.equal(await main(["copy", "--from", "hello.txt", "--to", "note.txt", "--sandbox", root]), 1);
    assert.match(captured, /target already exists/);
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "hello\n");
    writeFileSync(path.join(root, "secret.txt"), "password=hunter2\n");
    captured = "";
    assert.equal(await main(["copy", "--from", "secret.txt", "--to", "safe.txt", "--sandbox", root]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(existsSync(path.join(root, "secret.txt")), true);
    assert.equal(existsSync(path.join(root, "safe.txt")), false);
    mkdirSync(path.join(root, "subdir"));
    captured = "";
    assert.equal(await main(["copy", "--from", "subdir", "--to", "other", "--sandbox", root]), 1);
    assert.match(captured, /directories are not copied/);
    assert.equal(existsSync(path.join(root, "subdir")), true);
    captured = "";
    assert.equal(await main(["copy", "--from", "../secret", "--to", "note.txt", "--sandbox", root]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/one.txt"), "partner\n");
    captured = "";
    assert.equal(await main(["copy", "--from", "one.txt", "--to", "two.txt", "--sandbox", root, "--partner", "coding"]), 0);
    assert.match(captured, /copied/);
    assert.equal(readFileSync(path.join(root, ".ocp/fleet/coding/one.txt"), "utf8"), "partner\n");
    assert.equal(readFileSync(path.join(root, ".ocp/fleet/coding/two.txt"), "utf8"), "partner\n");
    assert.equal(existsSync(path.join(root, "two.txt")), false);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp write creates one new file and does not overwrite", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-write-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, mkdirSync } = await import("node:fs");
    assert.equal(await main(["write", "--sandbox", root]), 2);
    assert.match(captured, /Usage: ocp write/);
    captured = "";
    assert.equal(await main(["write", "--text", "hello\n", "--sandbox", root, "src/hello.txt"]), 0);
    assert.match(captured, /wrote/);
    assert.doesNotMatch(captured, /hello/);
    assert.equal(readFileSync(path.join(root, "src/hello.txt"), "utf8"), "hello\n");
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    captured = "";
    assert.equal(await main(["write", "--text", "other\n", "--sandbox", root, "src/hello.txt"]), 1);
    assert.match(captured, /file already exists/);
    assert.equal(readFileSync(path.join(root, "src/hello.txt"), "utf8"), "hello\n");
    captured = "";
    assert.equal(await main(["write", "--text", "password=hunter2\n", "--sandbox", root, "secret.txt"]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(existsSync(path.join(root, "secret.txt")), false);
    mkdirSync(path.join(root, "subdir"));
    captured = "";
    assert.equal(await main(["write", "--text", "x\n", "--sandbox", root, "subdir"]), 1);
    assert.match(captured, /path is a directory/);
    captured = "";
    assert.equal(await main(["write", "--text", "x\n", "--sandbox", root, "../secret"]), 1);
    assert.match(captured, /path refused/);
    captured = "";
    assert.equal(await main(["write", "--text", "partner\n", "--sandbox", root, "--partner", "coding", "note.txt"]), 0);
    assert.match(captured, /wrote/);
    assert.equal(readFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "utf8"), "partner\n");
    assert.equal(existsSync(path.join(root, "note.txt")), false);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp patch edits one file and leaves a mismatch unchanged", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-patch-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    const diff = "@@ -1 +1 @@\n-hello\n+world\n";
    assert.equal(await main(["patch", "--sandbox", root]), 2);
    assert.match(captured, /Usage: ocp patch/);
    captured = "";
    assert.equal(await main(["patch", "--text", diff, "--sandbox", root, "missing.txt"]), 1);
    assert.match(captured, /file missing/);
    assert.equal(existsSync(path.join(root, "missing.txt")), false);
    writeFileSync(path.join(root, "hello.txt"), "hello\n");
    captured = "";
    assert.equal(await main(["patch", "--text", diff, "--sandbox", root, "hello.txt"]), 0);
    assert.match(captured, /patched/);
    assert.doesNotMatch(captured, /world/);
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "world\n");
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    captured = "";
    assert.equal(await main(["patch", "--text", diff, "--sandbox", root, "hello.txt"]), 1);
    assert.match(captured, /patch did not match/);
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "world\n");
    const secretDiff = "@@ -1 +1 @@\n-world\n+password=hunter2\n";
    captured = "";
    assert.equal(await main(["patch", "--text", secretDiff, "--sandbox", root, "hello.txt"]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "world\n");
    writeFileSync(path.join(root, "secret.txt"), "password=hunter2\n");
    captured = "";
    assert.equal(await main(["patch", "--text", diff, "--sandbox", root, "secret.txt"]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(readFileSync(path.join(root, "secret.txt"), "utf8"), "password=hunter2\n");
    mkdirSync(path.join(root, "subdir"));
    captured = "";
    assert.equal(await main(["patch", "--text", diff, "--sandbox", root, "subdir"]), 1);
    assert.match(captured, /path is a directory/);
    captured = "";
    assert.equal(await main(["patch", "--text", diff, "--sandbox", root, "../secret"]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "hello\n");
    captured = "";
    assert.equal(await main(["patch", "--text", diff, "--sandbox", root, "--partner", "coding", "note.txt"]), 0);
    assert.match(captured, /patched/);
    assert.equal(readFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "utf8"), "world\n");
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "world\n");
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp replace overwrites one existing file and does not create one", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-replace-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    assert.equal(await main(["replace", "--sandbox", root]), 2);
    assert.match(captured, /Usage: ocp replace/);
    captured = "";
    assert.equal(await main(["replace", "--text", "next\n", "--sandbox", root, "missing.txt"]), 1);
    assert.match(captured, /file missing/);
    assert.equal(existsSync(path.join(root, "missing.txt")), false);
    writeFileSync(path.join(root, "hello.txt"), "hello\n");
    captured = "";
    assert.equal(await main(["replace", "--text", "next\n", "--sandbox", root, "hello.txt"]), 0);
    assert.match(captured, /replaced/);
    assert.doesNotMatch(captured, /next/);
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "next\n");
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    captured = "";
    assert.equal(await main(["replace", "--text", "password=hunter2\n", "--sandbox", root, "hello.txt"]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "next\n");
    writeFileSync(path.join(root, "secret.txt"), "password=hunter2\n");
    captured = "";
    assert.equal(await main(["replace", "--text", "clean\n", "--sandbox", root, "secret.txt"]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    assert.equal(readFileSync(path.join(root, "secret.txt"), "utf8"), "password=hunter2\n");
    mkdirSync(path.join(root, "subdir"));
    captured = "";
    assert.equal(await main(["replace", "--text", "x\n", "--sandbox", root, "subdir"]), 1);
    assert.match(captured, /path is a directory/);
    captured = "";
    assert.equal(await main(["replace", "--text", "x\n", "--sandbox", root, "../secret"]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "one\n");
    captured = "";
    assert.equal(await main(["replace", "--text", "two\n", "--sandbox", root, "--partner", "coding", "note.txt"]), 0);
    assert.match(captured, /replaced/);
    assert.equal(readFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "utf8"), "two\n");
    assert.equal(readFileSync(path.join(root, "hello.txt"), "utf8"), "next\n");
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp stat names a file or directory and does not print contents", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-stat-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    assert.equal(await main(["stat", "--sandbox", root]), 2);
    assert.match(captured, /Usage: ocp stat/);
    captured = "";
    assert.equal(await main(["stat", "--sandbox", root, "missing.txt"]), 0);
    assert.match(captured, /missing/);
    writeFileSync(path.join(root, "hello.txt"), "private-body\n");
    captured = "";
    assert.equal(await main(["stat", "--sandbox", root, "hello.txt"]), 0);
    assert.match(captured, /file/);
    assert.doesNotMatch(captured, /private-body/);
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    mkdirSync(path.join(root, "subdir"));
    captured = "";
    assert.equal(await main(["stat", "--sandbox", root, "subdir"]), 0);
    assert.match(captured, /directory/);
    captured = "";
    assert.equal(await main(["stat", "--sandbox", root, "password=hunter2"]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    captured = "";
    assert.equal(await main(["stat", "--sandbox", root, "../secret"]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/note.txt"), "partner-body\n");
    captured = "";
    assert.equal(await main(["stat", "--sandbox", root, "--partner", "coding", "note.txt"]), 0);
    assert.match(captured, /file/);
    assert.doesNotMatch(captured, /partner-body/);
    captured = "";
    assert.equal(await main(["stat", "--sandbox", root, "note.txt"]), 0);
    assert.match(captured, /missing/);
  } finally {
    process.stdout.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ocp same compares two files and does not print them", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-same-"));
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    assert.equal(await main(["same", "--sandbox", root]), 2);
    assert.match(captured, /Usage: ocp same/);
    writeFileSync(path.join(root, "a.txt"), "alpha-body\n");
    writeFileSync(path.join(root, "b.txt"), "alpha-body\n");
    captured = "";
    assert.equal(await main(["same", "--from", "a.txt", "--to", "b.txt", "--sandbox", root]), 0);
    assert.match(captured, /(^|\n)same\n/);
    assert.doesNotMatch(captured, /alpha-body/);
    assert.equal(existsSync(path.join(root, ".ocp/last-check.json")), false);
    writeFileSync(path.join(root, "b.txt"), "beta-body\n");
    captured = "";
    assert.equal(await main(["same", "--from", "a.txt", "--to", "b.txt", "--sandbox", root]), 0);
    assert.match(captured, /(^|\n)different\n/);
    assert.doesNotMatch(captured, /alpha-body/);
    assert.doesNotMatch(captured, /beta-body/);
    captured = "";
    assert.equal(await main(["same", "--from", "a.txt", "--to", "missing.txt", "--sandbox", root]), 1);
    assert.match(captured, /file missing/);
    writeFileSync(path.join(root, "secret.txt"), "password=hunter2\n");
    captured = "";
    assert.equal(await main(["same", "--from", "secret.txt", "--to", "a.txt", "--sandbox", root]), 1);
    assert.match(captured, /blocked \(secret pattern\)/);
    assert.doesNotMatch(captured, /hunter2/);
    mkdirSync(path.join(root, "subdir"));
    captured = "";
    assert.equal(await main(["same", "--from", "subdir", "--to", "a.txt", "--sandbox", root]), 1);
    assert.match(captured, /path is a directory/);
    captured = "";
    assert.equal(await main(["same", "--from", "../secret", "--to", "a.txt", "--sandbox", root]), 1);
    assert.match(captured, /path refused/);
    mkdirSync(path.join(root, ".ocp/fleet/coding"), { recursive: true });
    writeFileSync(path.join(root, ".ocp/fleet/coding/one.txt"), "partner-body\n");
    writeFileSync(path.join(root, ".ocp/fleet/coding/two.txt"), "partner-body\n");
    captured = "";
    assert.equal(await main(["same", "--from", "one.txt", "--to", "two.txt", "--sandbox", root, "--partner", "coding"]), 0);
    assert.match(captured, /(^|\n)same\n/);
    assert.doesNotMatch(captured, /partner-body/);
    assert.doesNotMatch(captured, /beta-body/);
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
