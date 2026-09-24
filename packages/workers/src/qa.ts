import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface QaResult {
  pass: boolean;
  summary: string;
}

/** QA reads the computer claim. A missing browser, a missing screenshot, or a wrong title fails. */
export async function reviewComputerClaim(sandboxRoot: string): Promise<QaResult> {
  const assertion = await readJson(sandboxRoot, "gtm/assertion.json");
  const run = await readJson(sandboxRoot, "gtm/last-run.json");
  if (!assertion || !run) return { pass: false, summary: "computer evidence is missing" };
  if (assertion.executed !== true) return { pass: false, summary: "computer did not run" };
  const screenshot = typeof assertion.screenshot === "string" ? assertion.screenshot : "";
  if (!screenshot) return { pass: false, summary: "screenshot is missing" };
  const png = await readSandboxBytes(sandboxRoot, screenshot);
  if (!png || png.length === 0) return { pass: false, summary: "screenshot is missing" };
  if (assertion.claimHeld !== true) {
    const expected = assertion.expectedTitle || assertion.expectedText || "the claim";
    const actual = assertion.actualTitle || "nothing";
    return { pass: false, summary: `page claim did not hold: expected ${expected}, saw ${actual}` };
  }
  return { pass: true, summary: `page claim held (${assertion.actualTitle || "text"})` };
}

async function readJson(sandboxRoot: string, relativePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path.join(sandboxRoot, relativePath), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function readSandboxBytes(sandboxRoot: string, relativePath: string): Promise<Buffer | undefined> {
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(root, relativePath);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!target.startsWith(rootPrefix)) return undefined;
  try {
    return await readFile(target);
  } catch {
    return undefined;
  }
}

/** Offline QA check. Reads the sandbox file the coding agent just wrote. */
export async function qaCheckFile(
  sandboxRoot: string,
  relativePath: string,
  expected?: string,
): Promise<QaResult> {
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(root, relativePath);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!target.startsWith(rootPrefix)) {
    return { pass: false, summary: "path left the sandbox" };
  }
  try {
    const text = await readFile(target, "utf8");
    if (text.length === 0) return { pass: false, summary: "file is empty" };
    if (expected !== undefined && text !== expected) return { pass: false, summary: "content mismatch" };
    return { pass: true, summary: `checked ${relativePath}` };
  } catch {
    return { pass: false, summary: "file missing" };
  }
}

/** Read text files under the sandbox. Skips temp write files. */
export async function snapshotSandbox(sandboxRoot: string): Promise<Map<string, string>> {
  const root = path.resolve(sandboxRoot);
  const files = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".tmp-")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.set(path.relative(root, full), await readFile(full, "utf8"));
    }
  }
  await walk(root);
  return files;
}

export function changedSandboxFiles(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

/** QA reads each kept file. An empty list fails when coding reported success. */
export async function reviewChangedFiles(
  sandboxRoot: string,
  files: readonly string[],
  codingExitOk: boolean,
): Promise<QaResult> {
  if (files.length === 0) {
    return {
      pass: false,
      summary: codingExitOk ? "coding reported success but kept no files" : "no files changed",
    };
  }
  const ok: string[] = [];
  const bad: string[] = [];
  for (const file of files) {
    const check = await qaCheckFile(sandboxRoot, file);
    if (check.pass) ok.push(`${file} is non-empty`);
    else bad.push(`${file}: ${check.summary}`);
  }
  if (bad.length > 0) return { pass: false, summary: bad.join("; ") };
  return { pass: true, summary: `checked ${ok.join("; ")}` };
}
