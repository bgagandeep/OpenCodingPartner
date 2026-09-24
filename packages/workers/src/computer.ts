/// <reference path="./playwright.d.ts" />
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ComputerAction {
  id: string;
  kind: "open-url" | "type" | "read-screen";
  target: string;
  purpose: string;
  executed: boolean;
  liveBrowser: boolean;
}

export interface ScreenShot {
  title: string;
  text: string;
  screenshotPng: Uint8Array;
}

export interface BrowserSession {
  open(url: string): Promise<ScreenShot>;
  readScreen(): Promise<ScreenShot>;
  typeInto(selector: string, text: string): Promise<ScreenShot>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  start(): Promise<BrowserSession>;
}

export interface ComputerStepEvidence {
  kind: ComputerAction["kind"];
  executed: boolean;
  title?: string;
  text?: string;
  selector?: string;
  screenshot?: string;
}

export interface GtmPlan {
  title: string;
  note: string;
  actions: ComputerAction[];
  evidence?: {
    url: string;
    title: string;
    screenshot: string;
    steps: ComputerStepEvidence[];
  };
}

export interface ComputerVisitInput {
  productName: string;
  message: string;
  sandboxRoot: string;
  execute: boolean;
  envUrl?: string;
  allowHosts?: readonly string[];
  driver?: BrowserDriver;
}

/** Record intended go-to-market computer actions. Nothing here is executed. */
export function planGtmActions(productName: string): GtmPlan {
  return {
    title: `${productName} go-to-market`,
    note: "Recorded intended computer actions. No live browser ran.",
    actions: [
      {
        id: "gtm-1",
        kind: "open-url",
        target: "https://example.invalid/draft-landing",
        purpose: "Open the draft landing page",
        executed: false,
        liveBrowser: false,
      },
      {
        id: "gtm-2",
        kind: "type",
        target: "hero",
        purpose: "Draft a one-line pitch",
        executed: false,
        liveBrowser: false,
      },
      {
        id: "gtm-3",
        kind: "read-screen",
        target: "hero",
        purpose: "Check the pitch is visible",
        executed: false,
        liveBrowser: false,
      },
    ],
  };
}

/** `type "text" into #selector`. Quotes are required. The selector is not code. */
export function typeInstruction(message: string): { text: string; selector: string } | undefined {
  const match = message.match(/type\s+"([^"]*)"\s+into\s+(\S+)/i) ?? message.match(/type\s+'([^']*)'\s+into\s+(\S+)/i);
  const text = match?.[1];
  const selector = match?.[2]?.replace(/[.,]$/, "");
  if (text === undefined || !selector) return undefined;
  return { text, selector };
}

export function selectorDecision(selector: string): { allow: boolean; reason: string } {
  const text = selector.trim();
  if (text.length === 0 || text.length > 200) return { allow: false, reason: "selector is empty or too long" };
  if (/[\n\r]/.test(text)) return { allow: false, reason: "selector must be one line" };
  if (/[<>]|javascript:|eval\s*\(|document\.|window\.|=>|function\s*\(|\bscript\b/i.test(text)) {
    return { allow: false, reason: "selector looks like a script" };
  }
  return { allow: true, reason: "" };
}

/** First http(s) URL in the message. An env URL wins when the operator set one. */
export function namedUrl(message: string, envUrl?: string): string | undefined {
  const fromEnv = envUrl?.trim();
  if (fromEnv) return fromEnv;
  return message.match(/https?:\/\/[^\s)]+/)?.[0];
}

export function urlDecision(raw: string, allowHosts?: readonly string[]): { allow: boolean; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { allow: false, reason: "URL is not valid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allow: false, reason: "only http and https URLs are allowed" };
  }
  if (parsed.username || parsed.password) {
    return { allow: false, reason: "URL must not carry a username or password" };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return { allow: false, reason: "URL has no host" };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") {
    return { allow: false, reason: "local and metadata hosts are blocked" };
  }
  if (isBlockedAddress(host)) return { allow: false, reason: "private and loopback addresses are blocked" };
  const allow = (allowHosts ?? []).map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
  if (allow.length > 0 && !allow.some((item) => host === item || host.endsWith(`.${item}`))) {
    return { allow: false, reason: "host is not on the allow list" };
  }
  return { allow: true, reason: "" };
}

export async function executeComputerVisit(input: ComputerVisitInput): Promise<GtmPlan> {
  if (!input.execute) return planGtmActions(input.productName);
  const url = namedUrl(input.message, input.envUrl);
  const plan = planGtmActions(input.productName);
  if (!url) {
    plan.note = "Computer execute was requested. Name an http or https URL. No live browser ran.";
    return plan;
  }
  const decision = urlDecision(url, input.allowHosts);
  const open = plan.actions.find((action) => action.kind === "open-url");
  if (open) open.target = url;
  if (!decision.allow) {
    plan.note = `Computer execute was requested. Refused ${url}: ${decision.reason}. No live browser ran.`;
    return plan;
  }
  if (!input.driver) {
    plan.note = "Computer execute was requested. No browser driver is configured. No live browser ran.";
    return plan;
  }
  const typing = typeInstruction(input.message);
  const steps: ComputerAction[] = [
    { id: "gtm-1", kind: "open-url", target: url, purpose: "Open the named URL", executed: false, liveBrowser: false },
    { id: "gtm-2", kind: "read-screen", target: url, purpose: "Read the page title and text", executed: false, liveBrowser: false },
  ];
  if (typing) {
    steps.push({
      id: "gtm-3",
      kind: "type",
      target: typing.selector,
      purpose: "Type into the named selector",
      executed: false,
      liveBrowser: false,
    });
  }
  plan.actions = steps;
  const selectorGate = typing ? selectorDecision(typing.selector) : { allow: true, reason: "" };
  let session: BrowserSession | undefined;
  const recorded: ComputerStepEvidence[] = [];
  try {
    session = await input.driver.start();
    const opened = await session.open(url);
    const openShot = `gtm/step-1.png`;
    await writeEvidence(input.sandboxRoot, openShot, opened.screenshotPng);
    mark(steps[0], true);
    recorded.push({ kind: "open-url", executed: true, title: redact(opened.title), screenshot: openShot });
    const read = await session.readScreen();
    const readShot = `gtm/step-2.png`;
    await writeEvidence(input.sandboxRoot, readShot, read.screenshotPng);
    mark(steps[1], true);
    recorded.push({
      kind: "read-screen",
      executed: true,
      title: redact(read.title),
      text: redact(read.text).slice(0, 500),
      screenshot: readShot,
    });
    if (typing && selectorGate.allow && steps[2]) {
      const typed = await session.typeInto(typing.selector, typing.text);
      const typeShot = `gtm/step-3.png`;
      await writeEvidence(input.sandboxRoot, typeShot, typed.screenshotPng);
      mark(steps[2], true);
      recorded.push({
        kind: "type",
        executed: true,
        selector: typing.selector,
        title: redact(typed.title),
        text: redact(typing.text),
        screenshot: typeShot,
      });
    } else if (typing && steps[2]) {
      recorded.push({ kind: "type", executed: false, selector: typing.selector });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "browser failed";
    plan.note = `Computer execute was requested. The browser did not finish (${redact(message)}). Finished steps stay marked.`;
    await session?.close().catch(() => undefined);
    await persistRun(input.sandboxRoot, url, recorded, plan);
    return plan;
  }
  await session.close();
  const title = recorded.find((step) => step.kind === "read-screen")?.title ?? "";
  const refused = typing && !selectorGate.allow ? ` Refused the type step: ${selectorGate.reason}.` : "";
  plan.note = `Live browser opened ${url}. Title: ${title}.${refused} Evidence: gtm/last-run.json.`;
  await persistRun(input.sandboxRoot, url, recorded, plan);
  return plan;
}

function mark(action: ComputerAction | undefined, ran: boolean): void {
  if (!action) return;
  action.executed = ran;
  action.liveBrowser = ran;
}

async function persistRun(
  sandboxRoot: string,
  url: string,
  steps: ComputerStepEvidence[],
  plan: GtmPlan,
): Promise<void> {
  const last = [...steps].reverse().find((step) => step.screenshot);
  const screenshot = last?.screenshot ?? "";
  if (screenshot) {
    plan.evidence = { url, title: last?.title ?? "", screenshot, steps };
  }
  const body = { url, title: last?.title ?? "", screenshot, steps };
  await writeEvidence(sandboxRoot, "gtm/last-run.json", `${JSON.stringify(body, null, 2)}\n`);
}

/** Headless Chromium via Playwright. The operator installs Playwright and Chromium. */
export function playwrightBrowserDriver(): BrowserDriver {
  return {
    async start() {
      const loaded = (await import("playwright")) as typeof import("playwright");
      const browser = await loaded.chromium.launch({ headless: true });
      const page = await browser.newPage();
      const shot = async (): Promise<ScreenShot> => {
        const title = await page.title();
        const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
        const screenshotPng = await page.screenshot({ type: "png" });
        return { title, text, screenshotPng };
      };
      return {
        async open(url) {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
          return shot();
        },
        readScreen: shot,
        async typeInto(selector, text) {
          await page.locator(selector).fill(text, { timeout: 5000 });
          return shot();
        },
        async close() {
          await browser.close();
        },
      };
    },
  };
}

function redact(text: string): string {
  if (/password\s*=|api_key\s*=|AKIA[0-9A-Z]{16}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/i.test(text)) return "[redacted]";
  return text;
}

async function writeEvidence(sandboxRoot: string, relativePath: string, content: string | Uint8Array): Promise<void> {
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(root, relativePath);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(rootPrefix)) {
    throw new Error("evidence path left the sandbox");
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function isBlockedAddress(host: string): boolean {
  if (host.includes(":")) {
    const packed = host.toLowerCase();
    if (packed === "::1" || packed === "::") return true;
    if (packed.startsWith("fe80:") || packed.startsWith("fc") || packed.startsWith("fd")) return true;
    return false;
  }
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
