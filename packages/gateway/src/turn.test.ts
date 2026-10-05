import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { routeWithPredict, type ManagerPlan } from "@opencodingpartner/policy";
import { applySandboxTodo, grepSandbox, listSandboxDir, writeSandboxFile } from "@opencodingpartner/workers";
import { DEMO_MESSAGE, applySwarmManifest, approveDoctorLine, clearSessionMemory, coreIsOpen, createRoutine, deliverSlackEvent, deliverTelegramUpdate, fireDueRoutines, fireEvent, formatApproveQueue, formatFleetStatus, formatFleetStatusJson, formatReviewHolds, formatTodoQueue, isolatePartner, listApproveQueue, listReviewHolds, listRoutines, listTodoQueue, parseSwarmManifest, partnerAgreementDoctorLine, partnerAgreementStatus, partnerContainerArgv, pauseRoutine, readFleetStatus, readPackaging, reviewHoldDoctorLine, runChatTurn, todoDoctorLine, runDemo, slackSignature, slackTurn, startPartnerContainer, stopPartnerContainer, verifySlackRequest, verifyTelegramRequest } from "./index.js";
import { allowComputerUse, captureComputerFrame, checkComputerFrame, computerTabText, doctorComputerControlLine, doctorComputerFrameLine, doctorComputerRunLine } from "./computer-tab.js";
import { doctorSharedMountLine } from "./fleet.js";
import { doctorLastCheckLine } from "./last-check.js";
import { REVIEW_HOLD_CODING_CAP, rolesUnderReviewHold } from "./sdlc.js";

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
    assert.match(turn.transcript, /General edits need a meter key/);
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
    assert.match(turn.transcript, /Orchestration accepted the session plan/);
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
    assert.match(turn.transcript, /System-1: real/);
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
    assert.match(turn.transcript, /Write path: orchestration/);
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
    assert.match(turn.transcript, /Write path: orchestration/);
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
          const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
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
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
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
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
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
    assert.doesNotMatch(turn.transcript, /path: orchestration/);
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
    assert.doesNotMatch(turn.transcript, /Rename path: orchestration/);
    await assert.rejects(readFile(path.join(root, "src/old.ts"), "utf8"));
    assert.match(await readFile(path.join(root, "src/lib/old.ts"), "utf8"), /export const old/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding turn appends to an existing file and does not create one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-append-turn-"));
  try {
    const turn = await runChatTurn({
      message: "add a line to the helper",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (!prompt.includes("Tool observations:\n")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ steps: [{ tool: "write", path: "src/note.ts", content: "one\n" }] }),
            };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                { tool: "append", path: "src/note.ts", content: "two\n" },
                { tool: "append", path: "src/missing.ts", content: "no\n" },
                { tool: "append", path: "../outside.ts", content: "no\n" },
              ],
            }),
          };
        },
      },
    });
    assert.match(turn.transcript, /Tool: append src\/note.ts/);
    assert.match(turn.transcript, /Tool: append src\/missing.ts \(file missing\)/);
    assert.match(turn.transcript, /Append path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /Append path: OpenClaw/);
    assert.equal(await readFile(path.join(root, "src/note.ts"), "utf8"), "one\ntwo\n");
    await assert.rejects(readFile(path.join(root, "src/missing.ts"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an orchestration turn appends through the bridge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-remote-append-"));
  try {
    await writeSandboxFile(root, "src/note.ts", "one\n");
    const calls: string[] = [];
    const turn = await runChatTurn({
      message: "add a line to the helper",
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
            stdout: JSON.stringify({ done: true, steps: [{ tool: "append", path: "src/note.ts", content: "two\n" }] }),
          };
        },
      },
      openclawAppend: async (relativePath, content) => {
        calls.push(`${relativePath} ${content}`);
        const { appendFile } = await import("node:fs/promises");
        await appendFile(path.join(root, relativePath), content);
        return { ok: true, missing: false, detail: "bridge" };
      },
    });
    assert.deepEqual(calls, ["src/note.ts two\n"]);
    assert.match(turn.transcript, /Append path: orchestration/);
    assert.doesNotMatch(turn.transcript, /Append path: local sandbox/);
    assert.equal(await readFile(path.join(root, "src/note.ts"), "utf8"), "one\ntwo\n");

    const blocked = await mkdtemp(path.join(tmpdir(), "ocp-append-refuse-"));
    await writeSandboxFile(blocked, "src/note.ts", "one\n");
    const refused = await runChatTurn({
      message: "add a line to the helper",
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
            stdout: JSON.stringify({ done: true, steps: [{ tool: "append", path: "src/note.ts", content: "two\n" }] }),
          };
        },
      },
      openclawAppend: async () => ({ ok: false, missing: false, detail: "refused" }),
    });
    assert.doesNotMatch(refused.transcript, /Append path: local sandbox/);
    assert.doesNotMatch(refused.transcript, /Append path: orchestration/);
    assert.equal(await readFile(path.join(blocked, "src/note.ts"), "utf8"), "one\n");
    await rm(blocked, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing OpenClaw append plugin falls back to the local sandbox", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-append-fallback-"));
  try {
    await writeSandboxFile(root, "src/note.ts", "one\n");
    const turn = await runChatTurn({
      message: "add a line to the helper",
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
            stdout: JSON.stringify({ done: true, steps: [{ tool: "append", path: "src/note.ts", content: "two\n" }] }),
          };
        },
      },
      openclawAppend: async () => ({ ok: false, missing: true, detail: "plugin missing" }),
    });
    assert.match(turn.transcript, /Append path: local sandbox/);
    assert.doesNotMatch(turn.transcript, /Append path: orchestration/);
    assert.equal(await readFile(path.join(root, "src/note.ts"), "utf8"), "one\ntwo\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an orchestration turn updates the todo list through the bridge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-remote-todo-"));
  try {
    const calls: string[] = [];
    const turn = await runChatTurn({
      message: "fix the checklist",
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
                { tool: "todo", action: "add", content: "write the test" },
                { tool: "todo", action: "complete", content: "1" },
                { tool: "todo", action: "add", content: "password=hunter2" },
              ],
            }),
          };
        },
      },
      openclawTodo: async (action, content) => {
        calls.push(`${action} ${content}`);
        const changed = await applySandboxTodo(root, action, content);
        return { ok: changed.ok, missing: false, detail: changed.detail };
      },
    });
    assert.deepEqual(calls, ["add write the test", "complete 1", "add password=hunter2"]);
    assert.match(turn.transcript, /Todo path: orchestration/);
    assert.match(turn.transcript, /Todo: complete 1/);
    assert.match(turn.transcript, /blocked/);
    assert.doesNotMatch(turn.transcript, /Todo path: local sandbox/);
    const stored = JSON.parse(await readFile(path.join(root, ".ocp/todos.json"), "utf8")) as { todos: { text: string; done: boolean }[] };
    assert.equal(stored.todos.length, 1);
    assert.equal(stored.todos[0]?.text, "write the test");
    assert.equal(stored.todos[0]?.done, true);

    const blocked = await mkdtemp(path.join(tmpdir(), "ocp-todo-refuse-"));
    const refused = await runChatTurn({
      message: "fix the checklist",
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
            stdout: JSON.stringify({ done: true, steps: [{ tool: "todo", action: "add", content: "write the test" }] }),
          };
        },
      },
      openclawTodo: async () => ({ ok: false, missing: false, detail: "refused" }),
    });
    assert.doesNotMatch(refused.transcript, /Todo path: local sandbox/);
    assert.doesNotMatch(refused.transcript, /Todo path: orchestration/);
    await assert.rejects(readFile(path.join(blocked, ".ocp/todos.json"), "utf8"));
    await rm(blocked, { recursive: true, force: true });

    const fallback = await mkdtemp(path.join(tmpdir(), "ocp-todo-fallback-"));
    const local = await runChatTurn({
      message: "fix the checklist",
      sandboxRoot: fallback,
      orchestration: async () => ({
        state: "ran",
        driver: "openclaw",
        detail: "Session agent:board:main accepted the plan.",
      }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "todo", action: "add", content: "write the test" }] }),
          };
        },
      },
      openclawTodo: async () => ({ ok: false, missing: true, detail: "plugin missing" }),
    });
    assert.match(local.transcript, /Todo path: local sandbox/);
    assert.doesNotMatch(local.transcript, /Todo path: orchestration/);
    const fallbackStored = JSON.parse(await readFile(path.join(fallback, ".ocp/todos.json"), "utf8")) as { todos: { text: string }[] };
    assert.equal(fallbackStored.todos[0]?.text, "write the test");
    await rm(fallback, { recursive: true, force: true });
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

test("an orchestration turn copies a file through the bridge", async () => {
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
    assert.match(turn.transcript, /Copy path: orchestration/);
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
    assert.doesNotMatch(refused.transcript, /Copy path: orchestration/);
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
    assert.doesNotMatch(turn.transcript, /Copy path: orchestration/);
    assert.match(await readFile(path.join(root, "src/old.ts"), "utf8"), /export const old/);
    assert.match(await readFile(path.join(root, "src/lib/old.ts"), "utf8"), /export const old/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an orchestration turn deletes and renames through the bridge", async () => {
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
    assert.match(turn.transcript, /Delete path: orchestration/);
    assert.match(turn.transcript, /Rename path: orchestration/);
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
    assert.doesNotMatch(turn.transcript, /Delete path: orchestration/);
    await assert.rejects(readFile(path.join(root, "src/old.ts"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an orchestration turn creates a directory through the bridge", async () => {
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
    assert.match(turn.transcript, /Mkdir path: orchestration/);
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
    assert.doesNotMatch(refused.transcript, /Mkdir path: orchestration/);
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
    assert.doesNotMatch(turn.transcript, /Mkdir path: orchestration/);
    const { stat } = await import("node:fs/promises");
    assert.equal((await stat(path.join(root, "src/lib"))).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an orchestration turn removes an empty directory through the bridge", async () => {
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
    assert.match(turn.transcript, /Rmdir path: orchestration/);
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
    assert.doesNotMatch(refused.transcript, /Rmdir path: orchestration/);
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
    assert.doesNotMatch(turn.transcript, /Rmdir path: orchestration/);
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
    assert.doesNotMatch(turn.transcript, /path: orchestration/);
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
    assert.doesNotMatch(turn.transcript, /path: orchestration/);
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

test("an orchestration tool write uses the write bridge", async () => {
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
    assert.match(turn.transcript, /Write path: orchestration/);
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
    assert.match(first.transcript, /Meter: worker/);
    assert.match(second.transcript, /Meter: worker/);
    assert.match(third.transcript, /Meter: worker/);
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

test("a partner sandbox waits for the plan, then edits and runs node --test", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-partner-"));
  try {
    await writeFile(path.join(root, "PARTNER.md"), "partner\n");
    let calls = 0;
    const held = await runChatTurn({
      message: "add a helper in src/add.test.mjs",
      sandboxRoot: root,
      grokRunner: {
        async run() {
          calls += 1;
          return { exitCode: 0, stdout: JSON.stringify({ done: true, steps: [{ tool: "write", path: "src/add.test.mjs", content: "no\n" }] }) };
        },
      },
    });
    assert.equal(calls, 0);
    assert.match(held.transcript, /Plan is waiting/);
    assert.equal(held.coding?.wrote, false);
    assert.match(await readFile(path.join(root, ".ocp/sdlc/intent.md"), "utf8"), /add a helper/);
    assert.match(await readFile(path.join(root, ".ocp/sdlc/spec.md"), "utf8"), /sandbox/);
    assert.match(await readFile(path.join(root, ".ocp/sdlc/plan.md"), "utf8"), /node --test/);
    const plan = JSON.parse(await readFile(path.join(root, ".ocp/sdlc/plan.json"), "utf8")) as { accepted: boolean };
    assert.equal(plan.accepted, false);

    const edited = await runChatTurn({
      message: "accept the plan",
      sandboxRoot: root,
      grokRunner: {
        async run() {
          calls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                {
                  tool: "write",
                  path: "src/add.test.mjs",
                  content: "import assert from \"node:assert/strict\";\nimport test from \"node:test\";\ntest(\"adds\", () => { assert.equal(1 + 1, 2); });\n",
                },
              ],
            }),
          };
        },
      },
    });
    assert.equal(calls, 1);
    assert.match(edited.transcript, /Self-verify: node --test \(exit 0\)/);
    assert.match(edited.transcript, /Human intent and risk are not decided/);
    assert.match(await readFile(path.join(root, ".ocp/sdlc/review.md"), "utf8"), /Mechanical review/);
    assert.match(await readFile(path.join(root, "src/add.test.mjs"), "utf8"), /adds/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partner turn uses the shared session block rule and does not copy it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-shared-rules-"));
  try {
    await writeFile(path.join(root, "PARTNER.md"), "partner\n");
    await writeFile(path.join(root, "PARTNER.rules"), "block: paid\n");
    const workspace = await isolatePartner(root, "coding");
    const blocked = await runChatTurn({
      message: "add a paid plan",
      sandboxRoot: root,
      partnerId: "coding",
      grokRunner: {
        async run() {
          return { exitCode: 0, stdout: JSON.stringify({ done: true, steps: [{ tool: "write", path: "src/paid.txt", content: "no\n" }] }) };
        },
      },
    });
    assert.match(blocked.transcript, /Partner rule blocked this request \(paid\)/);
    assert.equal(blocked.coding?.wrote, false);
    await assert.rejects(readFile(path.join(workspace, "PARTNER.rules"), "utf8"));
    await assert.rejects(readFile(path.join(workspace, "src", "paid.txt"), "utf8"));
    assert.equal(await readFile(path.join(root, "PARTNER.rules"), "utf8"), "block: paid\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approve cards deny or redirect, and partner rules block a request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-approve-"));
  try {
    await writeFile(path.join(root, "PARTNER.md"), "partner\n");
    await writeFile(path.join(root, "PARTNER.rules"), "Keep helpers small.\nblock: paid\n");
    const held = await runChatTurn({ message: "add a helper", sandboxRoot: root });
    assert.match(held.transcript, /Approve card plan-1 pending/);
    const denied = await runChatTurn({ message: "deny", sandboxRoot: root });
    assert.match(denied.transcript, /Approve denied/);
    assert.match(denied.transcript, /Approve card plan-1 denied/);
    assert.equal(denied.coding?.wrote, false);

    await runChatTurn({ message: "add a helper again", sandboxRoot: root });
    const redirected = await runChatTurn({ message: "redirect: use a smaller helper", sandboxRoot: root });
    assert.match(redirected.transcript, /Approve redirected/);
    assert.match(await readFile(path.join(root, ".ocp/sdlc/intent.md"), "utf8"), /smaller helper/);
    assert.equal(redirected.coding?.wrote, false);

    let seen = "";
    const blocked = await runChatTurn({
      message: "add a paid plan",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          seen = argv[argv.indexOf("-p") + 1] ?? "";
          return { exitCode: 0, stdout: JSON.stringify({ done: true, steps: [] }) };
        },
      },
    });
    assert.equal(seen, "");
    assert.match(blocked.transcript, /Partner rule blocked this request \(paid\)/);

    await writeFile(path.join(root, "PARTNER.rules"), "Keep helpers small.\n");
    await runChatTurn({ message: "add a tiny helper", sandboxRoot: root });
    await runChatTurn({
      message: "approve",
      sandboxRoot: root,
      grokRunner: {
        async run(argv) {
          seen = argv[argv.indexOf("-p") + 1] ?? "";
          return { exitCode: 0, stdout: JSON.stringify({ done: true, steps: [{ tool: "write", path: "src/tiny.txt", content: "ok\n" }] }) };
        },
      },
    });
    assert.match(seen, /Partner rules:/);
    assert.match(seen, /Keep helpers small/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partner computer waits for Approve, then a takeover blocks the browser", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-computer-gate-"));
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  try {
    await writeFile(path.join(root, "PARTNER.md"), "partner\n");
    let opened = 0;
    const driver = {
      async start() {
        opened += 1;
        return {
          async open() {
            return { title: "Example", text: "page", screenshotPng: png };
          },
          async readScreen() {
            return { title: "Example", text: "page", screenshotPng: png };
          },
          async typeInto() {
            return { title: "Example", text: "page", screenshotPng: png };
          },
          async close() {
            return undefined;
          },
        };
      },
    };
    const held = await runChatTurn({
      message: "sell this page. Open https://example.com",
      sandboxRoot: root,
      computerExecute: true,
      browserDriver: driver,
    });
    assert.equal(opened, 0);
    assert.match(held.transcript, /Approve card computer-/);
    assert.match(held.transcript, /Computer tab/);
    assert.match(held.transcript, /waiting for Approve/);
    assert.equal(held.computer?.actions.every((action) => action.executed === false), true);

    await runChatTurn({ message: "approve", sandboxRoot: root });
    await runChatTurn({ message: "approve the browser", sandboxRoot: root });
    const ran = await runChatTurn({
      message: "sell this page. Open https://example.com/live",
      sandboxRoot: root,
      computerExecute: true,
      browserDriver: driver,
    });
    assert.equal(opened, 1);
    assert.match(ran.transcript, /Last frame: gtm\//);
    assert.match(ran.transcript, /Computer QA computer-frame: pass/);
    assert.equal(ran.qa?.pass, true);
    assert.equal(ran.computer?.actions.some((action) => action.executed === true), true);

    const { returnComputer, takeoverComputer } = await import("./computer-tab.js");
    await takeoverComputer(root);
    const blocked = await runChatTurn({
      message: "sell this page. Open https://example.com/held",
      sandboxRoot: root,
      computerExecute: true,
      browserDriver: driver,
    });
    assert.equal(opened, 1);
    assert.match(blocked.transcript, /human has control/);
    assert.equal(blocked.computer?.actions.every((action) => action.executed === false), true);
    await returnComputer(root);
    const handed = await runChatTurn({
      message: "sell this page. Open https://example.com/back",
      sandboxRoot: root,
      computerExecute: true,
      browserDriver: driver,
    });
    assert.equal(opened, 2);
    assert.match(handed.transcript, /Computer QA computer-frame: pass/);
    assert.equal(handed.computer?.actions.some((action) => action.executed === true), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partner computer keeps the frame in its workspace, and takeover blocks that workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-partner-frame-"));
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const workspace = path.join(root, ".ocp/fleet/coding");
  try {
    await writeFile(path.join(root, "PARTNER.md"), "partner\n");
    let opened = 0;
    const driver = {
      async start() {
        opened += 1;
        return {
          async open() {
            return { title: "Example", text: "page", screenshotPng: png };
          },
          async readScreen() {
            return { title: "Example", text: "page", screenshotPng: png };
          },
          async typeInto() {
            return { title: "Example", text: "page", screenshotPng: png };
          },
          async close() {
            return undefined;
          },
        };
      },
    };
    const held = await runChatTurn({
      message: "sell this page. Open https://example.com/partner",
      sandboxRoot: root,
      partnerId: "coding",
      computerExecute: true,
      computerAllowHosts: ["example.com"],
      browserDriver: driver,
    });
    assert.equal(opened, 0);
    assert.match(held.transcript, /Approve card computer-/);
    assert.match(held.transcript, /waiting for Approve/);
    await assert.rejects(readFile(path.join(workspace, "gtm/last-frame.png")));

    await runChatTurn({ message: "approve", sandboxRoot: root, partnerId: "coding" });
    await runChatTurn({ message: "approve the browser", sandboxRoot: root, partnerId: "coding" });
    const ran = await runChatTurn({
      message: "sell this page. Open https://example.com/partner-live",
      sandboxRoot: root,
      partnerId: "coding",
      computerExecute: true,
      computerAllowHosts: ["example.com"],
      browserDriver: driver,
    });
    assert.equal(opened, 1);
    assert.equal(ran.qa?.pass, true);
    assert.match(ran.transcript, /Computer QA computer-frame: pass/);
    assert.match(ran.transcript, /Last frame: \.ocp\/fleet\/coding\/gtm\/last-frame.png/);
    assert.doesNotMatch(ran.transcript, /Last frame: gtm\/last-frame.png/);
    const frame = await readFile(path.join(workspace, "gtm/last-frame.png"));
    assert.equal(frame[0], 0x89);
    await assert.rejects(readFile(path.join(root, "gtm/last-frame.png")));

    const { returnComputer, takeoverComputer } = await import("./computer-tab.js");
    await takeoverComputer(workspace);
    const blocked = await runChatTurn({
      message: "sell this page. Open https://example.com/partner-held",
      sandboxRoot: root,
      partnerId: "coding",
      computerExecute: true,
      computerAllowHosts: ["example.com"],
      browserDriver: driver,
    });
    assert.equal(opened, 1);
    assert.match(blocked.transcript, /human has control/);
    assert.equal(blocked.computer?.actions.every((action) => action.executed === false), true);
    await returnComputer(workspace);
    const handed = await runChatTurn({
      message: "sell this page. Open https://example.com/partner-back",
      sandboxRoot: root,
      partnerId: "coding",
      computerExecute: true,
      computerAllowHosts: ["example.com"],
      browserDriver: driver,
    });
    assert.equal(opened, 2);
    assert.equal(handed.qa?.pass, true);
    assert.match(handed.transcript, /Computer QA computer-frame: pass/);
    assert.equal((await readFile(path.join(workspace, "gtm/last-frame.png")))[0], 0x89);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing browser fails capture and computer-frame in the transcript", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-browser-missing-"));
  try {
    const turn = await runChatTurn({
      message: "Stand up a computer agent and open https://example.com",
      sandboxRoot: root,
      computerExecute: true,
      computerAllowHosts: ["example.com"],
    });
    assert.equal(turn.qa?.pass, false);
    assert.match(turn.transcript, /Browser is missing/);
    assert.match(turn.transcript, /Playwright is not installed/);
    assert.match(turn.transcript, /pnpm exec playwright install chromium/);
    assert.match(turn.transcript, /ocp doctor reports Computer capture/);
    assert.match(turn.transcript, /Computer QA computer-frame: fail/);
    assert.match(turn.transcript, /No frame was written/);
    await assert.rejects(readFile(path.join(root, "gtm/last-frame.png")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same message for two partners is two turns, and one partner still replays", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-partner-replay-"));
  try {
    const coding = await runChatTurn({ message: "hello", sandboxRoot: root, partnerId: "coding" });
    const qa = await runChatTurn({ message: "hello", sandboxRoot: root, partnerId: "qa" });
    assert.equal(coding.replayed, false);
    assert.equal(qa.replayed, false);
    assert.match(await readFile(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), "utf8"), /"id": "coding"/);
    assert.match(await readFile(path.join(root, ".ocp/fleet/qa/.ocp/identity.json"), "utf8"), /"id": "qa"/);
    const again = await runChatTurn({ message: "hello", sandboxRoot: root, partnerId: "coding" });
    assert.equal(again.replayed, true);
    assert.match(again.transcript, /Replayed the same turn/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partner greps the shared session and skips a secret file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-shared-grep-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "note.txt"), "hello shared\n");
    await writeFile(path.join(root, "secret.txt"), "password=hunter2\n");
    const workspace = await isolatePartner(root, "coding");
    const turn = await runChatTurn({
      message: "fix the checklist",
      sandboxRoot: workspace,
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                { tool: "grep", path: "shared", query: "hello" },
                { tool: "grep", path: "shared", query: "hunter2" },
                { tool: "glob", path: "shared", query: "src/**/*.txt" },
                { tool: "write", path: "shared/src/note.txt", content: "changed\n" },
              ],
            }),
          };
        },
      },
    });
    assert.match(turn.transcript, /Tool: grep hello \(1 hits\)/);
    assert.match(turn.transcript, /Tool: grep hunter2 \(0 hits\)/);
    assert.match(turn.transcript, /Tool: glob src\/\*\*\/\*\.txt \(1 hits\)/);
    const { globShared, grepShared } = await import("./fleet.js");
    assert.match((await grepShared(workspace, "hello", "shared")).detail, /shared\/src\/note.txt:1: hello shared/);
    assert.equal((await grepShared(workspace, "hunter2", "shared")).detail, "(no matches)");
    assert.match((await globShared(workspace, "src/**/*.txt")).detail, /^shared\/src\/note.txt$/);
    assert.match(turn.transcript, /shared is read-only/);
    assert.doesNotMatch(turn.transcript, /password=hunter2/);
    assert.doesNotMatch(turn.transcript, /shared\/\.ocp/);
    assert.equal(await readFile(path.join(root, "src", "note.txt"), "utf8"), "hello shared\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partner reads the shared session and a write to shared is refused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-shared-read-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "note.txt"), "hello shared\n");
    await writeFile(path.join(root, "secret.txt"), "password=hunter2\n");
    const workspace = await isolatePartner(root, "coding");
    const turn = await runChatTurn({
      message: "fix the checklist",
      sandboxRoot: workspace,
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                { tool: "list", path: "shared" },
                { tool: "read", path: "shared/src/note.txt" },
                { tool: "read", path: "shared/secret.txt" },
                { tool: "read", path: "shared/../secret.txt" },
                { tool: "write", path: "shared/src/note.txt", content: "changed\n" },
              ],
            }),
          };
        },
      },
    });
    assert.match(turn.transcript, /Tool: list shared \([^)]*src/);
    assert.doesNotMatch(turn.transcript, /Tool: list shared \([^)]*\.ocp/);
    assert.match(turn.transcript, /Tool: read shared\/src\/note.txt \(ok\)/);
    const { readShared } = await import("./fleet.js");
    assert.equal((await readShared(workspace, "shared/src/note.txt")).detail, "hello shared\n");
    assert.match(turn.transcript, /Tool: read shared\/secret.txt \(blocked/);
    assert.match(turn.transcript, /shared path refused/);
    assert.match(turn.transcript, /shared is read-only/);
    assert.doesNotMatch(turn.transcript, /password=hunter2/);
    assert.equal(await readFile(path.join(root, "src", "note.txt"), "utf8"), "hello shared\n");
    await assert.rejects(readFile(path.join(workspace, "src", "note.txt"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partner turn writes in its own workspace, not the shared session root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-fleet-"));
  try {
    const turn = await runChatTurn({
      message: "Use the coding worker to create hello.txt with content:\nhello\n",
      sandboxRoot: root,
      partnerId: "coding",
    });
    assert.equal(turn.coding?.wrote, true);
    assert.equal(await readFile(path.join(root, ".ocp/fleet/coding/hello.txt"), "utf8"), "hello\n");
    await assert.rejects(readFile(path.join(root, "hello.txt"), "utf8"));
    const tab = await computerTabText(path.join(root, ".ocp/fleet/coding"));
    assert.match(tab, /Partner: coding/);
    assert.match(tab, /Desktop: partner sandbox/);
    assert.match(tab, /Fleet: coding/);
    const mount = JSON.parse(await readFile(path.join(root, ".ocp/fleet/coding/.ocp/mount.json"), "utf8")) as { shared: string; mode: string };
    assert.equal(mount.shared, "/shared");
    assert.equal(mount.mode, "read-only");
    const argv = partnerContainerArgv(root, "coding");
    assert.equal(argv[0], "docker");
    assert.ok(argv.includes("/workspace"));
    assert.ok(argv.some((part) => part.endsWith(":/shared:ro")));
    await isolatePartner(root, "qa");
    const fleet = await computerTabText(path.join(root, ".ocp/fleet/coding"));
    assert.match(fleet, /Fleet: coding, qa/);
    await assert.rejects(isolatePartner(root, "../escape"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a routine fires a partner turn, and Slack approve still gates the edit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-routine-"));
  try {
    await writeFile(path.join(root, "PARTNER.md"), "partner\n");
    const routine = await createRoutine(root, {
      partnerId: "coding",
      message: "Use the coding worker to create note.txt with content:\nfrom routine\n",
      everyMs: 1000,
      now: 0,
    });
    assert.equal(routine.status, "active");
    const early = await fireDueRoutines(root, 500, async () => "too soon");
    assert.deepEqual(early, []);
    const fired = await fireDueRoutines(root, 1000, async (item) => {
      const turn = await runChatTurn({ message: item.message, sandboxRoot: root, partnerId: item.partnerId });
      return turn.transcript;
    });
    assert.equal(fired.length, 1);
    assert.match(await readFile(path.join(root, ".ocp/fleet/coding/note.txt"), "utf8"), /from routine/);
    await pauseRoutine(root, routine.id);
    const paused = await fireDueRoutines(root, 10_000, async () => "again");
    assert.deepEqual(paused, []);
    const listed = await listRoutines(root);
    assert.equal(listed[0]?.status, "paused");

    const asked = await slackTurn({ text: "add a helper", channel: "dev" }, async (message, partnerId) => {
      const turn = await runChatTurn({ message, sandboxRoot: root, partnerId });
      return turn.transcript;
    });
    assert.equal(asked.partnerId, "slack-dev");
    assert.match(asked.reply, /Plan is waiting/);
    assert.match(asked.reply, /Approve card/);
    const denied = await slackTurn({ text: "deny", channel: "dev" }, async (message, partnerId) => {
      const turn = await runChatTurn({ message, sandboxRoot: root, partnerId });
      return turn.transcript;
    });
    assert.match(denied.reply, /Approve denied/);
    await createRoutine(root, { partnerId: "coding", message: "add a note", event: "build-finished", now: 0 });
    const events = await fireEvent(root, "build-finished", async (item) => item.message);
    assert.deepEqual(events, ["add a note"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a swarm manifest validates, dry-runs, and applies partner workspaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-swarm-"));
  try {
    const raw = await readFile(path.join(fileURLToPath(new URL("../../../docs/examples/swarm.json", import.meta.url))), "utf8");
    const manifest = parseSwarmManifest(raw);
    const dry = await applySwarmManifest(root, manifest, { dryRun: true, now: 0 });
    assert.equal(dry.ok, true);
    assert.match(dry.text, /dry-run: no files written/);
    assert.match(dry.text, /partner coding coding workspace \.ocp\/fleet\/coding/);
    await assert.rejects(readFile(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), "utf8"));
    const applied = await applySwarmManifest(root, manifest, { now: 0 });
    assert.equal(applied.ok, true);
    assert.match(applied.text, /applied/);
    const identity = JSON.parse(await readFile(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), "utf8")) as { id: string };
    assert.equal(identity.id, "coding");
    assert.match(await readFile(path.join(root, ".ocp/fleet/chat/.ocp/identity.json"), "utf8"), /chat/);
    const routines = await listRoutines(root);
    assert.equal(routines.length, 2);
    await applySwarmManifest(root, manifest, { now: 0 });
    assert.equal((await listRoutines(root)).length, 2);
    const bad = parseSwarmManifest(JSON.stringify({ system: "board", partners: [{ id: "coding", kind: "coding", role: "coding" }], routines: [{ partnerId: "coding", message: "loop", everyMs: 1 }] }));
    const refused = await applySwarmManifest(root, bad, { dryRun: true });
    assert.equal(refused.ok, false);
    assert.match(refused.text, /at least 1000 ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("todo list shows open and done items and the doctor line does not print the text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-todo-list-"));
  try {
    assert.match(formatTodoQueue(await listTodoQueue(root)), /Todos: none/);
    await mkdir(path.join(root, ".ocp/fleet/coding/.ocp"), { recursive: true });
    await writeFile(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), `${JSON.stringify({ id: "coding" })}\n`);
    await writeFile(
      path.join(root, ".ocp/todos.json"),
      `${JSON.stringify({ todos: [{ id: "1", text: "write the test", done: false }, { id: "2", text: "password=hunter2", done: true }] })}\n`,
    );
    await writeFile(
      path.join(root, ".ocp/fleet/coding/.ocp/todos.json"),
      `${JSON.stringify({ todos: [{ id: "1", text: "patch add", done: false }] })}\n`,
    );
    const items = await listTodoQueue(root);
    assert.equal(items.length, 3);
    assert.match(formatTodoQueue(items), /session \. 1 open write the test/);
    assert.match(formatTodoQueue(items), /coding \.ocp\/fleet\/coding 1 open patch add/);
    const doctor = todoDoctorLine(items.filter((item) => !item.done).length);
    assert.match(doctor, /yellow Todos: 2 open/);
    assert.match(doctor, /does not change the list/);
    assert.doesNotMatch(doctor, /password=hunter2/);
    assert.doesNotMatch(doctor, /write the test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a review hold is listed and the doctor line does not print the reason", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-review-hold-"));
  try {
    assert.match(formatReviewHolds(await listReviewHolds(root)), /Review hold: none/);
    await mkdir(path.join(root, ".ocp/fleet/coding/.ocp/sdlc"), { recursive: true });
    await writeFile(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), `${JSON.stringify({ id: "coding" })}\n`);
    await writeFile(path.join(root, ".ocp/fleet/coding/.ocp/sdlc/review-hold"), "node --test exit 1 password=hunter2\n");
    const holds = await listReviewHolds(root);
    assert.equal(holds.length, 1);
    assert.equal(holds[0]?.partner, "coding");
    assert.match(formatReviewHolds(holds), /coding \.ocp\/fleet\/coding node --test exit 1/);
    const doctor = reviewHoldDoctorLine(holds.length);
    assert.match(doctor, /yellow Review hold: 1/);
    assert.doesNotMatch(doctor, /password=hunter2/);
    assert.match(doctor, /does not accept the plan/);
    assert.match(await readFile(path.join(root, ".ocp/fleet/coding/.ocp/sdlc/review-hold"), "utf8"), /password=hunter2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor names a missing partner agreement and does not print a block rule", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-agreement-"));
  try {
    const missing = partnerAgreementDoctorLine(await partnerAgreementStatus(root));
    assert.match(missing, /yellow Partner agreement: PARTNER.md is missing/);
    assert.match(missing, /does not copy the file/);
    await mkdir(path.join(root, ".ocp/fleet/coding/.ocp"), { recursive: true });
    await writeFile(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), `${JSON.stringify({ id: "coding" })}\n`);
    await writeFile(path.join(root, "PARTNER.md"), "partner\n");
    await writeFile(path.join(root, "PARTNER.rules"), "block: password=hunter2\n");
    const partial = partnerAgreementDoctorLine(await partnerAgreementStatus(root));
    assert.match(partial, /yellow Partner agreement: coding missing PARTNER.md/);
    assert.doesNotMatch(partial, /password=hunter2/);
    await writeFile(path.join(root, ".ocp/fleet/coding/PARTNER.md"), "partner\n");
    const ready = partnerAgreementDoctorLine(await partnerAgreementStatus(root));
    assert.match(ready, /green Partner agreement: present/);
    assert.match(ready, /1 block rule/);
    assert.match(ready, /does not copy the file/);
    assert.doesNotMatch(ready, /password=hunter2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approve list shows pending cards and the doctor line does not print the request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-approve-list-"));
  try {
    assert.match(formatApproveQueue(await listApproveQueue(root)), /Approvals: none pending/);
    await mkdir(path.join(root, ".ocp"), { recursive: true });
    await writeFile(
      path.join(root, ".ocp", "approvals.json"),
      `${JSON.stringify({ cards: [{ id: "plan-1", kind: "plan", title: "Edit after this plan", detail: "add password=hunter2 to the helper", status: "pending" }] })}\n`,
    );
    await isolatePartner(root, "coding");
    await mkdir(path.join(root, ".ocp/fleet/coding/.ocp"), { recursive: true });
    await writeFile(
      path.join(root, ".ocp/fleet/coding/.ocp/approvals.json"),
      `${JSON.stringify({ cards: [{ id: "computer-1", kind: "computer", title: "Start the sandbox browser", detail: "open the page", status: "pending" }, { id: "plan-1", kind: "plan", title: "Edit after this plan", detail: "already decided", status: "approved" }] })}\n`,
    );
    const items = await listApproveQueue(root);
    assert.deepEqual(items.map((item) => `${item.partner} ${item.id}`), ["session plan-1", "coding computer-1"]);
    assert.match(formatApproveQueue(items), /session \. plan-1 plan pending/);
    assert.match(formatApproveQueue(items), /coding \.ocp\/fleet\/coding computer-1 computer pending/);
    const doctor = approveDoctorLine(items.length);
    assert.match(doctor, /yellow Approvals: 2 pending/);
    assert.doesNotMatch(doctor, /password=hunter2/);
    assert.match(doctor, /does not decide a card/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fleet status lists partners, container state, and the last frame", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-fleet-status-"));
  try {
    assert.match(formatFleetStatus(await readFleetStatus(root)), /Fleet: no partners/);
    await isolatePartner(root, "coding");
    await isolatePartner(root, "qa");
    await mkdir(path.join(root, ".ocp/fleet/coding/.ocp"), { recursive: true });
    await writeFile(path.join(root, ".ocp/fleet/coding/.ocp/container.json"), `${JSON.stringify({ state: "running", name: "ocp-coding" })}\n`);
    await mkdir(path.join(root, ".ocp/fleet/qa/gtm"), { recursive: true });
    await writeFile(path.join(root, ".ocp/fleet/qa/gtm/last-frame.png"), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const rows = await readFleetStatus(root);
    assert.deepEqual(rows.map((row) => row.id), ["coding", "qa"]);
    assert.equal(rows[0]?.container, "running");
    assert.equal(rows[0]?.frame, "none");
    assert.equal(rows[1]?.container, "not started");
    assert.equal(rows[1]?.frame, ".ocp/fleet/qa/gtm/last-frame.png");
    assert.match(rows[1]?.frameTime ?? "", /^\d{4}-/);
    const text = formatFleetStatus(rows);
    assert.match(text, /coding workspace \.ocp\/fleet\/coding container running/);
    assert.match(text, /qa workspace \.ocp\/fleet\/qa container not started/);
    assert.match(text, /No telemetry is sent/);
    const json = JSON.parse(formatFleetStatusJson(rows)) as { id: string }[];
    assert.deepEqual(json.map((row) => row.id), ["coding", "qa"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fleet start dry-run and a missing Docker do not claim a running container", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-fleet-run-"));
  try {
    let calls = 0;
    const dry = await startPartnerContainer(root, "coding", {
      dryRun: true,
      exec: async () => {
        calls += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(dry.ok, true);
    assert.equal(calls, 0);
    assert.match(dry.text, /dry-run: docker run -d/);
    assert.match(dry.text, /:\/workspace/);
    assert.match(dry.text, /:\/shared:ro/);
    const missing = await startPartnerContainer(root, "coding", {
      exec: async () => ({ code: 127, stdout: "", stderr: "docker not found" }),
    });
    assert.equal(missing.ok, false);
    assert.match(missing.text, /Docker is not available/);
    assert.match(missing.text, /ocp doctor says whether docker answered and does not start containers/);
    assert.match(await computerTabText(path.join(root, ".ocp/fleet/coding")), /Container: not started/);

    await writeFile(path.join(root, "PARTNER.md"), "partner\n");
    const gated = await startPartnerContainer(root, "coding", {
      exec: async () => {
        calls += 1;
        return { code: 0, stdout: "1\n", stderr: "" };
      },
    });
    assert.equal(gated.ok, false);
    assert.match(gated.text, /Approve the card first/);
    assert.equal(calls, 0);

    await allowComputerUse(path.join(root, ".ocp/fleet/coding"));
    const started = await startPartnerContainer(root, "coding", {
      exec: async (argv) => {
        calls += 1;
        if (argv[1] === "version") return { code: 0, stdout: "27\n", stderr: "" };
        return { code: 0, stdout: "abc\n", stderr: "" };
      },
    });
    assert.equal(started.ok, true);
    assert.match(await computerTabText(path.join(root, ".ocp/fleet/coding")), /Container: running/);
    const stopped = await stopPartnerContainer(root, "coding", {
      exec: async (argv) => (argv[1] === "version" ? { code: 0, stdout: "27\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }),
    });
    assert.equal(stopped.ok, true);
    assert.match(await computerTabText(path.join(root, ".ocp/fleet/coding")), /Container: stopped/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coding check records its exit code and doctor does not print the output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-last-check-"));
  try {
    assert.match(await doctorLastCheckLine(root), /green Last check: none/);
    const turn = await runChatTurn({
      message: "fix the checklist",
      sandboxRoot: root,
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                { tool: "run", argv: ["node", "--test", "src/a.test.ts"] },
                { tool: "run", argv: ["git", "status", "-sb"] },
              ],
            }),
          };
        },
      },
      checkExec: async (argv) => ({
        code: argv[0] === "node" ? 1 : 0,
        stdout: "",
        stderr: "password=hunter2",
      }),
    });
    assert.match(turn.transcript, /Tool: run node --test src\/a.test.ts \(exit 1/);
    const saved = JSON.parse(await readFile(path.join(root, ".ocp/last-check.json"), "utf8")) as { code: number; kind: string };
    assert.equal(saved.code, 1);
    assert.equal(saved.kind, "node --test");
    assert.doesNotMatch(JSON.stringify(saved), /password=hunter2/);
    const line = await doctorLastCheckLine(root);
    assert.match(line, /yellow Last check: session node --test exit 1/);
    assert.match(line, /does not print its output/);
    assert.doesNotMatch(line, /password=hunter2/);
    assert.doesNotMatch(line, /src\/a.test.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor names a shared mount that does not point at this session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-doctor-mount-"));
  try {
    assert.match(await doctorSharedMountLine(root), /green Shared mount: no partners/);
    await isolatePartner(root, "coding");
    const ready = await doctorSharedMountLine(root);
    assert.match(ready, /green Shared mount: 1 partner read-only at this session/);
    assert.match(ready, /does not copy files/);
    const elsewhere = path.join(root, "elsewhere-secret");
    await writeFile(
      path.join(root, ".ocp/fleet/coding/.ocp/mount.json"),
      `${JSON.stringify({ shared: "/shared", source: elsewhere, mode: "read-only" })}\n`,
    );
    const wrong = await doctorSharedMountLine(root);
    assert.match(wrong, /yellow Shared mount: coding does not point at this session/);
    assert.match(wrong, /does not copy files/);
    assert.doesNotMatch(wrong, /elsewhere-secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor names who holds the browser and does not return it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-doctor-control-"));
  try {
    const open = await doctorComputerControlLine(root);
    assert.match(open, /green Computer control: partner/);
    assert.match(open, /does not take or return the browser/);
    await mkdir(path.join(root, ".ocp/fleet/coding/.ocp"), { recursive: true });
    await writeFile(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), `${JSON.stringify({ id: "coding" })}\n`);
    const heldFile = `${JSON.stringify({ desktop: "sandbox", control: "human", approved: true, status: "held" })}\n`;
    await writeFile(path.join(root, ".ocp/fleet/coding/.ocp/computer.json"), heldFile);
    const held = await doctorComputerControlLine(root);
    assert.match(held, /yellow Computer control: you hold the coding browser/);
    assert.match(held, /does not take or return the browser/);
    assert.doesNotMatch(held, /Browser is missing/);
    assert.equal(await readFile(path.join(root, ".ocp/fleet/coding/.ocp/computer.json"), "utf8"), heldFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor names a failed page check and does not print the page", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-doctor-run-"));
  try {
    const none = await doctorComputerRunLine(root);
    assert.match(none, /yellow Computer run: none/);
    assert.match(none, /does not open a page/);
    await mkdir(path.join(root, "gtm"), { recursive: true });
    await writeFile(
      path.join(root, "gtm/last-run.json"),
      `${JSON.stringify({
        url: "https://example.com/?token=password=hunter2",
        title: "password=hunter2",
        steps: [{ kind: "click", executed: true, passed: false, reason: "password=hunter2" }],
      })}\n`,
    );
    const failed = await doctorComputerRunLine(root);
    assert.match(failed, /yellow Computer run: the last page check failed at click/);
    assert.match(failed, /does not open a page/);
    assert.doesNotMatch(failed, /password=hunter2/);
    assert.doesNotMatch(failed, /example.com/);
    await mkdir(path.join(root, ".ocp/fleet/coding/.ocp"), { recursive: true });
    await mkdir(path.join(root, ".ocp/fleet/coding/gtm"), { recursive: true });
    await writeFile(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), `${JSON.stringify({ id: "coding" })}\n`);
    await writeFile(
      path.join(root, "gtm/last-run.json"),
      `${JSON.stringify({ steps: [{ kind: "click", executed: true, passed: true }] })}\n`,
    );
    await writeFile(
      path.join(root, ".ocp/fleet/coding/gtm/last-run.json"),
      `${JSON.stringify({ steps: [{ kind: "hover", executed: true, passed: false, reason: "secret" }] })}\n`,
    );
    const partner = await doctorComputerRunLine(root);
    assert.match(partner, /yellow Computer run: the last page check passed/);
    assert.match(partner, /coding failed at hover/);
    assert.doesNotMatch(partner, /secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor names a bad partner frame and does not open a browser", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-doctor-frames-"));
  try {
    const none = await doctorComputerFrameLine(root);
    assert.match(none, /yellow Computer frame: none at gtm\/last-frame.png/);
    assert.match(none, /does not start the browser/);
    await mkdir(path.join(root, "gtm"), { recursive: true });
    await writeFile(path.join(root, "gtm/last-frame.png"), Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await mkdir(path.join(root, ".ocp/fleet/coding/.ocp"), { recursive: true });
    await writeFile(path.join(root, ".ocp/fleet/coding/.ocp/identity.json"), `${JSON.stringify({ id: "coding" })}\n`);
    const quiet = await doctorComputerFrameLine(root);
    assert.match(quiet, /green Computer frame: a PNG is at gtm\/last-frame.png/);
    assert.doesNotMatch(quiet, /partner frame/);
    await mkdir(path.join(root, ".ocp/fleet/coding/gtm"), { recursive: true });
    await writeFile(path.join(root, ".ocp/fleet/coding/gtm/last-frame.png"), Buffer.from("not-a-png"));
    const bad = await doctorComputerFrameLine(root);
    assert.match(bad, /yellow Computer frame:/);
    assert.match(bad, /a PNG is at gtm\/last-frame.png/);
    assert.match(bad, /not a PNG \(\.ocp\/fleet\/coding\/gtm\/last-frame.png\)|\.ocp\/fleet\/coding\/gtm\/last-frame.png is not a PNG/);
    assert.match(bad, /does not start the browser/);
    assert.doesNotMatch(bad, /Browser is missing/);
    await writeFile(path.join(root, ".ocp/fleet/coding/gtm/last-frame.png"), Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const passed = await doctorComputerFrameLine(root);
    assert.match(passed, /green Computer frame: a PNG is at gtm\/last-frame.png/);
    assert.match(passed, /1 partner frame passed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computer capture writes a PNG frame and reports its time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-frame-"));
  try {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await mkdir(path.join(root, "gtm"), { recursive: true });
    await writeFile(path.join(root, "gtm", "last-run.json"), `${JSON.stringify({ url: "https://example.com", screenshot: "" })}\n`);
    const shot = await captureComputerFrame(root, { capture: async () => png });
    assert.equal(shot.ok, true);
    assert.match(shot.text, /Computer QA computer-frame: pass/);
    const bytes = await readFile(path.join(root, "gtm", "last-frame.png"));
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50);
    const tab = await computerTabText(root);
    assert.match(tab, /Last frame: gtm\/last-frame.png/);
    assert.match(tab, /Frame time: \d{4}-/);
    const missing = await captureComputerFrame(root);
    assert.equal(missing.ok, false);
    assert.match(missing.text, /Browser is missing/);
    assert.match(missing.text, /pnpm exec playwright install chromium/);
    assert.match(missing.text, /ocp doctor reports Computer capture/);
    assert.match(missing.text, /No frame was written/);
    const empty = await mkdtemp(path.join(tmpdir(), "ocp-frame-empty-"));
    const none = await captureComputerFrame(empty);
    assert.match(none.text, /No page is open/);
    await assert.rejects(readFile(path.join(empty, "gtm", "last-frame.png")));
    await rm(empty, { recursive: true, force: true });
    const stale = await checkComputerFrame(root, Date.now() + 60_000);
    assert.equal(stale.pass, false);
    assert.match(stale.summary, /frame time did not move/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a computer turn fails when the frame is not a PNG", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-frame-qa-"));
  try {
    const png = Uint8Array.from([137, 80, 78, 71]);
    const turn = await runChatTurn({
      message: "Stand up a computer agent and open https://example.com",
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
    assert.equal(turn.computer?.actions.some((action) => action.executed === true), true);
    assert.equal(turn.qa?.pass, false);
    assert.match(turn.transcript, /Computer QA computer-frame: fail/);
    assert.match(turn.transcript, /not a PNG/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Slack delivery verifies a signature and posts the partner reply", async () => {
  const now = 1_700_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const secret = "signing-secret";
  const raw = JSON.stringify({ type: "event_callback", event: { text: "deny", channel: "dev", ts: "1.2" } });
  const signature = slackSignature(secret, timestamp, raw);
  assert.equal(verifySlackRequest({ secret, timestamp, signature, rawBody: raw, nowMs: now }).ok, true);
  assert.equal(verifySlackRequest({ secret, timestamp, signature: "v0=nope", rawBody: raw, nowMs: now }).reason, "bad signature");
  assert.equal(verifySlackRequest({ secret, timestamp, signature, rawBody: raw, nowMs: now + 6 * 60 * 1000 }).reason, "stale timestamp");
  let posted = "";
  let bearer = "";
  const delivered = await deliverSlackEvent(
    {
      rawBody: raw,
      timestamp,
      signature,
      signingSecret: secret,
      botToken: "xoxb-test",
      nowMs: now,
      fetchImpl: async (_url, init) => {
        bearer = String((init?.headers as { authorization?: string } | undefined)?.authorization ?? "");
        posted = String(init?.body ?? "");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
    async (message) => `turn:${message}`,
  );
  assert.equal(delivered.ok, true);
  assert.equal(delivered.posted, true);
  assert.equal(delivered.reply, "turn:deny");
  assert.equal(bearer, "Bearer xoxb-test");
  assert.match(posted, /"channel":"dev"/);
  assert.match(posted, /"thread_ts":"1.2"/);
  assert.doesNotMatch(posted, /signing-secret/);
  assert.equal(verifySlackRequest({ secret, timestamp: "", signature: "", rawBody: raw, nowMs: now }).reason, "missing signature");

  let runs = 0;
  const challengeBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
  const challenge = await deliverSlackEvent(
    {
      rawBody: challengeBody,
      timestamp,
      signature: slackSignature(secret, timestamp, challengeBody),
      signingSecret: secret,
      botToken: "xoxb-test",
      nowMs: now,
      fetchImpl: async () => {
        throw new Error("challenge must not post");
      },
    },
    async () => {
      runs += 1;
      return "ran";
    },
  );
  assert.equal(challenge.ok, true);
  assert.equal(challenge.reply, "abc123");
  assert.equal(challenge.posted, false);
  assert.equal(runs, 0);

  const rejected = await deliverSlackEvent(
    {
      rawBody: raw,
      timestamp,
      signature: "v0=nope",
      signingSecret: secret,
      botToken: "xoxb-test",
      nowMs: now,
    },
    async () => {
      runs += 1;
      return "ran";
    },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reply, "bad signature");
  assert.equal(rejected.posted, false);
  assert.equal(runs, 0);

  const offline = await deliverSlackEvent(
    {
      rawBody: raw,
      timestamp,
      signature,
      signingSecret: secret,
      botToken: "xoxb-test",
      nowMs: now,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    },
    async (message) => `turn:${message}`,
  );
  assert.equal(offline.ok, false);
  assert.equal(offline.posted, false);
  assert.equal(offline.reply, "turn:deny");
});

test("a signed Slack deny still decides the Approve card", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-slack-card-"));
  try {
    await writeFile(path.join(root, "PARTNER.md"), "partner\n");
    const asked = await runChatTurn({ message: "add a helper", sandboxRoot: root, partnerId: "slack-dev" });
    assert.match(asked.transcript, /Approve card/);
    const now = 1_700_000_000_000;
    const timestamp = String(Math.floor(now / 1000));
    const secret = "signing-secret";
    const raw = JSON.stringify({ type: "event_callback", event: { text: "deny", channel: "dev", ts: "9.9" } });
    const delivered = await deliverSlackEvent(
      {
        rawBody: raw,
        timestamp,
        signature: slackSignature(secret, timestamp, raw),
        signingSecret: secret,
        botToken: "xoxb-test",
        nowMs: now,
        fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      async (message, partnerId) => {
        const turn = await runChatTurn({ message, sandboxRoot: root, partnerId });
        return turn.transcript;
      },
    );
    assert.equal(delivered.ok, true);
    assert.equal(delivered.posted, true);
    assert.match(delivered.reply, /Approve denied/);
    assert.doesNotMatch(delivered.reply, /xoxb-test/);
    assert.doesNotMatch(delivered.reply, /signing-secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram delivery checks the webhook secret and posts the partner reply", async () => {
  const secret = "webhook-secret";
  const raw = JSON.stringify({ message: { message_id: 9, text: "deny", chat: { id: 42 } } });
  assert.equal(verifyTelegramRequest({ secret, header: secret }).ok, true);
  assert.equal(verifyTelegramRequest({ secret, header: "" }).reason, "missing secret");
  assert.equal(verifyTelegramRequest({ secret, header: "nope" }).reason, "bad secret");
  let posted = "";
  let url = "";
  const delivered = await deliverTelegramUpdate(
    {
      rawBody: raw,
      secretHeader: secret,
      webhookSecret: secret,
      botToken: "123:telegram-secret",
      fetchImpl: async (target, init) => {
        url = String(target);
        posted = String(init?.body ?? "");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
    async (message) => `turn:${message}`,
  );
  assert.equal(delivered.ok, true);
  assert.equal(delivered.posted, true);
  assert.equal(delivered.reply, "Telegram adapter\nturn:deny");
  assert.match(url, /\/sendMessage$/);
  assert.doesNotMatch(posted, /telegram-secret/);
  assert.doesNotMatch(posted, /webhook-secret/);
  assert.match(posted, /"chat_id":"42"/);
  assert.match(posted, /"reply_to_message_id":9/);
  const rejected = await deliverTelegramUpdate(
    { rawBody: raw, secretHeader: "nope", webhookSecret: secret, botToken: "123:telegram-secret" },
    async () => "ran",
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.posted, false);
  assert.equal(rejected.reply, "bad secret");
});

test("a Telegram deny still decides the Approve card", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-telegram-card-"));
  try {
    await writeFile(path.join(root, "PARTNER.md"), "partner\n");
    const asked = await runChatTurn({ message: "add a helper", sandboxRoot: root, partnerId: "telegram-42" });
    assert.match(asked.transcript, /Approve card/);
    const raw = JSON.stringify({ message: { message_id: 3, text: "deny", chat: { id: 42 } } });
    const delivered = await deliverTelegramUpdate(
      {
        rawBody: raw,
        secretHeader: "webhook-secret",
        webhookSecret: "webhook-secret",
        botToken: "123:telegram-secret",
        fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      async (message, partnerId) => {
        const turn = await runChatTurn({ message, sandboxRoot: root, partnerId });
        return turn.transcript;
      },
    );
    assert.equal(delivered.ok, true);
    assert.match(delivered.reply, /Approve denied/);
    assert.doesNotMatch(delivered.reply, /telegram-secret/);
    assert.doesNotMatch(delivered.reply, /webhook-secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a billing key stays inert and the core stays open", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-pack-"));
  try {
    await mkdir(path.join(root, ".ocp"), { recursive: true });
    await writeFile(
      path.join(root, ".ocp", "settings.json"),
      `${JSON.stringify({ packaging: { plan: "seats", seats: 4, credits: 10, billing: "later" } })}\n`,
    );
    const packaging = await readPackaging(root);
    assert.equal(packaging.plan, "oss");
    assert.equal(packaging.seats, 4);
    assert.equal(packaging.credits, 10);
    assert.equal(packaging.billing, "inert");
    assert.equal(packaging.core, "full");
    assert.equal(coreIsOpen(packaging), true);
    const turn = await runChatTurn({
      message: "Use the coding worker to create hello.txt with content:\nhello\n",
      sandboxRoot: root,
    });
    assert.equal(turn.coding?.wrote, true);
    assert.equal(await readFile(path.join(root, "hello.txt"), "utf8"), "hello\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advanced ACP stays off unless asked, and the stub does not replace the swarm", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-acp-"));
  try {
    const off = await runChatTurn({ message: "add a note", sandboxRoot: root });
    assert.doesNotMatch(off.transcript, /Advanced ACP/);
    assert.match(off.transcript, /local swarm ran this turn/);
    assert.ok(off.agents.some((agent) => agent.role === "coding"));
    const on = await runChatTurn({ message: "add a note again", sandboxRoot: root, acp: true });
    assert.match(on.transcript, /No ACP backend is installed/);
    assert.match(on.transcript, /local swarm ran this turn/);
    assert.ok(on.agents.some((agent) => agent.role === "coding"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed partner check returns to intent and holds one coding worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-partner-fail-"));
  try {
    await writeFile(path.join(root, "PARTNER.md"), "partner\n");
    await runChatTurn({ message: "add a broken check", sandboxRoot: root });
    const failed = await runChatTurn({
      message: "accept the plan",
      sandboxRoot: root,
      checkExec: async () => ({ code: 1, stdout: "failed", stderr: "" }),
      grokRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ done: true, steps: [{ tool: "write", path: "src/note.txt", content: "note\n" }] }),
          };
        },
      },
    });
    assert.match(failed.transcript, /Self-verify: node --test \(exit 1\)/);
    assert.match(failed.transcript, /Returned to intent/);
    assert.match(await readFile(path.join(root, ".ocp/sdlc/intent.md"), "utf8"), /Returned from review/);
    assert.match(await readFile(path.join(root, ".ocp/sdlc/review-hold"), "utf8"), /exit 1/);
    const capped = rolesUnderReviewHold(["coding", "coding", "qa", "security", "computer"]);
    assert.equal(capped.filter((role) => role === "coding").length, REVIEW_HOLD_CODING_CAP);
    assert.equal(capped.length, 4);
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
