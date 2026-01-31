# LLM Proxy Design (Bun)

## Goals
- Provide a lightweight LAN proxy that forwards to OpenAI and Anthropic.
- Single LAN token for clients; upstream keys stay only on the proxy.
- Support streaming (SSE) without buffering.
- Easy Docker/Compose deployment; GitHub Actions builds to GHCR.

## Non-Goals
- Advanced policy controls (rate limiting, model allowlists).
- Request/response transformations.
- Multi-tenant auth or per-user keys.

## Configuration
Environment variables only:
- `OPENAI_BASE_URL`, `OPENAI_API_KEY`
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`
- `PROXY_TOKEN`, `PORT` (default `33000`)
- Optional: `ANTHROPIC_VERSION` (default header when not provided)

Startup validates required vars and exits non-zero if missing.

## Routes
- `GET /healthz` -> `200 ok`
- `/openai/*` -> upstream OpenAI (prefix stripped)
- `/anthropic/*` -> upstream Anthropic (prefix stripped)

Mapping example:
- `/openai/v1/chat/completions` -> `<OPENAI_BASE_URL>/v1/chat/completions`
- `/anthropic/v1/messages` -> `<ANTHROPIC_BASE_URL>/v1/messages`

## Request Flow
1) Validate `Authorization: Bearer <PROXY_TOKEN>` for all routes except `/healthz`.
2) Build upstream URL by stripping prefix and preserving path + query.
3) Forward method, headers, and body using `fetch` with `duplex: "half"`.
4) Inject upstream auth headers:
   - OpenAI: `Authorization: Bearer <OPENAI_API_KEY>`
   - Anthropic: `x-api-key: <ANTHROPIC_API_KEY>`
   - Optional: `anthropic-version` if configured and not provided.
5) Strip hop-by-hop headers (`host`, `content-length`, `connection`, `transfer-encoding`, `authorization`).
6) Return upstream status, headers (filtered), and body as-is.

## Streaming
- No buffering. Pass through upstream `ReadableStream` directly.
- Preserve `text/event-stream` responses for SSE.

## Error Handling
- Invalid/missing proxy token -> `401` JSON error.
- Upstream fetch failure -> `502` JSON error.
- Minimal logging (startup + fatal errors only).

## Testing
- Auth: wrong token -> `401`.
- Routing: `/openai/*` and `/anthropic/*` map correctly.
- Streaming: mock upstream emits SSE chunks; proxy relays without buffering.

## Packaging
- Bun server in `src/server.ts`.
- Dockerfile based on a Bun image.
- `docker-compose.yml` example for LAN deployment.

## CI/CD
- GitHub Actions builds and publishes GHCR image.
- Tags: `latest` on `main`, plus version tags on releases.
- Optional multi-arch build (amd64 + arm64).
