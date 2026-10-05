import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * Optional container start. This build does not run it.
 * The partner workspace is already isolated on disk.
 */
export function partnerContainerArgv(sessionRoot: string, partnerId: string): string[] {
  const decision = partnerIdDecision(partnerId);
  if (!decision.allow) throw new Error(decision.reason);
  const workspace = path.resolve(partnerWorkspace(sessionRoot, partnerId));
  const shared = path.resolve(sessionRoot);
  return [
    "docker",
    "run",
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
