import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface QaResult {
  pass: boolean;
  summary: string;
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
