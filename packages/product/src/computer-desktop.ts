import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const binaryCache = new Map<string, boolean>();

async function hasBinary(name: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? "";
  const cacheKey = `${name}::${pathEnv}`;
  const cached = binaryCache.get(cacheKey);
  if (cached !== undefined) return cached;
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    try {
      await access(path.join(dir, name), fsConstants.X_OK);
      binaryCache.set(cacheKey, true);
      return true;
    } catch {
      // Keep searching PATH
    }
  }
  binaryCache.set(cacheKey, false);
  return false;
}

export interface ComputerDesktopState {
  display: string;
  xvncPid?: number;
  chromePid?: number;
  width: number;
  height: number;
  control: "partner" | "human";
  approved: boolean;
  status: "idle" | "held" | "live";
  lastUrl?: string;
  updatedAt: string;
}

export interface ComputerActionResult {
  ok: boolean;
  detail: string;
  display: string;
  width: number;
  height: number;
  cursor?: { x: number; y: number };
  windowTitle?: string;
  screenshot: string;
  control: "partner" | "human";
  status: "idle" | "held" | "live";
  frameMtimeMs?: number;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DESKTOP_STATE_REL = path.join(".ocp", "computer-desktop.json");
const LEGACY_COMPUTER_REL = path.join(".ocp", "computer.json");
const FRAME_REL = path.join("gtm", "last-frame.png");
const LAST_RUN_REL = path.join("gtm", "last-run.json");

// Valid 1x1 dark-slate PNG fallback when running in headless CI without X11/ffmpeg
const FALLBACK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function desktopStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, DESKTOP_STATE_REL);
}

function legacyComputerPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, LEGACY_COMPUTER_REL);
}

function defaultDisplayForWorkspace(workspaceRoot: string): string {
  if (process.env.OCP_COMPUTER_DISPLAY?.trim()) {
    return process.env.OCP_COMPUTER_DISPLAY.trim();
  }
  const hash = createHash("sha256").update(path.resolve(workspaceRoot)).digest();
  // Map workspace to virtual display :50 .. :89 so each workspace gets a stable dedicated Xvnc display
  const num = 50 + (hash[0]! % 40);
  return `:${num}`;
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readDesktopState(workspaceRoot: string): Promise<ComputerDesktopState> {
  const root = path.resolve(workspaceRoot);
  let state: Partial<ComputerDesktopState> = {};
  try {
    state = JSON.parse(await readFile(desktopStatePath(root), "utf8")) as Partial<ComputerDesktopState>;
  } catch {
    // Fallback to legacy .ocp/computer.json if present
    try {
      const legacy = JSON.parse(await readFile(legacyComputerPath(root), "utf8")) as {
        control?: "partner" | "human";
        approved?: boolean;
        status?: "idle" | "held" | "live";
      };
      state = {
        control: legacy.control,
        approved: legacy.approved,
        status: legacy.status,
      };
    } catch {
      state = {};
    }
  }
  return {
    display: typeof state.display === "string" && state.display.startsWith(":") ? state.display : defaultDisplayForWorkspace(root),
    xvncPid: typeof state.xvncPid === "number" && isProcessAlive(state.xvncPid) ? state.xvncPid : undefined,
    chromePid: typeof state.chromePid === "number" && isProcessAlive(state.chromePid) ? state.chromePid : undefined,
    width: typeof state.width === "number" && state.width >= 320 ? state.width : DEFAULT_WIDTH,
    height: typeof state.height === "number" && state.height >= 240 ? state.height : DEFAULT_HEIGHT,
    control: state.control === "human" ? "human" : "partner",
    approved: state.approved !== false,
    status: state.control === "human" ? "held" : state.status === "live" ? "live" : "idle",
    lastUrl: typeof state.lastUrl === "string" ? state.lastUrl : undefined,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date().toISOString(),
  };
}

export async function writeDesktopState(workspaceRoot: string, state: ComputerDesktopState): Promise<ComputerDesktopState> {
  const root = path.resolve(workspaceRoot);
  const next: ComputerDesktopState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(path.join(root, ".ocp"), { recursive: true });
  await writeFile(desktopStatePath(root), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await writeFile(
    legacyComputerPath(root),
    `${JSON.stringify({ desktop: "sandbox", control: next.control, approved: next.approved, status: next.status }, null, 2)}\n`,
    "utf8",
  );
  return next;
}

async function displayResponds(display: string): Promise<{ ok: boolean; width?: number; height?: number }> {
  if (!(await hasBinary("xdotool"))) return { ok: false };
  try {
    const { stdout } = await execFileAsync("xdotool", ["getdisplaygeometry"], {
      env: { ...process.env, DISPLAY: display },
      timeout: 2_500,
    });
    const parts = stdout.trim().split(/\s+/).map(Number);
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      return { ok: true, width: parts[0], height: parts[1] };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function ensureComputerDisplay(workspaceRoot: string): Promise<ComputerDesktopState> {
  const root = path.resolve(workspaceRoot);
  const state = await readDesktopState(root);

  // 1. Check if the assigned virtual display is already alive
  const currentCheck = await displayResponds(state.display);
  if (currentCheck.ok) {
    state.width = currentCheck.width ?? state.width;
    state.height = currentCheck.height ?? state.height;
    if (state.control !== "human") state.status = "live";
    return writeDesktopState(root, state);
  }

  // 2. Try starting an isolated Xvnc display for this workspace when Xvnc is available
  if (await hasBinary("Xvnc")) {
    try {
      let spawnFailed = false;
      const child = spawn(
        "Xvnc",
        [
          state.display,
          "-geometry",
          `${state.width}x${state.height}`,
          "-depth",
          "24",
          "-SecurityTypes",
          "None",
          "-localhost",
          "yes",
          "-AlwaysShared",
        ],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      child.on("error", () => {
        spawnFailed = true;
      });
      child.unref();
      state.xvncPid = child.pid;
      for (let i = 0; i < 12 && !spawnFailed; i += 1) {
        await new Promise((r) => setTimeout(r, 120));
        if (spawnFailed) break;
        const check = await displayResponds(state.display);
        if (check.ok) {
          state.width = check.width ?? state.width;
          state.height = check.height ?? state.height;
          if (state.control !== "human") state.status = "live";
          return writeDesktopState(root, state);
        }
      }
    } catch {
      // Xvnc binary not available; fall back to host DISPLAY if available
    }
  }

  // 3. Fallback to process.env.DISPLAY (e.g. :0) if available
  const hostDisplay = process.env.DISPLAY?.trim();
  if (hostDisplay) {
    const hostCheck = await displayResponds(hostDisplay);
    if (hostCheck.ok) {
      state.display = hostDisplay;
      state.width = hostCheck.width ?? state.width;
      state.height = hostCheck.height ?? state.height;
      if (state.control !== "human") state.status = "live";
      return writeDesktopState(root, state);
    }
  }

  return writeDesktopState(root, state);
}

export async function getCursorAndWindow(display: string): Promise<{
  cursor?: { x: number; y: number };
  windowTitle?: string;
}> {
  if (!(await hasBinary("xdotool"))) return {};
  let cursor: { x: number; y: number } | undefined;
  let windowTitle: string | undefined;
  try {
    const { stdout } = await execFileAsync("xdotool", ["getmouselocation"], {
      env: { ...process.env, DISPLAY: display },
      timeout: 2_000,
    });
    const xMatch = /\bx:(\d+)/.exec(stdout);
    const yMatch = /\by:(\d+)/.exec(stdout);
    if (xMatch && yMatch) {
      cursor = { x: Number(xMatch[1]), y: Number(yMatch[1]) };
    }
  } catch {
    // Ignore when xdotool is unavailable
  }
  try {
    const { stdout } = await execFileAsync("xdotool", ["getactivewindow", "getwindowname"], {
      env: { ...process.env, DISPLAY: display },
      timeout: 2_000,
    });
    if (stdout.trim()) windowTitle = stdout.trim();
  } catch {
    // No active focused window
  }
  return { cursor, windowTitle };
}

export async function captureComputerScreen(workspaceRoot: string, note = "Captured live computer screen"): Promise<ComputerActionResult> {
  const root = path.resolve(workspaceRoot);
  const state = await ensureComputerDisplay(root);
  const framePath = path.join(root, FRAME_REL);
  await mkdir(path.dirname(framePath), { recursive: true });

  let captured = false;
  if (state.status === "live" && (await hasBinary("ffmpeg"))) {
    try {
      await execFileAsync(
        "ffmpeg",
        [
          "-nostdin",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "x11grab",
          "-video_size",
          `${state.width}x${state.height}`,
          "-i",
          state.display,
          "-frames:v",
          "1",
          framePath,
        ],
        { timeout: 6_000 },
      );
      const info = await stat(framePath).catch(() => undefined);
      if (info && info.size > 0) captured = true;
    } catch {
      captured = false;
    }
  }

  if (!captured) {
    await writeFile(framePath, FALLBACK_PNG);
  }

  const { cursor, windowTitle } = state.status === "live" ? await getCursorAndWindow(state.display) : {};
  const info = await stat(framePath).catch(() => undefined);
  await writeFile(
    path.join(root, LAST_RUN_REL),
    `${JSON.stringify(
      {
        url: state.lastUrl ?? `display://${state.display}`,
        title: windowTitle ?? `OCP Virtual Computer (${state.display})`,
        screenshot: "gtm/last-frame.png",
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    ok: true,
    detail: `${note} on ${state.display} (${state.width}x${state.height})${cursor ? ` cursor=(${cursor.x},${cursor.y})` : ""}${windowTitle ? ` window="${windowTitle}"` : ""}.`,
    display: state.display,
    width: state.width,
    height: state.height,
    cursor,
    windowTitle,
    screenshot: "gtm/last-frame.png",
    control: state.control,
    status: state.status,
    frameMtimeMs: info?.mtimeMs,
  };
}

function assertActorAllowed(state: ComputerDesktopState, actor: "partner" | "human"): string | undefined {
  if (actor === "partner" && state.control === "human") {
    return "Computer is currently held by human takeover. Return control to the bot before it can use mouse, keyboard, or browser.";
  }
  return undefined;
}

export interface MouseActionInput {
  action: "move" | "click" | "double_click" | "right_click" | "middle_click" | "down" | "up" | "drag" | "scroll" | "position";
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  button?: "left" | "middle" | "right";
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  actor?: "partner" | "human";
}

function buttonCode(button?: "left" | "middle" | "right"): string {
  if (button === "middle") return "2";
  if (button === "right") return "3";
  return "1";
}

export async function computerMouse(workspaceRoot: string, input: MouseActionInput): Promise<ComputerActionResult> {
  const root = path.resolve(workspaceRoot);
  const state = await ensureComputerDisplay(root);
  const actor = input.actor ?? "partner";
  const blocked = assertActorAllowed(state, actor);
  if (blocked) {
    return {
      ok: false,
      detail: blocked,
      display: state.display,
      width: state.width,
      height: state.height,
      screenshot: "gtm/last-frame.png",
      control: state.control,
      status: state.status,
    };
  }

  const clampX = (val: number | undefined): number =>
    Math.max(0, Math.min(state.width - 1, Math.round(Number.isFinite(val) ? Number(val) : state.width / 2)));
  const clampY = (val: number | undefined): number =>
    Math.max(0, Math.min(state.height - 1, Math.round(Number.isFinite(val) ? Number(val) : state.height / 2)));

  const x = input.x !== undefined ? clampX(input.x) : undefined;
  const y = input.y !== undefined ? clampY(input.y) : undefined;
  const env = { ...process.env, DISPLAY: state.display };
  const xdotoolReady = state.status === "live" && (await hasBinary("xdotool"));

  try {
    if (input.action === "position") {
      return captureComputerScreen(root, "Queried mouse position");
    }
    if (input.action === "move") {
      const tx = clampX(x);
      const ty = clampY(y);
      if (xdotoolReady) {
        await execFileAsync("xdotool", ["mousemove", "--sync", String(tx), String(ty)], { env, timeout: 4_000 });
      }
      return captureComputerScreen(root, `Moved mouse to (${tx}, ${ty})`);
    }
    if (input.action === "click" || input.action === "double_click" || input.action === "right_click" || input.action === "middle_click") {
      if (xdotoolReady) {
        const args: string[] = [];
        if (x !== undefined && y !== undefined) {
          args.push("mousemove", "--sync", String(x), String(y));
        }
        const btn =
          input.action === "right_click"
            ? "3"
            : input.action === "middle_click"
              ? "2"
              : buttonCode(input.button);
        if (input.action === "double_click") {
          args.push("click", "--repeat", "2", "--delay", "80", btn);
        } else {
          args.push("click", btn);
        }
        await execFileAsync("xdotool", args, { env, timeout: 4_000 });
        await new Promise((r) => setTimeout(r, 150));
      }
      return captureComputerScreen(
        root,
        `Executed ${input.action}${x !== undefined && y !== undefined ? ` at (${x}, ${y})` : ""}`,
      );
    }
    if (input.action === "down" || input.action === "up") {
      if (xdotoolReady) {
        const args: string[] = [];
        if (x !== undefined && y !== undefined) {
          args.push("mousemove", "--sync", String(x), String(y));
        }
        args.push(input.action === "down" ? "mousedown" : "mouseup", buttonCode(input.button));
        await execFileAsync("xdotool", args, { env, timeout: 4_000 });
      }
      return captureComputerScreen(root, `Mouse button ${input.action}`);
    }
    if (input.action === "drag") {
      const sx = clampX(input.fromX ?? 100);
      const sy = clampY(input.fromY ?? 100);
      const ex = clampX(x ?? 300);
      const ey = clampY(y ?? 300);
      if (xdotoolReady) {
        await execFileAsync(
          "xdotool",
          ["mousemove", "--sync", String(sx), String(sy), "mousedown", "1", "mousemove", "--sync", String(ex), String(ey), "mouseup", "1"],
          { env, timeout: 5_000 },
        );
        await new Promise((r) => setTimeout(r, 150));
      }
      return captureComputerScreen(root, `Dragged mouse from (${sx}, ${sy}) to (${ex}, ${ey})`);
    }
    if (input.action === "scroll") {
      const dir = input.direction ?? "down";
      const clicks = Math.max(1, Math.min(20, Math.round(Number(input.amount) || 4)));
      if (xdotoolReady) {
        const args: string[] = [];
        if (x !== undefined && y !== undefined) {
          args.push("mousemove", "--sync", String(x), String(y));
        }
        const scrollBtn = dir === "up" ? "4" : dir === "left" ? "6" : dir === "right" ? "7" : "5";
        args.push("click", "--repeat", String(clicks), "--delay", "40", scrollBtn);
        await execFileAsync("xdotool", args, { env, timeout: 4_000 });
        await new Promise((r) => setTimeout(r, 150));
      }
      return captureComputerScreen(root, `Scrolled ${dir} (${clicks} ticks)`);
    }
    return {
      ok: false,
      detail: `Unsupported mouse action: ${String(input.action)}`,
      display: state.display,
      width: state.width,
      height: state.height,
      screenshot: "gtm/last-frame.png",
      control: state.control,
      status: state.status,
    };
  } catch (error) {
    const captured = await captureComputerScreen(root, `Mouse ${input.action} completed with fallback`);
    return {
      ...captured,
      detail: `${captured.detail} (${error instanceof Error ? error.message : "xdotool warning"})`,
    };
  }
}

export interface KeyboardActionInput {
  action: "type" | "key" | "hotkey";
  text?: string;
  key?: string;
  actor?: "partner" | "human";
}

function normalizeXdotoolKey(raw: string): string {
  const keyMap: Record<string, string> = {
    enter: "Return",
    return: "Return",
    esc: "Escape",
    escape: "Escape",
    tab: "Tab",
    backspace: "BackSpace",
    delete: "Delete",
    space: "space",
    up: "Up",
    arrowup: "Up",
    down: "Down",
    arrowdown: "Down",
    left: "Left",
    arrowleft: "Left",
    right: "Right",
    arrowright: "Right",
    home: "Home",
    end: "End",
    pageup: "Page_Up",
    pagedown: "Page_Down",
    ctrl: "ctrl",
    control: "ctrl",
    alt: "alt",
    shift: "shift",
    super: "super",
    meta: "super",
    cmd: "super",
  };
  return raw
    .trim()
    .split("+")
    .map((part) => {
      const trimmed = part.trim();
      const lower = trimmed.toLowerCase();
      return keyMap[lower] ?? trimmed;
    })
    .filter(Boolean)
    .join("+");
}

export async function computerKeyboard(workspaceRoot: string, input: KeyboardActionInput): Promise<ComputerActionResult> {
  const root = path.resolve(workspaceRoot);
  const state = await ensureComputerDisplay(root);
  const actor = input.actor ?? "partner";
  const blocked = assertActorAllowed(state, actor);
  if (blocked) {
    return {
      ok: false,
      detail: blocked,
      display: state.display,
      width: state.width,
      height: state.height,
      screenshot: "gtm/last-frame.png",
      control: state.control,
      status: state.status,
    };
  }

  const env = { ...process.env, DISPLAY: state.display };
  const xdotoolReady = state.status === "live" && (await hasBinary("xdotool"));
  try {
    if (input.action === "type") {
      const text = typeof input.text === "string" ? input.text : "";
      if (!text || text.length > 2_000) {
        return {
          ok: false,
          detail: "Keyboard type text must be 1 to 2,000 characters.",
          display: state.display,
          width: state.width,
          height: state.height,
          screenshot: "gtm/last-frame.png",
          control: state.control,
          status: state.status,
        };
      }
      if (xdotoolReady) {
        await execFileAsync("xdotool", ["type", "--clearmodifiers", "--delay", "12", "--", text], {
          env,
          timeout: 15_000,
        });
        await new Promise((r) => setTimeout(r, 150));
      }
      return captureComputerScreen(root, `Typed ${text.length} character(s)`);
    }

    const rawKey = typeof input.key === "string" && input.key.trim() ? input.key : typeof input.text === "string" ? input.text : "";
    const normalized = normalizeXdotoolKey(rawKey);
    if (!normalized || normalized.length > 80 || /[^A-Za-z0-9_+:-]/.test(normalized)) {
      return {
        ok: false,
        detail: "Provide a valid key or hotkey combination (for example Return, Tab, Escape, BackSpace, ctrl+l, ctrl+c).",
        display: state.display,
        width: state.width,
        height: state.height,
        screenshot: "gtm/last-frame.png",
        control: state.control,
        status: state.status,
      };
    }
    if (xdotoolReady) {
      await execFileAsync("xdotool", ["key", "--clearmodifiers", "--", normalized], {
        env,
        timeout: 5_000,
      });
      await new Promise((r) => setTimeout(r, 150));
    }
    return captureComputerScreen(root, `Pressed key ${normalized}`);
  } catch (error) {
    const captured = await captureComputerScreen(root, `Keyboard ${input.action} completed with fallback`);
    return {
      ...captured,
      detail: `${captured.detail} (${error instanceof Error ? error.message : "xdotool warning"})`,
    };
  }
}

export async function computerOpenBrowser(
  workspaceRoot: string,
  url: string,
  actor: "partner" | "human" = "partner",
): Promise<ComputerActionResult> {
  const root = path.resolve(workspaceRoot);
  const state = await ensureComputerDisplay(root);
  const blocked = assertActorAllowed(state, actor);
  if (blocked) {
    return {
      ok: false,
      detail: blocked,
      display: state.display,
      width: state.width,
      height: state.height,
      screenshot: "gtm/last-frame.png",
      control: state.control,
      status: state.status,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "data:") {
      throw new Error("Unsupported protocol");
    }
  } catch {
    return {
      ok: false,
      detail: "Browser URL must use http://, https://, or data:.",
      display: state.display,
      width: state.width,
      height: state.height,
      screenshot: "gtm/last-frame.png",
      control: state.control,
      status: state.status,
    };
  }

  const profileDir = path.join(root, ".ocp", "chrome-profile");
  await mkdir(profileDir, { recursive: true });

  if (state.chromePid && isProcessAlive(state.chromePid)) {
    try {
      process.kill(state.chromePid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 250));
    } catch {
      // Ignore
    }
  }

  const chromeBin = (await hasBinary("google-chrome"))
    ? "google-chrome"
    : (await hasBinary("chromium"))
      ? "chromium"
      : (await hasBinary("chromium-browser"))
        ? "chromium-browser"
        : undefined;

  if (state.status === "live" && chromeBin) {
    try {
      const child = spawn(
        chromeBin,
        [
          "--no-sandbox",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          `--user-data-dir=${profileDir}`,
          `--window-size=${state.width},${state.height}`,
          "--window-position=0,0",
          parsed.toString(),
        ],
        {
          env: { ...process.env, DISPLAY: state.display },
          detached: true,
          stdio: "ignore",
        },
      );
      child.on("error", () => {
        // Ignore async spawn errors when browser binary is unavailable
      });
      child.unref();
      state.chromePid = child.pid;
      state.lastUrl = parsed.toString();
      await writeDesktopState(root, state);
      // Give Chrome a moment to render on the virtual display before capturing the frame
      await new Promise((r) => setTimeout(r, 1_500));
    } catch {
      state.lastUrl = parsed.toString();
      await writeDesktopState(root, state);
    }
  } else {
    state.lastUrl = parsed.toString();
    await writeDesktopState(root, state);
  }

  return captureComputerScreen(root, `Opened ${parsed.toString()} in virtual computer browser`);
}

export async function setComputerControl(
  workspaceRoot: string,
  mode: "takeover" | "return" | "allow",
): Promise<ComputerActionResult> {
  const root = path.resolve(workspaceRoot);
  const state = await ensureComputerDisplay(root);
  if (mode === "takeover") {
    state.control = "human";
    state.status = "held";
  } else if (mode === "return") {
    state.control = "partner";
    state.status = "live";
  } else {
    state.approved = true;
    if (state.control !== "human") state.status = "live";
  }
  await writeDesktopState(root, state);
  return captureComputerScreen(
    root,
    mode === "takeover"
      ? "Human took over computer mouse and keyboard control"
      : mode === "return"
        ? "Returned computer mouse and keyboard control to bot"
        : "Approved computer desktop use",
  );
}

export async function stopComputerDesktop(workspaceRoot: string): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const state = await readDesktopState(root);
  for (const pid of [state.chromePid, state.xvncPid]) {
    if (pid && isProcessAlive(pid)) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Ignore
        }
      }
    }
  }
  await new Promise((r) => setTimeout(r, 200));
  state.chromePid = undefined;
  state.xvncPid = undefined;
  state.status = state.control === "human" ? "held" : "idle";
  await writeDesktopState(root, state);
}
