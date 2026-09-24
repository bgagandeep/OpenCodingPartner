/** Same headless argv the coding and QA seam uses. Kept here so the probe does not spawn from the workers package. */
export function grokBuildArgv(prompt: string, cwd: string): string[] {
  return ["grok", "-p", prompt, "--cwd", cwd, "--output-format", "streaming-json"];
}
