import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeWithPredict } from "@opencodingpartner/policy";
import { runConnectedPath } from "./connected.js";
import { predictWithLaya } from "./laya.js";

test("predict.py is selected when the Laya python is present", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-laya-py-"));
  const python = path.join(root, "python");
  try {
    await writeFile(
      python,
      "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"answers\":{\"route\":{\"choice\":\"status\",\"probabilities\":{\"status\":0.9,\"multi-agent\":0.1},\"confidence\":0.9,\"rl_agent\":\"laya\"},\"stand_up_computer\":{\"noul\":0.1},\"write_risk\":{\"score\":0.2,\"legend\":\"low\"}},\"routing\":{\"model\":\"english\"}}'\n",
    );
    await chmod(python, 0o755);
    const raw = await predictWithLaya(python, path.join(root, "predict.py"), "add a function", []);
    const decision = await routeWithPredict("add a function and a test", async () => raw);
    assert.equal(decision.note, "System-1: real Laya.");
    assert.equal(decision.route, "status");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway down and missing grok are both skipped", async () => {
  const report = await runConnectedPath({
    env: {},
    bins: {},
    gatewayHttp: "http://127.0.0.1:9",
    fetchImpl: async () => {
      throw new Error("refused");
    },
  });
  assert.equal(report.code, 0);
  assert.match(report.transcript, /OpenClaw gateway: skipped/);
  assert.match(report.transcript, /Chat turn: skipped/);
  assert.match(report.transcript, /Coding\/QA on Grok Build: skipped \(grok binary not installed\)/);
});

test("a live gateway receives the chat turn and grok runs only with a key", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/healthz" ? '{"ok":true}' : '{"id":"chat"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const calls: string[][] = [];
  try {
    const skipped = await runConnectedPath({
      env: {},
      bins: { grokBin: "/tmp/grok" },
      gatewayHttp: `http://127.0.0.1:${port}`,
      exec: async () => {
        throw new Error("grok must not run without XAI_API_KEY");
      },
    });
    assert.match(skipped.transcript, /Chat turn: ran\. OpenClaw chat completions accepted session agent:board:main/);
    assert.match(skipped.transcript, /skipped \(set XAI_API_KEY/);
    assert.equal(skipped.code, 0);

    const ran = await runConnectedPath({
      env: { XAI_API_KEY: "xai-test-secret", OPENCLAW_GATEWAY_TOKEN: "gateway-secret" },
      bins: { openclawBin: "/tmp/openclaw", grokBin: "/tmp/grok" },
      gatewayHttp: `http://127.0.0.1:${port}`,
      exec: async (bin, args) => {
        calls.push([bin, ...args]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    assert.equal(ran.code, 0);
    assert.match(ran.transcript, /Chat turn: ran/);
    assert.match(ran.transcript, /Coding\/QA on Grok Build: ran/);
    assert.doesNotMatch(ran.transcript, /xai-test-secret/);
    assert.doesNotMatch(ran.transcript, /gateway-secret/);
    const chat = calls.find((args) => args.includes("sessions.send"));
    assert.ok(chat);
    assert.match(chat.join(" "), /agent:board:main/);
    assert.equal(chat.includes("gateway-secret"), true);
    const grokCalls = calls.filter((args) => args[0] === "/tmp/grok");
    assert.equal(grokCalls.length, 2);
    assert.equal(grokCalls[0]?.includes("--output-format"), true);
    assert.equal(grokCalls[0]?.includes("streaming-json"), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  assert.ok(seen.includes("GET /healthz"));
});
