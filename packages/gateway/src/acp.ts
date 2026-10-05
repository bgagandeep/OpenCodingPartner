import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatPackaging, type Packaging } from "./packaging.js";

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

/** Doctor line for the ACP switch. This does not start a backend. */
export async function doctorAcpLine(sandboxRoot: string, env: NodeJS.ProcessEnv): Promise<string> {
  const tail = "No backend is installed. The local swarm still runs. This check does not start one.";
  const file = path.join(sandboxRoot, ".ocp", "settings.json");
  let raw: string | undefined;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    raw = undefined;
  }
  if (raw !== undefined) {
    try {
      JSON.parse(raw);
    } catch {
      if (env.OCP_ACP === "1") return `yellow Advanced ACP: on. The settings file could not be read. ${tail}`;
      return `yellow Advanced ACP: the settings file could not be read. ${tail}`;
    }
  }
  if (await acpOptIn(sandboxRoot, env)) return `yellow Advanced ACP: on. ${tail}`;
  return `green Advanced ACP: off. ${tail}`;
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

export function formatSettings(acp: boolean, packaging: Packaging): string {
  return `Settings\nAdvanced ACP: ${acp ? "on" : "off"}\n${formatPackaging(packaging)}\nThe optional backend is named in Credits. It is not installed.\n`;
}
