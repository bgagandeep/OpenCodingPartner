import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PathRejectedError, type CodingDispatch, type WorkerTask } from "@opencodingpartner/mesh";

import { CursorCloudCodingWorker, buildCursorCreateAgentRequest } from "./cursor-cloud.js";
import { GrokBuildCodingWorker, buildGrokHeadlessInvocation } from "./grok-build.js";
import { LocalSandboxWorker } from "./local-sandbox.js";
import { CodingWorkerNotConfiguredError } from "./worker.js";

const task: WorkerTask = {
  id: "write:BOARD.md",
  kind: "write_file",
  relativePath: "BOARD.md",
  contents: "ready\n",
  rationale: "test",
};

function dispatch(sandboxRoot: string, relativePath = task.relativePath): CodingDispatch {
  return {
    sessionKey: "agent:board:main",
    turnId: "turn-1",
    idempotencyKey: "test",
    sandboxRoot,
    task: { ...task, relativePath },
  };
}

test("local sandbox worker writes only inside the sandbox", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-sandbox-"));
  const result = await new LocalSandboxWorker().dispatch(dispatch(root));
  assert.equal(result.location.kind, "sandbox");
  if (result.location.kind === "sandbox") {
    assert.equal(await readFile(result.location.absolutePath, "utf8"), "ready\n");
  }
  await assert.rejects(
    () => new LocalSandboxWorker().dispatch(dispatch(root, "../outside.txt")),
    PathRejectedError,
  );
});

test("cursor request matches the v1 create-agent shape and stays offline by default", async () => {
  const body = buildCursorCreateAgentRequest({
    prompt: "Perform exactly one file write.",
    repositoryUrl: "https://github.com/example/repo",
    startingRef: "main",
  });
  assert.equal(body.autoCreatePR, false);
  assert.equal(body.mode, "agent");
  assert.equal(body.repos[0].url, "https://github.com/example/repo");
  assert.equal(body.repos[0].startingRef, "main");
  assert.equal(body.prompt.text.includes("Perform exactly one file write."), true);

  const calls: unknown[] = [];
  await assert.rejects(
    () => new CursorCloudCodingWorker().dispatch(dispatch("/tmp/unused")),
    CodingWorkerNotConfiguredError,
  );
  assert.equal(calls.length, 0);

  const worker = new CursorCloudCodingWorker({
    apiKey: "operator-key",
    repositoryUrl: "https://github.com/example/repo",
    startingRef: "main",
    transport: {
      async createAgent(request, apiKey) {
        calls.push({ request, apiKey });
        return { agentId: "bc-test", runId: "run-test", runStatus: "CREATING" };
      },
    },
  });
  const result = await worker.dispatch(dispatch("/tmp/unused"));
  assert.equal(calls.length, 1);
  const call = calls[0] as { request: { autoCreatePR: boolean }; apiKey: string };
  assert.equal(call.apiKey, "operator-key");
  assert.equal(call.request.autoCreatePR, false);
  assert.equal(result.location.kind, "external");
});

test("grok invocation is the documented headless argv and does not spawn", async () => {
  const invocation = buildGrokHeadlessInvocation({ prompt: "write BOARD.md", cwd: "/work/sandbox" });
  assert.deepEqual(invocation.argv, [
    "grok",
    "-p",
    "write BOARD.md",
    "--cwd",
    "/work/sandbox",
    "--output-format",
    "streaming-json",
  ]);
  await assert.rejects(
    () => new GrokBuildCodingWorker().dispatch(dispatch("/work/sandbox")),
    CodingWorkerNotConfiguredError,
  );
  let seen = 0;
  const worker = new GrokBuildCodingWorker({
    async run(next) {
      seen += 1;
      assert.equal(next.argv[0], "grok");
      assert.equal(next.argv.includes("--output-format"), true);
      return { exitCode: 0, stdout: "" };
    },
  });
  await worker.dispatch(dispatch("/work/sandbox"));
  assert.equal(seen, 1);
});
