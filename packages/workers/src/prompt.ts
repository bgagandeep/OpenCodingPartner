import type { WorkerTask } from "@opencodingpartner/mesh";

export function taskToWorkerPrompt(task: WorkerTask): string {
  return [
    "Perform exactly one file write.",
    `Relative path: ${task.relativePath}`,
    "Do not edit any other path.",
    "File contents follow, unchanged:",
    task.contents,
  ].join("\n");
}
