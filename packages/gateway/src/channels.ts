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
