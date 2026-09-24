import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { routeWithPredict, type ManagerPlan } from "@opencodingpartner/policy";
import { grepSandbox, listSandboxDir, writeSandboxFile } from "@opencodingpartner/workers";
import { DEMO_MESSAGE, clearSessionMemory, runChatTurn, runDemo } from "./index.js";

test("chat stands up agents, writes, checks QA, gates security, and records GTM", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-turn-"));
  try {
    const turn = await runChatTurn({ message: DEMO_MESSAGE, sandboxRoot: root });
    assert.equal(turn.session.key, "agent:board:main");
    assert.deepEqual(
      turn.agents.map((agent) => agent.role),
      ["coding", "qa", "security", "computer"],
    );
    assert.equal(turn.security?.allow, true);
    assert.equal(turn.coding?.wrote, true);
    assert.equal(turn.qa?.pass, true);
    assert.equal(turn.computer?.actions.every((action) => action.executed === false), true);
    const product = await readFile(path.join(root, "PRODUCT.md"), "utf8");
    assert.equal(product, "OpenCodingPartner helps a team build and sell.\n");
    const plan = JSON.parse(await readFile(path.join(root, "gtm", "action-plan.json"), "utf8")) as {
      actions: { executed: boolean; liveBrowser: boolean }[];
      note: string;
    };
    assert.match(plan.note, /No live browser ran/);
    assert.ok(plan.actions.every((action) => action.executed === false && action.liveBrowser === false));

    const blocked = await runChatTurn({
      message: "Stand up a security agent and a coding agent.\nUse Grok Build to create ../secret.txt with content:\npassword=hunter2\n",
      sandboxRoot: root,
    });
    assert.equal(blocked.security?.allow, false);
    assert.equal(blocked.coding?.wrote, false);
    await assert.rejects(access(path.join(root, "secret.txt")));

    await writeFile(path.join(root, "PRODUCT.md"), "changed\n");
    const replay = await runChatTurn({ message: DEMO_MESSAGE, sandboxRoot: root });
    assert.equal(replay.replayed, true);
    assert.equal(await readFile(path.join(root, "PRODUCT.md"), "utf8"), "changed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a grok runner edits the sandbox and the transcript names each agent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-grok-turn-"));
  try {
    const message = "Use Grok Build to create hello.txt with content:\nhello from grok\n";
    const turn = await runChatTurn({
      message,
      sandboxRoot: root,
      computerExecute: true,
      orchestration: async () => ({ state: "ran", detail: "OpenClaw session agent:board:main accepted the turn." }),
      grokRunner: {
        async run() {
          await writeSandboxFile(root, "hello.txt", "hello from grok\n");
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    assert.match(turn.transcript, /Orchestration: ran:/);
    assert.match(turn.transcript, /coding agent/);
    assert.match(turn.transcript, /QA agent/);
    assert.match(turn.transcript, /security agent/);
    assert.match(turn.transcript, /computer agent/);
    assert.match(turn.transcript, /via grok-build/);
    assert.match(turn.transcript, /executed: false/);
    assert.match(turn.transcript, /Computer execute was requested/);
    assert.equal(await readFile(path.join(root, "hello.txt"), "utf8"), "hello from grok\n");
    const plan = JSON.parse(await readFile(path.join(root, "gtm", "action-plan.json"), "utf8")) as {
      actions: { executed: boolean }[];
    };
    assert.ok(plan.actions.every((action) => action.executed === false));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a general ask offline does not pretend to edit files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-offline-ask-"));
  try {
    const turn = await runChatTurn({
      message: "add a README section explaining install",
      sandboxRoot: root,
    });
    assert.equal(turn.coding?.wrote, false);
    assert.match(turn.transcript, /General edits need LITELLM_API_KEY/);
    assert.match(turn.transcript, /XAI_API_KEY/);
    assert.match(turn.transcript, /Meter: none/);
    await assert.rejects(readFile(path.join(root, "README.md"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a general ask on Grok Build edits files and QA reviews them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-general-"));
  try {
    let prompts: string[] = [];
    const turn = await runChatTurn({
      message: "add a README section explaining install",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          prompts = [...argv];
          await writeSandboxFile(root, "README.md", "# Install\n\npnpm install\n");
          await writeSandboxFile(root, "docs/setup.md", "See README.\n");
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    assert.equal(turn.coding?.via, "grok-build");
    assert.equal(turn.coding?.wrote, true);
    assert.match(turn.qa?.summary ?? "", /README.md/);
    assert.match(turn.qa?.summary ?? "", /docs\/setup.md/);
    assert.equal(turn.qa?.pass, true);
    assert.ok((prompts[prompts.indexOf("-p") + 1] ?? "").includes("add a README section explaining install"));
    assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "# Install\n\npnpm install\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("security removes a secret file after a general edit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-secret-after-"));
  try {
    const turn = await runChatTurn({
      message: "refactor the notes",
      sandboxRoot: root,
      grokRunner: {
        async run() {
          await writeSandboxFile(root, "notes.txt", "password=hunter2\n");
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    assert.equal(turn.security?.allow, false);
    assert.match(turn.transcript, /removed notes.txt/);
    await assert.rejects(readFile(path.join(root, "notes.txt"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenClaw drives a general edit and QA checks the kept files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-driven-"));
  try {
    const turn = await runChatTurn({
      message: "add a README section explaining install",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan. skills.status ran on the session.",
      }),
      grokRunner: {
        async run() {
          await writeSandboxFile(root, "README.md", "# Install\n");
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    assert.match(turn.transcript, /OpenClaw accepted the session plan/);
    assert.match(turn.transcript, /General model edits still run in this process/);
    assert.match(turn.transcript, /via grok-build/);
    assert.doesNotMatch(turn.transcript, /write tool landed/);
    assert.equal(turn.qa?.pass, true);
    assert.match(turn.qa?.summary ?? "", /README.md is non-empty/);
    assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "# Install\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a gateway that rejects the plan does not fall back to the local swarm", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-reject-"));
  try {
    const turn = await runChatTurn({
      message: "Use Grok Build to create hello.txt with content:\nhello\n",
      sandboxRoot: root,
      orchestration: async () => ({ state: "failed", driver: "openclaw", detail: "sessions.send did not accept the session plan." }),
      grokRunner: {
        async run() {
          await writeSandboxFile(root, "hello.txt", "should-not\n");
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    assert.match(turn.transcript, /did not take over/);
    assert.equal(turn.coding, null);
    await assert.rejects(readFile(path.join(root, "hello.txt"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA fails when Grok Build reports success and keeps no files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-empty-"));
  try {
    const turn = await runChatTurn({
      message: "refactor the notes",
      sandboxRoot: root,
      grokRunner: { async run() { return { exitCode: 0, stdout: "" }; } },
    });
    assert.equal(turn.coding?.wrote, false);
    assert.equal(turn.qa?.pass, false);
    assert.match(turn.qa?.summary ?? "", /kept no files/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok Build adds a function and a test across two files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-math-"));
  try {
    const message = "Add an add function in src/math.ts and a test in src/math.test.ts";
    let argv: string[] = [];
    const turn = await runChatTurn({
      message,
      sandboxRoot: root,
      grokRunner: {
        async run(next) {
          argv = [...next];
          await writeSandboxFile(
            root,
            "src/math.ts",
            "export function add(left: number, right: number): number {\n  return left + right;\n}\n",
          );
          await writeSandboxFile(
            root,
            "src/math.test.ts",
            "import assert from \"node:assert/strict\";\nimport { add } from \"./math.js\";\nassert.equal(add(2, 3), 5);\n",
          );
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    assert.equal(argv[0], "grok");
    assert.ok((argv[argv.indexOf("-p") + 1] ?? "").includes(message));
    assert.ok(argv.includes("--cwd"));
    assert.ok(argv.includes(root));
    assert.ok(argv.includes("--output-format"));
    assert.ok(argv.includes("streaming-json"));
    assert.equal(turn.coding?.wrote, true);
    assert.equal(turn.coding?.via, "grok-build");
    assert.equal(turn.qa?.pass, true);
    assert.match(await readFile(path.join(root, "src/math.ts"), "utf8"), /function add/);
    assert.match(await readFile(path.join(root, "src/math.test.ts"), "utf8"), /add\(2, 3\)/);
    const planAt = turn.transcript.indexOf("Manager plan (local-manager):");
    const stoodAt = turn.transcript.indexOf("Stood up:");
    assert.ok(planAt >= 0 && planAt < stoodAt);
    assert.match(turn.transcript, /System-1: fallback/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real Laya status choice is the only plan OpenClaw stands up", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-laya-"));
  try {
    let sent: ManagerPlan | undefined;
    const turn = await runChatTurn({
      message: "add a README section explaining install",
      sandboxRoot: root,
      layaPredict: (message) =>
        routeWithPredict(message, async () => ({
          answers: {
            route: { choice: "status", probabilities: { status: 0.99, "multi-agent": 0.01 }, confidence: 0.99, rl_agent: "laya" },
            stand_up_computer: { noul: 0.01 },
            write_risk: { score: 0.1, legend: "none" },
          },
          routing: { model: "english" },
        })),
      orchestration: async (plan) => {
        sent = plan;
        return { state: "ran", driver: "openclaw", detail: "Session agent:board:main accepted the plan." };
      },
      grokRunner: {
        async run() {
          await writeSandboxFile(root, "README.md", "should-not\n");
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    assert.equal(sent?.source, "local-manager");
    assert.deepEqual(sent?.roles, []);
    assert.equal(sent?.sessionKey, "agent:board:main");
    assert.deepEqual(turn.agents, []);
    assert.equal(turn.coding, null);
    assert.match(turn.transcript, /System-1: real Laya/);
    assert.match(turn.transcript, /Manager plan \(openclaw\)/);
    await assert.rejects(readFile(path.join(root, "README.md"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the golden proof tree is what a multi-file coding turn writes", async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const math = await readFile(path.join(repoRoot, "examples/proof-multifile/src/math.ts"), "utf8");
  const spec = await readFile(path.join(repoRoot, "examples/proof-multifile/src/math.test.ts"), "utf8");
  const prompt = (await readFile(path.join(repoRoot, "examples/proof-multifile/PROMPT.txt"), "utf8")).trim();
  const sandbox = await mkdtemp(path.join(tmpdir(), "ocp-proof-"));
  try {
    const turn = await runChatTurn({
      message: prompt,
      sandboxRoot: sandbox,
      grokRunner: {
        async run(argv) {
          const sent = argv[argv.indexOf("-p") + 1] ?? "";
          assert.match(sent, /User request:/);
          assert.ok(sent.includes(prompt));
          await writeSandboxFile(sandbox, "src/math.ts", math);
          await writeSandboxFile(sandbox, "src/math.test.ts", spec);
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    assert.equal(turn.coding?.wrote, true);
    assert.equal(await readFile(path.join(sandbox, "src/math.ts"), "utf8"), math);
    assert.equal(await readFile(path.join(sandbox, "src/math.test.ts"), "utf8"), spec);
    assert.match(math, /export function add/);
    assert.match(turn.transcript, /gateway write tool writes a create-file/);
    assert.match(turn.transcript, /blocks fs_write/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an accepted plan writes a create-file through the OpenClaw write tool", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-remote-write-"));
  try {
    const content = "hello from openclaw\n";
    const turn = await runChatTurn({
      message: `Use Grok Build to create hello.txt with content:\n${content}`,
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          await writeSandboxFile(root, "hello.txt", "local-fallback\n");
          return { exitCode: 0, stdout: "" };
        },
      },
      openclawWrite: async (relativePath, bytes) => {
        await writeSandboxFile(root, relativePath, bytes);
        return { ok: true, detail: "wrote" };
      },
    });
    assert.equal(turn.coding?.wrote, true);
    assert.equal(turn.coding?.via, "openclaw-write");
    assert.equal(await readFile(path.join(root, "hello.txt"), "utf8"), content);
    assert.match(turn.transcript, /Write path: OpenClaw-driven/);
    assert.match(turn.transcript, /blocks fs_write/);
    assert.doesNotMatch(turn.transcript, /fs_write landed/);
    assert.equal(turn.qa?.pass, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a refused OpenClaw write does not land a local file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-remote-refuse-"));
  try {
    const turn = await runChatTurn({
      message: "Use Grok Build to create hello.txt with content:\nhello\n",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          await writeSandboxFile(root, "hello.txt", "should-not\n");
          return { exitCode: 0, stdout: "" };
        },
      },
      openclawWrite: async () => ({ ok: false, detail: "refused" }),
    });
    assert.equal(turn.coding?.wrote, false);
    assert.equal(turn.coding?.via, "openclaw-write");
    assert.match(turn.transcript, /did not land the file/);
    assert.match(turn.transcript, /did not write it locally/);
    await assert.rejects(readFile(path.join(root, "hello.txt"), "utf8"));
    assert.equal(turn.qa?.pass, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a general edit under an accepted plan lands only through the OpenClaw write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-remote-general-"));
  try {
    let stage = "";
    const turn = await runChatTurn({
      message: "add a README section explaining install",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run(argv) {
          const cwdFlag = argv.indexOf("--cwd");
          stage = argv[cwdFlag + 1] ?? "";
          await writeSandboxFile(stage, "README.md", "# Install\n");
          return { exitCode: 0, stdout: "" };
        },
      },
      openclawWrite: async (relativePath, bytes) => {
        await writeSandboxFile(root, relativePath, bytes);
        return { ok: true, detail: "bridge" };
      },
    });
    assert.notEqual(stage, root);
    assert.equal(turn.coding?.via, "openclaw-write");
    assert.equal(turn.coding?.wrote, true);
    assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "# Install\n");
    assert.match(turn.transcript, /Write path: OpenClaw-driven/);
    assert.doesNotMatch(turn.transcript, /Write path: local sandbox/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computer execute with a fake browser saves evidence and marks the action executed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-computer-live-"));
  try {
    const turn = await runChatTurn({
      message: "Stand up a computer agent and open https://example.com",
      sandboxRoot: root,
      computerExecute: true,
      computerAllowHosts: ["example.com"],
      browserDriver: {
        async start() {
          const png = Uint8Array.from([137, 80, 78, 71]);
          return {
            async open(url: string) {
              assert.equal(url, "https://example.com");
              return { title: "Example Domain", text: "hello", screenshotPng: png };
            },
            async readScreen() {
              return { title: "Example Domain", text: "hello", screenshotPng: png };
            },
            async typeInto() {
              return { title: "Example Domain", text: "hello", screenshotPng: png };
            },
            async close() {
              return undefined;
            },
          };
        },
      },
    });
    assert.equal(turn.computer?.actions[0]?.executed, true);
    assert.equal(turn.computer?.actions[1]?.executed, true);
    assert.match(turn.transcript, /Live browser opened https:\/\/example.com/);
    assert.match(turn.transcript, /executed: true/);
    const saved = JSON.parse(await readFile(path.join(root, "gtm/last-run.json"), "utf8")) as {
      title: string;
      steps: { executed: boolean }[];
    };
    assert.equal(saved.title, "Example Domain");
    assert.equal(saved.steps.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA fails a broken page claim and records the screenshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-qa-claim-"));
  try {
    const png = Uint8Array.from([137, 80, 78, 71]);
    const turn = await runChatTurn({
      message: 'Stand up a computer agent and a QA agent. Open https://example.com and expect title "Not the page"',
      sandboxRoot: root,
      computerExecute: true,
      computerAllowHosts: ["example.com"],
      browserDriver: {
        async start() {
          return {
            async open() {
              return { title: "Example Domain", text: "hello", screenshotPng: png };
            },
            async readScreen() {
              return { title: "Example Domain", text: "hello", screenshotPng: png };
            },
            async typeInto() {
              return { title: "Example Domain", text: "hello", screenshotPng: png };
            },
            async close() {
              return undefined;
            },
          };
        },
      },
    });
    assert.equal(turn.qa?.pass, false);
    assert.match(turn.qa?.summary ?? "", /did not hold/);
    assert.match(turn.transcript, /QA agent: fail/);
    const assertion = JSON.parse(await readFile(path.join(root, "gtm/assertion.json"), "utf8")) as { claimHeld: boolean };
    assert.equal(assertion.claimHeld, false);
    const run = JSON.parse(await readFile(path.join(root, "gtm/last-run.json"), "utf8")) as { steps: { executed: boolean }[] };
    assert.ok(run.steps.length >= 2);
    const shot = await readFile(path.join(root, "gtm/step-2.png"));
    assert.ok(shot.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA names a missing file snippet in the transcript", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-qa-snippet-"));
  try {
    const turn = await runChatTurn({
      message: 'add a README and expect file README.md to contain "Install"',
      sandboxRoot: root,
      grokRunner: {
        async run() {
          await writeSandboxFile(root, "README.md", "Hello\n");
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    assert.equal(turn.qa?.pass, false);
    assert.match(turn.transcript, /README.md is missing expected content/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed file expectation is rewritten once and then passes QA", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-fix-pass-"));
  try {
    let calls = 0;
    const turn = await runChatTurn({
      message: 'add a README and expect file README.md to contain "Install"',
      sandboxRoot: root,
      grokRunner: {
        async run() {
          calls += 1;
          await writeSandboxFile(root, "README.md", calls === 1 ? "Hello\n" : "Install\n");
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    assert.equal(calls, 2);
    assert.equal(turn.qa?.pass, true);
    assert.match(turn.transcript, /fix loop passed on retry 1/);
    assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Install\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file QA stops after two failed retries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-fix-stop-"));
  try {
    let calls = 0;
    const turn = await runChatTurn({
      message: 'add a README and expect file README.md to contain "Install"',
      sandboxRoot: root,
      grokRunner: {
        async run() {
          calls += 1;
          await writeSandboxFile(root, "README.md", "Hello\n");
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    assert.equal(calls, 3);
    assert.equal(turn.qa?.pass, false);
    assert.match(turn.transcript, /fix budget exhausted after 2 retries/);
    assert.match(turn.transcript, /missing expected content/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed page claim is checked again and stops when the budget is used", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-fix-page-"));
  try {
    const png = Uint8Array.from([137, 80, 78, 71]);
    let starts = 0;
    const driver = {
      async start() {
        starts += 1;
        const title = starts === 1 ? "Wrong" : "Example Domain";
        return {
          async open() {
            return { title, text: "hello", screenshotPng: png };
          },
          async readScreen() {
            return { title, text: "hello", screenshotPng: png };
          },
          async typeInto() {
            return { title, text: "hello", screenshotPng: png };
          },
          async close() {
            return undefined;
          },
        };
      },
    };
    const passed = await runChatTurn({
      message: 'Stand up a computer agent and a QA agent. Open https://example.com and expect title "Example Domain"',
      sandboxRoot: root,
      computerExecute: true,
      computerAllowHosts: ["example.com"],
      browserDriver: driver,
    });
    assert.equal(starts, 2);
    assert.equal(passed.qa?.pass, true);
    assert.match(passed.transcript, /fix loop passed on retry 1/);

    const stuck = await mkdtemp(path.join(tmpdir(), "ocp-fix-page-stuck-"));
    let stuckStarts = 0;
    const failed = await runChatTurn({
      message: 'Stand up a computer agent and a QA agent. Open https://example.com and expect title "Example Domain"',
      sandboxRoot: stuck,
      computerExecute: true,
      computerAllowHosts: ["example.com"],
      browserDriver: {
        async start() {
          stuckStarts += 1;
          return {
            async open() {
              return { title: "Wrong", text: "hello", screenshotPng: png };
            },
            async readScreen() {
              return { title: "Wrong", text: "hello", screenshotPng: png };
            },
            async typeInto() {
              return { title: "Wrong", text: "hello", screenshotPng: png };
            },
            async close() {
              return undefined;
            },
          };
        },
      },
    });
    assert.equal(stuckStarts, 3);
    assert.equal(failed.qa?.pass, false);
    assert.match(failed.transcript, /fix budget exhausted after 2 retries/);
    await rm(stuck, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn reads a file, patches it, and retries a failed check", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-tools-"));
  try {
    await writeSandboxFile(root, "src/math.ts", "export function add(left: number, right: number): number {\n  return left - right;\n}\n");
    let calls = 0;
    let checks = 0;
    const turn = await runChatTurn({
      message: "fix add and run node --test src/math.test.ts",
      sandboxRoot: root,
      checkExec: async (argv) => {
        checks += 1;
        assert.deepEqual(argv, ["node", "--test", "src/math.test.ts"]);
        return checks === 1
          ? { code: 1, stdout: "", stderr: "expected 5" }
          : { code: 0, stdout: "pass", stderr: "" };
      },
      grokRunner: {
        async run() {
          calls += 1;
          if (calls === 1) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                steps: [
                  { tool: "read", path: "src/math.ts" },
                  { tool: "run", argv: ["node", "--test", "src/math.test.ts"] },
                ],
              }),
            };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              steps: [
                {
                  tool: "patch",
                  path: "src/math.ts",
                  diff: "--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1,3 +1,3 @@\n export function add(left: number, right: number): number {\n-  return left - right;\n+  return left + right;\n }\n",
                },
                { tool: "run", argv: ["node", "--test", "src/math.test.ts"] },
              ],
            }),
          };
        },
      },
    });
    assert.equal(calls, 2);
    assert.equal(checks, 2);
    assert.equal(turn.qa?.pass, true);
    assert.match(turn.transcript, /Tool: read src\/math.ts/);
    assert.match(turn.transcript, /Tool: patch src\/math.ts/);
    assert.match(turn.transcript, /Round 1/);
    assert.match(turn.transcript, /Round 2/);
    assert.match(turn.transcript, /Tool: run node --test src\/math.test.ts \(exit 1\)/);
    assert.match(turn.transcript, /exit 0/);
    assert.match(await readFile(path.join(root, "src/math.ts"), "utf8"), /return left \+ right/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn can list for six rounds and then write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-rounds-"));
  try {
    let calls = 0;
    const turn = await runChatTurn({
      message: "add a note after looking around",
      sandboxRoot: root,
      grokRunner: {
        async run() {
          calls += 1;
          if (calls < 6) {
            return { exitCode: 0, stdout: JSON.stringify({ steps: [{ tool: "list", path: "." }] }) };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "write", path: "note.txt", content: "ok\n" }] }),
          };
        },
      },
    });
    assert.equal(calls, 6);
    assert.match(turn.transcript, /Round 6/);
    assert.doesNotMatch(turn.transcript, /Round 7/);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "ok\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn writes a file and then deletes it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-delete-turn-"));
  try {
    const turn = await runChatTurn({
      message: "refactor and remove the old helper",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (!prompt.includes("Tool observations:\n")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ steps: [{ tool: "write", path: "src/old.ts", content: "export const old = 1;\n" }] }),
            };
          }
          assert.match(prompt, /Tool: write src\/old.ts/);
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "delete", path: "src/old.ts" }] }),
          };
        },
      },
    });
    assert.match(turn.transcript, /Tool: write src\/old.ts/);
    assert.match(turn.transcript, /Tool: delete src\/old.ts/);
    assert.match(turn.transcript, /Delete path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /OpenClaw-driven/);
    await assert.rejects(readFile(path.join(root, "src/old.ts"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pnpm test is allowed and a failed check still retries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-pnpm-test-"));
  try {
    const seen: string[][] = [];
    let checks = 0;
    const turn = await runChatTurn({
      message: "fix the suite and run pnpm test",
      sandboxRoot: root,
      checkExec: async (argv, cwd) => {
        seen.push([...argv]);
        assert.equal(cwd, root);
        checks += 1;
        return checks === 1 ? { code: 1, stdout: "", stderr: "1 failed" } : { code: 0, stdout: "pass", stderr: "" };
      },
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (prompt.includes("QA failed")) {
            return { exitCode: 0, stdout: JSON.stringify({ done: true, steps: [{ tool: "run", argv: ["pnpm", "test"] }] }) };
          }
          if (prompt.includes("Tool observations:\n")) return { exitCode: 0, stdout: JSON.stringify({ done: true }) };
          return { exitCode: 0, stdout: JSON.stringify({ steps: [{ tool: "run", argv: ["pnpm", "test"] }] }) };
        },
      },
    });
    assert.deepEqual(seen[0], ["pnpm", "test"]);
    assert.equal(checks, 2);
    assert.match(turn.transcript, /Tool: run pnpm test \(exit 1\)/);
    assert.match(turn.transcript, /fix loop passed on retry 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git status and git diff run, and git commit is refused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-git-run-"));
  try {
    const seen: string[][] = [];
    const turn = await runChatTurn({
      message: "fix the note and show git status",
      sandboxRoot: root,
      checkExec: async (argv) => {
        seen.push([...argv]);
        if (argv[1] === "diff") return { code: 0, stdout: `${"x".repeat(2500)}\n`, stderr: "" };
        return { code: 0, stdout: "## main\n", stderr: "" };
      },
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                { tool: "run", argv: ["git", "status", "-sb"] },
                { tool: "run", argv: ["git", "commit", "-m", "nope"] },
                { tool: "run", argv: ["git", "diff", "src/math.ts"] },
              ],
            }),
          };
        },
      },
    });
    assert.deepEqual(seen, [
      ["git", "status", "-sb"],
      ["git", "diff", "src/math.ts"],
    ]);
    assert.match(turn.transcript, /Tool: run git status -sb \(exit 0\)/);
    assert.match(turn.transcript, /Tool: run refused/);
    assert.match(turn.transcript, /Tool: run git diff src\/math.ts \(exit 0, truncated\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git log --oneline -n runs, and a wide log is refused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-git-log-"));
  try {
    const seen: string[][] = [];
    const turn = await runChatTurn({
      message: "fix the note and show git log",
      sandboxRoot: root,
      checkExec: async (argv) => {
        seen.push([...argv]);
        return { code: 0, stdout: "abc123 note\n", stderr: "" };
      },
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [{ tool: "run", argv: ["git", "log", "--oneline", "-n", "5"] }],
            }),
          };
        },
      },
    });
    assert.deepEqual(seen, [["git", "log", "--oneline", "-n", "5"]]);
    assert.match(turn.transcript, /Tool: run git log --oneline -n 5 \(exit 0\)/);
    const refused = await runChatTurn({
      message: "fix the note and refuse a long git log",
      sandboxRoot: root,
      checkExec: async () => {
        throw new Error("refused log must not run");
      },
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (prompt.includes("QA failed")) return { exitCode: 0, stdout: JSON.stringify({ done: true, steps: [] }) };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [{ tool: "run", argv: ["git", "log", "--oneline", "-n", "50"] }],
            }),
          };
        },
      },
    });
    assert.match(refused.transcript, /Tool: run refused/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git show HEAD:path runs, and other show forms are refused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-git-show-"));
  try {
    const seen: string[][] = [];
    const turn = await runChatTurn({
      message: "fix the note and show the file at HEAD",
      sandboxRoot: root,
      checkExec: async (argv) => {
        seen.push([...argv]);
        return { code: 0, stdout: `${"x".repeat(2500)}\n`, stderr: "" };
      },
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [{ tool: "run", argv: ["git", "show", "HEAD:src/math.ts"] }],
            }),
          };
        },
      },
    });
    assert.deepEqual(seen, [["git", "show", "HEAD:src/math.ts"]]);
    assert.match(turn.transcript, /Tool: run git show HEAD:src\/math.ts \(exit 0, truncated\)/);
    const refused = await runChatTurn({
      message: "fix the note and refuse a bad git show",
      sandboxRoot: root,
      checkExec: async () => {
        throw new Error("refused show must not run");
      },
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (prompt.includes("QA failed")) return { exitCode: 0, stdout: JSON.stringify({ done: true, steps: [] }) };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                { tool: "run", argv: ["git", "show", "main:src/math.ts"] },
                { tool: "run", argv: ["git", "show", "HEAD:../secret.ts"] },
                { tool: "run", argv: ["git", "show", "--stat", "HEAD:src/math.ts"] },
              ],
            }),
          };
        },
      },
    });
    assert.match(refused.transcript, /Tool: run refused/);
    assert.doesNotMatch(refused.transcript, /exit 0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn writes a file and then renames it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-rename-turn-"));
  try {
    const turn = await runChatTurn({
      message: "refactor the helper into src/lib",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (!prompt.includes("Tool observations:\n")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ steps: [{ tool: "write", path: "src/old.ts", content: "export const old = 1;\n" }] }),
            };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "rename", path: "src/old.ts", to: "src/lib/old.ts" }] }),
          };
        },
      },
    });
    assert.match(turn.transcript, /Tool: rename src\/old.ts → src\/lib\/old.ts/);
    assert.match(turn.transcript, /Rename path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /Rename path: OpenClaw-driven/);
    await assert.rejects(readFile(path.join(root, "src/old.ts"), "utf8"));
    assert.match(await readFile(path.join(root, "src/lib/old.ts"), "utf8"), /export const old/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn copies a file and leaves the source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-copy-turn-"));
  try {
    const turn = await runChatTurn({
      message: "refactor a copy of the helper into src/lib",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (!prompt.includes("Tool observations:\n")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ steps: [{ tool: "write", path: "src/old.ts", content: "export const old = 1;\n" }] }),
            };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                { tool: "copy", path: "src/old.ts", to: "src/lib/old.ts" },
                { tool: "copy", path: "src/old.ts", to: "../outside.ts" },
              ],
            }),
          };
        },
      },
    });
    assert.match(turn.transcript, /Tool: copy src\/old.ts → src\/lib\/old.ts/);
    assert.match(turn.transcript, /Tool: copy src\/old.ts → \.\.\/outside.ts/);
    assert.match(turn.transcript, /Copy path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /Copy path: OpenClaw/);
    assert.match(await readFile(path.join(root, "src/old.ts"), "utf8"), /export const old/);
    assert.match(await readFile(path.join(root, "src/lib/old.ts"), "utf8"), /export const old/);
    await assert.rejects(readFile(path.join(root, "../outside.ts"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an OpenClaw-driven turn copies a file through the bridge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-remote-copy-"));
  try {
    await writeSandboxFile(root, "src/old.ts", "export const old = 1;\n");
    const calls: string[] = [];
    const turn = await runChatTurn({
      message: "refactor a copy of the helper",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "copy", path: "src/old.ts", to: "src/lib/old.ts" }] }),
          };
        },
      },
      openclawCopy: async (fromPath, toPath) => {
        calls.push(`${fromPath} ${toPath}`);
        const { copyFile, mkdir } = await import("node:fs/promises");
        await mkdir(path.join(root, "src/lib"), { recursive: true });
        await copyFile(path.join(root, fromPath), path.join(root, toPath));
        return { ok: true, missing: false, detail: "bridge" };
      },
    });
    assert.deepEqual(calls, ["src/old.ts src/lib/old.ts"]);
    assert.match(turn.transcript, /Copy path: OpenClaw-driven/);
    assert.doesNotMatch(turn.transcript, /Copy path: local sandbox/);
    assert.match(await readFile(path.join(root, "src/old.ts"), "utf8"), /export const old/);
    assert.match(await readFile(path.join(root, "src/lib/old.ts"), "utf8"), /export const old/);

    const blocked = await mkdtemp(path.join(tmpdir(), "ocp-copy-refuse-"));
    await writeSandboxFile(blocked, "src/old.ts", "export const old = 1;\n");
    const refused = await runChatTurn({
      message: "refactor a copy of the helper",
      sandboxRoot: blocked,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "copy", path: "src/old.ts", to: "src/lib/old.ts" }] }),
          };
        },
      },
      openclawCopy: async () => ({ ok: false, missing: false, detail: "target already exists" }),
    });
    assert.doesNotMatch(refused.transcript, /Copy path: local sandbox/);
    assert.doesNotMatch(refused.transcript, /Copy path: OpenClaw-driven/);
    await assert.rejects(readFile(path.join(blocked, "src/lib/old.ts"), "utf8"));
    await rm(blocked, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing OpenClaw copy plugin falls back to the local sandbox", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-copy-fallback-"));
  try {
    await writeSandboxFile(root, "src/old.ts", "export const old = 1;\n");
    const turn = await runChatTurn({
      message: "refactor a copy of the helper",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "copy", path: "src/old.ts", to: "src/lib/old.ts" }] }),
          };
        },
      },
      openclawCopy: async () => ({ ok: false, missing: true, detail: "plugin missing" }),
    });
    assert.match(turn.transcript, /Copy path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /Copy path: OpenClaw-driven/);
    assert.match(await readFile(path.join(root, "src/old.ts"), "utf8"), /export const old/);
    assert.match(await readFile(path.join(root, "src/lib/old.ts"), "utf8"), /export const old/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an OpenClaw-driven turn deletes and renames through the bridge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-remote-move-"));
  try {
    await writeSandboxFile(root, "src/old.ts", "export const old = 1;\n");
    await writeSandboxFile(root, "src/keep.ts", "export const keep = 1;\n");
    const calls: string[] = [];
    const turn = await runChatTurn({
      message: "refactor the helpers",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                { tool: "delete", path: "src/old.ts" },
                { tool: "rename", path: "src/keep.ts", to: "src/lib/keep.ts" },
              ],
            }),
          };
        },
      },
      openclawDelete: async (relativePath) => {
        calls.push(`delete ${relativePath}`);
        await rm(path.join(root, relativePath));
        return { ok: true, missing: false, detail: "bridge" };
      },
      openclawRename: async (fromPath, toPath) => {
        calls.push(`rename ${fromPath} ${toPath}`);
        const { rename, mkdir } = await import("node:fs/promises");
        await mkdir(path.join(root, "src/lib"), { recursive: true });
        await rename(path.join(root, fromPath), path.join(root, toPath));
        return { ok: true, missing: false, detail: "bridge" };
      },
    });
    assert.deepEqual(calls, ["delete src/old.ts", "rename src/keep.ts src/lib/keep.ts"]);
    assert.match(turn.transcript, /Delete path: OpenClaw-driven/);
    assert.match(turn.transcript, /Rename path: OpenClaw-driven/);
    assert.doesNotMatch(turn.transcript, /Delete path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /Rename path: local sandbox/);
    await assert.rejects(readFile(path.join(root, "src/old.ts"), "utf8"));
    await assert.rejects(readFile(path.join(root, "src/keep.ts"), "utf8"));
    assert.match(await readFile(path.join(root, "src/lib/keep.ts"), "utf8"), /export const keep/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing OpenClaw delete plugin falls back to the local sandbox", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-delete-fallback-"));
  try {
    await writeSandboxFile(root, "src/old.ts", "export const old = 1;\n");
    const turn = await runChatTurn({
      message: "refactor and remove the old helper",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "delete", path: "src/old.ts" }] }),
          };
        },
      },
      openclawDelete: async () => ({ ok: false, missing: true, detail: "plugin missing" }),
    });
    assert.match(turn.transcript, /Delete path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /Delete path: OpenClaw-driven/);
    await assert.rejects(readFile(path.join(root, "src/old.ts"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an OpenClaw-driven turn creates a directory through the bridge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-remote-mkdir-"));
  try {
    const calls: string[] = [];
    const turn = await runChatTurn({
      message: "add a helper folder",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "mkdir", path: "src/lib" }] }),
          };
        },
      },
      openclawMkdir: async (relativePath) => {
        calls.push(relativePath);
        const { mkdir } = await import("node:fs/promises");
        await mkdir(path.join(root, relativePath), { recursive: true });
        return { ok: true, missing: false, detail: "bridge" };
      },
    });
    assert.deepEqual(calls, ["src/lib"]);
    assert.match(turn.transcript, /Mkdir path: OpenClaw-driven/);
    assert.doesNotMatch(turn.transcript, /Mkdir path: local sandbox/);
    const { stat } = await import("node:fs/promises");
    assert.equal((await stat(path.join(root, "src/lib"))).isDirectory(), true);

    const blocked = await mkdtemp(path.join(tmpdir(), "ocp-mkdir-refuse-"));
    const refused = await runChatTurn({
      message: "add a helper folder",
      sandboxRoot: blocked,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "mkdir", path: "src/kept" }] }),
          };
        },
      },
      openclawMkdir: async () => ({ ok: false, missing: false, detail: "blocked (path escape)" }),
    });
    assert.doesNotMatch(refused.transcript, /Mkdir path: local sandbox/);
    assert.doesNotMatch(refused.transcript, /Mkdir path: OpenClaw-driven/);
    await assert.rejects(stat(path.join(blocked, "src/kept")));
    await rm(blocked, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing OpenClaw mkdir plugin falls back to the local sandbox", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-mkdir-fallback-"));
  try {
    const turn = await runChatTurn({
      message: "add a helper folder",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "mkdir", path: "src/lib" }] }),
          };
        },
      },
      openclawMkdir: async () => ({ ok: false, missing: true, detail: "plugin missing" }),
    });
    assert.match(turn.transcript, /Mkdir path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /Mkdir path: OpenClaw-driven/);
    const { stat } = await import("node:fs/promises");
    assert.equal((await stat(path.join(root, "src/lib"))).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an OpenClaw-driven turn removes an empty directory through the bridge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-remote-rmdir-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "src/empty"), { recursive: true });
    const calls: string[] = [];
    const turn = await runChatTurn({
      message: "fix the empty folder",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "rmdir", path: "src/empty" }] }),
          };
        },
      },
      openclawRmdir: async (relativePath) => {
        calls.push(relativePath);
        const { rmdir } = await import("node:fs/promises");
        await rmdir(path.join(root, relativePath));
        return { ok: true, missing: false, detail: "bridge" };
      },
    });
    assert.deepEqual(calls, ["src/empty"]);
    assert.match(turn.transcript, /Rmdir path: OpenClaw-driven/);
    assert.doesNotMatch(turn.transcript, /Rmdir path: local sandbox/);
    const { stat } = await import("node:fs/promises");
    await assert.rejects(stat(path.join(root, "src/empty")));

    const blocked = await mkdtemp(path.join(tmpdir(), "ocp-rmdir-refuse-"));
    await mkdir(path.join(blocked, "src/kept"), { recursive: true });
    const refused = await runChatTurn({
      message: "fix the empty folder",
      sandboxRoot: blocked,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "rmdir", path: "src/kept" }] }),
          };
        },
      },
      openclawRmdir: async () => ({ ok: false, missing: false, detail: "directory is not empty" }),
    });
    assert.doesNotMatch(refused.transcript, /Rmdir path: local sandbox/);
    assert.doesNotMatch(refused.transcript, /Rmdir path: OpenClaw-driven/);
    assert.equal((await stat(path.join(blocked, "src/kept"))).isDirectory(), true);
    await rm(blocked, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing OpenClaw rmdir plugin falls back to the local sandbox", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-rmdir-fallback-"));
  try {
    const { mkdir, stat } = await import("node:fs/promises");
    await mkdir(path.join(root, "src/empty"), { recursive: true });
    const turn = await runChatTurn({
      message: "fix the empty folder",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "rmdir", path: "src/empty" }] }),
          };
        },
      },
      openclawRmdir: async () => ({ ok: false, missing: true, detail: "plugin missing" }),
    });
    assert.match(turn.transcript, /Rmdir path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /Rmdir path: OpenClaw-driven/);
    await assert.rejects(stat(path.join(root, "src/empty")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn creates a directory and then writes a file in it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-mkdir-turn-"));
  try {
    const turn = await runChatTurn({
      message: "add a helper under src/lib",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (!prompt.includes("Tool observations:\n")) {
            return { exitCode: 0, stdout: JSON.stringify({ steps: [{ tool: "mkdir", path: "src/lib" }] }) };
          }
          assert.match(prompt, /Tool: mkdir src\/lib/);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [{ tool: "write", path: "src/lib/helper.ts", content: "export const helper = 1;\n" }],
            }),
          };
        },
      },
    });
    assert.match(turn.transcript, /Tool: mkdir src\/lib/);
    assert.match(turn.transcript, /Mkdir path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /OpenClaw-driven/);
    assert.match(await readFile(path.join(root, "src/lib/helper.ts"), "utf8"), /export const helper/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn removes an empty directory it just made", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-rmdir-turn-"));
  try {
    const turn = await runChatTurn({
      message: "fix the empty folder",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (!prompt.includes("Tool observations:\n")) {
            return { exitCode: 0, stdout: JSON.stringify({ steps: [{ tool: "mkdir", path: "src/empty" }] }) };
          }
          assert.match(prompt, /Tool: mkdir src\/empty/);
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "rmdir", path: "src/empty" }] }),
          };
        },
      },
    });
    assert.match(turn.transcript, /Tool: rmdir src\/empty/);
    assert.match(turn.transcript, /Rmdir path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /OpenClaw-driven/);
    const { stat } = await import("node:fs/promises");
    await assert.rejects(stat(path.join(root, "src/empty")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn adds two todos and completes one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-todo-turn-"));
  try {
    const turn = await runChatTurn({
      message: "fix the checklist",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (!prompt.includes("Tool observations:\n")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                steps: [
                  { tool: "todo", action: "add", content: "write the test" },
                  { tool: "todo", action: "add", content: "patch add" },
                ],
              }),
            };
          }
          assert.match(prompt, /Todo: add write the test/);
          assert.match(prompt, /Todos:/);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                { tool: "todo", action: "complete", content: "1" },
                { tool: "todo", action: "add", content: "../secret" },
              ],
            }),
          };
        },
      },
    });
    assert.match(turn.transcript, /Todo: add write the test/);
    assert.match(turn.transcript, /Todo: add patch add/);
    assert.match(turn.transcript, /Todo: complete 1/);
    assert.match(turn.transcript, /Todo: add \(todo text refused\)/);
    assert.match(turn.transcript, /Todos:\n1\. \[done\] write the test\n2\. \[open\] patch add/);
    const stored = JSON.parse(await readFile(path.join(root, ".ocp/todos.json"), "utf8")) as { todos: { done: boolean; text: string }[] };
    assert.equal(stored.todos[0]?.done, true);
    assert.equal(stored.todos[1]?.done, false);
    assert.equal(stored.todos.some((item) => item.text.includes("../")), false);
    const listed = await listSandboxDir(root, ".");
    assert.doesNotMatch(listed.detail, /\.ocp/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn globs a pattern and patches only the hit file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-glob-turn-"));
  try {
    await writeSandboxFile(root, "src/math.ts", "export function add(left: number, right: number): number {\n  return left - right;\n}\n");
    await writeSandboxFile(root, "src/other.js", "export const other = 1;\n");
    const turn = await runChatTurn({
      message: "fix add",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (!prompt.includes("Tool observations:\n")) {
            return { exitCode: 0, stdout: JSON.stringify({ steps: [{ tool: "glob", query: "src/**/*.ts" }] }) };
          }
          assert.match(prompt, /src\/math.ts/);
          assert.doesNotMatch(prompt, /other.js/);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                {
                  tool: "patch",
                  path: "src/math.ts",
                  diff: "--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1,3 +1,3 @@\n export function add(left: number, right: number): number {\n-  return left - right;\n+  return left + right;\n }\n",
                },
              ],
            }),
          };
        },
      },
    });
    assert.match(turn.transcript, /Tool: glob src\/\*\*\/\*\.ts/);
    assert.match(await readFile(path.join(root, "src/math.ts"), "utf8"), /return left \+ right/);
    assert.match(await readFile(path.join(root, "src/other.js"), "utf8"), /other/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn greps for a symbol and patches only the hit file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-grep-turn-"));
  try {
    await writeSandboxFile(root, "src/math.ts", "export function add(left: number, right: number): number {\n  return left - right;\n}\n");
    await writeSandboxFile(root, "src/other.ts", "export function sub(left: number, right: number): number {\n  return left - right;\n}\n");
    await writeSandboxFile(root, "src/secret.ts", "password=hunter2\nfunction add\n");
    const prompts: string[] = [];
    const turn = await runChatTurn({
      message: "fix add",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          prompts.push(prompt);
          if (!prompt.includes("Tool observations:\n")) {
            return { exitCode: 0, stdout: JSON.stringify({ steps: [{ tool: "grep", query: "function add" }] }) };
          }
          assert.match(prompt, /src\/math.ts:1:/);
          assert.doesNotMatch(prompt, /src\/other.ts/);
          assert.doesNotMatch(prompt, /hunter2/);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                {
                  tool: "patch",
                  path: "src/math.ts",
                  diff: "--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1,3 +1,3 @@\n export function add(left: number, right: number): number {\n-  return left - right;\n+  return left + right;\n }\n",
                },
              ],
            }),
          };
        },
      },
    });
    assert.equal(prompts.length, 2);
    assert.match(turn.transcript, /Tool: grep function add/);
    assert.match(await readFile(path.join(root, "src/math.ts"), "utf8"), /return left \+ right/);
    assert.match(await readFile(path.join(root, "src/other.ts"), "utf8"), /return left - right/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn patches only after it sees the read result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-observe-"));
  try {
    await writeSandboxFile(root, "src/math.ts", "export function add(left: number, right: number): number {\n  return left - right;\n}\n");
    const prompts: string[] = [];
    const turn = await runChatTurn({
      message: "fix add",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          prompts.push(prompt);
          if (prompts.length === 1) {
            return { exitCode: 0, stdout: JSON.stringify({ steps: [{ tool: "read", path: "src/math.ts" }] }) };
          }
          assert.match(prompt, /Tool observations:\n/);
          assert.match(prompt, /return left - right/);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                {
                  tool: "patch",
                  path: "src/math.ts",
                  diff: "--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1,3 +1,3 @@\n export function add(left: number, right: number): number {\n-  return left - right;\n+  return left + right;\n }\n",
                },
              ],
            }),
          };
        },
      },
    });
    assert.equal(prompts.length, 2);
    assert.match(turn.transcript, /Round 1/);
    assert.match(turn.transcript, /Round 2/);
    assert.match(turn.transcript, /Tool: read src\/math.ts/);
    assert.match(turn.transcript, /Tool: patch src\/math.ts/);
    assert.match(await readFile(path.join(root, "src/math.ts"), "utf8"), /return left \+ right/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed check still uses the fix loop after tool rounds stop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-tool-fix-"));
  try {
    let checks = 0;
    const turn = await runChatTurn({
      message: "fix the test and run node --test src/math.test.ts",
      sandboxRoot: root,
      checkExec: async () => {
        checks += 1;
        return checks === 1 ? { code: 1, stdout: "", stderr: "expected 5" } : { code: 0, stdout: "pass", stderr: "" };
      },
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (prompt.includes("QA failed")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                done: true,
                steps: [{ tool: "run", argv: ["node", "--test", "src/math.test.ts"] }],
              }),
            };
          }
          if (prompt.includes("Tool observations:\n")) return { exitCode: 0, stdout: JSON.stringify({ done: true }) };
          return {
            exitCode: 0,
            stdout: JSON.stringify({ steps: [{ tool: "run", argv: ["node", "--test", "src/math.test.ts"] }] }),
          };
        },
      },
    });
    assert.equal(checks, 2);
    assert.equal(turn.qa?.pass, true);
    assert.match(turn.transcript, /fix loop passed on retry 1/);
    assert.match(turn.transcript, /Tool: run node --test src\/math.test.ts \(exit 1\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an OpenClaw-driven tool write uses the write bridge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-tools-bridge-"));
  try {
    const writes: string[] = [];
    const turn = await runChatTurn({
      message: "add src/note.txt",
      sandboxRoot: root,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [{ tool: "write", path: "src/note.txt", content: "from the bridge\n" }],
            }),
          };
        },
      },
      openclawWrite: async (relativePath, bytes) => {
        writes.push(relativePath);
        await writeSandboxFile(root, relativePath, bytes);
        return { ok: true, detail: "bridge" };
      },
    });
    assert.deepEqual(writes, ["src/note.txt"]);
    assert.equal(turn.coding?.via, "openclaw-write");
    assert.match(turn.transcript, /Tool: write src\/note.txt/);
    assert.match(turn.transcript, /Write path: OpenClaw-driven/);
    assert.equal(await readFile(path.join(root, "src/note.txt"), "utf8"), "from the bridge\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a follow-up turn sees the files from the previous turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-multi-"));
  try {
    const prompts: string[] = [];
    const runner = {
      async run(argv: readonly string[]) {
        const prompt = argv[argv.indexOf("-p") + 1] ?? "";
        prompts.push(prompt);
        const request = prompt.split("User request:\n").pop()?.split("\nReply with JSON")[0] ?? prompt;
        if (request.includes("create the add function")) {
          await writeSandboxFile(root, "src/math.ts", "export function add(left: number, right: number): number {\n  return left + right;\n}\n");
        } else if (request.includes("add tests")) {
          assert.match(prompt, /export function add/);
          await writeSandboxFile(root, "src/math.test.ts", "import { add } from \"./math.js\";\nimport assert from \"node:assert/strict\";\nassert.equal(add(2, 3), 4);\n");
        } else if (request.includes("fix the failing assert")) {
          assert.match(prompt, /assert.equal\(add\(2, 3\), 4\)/);
          await writeSandboxFile(root, "src/math.test.ts", "import { add } from \"./math.js\";\nimport assert from \"node:assert/strict\";\nassert.equal(add(2, 3), 5);\n");
        }
        return { exitCode: 0, stdout: "" };
      },
    };
    const first = await runChatTurn({ message: "create the add function in src/math.ts", sandboxRoot: root, grokRunner: runner });
    await writeSandboxFile(root, "notes.txt", "password=hunter2\n");
    const second = await runChatTurn({ message: "add tests in src/math.test.ts that import from math", sandboxRoot: root, grokRunner: runner });
    const third = await runChatTurn({ message: "fix the failing assert", sandboxRoot: root, grokRunner: runner });
    assert.equal(first.session.key, second.session.key);
    assert.match(first.transcript, /Meter: Grok Build/);
    assert.match(second.transcript, /Meter: Grok Build/);
    assert.match(third.transcript, /Meter: Grok Build/);
    assert.match(prompts[1] ?? "", /Sandbox files already on disk/);
    assert.match(prompts[1] ?? "", /src\/math.ts/);
    assert.doesNotMatch(prompts[1] ?? "", /hunter2/);
    assert.equal(await readFile(path.join(root, "src/math.ts"), "utf8"), "export function add(left: number, right: number): number {\n  return left + right;\n}\n");
    assert.match(await readFile(path.join(root, "src/math.test.ts"), "utf8"), /add\(2, 3\), 5\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a follow-up prompt remembers the prior user text and drops a blocked secret", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-memory-"));
  const other = await mkdtemp(path.join(tmpdir(), "ocp-memory-other-"));
  try {
    const prompts: string[] = [];
    const runner = {
      async run(argv: readonly string[]) {
        const prompt = argv[argv.indexOf("-p") + 1] ?? "";
        prompts.push(prompt);
        if (prompt.includes("add a README section explaining install") && !prompt.includes("Prior turns:")) {
          await writeSandboxFile(root, "README.md", "# Install\n");
          await writeSandboxFile(root, "secret.txt", "password=hunter2\n");
        }
        return { exitCode: 0, stdout: "" };
      },
    };
    await runChatTurn({ message: "add a README section explaining install", sandboxRoot: root, grokRunner: runner });
    await runChatTurn({ message: "also add subtract", sandboxRoot: root, grokRunner: runner });
    const second = prompts[1] ?? "";
    assert.match(second, /Prior turns:/);
    assert.match(second, /add a README section explaining install/);
    assert.doesNotMatch(second, /hunter2/);
    prompts.length = 0;
    await runChatTurn({ message: "add a note in other.txt", sandboxRoot: other, grokRunner: runner });
    assert.doesNotMatch(prompts[0] ?? "", /add a README section explaining install/);
    assert.doesNotMatch(prompts[0] ?? "", /hunter2/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("prior turns survive a fresh process and stay inside one sandbox", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-disk-"));
  const other = await mkdtemp(path.join(tmpdir(), "ocp-disk-other-"));
  try {
    const prompts: string[] = [];
    const runner = {
      async run(argv: readonly string[]) {
        const prompt = argv[argv.indexOf("-p") + 1] ?? "";
        prompts.push(prompt);
        if (prompt.includes("add a README section explaining install") && !prompt.includes("Prior turns:")) {
          await writeSandboxFile(root, "README.md", "# Install\n");
          await writeSandboxFile(root, "secret.txt", "password=hunter2\n");
        }
        return { exitCode: 0, stdout: "" };
      },
    };
    await runChatTurn({ message: "add a README section explaining install", sandboxRoot: root, grokRunner: runner });
    const saved = await readFile(path.join(root, ".ocp", "prior-turns.json"), "utf8");
    assert.match(saved, /add a README section explaining install/);
    assert.doesNotMatch(saved, /hunter2/);
    const listed = await listSandboxDir(root, ".");
    assert.doesNotMatch(listed.detail, /\.ocp/);
    const found = await grepSandbox(root, "README section");
    assert.equal(found.detail, "(no matches)");
    clearSessionMemory();
    prompts.length = 0;
    await runChatTurn({ message: "also add subtract", sandboxRoot: root, grokRunner: runner });
    assert.match(prompts[0] ?? "", /Prior turns:/);
    assert.match(prompts[0] ?? "", /add a README section explaining install/);
    assert.doesNotMatch(prompts[0] ?? "", /hunter2/);
    prompts.length = 0;
    await runChatTurn({ message: "add a note in other.txt", sandboxRoot: other, grokRunner: runner });
    assert.doesNotMatch(prompts[0] ?? "", /add a README section explaining install/);
    const otherSaved = await readFile(path.join(other, ".ocp", "prior-turns.json"), "utf8");
    assert.match(otherSaved, /add a note in other.txt/);
    assert.doesNotMatch(otherSaved, /add a README section explaining install/);
    assert.doesNotMatch(otherSaved, /hunter2/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("demo command path writes the product file and blocks the secret", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-demo-"));
  try {
    const demo = await runDemo(root);
    assert.equal(demo.code, 0);
    assert.match(demo.transcript, /coding agent/);
    assert.match(demo.transcript, /QA agent/);
    assert.match(demo.transcript, /security agent/);
    assert.match(demo.transcript, /computer agent/);
    assert.match(demo.transcript, /executed: false/);
    assert.match(demo.transcript, /blocked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
