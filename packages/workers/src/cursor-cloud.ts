import type { CodingDispatch, WorkerResult, WorkerTask } from "@opencodingpartner/mesh";

import { taskToWorkerPrompt } from "./prompt.js";
import { CodingWorkerNotConfiguredError, type CodingWorker } from "./worker.js";

export interface CursorCreateAgentRequest {
  readonly prompt: { readonly text: string };
  readonly repos: readonly [{ readonly url: string; readonly startingRef: string }];
  readonly autoCreatePR: false;
  readonly workOnCurrentBranch: false;
  readonly mode: "agent";
  readonly name: string;
}

export interface CursorCloudTransport {
  createAgent(
    body: CursorCreateAgentRequest,
    apiKey: string,
  ): Promise<{ readonly agentId: string; readonly runId: string; readonly runStatus: string }>;
}

export interface CursorCloudOptions {
  readonly apiKey?: string;
  readonly repositoryUrl?: string;
  readonly startingRef?: string;
  readonly transport?: CursorCloudTransport;
}

export function buildCursorCreateAgentRequest(input: {
  readonly prompt: string;
  readonly repositoryUrl: string;
  readonly startingRef: string;
  readonly name?: string;
}): CursorCreateAgentRequest {
  const name = (input.name ?? "OpenCodingPartner worker").slice(0, 100);
  return {
    prompt: { text: input.prompt },
    repos: [{ url: input.repositoryUrl, startingRef: input.startingRef }],
    autoCreatePR: false,
    workOnCurrentBranch: false,
    mode: "agent",
    name,
  };
}

export class CursorCloudCodingWorker implements CodingWorker {
  readonly id = "cursor-cloud" as const;

  constructor(private readonly options: CursorCloudOptions = {}) {}

  planRequest(task: WorkerTask): CursorCreateAgentRequest {
    const repositoryUrl = this.options.repositoryUrl;
    const startingRef = this.options.startingRef;
    if (repositoryUrl === undefined || startingRef === undefined) {
      throw new CodingWorkerNotConfiguredError(
        this.id,
        "Cursor Cloud needs the operator's repository URL and starting ref.",
      );
    }
    return buildCursorCreateAgentRequest({
      prompt: taskToWorkerPrompt(task),
      repositoryUrl,
      startingRef,
      name: `write ${task.relativePath}`,
    });
  }

  async dispatch(input: CodingDispatch): Promise<WorkerResult> {
    const apiKey = this.options.apiKey;
    const transport = this.options.transport;
    if (apiKey === undefined || transport === undefined) {
      throw new CodingWorkerNotConfiguredError(
        this.id,
        "Cursor Cloud is unwired. Inject your own API key and transport. This build does not call api.cursor.com.",
      );
    }
    const body = this.planRequest(input.task);
    const created = await transport.createAgent(body, apiKey);
    return {
      workerId: this.id,
      relativePath: input.task.relativePath,
      bytesWritten: Buffer.byteLength(input.task.contents, "utf8"),
      location: {
        kind: "external",
        reference: `cursor-cloud://${created.agentId}/${created.runId}`,
      },
    };
  }
}
