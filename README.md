# LLM Proxy (Bun)

A small OpenAI / Anthropic proxy with a built-in admin page, per-member keys, timed access, and daily usage by model. No frontend framework or external database.

## Run

Only `ADMIN_PASSWORD` is required. Configure upstream URLs, upstream API keys, member keys, reporting timezone, and the usage save interval in the admin UI.

```bash
ADMIN_PASSWORD='your-private-admin-password' ./llmp
```

Open `http://localhost:33000/admin`, sign in, and open **Settings**. Enter a key for at least one upstream service, then create and enable member keys. API requests to an unconfigured provider receive `503 provider_not_configured`.

The default upstream URLs are `https://api.openai.com` and `https://api.anthropic.com`. Custom compatible endpoints are supported, including a base path. The proxy appends the client path after removing `/openai` or `/anthropic`: a client request to `/openai/v1/responses` becomes `<base-url>/v1/responses`, so do not duplicate `/v1` in the base URL unless your upstream requires it.

## Build a single executable

Use Bun 1.4.2:

```bash
bun install --frozen-lockfile
bun run check
bun test
bun run build
```

The result is `dist/llmp`, compiled for the build machine's OS and CPU architecture. Copy that one file to a matching machine. Bun, source files, frontend assets, and `node_modules` are not required on the destination. For local development, use `ADMIN_PASSWORD='your-password' bun run dev`.

## Docker

```bash
docker run --rm -p 33000:33000 \
  -e ADMIN_PASSWORD='your-private-admin-password' \
  -v llmp-data:/app/data \
  ghcr.io/txchen/llmp:latest
```

Or use the included Compose file:

```bash
ADMIN_PASSWORD='your-private-admin-password' docker compose up -d
```

Only the admin password is passed as application configuration. The volume retains settings, member keys, and usage across container replacement. Upgrading the source requires rebuilding the image before these changes are available in Docker.

## Manage access

- Admin sessions expire after 12 hours or a server restart. Member keys cannot access the management API.
- New member keys start disabled. Their full value is shown only once; the database stores a SHA-256 hash and the last four characters.
- **Enable** offers continuous access until manually disabled or a custom duration in minutes/hours. Shortcuts: 30 minutes, 1 hour, 3 hours. Maximum: 365 days.
- Changing the duration starts a new countdown from confirmation. Continuous access clears the deadline.
- Disabling, revoking, or reaching the deadline immediately interrupts that key's active requests and rejects new requests. Re-enabling keeps the same key. Revocation is permanent.
- Deadlines persist across restarts and work with the admin page closed. Interrupted requests do not resume automatically. Already-delivered text cannot be retracted; aborting the upstream connection does not guarantee that the provider stops already-submitted background work or billing.
- Invalid/revoked member keys receive `401`; disabled/expired keys receive `403`.

## Usage and caching

The usage table groups by **date, member key, provider, and model name**, with separate **input tokens**, **output tokens**, and total tokens. Filter by dates, member key, or exact model name. Revoked keys keep historical usage. The response model name is used when supplied by the provider, otherwise the requested model is retained.

Reporting dates use the timezone selected in Settings (initially the server timezone). Cross-midnight requests belong to their start date. Changing timezone only affects new requests; historical dates are not rewritten.

Usage is parsed from OpenAI Responses, Chat Completions, Completions, Embeddings, and Anthropic Messages, including SSE streams. Chat/Completions streaming requests get `stream_options.include_usage=true`. OpenAI cached input is already included in its input count; Anthropic cache-read and cache-creation counts are added to input. Prompt and response content is never stored.

Compressed request bodies are forwarded unchanged, so the proxy does not inject streaming usage options into them. Such clients must request usage themselves when the provider requires it. Response usage is still recorded; if neither request inspection nor the response supplies a model name, it is reported as `unknown`.

Only complete provider-reported usage is included in totals. Requests interrupted or returned without complete usage are counted as **Unknown usage**, not known zero consumption. Parsing is bounded to 8 MiB per SSE event or non-stream JSON response. Other endpoints remain proxied and access-controlled but are not included in the usage report. Statistics are not a provider billing reconciliation.

Storage behavior:

- Keys, upstream configuration, and daily counters load into memory at startup. Authentication, access checks, and usage queries use this cache without querying SQLite.
- Request completion updates in-memory daily counters. Recent-use timestamps are also cached. There are no per-request database inserts or updates.
- Usage and recent-use timestamps are saved together in one transaction **every 10 minutes by default**. Change this in Settings to any whole-minute interval from 1 to 1440 minutes. An idle interval performs no database writes.
- Key creation, access changes, and configuration changes are saved immediately, then published to the cache. Provider updates apply to new requests without restarting; requests already sent keep their original upstream configuration.
- Normal shutdown flushes the remaining cache. A crash, forced kill, or power loss can lose unflushed usage and in-flight request accounting. A failed flush keeps the dirty counters for retry. The UI always reads live cached values, even before they are saved.

## Database

The default path is `./data/llmp.sqlite`, relative to the working directory. The parent directory is created automatically. SQLite may create `-wal` and `-shm` sidecars while running. Stop the server normally before copying the database for backup. Run one server process per database; direct database edits are not reflected in the running cache.

| Table | Purpose |
| --- | --- |
| `keys` | Member key hash, display name, suffix, state, access deadline, creation and recent-use timestamps |
| `daily_usage` | Counters grouped by `(day, key_id, provider, model)`: input/output tokens, completed requests, and requests with unknown usage |
| `metadata` | Settings JSON and one-time migration markers |

The `metadata` row named `settings` contains:

```json
{
  "openaiBaseUrl": "https://api.openai.com",
  "openaiApiKey": "...",
  "anthropicBaseUrl": "https://api.anthropic.com",
  "anthropicApiKey": "...",
  "anthropicVersion": "2023-06-01",
  "timezone": "America/Los_Angeles",
  "usageFlushMinutes": 10
}
```

Upstream API keys must remain recoverable to authenticate forwarded requests, so they are stored as values in the database. They are never returned by the settings API; it only reports whether each provider is configured. Member keys are stored as hashes. The database file is created with owner-only permissions.

On upgrade, existing per-request history from `requests` is aggregated into `daily_usage` once. The old table is kept as an archive and is no longer used for normal reads or writes. Old upstream environment variables and `TIMEZONE` are imported only when settings are first initialized. An old `PROXY_TOKEN`, if supplied on the first database initialization, becomes an enabled **Legacy shared key**; it is never reimported or used as an authentication bypass. After migration, manage settings and keys in the UI.

## Optional deployment overrides

These are not needed for a normal Docker or binary setup:

- `PORT`: listening port, default `33000`.
- `DATABASE_PATH`: SQLite location, default `./data/llmp.sqlite`.
- `ADMIN_ORIGIN`: exact public origin for an HTTPS reverse proxy, e.g. `https://ai.example.com`, with no path or trailing slash. Enables Secure session cookies. The reverse proxy must preserve streaming and cancellation.
- `IDLE_TIMEOUT_SECONDS`: default and maximum `255` on Bun.
- `MAX_REQUEST_BODY_SIZE_MB`: default `256`.

The admin page is intended for a trusted home LAN. Mutating admin API calls require a matching `Origin` header. Forwarded client-IP headers are not trusted for login rate limiting.

## Client requests

Use a member key created and enabled in the UI:

```bash
curl http://127.0.0.1:33000/openai/v1/responses \
  -H 'Authorization: Bearer YOUR_MEMBER_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"YOUR_MODEL","input":"Hello","stream":true}'

curl http://127.0.0.1:33000/anthropic/v1/messages \
  -H 'Authorization: Bearer YOUR_MEMBER_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"YOUR_MODEL","max_tokens":64,"messages":[{"role":"user","content":"Hello"}]}'
```

The proxy injects the upstream credentials and strips local credentials, cookies, and hop-by-hop headers. Anthropic API version defaults to `2023-06-01` and can be changed in Settings. An explicit client `anthropic-version` header takes precedence.
