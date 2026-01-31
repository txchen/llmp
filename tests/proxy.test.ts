import { describe, expect, it } from "bun:test";
import { createProxyHandler } from "../src/proxy";
import type { Config } from "../src/config";

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

describe("proxy", () => {
  it("rejects missing token", async () => {
    const cfg: Config = {
      openaiBaseUrl: "https://openai.example",
      openaiApiKey: "ok",
      anthropicBaseUrl: "https://anthropic.example",
      anthropicApiKey: "ak",
      proxyToken: "pt",
      port: 33000,
    };
    const handler = createProxyHandler(cfg);
    const res = await handler(new Request("http://proxy/openai/v1/test"));
    expect(res.status).toBe(401);
  });

  it("forwards and strips prefix", async () => {
    const cfg: Config = {
      openaiBaseUrl: "https://openai.example",
      openaiApiKey: "ok",
      anthropicBaseUrl: "https://anthropic.example",
      anthropicApiKey: "ak",
      proxyToken: "pt",
      port: 33000,
    };
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

  it("preserves base path when forwarding", async () => {
    const cfg: Config = {
      openaiBaseUrl: "https://openai.example/openai",
      openaiApiKey: "ok",
      anthropicBaseUrl: "https://anthropic.example",
      anthropicApiKey: "ak",
      proxyToken: "pt",
      port: 33000,
    };
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
});

it("streams SSE without buffering", async () => {
  const cfg: Config = {
    openaiBaseUrl: "https://openai.example",
    openaiApiKey: "ok",
    anthropicBaseUrl: "https://anthropic.example",
    anthropicApiKey: "ak",
    proxyToken: "pt",
    port: 33000,
  };
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
