import { readFile } from "node:fs/promises";
import path from "node:path";

/** Design-only pack. The core stays open. Billing never charges. */
export interface Packaging {
  plan: "oss";
  seats: number;
  credits: number;
  billing: "inert";
  core: "full";
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

export async function readPackaging(sandboxRoot: string): Promise<Packaging> {
  let seats = 1;
  let credits = 0;
  try {
    const body = JSON.parse(await readFile(path.join(sandboxRoot, ".ocp", "settings.json"), "utf8")) as {
      packaging?: { seats?: unknown; credits?: unknown };
    };
    seats = count(body.packaging?.seats, 1);
    credits = count(body.packaging?.credits, 0);
  } catch {
    // Missing settings still mean the free core.
  }
  return { plan: "oss", seats, credits, billing: "inert", core: "full" };
}

/** Seats, credits, and any billing key do not close the core. */
export function coreIsOpen(_packaging: Packaging): boolean {
  return true;
}

export function formatPackaging(packaging: Packaging): string {
  return [
    "Packaging: free OSS core",
    `Seats: ${packaging.seats} (design only)`,
    `Credits: ${packaging.credits} (design only)`,
    "Billing: inert",
    "Core: full",
    "No charge is made.",
  ].join("\n");
}
