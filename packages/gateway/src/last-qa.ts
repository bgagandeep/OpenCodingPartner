import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readPartnerIdentity } from "./fleet.js";

const QA_FILE = path.join(".ocp", "last-qa.json");

/** Store pass or fail only. The QA summary is not stored. */
export async function recordLastQa(sandboxRoot: string, pass: boolean): Promise<void> {
  if (typeof pass !== "boolean") return;
  await mkdir(path.join(sandboxRoot, ".ocp"), { recursive: true });
  await writeFile(path.join(sandboxRoot, QA_FILE), `${JSON.stringify({ pass })}\n`);
}

async function readLastQa(sandboxRoot: string): Promise<{ pass: boolean } | "missing" | "unreadable"> {
  let raw: string;
  try {
    raw = await readFile(path.join(sandboxRoot, QA_FILE), "utf8");
  } catch {
    return "missing";
  }
  try {
    const parsed = JSON.parse(raw) as { pass?: unknown };
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== "pass" || typeof parsed.pass !== "boolean") return "unreadable";
    return { pass: parsed.pass };
  } catch {
    return "unreadable";
  }
}

/** Doctor line for the last QA verdict. This does not review files and does not print the summary. */
export async function doctorLastQaLine(sessionRoot: string): Promise<string> {
  const tail = "This check does not review files and does not print the QA summary.";
  const bits: string[] = [];
  const session = await readLastQa(sessionRoot);
  if (session === "unreadable") return `yellow Last QA: this session file could not be read. ${tail}`;
  if (session !== "missing") bits.push(`session ${session.pass ? "pass" : "fail"}`);
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
  let failed = session !== "missing" && session.pass === false;
  for (const partner of partners) {
    const qa = await readLastQa(partner.workspace);
    if (qa === "unreadable") return `yellow Last QA: ${partner.id} file could not be read. ${tail}`;
    if (qa === "missing") continue;
    bits.push(`${partner.id} ${qa.pass ? "pass" : "fail"}`);
    if (!qa.pass) failed = true;
  }
  if (bits.length === 0) return `green Last QA: none. ${tail}`;
  return `${failed ? "yellow" : "green"} Last QA: ${bits.join(". ")}. ${tail}`;
}
