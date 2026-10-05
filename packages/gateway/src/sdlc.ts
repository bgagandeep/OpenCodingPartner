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

export function acceptsPlan(message: string): boolean {
  return /accept the plan/i.test(message);
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
    `Mechanical review: ${mechanical}\nHuman intent and risk: not decided. There is no approve card yet.\n`,
  );
}

export async function acceptedPlanText(sandboxRoot: string): Promise<string> {
  try {
    return await readFile(sdlcPath(sandboxRoot, "plan.md"), "utf8");
  } catch {
    return "";
  }
}
