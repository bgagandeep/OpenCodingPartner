import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runChatTurn } from "@opencodingpartner/gateway";
import type { BrowserDriver } from "@opencodingpartner/workers";

const MATH = "src/math.mjs";
const TEST = "src/math.test.mjs";
const BUGGY = "export function add(left, right) {\n  return left - right;\n}\n";
const FIXED = "export function add(left, right) {\n  return left + right;\n}\n";
const TEST_BODY = "import assert from \"node:assert/strict\";\nimport { add } from \"./math.mjs\";\nassert.equal(add(2, 3), 5);\n";
const PATCH = "--- a/src/math.mjs\n+++ b/src/math.mjs\n@@ -1,3 +1,3 @@\n export function add(left, right) {\n-  return left - right;\n+  return left + right;\n }\n";

/**
 * One scripted coding turn. The runner is local. It does not call a meter and does not read API keys.
 */
export async function proveCoding(): Promise<{ code: number; text: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-prove-"));
  try {
    const turn = await runChatTurn({
      message: "fix add in src/math.mjs",
      sandboxRoot: root,
      codingVia: "scripted",
      grokRunner: {
        async run(argv) {
          const prompt = argv[argv.indexOf("-p") + 1] ?? "";
          if (prompt.includes("QA failed")) {
            return { exitCode: 0, stdout: JSON.stringify({ done: true, steps: [] }) };
          }
          if (!prompt.includes("Tool observations:\n")) {
            return { exitCode: 0, stdout: JSON.stringify({ steps: [{ tool: "mkdir", path: "src" }] }) };
          }
          if (!prompt.includes("Tool: write")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                steps: [
                  { tool: "write", path: MATH, content: BUGGY },
                  { tool: "write", path: TEST, content: TEST_BODY },
                ],
              }),
            };
          }
          if (!prompt.includes("Tool: glob")) {
            return { exitCode: 0, stdout: JSON.stringify({ steps: [{ tool: "glob", query: "src/**/*.mjs" }] }) };
          }
          if (!prompt.includes(MATH)) {
            return { exitCode: 0, stdout: JSON.stringify({ done: true, steps: [] }) };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              done: true,
              steps: [
                { tool: "patch", path: MATH, diff: PATCH },
                { tool: "run", argv: ["node", "--test", TEST] },
              ],
            }),
          };
        },
      },
    });
    let math = "";
    try {
      math = await readFile(path.join(root, MATH), "utf8");
    } catch {
      math = "";
    }
    const reasons: string[] = [];
    if (math !== FIXED) reasons.push(`${MATH} was not patched to add`);
    try {
      await readFile(path.join(root, TEST), "utf8");
    } catch {
      reasons.push(`${TEST} is missing`);
    }
    for (const line of [`Tool: mkdir src`, `Tool: write ${MATH}`, `Tool: glob src/**/*.mjs`, `Tool: patch ${MATH}`, `Tool: run node --test ${TEST}`]) {
      if (!turn.transcript.includes(line)) reasons.push(`transcript missing ${line}`);
    }
    if (!turn.transcript.includes("Mkdir path: local sandbox.")) reasons.push("mkdir was not local");
    if (turn.qa?.pass !== true) reasons.push("the check did not pass");
    if (reasons.length > 0) {
      return {
        code: 1,
        text: `ocp prove coding\nFailed. ${reasons[0]}\nThis proof uses a scripted runner. It does not call a live meter and it does not print keys.\n`,
      };
    }
    return {
      code: 0,
      text: `ocp prove coding\nPassed. A scripted runner made src/, wrote ${MATH}, globbed it, patched add, and node --test exited 0.\nNo live meter ran. No API key was used.\n\n${turn.transcript}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const PROVE_PAGE = 'sell this page. Open https://example.com then scroll down then press Enter then hover #buy then double-click #buy then right-click #buy then expect text "lower"';

function fakeBrowser(): BrowserDriver {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const top = { title: "Example", text: "top", screenshotPng: png };
  const lower = { title: "Example", text: "lower", screenshotPng: png };
  return {
    async start() {
      return {
        async open() {
          return top;
        },
        async readScreen() {
          return lower;
        },
        async typeInto() {
          return lower;
        },
        async scrollBy() {
          return lower;
        },
        async press() {
          return lower;
        },
        async hover() {
          return lower;
        },
        async doubleClick() {
          return lower;
        },
        async rightClick() {
          return lower;
        },
        async close() {
          return undefined;
        },
      };
    },
  };
}

/**
 * One scripted computer chain. A fake browser driver does the work.
 * Playwright is not required. OpenClaw does not run the browser.
 */
export async function proveComputer(): Promise<{ code: number; text: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-prove-computer-"));
  try {
    const turn = await runChatTurn({
      message: PROVE_PAGE,
      sandboxRoot: root,
      computerExecute: true,
      browserDriver: fakeBrowser(),
    });
    const reasons: string[] = [];
    let run: { steps?: { kind?: string; passed?: boolean; screenshot?: string; executed?: boolean }[] } = {};
    try {
      run = JSON.parse(await readFile(path.join(root, "gtm", "last-run.json"), "utf8")) as typeof run;
    } catch {
      reasons.push("gtm/last-run.json is missing");
    }
    for (const kind of ["scroll", "press", "hover", "double-click", "right-click"] as const) {
      const step = run.steps?.find((item) => item.kind === kind);
      if (!step?.passed || !step.screenshot) {
        reasons.push(`${kind} did not pass with a screenshot`);
        continue;
      }
      try {
        const bytes = await readFile(path.join(root, step.screenshot));
        if (bytes.length === 0) reasons.push(`${kind} screenshot is empty`);
      } catch {
        reasons.push(`${kind} screenshot file is missing`);
      }
      if (!turn.transcript.includes(`- ${kind}`) || !new RegExp(`${kind}[^\\n]*executed: true`).test(turn.transcript)) {
        reasons.push(`transcript did not show a ${kind} that ran`);
      }
    }
    if (!turn.transcript.includes("verify lower")) {
      reasons.push("transcript did not show the page check");
    }
    if (/OpenClaw (opened|ran the browser)/i.test(turn.transcript)) {
      reasons.push("transcript claimed OpenClaw ran the browser");
    }
    if (turn.qa?.pass !== true) reasons.push("the page check did not pass");
    if (reasons.length > 0) {
      return {
        code: 1,
        text: `ocp prove computer\nFailed. ${reasons[0]}\nThis proof uses a fake browser driver. OpenClaw does not run the browser. It does not print keys.\n`,
      };
    }
    return {
      code: 0,
      text: `ocp prove computer\nPassed. A fake browser driver opened https://example.com, scrolled, pressed Enter, hovered #buy, double-clicked #buy, right-clicked #buy, and the page text matched.\nThis is one scripted chain, not a full go-to-market run. OpenClaw did not run the browser. Playwright was not required. No API key was used.\n\n${turn.transcript}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
