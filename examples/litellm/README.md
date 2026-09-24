# Local LiteLLM proxy

LiteLLM is an OpenAI-compatible proxy. You own the keys. This repo does not vendor LiteLLM.

The example config exposes one alias, `gpt-4o-mini`. The proxy sends that to OpenAI using `OPENAI_API_KEY`. Clients call the proxy with `LITELLM_MASTER_KEY`.

```bash
export LITELLM_MASTER_KEY="the proxy key"
export OPENAI_API_KEY="the provider key"
docker compose up -d litellm
export LITELLM_API_KEY="$LITELLM_MASTER_KEY"
export LITELLM_BASE_URL="http://127.0.0.1:4000/v1"
pnpm exec ocp chat --sandbox .sandbox
```

The proxy listens on `127.0.0.1:4000` only. Image: `docker.litellm.ai/berriai/litellm:v1.102.1` (MIT, BerriAI).
