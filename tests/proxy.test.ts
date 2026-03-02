import { describe, expect, it } from "bun:test";
import { createProxyHandler } from "../src/proxy";
import type { Config } from "../src/config";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    openaiBaseUrl: "https://openai.example",
    openaiApiKey: "ok",
    anthropicBaseUrl: "https://anthropic.example",
    anthropicApiKey: "ak",
    proxyToken: "pt",
    port: 33000,
    idleTimeoutSeconds: 255,
    maxRequestBodySizeBytes: 256 * 1024 * 1024,
    ...overrides,
  };
}

async function withMockedFetch<T>(
  mock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = mock;
  try {
    return await fn();
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = original;
  }
}

async function withMockedWarn<T>(fn: (logs: string[]) => Promise<T>): Promise<T> {
  const original = console.warn;
  const logs: string[] = [];
  console.warn = ((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  }) as typeof console.warn;
  try {
    return await fn(logs);
  } finally {
    console.warn = original;
  }
}

describe("proxy", () => {
  it("rejects missing token", async () => {
    const cfg = makeConfig();
    const handler = createProxyHandler(cfg);
    const res = await handler(new Request("http://proxy/openai/v1/test"));
    expect(res.status).toBe(401);
  });

  it("forwards and strips prefix", async () => {
    const cfg = makeConfig();
    const handler = createProxyHandler(cfg);
    let seenUrl = "";
    await withMockedFetch(async (input) => {
      seenUrl = String(input);
      return new Response("ok", { status: 200 });
    }, async () => {
      await handler(
        new Request("http://proxy/openai/v1/test?x=1", {
          headers: { Authorization: "Bearer pt" },
        }),
      );
    });
    expect(seenUrl).toBe("https://openai.example/v1/test?x=1");
  });

  it("passes through client accept-encoding by default", async () => {
    const cfg = makeConfig();
    const handler = createProxyHandler(cfg);
    let seenAcceptEncoding: string | null = null;

    await withMockedFetch(async (_input, init) => {
      seenAcceptEncoding = new Headers(init?.headers).get("accept-encoding");
      return new Response("ok", { status: 200 });
    }, async () => {
      await handler(
        new Request("http://proxy/openai/v1/test", {
          headers: {
            Authorization: "Bearer pt",
            "accept-encoding": "br",
          },
        }),
      );
    });

    expect(seenAcceptEncoding).toBe("br");
  });

  it("preserves base path when forwarding", async () => {
    const cfg = makeConfig({ openaiBaseUrl: "https://openai.example/openai" });
    const handler = createProxyHandler(cfg);
    let seenUrl = "";
    await withMockedFetch(async (input) => {
      seenUrl = String(input);
      return new Response("ok", { status: 200 });
    }, async () => {
      await handler(
        new Request("http://proxy/openai/v1/models?x=1", {
          headers: { Authorization: "Bearer pt" },
        }),
      );
    });
    expect(seenUrl).toBe("https://openai.example/openai/v1/models?x=1");
  });

  it("logs unsupported path when client URL path is invalid", async () => {
    const cfg = makeConfig();
    const handler = createProxyHandler(cfg);

    await withMockedWarn(async (logs) => {
      const res = await handler(
        new Request("http://proxy/invalid-provider/v1/test", {
          headers: { Authorization: "Bearer pt" },
        }),
      );

      expect(res.status).toBe(404);
      expect(logs.length).toBe(1);
      const log = JSON.parse(logs[0]) as { event?: string };
      expect(log.event).toBe("proxy.unsupported_path");
    });
  });

  it("logs malformed request URL", async () => {
    const cfg = makeConfig();
    const handler = createProxyHandler(cfg);

    await withMockedWarn(async (logs) => {
      const res = await handler({
        url: "%%%not-a-valid-url",
        method: "GET",
        headers: new Headers(),
        body: null,
      } as unknown as Request);

      expect(res.status).toBe(400);
      expect(logs.length).toBe(1);
      const log = JSON.parse(logs[0]) as { event?: string };
      expect(log.event).toBe("proxy.invalid_request_url");
    });
  });

  it("drops upstream content-encoding header to keep body/header consistent", async () => {
    const cfg = makeConfig();
    const handler = createProxyHandler(cfg);

    await withMockedFetch(async () => {
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "br",
        },
      });
    }, async () => {
      const res = await handler(
        new Request("http://proxy/openai/v1/responses", {
          headers: { Authorization: "Bearer pt" },
        }),
      );

      expect(res.headers.get("content-encoding")).toBeNull();
      expect(await res.text()).toBe('{"ok":true}');
    });
  });
});

it("streams SSE without buffering", async () => {
  const cfg = makeConfig();
  const handler = createProxyHandler(cfg);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: one\n\n"));
      controller.enqueue(new TextEncoder().encode("data: two\n\n"));
      controller.close();
    },
  });

  await withMockedFetch(async () => {
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  }, async () => {
    const res = await handler(
      new Request("http://proxy/openai/v1/stream", {
        headers: { Authorization: "Bearer pt" },
      }),
    );
    const body = await res.text();
    expect(body).toContain("data: one");
    expect(body).toContain("data: two");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });
});
