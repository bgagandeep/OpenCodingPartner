#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createFoundationMesh, runBoardDemo, type FoundationOptions } from "@opencodingpartner/gateway";
import type { TurnResult } from "@opencodingpartner/mesh";

import { HELP, parseCli } from "./args.js";
import { formatTurn } from "./format.js";

function printTurns(turns: readonly TurnResult[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(turns, null, 2)}\n`);
    return;
  }
  for (const turn of turns) {
    process.stdout.write(`${formatTurn(turn)}\n`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseCli(argv);
  if (args.command === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (args.command === "error") {
    process.stderr.write(`${args.message}\n${HELP}\n`);
    return 1;
  }
  if (args.command === "route") {
    const mesh = createFoundationMesh({ sandboxRoot: "." });
    const preview = await mesh.preview(args.message);
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    return 0;
  }

  const options: FoundationOptions = { sandboxRoot: args.sandbox };
  const mesh = createFoundationMesh(options);
  const turns =
    args.command === "demo" && args.message === undefined
      ? await runBoardDemo(mesh)
      : [
          await mesh.handleTurn(args.message ?? "", {
            ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
          }),
        ];
  printTurns(turns, args.json);
  return turns.every((turn) => turn.ok) ? 0 : 1;
}

const entry = process.argv[1];
const isDirect = entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;

if (isDirect) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "cli failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

export { main };
