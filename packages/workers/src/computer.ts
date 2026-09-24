/// <reference path="./playwright.d.ts" />
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ComputerAction {
  id: string;
  kind: "open-url" | "type" | "read-screen" | "verify";
  target: string;
  purpose: string;
  executed: boolean;
  liveBrowser: boolean;
  passed?: boolean;
  skipped?: boolean;
  reason?: string;
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
  selectorState?(selector: string): Promise<{ visible: boolean; value: string }>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  start(): Promise<BrowserSession>;
}

export interface ComputerStepEvidence {
  kind: ComputerAction["kind"];
  executed: boolean;
  passed?: boolean;
  skipped?: boolean;
  reason?: string;
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

/** `expect title "..."` and `expect text "..."`. Both are optional. Quotes are required. */
export function pageClaim(message: string): { title?: string; text?: string } | undefined {
  const title = quotedClaim(message, "title");
  const text = quotedClaim(message, "text");
  if (title === undefined && text === undefined) return undefined;
  return { ...(title !== undefined ? { title } : {}), ...(text !== undefined ? { text } : {}) };
}

export interface ChainStep {
  kind: "type" | "expect-title" | "expect-text" | "expect-selector";
  target: string;
  text?: string;
}

/** Steps in the order they appear. A short chain can include more than one type. */
export function computerChain(message: string): ChainStep[] {
  const pattern = /expect title "([^"]*)"|expect text "([^"]*)"|type "([^"]*)" into (\S+)|expect selector (\S+) value "([^"]*)"|expect title '([^']*)'|expect text '([^']*)'|type '([^']*)' into (\S+)|expect selector (\S+) value '([^']*)'/gi;
  const steps: ChainStep[] = [];
  for (const match of message.matchAll(pattern)) {
    if (match[1] !== undefined) steps.push({ kind: "expect-title", target: match[1] });
    else if (match[2] !== undefined) steps.push({ kind: "expect-text", target: match[2] });
    else if (match[3] !== undefined && match[4]) steps.push({ kind: "type", target: match[4].replace(/[.,]$/, ""), text: match[3] });
    else if (match[5] && match[6] !== undefined) steps.push({ kind: "expect-selector", target: match[5].replace(/[.,]$/, ""), text: match[6] });
    else if (match[7] !== undefined) steps.push({ kind: "expect-title", target: match[7] });
    else if (match[8] !== undefined) steps.push({ kind: "expect-text", target: match[8] });
    else if (match[9] !== undefined && match[10]) steps.push({ kind: "type", target: match[10].replace(/[.,]$/, ""), text: match[9] });
    else if (match[11] && match[12] !== undefined) steps.push({ kind: "expect-selector", target: match[11].replace(/[.,]$/, ""), text: match[12] });
  }
  return steps;
}

function quotedClaim(message: string, name: "title" | "text"): string | undefined {
  const match = message.match(new RegExp(`expect ${name} "([^"]*)"`, "i")) ?? message.match(new RegExp(`expect ${name} '([^']*)'`, "i"));
  return match?.[1];
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
  if (!input.execute) {
    const plan = planGtmActions(input.productName);
    const claim = pageClaim(input.message);
    if (claim) {
      plan.note = "Computer execute is off. No live browser ran. The page claim was not checked.";
      await writeClaim(input.sandboxRoot, namedUrl(input.message, input.envUrl) ?? "", claim, "", "", "", false);
    }
    return plan;
  }
  const url = namedUrl(input.message, input.envUrl);
  const plan = planGtmActions(input.productName);
  const claim = pageClaim(input.message);
  if (!url) {
    plan.note = "Computer execute was requested. Name an http or https URL. No live browser ran.";
    if (claim) await writeClaim(input.sandboxRoot, "", claim, "", "", "", false);
    return plan;
  }
  const decision = urlDecision(url, input.allowHosts);
  const open = plan.actions.find((action) => action.kind === "open-url");
  if (open) open.target = url;
  if (!decision.allow) {
    plan.note = `Computer execute was requested. Refused ${url}: ${decision.reason}. No live browser ran.`;
    if (claim) await writeClaim(input.sandboxRoot, url, claim, "", "", "", false);
    return plan;
  }
  if (!input.driver) {
    plan.note = "Computer execute was requested. Playwright is missing or no browser driver is configured. No live browser ran.";
    if (claim) await writeClaim(input.sandboxRoot, url, claim, "", "", "", false);
    return plan;
  }
  const chain = computerChain(input.message);
  const steps: ComputerAction[] = [
    { id: "gtm-1", kind: "open-url", target: url, purpose: "Open the named URL", executed: false, liveBrowser: false },
    { id: "gtm-2", kind: "read-screen", target: url, purpose: "Read the page title and text", executed: false, liveBrowser: false },
  ];
  for (const [index, item] of chain.entries()) {
    steps.push({
      id: `gtm-${index + 3}`,
      kind: item.kind === "type" ? "type" : "verify",
      target: item.target,
      purpose: chainPurpose(item),
      executed: false,
      liveBrowser: false,
    });
  }
  plan.actions = steps;
  let session: BrowserSession | undefined;
  const recorded: ComputerStepEvidence[] = [];
  let failed = "";
  let screen: ScreenShot | undefined;
  try {
    session = await input.driver.start();
    screen = await session.open(url);
    await finishStep(input.sandboxRoot, steps[0], recorded, screen, true, "");
    if (!failed) {
      screen = await session.readScreen();
      await finishStep(input.sandboxRoot, steps[1], recorded, screen, true, "");
    }
    for (let index = 0; index < chain.length; index += 1) {
      const action = steps[index + 2];
      const item = chain[index];
      if (!action || !item) continue;
      if (failed) {
        action.executed = false;
        action.skipped = true;
        action.passed = false;
        action.reason = "skipped because an earlier step failed";
        recorded.push({ kind: action.kind, executed: false, skipped: true, passed: false, reason: action.reason, selector: item.target });
        continue;
      }
      const outcome = await runChainStep(session, item, screen);
      screen = outcome.screen ?? screen;
      if (outcome.passed && screen) await finishStep(input.sandboxRoot, action, recorded, screen, true, "");
      else {
        failed = outcome.reason;
        action.executed = true;
        action.passed = false;
        action.reason = outcome.reason;
        if (screen) await finishStep(input.sandboxRoot, action, recorded, screen, false, outcome.reason);
        else recorded.push({ kind: action.kind, executed: true, passed: false, reason: outcome.reason });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "browser failed";
    failed = failed || redact(message);
    plan.note = `Computer execute was requested. The browser did not finish (${failed}). Playwright or Chromium may be missing. Later steps were skipped.`;
    await session?.close().catch(() => undefined);
    await persistRun(input.sandboxRoot, url, recorded, plan);
    if (claim) await writeClaim(input.sandboxRoot, url, claim, "", "", "", false);
    return plan;
  }
  await session.close();
  const title = screen?.title ?? "";
  const held = !failed && (!claim || claimHolds(claim, title, screen?.text ?? ""));
  if (claim) {
    const shot = [...recorded].reverse().find((step) => step.screenshot)?.screenshot ?? "";
    await writeClaim(input.sandboxRoot, url, claim, redact(title), redact(screen?.text ?? "").slice(0, 500), shot, true, held && !failed);
  }
  plan.note = failed
    ? `Step failed: ${failed}. Later steps were skipped. Evidence: gtm/last-run.json.`
    : `Live browser opened ${url}. Title: ${redact(title)}. ${claim ? "The page claim held. " : ""}Evidence: gtm/last-run.json.`;
  await persistRun(input.sandboxRoot, url, recorded, plan);
  return plan;
}

function chainPurpose(item: ChainStep): string {
  if (item.kind === "type") return "Type into the named selector";
  if (item.kind === "expect-selector") return "Check the selector value";
  if (item.kind === "expect-text") return "Check the page text";
  return "Check the page title";
}

async function finishStep(
  sandboxRoot: string,
  action: ComputerAction | undefined,
  recorded: ComputerStepEvidence[],
  screen: ScreenShot,
  passed: boolean,
  reason: string,
): Promise<void> {
  if (!action) return;
  const shot = `gtm/step-${recorded.length + 1}.png`;
  await writeEvidence(sandboxRoot, shot, screen.screenshotPng);
  action.executed = true;
  action.liveBrowser = true;
  action.passed = passed;
  if (!passed) action.reason = reason;
  recorded.push({
    kind: action.kind,
    executed: true,
    passed,
    reason: reason || undefined,
    title: redact(screen.title),
    text: redact(screen.text).slice(0, 500),
    selector: action.kind === "type" || action.kind === "verify" ? action.target : undefined,
    screenshot: shot,
  });
}

async function runChainStep(
  session: BrowserSession,
  item: ChainStep,
  screen: ScreenShot | undefined,
): Promise<{ passed: boolean; reason: string; screen?: ScreenShot }> {
  if (item.kind === "expect-title") {
    const seen = await session.readScreen();
    const passed = seen.title === item.target;
    return { passed, reason: passed ? "" : `title was ${seen.title || "empty"}, expected ${item.target}`, screen: seen };
  }
  if (item.kind === "expect-text") {
    const seen = await session.readScreen();
    const passed = seen.text.includes(item.target);
    return { passed, reason: passed ? "" : `page text did not include ${item.target}`, screen: seen };
  }
  if (item.kind === "type") {
    const gate = selectorDecision(item.target);
    if (!gate.allow) return { passed: false, reason: gate.reason, screen };
    const typed = await session.typeInto(item.target, item.text ?? "");
    return { passed: true, reason: "", screen: typed };
  }
  if (!session.selectorState) return { passed: false, reason: "browser cannot read selector state", screen };
  const state = await session.selectorState(item.target);
  const passed = state.visible && state.value === (item.text ?? "");
  return {
    passed,
    reason: passed ? "" : `selector ${item.target} value was ${state.value || "empty"}, expected ${item.text}`,
    screen,
  };
}

function claimHolds(claim: { title?: string; text?: string }, actualTitle: string, actualText: string): boolean {
  if (claim.title !== undefined && actualTitle !== claim.title) return false;
  if (claim.text !== undefined && !actualText.includes(claim.text)) return false;
  return true;
}

async function writeClaim(
  sandboxRoot: string,
  url: string,
  claim: { title?: string; text?: string },
  actualTitle: string,
  actualText: string,
  screenshot: string,
  executed: boolean,
  claimHeld = false,
): Promise<void> {
  const body = {
    url,
    expectedTitle: claim.title ?? "",
    actualTitle,
    expectedText: claim.text ?? "",
    actualText,
    screenshot,
    executed,
    claimHeld: executed && claimHeld,
  };
  await writeEvidence(sandboxRoot, "gtm/assertion.json", `${JSON.stringify(body, null, 2)}\n`);
  if (!executed) {
    await writeEvidence(
      sandboxRoot,
      "gtm/last-run.json",
      `${JSON.stringify({ url, title: actualTitle, screenshot, executed: false, steps: [{ kind: "verify", executed: false }] }, null, 2)}\n`,
    );
  }
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
        async selectorState(selector) {
          const locator = page.locator(selector);
          const visible = await locator.isVisible({ timeout: 5000 }).catch(() => false);
          const value = await locator.inputValue({ timeout: 5000 }).catch(() => "");
          return { visible, value };
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
