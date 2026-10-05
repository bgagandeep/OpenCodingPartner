/// <reference path="./playwright.d.ts" />
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ComputerAction {
  id: string;
  kind: "open-url" | "type" | "read-screen" | "verify" | "click" | "navigate" | "wait" | "scroll" | "press" | "hover" | "double-click" | "right-click" | "fill" | "select" | "check" | "uncheck";
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
  click?(target: string, by: "selector" | "text"): Promise<ScreenShot>;
  navigate?(url: string): Promise<ScreenShot>;
  waitFor?(selector: string, timeoutMs: number): Promise<ScreenShot>;
  scrollBy?(deltaY: number): Promise<ScreenShot>;
  scrollIntoView?(selector: string): Promise<ScreenShot>;
  press?(key: string): Promise<ScreenShot>;
  hover?(target: string, by: "selector" | "text"): Promise<ScreenShot>;
  doubleClick?(target: string, by: "selector" | "text"): Promise<ScreenShot>;
  rightClick?(target: string, by: "selector" | "text"): Promise<ScreenShot>;
  /** Clear the field, then set the quoted text. Selector or exact text. */
  fill?(target: string, value: string, by: "selector" | "text"): Promise<ScreenShot>;
  /** Choose a select option by its visible label. */
  selectOption?(target: string, label: string, by: "selector" | "text"): Promise<ScreenShot>;
  /** Check a checkbox or radio. Selector or exact label text. */
  check?(target: string, by: "selector" | "text"): Promise<ScreenShot>;
  /** Uncheck a checkbox. Selector or exact label text. */
  uncheck?(target: string, by: "selector" | "text"): Promise<ScreenShot>;
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
  kind: "type" | "expect-title" | "expect-text" | "expect-selector" | "click" | "navigate" | "wait" | "scroll" | "press" | "hover" | "double-click" | "right-click" | "fill" | "select" | "check" | "uncheck";
  target: string;
  text?: string;
  /** Text placed in the field by `fill`. */
  value?: string;
}

/** Longest `wait N` or `wait Nms` sleep. Longer values fail the step. */
export const COMPUTER_WAIT_CAP_MS = 30_000;
/** Largest `scroll N` pixel delta. `scroll down` and `scroll up` use the step size. */
export const COMPUTER_SCROLL_CAP_PX = 2_000;
export const COMPUTER_SCROLL_STEP_PX = 800;
/** Keys `press` may send. Anything else fails the step. */
export const COMPUTER_PRESS_KEYS = ["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;

/** Steps in the order they appear. A short chain can include more than one type. */
export function computerChain(message: string): ChainStep[] {
  const pattern = /expect title "([^"]*)"|expect text "([^"]*)"|type "([^"]*)" into (\S+)|expect selector (\S+) value "([^"]*)"|click "([^"]*)"|click '([^']*)'|click (\S+)|navigate (https?:\/\/[^\s)]+)|expect title '([^']*)'|expect text '([^']*)'|type '([^']*)' into (\S+)|expect selector (\S+) value '([^']*)'|wait (\d+)ms|wait (\d+)|wait (\S+)|scroll down|scroll up|scroll (-?\d+)px|scroll (-?\d+)|scroll (\S+)|press (\S+)|hover "([^"]*)"|hover '([^']*)'|hover (\S+)|double-click "([^"]*)"|double-click '([^']*)'|double-click (\S+)|right-click "([^"]*)"|right-click '([^']*)'|right-click (\S+)|fill "([^"]*)" with "([^"]*)"|fill '([^']*)' with '([^']*)'|fill (\S+) with "([^"]*)"|fill (\S+) with '([^']*)'|select "([^"]*)" option "([^"]*)"|select '([^']*)' option '([^']*)'|select (\S+) option "([^"]*)"|select (\S+) option '([^']*)'|uncheck "([^"]*)"|uncheck '([^']*)'|uncheck (\S+)|check "([^"]*)"|check '([^']*)'|check (\S+)/gi;
  const steps: ChainStep[] = [];
  for (const match of message.matchAll(pattern)) {
    if (match[1] !== undefined) steps.push({ kind: "expect-title", target: match[1] });
    else if (match[2] !== undefined) steps.push({ kind: "expect-text", target: match[2] });
    else if (match[3] !== undefined && match[4]) steps.push({ kind: "type", target: match[4].replace(/[.,]$/, ""), text: match[3] });
    else if (match[5] && match[6] !== undefined) steps.push({ kind: "expect-selector", target: match[5].replace(/[.,]$/, ""), text: match[6] });
    else if (match[7] !== undefined) steps.push({ kind: "click", target: match[7], text: "text" });
    else if (match[8] !== undefined) steps.push({ kind: "click", target: match[8], text: "text" });
    else if (match[9]) steps.push({ kind: "click", target: match[9].replace(/[.,]$/, "") });
    else if (match[10]) steps.push({ kind: "navigate", target: match[10].replace(/[.,]$/, "") });
    else if (match[11] !== undefined) steps.push({ kind: "expect-title", target: match[11] });
    else if (match[12] !== undefined) steps.push({ kind: "expect-text", target: match[12] });
    else if (match[13] !== undefined && match[14]) steps.push({ kind: "type", target: match[14].replace(/[.,]$/, ""), text: match[13] });
    else if (match[15] && match[16] !== undefined) steps.push({ kind: "expect-selector", target: match[15].replace(/[.,]$/, ""), text: match[16] });
    else if (match[17]) steps.push({ kind: "wait", target: match[17], text: "sleep" });
    else if (match[18]) steps.push({ kind: "wait", target: match[18], text: "sleep" });
    else if (match[19]) steps.push({ kind: "wait", target: match[19].replace(/[.,]$/, "") });
    else if (match[0].toLowerCase().startsWith("scroll down")) steps.push({ kind: "scroll", target: String(COMPUTER_SCROLL_STEP_PX), text: "delta" });
    else if (match[0].toLowerCase().startsWith("scroll up")) steps.push({ kind: "scroll", target: String(-COMPUTER_SCROLL_STEP_PX), text: "delta" });
    else if (match[20]) steps.push({ kind: "scroll", target: match[20], text: "delta" });
    else if (match[21]) steps.push({ kind: "scroll", target: match[21], text: "delta" });
    else if (match[22]) steps.push({ kind: "scroll", target: match[22].replace(/[.,]$/, ""), text: "into-view" });
    else if (match[23]) steps.push({ kind: "press", target: match[23].replace(/[.,]$/, "") });
    else if (match[24] !== undefined) steps.push({ kind: "hover", target: match[24], text: "text" });
    else if (match[25] !== undefined) steps.push({ kind: "hover", target: match[25], text: "text" });
    else if (match[26]) steps.push({ kind: "hover", target: match[26].replace(/[.,]$/, "") });
    else if (match[27] !== undefined) steps.push({ kind: "double-click", target: match[27], text: "text" });
    else if (match[28] !== undefined) steps.push({ kind: "double-click", target: match[28], text: "text" });
    else if (match[29]) steps.push({ kind: "double-click", target: match[29].replace(/[.,]$/, "") });
    else if (match[30] !== undefined) steps.push({ kind: "right-click", target: match[30], text: "text" });
    else if (match[31] !== undefined) steps.push({ kind: "right-click", target: match[31], text: "text" });
    else if (match[32]) steps.push({ kind: "right-click", target: match[32].replace(/[.,]$/, "") });
    else if (match[33] !== undefined && match[34] !== undefined) steps.push({ kind: "fill", target: match[33], text: "text", value: match[34] });
    else if (match[35] !== undefined && match[36] !== undefined) steps.push({ kind: "fill", target: match[35], text: "text", value: match[36] });
    else if (match[37] && match[38] !== undefined) steps.push({ kind: "fill", target: match[37].replace(/[.,]$/, ""), value: match[38] });
    else if (match[39] && match[40] !== undefined) steps.push({ kind: "fill", target: match[39].replace(/[.,]$/, ""), value: match[40] });
    else if (match[41] !== undefined && match[42] !== undefined) steps.push({ kind: "select", target: match[41], text: "text", value: match[42] });
    else if (match[43] !== undefined && match[44] !== undefined) steps.push({ kind: "select", target: match[43], text: "text", value: match[44] });
    else if (match[45] && match[46] !== undefined) steps.push({ kind: "select", target: match[45].replace(/[.,]$/, ""), value: match[46] });
    else if (match[47] && match[48] !== undefined) steps.push({ kind: "select", target: match[47].replace(/[.,]$/, ""), value: match[48] });
    else if (match[49] !== undefined) steps.push({ kind: "uncheck", target: match[49], text: "text" });
    else if (match[50] !== undefined) steps.push({ kind: "uncheck", target: match[50], text: "text" });
    else if (match[51]) steps.push({ kind: "uncheck", target: match[51].replace(/[.,]$/, "") });
    else if (match[52] !== undefined) steps.push({ kind: "check", target: match[52], text: "text" });
    else if (match[53] !== undefined) steps.push({ kind: "check", target: match[53], text: "text" });
    else if (match[54]) steps.push({ kind: "check", target: match[54].replace(/[.,]$/, "") });
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

/** Shown when Playwright or Chromium is missing. No blank frame is written. */
export function browserMissingNote(): string {
  return "Browser is missing. Playwright is not installed. No frame was written. Install Chromium with pnpm exec playwright install chromium. ocp doctor reports Computer capture and does not start the browser.";
}

export function browserMissingMessage(message: string): boolean {
  return /playwright|chromium|browserType|executable doesn't exist|cannot find package|browser missing/i.test(message);
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
    plan.note = browserMissingNote();
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
      kind: item.kind === "type" ? "type" : item.kind === "click" ? "click" : item.kind === "navigate" ? "navigate" : item.kind === "wait" ? "wait" : item.kind === "scroll" ? "scroll" : item.kind === "press" ? "press" : item.kind === "hover" ? "hover" : item.kind === "double-click" ? "double-click" : item.kind === "right-click" ? "right-click" : item.kind === "fill" ? "fill" : item.kind === "select" ? "select" : item.kind === "check" ? "check" : item.kind === "uncheck" ? "uncheck" : "verify",
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
      const outcome = await runChainStep(session, item, screen, url, input.allowHosts);
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
    plan.note = browserMissingMessage(failed)
      ? browserMissingNote()
      : `Computer execute was requested. The browser did not finish (${failed}). Later steps were skipped.`;
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
  if (item.kind === "click") return item.text === "text" ? "Click the named text" : "Click the named selector";
  if (item.kind === "navigate") return "Open a URL on the same host";
  if (item.kind === "wait") return item.text === "sleep" ? "Wait a short time" : "Wait until the selector is visible";
  if (item.kind === "scroll") return item.text === "into-view" ? "Scroll the selector into view" : "Scroll the page";
  if (item.kind === "press") return "Press a named key";
  if (item.kind === "hover") return item.text === "text" ? "Hover the named text" : "Hover the named selector";
  if (item.kind === "double-click") return item.text === "text" ? "Double-click the named text" : "Double-click the named selector";
  if (item.kind === "right-click") return item.text === "text" ? "Right-click the named text" : "Right-click the named selector";
  if (item.kind === "fill") return item.text === "text" ? "Fill the named text" : "Fill the named selector";
  if (item.kind === "select") return item.text === "text" ? "Select the named text option" : "Select the named selector option";
  if (item.kind === "check") return item.text === "text" ? "Check the named text" : "Check the named selector";
  if (item.kind === "uncheck") return item.text === "text" ? "Uncheck the named text" : "Uncheck the named selector";
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
    selector: action.kind === "type" || action.kind === "verify" || action.kind === "click" || action.kind === "navigate" || action.kind === "hover" || action.kind === "double-click" || action.kind === "right-click" || action.kind === "fill" || action.kind === "select" || action.kind === "check" || action.kind === "uncheck" ? action.target : undefined,
    screenshot: shot,
  });
}

async function runChainStep(
  session: BrowserSession,
  item: ChainStep,
  screen: ScreenShot | undefined,
  openedUrl: string,
  allowHosts?: readonly string[],
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
  if (item.kind === "click") {
    const gate = selectorDecision(item.target);
    if (!gate.allow) return { passed: false, reason: gate.reason, screen };
    if (!session.click) return { passed: false, reason: "browser cannot click", screen };
    const next = await session.click(item.target, item.text === "text" ? "text" : "selector");
    return { passed: true, reason: "", screen: next };
  }
  if (item.kind === "navigate") {
    const decision = urlDecision(item.target, allowHosts);
    if (!decision.allow) return { passed: false, reason: decision.reason, screen };
    const openedHost = new URL(openedUrl).hostname.toLowerCase();
    const nextHost = new URL(item.target).hostname.toLowerCase();
    const listed = (allowHosts ?? []).map((host) => host.toLowerCase());
    if (nextHost !== openedHost && !listed.includes(nextHost)) {
      return { passed: false, reason: "navigate stays on the opened host", screen };
    }
    if (!session.navigate) return { passed: false, reason: "browser cannot navigate", screen };
    const next = await session.navigate(item.target);
    return { passed: true, reason: "", screen: next };
  }
  if (item.kind === "wait") {
    if (item.text === "sleep") {
      const ms = Number(item.target);
      if (!Number.isInteger(ms) || ms < 0 || ms > COMPUTER_WAIT_CAP_MS) {
        return { passed: false, reason: `wait is capped at ${COMPUTER_WAIT_CAP_MS} ms`, screen };
      }
      await new Promise((resolve) => setTimeout(resolve, ms));
      const seen = await session.readScreen();
      return { passed: true, reason: "", screen: seen };
    }
    const gate = selectorDecision(item.target);
    if (!gate.allow) return { passed: false, reason: gate.reason, screen };
    if (!session.waitFor) return { passed: false, reason: "browser cannot wait", screen };
    try {
      const next = await session.waitFor(item.target, 5000);
      return { passed: true, reason: "", screen: next };
    } catch (error) {
      const message = error instanceof Error ? error.message : "wait timed out";
      return { passed: false, reason: redact(message), screen };
    }
  }
  if (item.kind === "scroll") {
    if (item.text === "into-view") {
      const gate = selectorDecision(item.target);
      if (!gate.allow) return { passed: false, reason: gate.reason, screen };
      if (!session.scrollIntoView) return { passed: false, reason: "browser cannot scroll", screen };
      const next = await session.scrollIntoView(item.target);
      return { passed: true, reason: "", screen: next };
    }
    const delta = Number(item.target);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > COMPUTER_SCROLL_CAP_PX) {
      return { passed: false, reason: `scroll is capped at ${COMPUTER_SCROLL_CAP_PX} px`, screen };
    }
    if (!session.scrollBy) return { passed: false, reason: "browser cannot scroll", screen };
    const next = await session.scrollBy(delta);
    return { passed: true, reason: "", screen: next };
  }
  if (item.kind === "press") {
    const key = COMPUTER_PRESS_KEYS.find((name) => name.toLowerCase() === item.target.toLowerCase());
    if (!key) return { passed: false, reason: "key is not on the press allow list", screen };
    if (!session.press) return { passed: false, reason: "browser cannot press keys", screen };
    const next = await session.press(key);
    return { passed: true, reason: "", screen: next };
  }
  if (item.kind === "hover") {
    const gate = selectorDecision(item.target);
    if (!gate.allow) return { passed: false, reason: gate.reason, screen };
    if (!session.hover) return { passed: false, reason: "browser cannot hover", screen };
    try {
      const next = await session.hover(item.target, item.text === "text" ? "text" : "selector");
      return { passed: true, reason: "", screen: next };
    } catch (error) {
      const message = error instanceof Error ? error.message : "selector missing";
      return { passed: false, reason: redact(message), screen };
    }
  }
  if (item.kind === "double-click") {
    const gate = selectorDecision(item.target);
    if (!gate.allow) return { passed: false, reason: gate.reason, screen };
    if (!session.doubleClick) return { passed: false, reason: "browser cannot double-click", screen };
    try {
      const next = await session.doubleClick(item.target, item.text === "text" ? "text" : "selector");
      return { passed: true, reason: "", screen: next };
    } catch (error) {
      const message = error instanceof Error ? error.message : "selector missing";
      return { passed: false, reason: redact(message), screen };
    }
  }
  if (item.kind === "right-click") {
    const gate = selectorDecision(item.target);
    if (!gate.allow) return { passed: false, reason: gate.reason, screen };
    if (!session.rightClick) return { passed: false, reason: "browser cannot right-click", screen };
    try {
      const next = await session.rightClick(item.target, item.text === "text" ? "text" : "selector");
      return { passed: true, reason: "", screen: next };
    } catch (error) {
      const message = error instanceof Error ? error.message : "selector missing";
      return { passed: false, reason: redact(message), screen };
    }
  }
  if (item.kind === "fill") {
    const gate = selectorDecision(item.target);
    if (!gate.allow) return { passed: false, reason: gate.reason, screen };
    if (item.value === undefined) return { passed: false, reason: "fill text is missing", screen };
    if (!session.fill) return { passed: false, reason: "browser cannot fill", screen };
    try {
      const next = await session.fill(item.target, item.value, item.text === "text" ? "text" : "selector");
      return { passed: true, reason: "", screen: next };
    } catch (error) {
      const message = error instanceof Error ? error.message : "selector missing";
      return { passed: false, reason: redact(message), screen };
    }
  }
  if (item.kind === "select") {
    const gate = selectorDecision(item.target);
    if (!gate.allow) return { passed: false, reason: gate.reason, screen };
    if (!item.value) return { passed: false, reason: "option label is missing", screen };
    if (!session.selectOption) return { passed: false, reason: "browser cannot select", screen };
    try {
      const next = await session.selectOption(item.target, item.value, item.text === "text" ? "text" : "selector");
      return { passed: true, reason: "", screen: next };
    } catch (error) {
      const message = error instanceof Error ? error.message : "selector missing";
      return { passed: false, reason: redact(message), screen };
    }
  }
  if (item.kind === "check" || item.kind === "uncheck") {
    const gate = selectorDecision(item.target);
    if (!gate.allow) return { passed: false, reason: gate.reason, screen };
    const run = item.kind === "check" ? session.check : session.uncheck;
    if (!run) return { passed: false, reason: item.kind === "check" ? "browser cannot check" : "browser cannot uncheck", screen };
    try {
      const next = await run(item.target, item.text === "text" ? "text" : "selector");
      return { passed: true, reason: "", screen: next };
    } catch (error) {
      const message = error instanceof Error ? error.message : "selector missing";
      return { passed: false, reason: redact(message), screen };
    }
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
        async click(target, by) {
          const locator = by === "text" ? page.getByText(target, { exact: true }) : page.locator(target);
          await locator.click({ timeout: 5000 });
          return shot();
        },
        async navigate(nextUrl) {
          await page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
          return shot();
        },
        async waitFor(selector, timeoutMs) {
          await page.locator(selector).waitFor({ state: "visible", timeout: timeoutMs });
          return shot();
        },
        async scrollBy(deltaY) {
          await page.mouse.wheel(0, deltaY);
          return shot();
        },
        async scrollIntoView(selector) {
          await page.locator(selector).scrollIntoViewIfNeeded({ timeout: 5000 });
          return shot();
        },
        async press(key) {
          await page.keyboard.press(key);
          return shot();
        },
        async hover(target, by) {
          const locator = by === "text" ? page.getByText(target, { exact: true }) : page.locator(target);
          await locator.hover({ timeout: 5000 });
          return shot();
        },
        async doubleClick(target, by) {
          const locator = by === "text" ? page.getByText(target, { exact: true }) : page.locator(target);
          await locator.dblclick({ timeout: 5000 });
          return shot();
        },
        async rightClick(target, by) {
          const locator = by === "text" ? page.getByText(target, { exact: true }) : page.locator(target);
          await locator.click({ button: "right", timeout: 5000 });
          return shot();
        },
        async fill(target, value, by) {
          const locator = by === "text" ? page.getByText(target, { exact: true }) : page.locator(target);
          await locator.fill(value, { timeout: 5000 });
          return shot();
        },
        async selectOption(target, label, by) {
          const locator = by === "text" ? page.getByText(target, { exact: true }) : page.locator(target);
          await locator.selectOption({ label }, { timeout: 5000 });
          return shot();
        },
        async check(target, by) {
          const locator = by === "text" ? page.getByText(target, { exact: true }) : page.locator(target);
          await locator.check({ timeout: 5000 });
          return shot();
        },
        async uncheck(target, by) {
          const locator = by === "text" ? page.getByText(target, { exact: true }) : page.locator(target);
          await locator.uncheck({ timeout: 5000 });
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
