#!/usr/bin/env node
/**
 * User-facing branding guard for Open Coding Partner (OCP).
 *
 * Hard rules:
 * - Product name is Open Coding Partner / OCP / OpenCodingPartner.
 * - CBRE is never allowed.
 * - Do not describe Cursor Cloud Agents as part of the product.
 * - Upstream runtime names (OpenClaw, Hermes, Grok Build, Laya, LiteLLM, xAI)
 *   belong in Credits / NOTICE / THIRD_PARTY_NOTICES (and Settings > Credits).
 *
 * The scan of CLI/dashboard copy for upstream names is advisory until the
 * branding cleanup lands; CBRE and credit-file presence are always enforced.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".sandbox", ".bundle", ".ocp"]);
const STRICT = process.env.OCP_BRANDING_STRICT === "1";

const CREDIT_FILES = new Set([
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "packages/bundle/pins.json",
]);

const UPSTREAM = /\b(OpenClaw|Hermes Agent|\bHermes\b|Grok Build|\bLaya\b|LiteLLM|\bxAI\b|Grok Bot)\b/;
const CBRE = /\bCBRE\b/;
const CURSOR_CLOUD_AS_PRODUCT = /Cursor Cloud Agents? as part of the product|powered by Cursor Cloud/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

const failures = [];

const readme = read("README.md");
if (!/Open Coding Partner|OpenCodingPartner/.test(readme)) {
  failures.push("README.md must name Open Coding Partner / OpenCodingPartner");
}
if (!/## Credits/.test(readme)) {
  failures.push("README.md must include a Credits section for upstream runtime names");
}

const notice = read("NOTICE");
if (!/OpenClaw/.test(notice) || !/Hermes Agent/.test(notice) || !/LiteLLM/.test(notice)) {
  failures.push("NOTICE must credit OpenClaw, Hermes Agent, and LiteLLM");
}

const health = read("packages/product/src/server.ts");
if (!/\bocpAgent\b/.test(health) || !/\bocpCoder\b/.test(health)) {
  failures.push("packages/product/src/server.ts /api/health must expose ocpAgent and ocpCoder field names");
}

for (const file of walk(root)) {
  const rel = path.relative(root, file).replaceAll("\\", "/");
  if (rel.endsWith(".png") || rel.endsWith(".lock") || rel.endsWith(".woff2")) continue;
  if (rel === "scripts/branding-guard.mjs" || rel === "tests/branding-guard.test.mjs" || rel === "tests/invariants.test.mjs") continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  if (CBRE.test(text)) failures.push(`${rel}: CBRE is not allowed anywhere in this repository`);
  if (CURSOR_CLOUD_AS_PRODUCT.test(text)) {
    failures.push(`${rel}: do not describe Cursor Cloud Agents as part of the product`);
  }
  if (!STRICT) continue;
  if (CREDIT_FILES.has(rel)) continue;
  if (rel.startsWith("packages/bundle/") || rel.startsWith("integrations/") || rel === "docs/legacy-sandbox.md") continue;
  if (/\.test\.(ts|js|mjs)$/.test(rel)) continue;
  const userFacing =
    rel === "packages/cli/src/main.ts" ||
    rel === "packages/product/src/server.ts" ||
    rel === "PARTNER.md" ||
    rel === "README.md" ||
    rel === "CONTRIBUTING.md";
  if (userFacing && UPSTREAM.test(text)) {
    const hits = [...text.matchAll(new RegExp(UPSTREAM.source, "g"))].map((m) => m[0]);
    failures.push(`${rel}: upstream names in user-facing copy (${[...new Set(hits)].join(", ")}). Move to Credits/NOTICE.`);
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.stderr.write(`branding-guard failed: ${failures.length} issue(s)\n`);
  process.exit(1);
}

process.stdout.write(`branding-guard ok${STRICT ? " (strict)" : ""}\n`);
