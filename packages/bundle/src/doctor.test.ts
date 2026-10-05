import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { dockerLine, runDoctor } from "./doctor.js";

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
    assert.match(missing.transcript, /yellow Computer capture: Playwright is not installed/);
    assert.match(missing.transcript, /pnpm exec playwright install chromium/);
    assert.match(missing.transcript, /This check does not start the browser/);
    assert.doesNotMatch(missing.transcript, /Computer QA computer-frame/);
    assert.match(missing.transcript, /yellow Slack: missing SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET/);
    assert.match(missing.transcript, /yellow Telegram: missing TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET/);
    assert.match(missing.transcript, /green Approvals: none pending/);
    assert.match(missing.transcript, /does not decide a card/);
    assert.match(missing.transcript, /yellow Computer frame: none at gtm\/last-frame.png/);
    assert.match(missing.transcript, /yellow Computer run: none/);
    assert.match(missing.transcript, /does not open a page/);
    assert.match(missing.transcript, /green Computer control: partner/);
    assert.match(missing.transcript, /does not take or return the browser/);
    assert.match(missing.transcript, /green Review hold: none/);
    assert.match(missing.transcript, /yellow Partner agreement: PARTNER.md is missing/);
    assert.match(missing.transcript, /does not copy the file/);
    assert.match(missing.transcript, /green Todos: none open/);
    assert.match(missing.transcript, /does not change the list/);
    assert.match(missing.transcript, /yellow Docker: docker is not available/);
    assert.match(missing.transcript, /does not start containers/);
    assert.match(missing.transcript, /yellow Fleet: no partners/);
    assert.match(missing.transcript, /No telemetry is sent/);
    assert.doesNotMatch(missing.transcript, /Prometheus/);
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
      dockerLine: dockerLine(true),
    });
    assert.equal(ready.code, 0);
    assert.match(ready.transcript, /green Docker: the docker command answered/);
    assert.match(ready.transcript, /This check does not start containers/);
    assert.match(ready.transcript, /green System-1:/);
    assert.match(ready.transcript, /yellow Meter: none/);
    assert.match(ready.transcript, /green orchestration \/healthz/);
    assert.match(ready.transcript, /green Write bridge plugin/);
    assert.match(ready.transcript, /green Computer capture: Playwright is installed/);
    assert.match(ready.transcript, /This check does not start the browser/);
    assert.match(ready.transcript, /yellow Slack: missing SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET/);
    assert.match(ready.transcript, /System-1: fallback/);
    const slack = await runDoctor({
      env: { SLACK_BOT_TOKEN: "xoxb-secret-value", SLACK_SIGNING_SECRET: "signing-secret-value" },
      bins: { layaPython: "/tmp/python", layaHfHome: "/tmp/hf" },
      repoRoot: root,
      fetchImpl: async () => new Response("ok", { status: 200 }),
      playwrightPresent: true,
    });
    assert.match(slack.transcript, /yellow Slack: the bot token was not accepted/);
    assert.match(slack.transcript, /does not post a message/);
    assert.doesNotMatch(slack.transcript, /xoxb-secret-value/);
    assert.doesNotMatch(slack.transcript, /signing-secret-value/);
    assert.match(slack.transcript, /yellow Telegram: missing TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET/);
    const telegram = await runDoctor({
      env: { TELEGRAM_BOT_TOKEN: "123:telegram-secret", TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value" },
      bins: { layaPython: "/tmp/python", layaHfHome: "/tmp/hf" },
      repoRoot: root,
      fetchImpl: async () => new Response("ok", { status: 200 }),
      playwrightPresent: true,
    });
    assert.match(telegram.transcript, /yellow Telegram: the bot token was not accepted/);
    assert.match(telegram.transcript, /does not post a message/);
    assert.doesNotMatch(telegram.transcript, /123:telegram-secret/);
    assert.doesNotMatch(telegram.transcript, /webhook-secret-value/);
    assert.match(telegram.transcript, /green Write bridge plugin: the gateway offered ocp_sandbox_todo/);
    assert.match(telegram.transcript, /does not update a list/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor asks whether the gateway offers the todo tool and does not send a bridge url", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-doctor-bridge-"));
  try {
    await mkdir(path.join(root, "integrations/openclaw-sandbox-write"), { recursive: true });
    await writeFile(path.join(root, "integrations/openclaw-sandbox-write/openclaw.plugin.json"), "{}\n");
    const down = await runDoctor({
      env: {},
      bins: {},
      repoRoot: root,
      gatewayHttp: "http://127.0.0.1:9",
      fetchImpl: async () => {
        throw new Error("refused");
      },
    });
    assert.match(down.transcript, /The gateway did not answer, so this check does not prove it loaded/);
    let body = "";
    const missing = await runDoctor({
      env: { OPENCLAW_GATEWAY_TOKEN: "gateway-token-secret" },
      bins: {},
      repoRoot: root,
      gatewayHttp: "http://127.0.0.1:9",
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/healthz")) return new Response("ok", { status: 200 });
        body = String(init?.body ?? "");
        return new Response('{"ok":false}', { status: 404 });
      },
    });
    assert.match(missing.transcript, /yellow Write bridge plugin: the gateway did not offer ocp_sandbox_todo/);
    assert.match(missing.transcript, /does not update a list/);
    assert.doesNotMatch(missing.transcript, /gateway-token-secret/);
    assert.match(body, /"tool":"ocp_sandbox_todo"/);
    assert.match(body, /"action":"status"/);
    assert.doesNotMatch(body, /bridgeUrl/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor asks Slack and Telegram whether the bot token is accepted and does not post", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocp-doctor-channel-"));
  try {
    const calls: string[] = [];
    const accepted = await runDoctor({
      env: {
        SLACK_BOT_TOKEN: "xoxb-live-secret",
        SLACK_SIGNING_SECRET: "signing-live-secret",
        TELEGRAM_BOT_TOKEN: "999:telegram-live-secret",
        TELEGRAM_WEBHOOK_SECRET: "webhook-live-secret",
      },
      bins: {},
      repoRoot: root,
      fetchImpl: async (url, init) => {
        const target = String(url);
        calls.push(target);
        if (target === "https://slack.com/api/auth.test") {
          const header = new Headers(init?.headers).get("authorization") ?? "";
          if (header !== "Bearer xoxb-live-secret") return new Response('{"ok":false}', { status: 200 });
          return new Response('{"ok":true}', { status: 200 });
        }
        if (target.startsWith("https://api.telegram.org/bot") && target.endsWith("/getMe")) {
          return new Response('{"ok":true}', { status: 200 });
        }
        if (target.endsWith("/healthz")) return new Response("ok", { status: 200 });
        return new Response("ok", { status: 200 });
      },
    });
    assert.match(accepted.transcript, /green Slack: the bot token was accepted/);
    assert.match(accepted.transcript, /signing secret is set and was not sent/);
    assert.match(accepted.transcript, /green Telegram: the bot token was accepted/);
    assert.match(accepted.transcript, /webhook secret is set and was not sent/);
    assert.match(accepted.transcript, /does not post a message/);
    assert.doesNotMatch(accepted.transcript, /xoxb-live-secret/);
    assert.doesNotMatch(accepted.transcript, /signing-live-secret/);
    assert.doesNotMatch(accepted.transcript, /telegram-live-secret/);
    assert.doesNotMatch(accepted.transcript, /webhook-live-secret/);
    assert.equal(calls.includes("https://slack.com/api/auth.test"), true);
    assert.equal(calls.some((url) => url.startsWith("https://api.telegram.org/bot") && url.endsWith("/getMe")), true);
    assert.equal(calls.some((url) => url.includes("chat.postMessage") || url.includes("sendMessage")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
