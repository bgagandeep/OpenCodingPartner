import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { routeWithPredict, type ManagerPlan } from "@opencodingpartner/policy";
import { writeSandboxFile } from "@opencodingpartner/workers";
import { DEMO_MESSAGE, runChatTurn, runDemo } from "./index.js";

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
    assert.match(turn.transcript, /General edits need XAI_API_KEY/);
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
    assert.ok(prompts.includes("add a README section explaining install"));
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
    assert.match(turn.transcript, /OpenClaw does not write sandbox files/);
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
    assert.ok(argv.includes(message));
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
          assert.ok(argv.includes(prompt));
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
    assert.match(turn.transcript, /OpenClaw does not write sandbox files/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
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
