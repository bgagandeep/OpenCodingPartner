import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { slackSignature } from "@opencodingpartner/gateway";
import { startProductApp } from "./server.js";

const SLACK_TOKEN = "xoxb-channel-test-token";
const SLACK_SECRET = "signing-secret-test";
const TELEGRAM_TOKEN = "123:telegram-channel-test";
const TELEGRAM_SECRET = "telegram-webhook-secret";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ocp-channels-"));
}

function localEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: root,
    HERMES_HOME: root,
    OCP_DATA_DIR: root,
  };
}

test("Slack and Telegram replies stay drafts until a person sends them", async () => {
  const root = await tempRoot();
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(`${String(input)} ${String(init?.body ?? "")}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const app = await startProductApp({ root, port: 0, env: localEnv(root), fetchImpl });
  try {
    const html = await (await fetch(app.url)).text();
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec((await fetch(app.url)).headers.get("content-security-policy") ?? "")?.[1] ?? "";
    assert.match(html, /Channels/);
    assert.match(html, /Nothing is sent automatically/);
    assert.doesNotMatch(html, new RegExp(SLACK_TOKEN));
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const botRes = await fetch(`${app.url}/api/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Inbox", role: "general", runtime: "ocp-agent", isolation: "host", workspace, instructions: "Reply briefly." }),
    });
    assert.equal(botRes.status, 201);
    const { bot } = (await botRes.json()) as { bot: { id: string } };
    const saved = await fetch(`${app.url}/api/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slackBotToken: SLACK_TOKEN,
        slackSigningSecret: SLACK_SECRET,
        slackBotId: bot.id,
        telegramBotToken: TELEGRAM_TOKEN,
        telegramWebhookSecret: TELEGRAM_SECRET,
        telegramBotId: bot.id,
      }),
    });
    const savedText = await saved.text();
    assert.equal(saved.status, 200);
    assert.doesNotMatch(savedText, new RegExp(SLACK_TOKEN));
    assert.doesNotMatch(savedText, new RegExp(TELEGRAM_TOKEN));

    const raw = JSON.stringify({
      type: "event_callback",
      event_id: "Ev-channel-1",
      event: { type: "message", text: "hello from slack", channel: "C123", ts: "100.1" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rejected = await fetch(`${app.url}/api/channels/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": "v0=nope" },
      body: raw,
    });
    assert.equal(rejected.status, 401);

    const accepted = await fetch(`${app.url}/api/channels/slack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackSignature(SLACK_SECRET, timestamp, raw),
      },
      body: raw,
    });
    assert.equal(accepted.status, 202);
    const duplicate = await fetch(`${app.url}/api/channels/slack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackSignature(SLACK_SECRET, timestamp, raw),
      },
      body: raw,
    });
    assert.equal(duplicate.status, 200);
    const duplicateBody = await duplicate.json() as { duplicate?: boolean };
    assert.equal(duplicateBody.duplicate, true);

    const draft = await waitForDraft(app.url);
    assert.match(draft.text, /No model is configured/);
    assert.equal(calls.length, 0);
    const stateBefore = await (await fetch(`${app.url}/api/state`)).text();
    assert.doesNotMatch(stateBefore, new RegExp(SLACK_TOKEN));
    assert.match(stateBefore, /hello from slack/);
    assert.match(stateBefore, /"status":"draft"/);

    const deniedUpdate = JSON.stringify({
      update_id: 77,
      message: { message_id: 9, text: "hello from telegram", chat: { id: 42 } },
    });
    const telegram = await fetch(`${app.url}/api/channels/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TELEGRAM_SECRET },
      body: deniedUpdate,
    });
    assert.equal(telegram.status, 202);
    const telegramDraft = await waitForDraft(app.url, "telegram");
    assert.equal(calls.length, 0);
    const denied = await fetch(`${app.url}/api/channels/drafts/${telegramDraft.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "deny" }),
    });
    assert.equal(denied.status, 200);
    assert.equal(calls.length, 0);

    const sent = await fetch(`${app.url}/api/channels/drafts/${draft.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "allow" }),
    });
    const sentBody = await sent.json() as { status?: string };
    assert.equal(sent.status, 200);
    assert.equal(sentBody.status, "sent");
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /https:\/\/slack\.com\/api\/chat\.postMessage/);
    assert.match(calls[0] ?? "", /No model is configured/);
    const stateAfter = await (await fetch(`${app.url}/api/state`)).text();
    assert.doesNotMatch(stateAfter, new RegExp(SLACK_TOKEN));
    assert.doesNotMatch(stateAfter, new RegExp(TELEGRAM_TOKEN));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForDraft(url: string, channel = "slack"): Promise<{ id: string; text: string; status: string }> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const state = await (await fetch(`${url}/api/state`)).json() as { channelLog?: Array<{ id: string; text: string; status: string; channel: string; direction: string }> };
    const draft = (state.channelLog ?? []).find((entry) => entry.channel === channel && entry.direction === "out" && entry.status === "draft");
    if (draft) return draft;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No ${channel} draft appeared.`);
}
