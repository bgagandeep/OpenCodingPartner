export type RuntimeHint = "local-sandbox" | "cursor-cloud" | "grok-build";

export interface CreateFileInstruction {
  readonly relativePath: string;
  readonly contents: string;
  readonly runtimeHint: RuntimeHint;
}

const CREATE_FILE =
  /^(?:use\s+([\s\S]+?)\s+to\s+)?create\s+(\S+)\s+with\s+content:\n?([\s\S]*)$/i;

export function parseCreateFileInstruction(message: string): CreateFileInstruction | null {
  const match = CREATE_FILE.exec(message.replace(/^\s+/, ""));
  if (match === null) {
    return null;
  }
  const hint = (match[1] ?? "").toLowerCase();
  const relativePath = match[2];
  if (relativePath === undefined) {
    return null;
  }
  const contents = match[3] ?? "";
  let runtimeHint: RuntimeHint = "local-sandbox";
  if (hint.includes("cursor cloud")) {
    runtimeHint = "cursor-cloud";
  } else if (hint.includes("grok build")) {
    runtimeHint = "grok-build";
  }
  return { relativePath, contents, runtimeHint };
}
