import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { globSandbox, grepSandbox, securityGate } from "@opencodingpartner/workers";

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

/** `shared` or `shared/relative` is the read-only session mount. Anything else is a normal sandbox path. */
export function sharedRequest(relativePath: string): { shared: true; relative: string } | { shared: false } {
  const text = relativePath.replace(/\\/g, "/");
  if (text !== "shared" && !text.startsWith("shared/")) return { shared: false };
  if (text === "shared") return { shared: true, relative: "." };
  if (text.includes("..")) return { shared: true, relative: "" };
  const relative = text.slice("shared/".length);
  if (!relative || relative.split("/").some((part) => part === "" || part === "." || part === "..")) return { shared: true, relative: "" };
  if (relative === ".ocp" || relative.startsWith(".ocp/") || relative === "gtm" || relative.startsWith("gtm/")) return { shared: true, relative: "" };
  return { shared: true, relative };
}

export async function sharedMountSource(sandboxRoot: string): Promise<string | undefined> {
  try {
    const body = JSON.parse(await readFile(path.join(sandboxRoot, ".ocp", "mount.json"), "utf8")) as { source?: unknown; mode?: unknown };
    if (body.mode !== "read-only" || typeof body.source !== "string" || !body.source) return undefined;
    return path.resolve(body.source);
  } catch {
    return undefined;
  }
}

/** Doctor line for each partner shared mount. This does not print the source path and does not copy files. */
export async function doctorSharedMountLine(sessionRoot: string): Promise<string> {
  const tail = "This check does not copy files.";
  let names: string[] = [];
  try {
    names = await readdir(path.join(sessionRoot, ".ocp", "fleet"));
  } catch {
    return `green Shared mount: no partners. ${tail}`;
  }
  const partners: { id: string; workspace: string }[] = [];
  for (const name of names) {
    const workspace = path.join(sessionRoot, ".ocp", "fleet", name);
    const identity = await readPartnerIdentity(workspace);
    if (identity) partners.push({ id: identity.id, workspace });
  }
  partners.sort((left, right) => left.id.localeCompare(right.id));
  if (partners.length === 0) return `green Shared mount: no partners. ${tail}`;
  const session = path.resolve(sessionRoot);
  const bad: string[] = [];
  for (const partner of partners) {
    let body: { source?: unknown; mode?: unknown };
    try {
      body = JSON.parse(await readFile(path.join(partner.workspace, ".ocp", "mount.json"), "utf8")) as { source?: unknown; mode?: unknown };
    } catch {
      bad.push(`${partner.id} has no shared mount`);
      continue;
    }
    const source = typeof body.source === "string" && body.source ? path.resolve(body.source) : "";
    if (body.mode !== "read-only" || source !== session) bad.push(`${partner.id} does not point at this session`);
  }
  if (bad.length === 0) {
    const count = partners.length === 1 ? "1 partner" : `${partners.length} partners`;
    return `green Shared mount: ${count} read-only at this session. ${tail}`;
  }
  return `yellow Shared mount: ${bad.join(". ")}. ${tail}`;
}

function insideSource(source: string, relative: string): string | undefined {
  const root = path.resolve(source);
  const target = path.resolve(root, relative);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(rootPrefix)) return undefined;
  return target;
}

/** List the read-only session mount. This does not copy files into the partner workspace. */
export async function listShared(sandboxRoot: string, relativePath: string): Promise<{ ok: boolean; detail: string }> {
  const request = sharedRequest(relativePath);
  if (!request.shared || !request.relative) return { ok: false, detail: "shared path refused" };
  const source = await sharedMountSource(sandboxRoot);
  if (!source) return { ok: false, detail: "shared mount is missing" };
  const target = insideSource(source, request.relative);
  if (!target) return { ok: false, detail: "shared path refused" };
  try {
    const names = (await readdir(target)).filter((name) => name !== ".ocp" && name !== "gtm");
    return { ok: true, detail: names.join(", ") || "(empty)" };
  } catch {
    return { ok: false, detail: "directory missing" };
  }
}

/** Read one file on the read-only session mount. This does not copy it. */
export async function readShared(sandboxRoot: string, relativePath: string): Promise<{ ok: boolean; detail: string }> {
  const request = sharedRequest(relativePath);
  if (!request.shared || !request.relative || request.relative === ".") return { ok: false, detail: "shared path refused" };
  const source = await sharedMountSource(sandboxRoot);
  if (!source) return { ok: false, detail: "shared mount is missing" };
  const target = insideSource(source, request.relative);
  if (!target) return { ok: false, detail: "shared path refused" };
  let content = "";
  try {
    content = await readFile(target, "utf8");
  } catch {
    return { ok: false, detail: "file missing" };
  }
  const gate = securityGate({ relativePath: request.relative, content, sandboxRoot: source });
  if (!gate.allow) return { ok: false, detail: `blocked (${gate.reasons.join(", ")})` };
  return { ok: true, detail: content };
}

function prefixShared(detail: string): string {
  if (detail === "(no matches)") return detail;
  return detail
    .split("\n")
    .map((line) => `shared/${line}`)
    .join("\n");
}

/** Search the read-only session mount. This does not copy files. Secret files are skipped. */
export async function grepShared(
  sandboxRoot: string,
  query: string,
  relativePath: string,
): Promise<{ ok: boolean; detail: string }> {
  const request = sharedRequest(relativePath);
  if (!request.shared || !request.relative) return { ok: false, detail: "shared path refused" };
  const source = await sharedMountSource(sandboxRoot);
  if (!source) return { ok: false, detail: "shared mount is missing" };
  const found = await grepSandbox(source, query, request.relative);
  if (!found.ok) return found;
  return { ok: true, detail: prefixShared(found.detail) };
}

/** Glob the read-only session mount. This does not copy files. `.ocp` and `gtm` are skipped. */
export async function globShared(sandboxRoot: string, pattern: string): Promise<{ ok: boolean; detail: string }> {
  const source = await sharedMountSource(sandboxRoot);
  if (!source) return { ok: false, detail: "shared mount is missing" };
  const found = await globSandbox(source, pattern.replace(/^shared\//, ""));
  if (!found.ok) return found;
  return { ok: true, detail: prefixShared(found.detail) };
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
