import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export class SkillError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface SkillRecord {
  id: string;
  name: string;
  whenToUse: string;
  body: string;
  builtin: boolean;
}

const STARTERS: Array<Omit<SkillRecord, "id">> = [
  {
    name: "Review a diff",
    whenToUse: "Review a code change before a person opens a pull request.",
    builtin: true,
    body: [
      "1. Read the diff and name the behavior that changed.",
      "2. Run the tests that cover that behavior. Quote the pass or fail output.",
      "3. List risks, missing tests, and anything a person should decide.",
      "4. Stop. Do not merge and do not claim the change is shipped.",
    ].join("\n"),
  },
  {
    name: "Reproduce a bug",
    whenToUse: "A bug report needs a failing test before any fix.",
    builtin: true,
    body: [
      "1. Restate the bug in one sentence.",
      "2. Add the smallest test that fails for that reason.",
      "3. Run that test and keep the failure output.",
      "4. If the test passes, stop and say the bug was not reproduced.",
    ].join("\n"),
  },
  {
    name: "Explain a change",
    whenToUse: "Summarize a local change for a person who will decide whether to ship it.",
    builtin: true,
    body: [
      "1. List the files that changed.",
      "2. Say what a person can do now that they could not do before.",
      "3. Say which tests ran and what they reported.",
      "4. Name anything still untested. Do not invent a result.",
    ].join("\n"),
  },
];

const NAME_LIMIT = 80;
const WHEN_LIMIT = 300;
const BODY_LIMIT = 20_000;
const PACK_LIMIT = 40;

function skillsRoot(root: string): string {
  return path.join(root, "skills");
}

function fieldValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed.replace(/^"|"$/g, "");
    }
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

export function skillIdFromName(name: string): string {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, NAME_LIMIT);
  if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new SkillError("Skill name needs a letter or number.");
  return id;
}

export function renderSkillMarkdown(skill: Omit<SkillRecord, "id">): string {
  const name = skill.name.replace(/[\r\n]/g, " ").trim();
  const whenToUse = skill.whenToUse.replace(/[\r\n]/g, " ").trim();
  return `---\nname: ${JSON.stringify(name)}\nwhen-to-use: ${JSON.stringify(whenToUse)}\nbuiltin: ${skill.builtin ? "true" : "false"}\n---\n${skill.body.trim()}\n`;
}

export function parseSkillMarkdown(text: string): Omit<SkillRecord, "id"> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text.trim());
  if (!match?.[1] || match[2] === undefined) throw new SkillError("SKILL.md needs frontmatter with name and when-to-use.");
  let name = "";
  let whenToUse = "";
  let builtin = false;
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line.trim());
    if (!field?.[1]) continue;
    const value = fieldValue(field[2] ?? "");
    if (field[1] === "name") name = value;
    if (field[1] === "when-to-use") whenToUse = value;
    if (field[1] === "builtin") builtin = value === "true";
  }
  const body = match[2].trim();
  if (!name || name.length > NAME_LIMIT) throw new SkillError("Skill name must be 1 to 80 characters.");
  if (!whenToUse || whenToUse.length > WHEN_LIMIT) throw new SkillError("When to use must be 1 to 300 characters.");
  if (!body || body.length > BODY_LIMIT) throw new SkillError("Skill steps must be 1 to 20000 characters.");
  skillIdFromName(name);
  return { name, whenToUse, body, builtin };
}

async function readSkillFile(file: string): Promise<SkillRecord | undefined> {
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text) return undefined;
  const parsed = parseSkillMarkdown(text);
  return { ...parsed, id: skillIdFromName(parsed.name) };
}

async function writeSkill(root: string, skill: SkillRecord): Promise<void> {
  const dir = path.join(skillsRoot(root), skill.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, "SKILL.md"), renderSkillMarkdown(skill), { mode: 0o600 });
}

export async function listSkills(root: string): Promise<SkillRecord[]> {
  const dir = skillsRoot(root);
  const entries = await readdir(dir).catch(() => undefined);
  if (!entries) {
    for (const starter of STARTERS) {
      const id = skillIdFromName(starter.name);
      await writeSkill(root, { ...starter, id });
    }
  }
  const ids = await readdir(dir).catch(() => [] as string[]);
  const skills: SkillRecord[] = [];
  for (const id of ids) {
    const record = await readSkillFile(path.join(dir, id, "SKILL.md"));
    if (record) skills.push(record);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createSkill(root: string, input: { name?: unknown; whenToUse?: unknown; body?: unknown }): Promise<SkillRecord> {
  const skill = normalizeInput(input, false);
  const existing = await listSkills(root);
  if (existing.some((item) => item.id === skill.id)) throw new SkillError("A skill with that name already exists.", 409);
  if (existing.length >= 100) throw new SkillError("The skills library already has 100 skills.");
  await writeSkill(root, skill);
  return skill;
}

export async function updateSkill(root: string, id: string, input: { name?: unknown; whenToUse?: unknown; body?: unknown }): Promise<SkillRecord> {
  const current = (await listSkills(root)).find((item) => item.id === id);
  if (!current) throw new SkillError("Unknown skill.", 404);
  const skill = normalizeInput(input, current.builtin);
  if (skill.id !== current.id) {
    const taken = (await listSkills(root)).some((item) => item.id === skill.id);
    if (taken) throw new SkillError("A skill with that name already exists.", 409);
    await rm(path.join(skillsRoot(root), current.id), { recursive: true, force: true });
  }
  await writeSkill(root, skill);
  return skill;
}

export async function deleteSkill(root: string, id: string): Promise<void> {
  const current = (await listSkills(root)).find((item) => item.id === id);
  if (!current) throw new SkillError("Unknown skill.", 404);
  await rm(path.join(skillsRoot(root), current.id), { recursive: true, force: true });
}

function normalizeInput(input: { name?: unknown; whenToUse?: unknown; body?: unknown }, builtin: boolean): SkillRecord {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const whenToUse = typeof input.whenToUse === "string" ? input.whenToUse.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const parsed = parseSkillMarkdown(renderSkillMarkdown({ name, whenToUse, body, builtin }));
  return { ...parsed, id: skillIdFromName(parsed.name) };
}

export async function skillCatalog(root: string): Promise<Array<{ name: string; description: string; body: string }>> {
  const skills = await listSkills(root);
  return skills.map((skill) => ({
    name: `skill:${skill.id}`,
    description: `${skill.name}. ${skill.whenToUse}`,
    body: skill.body.length > 8_000 ? `${skill.body.slice(0, 8_000)}\n…` : skill.body,
  }));
}

export async function exportSkillPack(root: string): Promise<Buffer> {
  const skills = await listSkills(root);
  if (!skills.length) throw new SkillError("There are no skills to export.");
  const destination = path.join(tmpdir(), `ocp-skills-export-${Date.now()}.zip`);
  const result = await runPython(EXPORT_PY, [skillsRoot(root), destination]);
  if (!result.ok) throw new SkillError("The skill pack could not be written.");
  const bytes = await readFile(destination);
  await rm(destination, { force: true });
  return bytes;
}

export async function importSkillZip(root: string, bytes: Buffer): Promise<{ imported: number }> {
  if (!bytes.length || bytes.length > 700_000) throw new SkillError("The zip pack must be a non-empty file under 700 KB. Nothing was imported.");
  const source = path.join(tmpdir(), `ocp-skills-import-${Date.now()}.zip`);
  await writeFile(source, bytes, { mode: 0o600 });
  const result = await runPython(IMPORT_PY, [source]);
  await rm(source, { force: true });
  if (!result.ok || !Array.isArray(result.files)) throw new SkillError(result.error || "The zip pack could not be read. Nothing was imported.");
  return storeImported(root, result.files);
}

export async function importSkillGit(root: string, gitUrl: string): Promise<{ imported: number }> {
  if (!allowedGitUrl(gitUrl)) throw new SkillError("Git URL must be an absolute local path or an https, git, or ssh URL without credentials. Nothing was imported.");
  const checkout = path.join(tmpdir(), `ocp-skills-git-${Date.now()}`);
  await mkdir(checkout, { recursive: true, mode: 0o700 });
  const cloned = await runGit(gitUrl, path.join(checkout, "repo"));
  if (!cloned) {
    await rm(checkout, { recursive: true, force: true });
    throw new SkillError("The git pack could not be read. Nothing was imported.");
  }
  const files = await collectSkillFiles(path.join(checkout, "repo"));
  await rm(checkout, { recursive: true, force: true });
  return storeImported(root, files);
}

async function storeImported(root: string, files: Array<{ text?: string }>): Promise<{ imported: number }> {
  const parsed: SkillRecord[] = [];
  for (const file of files.slice(0, PACK_LIMIT)) {
    if (typeof file.text !== "string") continue;
    try {
      const skill = parseSkillMarkdown(file.text);
      parsed.push({ ...skill, id: skillIdFromName(skill.name), builtin: false });
    } catch {
      continue;
    }
  }
  if (!parsed.length) throw new SkillError("The pack had no SKILL.md files with name and when-to-use. Nothing was imported.");
  await listSkills(root);
  for (const skill of parsed) await writeSkill(root, skill);
  return { imported: parsed.length };
}

function allowedGitUrl(value: string): boolean {
  if (!value || value.length > 500 || /[\r\n\0\s]/.test(value)) return false;
  if (value.startsWith("/") && !value.includes("@")) return true;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || url.protocol === "file:" || url.protocol === "git:" || url.protocol === "ssh:";
  } catch {
    return false;
  }
}

async function collectSkillFiles(dir: string, depth = 0): Promise<Array<{ text: string }>> {
  if (depth > 6) return [];
  const found: Array<{ text: string }> = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (found.length >= PACK_LIMIT) break;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) found.push(...await collectSkillFiles(full, depth + 1));
    else if (entry.name === "SKILL.md") {
      const text = await readFile(full, "utf8").catch(() => "");
      if (text.length > 0 && text.length <= 100_000) found.push({ text });
    }
  }
  return found;
}

function runGit(gitUrl: string, destination: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", gitUrl, destination], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 20_000,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function runPython(script: string, args: string[]): Promise<{ ok: boolean; error?: string; files?: Array<{ text?: string }> }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", script, ...args], { stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.on("error", () => resolve({ ok: false, error: "Skill packs need python3 on this machine. Nothing was imported." }));
    child.on("close", (code) => {
      if (!out.trim()) {
        resolve({ ok: code === 0, error: code === 0 ? undefined : "The skill pack could not be read. Nothing was imported." });
        return;
      }
      try {
        resolve(JSON.parse(out) as { ok: boolean; error?: string; files?: Array<{ text?: string }> });
      } catch {
        resolve({ ok: false, error: "The skill pack could not be read. Nothing was imported." });
      }
    });
  });
}

const EXPORT_PY = String.raw`
import json, os, sys, zipfile
root, dest = sys.argv[1], sys.argv[2]
count = 0
with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != ".git" and not d.startswith(".")]
        for name in files:
            if name != "SKILL.md":
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace("\\", "/")
            if rel.startswith("../") or rel.startswith("/"):
                continue
            z.write(full, rel)
            count += 1
print(json.dumps({"ok": count > 0, "error": None if count else "There are no skills to export."}))
`;

const IMPORT_PY = String.raw`
import json, sys, zipfile
source = sys.argv[1]
files = []
try:
    with zipfile.ZipFile(source) as z:
        for info in z.infolist():
            name = info.filename.replace("\\", "/")
            parts = [part for part in name.split("/") if part]
            if not parts or any(part == ".." for part in parts) or name.startswith("/"):
                print(json.dumps({"ok": False, "error": "The pack had an unsafe path. Nothing was imported."}))
                raise SystemExit
            if parts[-1] != "SKILL.md" or info.file_size > 100_000:
                continue
            files.append({"text": z.read(info).decode("utf-8", "replace")})
            if len(files) >= 40:
                break
except zipfile.BadZipFile:
    print(json.dumps({"ok": False, "error": "The zip pack could not be read. Nothing was imported."}))
    raise SystemExit
print(json.dumps({"ok": True, "files": files}))
`;
