import { readFile } from "node:fs/promises";
import { isolatePartner, partnerIdDecision } from "./fleet.js";
import { createRoutine, listRoutines } from "./routines.js";

export interface SwarmPartner {
  id: string;
  role: string;
  kind: "coding" | "chat";
  channel?: "slack" | "telegram" | "discord";
}

export interface SwarmRoutine {
  partnerId: string;
  message: string;
  everyMs?: number;
  event?: string;
}

export interface SwarmManifest {
  system: string;
  partners: SwarmPartner[];
  routines: SwarmRoutine[];
}

const CHANNELS = new Set(["slack", "telegram", "discord"]);

export function parseSwarmManifest(raw: string): SwarmManifest {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("swarm manifest must be JSON");
  }
  if (!body || typeof body !== "object") throw new Error("swarm manifest must be an object");
  const record = body as { system?: unknown; partners?: unknown; routines?: unknown };
  return {
    system: typeof record.system === "string" ? record.system : "",
    partners: Array.isArray(record.partners) ? (record.partners as SwarmPartner[]) : [],
    routines: Array.isArray(record.routines) ? (record.routines as SwarmRoutine[]) : [],
  };
}

/** Refuse bad ids, unknown kinds, missing schedules, and short intervals. */
export function validateSwarmManifest(manifest: SwarmManifest): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(manifest.system)) errors.push("system name must be a short lowercase name");
  if (manifest.partners.length === 0) errors.push("swarm needs at least one partner");
  if (manifest.partners.length > 8) errors.push("swarm is capped at 8 partners");
  if (manifest.routines.length > 20) errors.push("swarm is capped at 20 routines");
  const ids = new Set<string>();
  for (const partner of manifest.partners) {
    const decision = partnerIdDecision(partner.id ?? "");
    if (!decision.allow) errors.push(decision.reason);
    if (ids.has(partner.id)) errors.push(`duplicate partner ${partner.id}`);
    ids.add(partner.id);
    if (partner.kind !== "coding" && partner.kind !== "chat") errors.push(`partner ${partner.id} kind must be coding or chat`);
    if (partner.channel && !CHANNELS.has(partner.channel)) errors.push(`partner ${partner.id} channel is not supported`);
    if (partner.kind === "coding" && partner.channel) errors.push(`coding partner ${partner.id} does not take a channel`);
  }
  for (const routine of manifest.routines) {
    if (!ids.has(routine.partnerId)) errors.push(`routine partner ${routine.partnerId} is not in the swarm`);
    if (!routine.message?.trim()) errors.push("routine needs a message");
    const hasEvent = Boolean(routine.event?.trim());
    const hasInterval = routine.everyMs !== undefined;
    if (hasEvent && hasInterval) errors.push("routine must be an interval or an event, not both");
    if (!hasEvent && !hasInterval) errors.push("routine needs everyMs or event");
    if (hasInterval && (!Number.isInteger(routine.everyMs) || (routine.everyMs ?? 0) < 1000)) {
      errors.push("interval must be at least 1000 ms");
    }
  }
  return errors;
}

export function formatSwarmPlan(manifest: SwarmManifest, dryRun: boolean): string {
  const lines = [`Swarm ${manifest.system}`];
  for (const partner of manifest.partners) {
    const channel = partner.channel ? ` channel ${partner.channel}` : "";
    lines.push(`partner ${partner.id} ${partner.kind} workspace .ocp/fleet/${partner.id}${channel}`);
  }
  for (const routine of manifest.routines) {
    const when = routine.event ? `event ${routine.event}` : `every ${routine.everyMs}ms`;
    lines.push(`routine ${routine.partnerId} ${when} ${routine.message}`);
  }
  lines.push(dryRun ? "dry-run: no files written" : "applied");
  return lines.join("\n");
}

export async function applySwarmManifest(
  sessionRoot: string,
  manifest: SwarmManifest,
  options: { dryRun?: boolean; now?: number } = {},
): Promise<{ ok: boolean; text: string }> {
  const errors = validateSwarmManifest(manifest);
  if (errors.length > 0) return { ok: false, text: errors.join("\n") };
  const text = formatSwarmPlan(manifest, options.dryRun === true);
  if (options.dryRun) return { ok: true, text };
  for (const partner of manifest.partners) {
    await isolatePartner(sessionRoot, partner.id, partner.role || partner.kind);
  }
  const existing = await listRoutines(sessionRoot);
  for (const routine of manifest.routines) {
    const already = existing.some((item) => {
      if (item.partnerId !== routine.partnerId || item.message !== routine.message.trim()) return false;
      if (routine.event) return item.trigger.kind === "event" && item.trigger.name === routine.event;
      return item.trigger.kind === "interval" && item.trigger.everyMs === routine.everyMs;
    });
    if (already) continue;
    await createRoutine(sessionRoot, {
      partnerId: routine.partnerId,
      message: routine.message,
      everyMs: routine.everyMs,
      event: routine.event,
      now: options.now ?? Date.now(),
    });
  }
  return { ok: true, text };
}

export async function readSwarmManifest(filePath: string): Promise<SwarmManifest> {
  return parseSwarmManifest(await readFile(filePath, "utf8"));
}
