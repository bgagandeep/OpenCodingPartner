import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { browserMissingMessage, browserMissingNote } from "@opencodingpartner/workers";
import { fleetIds, readPartnerIdentity } from "./fleet.js";

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

async function containerState(sandboxRoot: string): Promise<string> {
  try {
    const body = JSON.parse(await readFile(path.join(sandboxRoot, ".ocp", "container.json"), "utf8")) as { state?: string };
    if (body.state === "running" || body.state === "stopped") return body.state;
  } catch {
    // No container has been started.
  }
  return "not started";
}

async function lastRun(sandboxRoot: string): Promise<{ url: string; screenshot: string; body: Record<string, unknown> } | undefined> {
  try {
    const body = JSON.parse(await readFile(path.join(sandboxRoot, "gtm", "last-run.json"), "utf8")) as Record<string, unknown>;
    return {
      url: typeof body.url === "string" ? body.url : "",
      screenshot: typeof body.screenshot === "string" ? body.screenshot.trim() : "",
      body,
    };
  } catch {
    return undefined;
  }
}

async function lastFrame(sandboxRoot: string): Promise<string> {
  const run = await lastRun(sandboxRoot);
  if (run?.screenshot) return run.screenshot;
  try {
    await stat(path.join(sandboxRoot, FRAME_FILE));
    return FRAME_FILE;
  } catch {
    return "none";
  }
}

async function frameTime(sandboxRoot: string, relativePath: string): Promise<string> {
  if (relativePath === "none") return "none";
  try {
    const info = await stat(path.join(sandboxRoot, relativePath));
    return info.mtime.toISOString();
  } catch {
    return "missing";
  }
}

const FRAME_FILE = "gtm/last-frame.png";
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Session turns report gtm/last-frame.png. A partner workspace reports .ocp/fleet/<id>/gtm/last-frame.png. */
async function reportedFrame(sandboxRoot: string, relative = FRAME_FILE): Promise<string> {
  if (relative === "none") return "none";
  const identity = await readPartnerIdentity(sandboxRoot);
  if (!identity) return relative;
  return `.ocp/fleet/${identity.id}/${relative}`;
}

export async function frameMtimeMs(sandboxRoot: string): Promise<number | undefined> {
  try {
    return (await stat(path.join(sandboxRoot, FRAME_FILE))).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Named self-check computer-frame. The frame must exist, be a PNG, and have a time. After a capture, the time must move. */
export async function checkComputerFrame(
  sandboxRoot: string,
  beforeMs?: number,
): Promise<{ pass: boolean; summary: string }> {
  const where = await reportedFrame(sandboxRoot);
  const target = path.join(sandboxRoot, FRAME_FILE);
  let bytes: Buffer;
  let mtimeMs: number;
  try {
    bytes = await readFile(target);
    mtimeMs = (await stat(target)).mtimeMs;
  } catch {
    return { pass: false, summary: `Computer QA computer-frame: fail. The frame file is missing (${where}).` };
  }
  const png = bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
  if (!png) return { pass: false, summary: `Computer QA computer-frame: fail. The frame is not a PNG (${where}).` };
  if (!Number.isFinite(mtimeMs)) return { pass: false, summary: `Computer QA computer-frame: fail. The frame time is missing (${where}).` };
  if (beforeMs !== undefined && !(mtimeMs > beforeMs)) {
    return { pass: false, summary: `Computer QA computer-frame: fail. The frame time did not move (${where}).` };
  }
  const moved = beforeMs === undefined ? "the time is set" : "the time moved";
  return { pass: true, summary: `Computer QA computer-frame: pass. The frame is a PNG and ${moved}. Last frame: ${where}.` };
}

export type FrameCapturer = (url: string) => Promise<Uint8Array>;

async function playwrightCapture(url: string): Promise<Uint8Array> {
  const { playwrightBrowserDriver } = await import("@opencodingpartner/workers");
  const session = await playwrightBrowserDriver().start();
  try {
    const screen = await session.open(url);
    return screen.screenshotPng;
  } finally {
    await session.close();
  }
}

function isPng(png: Uint8Array): boolean {
  return png.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => png[index] === byte);
}

async function landFrame(
  sandboxRoot: string,
  png: Uint8Array,
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; text: string }> {
  const where = await reportedFrame(sandboxRoot);
  if (!isPng(png)) {
    return { ok: false, text: `Computer QA computer-frame: fail. The frame is not a PNG. No frame was written at ${where}.` };
  }
  const before = await frameMtimeMs(sandboxRoot);
  await mkdir(path.join(sandboxRoot, "gtm"), { recursive: true });
  const framePath = path.join(sandboxRoot, FRAME_FILE);
  await writeFile(framePath, png);
  const written = await frameMtimeMs(sandboxRoot);
  if (before !== undefined && !(written !== undefined && written > before)) {
    const moved = new Date(before + 1);
    await utimes(framePath, moved, moved);
  }
  const next = { ...body, url, screenshot: FRAME_FILE };
  await writeFile(path.join(sandboxRoot, "gtm", "last-run.json"), `${JSON.stringify(next, null, 2)}\n`);
  const check = await checkComputerFrame(sandboxRoot, before);
  if (!check.pass) return { ok: false, text: check.summary };
  const when = await frameTime(sandboxRoot, FRAME_FILE);
  return { ok: true, text: `${check.summary}\nLast frame: ${where}\nFrame time: ${when}` };
}

/** Write gtm/last-frame.png from the open page. A missing browser is an error, not a blank image. */
export async function captureComputerFrame(
  sandboxRoot: string,
  options: { capture?: FrameCapturer } = {},
): Promise<{ ok: boolean; text: string }> {
  const run = await lastRun(sandboxRoot);
  const url = run?.url ?? "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { ok: false, text: "No page is open. Open a URL first. No frame was written." };
  }
  let png: Uint8Array;
  try {
    png = await (options.capture ?? playwrightCapture)(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "browser missing";
    const where = await reportedFrame(sandboxRoot);
    if (browserMissingMessage(message)) {
      return { ok: false, text: `${browserMissingNote()} Path: ${where}.` };
    }
    return { ok: false, text: `Capture failed. No frame was written at ${where}. ${message}` };
  }
  return landFrame(sandboxRoot, png, url, run?.body ?? {});
}

/**
 * After computer-execute, copy the step screenshot into gtm/last-frame.png and run computer-frame.
 * This does not open a second browser. A missing or bad screenshot fails in the returned text.
 */
export async function captureExecutedFrame(sandboxRoot: string): Promise<{ ok: boolean; text: string }> {
  const run = await lastRun(sandboxRoot);
  const url = run?.url ?? "";
  const where = await reportedFrame(sandboxRoot);
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { ok: false, text: `Computer QA computer-frame: fail. Capture found no open page. No frame was written at ${where}.` };
  }
  const rel = run?.screenshot ?? "";
  if (!rel) {
    return { ok: false, text: `Computer QA computer-frame: fail. Capture found no step screenshot. No frame was written at ${where}.` };
  }
  if (rel === FRAME_FILE) {
    const check = await checkComputerFrame(sandboxRoot);
    return { ok: check.pass, text: check.summary };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(sandboxRoot, rel));
  } catch {
    return { ok: false, text: `Computer QA computer-frame: fail. Capture could not read the step screenshot. No frame was written at ${where}.` };
  }
  return landFrame(sandboxRoot, bytes, url, run?.body ?? {});
}

/** Computer tab text. There is no live pixel stream in this build. */
export async function computerTabText(sandboxRoot: string): Promise<string> {
  const state = await readComputerTab(sandboxRoot);
  const frame = await lastFrame(sandboxRoot);
  const when = await frameTime(sandboxRoot, frame);
  const shown = await reportedFrame(sandboxRoot, frame);
  const identity = await readPartnerIdentity(sandboxRoot);
  const lines = ["Computer tab"];
  if (identity) {
    lines.push(`Partner: ${identity.id}`);
    lines.push("Desktop: partner sandbox");
    const fleet = await fleetIds(sandboxRoot);
    if (fleet.length > 0) lines.push(`Fleet: ${fleet.join(", ")}`);
  } else {
    lines.push("Desktop: sandbox");
  }
  lines.push(
    `Control: ${state.control}`,
    `Status: ${state.status}`,
    `Container: ${await containerState(sandboxRoot)}`,
    `Last frame: ${shown}`,
    `Frame time: ${when}`,
    "Live stream: not in this build",
  );
  return lines.join("\n");
}
