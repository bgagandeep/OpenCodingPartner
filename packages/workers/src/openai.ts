import { writeSandboxFile } from "./coding.js";
import type { InjectedRunner } from "./grok.js";

export interface OpenAiCoderOptions {
  apiKey: string;
  baseUrl: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export interface FileEdit {
  path: string;
  content: string;
}

/**
 * OpenAI-compatible meter. The operator sets OPENAI_API_KEY and OPENAI_BASE_URL
 * (LiteLLM or OpenRouter). This file does not spawn a process and does not print the key.
 */
export function openAiCompatibleRunner(options: OpenAiCoderOptions): InjectedRunner {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? "gpt-4o-mini";
  return {
    async run(argv) {
      const prompt = flagValue(argv, "-p");
      const cwd = flagValue(argv, "--cwd");
      if (!prompt || !cwd) return { exitCode: 1, stdout: "" };
      const base = options.baseUrl.replace(/\/$/, "");
      let response: Response;
      try {
        response = await fetchImpl(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "user",
                content: [
                  "Edit the coding sandbox. Reply with JSON only, no prose.",
                  'Shape: {"files":[{"path":"relative/path","content":"file bytes"}]}',
                  "Write every file the request needs. Paths stay inside the sandbox.",
                  "",
                  prompt,
                ].join("\n"),
              },
            ],
          }),
        });
      } catch {
        return { exitCode: 1, stdout: "" };
      }
      if (!response.ok) return { exitCode: 1, stdout: "" };
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content ?? "";
      const files = parseFileEdits(content);
      if (files.length === 0) return { exitCode: 1, stdout: "" };
      for (const file of files) {
        await writeSandboxFile(cwd, file.path, file.content);
      }
      return { exitCode: 0, stdout: "" };
    },
  };
}

export function parseFileEdits(content: string): FileEdit[] {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced?.[1] ?? content).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { files?: unknown };
    if (!Array.isArray(parsed.files)) return [];
    return parsed.files.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as { path?: unknown; content?: unknown };
      if (typeof record.path !== "string" || typeof record.content !== "string") return [];
      if (record.path.length === 0) return [];
      return [{ path: record.path, content: record.content }];
    });
  } catch {
    return [];
  }
}

function flagValue(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value ?? "";
}
