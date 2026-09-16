import { afterEach, describe, expect, it } from "bun:test";
import { createProxyHandler } from "../src/proxy";
import { Store, type Settings } from "../src/store";
import { Access } from "../src/access";

const fixtures: { store: Store; access: Access }[] = [];
afterEach(() => {
  for (const { store, access } of fixtures) { access.close(); store.close(); }
  fixtures.length = 0;
});

function makeProxy(overrides: Partial<Settings> = {}) {
  const store = new Store(":memory:", "UTC", "pt", {
    openaiBaseUrl: "https://openai.example", openaiApiKey: "ok",
    anthropicBaseUrl: "https://anthropic.example", anthropicApiKey: "ak",
    ...overrides,
  });
  const access = new Access(store);
  fixtures.push({ store, access });
  return { handler: createProxyHandler(access), store, access, key: store.authenticate("pt")! };
}

async function withMockedFetch<T>(
  mock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = original;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  return input instanceof Request ? input.headers : new Headers(init?.headers);
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
    const { handler } = makeProxy();
    const res = await handler(new Request("http://proxy/openai/v1/test"));
    expect(res.status).toBe(401);
  });

  it("forwards and strips prefix", async () => {
    const { handler } = makeProxy();
    let seenUrl = "";
    await withMockedFetch(async (input) => {
      seenUrl = requestUrl(input);
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

  it("does not rewrite accept-encoding", async () => {
    const { handler } = makeProxy();
    let seenAcceptEncoding: string | null | undefined;

    await withMockedFetch(async (input, init) => {
      seenAcceptEncoding = requestHeaders(input, init).get("accept-encoding");
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
    const { handler } = makeProxy({ openaiBaseUrl: "https://openai.example/openai" });
    let seenUrl = "";
    await withMockedFetch(async (input) => {
      seenUrl = requestUrl(input);
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
    const { handler } = makeProxy();

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
    const { handler } = makeProxy();

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

  it("strips hop-by-hop request headers", async () => {
    const { handler } = makeProxy();
    let seenHeaders = new Headers();

    await withMockedFetch(async (input, init) => {
      seenHeaders = requestHeaders(input, init);
      return new Response("ok", { status: 200 });
    }, async () => {
      await handler(
        new Request("http://proxy/openai/v1/responses", {
          headers: {
            Authorization: "Bearer pt",
            Connection: "keep-alive, x-trace-id",
            "Keep-Alive": "timeout=5",
            TE: "trailers",
            Upgrade: "websocket",
            "X-Trace-Id": "request-hop",
          },
        }),
      );
    });

    expect(seenHeaders.get("connection")).toBeNull();
    expect(seenHeaders.get("keep-alive")).toBeNull();
    expect(seenHeaders.get("te")).toBeNull();
    expect(seenHeaders.get("upgrade")).toBeNull();
    expect(seenHeaders.get("x-trace-id")).toBeNull();
    expect(seenHeaders.get("authorization")).toBe("Bearer ok");
  });

  it("strips hop-by-hop response headers", async () => {
    const { handler } = makeProxy();

    await withMockedFetch(async () => {
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          connection: "keep-alive, x-response-hop",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          "x-response-hop": "response-hop",
        },
      });
    }, async () => {
      const res = await handler(
        new Request("http://proxy/openai/v1/responses", {
          headers: { Authorization: "Bearer pt" },
        }),
      );

      expect(res.headers.get("connection")).toBeNull();
      expect(res.headers.get("keep-alive")).toBeNull();
      expect(res.headers.get("transfer-encoding")).toBeNull();
      expect(res.headers.get("x-response-hop")).toBeNull();
      expect(await res.text()).toBe('{"ok":true}');
    });
  });

  it("strips stale decoded-body response headers", async () => {
    const { handler } = makeProxy();

    await withMockedFetch(async () => {
      return new Response("decoded", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-encoding": "gzip",
          "content-length": "32",
        },
      });
    }, async () => {
      const res = await handler(
        new Request("http://proxy/openai/v1/responses", {
          headers: { Authorization: "Bearer pt" },
        }),
      );

      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("content-length")).toBeNull();
      expect(await res.text()).toBe("decoded");
    });
  });
});

it("streams SSE without buffering", async () => {
  const { handler } = makeProxy();

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

async function within<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Request did not settle after cancellation")), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

describe("request body handling", () => {
  it("preserves compressed JSON bytes and encoding while recording response usage", async () => {
    const { handler, store } = makeProxy();
    const raw = Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ model: "requested", stream: true, messages: [{ role: "user", content: "Hello" }] })));
    let seenBytes: Uint8Array | undefined;
    let seenEncoding = "";
    await withMockedFetch(async (input) => {
      const req = input as Request;
      seenBytes = new Uint8Array(await req.arrayBuffer());
      seenEncoding = req.headers.get("content-encoding") ?? "";
      return Response.json({ model: "actual", usage: { prompt_tokens: 12, completion_tokens: 4 } });
    }, async () => {
      const response = await handler(new Request("http://proxy/openai/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer pt", "content-type": "application/json", "content-encoding": "gzip" }, body: raw,
      }));
      expect(response.status).toBe(200);
      await response.text();
    });
    expect(seenEncoding).toBe("gzip");
    expect(seenBytes).toEqual(new Uint8Array(raw));
    expect(store.stats(store.day(), store.day())[0]).toMatchObject({ model: "actual", input_tokens: 12, output_tokens: 4, unknown: 0 });
  });

  it("leaves invalid UTF-8 JSON untouched for upstream validation", async () => {
    const { handler } = makeProxy();
    const raw = new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]);
    await withMockedFetch(async (input) => {
      expect(new Uint8Array(await (input as Request).arrayBuffer())).toEqual(raw);
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }, async () => {
      const response = await handler(new Request("http://proxy/openai/v1/responses", {
        method: "POST", headers: { authorization: "Bearer pt", "content-type": "application/json" }, body: raw,
      }));
      expect(response.status).toBe(400); await response.text();
    });
  });

  for (const reason of ["pause", "revoke", "expiry", "disconnect", "shutdown"] as const) {
    it(`interrupts stalled JSON uploads on ${reason}`, async () => {
      const { handler, store, access, key } = makeProxy();
      let canceled = false, forwarded = false;
      const client = new AbortController();
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode('{"model":')); },
        cancel() {
          canceled = true;
          // A slow source cleanup must not delay cancellation of the request.
          return new Promise<void>(() => {});
        },
      });
      await withMockedFetch(async () => { forwarded = true; throw new Error("Paused upload must never reach upstream"); }, async () => {
        const pending = handler(new Request("http://proxy/openai/v1/responses", {
          method: "POST", signal: client.signal, headers: { authorization: "Bearer pt", "content-type": "application/json" }, body,
        }));
        if (reason === "pause" || reason === "revoke") {
          store.updateKey(key.id, { state: reason === "pause" ? "paused" : "revoked" }); access.changed();
        } else if (reason === "expiry") {
          store.updateKey(key.id, { state: "open", expiresAt: Date.now() + 30 }); access.changed();
        } else if (reason === "disconnect") client.abort();
        else access.close();
        expect((await within(pending)).status).toBe(403);
      });
      expect(canceled).toBe(true);
      expect(forwarded).toBe(false);
      expect(store.stats(store.day(), store.day())).toEqual([]);
    });
  }

  it("treats imported legacy tokens as managed keys without an authentication bypass", async () => {
    const { handler, store, key } = makeProxy();
    store.updateKey(key.id, { state: "paused" });
    expect((await handler(new Request("http://proxy/openai/v1/models", { headers: { authorization: "Bearer pt" } }))).status).toBe(403);
    store.updateKey(key.id, { state: "revoked" });
    expect((await handler(new Request("http://proxy/openai/v1/models", { headers: { authorization: "Bearer pt" } }))).status).toBe(401);
  });
});
