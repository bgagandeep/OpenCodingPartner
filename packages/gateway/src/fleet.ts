import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface PartnerIdentity {
  id: string;
  role: string;
  desktop: "partner-sandbox";
}

export function partnerIdDecision(id: string): { allow: boolean; reason: string } {
  if (!ID.test(id)) return { allow: false, reason: "partner id must be a short lowercase name" };
  return { allow: true, reason: "" };
}

export function partnerWorkspace(sessionRoot: string, partnerId: string): string {
  return path.join(sessionRoot, ".ocp", "fleet", partnerId);
}

/** Give this partner a workspace of its own. The session root is not the desktop. */
export async function isolatePartner(sessionRoot: string, partnerId: string, role = partnerId): Promise<string> {
  const decision = partnerIdDecision(partnerId);
  if (!decision.allow) throw new Error(decision.reason);
  const workspace = partnerWorkspace(sessionRoot, partnerId);
  await mkdir(path.join(workspace, ".ocp"), { recursive: true });
  const identity: PartnerIdentity = { id: partnerId, role, desktop: "partner-sandbox" };
  await writeFile(path.join(workspace, ".ocp", "identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
  const mount = {
    shared: "/shared",
    source: path.resolve(sessionRoot),
    mode: "read-only",
    note: "The container hook mounts the session root here. This build does not copy that folder into the partner workspace.",
  };
  await writeFile(path.join(workspace, ".ocp", "mount.json"), `${JSON.stringify(mount, null, 2)}\n`);
  await copyFile(path.join(sessionRoot, "PARTNER.md"), path.join(workspace, "PARTNER.md")).catch(() => undefined);
  return workspace;
}

export async function readPartnerIdentity(workspace: string): Promise<PartnerIdentity | undefined> {
  try {
    const body = JSON.parse(await readFile(path.join(workspace, ".ocp", "identity.json"), "utf8")) as Partial<PartnerIdentity>;
    if (!body.id) return undefined;
    return { id: body.id, role: body.role || body.id, desktop: "partner-sandbox" };
  } catch {
    return undefined;
  }
}

export interface FleetStatusRow {
  id: string;
  workspace: string;
  container: "running" | "stopped" | "not started";
  frame: string;
  frameTime: string;
}

/** Partners under .ocp/fleet. This does not start containers and does not send telemetry. */
export async function readFleetStatus(sessionRoot: string): Promise<FleetStatusRow[]> {
  let names: string[] = [];
  try {
    names = await readdir(path.join(sessionRoot, ".ocp", "fleet"));
  } catch {
    return [];
  }
  const rows: FleetStatusRow[] = [];
  for (const name of names) {
    const workspace = path.join(sessionRoot, ".ocp", "fleet", name);
    const identity = await readPartnerIdentity(workspace);
    if (!identity) continue;
    const rel = `.ocp/fleet/${identity.id}`;
    let container: FleetStatusRow["container"] = "not started";
    try {
      const body = JSON.parse(await readFile(path.join(workspace, ".ocp", "container.json"), "utf8")) as { state?: string };
      if (body.state === "running" || body.state === "stopped") container = body.state;
    } catch {
      container = "not started";
    }
    const frameRel = `${rel}/gtm/last-frame.png`;
    let frame = "none";
    let frameTime = "none";
    try {
      const info = await stat(path.join(sessionRoot, frameRel));
      frame = frameRel;
      frameTime = info.mtime.toISOString();
    } catch {
      frame = "none";
      frameTime = "none";
    }
    rows.push({ id: identity.id, workspace: rel, container, frame, frameTime });
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

export function formatFleetStatus(rows: readonly FleetStatusRow[]): string {
  if (rows.length === 0) return "Fleet: no partners\nNo telemetry is sent.\n";
  const lines = ["Fleet"];
  for (const row of rows) {
    lines.push(`${row.id} workspace ${row.workspace} container ${row.container} frame ${row.frame} frame time ${row.frameTime}`);
  }
  lines.push("No telemetry is sent.");
  return `${lines.join("\n")}\n`;
}

export function formatFleetStatusJson(rows: readonly FleetStatusRow[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

export function fleetDoctorLine(rows: readonly FleetStatusRow[]): string {
  if (rows.length === 0) return "yellow Fleet: no partners. This check does not start containers. No telemetry is sent.";
  const bits = rows.map((row) => `${row.id} ${row.container}`);
  return `green Fleet: ${bits.join(", ")}. This check does not start containers. No telemetry is sent.`;
}

/** Other partners next to this workspace. A thin fleet list, not a grid. */
export async function fleetIds(workspace: string): Promise<string[]> {
  const fleet = path.dirname(workspace);
  try {
    const names = await readdir(fleet);
    const ids: string[] = [];
    for (const name of names) {
      const identity = await readPartnerIdentity(path.join(fleet, name));
      if (identity) ids.push(identity.id);
    }
    return ids.sort();
  } catch {
    return [];
  }
}

/** Detached container command. The workspace and the session root are mounted. */
export function partnerContainerArgv(sessionRoot: string, partnerId: string): string[] {
  const decision = partnerIdDecision(partnerId);
  if (!decision.allow) throw new Error(decision.reason);
  const workspace = path.resolve(partnerWorkspace(sessionRoot, partnerId));
  const shared = path.resolve(sessionRoot);
  return [
    "docker",
    "run",
    "-d",
    "--rm",
    "--name",
    `ocp-${partnerId}`,
    "-v",
    `${workspace}:/workspace`,
    "-v",
    `${shared}:/shared:ro`,
    "-w",
    "/workspace",
    "debian:stable-slim",
    "sleep",
    "infinity",
  ];
}
