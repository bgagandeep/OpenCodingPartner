#!/usr/bin/env node
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  process.stderr.write("Usage: node scripts/assert-test-count.mjs <test-output>\n");
  process.exit(2);
}

const text = readFileSync(file, "utf8");
const matches = [...text.matchAll(/(?:^|\n)[^\n]*\btests\s+(\d+)\s*(?:\n|$)/g)];
const count = matches.reduce((max, match) => Math.max(max, Number(match[1])), 0);
const minimum = 200;

if (!Number.isInteger(count) || count < minimum) {
  process.stderr.write(
    `Expected the Node test reporter to count at least ${minimum} tests, saw ${count || "none"}.\n` +
      "If CLI tests patch process.stdout.write, they must forward bytes to the original writer so TAP/spec lines are not swallowed.\n",
  );
  process.exit(1);
}

process.stdout.write(`test count ok: ${count}\n`);
