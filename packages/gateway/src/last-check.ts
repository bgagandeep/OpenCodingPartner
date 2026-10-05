import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { commandDecision, securityGate } from "@opencodingpartner/workers";
import { readPartnerIdentity } from "./fleet.js";

const CHECK_FILE = path.join(".ocp", "last-check.json");

export function lastCheckKind(argv: readonly string[]): string | undefined {
  const [bin, sub] = argv;
  if (bin === "node" && sub === "--test") return "node --test";
  if (bin === "pnpm" && sub === "test") return "pnpm test";
  if (bin === "tsc" && sub === "--noEmit") return "tsc --noEmit";
  return undefined;
}

/** Store the exit code and command kind. Output is not stored. */
export async function recordLastCheck(sandboxRoot: string, argv: readonly string[], code: number): Promise<void> {
  const kind = lastCheckKind(argv);
  if (!kind || !Number.isInteger(code)) return;
  await mkdir(path.join(sandboxRoot, ".ocp"), { recursive: true });
  await writeFile(path.join(sandboxRoot, CHECK_FILE), `${JSON.stringify({ code, kind })}\n`);
}

async function readLastCheck(sandboxRoot: string): Promise<{ code: number; kind: string } | "missing" | "unreadable"> {
  let raw: string;
  try {
    raw = await readFile(path.join(sandboxRoot, CHECK_FILE), "utf8");
  } catch {
    return "missing";
  }
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; kind?: unknown };
    if (!Number.isInteger(parsed.code) || (parsed.kind !== "node --test" && parsed.kind !== "pnpm test" && parsed.kind !== "tsc --noEmit")) {
      return "unreadable";
    }
    return { code: parsed.code as number, kind: parsed.kind };
  } catch {
    return "unreadable";
  }
}

/** Doctor line for the last coding check. This does not run it and does not print its output. */
export async function doctorLastCheckLine(sessionRoot: string): Promise<string> {
  const tail = "This check does not run a command and does not print its output.";
  const bits: string[] = [];
  const session = await readLastCheck(sessionRoot);
  if (session === "unreadable") return `yellow Last check: this session file could not be read. ${tail}`;
  if (session !== "missing") bits.push(`session ${session.kind} exit ${session.code}`);
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
  let failed = session !== "missing" && session.code !== 0;
  for (const partner of partners) {
    const check = await readLastCheck(partner.workspace);
    if (check === "unreadable") return `yellow Last check: ${partner.id} file could not be read. ${tail}`;
    if (check === "missing") continue;
    bits.push(`${partner.id} ${check.kind} exit ${check.code}`);
    if (check.code !== 0) failed = true;
  }
  if (bits.length === 0) return `green Last check: none. ${tail}`;
  return `${failed ? "yellow" : "green"} Last check: ${bits.join(". ")}. ${tail}`;
}

const CHECK_ARGV: Record<string, readonly string[]> = {
  node: ["node", "--test"],
  pnpm: ["pnpm", "test"],
  tsc: ["tsc", "--noEmit"],
};

const OUTPUT_CAP = 2000;

/** `node`, `pnpm`, or `tsc`. Anything else is refused. */
export function allowedCheckArgv(name: string): readonly string[] | undefined {
  return CHECK_ARGV[name];
}

export interface AllowedCheckResult {
  ok: boolean;
  code: number;
  detail: string;
}

/** Run one allowlisted check in this sandbox. The file stores the exit code and kind only. */
export async function runAllowedCheck(sandboxRoot: string, name: string): Promise<AllowedCheckResult> {
  const argv = allowedCheckArgv(name);
  if (!argv || !commandDecision([...argv]).allow) {
    return { ok: false, code: 2, detail: "Usage: ocp check [--sandbox .sandbox] [--partner name] [node|pnpm|tsc]" };
  }
  const kind = lastCheckKind(argv) ?? name;
  const result = await spawnCheck(argv, sandboxRoot);
  if (result.missing) {
    return { ok: false, code: 1, detail: `${kind} did not run.` };
  }
  await recordLastCheck(sandboxRoot, argv, result.code);
  const output = redactCheckOutput(capCheckOutput(result.stderr || result.stdout));
  const detail = output ? `${kind} exit ${result.code}\n${output}` : `${kind} exit ${result.code}`;
  return { ok: result.code === 0, code: result.code === 0 ? 0 : 1, detail };
}

function capCheckOutput(text: string): string {
  if (text.length <= OUTPUT_CAP) return text.trim();
  return `${text.slice(0, OUTPUT_CAP).trim()}\n(truncated)`;
}

function redactCheckOutput(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => {
      const gate = securityGate({ relativePath: "check.txt", content: line, sandboxRoot: "." });
      return gate.reasons.includes("secret pattern") ? "[redacted]" : line;
    })
    .join("\n");
}

function spawnCheck(argv: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { code: number; stdout: string; stderr: string; missing: boolean }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("NODE_TEST") || key.startsWith("NODE_CHANNEL")) delete env[key];
    }
    const child = spawn(argv[0] ?? "node", argv.slice(1), { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
    }, 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish({ code: 127, stdout, stderr, missing: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code: code ?? 1, stdout, stderr, missing: false });
    });
  });
}
