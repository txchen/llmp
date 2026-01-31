# LLM Proxy (Bun)

Lightweight LAN proxy for OpenAI and Anthropic with a single local token.

## Run locally

```bash
export OPENAI_BASE_URL=https://api.openai.com
export OPENAI_API_KEY=...
export ANTHROPIC_BASE_URL=https://api.anthropic.com
export ANTHROPIC_API_KEY=...
export PROXY_TOKEN=local-token
export PORT=33000

bun run src/server.ts
```

## Example request

```bash
curl http://127.0.0.1:33000/openai/v1/chat/completions \
  -H "Authorization: Bearer local-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

## Docker

```bash
docker run --rm -p 33000:33000 \
  -e OPENAI_BASE_URL=https://api.openai.com \
  -e OPENAI_API_KEY=... \
  -e ANTHROPIC_BASE_URL=https://api.anthropic.com \
  -e ANTHROPIC_API_KEY=... \
  -e PROXY_TOKEN=local-token \
  -e PORT=33000 \
  ghcr.io/<owner>/<repo>:latest
```
