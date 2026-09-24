import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCreateFileInstruction, writeSandboxFile } from "./coding.js";
import { planGtmActions } from "./computer.js";
import { grokBuildArgv, runOnGrokBuild } from "./grok.js";
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

test("computer agent records a GTM plan that did not run", () => {
  const plan = planGtmActions("OpenCodingPartner");
  assert.match(plan.note, /No live browser ran/);
  assert.ok(plan.actions.length >= 1);
  for (const action of plan.actions) {
    assert.equal(action.executed, false);
    assert.equal(action.liveBrowser, false);
  }
});
