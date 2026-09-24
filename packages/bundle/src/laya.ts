import { spawn } from "node:child_process";

export interface LayaExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type LayaExec = (bin: string, args: readonly string[], stdin: string) => Promise<LayaExecResult>;

/** Run integrations/laya/predict.py. The caller passes a Python that has Laya installed. */
export async function predictWithLaya(
  pythonBin: string,
  scriptPath: string,
  state: string,
  questions: readonly unknown[],
  exec?: LayaExec,
  env?: NodeJS.ProcessEnv,
): Promise<unknown> {
  const run = exec ?? ((bin, args, stdin) => defaultLayaExec(bin, args, stdin, env));
  const stdin = JSON.stringify({ state, questions, model: "english" });
  const result = await run(pythonBin, [scriptPath], stdin);
  if (result.code !== 0) {
    throw new Error(result.stderr || "Laya predict failed");
  }
  return JSON.parse(result.stdout) as unknown;
}

function defaultLayaExec(
  bin: string,
  args: readonly string[],
  stdin: string,
  env?: NodeJS.ProcessEnv,
): Promise<LayaExecResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
