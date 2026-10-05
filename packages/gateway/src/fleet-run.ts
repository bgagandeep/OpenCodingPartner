import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readComputerTab } from "./computer-tab.js";
import { isolatePartner, partnerContainerArgv, partnerIdDecision, partnerWorkspace } from "./fleet.js";
import { formatApproveCards, partnerAgreementOn, queueComputerCard } from "./sdlc.js";

export interface FleetExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type FleetExec = (argv: readonly string[]) => Promise<FleetExecResult>;

const DOCTOR_HINT = "Docker is not available. The container was not started. Install Docker, then run ocp fleet start again. ocp doctor does not start containers.";

export function dockerExec(argv: readonly string[]): Promise<FleetExecResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0] ?? "docker", argv.slice(1), { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => resolve({ code: 127, stdout, stderr: stderr || "docker not found" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function containerFile(workspace: string): string {
  return path.join(workspace, ".ocp", "container.json");
}

export async function writeContainerState(workspace: string, state: "running" | "stopped" | "not started", name: string): Promise<void> {
  await mkdir(path.dirname(containerFile(workspace)), { recursive: true });
  await writeFile(containerFile(workspace), `${JSON.stringify({ state, name }, null, 2)}\n`);
}

async function dockerReady(exec: FleetExec): Promise<boolean> {
  const probe = await exec(["docker", "version", "--format", "{{.Server.Version}}"]);
  return probe.code === 0 && probe.stdout.trim().length > 0;
}

/** Start the partner container. A dry-run only prints the command. */
export async function startPartnerContainer(
  sessionRoot: string,
  partnerId: string,
  options: { dryRun?: boolean; exec?: FleetExec } = {},
): Promise<{ ok: boolean; text: string }> {
  const decision = partnerIdDecision(partnerId);
  if (!decision.allow) return { ok: false, text: decision.reason };
  const workspace = await isolatePartner(sessionRoot, partnerId);
  const argv = partnerContainerArgv(sessionRoot, partnerId);
  if (options.dryRun) return { ok: true, text: `dry-run: ${argv.join(" ")}` };
  if (await partnerAgreementOn(workspace)) {
    const tab = await readComputerTab(workspace);
    if (!tab.approved) {
      await queueComputerCard(workspace, `Start the container for ${partnerId}`);
      return { ok: false, text: `Container not started. Approve the card first.\n${await formatApproveCards(workspace)}` };
    }
  }
  const exec = options.exec ?? dockerExec;
  if (!(await dockerReady(exec))) {
    await writeContainerState(workspace, "not started", `ocp-${partnerId}`);
    return { ok: false, text: DOCTOR_HINT };
  }
  const started = await exec(argv);
  if (started.code !== 0) {
    await writeContainerState(workspace, "stopped", `ocp-${partnerId}`);
    return { ok: false, text: `Container did not start. ${(started.stderr || started.stdout).trim()}` };
  }
  await writeContainerState(workspace, "running", `ocp-${partnerId}`);
  return { ok: true, text: `Container ocp-${partnerId} running.` };
}

export async function stopPartnerContainer(
  sessionRoot: string,
  partnerId: string,
  options: { exec?: FleetExec } = {},
): Promise<{ ok: boolean; text: string }> {
  const decision = partnerIdDecision(partnerId);
  if (!decision.allow) return { ok: false, text: decision.reason };
  const workspace = partnerWorkspace(sessionRoot, partnerId);
  const exec = options.exec ?? dockerExec;
  if (!(await dockerReady(exec))) {
    await writeContainerState(workspace, "not started", `ocp-${partnerId}`).catch(() => undefined);
    return { ok: false, text: DOCTOR_HINT };
  }
  const stopped = await exec(["docker", "stop", `ocp-${partnerId}`]);
  await writeContainerState(workspace, "stopped", `ocp-${partnerId}`);
  if (stopped.code !== 0) return { ok: true, text: `Container ocp-${partnerId} stopped.` };
  return { ok: true, text: `Container ocp-${partnerId} stopped.` };
}
