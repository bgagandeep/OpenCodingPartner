import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readPartnerIdentity } from "./fleet.js";

const SECURITY_FILE = path.join(".ocp", "last-security.json");

const KNOWN_REASONS = ["empty or null path", "absolute path", "path escape", "secret pattern", "sandbox escape"] as const;

function knownReasons(reasons: readonly string[]): string[] {
  return reasons.filter((reason) => (KNOWN_REASONS as readonly string[]).includes(reason));
}

/** Store allow or block and the known reason names. Paths and file contents are not stored. */
export async function recordLastSecurity(
  sandboxRoot: string,
  decision: { allow: boolean; reasons: readonly string[] },
): Promise<void> {
  if (typeof decision.allow !== "boolean" || !Array.isArray(decision.reasons)) return;
  await mkdir(path.join(sandboxRoot, ".ocp"), { recursive: true });
  const body = { allow: decision.allow, reasons: knownReasons(decision.reasons) };
  await writeFile(path.join(sandboxRoot, SECURITY_FILE), `${JSON.stringify(body)}\n`);
}

async function readLastSecurity(
  sandboxRoot: string,
): Promise<{ allow: boolean; reasons: string[] } | "missing" | "unreadable"> {
  let raw: string;
  try {
    raw = await readFile(path.join(sandboxRoot, SECURITY_FILE), "utf8");
  } catch {
    return "missing";
  }
  try {
    const parsed = JSON.parse(raw) as { allow?: unknown; reasons?: unknown };
    const keys = Object.keys(parsed);
    if (keys.length !== 2 || !keys.includes("allow") || !keys.includes("reasons")) return "unreadable";
    if (typeof parsed.allow !== "boolean" || !Array.isArray(parsed.reasons)) return "unreadable";
    const reasons: string[] = [];
    for (const reason of parsed.reasons) {
      if (typeof reason !== "string" || !(KNOWN_REASONS as readonly string[]).includes(reason)) return "unreadable";
      reasons.push(reason);
    }
    return { allow: parsed.allow, reasons };
  } catch {
    return "unreadable";
  }
}

function verdict(label: string, row: { allow: boolean; reasons: readonly string[] }): string {
  if (row.allow) return `${label} allowed`;
  const why = row.reasons.length > 0 ? ` (${row.reasons.join(", ")})` : "";
  return `${label} blocked${why}`;
}

/** Doctor line for the last security gate. This does not read file contents and does not print a path. */
export async function doctorLastSecurityLine(sessionRoot: string): Promise<string> {
  const tail = "This check does not read file contents and does not print a path.";
  const bits: string[] = [];
  const session = await readLastSecurity(sessionRoot);
  if (session === "unreadable") return `yellow Last security: this session file could not be read. ${tail}`;
  if (session !== "missing") bits.push(verdict("session", session));
  let names: string[] = [];
  try {
    names = await readdir(path.join(sessionRoot, ".ocp", "fleet"));
  } catch {
    names = [];
  }
  const partners: { id: string; workspace: string }[] = [];
  for (const name of names) {
    const workspace = path.join(sessionRoot, ".ocp", "fleet", name);
    const identity = await readPartnerIdentity(workspace);
    if (identity) partners.push({ id: identity.id, workspace });
  }
  partners.sort((left, right) => left.id.localeCompare(right.id));
  let blocked = session !== "missing" && session.allow === false;
  for (const partner of partners) {
    const gate = await readLastSecurity(partner.workspace);
    if (gate === "unreadable") return `yellow Last security: ${partner.id} file could not be read. ${tail}`;
    if (gate === "missing") continue;
    bits.push(verdict(partner.id, gate));
    if (!gate.allow) blocked = true;
  }
  if (bits.length === 0) return `green Last security: none. ${tail}`;
  return `${blocked ? "yellow" : "green"} Last security: ${bits.join(". ")}. ${tail}`;
}
