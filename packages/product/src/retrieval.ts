import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { securityGate } from "@opencodingpartner/workers";
import { estimateTokens } from "./context.js";

/**
 * Local retrieval over workspace files, task history, and memory.
 * Similarity is a hashed word n-gram vector (hashing trick). It is not a neural model
 * and it does not call a hosted embeddings API.
 */
const DIM = 256;
const DEFAULT_K = 4;
const MIN_SCORE = 0.2;
const MAX_FILES = 300;
const MAX_FILE_BYTES = 80_000;
const CHUNK_CHARS = 480;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "gtm", "build", ".next"]);
const TEXT_EXT = new Set(["ts", "tsx", "js", "mjs", "cjs", "json", "md", "txt", "css", "html", "yml", "yaml", "toml", "rs", "go", "py", "sh"]);
const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "are", "was", "were", "has", "have", "you", "your", "into", "then", "than"]);

export interface RetrievalDoc {
  source: "repo" | "memory" | "history";
  label: string;
  text: string;
  startLine?: number;
}

export interface RetrievalHit {
  source: RetrievalDoc["source"];
  label: string;
  text: string;
  startLine?: number;
  score: number;
}

const FILLER = "Warehouse aisle inventory count remains steady across the morning shift. ";

export const RETRIEVAL_REPLAY_QUERY = "Fix the hunk mismatch in packages/product/src/server.ts. Replies stay drafts until a person sends them.";

export function retrievalReplayDocs(): RetrievalDoc[] {
  const relevant: RetrievalDoc[] = [
    {
      source: "repo",
      label: "packages/product/src/server.ts",
      startLine: 12,
      text: "Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match.\nThe hunk mismatch is in packages/product/src/server.ts.",
    },
    {
      source: "memory",
      label: "MEMORY.md",
      text: "Decision: replies stay drafts until a person sends them.",
    },
    {
      source: "history",
      label: "task-9",
      text: "Error: workspace_patch failed in packages/product/src/server.ts: hunk did not match. Decision: keep the draft reply in the app.",
    },
  ];
  const filler = Array.from({ length: 24 }, (_, index) => ({
    source: "repo" as const,
    label: `notes/aisle-${index}.txt`,
    startLine: 1,
    text: FILLER.repeat(12),
  }));
  return [...relevant, ...filler];
}

export function searchHashedIndex(docs: RetrievalDoc[], query: string, k = DEFAULT_K): RetrievalHit[] {
  const queryVector = hashedVector(query);
  if (normOf(queryVector) === 0) return [];
  const hits: RetrievalHit[] = [];
  for (const doc of docs) {
    const score = cosine(queryVector, hashedVector(doc.text));
    if (score < MIN_SCORE) continue;
    hits.push({
      source: doc.source,
      label: doc.label,
      text: doc.text,
      startLine: doc.startLine,
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return hits.slice(0, Math.max(1, k));
}

export function formatRetrieved(hits: RetrievalHit[]): string {
  if (hits.length === 0) return "";
  const lines = ["Retrieved snippets from the local hashed n-gram index (not a neural model)."];
  for (const hit of hits) {
    const where = hit.startLine ? `${hit.label}:${hit.startLine}` : hit.label;
    lines.push(`[${hit.source}] ${where}`);
    lines.push(hit.text.trim());
  }
  return lines.join("\n");
}

export function replayRetrievalTokens(): {
  beforeEstimated: number;
  afterEstimated: number;
  hits: RetrievalHit[];
  formatted: string;
} {
  const docs = retrievalReplayDocs();
  const hits = searchHashedIndex(docs, RETRIEVAL_REPLAY_QUERY, DEFAULT_K);
  const stuffed = docs.map((doc) => `${doc.source} ${doc.label}\n${doc.text}`).join("\n");
  const formatted = formatRetrieved(hits);
  return {
    beforeEstimated: estimateTokens(stuffed),
    afterEstimated: estimateTokens(formatted),
    hits,
    formatted,
  };
}

export async function workspaceMemoryFile(dataDir: string, workspace: string): Promise<string> {
  const root = await realpath(path.resolve(workspace));
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(dataDir, "memories", hash, "MEMORY.md");
}

export async function retrieveWorkspaceSnippets(input: {
  workspace: string;
  dataDir?: string;
  query: string;
  k?: number;
}): Promise<string> {
  const docs = await collectRetrievalDocs(input.workspace, input.dataDir);
  return formatRetrieved(searchHashedIndex(docs, input.query, input.k ?? DEFAULT_K));
}

async function collectRetrievalDocs(workspace: string, dataDir?: string): Promise<RetrievalDoc[]> {
  let root: string;
  try {
    root = await realpath(path.resolve(workspace));
  } catch {
    return [];
  }
  const docs: RetrievalDoc[] = [];
  await walkRepo(root, root, docs, { files: 0 });
  if (dataDir) {
    const memory = await readFile(await workspaceMemoryFile(dataDir, root), "utf8").catch(() => "");
    for (const line of memory.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("- ")) continue;
      docs.push({ source: "memory", label: "MEMORY.md", text: trimmed.replace(/^- /, "").trim() });
    }
    docs.push(...await historyDocs(dataDir, root));
  }
  return docs;
}

async function historyDocs(dataDir: string, root: string): Promise<RetrievalDoc[]> {
  let parsed: {
    bots?: Array<{ id?: string; workspace?: string }>;
    tasks?: Array<{ id?: string; botId?: string; prompt?: string; result?: string; error?: string }>;
  };
  try {
    parsed = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8")) as typeof parsed;
  } catch {
    return [];
  }
  const botIds = new Set<string>();
  for (const bot of parsed.bots ?? []) {
    if (!bot.id || !bot.workspace) continue;
    let botRoot = path.resolve(bot.workspace);
    try { botRoot = await realpath(botRoot); } catch { /* use the resolved path */ }
    if (botRoot === root) botIds.add(bot.id);
  }
  const docs: RetrievalDoc[] = [];
  for (const task of parsed.tasks ?? []) {
    if (!task.id || !task.botId || !botIds.has(task.botId)) continue;
    const text = [task.error, task.result, task.prompt]
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join("\n")
      .slice(0, 800);
    if (!text) continue;
    docs.push({ source: "history", label: `task-${task.id}`, text });
    if (docs.length >= 50) break;
  }
  return docs;
}

async function walkRepo(dir: string, root: string, docs: RetrievalDoc[], state: { files: number }): Promise<void> {
  if (state.files >= MAX_FILES) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (state.files >= MAX_FILES) return;
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkRepo(full, root, docs, state);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).slice(1).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    const info = await stat(full).catch(() => undefined);
    if (!info || info.size > MAX_FILE_BYTES) continue;
    const text = await readFile(full, "utf8").catch(() => "");
    if (!text || text.includes("\0")) continue;
    const relative = path.relative(root, full).replaceAll("\\", "/");
    if (!securityGate({ relativePath: relative, content: text.slice(0, 20_000), sandboxRoot: root }).allow) continue;
    for (const chunk of chunkText(text)) {
      docs.push({ source: "repo", label: relative, text: chunk.text, startLine: chunk.startLine });
    }
    state.files += 1;
  }
}

function chunkText(text: string): Array<{ text: string; startLine: number }> {
  const lines = text.split("\n");
  const chunks: Array<{ text: string; startLine: number }> = [];
  let buffer: string[] = [];
  let chars = 0;
  let startLine = 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    buffer.push(line);
    chars += line.length + 1;
    if (chars >= CHUNK_CHARS) {
      chunks.push({ text: buffer.join("\n"), startLine });
      buffer = [];
      chars = 0;
      startLine = index + 2;
    }
  }
  if (buffer.some((line) => line.trim())) chunks.push({ text: buffer.join("\n"), startLine });
  return chunks;
}

function hashedVector(text: string): Float64Array {
  const vector = new Float64Array(DIM);
  const words = tokens(text);
  for (let index = 0; index < words.length; index += 1) {
    addGram(vector, words[index] ?? "");
    if (index + 1 < words.length) addGram(vector, `${words[index]} ${words[index + 1]}`);
  }
  const norm = normOf(vector);
  if (norm === 0) return vector;
  for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] ?? 0) / norm;
  return vector;
}

function addGram(vector: Float64Array, gram: string): void {
  if (!gram) return;
  const hash = fnv1a(gram);
  const bucket = hash % DIM;
  const sign = (fnv1a(`${gram}#`) & 1) === 0 ? 1 : -1;
  vector[bucket] = (vector[bucket] ?? 0) + sign;
}

function cosine(left: Float64Array, right: Float64Array): number {
  let dot = 0;
  for (let index = 0; index < DIM; index += 1) dot += (left[index] ?? 0) * (right[index] ?? 0);
  return dot;
}

function normOf(vector: Float64Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? []).filter((token) => !STOP.has(token));
}

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
