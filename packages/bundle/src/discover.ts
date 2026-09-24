import { access } from "node:fs/promises";
import path from "node:path";

export interface StackBins {
  openclawBin?: string;
  grokBin?: string;
  layaPython?: string;
}

export interface DiscoverInput {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  stack?: StackBins;
  pathLookup?: (name: string) => string | undefined;
}

async function exists(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) return undefined;
  try {
    await access(filePath);
    return filePath;
  } catch {
    return undefined;
  }
}

/** Prefer env, then the install record, then a name on PATH. */
export async function discoverStack(input: DiscoverInput): Promise<StackBins> {
  const openclaw =
    (await exists(input.env.OCP_OPENCLAW_BIN)) ??
    (await exists(input.stack?.openclawBin)) ??
    (await exists(path.join(input.repoRoot, ".bundle/openclaw/node_modules/.bin/openclaw"))) ??
    input.pathLookup?.("openclaw");
  const grok =
    (await exists(input.env.OCP_GROK_BIN)) ??
    (await exists(input.stack?.grokBin)) ??
    (await exists(path.join(input.repoRoot, ".bundle/grok/node_modules/.bin/grok"))) ??
    input.pathLookup?.("grok");
  const laya =
    (await exists(input.env.OCP_LAYA_PYTHON)) ??
    (await exists(input.stack?.layaPython)) ??
    (await exists(path.join(input.repoRoot, ".bundle/laya/bin/python"))) ??
    input.pathLookup?.("python3");
  return { openclawBin: openclaw, grokBin: grok, layaPython: laya };
}
