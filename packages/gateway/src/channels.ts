import { createHmac, timingSafeEqual } from "node:crypto";

/** Channel inbound becomes a partner turn. Approve and deny are ordinary replies. */

export interface ChannelInbound {
  text: string;
  channel: string;
}

export interface ChannelReply {
  partnerId: string;
  message: string;
  reply: string;
}

export function channelPartnerId(prefix: "slack" | "telegram" | "discord", channel: string): string {
  const slug = channel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  const id = `${prefix}-${slug || "channel"}`;
  return id.slice(0, 32);
}

export function slackCredentialStatus(env: NodeJS.ProcessEnv): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!env.SLACK_BOT_TOKEN) missing.push("SLACK_BOT_TOKEN");
  if (!env.SLACK_SIGNING_SECRET) missing.push("SLACK_SIGNING_SECRET");
  return { ready: missing.length === 0, missing };
}

export function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

/** Reject a missing, stale, or mismatched signature. The secret is not returned. */
export function verifySlackRequest(input: {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  nowMs: number;
}): { ok: boolean; reason: string } {
  const sent = Number(input.timestamp);
  if (!input.timestamp || !input.signature || !Number.isFinite(sent)) return { ok: false, reason: "missing signature" };
  if (Math.abs(input.nowMs - sent * 1000) > 5 * 60 * 1000) return { ok: false, reason: "stale timestamp" };
  const expected = slackSignature(input.secret, input.timestamp, input.rawBody);
  const left = Buffer.from(expected);
  const right = Buffer.from(input.signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, reason: "bad signature" };
  return { ok: true, reason: "" };
}

export function slackEventMessage(rawBody: string): { text: string; channel: string; thread: string; challenge?: string } | undefined {
  let body: { type?: string; challenge?: string; event?: { text?: string; channel?: string; thread_ts?: string; ts?: string } };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return undefined;
  }
  if (body.type === "url_verification" && body.challenge) return { text: "", channel: "", thread: "", challenge: body.challenge };
  const text = body.event?.text?.trim() ?? "";
  const channel = body.event?.channel ?? "";
  if (!text || !channel) return undefined;
  return { text, channel, thread: body.event?.thread_ts || body.event?.ts || "" };
}

export async function postSlackReply(
  token: string,
  channel: string,
  text: string,
  thread: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  let response: Response;
  try {
    response = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, text, ...(thread ? { thread_ts: thread } : {}) }),
    });
  } catch {
    return { ok: false, detail: "Slack post did not connect." };
  }
  if (!response.ok) return { ok: false, detail: `Slack post returned HTTP ${response.status}.` };
  let payload: { ok?: boolean };
  try {
    payload = (await response.json()) as { ok?: boolean };
  } catch {
    return { ok: false, detail: "Slack post returned an unreadable body." };
  }
  if (payload.ok === false) return { ok: false, detail: "Slack post was refused." };
  return { ok: true, detail: "Slack post sent." };
}

export async function deliverSlackEvent(
  input: {
    rawBody: string;
    timestamp: string;
    signature: string;
    signingSecret: string;
    botToken: string;
    nowMs: number;
    fetchImpl?: typeof fetch;
  },
  run: (message: string, partnerId: string) => Promise<string>,
): Promise<{ ok: boolean; reply: string; posted: boolean }> {
  const verified = verifySlackRequest({
    secret: input.signingSecret,
    timestamp: input.timestamp,
    signature: input.signature,
    rawBody: input.rawBody,
    nowMs: input.nowMs,
  });
  if (!verified.ok) return { ok: false, reply: verified.reason, posted: false };
  const event = slackEventMessage(input.rawBody);
  if (!event) return { ok: false, reply: "Slack event had no text.", posted: false };
  if (event.challenge) return { ok: true, reply: event.challenge, posted: false };
  const turn = await slackTurn({ text: event.text, channel: event.channel }, run);
  const posted = await postSlackReply(input.botToken, event.channel, turn.reply, event.thread, input.fetchImpl);
  return { ok: posted.ok, reply: turn.reply, posted: posted.ok };
}

export async function slackTurn(
  inbound: ChannelInbound,
  run: (message: string, partnerId: string) => Promise<string>,
): Promise<ChannelReply> {
  const partnerId = channelPartnerId("slack", inbound.channel);
  const message = inbound.text.trim();
  const reply = await run(message, partnerId);
  return { partnerId, message, reply };
}

export function telegramCredentialStatus(env: NodeJS.ProcessEnv): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!env.TELEGRAM_WEBHOOK_SECRET) missing.push("TELEGRAM_WEBHOOK_SECRET");
  return { ready: missing.length === 0, missing };
}

/** Reject a missing or mismatched webhook secret. The secret is not returned. */
export function verifyTelegramRequest(input: { secret: string; header: string }): { ok: boolean; reason: string } {
  if (!input.secret || !input.header) return { ok: false, reason: "missing secret" };
  const left = Buffer.from(input.secret);
  const right = Buffer.from(input.header);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, reason: "bad secret" };
  return { ok: true, reason: "" };
}

export function telegramUpdateMessage(rawBody: string): { text: string; chatId: string; replyTo: string } | undefined {
  let body: { message?: { text?: string; message_id?: number; chat?: { id?: number | string } } };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return undefined;
  }
  const text = body.message?.text?.trim() ?? "";
  const chat = body.message?.chat?.id;
  if (!text || chat === undefined || chat === "") return undefined;
  const replyTo = body.message?.message_id === undefined ? "" : String(body.message.message_id);
  return { text, chatId: String(chat), replyTo };
}

export async function postTelegramReply(
  token: string,
  chatId: string,
  text: string,
  replyTo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  const replyId = /^\d+$/.test(replyTo) ? Number(replyTo) : undefined;
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...(replyId !== undefined ? { reply_to_message_id: replyId } : {}) }),
    });
  } catch {
    return { ok: false, detail: "Telegram post did not connect." };
  }
  if (!response.ok) return { ok: false, detail: `Telegram post returned HTTP ${response.status}.` };
  let payload: { ok?: boolean };
  try {
    payload = (await response.json()) as { ok?: boolean };
  } catch {
    return { ok: false, detail: "Telegram post returned an unreadable body." };
  }
  if (payload.ok === false) return { ok: false, detail: "Telegram post was refused." };
  return { ok: true, detail: "Telegram post sent." };
}

export async function deliverTelegramUpdate(
  input: {
    rawBody: string;
    secretHeader: string;
    webhookSecret: string;
    botToken: string;
    fetchImpl?: typeof fetch;
  },
  run: (message: string, partnerId: string) => Promise<string>,
): Promise<{ ok: boolean; reply: string; posted: boolean }> {
  const verified = verifyTelegramRequest({ secret: input.webhookSecret, header: input.secretHeader });
  if (!verified.ok) return { ok: false, reply: verified.reason, posted: false };
  const update = telegramUpdateMessage(input.rawBody);
  if (!update) return { ok: false, reply: "Telegram update had no text.", posted: false };
  const turn = await telegramTurn({ text: update.text, channel: update.chatId }, run);
  const posted = await postTelegramReply(input.botToken, update.chatId, turn.reply, update.replyTo, input.fetchImpl);
  return { ok: posted.ok, reply: turn.reply, posted: posted.ok };
}

/** Same partner turn as Slack. A live reply is posted only when Telegram credentials are set. */
export async function telegramTurn(
  inbound: ChannelInbound,
  run: (message: string, partnerId: string) => Promise<string>,
): Promise<ChannelReply> {
  const partnerId = channelPartnerId("telegram", inbound.channel);
  const message = inbound.text.trim();
  const reply = await run(message, partnerId);
  return { partnerId, message, reply: `Telegram adapter\n${reply}` };
}

/** Same partner turn as Slack. This build does not call Discord. */
export async function discordTurn(
  inbound: ChannelInbound,
  run: (message: string, partnerId: string) => Promise<string>,
): Promise<ChannelReply> {
  const partnerId = channelPartnerId("discord", inbound.channel);
  const message = inbound.text.trim();
  const reply = await run(message, partnerId);
  return { partnerId, message, reply: `Discord adapter\n${reply}` };
}
