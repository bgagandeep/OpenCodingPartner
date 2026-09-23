import { accessSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function layaPredictScriptPath(): string {
  return path.resolve(fileURLToPath(new URL("../../../integrations/laya/predict.py", import.meta.url)));
}

export function buildLayaPythonCommand(python = "python3"): {
  readonly argv: readonly [string, string];
  readonly scriptPath: string;
} {
  const scriptPath = layaPredictScriptPath();
  return { argv: [python, scriptPath], scriptPath };
}

export function layaPredictScriptExists(): boolean {
  try {
    accessSync(layaPredictScriptPath());
    return true;
  } catch {
    return false;
  }
}
