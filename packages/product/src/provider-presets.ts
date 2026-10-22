/**
 * OCP-branded provider presets. No model ID is implied until the operator chooses one.
 * recentTokenBudget is how many estimated tokens of recent turns stay verbatim.
 * It is an OCP preset, not a claimed provider context limit.
 */
export const PROVIDER_PRESETS = [
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    recentTokenBudget: 8_000,
  },
  {
    id: "ollama",
    label: "Local: Ollama",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    recentTokenBudget: 4_096,
  },
  {
    id: "lmstudio",
    label: "Local: LM Studio",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    recentTokenBudget: 4_096,
  },
  {
    id: "vllm",
    label: "Local: vLLM",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    recentTokenBudget: 8_192,
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    kind: "openai-compatible",
    baseUrl: "",
    recentTokenBudget: 4_096,
  },
] as const;

export function recentTokenBudget(provider: string, baseUrl: string): number {
  if (provider === "openrouter") return budgetOf("openrouter");
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      if (url.port === "11434") return budgetOf("ollama");
      if (url.port === "1234") return budgetOf("lmstudio");
      if (url.port === "8000") return budgetOf("vllm");
    }
  } catch {
    // Custom preset covers a base URL that is not a URL.
  }
  return budgetOf("custom");
}

function budgetOf(id: (typeof PROVIDER_PRESETS)[number]["id"]): number {
  return PROVIDER_PRESETS.find((preset) => preset.id === id)?.recentTokenBudget ?? 4_096;
}

export function defaultModelId(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCP_DEFAULT_MODEL?.trim() || "";
}
