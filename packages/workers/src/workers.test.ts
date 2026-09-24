import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCreateFileInstruction, writeSandboxFile } from "./coding.js";
import { executeComputerVisit, planGtmActions, selectorDecision, urlDecision } from "./computer.js";
import { grokBuildArgv, runOnGrokBuild } from "./grok.js";
import { openAiCompatibleRunner, parseFileEdits } from "./openai.js";
import { qaCheckFile } from "./qa.js";
import { securityGate } from "./security.js";

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
    assert.equal(blocked.actions[2]?.executed, false);
    assert.match(blocked.note, /Refused the type step/);
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
        async close() {
          return undefined;
        },
      };
    },
  };
}

test("computer agent records a GTM plan that did not run", () => {
  const plan = planGtmActions("OpenCodingPartner");
  assert.match(plan.note, /No live browser ran/);
  assert.ok(plan.actions.length >= 1);
  for (const action of plan.actions) {
    assert.equal(action.executed, false);
    assert.equal(action.liveBrowser, false);
  }
});
