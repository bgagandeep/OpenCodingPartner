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

export interface GtmPlan {
  title: string;
  note: string;
  actions: ComputerAction[];
  evidence?: {
    url: string;
    title: string;
    screenshot: string;
  };
}

export interface BrowserDriver {
  open(url: string): Promise<{ title: string; screenshotPng: Uint8Array }>;
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
  let opened: { title: string; screenshotPng: Uint8Array };
  try {
    opened = await input.driver.open(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "browser failed";
    plan.note = `Computer execute was requested. The browser did not finish (${redact(message)}). No page was kept.`;
    return plan;
  }
  const title = redact(opened.title);
  const screenshotRelative = "gtm/last-screenshot.png";
  const evidenceRelative = "gtm/last-run.json";
  await writeEvidence(input.sandboxRoot, screenshotRelative, opened.screenshotPng);
  const evidence = { url, title, screenshot: screenshotRelative, executed: true };
  await writeEvidence(input.sandboxRoot, evidenceRelative, `${JSON.stringify(evidence, null, 2)}\n`);
  if (open) {
    open.executed = true;
    open.liveBrowser = true;
    open.purpose = "Opened the named URL and saved the title and a screenshot";
  }
  plan.evidence = { url, title, screenshot: screenshotRelative };
  plan.note = `Live browser opened ${url}. Title: ${title}. Evidence: ${evidenceRelative}.`;
  return plan;
}

/** Headless Chromium via Playwright. The operator installs Playwright and Chromium. */
export async function openWithPlaywright(url: string): Promise<{ title: string; screenshotPng: Uint8Array }> {
  const loaded = (await import("playwright")) as typeof import("playwright");
  const browser = await loaded.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    const title = await page.title();
    const screenshotPng = await page.screenshot({ type: "png" });
    return { title, screenshotPng };
  } finally {
    await browser.close();
  }
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
