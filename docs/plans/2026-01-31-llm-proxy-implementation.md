# LLM Proxy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Bun-based LAN proxy that forwards `/openai/*` and `/anthropic/*` requests to upstreams with streaming support and token auth.

**Architecture:** A small Bun HTTP server with a single request handler that validates a proxy token, maps paths by stripping the prefix, injects upstream auth headers, and streams the upstream response back to the client without buffering.

**Tech Stack:** Bun (TypeScript), bun:test, Docker, GitHub Actions (GHCR).

---

### Task 1: Scaffold Bun project and config loader

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Step 1: Write the failing test**

```ts
// tests/config.test.ts
import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const old = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    process.env = old as NodeJS.ProcessEnv;
  }
}

describe("loadConfig", () => {
  it("throws when required vars missing", () => {
    withEnv(
      {
        OPENAI_BASE_URL: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_BASE_URL: undefined,
        ANTHROPIC_API_KEY: undefined,
        PROXY_TOKEN: undefined,
        PORT: undefined,
      },
      () => {
        expect(() => loadConfig()).toThrow();
      },
    );
  });

  it("loads required vars and defaults port", () => {
    withEnv(
      {
        OPENAI_BASE_URL: "https://openai.example",
        OPENAI_API_KEY: "ok",
        ANTHROPIC_BASE_URL: "https://anthropic.example",
        ANTHROPIC_API_KEY: "ak",
        PROXY_TOKEN: "pt",
        PORT: undefined,
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.port).toBe(33000);
      },
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL with "Cannot find module '../src/config'" or similar

**Step 3: Write minimal implementation**

```ts
// src/config.ts
export type Config = {
  openaiBaseUrl: string;
  openaiApiKey: string;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  proxyToken: string;
  port: number;
  anthropicVersion?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

export function loadConfig(): Config {
  return {
    openaiBaseUrl: requireEnv("OPENAI_BASE_URL"),
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    anthropicBaseUrl: requireEnv("ANTHROPIC_BASE_URL"),
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    proxyToken: requireEnv("PROXY_TOKEN"),
    port: Number(process.env.PORT ?? 33000),
    anthropicVersion: process.env.ANTHROPIC_VERSION,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS

**Step 5: Create project files**

Run: `bun init -y`
Create `tsconfig.json` if not created:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "types": ["bun-types"],
    "skipLibCheck": true
  }
}
```

**Step 6: Commit**

```bash
git add package.json tsconfig.json src/config.ts tests/config.test.ts
git commit -m "feat: add config loader"
```

---

### Task 2: Core proxy handler with auth and routing

**Files:**
- Create: `src/proxy.ts`
- Create: `src/server.ts`
- Test: `tests/proxy.test.ts`

**Step 1: Write the failing test**

```ts
// tests/proxy.test.ts
import { describe, expect, it } from "bun:test";
import { createProxyHandler } from "../src/proxy";
import type { Config } from "../src/config";

function startUpstream() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      return new Response("ok", { status: 200, headers: { "x-up": "yes" } });
    },
  });
  return server;
}

describe("proxy", () => {
  it("rejects missing token", async () => {
    const upstream = startUpstream();
    const cfg: Config = {
      openaiBaseUrl: `http://127.0.0.1:${upstream.port}`,
      openaiApiKey: "ok",
      anthropicBaseUrl: `http://127.0.0.1:${upstream.port}`,
      anthropicApiKey: "ak",
      proxyToken: "pt",
      port: 33000,
    };
    const server = Bun.serve({ port: 0, fetch: createProxyHandler(cfg) });
    const res = await fetch(`http://127.0.0.1:${server.port}/openai/v1/test`);
    expect(res.status).toBe(401);
    server.stop(true);
    upstream.stop(true);
  });

  it("forwards and strips prefix", async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(req.url, { status: 200 });
      },
    });
    const cfg: Config = {
      openaiBaseUrl: `http://127.0.0.1:${upstream.port}`,
      openaiApiKey: "ok",
      anthropicBaseUrl: `http://127.0.0.1:${upstream.port}`,
      anthropicApiKey: "ak",
      proxyToken: "pt",
      port: 33000,
    };
    const server = Bun.serve({ port: 0, fetch: createProxyHandler(cfg) });
    const res = await fetch(`http://127.0.0.1:${server.port}/openai/v1/test?x=1`, {
      headers: { Authorization: "Bearer pt" },
    });
    const text = await res.text();
    expect(text).toContain("/v1/test?x=1");
    server.stop(true);
    upstream.stop(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/proxy.test.ts`
Expected: FAIL with "Cannot find module '../src/proxy'" or similar

**Step 3: Write minimal implementation**

```ts
// src/proxy.ts
import type { Config } from "./config";

const HOP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "authorization",
]);

function filterHeaders(headers: Headers, extra?: Record<string, string>): Headers {
  const out = new Headers();
  for (const [k, v] of headers.entries()) {
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    out.set(k, v);
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) out.set(k, v);
  }
  return out;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function badGateway(): Response {
  return new Response(JSON.stringify({ error: "bad_gateway" }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });
}

export function createProxyHandler(cfg: Config) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");

    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cfg.proxyToken}`) return unauthorized();

    let upstreamBase: string | null = null;
    let prefix = "";
    if (url.pathname.startsWith("/openai/")) {
      upstreamBase = cfg.openaiBaseUrl;
      prefix = "/openai";
    } else if (url.pathname.startsWith("/anthropic/")) {
      upstreamBase = cfg.anthropicBaseUrl;
      prefix = "/anthropic";
    } else {
      return new Response("not found", { status: 404 });
    }

    const upstreamUrl = new URL(url.pathname.slice(prefix.length) + url.search, upstreamBase);

    const extraHeaders: Record<string, string> =
      prefix === "/openai"
        ? { Authorization: `Bearer ${cfg.openaiApiKey}` }
        : { "x-api-key": cfg.anthropicApiKey };

    if (prefix === "/anthropic" && cfg.anthropicVersion && !req.headers.get("anthropic-version")) {
      extraHeaders["anthropic-version"] = cfg.anthropicVersion;
    }

    try {
      const res = await fetch(upstreamUrl, {
        method: req.method,
        headers: filterHeaders(req.headers, extraHeaders),
        body: req.body,
        duplex: "half",
      } as RequestInit);

      const outHeaders = filterHeaders(res.headers);
      return new Response(res.body, {
        status: res.status,
        headers: outHeaders,
      });
    } catch {
      return badGateway();
    }
  };
}
```

```ts
// src/server.ts
import { loadConfig } from "./config";
import { createProxyHandler } from "./proxy";

const config = loadConfig();

Bun.serve({
  port: config.port,
  fetch: createProxyHandler(config),
});

console.log(`llm-proxy listening on ${config.port}`);
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/proxy.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/proxy.ts src/server.ts tests/proxy.test.ts
git commit -m "feat: add proxy routing and auth"
```

---

### Task 3: Streaming/SSE passthrough

**Files:**
- Modify: `tests/proxy.test.ts`

**Step 1: Write the failing test**

```ts
// tests/proxy.test.ts (append)
import { ReadableStream } from "node:stream/web";

it("streams SSE without buffering", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: one\n\n"));
          controller.enqueue(new TextEncoder().encode("data: two\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const cfg = {
    openaiBaseUrl: `http://127.0.0.1:${upstream.port}`,
    openaiApiKey: "ok",
    anthropicBaseUrl: `http://127.0.0.1:${upstream.port}`,
    anthropicApiKey: "ak",
    proxyToken: "pt",
    port: 33000,
  };

  const server = Bun.serve({ port: 0, fetch: createProxyHandler(cfg) });
  const res = await fetch(`http://127.0.0.1:${server.port}/openai/v1/stream`, {
    headers: { Authorization: "Bearer pt" },
  });

  const body = await res.text();
  expect(body).toContain("data: one");
  expect(body).toContain("data: two");
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  server.stop(true);
  upstream.stop(true);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/proxy.test.ts`
Expected: FAIL if streaming not passed through or headers missing

**Step 3: Write minimal implementation**

No new code required if Task 2 already returns `res.body` directly. If it fails, fix `createProxyHandler` to ensure the upstream `ReadableStream` is returned as-is and headers are preserved.

**Step 4: Run test to verify it passes**

Run: `bun test tests/proxy.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/proxy.test.ts
git commit -m "test: verify SSE passthrough"
```

---

### Task 4: Docker and compose

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`

**Step 1: Write Dockerfile**

```Dockerfile
FROM oven/bun:1.1.45
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN bun install --frozen-lockfile || true
EXPOSE 33000
CMD ["bun", "run", "src/server.ts"]
```

**Step 2: Write .dockerignore**

```
.git
.worktrees
node_modules
bun.lockb
```

**Step 3: Write docker-compose.yml**

```yaml
services:
  llm-proxy:
    image: ghcr.io/<owner>/<repo>:latest
    ports:
      - "33000:33000"
    environment:
      OPENAI_BASE_URL: "https://api.openai.com"
      OPENAI_API_KEY: "${OPENAI_API_KEY}"
      ANTHROPIC_BASE_URL: "https://api.anthropic.com"
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
      PROXY_TOKEN: "${PROXY_TOKEN}"
      PORT: "33000"
```

**Step 4: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml
git commit -m "chore: add docker and compose"
```

---

### Task 5: GitHub Actions for GHCR

**Files:**
- Create: `.github/workflows/docker.yml`

**Step 1: Add workflow**

```yaml
name: docker
on:
  push:
    branches: ["main"]
    tags: ["v*"]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:${{ github.ref_name }}
```

**Step 2: Commit**

```bash
git add .github/workflows/docker.yml
git commit -m "ci: publish docker image"
```

---

### Task 6: README usage

**Files:**
- Create: `README.md`

**Step 1: Write README**

```md
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
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add usage"
```

---

### Task 7: Final verification

**Files:**
- Modify: (none)

**Step 1: Run all tests**

Run: `bun test`
Expected: PASS

**Step 2: Manual smoke check**

Run: `OPENAI_BASE_URL=http://127.0.0.1:PORT ... bun run src/server.ts` (use a local mock)
Expected: `GET /healthz` returns `ok` and proxy forwards with token.

**Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "chore: final fixes" || true
```
