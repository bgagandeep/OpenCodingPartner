import path from "node:path";

export class PathRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathRejectedError";
  }
}

export function sanitizeRelativePath(relativePath: string): string {
  if (relativePath.length === 0 || relativePath.includes("\0")) {
    throw new PathRejectedError("path is empty or contains a null byte");
  }
  const slash = relativePath.replaceAll("\\", "/");
  if (slash.startsWith("/") || /^[A-Za-z]:/.test(slash)) {
    throw new PathRejectedError("absolute paths are rejected");
  }
  const normalized = path.posix.normalize(slash);
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    segments.includes("..") ||
    segments.includes("")
  ) {
    throw new PathRejectedError(`path escapes the sandbox: ${relativePath}`);
  }
  return normalized;
}

export function resolveInsideSandbox(root: string, relativePath: string): string {
  const safe = sanitizeRelativePath(relativePath);
  const rootResolved = path.resolve(root);
  const absolute = path.resolve(rootResolved, safe);
  if (!isInsideSandbox(rootResolved, absolute)) {
    throw new PathRejectedError(`resolved path escapes the sandbox: ${relativePath}`);
  }
  return absolute;
}

export function isInsideSandbox(root: string, absolutePath: string): boolean {
  const rootResolved = path.resolve(root);
  const target = path.resolve(absolutePath);
  const relative = path.relative(rootResolved, target);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
