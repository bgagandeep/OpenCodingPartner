import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "./doctor.js";

test("doctor marks missing pieces and does not print a key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-doctor-"));
  try {
    const missing = await runDoctor({
      env: { LITELLM_API_KEY: "super-secret-value", OPENCLAW_GATEWAY_URL: "http://127.0.0.1:9" },
      bins: {},
      repoRoot: root,
      fetchImpl: async () => {
        throw new Error("refused");
      },
      playwrightPresent: false,
    });
    assert.equal(missing.code, 1);
    assert.match(missing.transcript, /yellow System-1: not installed/);
    assert.match(missing.transcript, /green Meter: proxy/);
    assert.match(missing.transcript, /yellow orchestration \/healthz:/);
    assert.match(missing.transcript, /red Write bridge plugin/);
    assert.match(missing.transcript, /yellow Playwright: not installed/);
    assert.match(missing.transcript, /yellow Slack: missing SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET/);
    assert.doesNotMatch(missing.transcript, /super-secret-value/);

    await mkdir(path.join(root, "integrations/openclaw-sandbox-write"), { recursive: true });
    await writeFile(path.join(root, "integrations/openclaw-sandbox-write/openclaw.plugin.json"), "{}\n");
    const ready = await runDoctor({
      env: {},
      bins: { layaPython: "/tmp/python", layaHfHome: "/tmp/hf" },
      repoRoot: root,
      gatewayHttp: "http://127.0.0.1:18789",
      fetchImpl: async () => new Response("ok", { status: 200 }),
      playwrightPresent: true,
    });
    assert.equal(ready.code, 0);
    assert.match(ready.transcript, /green System-1:/);
    assert.match(ready.transcript, /yellow Meter: none/);
    assert.match(ready.transcript, /green orchestration \/healthz/);
    assert.match(ready.transcript, /green Write bridge plugin/);
    assert.match(ready.transcript, /green Playwright/);
    assert.match(ready.transcript, /yellow Slack: missing SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET/);
    assert.match(ready.transcript, /System-1: fallback/);
    const slack = await runDoctor({
      env: { SLACK_BOT_TOKEN: "xoxb-secret-value", SLACK_SIGNING_SECRET: "signing-secret-value" },
      bins: { layaPython: "/tmp/python", layaHfHome: "/tmp/hf" },
      repoRoot: root,
      fetchImpl: async () => new Response("ok", { status: 200 }),
      playwrightPresent: true,
    });
    assert.match(slack.transcript, /green Slack: bot token and signing secret are set/);
    assert.doesNotMatch(slack.transcript, /xoxb-secret-value/);
    assert.doesNotMatch(slack.transcript, /signing-secret-value/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
