#!/usr/bin/env node
/**
 * Lightweight repo linter/formatter check for Open Coding Partner.
 * Checks source and docs for trailing whitespace, TAB indentation, and CR/LF.
 * Does not rewrite files unless --fix is passed (trailing whitespace only).
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fix = process.argv.includes("--fix");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".sandbox", ".bundle", ".ocp"]);
const TEXT_EXT = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".css",
  ".html",
  ".txt",
  ".toml",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(root).filter((file) => {
  const ext = path.extname(file);
  const base = path.basename(file);
  if (base === ".gitignore" || base === ".npmrc" || base === ".node-version" || base === "LICENSE") return true;
  return TEXT_EXT.has(ext);
});

const errors = [];
for (const file of files) {
  const rel = path.relative(root, file);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  if (text.includes("\r")) {
    errors.push(`${rel}: CRLF line endings (use LF)`);
  }
  const lines = text.split("\n");
  let changed = false;
  const next = lines.map((line, index) => {
    if (line.includes("\t") && !rel.endsWith(".md")) {
      errors.push(`${rel}:${index + 1}: TAB character`);
    }
    if (/[ \t]+$/.test(line)) {
      if (fix) {
        changed = true;
        return line.replace(/[ \t]+$/, "");
      }
      errors.push(`${rel}:${index + 1}: trailing whitespace`);
    }
    return line;
  });
  if (fix && changed) writeFileSync(file, next.join("\n"));
}

if (errors.length) {
  process.stderr.write(`${errors.slice(0, 80).join("\n")}\n`);
  if (errors.length > 80) process.stderr.write(`…and ${errors.length - 80} more\n`);
  process.stderr.write(`lint failed: ${errors.length} issue(s)\n`);
  process.exit(1);
}

process.stdout.write(`lint ok: ${files.length} text files\n`);
