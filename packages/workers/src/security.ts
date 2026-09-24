import path from "node:path";

export interface GateInput {
  relativePath: string;
  content: string;
  sandboxRoot: string;
}

export interface GateDecision {
  allow: boolean;
  reasons: string[];
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /api[_-]?key\s*[:=]\s*\S+/i,
  /password\s*[:=]\s*\S+/i,
];

/** Security agent check that runs before a coding write. */
export function securityGate(input: GateInput): GateDecision {
  const reasons: string[] = [];
  const relativePath = input.relativePath;
  if (relativePath.length === 0 || relativePath.includes("\0")) {
    reasons.push("empty or null path");
  }
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    reasons.push("absolute path");
  }
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    reasons.push("path escape");
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(input.content)) {
      reasons.push("secret pattern");
      break;
    }
  }
  const root = path.resolve(input.sandboxRoot);
  const target = path.resolve(root, normalized);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootPrefix)) {
    reasons.push("sandbox escape");
  }
  return { allow: reasons.length === 0, reasons };
}
