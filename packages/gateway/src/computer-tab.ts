import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
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
  return run?.screenshot || "none";
}

/** Point the Computer tab at gtm/last-frame.png when a step screenshot already exists. */
export async function publishLastFrame(sandboxRoot: string): Promise<void> {
  const run = await lastRun(sandboxRoot);
  const rel = run?.screenshot ?? "";
  if (!rel || rel === "gtm/last-frame.png") return;
  try {
    const bytes = await readFile(path.join(sandboxRoot, rel));
    await mkdir(path.join(sandboxRoot, "gtm"), { recursive: true });
    await writeFile(path.join(sandboxRoot, "gtm", "last-frame.png"), bytes);
    const next = { ...(run?.body ?? {}), screenshot: "gtm/last-frame.png" };
    await writeFile(path.join(sandboxRoot, "gtm", "last-run.json"), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // Keep the step path already recorded.
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

async function hasComputerEvidence(sandboxRoot: string): Promise<boolean> {
  for (const relative of [FRAME_FILE, "gtm/last-run.json"]) {
    try {
      await stat(path.join(sandboxRoot, relative));
      return true;
    } catch {
      // That evidence file is absent.
    }
  }
  return false;
}

/** Check the session frame and each partner frame that has a page or a file. This does not open a browser. */
export async function checkComputerFrames(sessionRoot: string): Promise<{ pass: boolean; summary: string }> {
  const checks: { pass: boolean; summary: string }[] = [];
  if (await hasComputerEvidence(sessionRoot)) checks.push(await checkComputerFrame(sessionRoot));
  let names: string[] = [];
  try {
    names = await readdir(path.join(sessionRoot, ".ocp", "fleet"));
  } catch {
    names = [];
  }
  const partners: { id: string; workspace: string }[] = [];
  for (const name of names) {
    const workspace = path.join(sessionRoot, ".ocp", "fleet", name);
    const identity = await readPartnerIdentity(workspace);
    if (identity) partners.push({ id: identity.id, workspace });
  }
  partners.sort((left, right) => left.id.localeCompare(right.id));
  for (const partner of partners) {
    if (await hasComputerEvidence(partner.workspace)) checks.push(await checkComputerFrame(partner.workspace));
  }
  if (checks.length === 0) return checkComputerFrame(sessionRoot);
  return { pass: checks.every((check) => check.pass), summary: checks.map((check) => check.summary).join("\n") };
}

async function frameDoctorDetail(sandboxRoot: string): Promise<{ pass: boolean; detail: string }> {
  const where = await reportedFrame(sandboxRoot);
  try {
    const bytes = await readFile(path.join(sandboxRoot, FRAME_FILE));
    const png = bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
    if (!png) return { pass: false, detail: `${where} is not a PNG.` };
    return { pass: true, detail: where === FRAME_FILE ? `a PNG is at ${where}.` : `${where} is a PNG.` };
  } catch {
    return { pass: false, detail: where === FRAME_FILE ? `none at ${where}.` : `${where} is missing.` };
  }
}

/** Doctor line for the session frame and each partner frame that has a page or a file. This does not open a browser. */
export async function doctorComputerFrameLine(sessionRoot: string): Promise<string> {
  const tail = "This check does not start the browser.";
  const session = await frameDoctorDetail(sessionRoot);
  const partners: { pass: boolean; detail: string }[] = [];
  let names: string[] = [];
  try {
    names = await readdir(path.join(sessionRoot, ".ocp", "fleet"));
  } catch {
    names = [];
  }
  const workspaces: { id: string; workspace: string }[] = [];
  for (const name of names) {
    const workspace = path.join(sessionRoot, ".ocp", "fleet", name);
    const identity = await readPartnerIdentity(workspace);
    if (identity) workspaces.push({ id: identity.id, workspace });
  }
  workspaces.sort((left, right) => left.id.localeCompare(right.id));
  for (const partner of workspaces) {
    if (await hasComputerEvidence(partner.workspace)) partners.push(await frameDoctorDetail(partner.workspace));
  }
  if (partners.length === 0) {
    return `${session.pass ? "green" : "yellow"} Computer frame: ${session.detail} ${tail}`;
  }
  const bad = partners.filter((partner) => !partner.pass);
  if (session.pass && bad.length === 0) {
    const count = partners.length === 1 ? "1 partner frame passed." : `${partners.length} partner frames passed.`;
    return `green Computer frame: ${session.detail} ${count} ${tail}`;
  }
  const extra = bad.length > 0 ? bad.map((partner) => partner.detail).join(" ") : `${partners.length} partner frame${partners.length === 1 ? "" : "s"} passed.`;
  return `yellow Computer frame: ${session.detail} ${extra} ${tail}`;
}

function stepKind(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9-]{1,32}$/.test(value) ? value : "step";
}

async function readRunOutcome(sandboxRoot: string): Promise<{ present: boolean; pass: boolean; kind: string }> {
  let raw: string;
  try {
    raw = await readFile(path.join(sandboxRoot, "gtm", "last-run.json"), "utf8");
  } catch {
    return { present: false, pass: false, kind: "" };
  }
  let body: { steps?: unknown; executed?: unknown };
  try {
    body = JSON.parse(raw) as { steps?: unknown; executed?: unknown };
  } catch {
    return { present: true, pass: false, kind: "unreadable" };
  }
  const steps = Array.isArray(body.steps) ? body.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const record = step as { kind?: unknown; executed?: unknown; passed?: unknown };
    if (record.passed === false || record.executed === false) return { present: true, pass: false, kind: stepKind(record.kind) };
  }
  if (body.executed === false || steps.length === 0) return { present: true, pass: false, kind: "run" };
  return { present: true, pass: true, kind: "" };
}

async function partnerWorkspaces(sessionRoot: string): Promise<{ id: string; workspace: string }[]> {
  let names: string[] = [];
  try {
    names = await readdir(path.join(sessionRoot, ".ocp", "fleet"));
  } catch {
    return [];
  }
  const partners: { id: string; workspace: string }[] = [];
  for (const name of names) {
    const workspace = path.join(sessionRoot, ".ocp", "fleet", name);
    const identity = await readPartnerIdentity(workspace);
    if (identity) partners.push({ id: identity.id, workspace });
  }
  partners.sort((left, right) => left.id.localeCompare(right.id));
  return partners;
}

/** Doctor line for the last page check. It does not print the page text and does not open a browser. */
export async function doctorComputerRunLine(sessionRoot: string): Promise<string> {
  const tail = "This check does not open a page.";
  const session = await readRunOutcome(sessionRoot);
  const partners: { id: string; pass: boolean; kind: string }[] = [];
  for (const partner of await partnerWorkspaces(sessionRoot)) {
    const outcome = await readRunOutcome(partner.workspace);
    if (outcome.present) partners.push({ id: partner.id, pass: outcome.pass, kind: outcome.kind });
  }
  const sessionDetail = !session.present
    ? partners.length === 0
      ? "none."
      : "none at the session."
    : session.pass
      ? "the last page check passed."
      : session.kind === "unreadable"
        ? "gtm/last-run.json could not be read."
        : `the last page check failed at ${session.kind}.`;
  if (partners.length === 0) {
    return `${session.pass ? "green" : "yellow"} Computer run: ${sessionDetail} ${tail}`;
  }
  const bad = partners.filter((partner) => !partner.pass);
  if (session.pass && bad.length === 0) {
    const count = partners.length === 1 ? "1 partner run passed." : `${partners.length} partner runs passed.`;
    return `green Computer run: ${sessionDetail} ${count} ${tail}`;
  }
  const extra = bad.length > 0
    ? bad.map((partner) => `${partner.id} failed at ${partner.kind}.`).join(" ")
    : partners.length === 1
      ? "1 partner run passed."
      : `${partners.length} partner runs passed.`;
  return `yellow Computer run: ${sessionDetail} ${extra} ${tail}`;
}

type StatusRead = "idle" | "live" | "held" | "unreadable" | "missing";

async function readComputerStatus(sandboxRoot: string): Promise<StatusRead> {
  let raw: string;
  try {
    raw = await readFile(statePath(sandboxRoot), "utf8");
  } catch {
    return "missing";
  }
  try {
    const parsed = JSON.parse(raw) as { status?: unknown };
    if (parsed.status === undefined || parsed.status === "idle" || parsed.status === "held") {
      return parsed.status === "held" ? "held" : "idle";
    }
    if (parsed.status === "live") return "live";
    return "unreadable";
  } catch {
    return "unreadable";
  }
}

/** Doctor line for a live browser flag. This does not start the browser. There is no live stream. */
export async function doctorComputerStatusLine(sessionRoot: string): Promise<string> {
  const tail = "This check does not start the browser. Live stream is not in this build.";
  const live: string[] = [];
  const session = await readComputerStatus(sessionRoot);
  if (session === "unreadable") return `yellow Computer status: this session file could not be read. ${tail}`;
  if (session === "live") live.push("the session");
  for (const partner of await partnerWorkspaces(sessionRoot)) {
    const status = await readComputerStatus(partner.workspace);
    if (status === "unreadable") return `yellow Computer status: ${partner.id} file could not be read. ${tail}`;
    if (status === "live") live.push(partner.id);
  }
  if (live.length === 0) return `green Computer status: idle. ${tail}`;
  const who = live.map((name) => (name === "the session" ? "the session is live" : `${name} is live`)).join(". ");
  return `yellow Computer status: ${who}. ${tail}`;
}

/** Doctor line for who holds the browser. This does not take or return it. */
export async function doctorComputerControlLine(sessionRoot: string): Promise<string> {
  const tail = "This check does not take or return the browser.";
  const held: string[] = [];
  if ((await readComputerTab(sessionRoot)).control === "human") held.push("the session");
  for (const partner of await partnerWorkspaces(sessionRoot)) {
    if ((await readComputerTab(partner.workspace)).control === "human") held.push(partner.id);
  }
  if (held.length === 0) return `green Computer control: partner. ${tail}`;
  const who = held.map((name) => (name === "the session" ? "you hold the session browser" : `you hold the ${name} browser`)).join(". ");
  return `yellow Computer control: ${who}. ${tail}`;
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
