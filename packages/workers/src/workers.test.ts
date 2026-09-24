import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyUnifiedDiff, commandDecision, deleteSandboxFile, grepSandbox, parseCodingReply } from "./agent-tools.js";
import { parseCreateFileInstruction, writeSandboxFile } from "./coding.js";
import { computerChain, executeComputerVisit, pageClaim, planGtmActions, selectorDecision, urlDecision } from "./computer.js";
import { grokBuildArgv, runOnGrokBuild } from "./grok.js";
import { openAiCompatibleRunner, parseFileEdits } from "./openai.js";
import { fileExpectations, qaCheckFile, reviewComputerClaim, reviewFileExpectations } from "./qa.js";
import { securityGate } from "./security.js";

test("node --test is allowed and a unified diff edits one line", () => {
  assert.equal(commandDecision(["node", "--test", "src/math.test.ts"]).allow, true);
  assert.equal(commandDecision(["bash", "-c", "rm -rf /"]).allow, false);
  assert.equal(commandDecision(["node", "-e", "process.exit(1)"]).allow, false);
  assert.equal(commandDecision(["node", "--test", "../secret"]).allow, false);
  assert.equal(commandDecision(["node", "--test", "/tmp/x.test.js"]).allow, false);
  const next = applyUnifiedDiff(
    "export function add(left: number, right: number): number {\n  return left - right;\n}\n",
    "--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1,3 +1,3 @@\n export function add(left: number, right: number): number {\n-  return left - right;\n+  return left + right;\n }\n",
  );
  assert.match(next ?? "", /return left \+ right/);
  assert.equal(parseCodingReply('{"steps":[{"tool":"read","path":"src/math.ts"}]}')?.steps[0]?.tool, "read");
  assert.equal(parseCodingReply('{"steps":[{"tool":"grep","query":"function add"}]}')?.steps[0]?.query, "function add");
});

test("grep finds a symbol and skips secrets and gtm", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-grep-"));
  try {
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "gtm"), { recursive: true });
  await writeFile(path.join(root, "src/math.ts"), "export function add(left: number, right: number) {\n  return left + right;\n}\n");
  await writeFile(path.join(root, "src/other.ts"), "export function sub() { return 1; }\n");
  await writeFile(path.join(root, "gtm/note.txt"), "function add should not show\n");
  await writeFile(path.join(root, "src/secret.ts"), "password=hunter2\nfunction add\n");
  const found = await grepSandbox(root, "function add");
  assert.match(found.detail, /src\/math.ts:1:/);
  assert.doesNotMatch(found.detail, /other.ts/);
  assert.doesNotMatch(found.detail, /gtm/);
  assert.doesNotMatch(found.detail, /hunter2/);
  assert.doesNotMatch(found.detail, /secret.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delete removes one file and refuses escape, secrets, and gtm", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-delete-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "gtm"), { recursive: true });
    await writeFile(path.join(root, "src/old.ts"), "export const old = 1;\n");
    await writeFile(path.join(root, "src/secret.ts"), "password=hunter2\n");
    await writeFile(path.join(root, "gtm/last-run.json"), "{}\n");
    assert.equal((await deleteSandboxFile(root, "src/old.ts")).ok, true);
    await assert.rejects(readFile(path.join(root, "src/old.ts"), "utf8"));
    const escaped = await deleteSandboxFile(root, "../secret.txt");
    assert.equal(escaped.ok, false);
    const secret = await deleteSandboxFile(root, "src/secret.ts");
    assert.equal(secret.ok, false);
    assert.match(secret.detail, /blocked/);
    assert.match(await readFile(path.join(root, "src/secret.ts"), "utf8"), /hunter2/);
    const evidence = await deleteSandboxFile(root, "gtm/last-run.json");
    assert.equal(evidence.ok, false);
    assert.match(await readFile(path.join(root, "gtm/last-run.json"), "utf8"), /\{\}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create-file parse keeps the trailing newline and rejects an unknown tool", () => {
  const parsed = parseCreateFileInstruction(
    "Use Grok Build to create PRODUCT.md with content:\nhello\n",
  );
  assert.deepEqual(parsed, { relativePath: "PRODUCT.md", content: "hello\n" });
  assert.equal(
    parseCreateFileInstruction("Use Some Other Tool to create PRODUCT.md with content:\nno\n"),
    null,
  );
  assert.equal(parseCreateFileInstruction("status please"), null);
});

test("security gate blocks escape and secrets, then a good write passes QA", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-workers-"));
  try {
    const blocked = securityGate({
      relativePath: "foo/../../secret.txt",
      content: "password=hunter2\n",
      sandboxRoot: root,
    });
    assert.equal(blocked.allow, false);
    assert.ok(blocked.reasons.includes("path escape"));
    assert.ok(blocked.reasons.includes("secret pattern"));

    const allowed = securityGate({
      relativePath: "PRODUCT.md",
      content: "OpenCodingPartner helps a team build and sell.\n",
      sandboxRoot: root,
    });
    assert.equal(allowed.allow, true);
    await writeSandboxFile(root, "PRODUCT.md", "OpenCodingPartner helps a team build and sell.\n");
    const qa = await qaCheckFile(root, "PRODUCT.md", "OpenCodingPartner helps a team build and sell.\n");
    assert.equal(qa.pass, true);
    const text = await readFile(path.join(root, "PRODUCT.md"), "utf8");
    assert.equal(text.endsWith("\n"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok Build argv is headless and the runner is injected", async () => {
  const argv = grokBuildArgv("write a file", "/work");
  assert.deepEqual(argv, ["grok", "-p", "write a file", "--cwd", "/work", "--output-format", "streaming-json"]);
  const seen: string[][] = [];
  const result = await runOnGrokBuild(
    {
      async run(next) {
        seen.push([...next]);
        return { exitCode: 0, stdout: "" };
      },
    },
    "check the file",
    "/sandbox",
  );
  assert.equal(result.exitCode, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.[0], "grok");
});

test("an OpenAI-compatible meter writes the files the model returns", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-openai-"));
  try {
    const runner = openAiCompatibleRunner({
      apiKey: "sk-test",
      baseUrl: "https://litellm.example/v1/",
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://litellm.example/v1/chat/completions");
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        assert.match(body.messages[0]?.content ?? "", /src\/math.ts/);
        assert.equal((init?.headers as Record<string, string>).authorization, "Bearer sk-test");
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '```json\n{"files":[{"path":"src/math.ts","content":"export function add(a: number, b: number): number {\\n  return a + b;\\n}\\n"},{"path":"src/math.test.ts","content":"import { add } from \\"./math.js\\";\\nimport assert from \\"node:assert/strict\\";\\nassert.equal(add(1, 2), 3);\\n"}]}\n```',
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await runOnGrokBuild(
      runner,
      "Add an add function in src/math.ts and a test in src/math.test.ts",
      root,
    );
    assert.equal(result.exitCode, 0);
    const math = await readFile(path.join(root, "src/math.ts"), "utf8");
    const spec = await readFile(path.join(root, "src/math.test.ts"), "utf8");
    assert.match(math, /function add/);
    assert.match(spec, /add\(1, 2\)/);
    assert.equal(parseFileEdits("not json").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a blocked URL never calls the browser", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-browser-block-"));
  try {
    assert.equal(urlDecision("file:///etc/passwd").allow, false);
    assert.equal(urlDecision("http://127.0.0.1/secret").allow, false);
    assert.equal(urlDecision("http://169.254.169.254/").allow, false);
    assert.equal(urlDecision("https://user:pass@example.com/").allow, false);
    let called = false;
    const plan = await executeComputerVisit({
      productName: "OpenCodingPartner",
      message: "open http://127.0.0.1/admin",
      sandboxRoot: root,
      execute: true,
      driver: {
        async start() {
          called = true;
          throw new Error("must not start");
        },
      },
    });
    assert.equal(called, false);
    assert.equal(plan.actions.every((action) => action.executed === false), true);
    assert.match(plan.note, /No live browser ran/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fake browser records the title and a screenshot inside the sandbox", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-browser-ok-"));
  try {
    const plan = await executeComputerVisit({
      productName: "OpenCodingPartner",
      message: "Open https://example.com/docs",
      sandboxRoot: root,
      execute: true,
      allowHosts: ["example.com"],
      driver: fakeBrowser(),
    });
    assert.equal(plan.actions[0]?.executed, true);
    assert.equal(plan.actions[1]?.kind, "read-screen");
    assert.equal(plan.actions[1]?.executed, true);
    const evidence = JSON.parse(await readFile(path.join(root, "gtm/last-run.json"), "utf8")) as {
      url: string;
      title: string;
      steps: { kind: string; executed: boolean }[];
    };
    assert.equal(evidence.url, "https://example.com/docs");
    assert.equal(evidence.title, "Example Domain");
    assert.equal(evidence.steps.filter((step) => step.executed).length, 2);
    const png = await readFile(path.join(root, "gtm/step-1.png"));
    assert.equal(png[0], 137);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live sequence opens, reads, and types, and a script selector does not run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-browser-steps-"));
  try {
    assert.equal(selectorDecision("javascript:alert(1)").allow, false);
    let typed = false;
    const plan = await executeComputerVisit({
      productName: "OpenCodingPartner",
      message: 'Open https://example.com and type "password=hunter2" into #hero',
      sandboxRoot: root,
      execute: true,
      driver: fakeBrowser(() => {
        typed = true;
      }),
    });
    assert.equal(plan.actions.map((action) => action.kind).join(","), "open-url,read-screen,type");
    assert.equal(plan.actions.every((action) => action.executed), true);
    assert.equal(typed, true);
    const evidence = JSON.parse(await readFile(path.join(root, "gtm/last-run.json"), "utf8")) as {
      steps: { kind: string; text?: string }[];
    };
    assert.equal(evidence.steps.find((step) => step.kind === "type")?.text, "[redacted]");
    const blocked = await executeComputerVisit({
      productName: "OpenCodingPartner",
      message: 'Open https://example.com type "hi" into javascript:alert(1)',
      sandboxRoot: root,
      execute: true,
      driver: fakeBrowser(() => {
        throw new Error("type must not run");
      }),
    });
    assert.equal(blocked.actions[0]?.executed, true);
    assert.equal(blocked.actions[1]?.executed, true);
    assert.equal(blocked.actions[2]?.executed, true);
    assert.equal(blocked.actions[2]?.passed, false);
    assert.match(blocked.note, /selector looks like a script/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA passes a page claim and fails a broken title", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-claim-ok-"));
  try {
    const held = await executeComputerVisit({
      productName: "OpenCodingPartner",
      message: 'Stand up a QA agent. Open https://example.com and expect title "Example Domain"',
      sandboxRoot: root,
      execute: true,
      driver: fakeBrowser(),
    });
    assert.equal(held.actions.some((action) => action.kind === "verify" && action.executed), true);
    const assertion = JSON.parse(await readFile(path.join(root, "gtm/assertion.json"), "utf8")) as { claimHeld: boolean; screenshot: string };
    assert.equal(assertion.claimHeld, true);
    assert.equal(assertion.screenshot, "gtm/step-3.png");
    const png = await readFile(path.join(root, assertion.screenshot));
    assert.ok(png.length > 0);
    const pass = await reviewComputerClaim(root);
    assert.equal(pass.pass, true);
    const run = JSON.parse(await readFile(path.join(root, "gtm/last-run.json"), "utf8")) as { steps: { kind: string }[] };
    assert.ok(run.steps.some((step) => step.kind === "verify"));

    const brokenRoot = await mkdtemp(path.join(tmpdir(), "ocp-claim-bad-"));
    await executeComputerVisit({
      productName: "OpenCodingPartner",
      message: 'Open https://example.com and expect title "Not the page"',
      sandboxRoot: brokenRoot,
      execute: true,
      driver: fakeBrowser(),
    });
    const broken = await reviewComputerClaim(brokenRoot);
    assert.equal(broken.pass, false);
    assert.match(broken.summary, /did not hold/);
    assert.match(broken.summary, /Not the page/);
    await rm(brokenRoot, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execute off and a missing browser fail the page claim", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-claim-off-"));
  try {
    assert.deepEqual(pageClaim('expect title "Example Domain"'), { title: "Example Domain" });
    await executeComputerVisit({
      productName: "OpenCodingPartner",
      message: 'Open https://example.com and expect title "Example Domain"',
      sandboxRoot: root,
      execute: false,
    });
    const off = await reviewComputerClaim(root);
    assert.equal(off.pass, false);
    assert.match(off.summary, /did not run/);
    const saved = JSON.parse(await readFile(path.join(root, "gtm/last-run.json"), "utf8")) as { executed: boolean };
    assert.equal(saved.executed, false);

    await executeComputerVisit({
      productName: "OpenCodingPartner",
      message: 'Open https://example.com and expect title "Example Domain"',
      sandboxRoot: root,
      execute: true,
      driver: {
        async start() {
          throw new Error("Playwright is not installed");
        },
      },
    });
    const missing = await reviewComputerClaim(root);
    assert.equal(missing.pass, false);
    assert.match(missing.summary, /did not run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed step skips the rest of the chain", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-chain-"));
  try {
    const chain = computerChain('Open https://example.com then expect title "Example Domain" then type "hi" into #hero then expect selector #hero value "nope" then type "later" into #next');
    assert.equal(chain.length, 4);
    let typed = 0;
    const plan = await executeComputerVisit({
      productName: "OpenCodingPartner",
      message: 'Open https://example.com then expect title "Example Domain" then type "hi" into #hero then expect selector #hero value "nope" then type "later" into #next',
      sandboxRoot: root,
      execute: true,
      driver: fakeBrowser(() => {
        typed += 1;
      }),
    });
    assert.equal(typed, 1);
    const selector = plan.actions.find((action) => action.purpose === "Check the selector value");
    assert.equal(selector?.passed, false);
    assert.match(selector?.reason ?? "", /expected nope/);
    const later = plan.actions.find((action) => action.target === "#next");
    assert.equal(later?.executed, false);
    assert.equal(later?.skipped, true);
    assert.match(plan.note, /Later steps were skipped/);
    const saved = JSON.parse(await readFile(path.join(root, "gtm/last-run.json"), "utf8")) as {
      steps: { passed?: boolean; skipped?: boolean; screenshot?: string }[];
    };
    assert.ok(saved.steps.some((step) => step.passed === false));
    assert.ok(saved.steps.some((step) => step.skipped === true));
    assert.ok(saved.steps.filter((step) => step.screenshot).length >= 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA fails a multi-file write that misses content or was stripped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-qa-files-"));
  try {
    await writeFile(path.join(root, "README.md"), "Hello\n");
    const expected = fileExpectations('expect file README.md to contain "Install" and expect file notes.txt to contain "safe"');
    assert.equal(expected.length, 2);
    const review = await reviewFileExpectations(root, ["README.md"], expected, ["notes.txt"]);
    assert.equal(review.pass, false);
    assert.match(review.summary, /README.md is missing expected content/);
    assert.match(review.summary, /notes.txt was removed by security/);
    await writeFile(path.join(root, "empty.txt"), "");
    const empty = await reviewFileExpectations(root, ["empty.txt"], [{ path: "empty.txt", contains: "x" }]);
    assert.equal(empty.pass, false);
    assert.match(empty.summary, /empty/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeBrowser(onType?: (selector: string, text: string) => void) {
  const png = Uint8Array.from([137, 80, 78, 71]);
  return {
    async start() {
      return {
        async open(url: string) {
          assert.match(url, /^https:\/\/example.com/);
          return { title: "Example Domain", text: "body", screenshotPng: png };
        },
        async readScreen() {
          return { title: "Example Domain", text: "body", screenshotPng: png };
        },
        async typeInto(selector: string, text: string) {
          onType?.(selector, text);
          return { title: "Example Domain", text, screenshotPng: png };
        },
        async selectorState(selector: string) {
          return { visible: true, value: selector === "#hero" ? "hi" : "" };
        },
        async close() {
          return undefined;
        },
      };
    },
  };
}

test("click then expect text, and navigate stays on the opened host", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-click-"));
  try {
    const chain = computerChain('Open https://example.com then click #more then expect text "Details" then navigate https://example.com/next');
    assert.deepEqual(chain.map((step) => step.kind), ["click", "expect-text", "navigate"]);
    const png = Uint8Array.from([137, 80, 78, 71]);
    let text = "body";
    let clicks = 0;
    const plan = await executeComputerVisit({
      productName: "OpenCodingPartner",
      message: 'Open https://example.com then click #more then expect text "Details"',
      sandboxRoot: root,
      execute: true,
      driver: {
        async start() {
          return {
            async open() {
              return { title: "Example", text, screenshotPng: png };
            },
            async readScreen() {
              return { title: "Example", text, screenshotPng: png };
            },
            async typeInto() {
              return { title: "Example", text, screenshotPng: png };
            },
            async click() {
              clicks += 1;
              text = "Details are here";
              return { title: "Example", text, screenshotPng: png };
            },
            async navigate() {
              return { title: "Example", text, screenshotPng: png };
            },
            async close() {
              return undefined;
            },
          };
        },
      },
    });
    assert.equal(clicks, 1);
    const click = plan.actions.find((action) => action.kind === "click");
    const expectText = plan.actions.find((action) => action.purpose === "Check the page text");
    assert.equal(click?.passed, true);
    assert.equal(expectText?.passed, true);
    const saved = JSON.parse(await readFile(path.join(root, "gtm/last-run.json"), "utf8")) as {
      steps: { kind: string; passed?: boolean; screenshot?: string }[];
    };
    assert.ok(saved.steps.some((step) => step.kind === "click" && step.passed === true && step.screenshot));

    const blocked = await mkdtemp(path.join(tmpdir(), "ocp-nav-"));
    let went = "";
    const refused = await executeComputerVisit({
      productName: "OpenCodingPartner",
      message: "Open https://example.com then navigate https://evil.example/phish",
      sandboxRoot: blocked,
      execute: true,
      driver: {
        async start() {
          return {
            async open() {
              return { title: "Example", text: "body", screenshotPng: png };
            },
            async readScreen() {
              return { title: "Example", text: "body", screenshotPng: png };
            },
            async typeInto() {
              return { title: "Example", text: "body", screenshotPng: png };
            },
            async click() {
              return { title: "Example", text: "body", screenshotPng: png };
            },
            async navigate(url: string) {
              went = url;
              return { title: "Example", text: "body", screenshotPng: png };
            },
            async close() {
              return undefined;
            },
          };
        },
      },
    });
    assert.equal(went, "");
    assert.equal(refused.actions.find((action) => action.kind === "navigate")?.passed, false);
    assert.match(refused.actions.find((action) => action.kind === "navigate")?.reason ?? "", /opened host/);
    await rm(blocked, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computer agent records a GTM plan that did not run", () => {
  const plan = planGtmActions("OpenCodingPartner");
  assert.match(plan.note, /No live browser ran/);
  assert.ok(plan.actions.length >= 1);
  for (const action of plan.actions) {
    assert.equal(action.executed, false);
    assert.equal(action.liveBrowser, false);
  }
});
