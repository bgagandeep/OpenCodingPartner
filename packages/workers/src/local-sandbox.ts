import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveInsideSandbox, type CodingDispatch, type WorkerResult } from "@opencodingpartner/mesh";

import type { CodingWorker } from "./worker.js";

export class LocalSandboxWorker implements CodingWorker {
  readonly id = "local-sandbox" as const;

  async dispatch(input: CodingDispatch): Promise<WorkerResult> {
    const absolutePath = resolveInsideSandbox(input.sandboxRoot, input.task.relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const temporary = `${absolutePath}.partial-${randomUUID()}`;
    await writeFile(temporary, input.task.contents, "utf8");
    await rename(temporary, absolutePath);
    return {
      workerId: this.id,
      relativePath: input.task.relativePath,
      bytesWritten: Buffer.byteLength(input.task.contents, "utf8"),
      location: { kind: "sandbox", absolutePath },
    };
  }
}
