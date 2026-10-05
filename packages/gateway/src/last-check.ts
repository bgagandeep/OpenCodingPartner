import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readPartnerIdentity } from "./fleet.js";

const CHECK_FILE = path.join(".ocp", "last-check.json");

export function lastCheckKind(argv: readonly string[]): string | undefined {
  const [bin, sub] = argv;
  if (bin === "node" && sub === "--test") return "node --test";
  if (bin === "pnpm" && sub === "test") return "pnpm test";
  if (bin === "tsc" && sub === "--noEmit") return "tsc --noEmit";
  return undefined;
}

/** Store the exit code and command kind. Output is not stored. */
export async function recordLastCheck(sandboxRoot: string, argv: readonly string[], code: number): Promise<void> {
  const kind = lastCheckKind(argv);
  if (!kind || !Number.isInteger(code)) return;
  await mkdir(path.join(sandboxRoot, ".ocp"), { recursive: true });
  await writeFile(path.join(sandboxRoot, CHECK_FILE), `${JSON.stringify({ code, kind })}\n`);
}

async function readLastCheck(sandboxRoot: string): Promise<{ code: number; kind: string } | "missing" | "unreadable"> {
  let raw: string;
  try {
    raw = await readFile(path.join(sandboxRoot, CHECK_FILE), "utf8");
  } catch {
    return "missing";
  }
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; kind?: unknown };
    if (!Number.isInteger(parsed.code) || (parsed.kind !== "node --test" && parsed.kind !== "pnpm test" && parsed.kind !== "tsc --noEmit")) {
      return "unreadable";
    }
    return { code: parsed.code as number, kind: parsed.kind };
  } catch {
    return "unreadable";
  }
}

/** Doctor line for the last coding check. This does not run it and does not print its output. */
export async function doctorLastCheckLine(sessionRoot: string): Promise<string> {
  const tail = "This check does not run a command and does not print its output.";
  const bits: string[] = [];
  const session = await readLastCheck(sessionRoot);
  if (session === "unreadable") return `yellow Last check: this session file could not be read. ${tail}`;
  if (session !== "missing") bits.push(`session ${session.kind} exit ${session.code}`);
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
  let failed = session !== "missing" && session.code !== 0;
  for (const partner of partners) {
    const check = await readLastCheck(partner.workspace);
    if (check === "unreadable") return `yellow Last check: ${partner.id} file could not be read. ${tail}`;
    if (check === "missing") continue;
    bits.push(`${partner.id} ${check.kind} exit ${check.code}`);
    if (check.code !== 0) failed = true;
  }
  if (bits.length === 0) return `green Last check: none. ${tail}`;
  return `${failed ? "yellow" : "green"} Last check: ${bits.join(". ")}. ${tail}`;
}
