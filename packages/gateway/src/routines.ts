import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { partnerIdDecision } from "./fleet.js";

export interface IntervalTrigger {
  kind: "interval";
  everyMs: number;
  nextRunAt: number;
}

export interface EventTrigger {
  kind: "event";
  name: string;
}

export interface Routine {
  id: string;
  partnerId: string;
  message: string;
  status: "active" | "paused";
  trigger: IntervalTrigger | EventTrigger;
}

function file(sessionRoot: string): string {
  return path.join(sessionRoot, ".ocp", "routines.json");
}

async function readRoutines(sessionRoot: string): Promise<Routine[]> {
  try {
    const body = JSON.parse(await readFile(file(sessionRoot), "utf8")) as { routines?: Routine[] };
    return Array.isArray(body.routines) ? body.routines : [];
  } catch {
    return [];
  }
}

async function writeRoutines(sessionRoot: string, routines: Routine[]): Promise<void> {
  await mkdir(path.join(sessionRoot, ".ocp"), { recursive: true });
  await writeFile(file(sessionRoot), `${JSON.stringify({ routines }, null, 2)}\n`);
}

export async function listRoutines(sessionRoot: string): Promise<Routine[]> {
  return readRoutines(sessionRoot);
}

export function formatRoutineList(routines: readonly Routine[]): string {
  if (routines.length === 0) return "Routines: none";
  return routines
    .map((routine) => {
      const when = routine.trigger.kind === "interval" ? `every ${routine.trigger.everyMs}ms` : `event ${routine.trigger.name}`;
      return `${routine.id} ${routine.status} partner ${routine.partnerId} ${when} ${routine.message}`;
    })
    .join("\n");
}

export async function createRoutine(
  sessionRoot: string,
  input: { partnerId: string; message: string; everyMs?: number; event?: string; now: number },
): Promise<Routine> {
  const decision = partnerIdDecision(input.partnerId);
  if (!decision.allow) throw new Error(decision.reason);
  const message = input.message.trim();
  if (!message) throw new Error("routine needs a message");
  const routines = await readRoutines(sessionRoot);
  const trigger: Routine["trigger"] = input.event
    ? { kind: "event", name: input.event.trim() }
    : { kind: "interval", everyMs: input.everyMs ?? 0, nextRunAt: input.now + (input.everyMs ?? 0) };
  if (trigger.kind === "interval" && (!Number.isInteger(trigger.everyMs) || trigger.everyMs < 1000)) {
    throw new Error("interval must be at least 1000 ms");
  }
  if (trigger.kind === "event" && !trigger.name) throw new Error("event needs a name");
  const routine: Routine = {
    id: `routine-${routines.length + 1}`,
    partnerId: input.partnerId,
    message,
    status: "active",
    trigger,
  };
  routines.push(routine);
  await writeRoutines(sessionRoot, routines);
  return routine;
}

async function setStatus(sessionRoot: string, id: string, status: "active" | "paused"): Promise<Routine> {
  const routines = await readRoutines(sessionRoot);
  const routine = routines.find((item) => item.id === id);
  if (!routine) throw new Error("routine not found");
  routine.status = status;
  await writeRoutines(sessionRoot, routines);
  return routine;
}

export function pauseRoutine(sessionRoot: string, id: string): Promise<Routine> {
  return setStatus(sessionRoot, id, "paused");
}

export function resumeRoutine(sessionRoot: string, id: string): Promise<Routine> {
  return setStatus(sessionRoot, id, "active");
}

/** Run due interval routines. Each one becomes a partner turn. */
export async function fireDueRoutines(
  sessionRoot: string,
  now: number,
  run: (routine: Routine) => Promise<string>,
): Promise<string[]> {
  const routines = await readRoutines(sessionRoot);
  const replies: string[] = [];
  for (const routine of routines) {
    if (routine.status !== "active" || routine.trigger.kind !== "interval") continue;
    if (routine.trigger.nextRunAt > now) continue;
    replies.push(await run(routine));
    routine.trigger.nextRunAt = now + routine.trigger.everyMs;
  }
  await writeRoutines(sessionRoot, routines);
  return replies;
}

function routineShape(value: unknown): value is Routine {
  if (!value || typeof value !== "object") return false;
  const routine = value as Routine;
  if (routine.status !== "active" && routine.status !== "paused") return false;
  if (!routine.trigger || typeof routine.trigger !== "object") return false;
  if (routine.trigger.kind === "interval") {
    return Number.isInteger(routine.trigger.everyMs) && Number.isFinite(routine.trigger.nextRunAt);
  }
  if (routine.trigger.kind === "event") return typeof routine.trigger.name === "string";
  return false;
}

/** Count routines for doctor. This does not run one and does not print its message. */
export async function doctorRoutineLine(sessionRoot: string, now = Date.now()): Promise<string> {
  const tail = "This check does not run a routine and does not print its message.";
  let raw: string;
  try {
    raw = await readFile(file(sessionRoot), "utf8");
  } catch {
    return `green Routines: none. ${tail}`;
  }
  let routines: unknown[];
  try {
    const body = JSON.parse(raw) as { routines?: unknown };
    if (!Array.isArray(body.routines)) return `yellow Routines: the file could not be read. ${tail}`;
    routines = body.routines;
  } catch {
    return `yellow Routines: the file could not be read. ${tail}`;
  }
  if (routines.length === 0) return `green Routines: none. ${tail}`;
  const parsed = routines.filter(routineShape);
  if (parsed.length !== routines.length) return `yellow Routines: the file could not be read. ${tail}`;
  let active = 0;
  let paused = 0;
  let due = 0;
  for (const routine of parsed) {
    if (routine.status === "paused") {
      paused += 1;
      continue;
    }
    active += 1;
    if (routine.trigger.kind === "interval" && routine.trigger.nextRunAt <= now) due += 1;
  }
  const bits: string[] = [];
  if (active > 0) bits.push(`${active} active`);
  if (paused > 0) bits.push(`${paused} paused`);
  if (due > 0) bits.push(`${due} due`);
  return `${active > 0 ? "yellow" : "green"} Routines: ${bits.join(", ")}. ${tail}`;
}

/** Run active routines waiting on this event name. */
export async function fireEvent(
  sessionRoot: string,
  name: string,
  run: (routine: Routine) => Promise<string>,
): Promise<string[]> {
  const routines = await readRoutines(sessionRoot);
  const replies: string[] = [];
  for (const routine of routines) {
    if (routine.status !== "active" || routine.trigger.kind !== "event") continue;
    if (routine.trigger.name !== name) continue;
    replies.push(await run(routine));
  }
  return replies;
}
