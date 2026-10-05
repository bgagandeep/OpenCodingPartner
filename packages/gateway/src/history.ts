import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readPartnerIdentity } from "./fleet.js";

const HISTORY_FILE = path.join(".ocp", "prior-turns.json");

async function readTurnCount(sandboxRoot: string): Promise<{ count: number; unreadable: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path.join(sandboxRoot, HISTORY_FILE), "utf8");
  } catch {
    return { count: 0, unreadable: false };
  }
  try {
    const parsed = JSON.parse(raw) as { turns?: unknown };
    if (!Array.isArray(parsed.turns)) return { count: 0, unreadable: true };
    return { count: parsed.turns.length, unreadable: false };
  } catch {
    return { count: 0, unreadable: true };
  }
}

/** Count stored prior turns. This does not print them. */
export async function doctorPriorTurnLine(sessionRoot: string): Promise<string> {
  const tail = "This check does not print the turns.";
  const session = await readTurnCount(sessionRoot);
  if (session.unreadable) return `yellow Prior turns: this session file could not be read. ${tail}`;
  const bits: string[] = [];
  if (session.count > 0) bits.push(`${session.count} in this session`);
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
  for (const partner of partners) {
    const counted = await readTurnCount(partner.workspace);
    if (counted.unreadable) return `yellow Prior turns: ${partner.id} file could not be read. ${tail}`;
    if (counted.count > 0) bits.push(`${counted.count} for ${partner.id}`);
  }
  if (bits.length === 0) return `green Prior turns: none. ${tail}`;
  return `green Prior turns: ${bits.join(". ")}. ${tail}`;
}
