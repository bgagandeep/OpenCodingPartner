import { readFile } from "node:fs/promises";
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
