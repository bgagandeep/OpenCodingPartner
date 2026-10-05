import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readPartnerIdentity } from "./fleet.js";

const WRITE_FILE = path.join(".ocp", "last-write.json");

/** Store orchestration or local. The path and the file contents are not stored. */
export async function recordLastWrite(sandboxRoot: string, via: "orchestration" | "local"): Promise<void> {
  if (via !== "orchestration" && via !== "local") return;
  await mkdir(path.join(sandboxRoot, ".ocp"), { recursive: true });
  await writeFile(path.join(sandboxRoot, WRITE_FILE), `${JSON.stringify({ via })}\n`);
}

async function readLastWrite(sandboxRoot: string): Promise<{ via: "orchestration" | "local" } | "missing" | "unreadable"> {
  let raw: string;
  try {
    raw = await readFile(path.join(sandboxRoot, WRITE_FILE), "utf8");
  } catch {
    return "missing";
  }
  try {
    const parsed = JSON.parse(raw) as { via?: unknown };
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== "via") return "unreadable";
    if (parsed.via !== "orchestration" && parsed.via !== "local") return "unreadable";
    return { via: parsed.via };
  } catch {
    return "unreadable";
  }
}

/** Doctor line for the last write path. This does not write a file and does not print a path. */
export async function doctorLastWriteLine(sessionRoot: string): Promise<string> {
  const tail = "This check does not write a file and does not print a path.";
  const bits: string[] = [];
  const session = await readLastWrite(sessionRoot);
  if (session === "unreadable") return `yellow Last write: this session file could not be read. ${tail}`;
  if (session !== "missing") bits.push(`session ${session.via}`);
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
  let local = session !== "missing" && session.via === "local";
  for (const partner of partners) {
    const write = await readLastWrite(partner.workspace);
    if (write === "unreadable") return `yellow Last write: ${partner.id} file could not be read. ${tail}`;
    if (write === "missing") continue;
    bits.push(`${partner.id} ${write.via}`);
    if (write.via === "local") local = true;
  }
  if (bits.length === 0) return `green Last write: none. ${tail}`;
  return `${local ? "yellow" : "green"} Last write: ${bits.join(". ")}. ${tail}`;
}
