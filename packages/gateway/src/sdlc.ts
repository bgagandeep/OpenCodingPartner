import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRole } from "@opencodingpartner/mesh";

/** One coding worker may stand up while a review hold is on disk. */
export const REVIEW_HOLD_CODING_CAP = 1;

const SDLC = path.join(".ocp", "sdlc");

export function sdlcPath(sandboxRoot: string, name: string): string {
  return path.join(sandboxRoot, SDLC, name);
}

export async function partnerAgreementOn(sandboxRoot: string): Promise<boolean> {
  try {
    await readFile(path.join(sandboxRoot, "PARTNER.md"), "utf8");
    return true;
  } catch {
    return false;
  }
}

export interface ApproveCard {
  id: string;
  kind: "plan" | "computer";
  title: string;
  detail: string;
  status: "pending" | "approved" | "denied" | "redirected";
  redirect?: string;
}

export function acceptsPlan(message: string): boolean {
  return approveVerb(message) === "approve";
}

/** `approve` and `accept the plan` approve. `deny` and `redirect:` decide the card. */
export function approveVerb(message: string): "approve" | "deny" | "redirect" | undefined {
  const text = message.trim();
  if (/^deny\b/i.test(text)) return "deny";
  if (/^redirect\b/i.test(text)) return "redirect";
  if (/^approve\b/i.test(text) || /accept the plan/i.test(text)) return "approve";
  return undefined;
}

export function redirectNote(message: string): string {
  return message.replace(/^redirect:?\s*/i, "").trim().slice(0, 2000);
}

export async function planIsAccepted(sandboxRoot: string): Promise<boolean> {
  try {
    const body = JSON.parse(await readFile(sdlcPath(sandboxRoot, "plan.json"), "utf8")) as { accepted?: boolean };
    return body.accepted === true;
  } catch {
    return false;
  }
}

export async function reviewHoldOn(sandboxRoot: string): Promise<boolean> {
  try {
    await readFile(sdlcPath(sandboxRoot, "review-hold"), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Drop extra coding roles while a review hold is active. Other roles stay. */
export function rolesUnderReviewHold(roles: readonly AgentRole[]): AgentRole[] {
  let coding = 0;
  return roles.filter((role) => {
    if (role !== "coding") return true;
    coding += 1;
    return coding <= REVIEW_HOLD_CODING_CAP;
  });
}

/** Write intent, spec, and a plan. Edits stay off until a later message accepts the plan. */
export async function writePlanChain(sandboxRoot: string, message: string): Promise<void> {
  const dir = path.join(sandboxRoot, SDLC);
  await mkdir(dir, { recursive: true });
  const intent = message.replace(/\s+/g, " ").trim().slice(0, 2000);
  await writeFile(path.join(dir, "intent.md"), `${intent}\n`);
  await writeFile(path.join(dir, "spec.md"), `Do this in the sandbox: ${intent}\n`);
  await writeFile(
    path.join(dir, "plan.md"),
    "1. Read the sandbox.\n2. Edit only after this plan is accepted.\n3. Run node --test in the sandbox.\n4. QA reviews the files and the check. A human reviews intent and risk.\n",
  );
  await writeFile(path.join(dir, "plan.json"), `${JSON.stringify({ accepted: false, check: ["node", "--test"] }, null, 2)}\n`);
  await queuePlanCard(sandboxRoot, intent);
}

function approvalsFile(sandboxRoot: string): string {
  return path.join(sandboxRoot, ".ocp", "approvals.json");
}

async function readCards(sandboxRoot: string): Promise<ApproveCard[]> {
  try {
    const body = JSON.parse(await readFile(approvalsFile(sandboxRoot), "utf8")) as { cards?: ApproveCard[] };
    return Array.isArray(body.cards) ? body.cards : [];
  } catch {
    return [];
  }
}

async function writeCards(sandboxRoot: string, cards: ApproveCard[]): Promise<void> {
  await mkdir(path.join(sandboxRoot, ".ocp"), { recursive: true });
  await writeFile(approvalsFile(sandboxRoot), `${JSON.stringify({ cards }, null, 2)}\n`);
}

/** One pending plan card. A new plan updates that card instead of stacking duplicates. */
export async function queuePlanCard(sandboxRoot: string, detail: string): Promise<ApproveCard> {
  const cards = await readCards(sandboxRoot);
  const pending = cards.find((card) => card.kind === "plan" && card.status === "pending");
  if (pending) {
    pending.detail = detail;
    await writeCards(sandboxRoot, cards);
    return pending;
  }
  const card: ApproveCard = {
    id: `plan-${cards.length + 1}`,
    kind: "plan",
    title: "Edit after this plan",
    detail,
    status: "pending",
  };
  cards.push(card);
  await writeCards(sandboxRoot, cards);
  return card;
}

export async function pendingPlanCard(sandboxRoot: string): Promise<ApproveCard | undefined> {
  const cards = await readCards(sandboxRoot);
  return cards.find((card) => card.kind === "plan" && card.status === "pending");
}

/** One pending computer card. Starting the browser waits on this card. */
export async function queueComputerCard(sandboxRoot: string, detail: string): Promise<ApproveCard> {
  const cards = await readCards(sandboxRoot);
  const pending = cards.find((card) => card.kind === "computer" && card.status === "pending");
  if (pending) {
    pending.detail = detail;
    await writeCards(sandboxRoot, cards);
    return pending;
  }
  const card: ApproveCard = {
    id: `computer-${cards.length + 1}`,
    kind: "computer",
    title: "Start the sandbox browser",
    detail,
    status: "pending",
  };
  cards.push(card);
  await writeCards(sandboxRoot, cards);
  return card;
}

export async function decidePlanCard(
  sandboxRoot: string,
  status: "approved" | "denied" | "redirected",
  redirect?: string,
): Promise<ApproveCard | undefined> {
  const cards = await readCards(sandboxRoot);
  const pending = cards.find((card) => card.status === "pending");
  if (!pending) return undefined;
  pending.status = status;
  if (redirect) pending.redirect = redirect;
  await writeCards(sandboxRoot, cards);
  return pending;
}

export async function formatApproveCards(sandboxRoot: string): Promise<string> {
  const cards = await readCards(sandboxRoot);
  if (cards.length === 0) return "";
  return cards
    .map((card) => `Approve card ${card.id} ${card.status}\n${card.title}\n${card.detail}${card.redirect ? `\nRedirect: ${card.redirect}` : ""}`)
    .join("\n");
}

/** `PARTNER.rules` at the sandbox root, then `.ocp/rules`. Both apply. */
export async function loadPartnerRules(sandboxRoot: string): Promise<string> {
  const parts: string[] = [];
  for (const relative of ["PARTNER.rules", path.join(".ocp", "rules")]) {
    try {
      const text = (await readFile(path.join(sandboxRoot, relative), "utf8")).trim();
      if (text) parts.push(text);
    } catch {
      // That rules file is optional.
    }
  }
  return parts.join("\n");
}

/** A `block:` line stops the request when the message contains that text. */
export function partnerRuleBlock(rules: string, message: string): string | undefined {
  for (const line of rules.split("\n")) {
    const match = line.match(/^block:\s*(.+)$/i);
    const text = match?.[1]?.trim();
    if (text && message.includes(text)) return text;
  }
  return undefined;
}

export async function acceptPlan(sandboxRoot: string): Promise<boolean> {
  const file = sdlcPath(sandboxRoot, "plan.json");
  let body: { accepted?: boolean; check?: string[] };
  try {
    body = JSON.parse(await readFile(file, "utf8")) as { accepted?: boolean; check?: string[] };
  } catch {
    return false;
  }
  body.accepted = true;
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
  await rm(sdlcPath(sandboxRoot, "review-hold"), { force: true });
  return true;
}

export async function returnToIntent(sandboxRoot: string, reason: string): Promise<void> {
  const dir = path.join(sandboxRoot, SDLC);
  await mkdir(dir, { recursive: true });
  let prior = "";
  try {
    prior = await readFile(path.join(dir, "intent.md"), "utf8");
  } catch {
    prior = "";
  }
  await writeFile(path.join(dir, "intent.md"), `${prior}Returned from review: ${reason}\n`);
  const file = path.join(dir, "plan.json");
  try {
    const body = JSON.parse(await readFile(file, "utf8")) as { accepted?: boolean; check?: string[] };
    body.accepted = false;
    await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
  } catch {
    await writeFile(file, `${JSON.stringify({ accepted: false, check: ["node", "--test"] }, null, 2)}\n`);
  }
  await writeFile(path.join(dir, "review-hold"), `${reason}\n`);
}

export async function writeReviewSplit(sandboxRoot: string, mechanical: string): Promise<void> {
  const dir = path.join(sandboxRoot, SDLC);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "review.md"),
    `Mechanical review: ${mechanical}\nHuman intent and risk: decided on the Approve card before the edit. QA does not decide intent.\n`,
  );
}

export async function acceptedPlanText(sandboxRoot: string): Promise<string> {
  try {
    return await readFile(sdlcPath(sandboxRoot, "plan.md"), "utf8");
  } catch {
    return "";
  }
}
