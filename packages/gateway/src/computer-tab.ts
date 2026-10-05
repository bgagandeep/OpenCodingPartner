import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ComputerTabState {
  desktop: "sandbox";
  control: "partner" | "human";
  approved: boolean;
  status: "idle" | "held" | "live";
}

const FILE = path.join(".ocp", "computer.json");

function statePath(sandboxRoot: string): string {
  return path.join(sandboxRoot, FILE);
}

export async function readComputerTab(sandboxRoot: string): Promise<ComputerTabState> {
  try {
    const body = JSON.parse(await readFile(statePath(sandboxRoot), "utf8")) as Partial<ComputerTabState>;
    return {
      desktop: "sandbox",
      control: body.control === "human" ? "human" : "partner",
      approved: body.approved === true,
      status: body.status === "held" || body.status === "live" ? body.status : "idle",
    };
  } catch {
    return { desktop: "sandbox", control: "partner", approved: false, status: "idle" };
  }
}

async function writeComputerTab(sandboxRoot: string, state: ComputerTabState): Promise<void> {
  await mkdir(path.join(sandboxRoot, ".ocp"), { recursive: true });
  await writeFile(statePath(sandboxRoot), `${JSON.stringify(state, null, 2)}\n`);
}

export async function allowComputerUse(sandboxRoot: string): Promise<void> {
  const state = await readComputerTab(sandboxRoot);
  state.approved = true;
  if (state.control !== "human") state.status = "idle";
  await writeComputerTab(sandboxRoot, state);
}

export async function takeoverComputer(sandboxRoot: string): Promise<ComputerTabState> {
  const state = await readComputerTab(sandboxRoot);
  state.control = "human";
  state.status = "held";
  await writeComputerTab(sandboxRoot, state);
  return state;
}

export async function returnComputer(sandboxRoot: string): Promise<ComputerTabState> {
  const state = await readComputerTab(sandboxRoot);
  state.control = "partner";
  state.status = state.approved ? "idle" : "idle";
  await writeComputerTab(sandboxRoot, state);
  return state;
}

export async function markComputerLive(sandboxRoot: string): Promise<void> {
  const state = await readComputerTab(sandboxRoot);
  if (state.control === "human") return;
  state.status = "live";
  await writeComputerTab(sandboxRoot, state);
}

async function lastFrame(sandboxRoot: string): Promise<string> {
  try {
    const body = JSON.parse(await readFile(path.join(sandboxRoot, "gtm", "last-run.json"), "utf8")) as { screenshot?: string };
    return body.screenshot?.trim() || "none";
  } catch {
    return "none";
  }
}

/** Computer tab text. There is no live pixel stream in this build. */
export async function computerTabText(sandboxRoot: string): Promise<string> {
  const state = await readComputerTab(sandboxRoot);
  const frame = await lastFrame(sandboxRoot);
  return [
    "Computer tab",
    "Desktop: sandbox",
    `Control: ${state.control}`,
    `Status: ${state.status}`,
    `Last frame: ${frame}`,
    "Live stream: not in this build",
  ].join("\n");
}
