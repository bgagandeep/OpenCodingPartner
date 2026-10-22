/** OCP-branded provider presets. No model ID is implied until the operator chooses one. */
export const PROVIDER_PRESETS = [
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "ollama",
    label: "Local: Ollama",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
  },
  {
    id: "lmstudio",
    label: "Local: LM Studio",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
  },
  {
    id: "vllm",
    label: "Local: vLLM",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    kind: "openai-compatible",
    baseUrl: "",
  },
] as const;

export function defaultModelId(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCP_DEFAULT_MODEL?.trim() || "";
}
