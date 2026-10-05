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

/** Same partner turn as Slack. This build does not call Telegram. */
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
