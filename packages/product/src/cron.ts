import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export const WEBHOOK_WINDOW_MS = 5 * 60 * 1000;

interface ParsedCron {
  minute: number[];
  hour: number[];
  day: number[];
  month: number[];
  weekday: number[];
  dayAny: boolean;
  weekdayAny: boolean;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

interface HookFile {
  secrets: Record<string, string>;
  replays: { stamp: string; at: number }[];
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONTH_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const formatters = new Map<string, Intl.DateTimeFormat>();
let hookChain: Promise<unknown> = Promise.resolve();

function withHooks<T>(work: () => Promise<T>): Promise<T> {
  const run = hookChain.then(work, work);
  hookChain = run.then(() => undefined, () => undefined);
  return run;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 80 || /[\s\\]/.test(timeZone)) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatters.set(timeZone, created);
  return created;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const bag: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  const hour = Number(bag.hour);
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    weekday: WEEKDAYS[bag.weekday ?? ""] ?? 0,
  };
}

function parseField(token: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of token.split(",")) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match || (match[1] === "*" && match[2] !== undefined)) throw new CronError("Cron fields must be numeric.");
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (!Number.isInteger(step) || step < 1) throw new CronError("Cron field is out of range.");
    const start = match[1] === "*" ? min : Number(match[1]);
    const end = match[2] !== undefined
      ? Number(match[2])
      : match[1] === "*" || match[3] !== undefined
        ? max
        : start;
    if (start < min || end > max || start > end) throw new CronError("Cron field is out of range.");
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new CronError("Cron field is out of range.");
  return [...values].sort((left, right) => left - right);
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError("Cron must be five fields: minute hour day month weekday.");
  const weekday = parseField(fields[4] ?? "", 0, 7).map((value) => (value === 7 ? 0 : value));
  return {
    minute: parseField(fields[0] ?? "", 0, 59),
    hour: parseField(fields[1] ?? "", 0, 23),
    day: parseField(fields[2] ?? "", 1, 31),
    month: parseField(fields[3] ?? "", 1, 12),
    weekday: [...new Set(weekday)].sort((left, right) => left - right),
    dayAny: fields[2] === "*",
    weekdayAny: fields[4] === "*",
  };
}

function dayMatches(parsed: ParsedCron, day: number, weekday: number): boolean {
  const dayOk = parsed.day.includes(day);
  const weekOk = parsed.weekday.includes(weekday);
  if (parsed.dayAny && parsed.weekdayAny) return true;
  if (parsed.dayAny) return weekOk;
  if (parsed.weekdayAny) return dayOk;
  return dayOk || weekOk;
}

function calendarCanMatch(parsed: ParsedCron): boolean {
  for (const month of parsed.month) {
    for (let day = 1; day <= (MONTH_DAYS[month] ?? 0); day += 1) {
      for (let weekday = 0; weekday < 7; weekday += 1) {
        if (dayMatches(parsed, day, weekday)) return true;
      }
    }
  }
  return false;
}

function nextMinuteStart(ms: number, timeZone: string): number {
  const parts = zonedParts(ms, timeZone);
  const into = parts.second * 1000 + (ms % 1000);
  const cursor = ms + (into === 0 ? 60_000 : 60_000 - into);
  const next = zonedParts(cursor, timeZone);
  const snapped = cursor - next.second * 1000 - (cursor % 1000);
  return snapped > ms ? snapped : cursor;
}

/** Next occurrence strictly after afterMs, in the given IANA timezone. */
export function nextCronRun(expression: string, timeZone: string, afterMs: number): number {
  if (!isValidTimeZone(timeZone)) throw new CronError("Timezone is not a known IANA name.");
  const parsed = parseCron(expression);
  if (!calendarCanMatch(parsed)) throw new CronError("That cron expression has no run in the next year.");
  const limit = afterMs + 366 * 24 * 60 * 60 * 1000;
  let cursor = afterMs;
  for (let step = 0; step < 400_000; step += 1) {
    const next = nextMinuteStart(cursor, timeZone);
    if (next <= cursor || next > limit) break;
    cursor = next;
    const parts = zonedParts(cursor, timeZone);
    if (
      parsed.minute.includes(parts.minute) &&
      parsed.hour.includes(parts.hour) &&
      parsed.month.includes(parts.month) &&
      dayMatches(parsed, parts.day, parts.weekday)
    ) return cursor;
  }
  throw new CronError("That cron expression has no run in the next year.");
}

export function followingRunAt(
  routine: { cron?: string; timezone?: string; everyMs?: number; nextRunAt?: number },
  now: number,
): number | undefined {
  if (routine.cron) {
    if (!routine.timezone) throw new CronError("A cron routine needs an IANA timezone.");
    return nextCronRun(routine.cron, routine.timezone, now);
  }
  if (Number.isInteger(routine.everyMs) && (routine.everyMs ?? 0) > 0) return now + (routine.everyMs ?? 0);
  return routine.nextRunAt;
}

function hookPath(root: string): string {
  return path.join(root, "routine-hooks.json");
}

async function readHookFile(root: string): Promise<HookFile> {
  try {
    const parsed = JSON.parse(await readFile(hookPath(root), "utf8")) as Partial<HookFile>;
    return {
      secrets: parsed.secrets && typeof parsed.secrets === "object" ? parsed.secrets : {},
      replays: Array.isArray(parsed.replays) ? parsed.replays.filter((item) => item && typeof item.stamp === "string" && typeof item.at === "number") : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { secrets: {}, replays: [] };
    throw new CronError("The webhook secret store could not be read.");
  }
}

async function writeHookFile(root: string, file: HookFile): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  const target = hookPath(root);
  await writeFile(target, `${JSON.stringify(file)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
}

export async function saveWebhookSecret(root: string, routineId: string, secret: string): Promise<void> {
  await withHooks(async () => {
    const file = await readHookFile(root);
    file.secrets[routineId] = secret;
    await writeHookFile(root, file);
  });
}

export async function readWebhookSecret(root: string, routineId: string): Promise<string | undefined> {
  return withHooks(async () => (await readHookFile(root)).secrets[routineId]);
}

export async function deleteWebhookSecret(root: string, routineId: string): Promise<void> {
  await withHooks(async () => {
    const file = await readHookFile(root);
    if (!file.secrets[routineId]) return;
    delete file.secrets[routineId];
    file.replays = file.replays.filter((item) => !item.stamp.startsWith(`${routineId}:`));
    await writeHookFile(root, file);
  });
}

export function newWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function signRoutineWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyRoutineWebhook(input: {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  nowMs: number;
}): { ok: boolean; reason: string } {
  if (!input.secret || !input.timestamp || !input.signature) return { ok: false, reason: "missing signature" };
  if (!/^\d{10,16}$/.test(input.timestamp)) return { ok: false, reason: "bad timestamp" };
  const sent = Number(input.timestamp);
  if (!Number.isFinite(sent) || Math.abs(input.nowMs - sent) > WEBHOOK_WINDOW_MS) return { ok: false, reason: "stale timestamp" };
  if (!/^[0-9a-f]{64}$/.test(input.signature)) return { ok: false, reason: "bad signature" };
  const expected = signRoutineWebhook(input.secret, input.timestamp, input.rawBody);
  const left = Buffer.from(expected);
  const right = Buffer.from(input.signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, reason: "bad signature" };
  return { ok: true, reason: "" };
}

/** Returns true when this exact signature was already accepted inside the time window. */
export async function consumeWebhookReplay(root: string, routineId: string, timestamp: string, signature: string, nowMs: number): Promise<boolean> {
  return withHooks(async () => {
    const file = await readHookFile(root);
    file.replays = file.replays.filter((item) => nowMs - item.at <= WEBHOOK_WINDOW_MS);
    const stamp = `${routineId}:${timestamp}:${signature}`;
    if (file.replays.some((item) => item.stamp === stamp)) {
      await writeHookFile(root, file);
      return true;
    }
    file.replays.push({ stamp, at: nowMs });
    await writeHookFile(root, file);
    return false;
  });
}
