import { readFile } from "node:fs/promises";
import path from "node:path";

/** A later JSON-RPC stdio session. This build does not spawn a process. */
export interface AcpTurnRequest {
  sessionKey: string;
  message: string;
}

export interface AcpTurnResult {
  ok: boolean;
  detail: string;
}

export interface AcpBackend {
  start(request: AcpTurnRequest): Promise<AcpTurnResult>;
}

/** Opt-in stub. It never replaces the local swarm. */
export function noopAcpBackend(): AcpBackend {
  return {
    async start() {
      return { ok: false, detail: "No ACP backend is installed. The local swarm still runs." };
    },
  };
}

export async function acpOptIn(sandboxRoot: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (env.OCP_ACP === "1") return true;
  try {
    const body = JSON.parse(await readFile(path.join(sandboxRoot, ".ocp", "settings.json"), "utf8")) as {
      advanced?: { acp?: boolean };
    };
    return body.advanced?.acp === true;
  } catch {
    return false;
  }
}

export function formatSettings(acp: boolean): string {
  return `Settings\nAdvanced ACP: ${acp ? "on" : "off"}\nThe optional backend is named in Credits. It is not installed. Packaging and payments are later.\n`;
}
