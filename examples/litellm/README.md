# Local meter proxy

This folder is a local chat-completions proxy for the meter. You own the keys. This repo does not vendor the proxy. The upstream name, image, and license are in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

The example config exposes one alias, `gpt-4o-mini`. The proxy sends that to the provider using `OPENAI_API_KEY`. Clients call the proxy with `LITELLM_MASTER_KEY`.

```bash
export LITELLM_MASTER_KEY="the proxy key"
export OPENAI_API_KEY="the provider key"
docker compose up -d litellm
export LITELLM_API_KEY="$LITELLM_MASTER_KEY"
export LITELLM_BASE_URL="http://127.0.0.1:4000/v1"
pnpm exec ocp chat --sandbox .sandbox
```

The proxy listens on `127.0.0.1:4000` only.
