import type { CodingDispatch, WorkerResult } from "@opencodingpartner/mesh";

import { taskToWorkerPrompt } from "./prompt.js";
import { CodingWorkerNotConfiguredError, type CodingWorker } from "./worker.js";

export interface GrokHeadlessInvocation {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
}

export interface GrokBuildRunner {
  run(invocation: GrokHeadlessInvocation): Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

export function buildGrokHeadlessInvocation(input: {
  readonly prompt: string;
  readonly cwd: string;
}): GrokHeadlessInvocation {
  return {
    argv: ["grok", "-p", input.prompt, "--cwd", input.cwd, "--output-format", "streaming-json"],
    cwd: input.cwd,
  };
}

export class GrokBuildCodingWorker implements CodingWorker {
  readonly id = "grok-build" as const;

  constructor(private readonly runner?: GrokBuildRunner) {}

  planInvocation(input: CodingDispatch): GrokHeadlessInvocation {
    return buildGrokHeadlessInvocation({
      prompt: taskToWorkerPrompt(input.task),
      cwd: input.sandboxRoot,
    });
  }

  async dispatch(input: CodingDispatch): Promise<WorkerResult> {
    const invocation = this.planInvocation(input);
    if (this.runner === undefined) {
      throw new CodingWorkerNotConfiguredError(
        this.id,
        "Grok Build is unwired. Inject a runner for your own grok binary. This build does not spawn a process.",
      );
    }
    const ran = await this.runner.run(invocation);
    if (ran.exitCode !== 0) {
      throw new Error(`Grok Build runner exited ${ran.exitCode}`);
    }
    return {
      workerId: this.id,
      relativePath: input.task.relativePath,
      bytesWritten: 0,
      location: {
        kind: "external",
        reference: `grok-build://${input.task.relativePath}`,
      },
    };
  }
}
