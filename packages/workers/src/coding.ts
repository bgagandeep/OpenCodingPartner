import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CreateFileInstruction {
  relativePath: string;
  content: string;
}

/**
 * Pull a create-file instruction out of a chat message.
 * "Use the coding worker to create ..." is the product phrase. "Use Grok Build to create ..." still parses. Any other "Use X to create" is ignored.
 * Leading space is stripped. The rest of the message is not trimmed, so a trailing newline stays.
 */
export function parseCreateFileInstruction(message: string): CreateFileInstruction | null {
  const text = message.replace(/^\s+/, "");
  const toolUse = text.match(/Use ([A-Za-z0-9 ._-]+) to create\s+/);
  const named = toolUse?.[1]?.trim().toLowerCase();
  if (named !== undefined && named !== "grok build" && named !== "the coding worker" && named !== "coding worker") {
    return null;
  }
  const match = text.match(/create\s+(\S+)\s+with content:\n?([\s\S]*)$/);
  const relativePath = match?.[1];
  if (!match || relativePath === undefined) return null;
  return { relativePath, content: match[2] ?? "" };
}

/** Write through a temp file, then rename. Caller must have passed the security gate. */
export async function writeSandboxFile(
  sandboxRoot: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.tmp-${randomBytes(6).toString("hex")}`);
  await writeFile(tmp, content);
  await rename(tmp, target);
  return target;
}
