import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeWithPredict } from "@opencodingpartner/policy";
import { runOnGrokBuild } from "@opencodingpartner/workers";
import { LITELLM_LOCAL_BASE_URL, resolveCodingMeter, runConnectedPath, writeViaOpenClaw } from "./connected.js";
import { startSandboxWriteBridge } from "./write-bridge.js";
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

test("LiteLLM env wins over OpenAI and XAI and does not print the key", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const meter = resolveCodingMeter(
    { grokBin: "/tmp/grok" },
    {
      LITELLM_API_KEY: "litellm-secret",
      LITELLM_MASTER_KEY: "master-should-lose",
      OPENAI_API_KEY: "openai-secret",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      XAI_API_KEY: "xai-secret",
    },
    {
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenAuth = String((init?.headers as Record<string, string> | undefined)?.authorization);
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"files":[{"path":"a.ts","content":"export const a = 1;\\n"}]}' } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.equal(meter.via, "litellm");
  assert.equal(meter.label, "LiteLLM");
  assert.equal(meter.baseUrl, LITELLM_LOCAL_BASE_URL);
  const root = await mkdtemp(path.join(tmpdir(), "ocp-litellm-"));
  try {
    const result = await runOnGrokBuild(meter.runner!, "add a function", root);
    assert.equal(result.exitCode, 0);
    assert.equal(seenUrl, "http://127.0.0.1:4000/v1/chat/completions");
    assert.equal(seenAuth, "Bearer litellm-secret");
    assert.doesNotMatch(JSON.stringify(meter), /litellm-secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const master = resolveCodingMeter({}, { LITELLM_MASTER_KEY: "master-key", LITELLM_BASE_URL: "https://proxy.example/v1", LITELLM_MODEL: "ocp" });
  assert.equal(master.via, "litellm");
  assert.equal(master.baseUrl, "https://proxy.example/v1");
  assert.equal(master.model, "ocp");

  const openai = resolveCodingMeter({ grokBin: "/tmp/grok" }, { OPENAI_API_KEY: "sk", OPENAI_BASE_URL: "https://openrouter.ai/api/v1", XAI_API_KEY: "xai" });
  assert.equal(openai.via, "openai-compatible");
  assert.equal(openai.label, "OpenAI-compatible");

  const grok = resolveCodingMeter({ grokBin: "/tmp/grok" }, { XAI_API_KEY: "xai" });
  assert.equal(grok.via, "grok-build");
  assert.equal(grok.label, "Grok Build");

  const none = resolveCodingMeter({}, {});
  assert.equal(none.runner, undefined);
});

test("the gateway invokes the write bridge and fs_write is not sent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-write-http-"));
  const bridge = await startSandboxWriteBridge(root);
  const seen: { tool?: string }[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      tool?: string;
      args?: { bridgeUrl?: string; relativePath?: string; content?: string; path?: string };
    };
    seen.push({ tool: body.tool });
    if (body.tool === "fs_write" || body.tool === "sessions_spawn") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"ok":false}');
      return;
    }
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
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"ok":false}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const landed = await writeViaOpenClaw(
      { env: { OCP_WRITE_BRIDGE_URL: bridge.url }, bins: {}, gatewayHttp: `http://127.0.0.1:${port}` },
      root,
      "hello.txt",
      "from-gateway\n",
    );
    assert.equal(landed.ok, true);
    assert.equal(seen[0]?.tool, "ocp_sandbox_write");
    assert.equal(seen.some((call) => call.tool === "fs_write"), false);
    assert.equal(await readFile(path.join(root, "hello.txt"), "utf8"), "from-gateway\n");
    const blocked = await writeViaOpenClaw(
      { env: { OCP_WRITE_BRIDGE_URL: bridge.url }, bins: {}, gatewayHttp: `http://127.0.0.1:${port}` },
      root,
      "../secret.txt",
      "password=hunter2\n",
    );
    assert.equal(blocked.ok, false);
    await assert.rejects(readFile(path.join(root, "secret.txt"), "utf8"));

    const refused = await writeViaOpenClaw(
      {
        env: {},
        bins: {},
        gatewayHttp: `http://127.0.0.1:${port}`,
        fetchImpl: async (url, init) => {
          const payload = JSON.parse(String(init?.body)) as { tool?: string };
          assert.equal(payload.tool, "write");
          if (String(url).endsWith("/healthz")) return new Response('{"ok":true}', { status: 200 });
          return new Response('{"ok":false}', { status: 404 });
        },
      },
      root,
      "missing.txt",
      "nope\n",
    );
    assert.equal(refused.ok, false);
    await assert.rejects(readFile(path.join(root, "missing.txt"), "utf8"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await bridge.close();
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
  assert.match(report.transcript, /Coding\/QA: skipped \(set XAI_API_KEY/);
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
