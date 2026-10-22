export interface PinnedNotes {
  facts: string[];
  decisions: string[];
  todos: string[];
}

export interface ContextTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface RolledContext {
  summary: string;
  recent: ContextTurn[];
  pinned: PinnedNotes;
  /** Estimated with characters / 4. Not a provider token count. */
  estimatedTokens: number;
  summarySource: "model" | "extractive" | "none";
}

const EMPTY_PINS: PinnedNotes = { facts: [], decisions: [], todos: [] };

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function emptyPins(): PinnedNotes {
  return { facts: [], decisions: [], todos: [] };
}

export function takePins(text: string, pinned: PinnedNotes = EMPTY_PINS): { text: string; pinned: PinnedNotes } {
  const next = clonePins(pinned);
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const fact = /^pin fact:\s*(.+)$/i.exec(line.trim());
    const decision = /^pin decision:\s*(.+)$/i.exec(line.trim());
    const todo = /^pin todo:\s*(.+)$/i.exec(line.trim());
    if (fact) pushUnique(next.facts, fact[1] ?? "");
    else if (decision) pushUnique(next.decisions, decision[1] ?? "");
    else if (todo) pushUnique(next.todos, todo[1] ?? "");
    else kept.push(line);
  }
  return { text: kept.join("\n").trim(), pinned: next };
}

export function splitRecent<T extends { content?: string | null }>(turns: T[], budgetTokens: number): { older: T[]; recent: T[] } {
  if (turns.length === 0) return { older: [], recent: [] };
  const recent: T[] = [];
  let tokens = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    const cost = estimateTokens(turn.content ?? "");
    if (recent.length > 0 && tokens + cost > budgetTokens) break;
    recent.unshift(turn);
    tokens += cost;
  }
  return { older: turns.slice(0, turns.length - recent.length), recent };
}

export async function rollContext(input: {
  turns: ContextTurn[];
  budgetTokens: number;
  pinned?: PinnedNotes;
  previousSummary?: string;
  writeSummary?: (prompt: string) => Promise<string | undefined>;
}): Promise<RolledContext> {
  const pinned = clonePins(input.pinned ?? EMPTY_PINS);
  const { older, recent } = splitRecent(input.turns, input.budgetTokens);
  let summary = input.previousSummary?.trim() ?? "";
  let summarySource: RolledContext["summarySource"] = summary ? "model" : "none";
  if (older.length > 0) {
    const folded = await summarizeTurns(older, summary, input.writeSummary);
    summary = folded.summary;
    summarySource = folded.summarySource;
  }
  const pinnedText = formatPins(pinned);
  const estimatedTokens = estimateTokens([summary, pinnedText, ...recent.map((turn) => turn.content)].join("\n"));
  return { summary, recent, pinned, estimatedTokens, summarySource };
}

export async function summarizeTurns(
  turns: ContextTurn[],
  previousSummary = "",
  writeSummary?: (prompt: string) => Promise<string | undefined>,
): Promise<{ summary: string; summarySource: RolledContext["summarySource"] }> {
  const previous = previousSummary.trim();
  if (turns.length === 0) return { summary: previous, summarySource: previous ? "model" : "none" };
  const drafted = writeSummary ? (await writeSummary(summaryPrompt(turns, previous)))?.trim() : undefined;
  const summary = preserveFaithfulDetails(turns, drafted || extractiveSummary(turns, previous));
  return { summary, summarySource: drafted ? "model" : "extractive" };
}

export function formatPins(pinned: PinnedNotes): string {
  const lines = [
    ...pinned.facts.map((item) => `Fact: ${item}`),
    ...pinned.decisions.map((item) => `Decision: ${item}`),
    ...pinned.todos.map((item) => `Todo: ${item}`),
  ];
  return lines.join("\n");
}

export function faithfulDetails(turns: ContextTurn[]): string[] {
  const found: string[] = [];
  for (const turn of turns) {
    for (const match of turn.content.matchAll(/(?:^|[\s`'"(])((?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,8})/g)) {
      pushUnique(found, match[1] ?? "");
    }
    for (const line of turn.content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length > 300) continue;
      if (/\b(error|exception|failed)\b/i.test(trimmed) || /\b(decision|decided)\b/i.test(trimmed)) {
        pushUnique(found, trimmed);
      }
    }
  }
  return found.slice(0, 40);
}

function preserveFaithfulDetails(older: ContextTurn[], summary: string): string {
  const missing = faithfulDetails(older).filter((item) => !summary.includes(item));
  if (missing.length === 0) return summary;
  return `${summary}\n\nKept from earlier turns:\n${missing.map((item) => `- ${item}`).join("\n")}`;
}

function extractiveSummary(older: ContextTurn[], previous: string): string {
  const head = older.map((turn) => `${turn.role}: ${turn.content}`).join("\n").slice(0, 500);
  return [previous, "Extractive summary (no summary model configured).", head].filter(Boolean).join("\n\n");
}

function summaryPrompt(older: ContextTurn[], previous: string): string {
  return [
    "Summarize earlier coding turns.",
    "Keep every file path, error, and decision verbatim.",
    previous ? `Previous summary:\n${previous}` : "",
    older.map((turn) => `${turn.role}: ${turn.content}`).join("\n\n"),
  ].filter(Boolean).join("\n\n");
}

function clonePins(pinned: PinnedNotes): PinnedNotes {
  return {
    facts: [...pinned.facts],
    decisions: [...pinned.decisions],
    todos: [...pinned.todos],
  };
}

function pushUnique(list: string[], value: string): void {
  const trimmed = value.trim();
  if (!trimmed || list.includes(trimmed)) return;
  list.push(trimmed);
}
