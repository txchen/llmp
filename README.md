# LLM Proxy (Bun)

Lightweight LAN proxy for OpenAI and Anthropic with a single local token.

## Run locally

Copy `.env.example` to `.env` and fill in values, then export them (or load with your preferred env loader), or export directly:

```bash
export OPENAI_BASE_URL=https://api.openai.com
export OPENAI_API_KEY=...
export ANTHROPIC_BASE_URL=https://api.anthropic.com
export ANTHROPIC_API_KEY=...
export PROXY_TOKEN=local-token
export PORT=33000

bun run dev
```

## Example request

```bash
curl http://127.0.0.1:33000/openai/v1/chat/completions \
  -H "Authorization: Bearer local-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

## Curl testing

List OpenAI models:

```bash
curl http://127.0.0.1:33000/openai/v1/models \
  -H "Authorization: Bearer local-token"
```

OpenAI responses (non-stream):

```bash
curl http://127.0.0.1:33000/openai/v1/responses \
  -H "Authorization: Bearer local-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","input":"hello"}'
```

OpenAI responses (SSE stream):

```bash
curl -N http://127.0.0.1:33000/openai/v1/responses \
  -H "Authorization: Bearer local-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","input":"stream please","stream":true}'
```

Anthropic messages (non-stream). If you did not set `ANTHROPIC_VERSION` on the proxy, include the header here:

```bash
curl http://127.0.0.1:33000/anthropic/v1/messages \
  -H "Authorization: Bearer local-token" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

Anthropic messages (SSE stream):

```bash
curl -N http://127.0.0.1:33000/anthropic/v1/messages \
  -H "Authorization: Bearer local-token" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"stream"}]}'
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
