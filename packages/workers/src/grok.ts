/**
 * Grok Build seam. Builds the headless argv. The caller injects a runner.
 * The offline demo cannot start grok. Callers pass in a runner.
 *
 * Operator install: https://github.com/xai-org/grok-build (Apache-2.0). We do not vendor it.
 */
export function grokBuildArgv(prompt: string, cwd: string): string[] {
  return ["grok", "-p", prompt, "--cwd", cwd, "--output-format", "streaming-json"];
}

export interface InjectedRunner {
  run(argv: readonly string[]): Promise<{ exitCode: number; stdout: string }>;
}

export async function runOnGrokBuild(
  runner: InjectedRunner,
  prompt: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; argv: string[] }> {
  const argv = grokBuildArgv(prompt, cwd);
  const result = await runner.run(argv);
  return { ...result, argv };
}
