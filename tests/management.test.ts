import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { Store } from "../src/store";
import { UsageObserver } from "../src/usage";
import type { Config } from "../src/config";

const config: Config = {
  openaiBaseUrl: "https://openai.example", openaiApiKey: "upstream-openai",
  anthropicBaseUrl: "https://anthropic.example", anthropicApiKey: "upstream-anthropic",
  adminPassword: "test-admin-password", databasePath: ":memory:", timezone: "America/Los_Angeles",
  port: 33000, idleTimeoutSeconds: 255, maxRequestBodySizeBytes: 1024 * 1024,
};
let apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps) app.close(); apps = []; });
function app(overrides: Partial<Config> = {}) { const a = createApp({ ...config, ...overrides }); apps.push(a); return a; }
function adminReq(path: string, method = "GET", body?: unknown, cookie = "", origin = "http://proxy") {
  return new Request("http://proxy/admin/api/" + path, { method, headers: { origin, cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function login(a: ReturnType<typeof app>) {
  const res = await a.fetch(adminReq("login", "POST", { password: config.adminPassword }));
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}
function request(token: string, provider = "openai", path = "responses", signal?: AbortSignal) {
  return new Request(`http://proxy/${provider}/v1/${path}`, { method: "POST", signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", cookie: "llmp_session=secret", "x-api-key": "client-secret" }, body: JSON.stringify({ model: "test-model", input: "hi", stream: true }) });
}
async function mocked(fn: typeof fetch, work: () => Promise<void>) {
  const previous = globalThis.fetch; globalThis.fetch = fn;
  try { await work(); } finally { globalThis.fetch = previous; }
}
const encoder = new TextEncoder();
const frame = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

describe("administration", () => {
  it("requires password and keeps members separate from admin sessions", async () => {
    expect(() => createApp({ ...config, adminPassword: undefined })).toThrow("ADMIN_PASSWORD");
    const a = app();
    const member = a.store.createKey("child");
    expect((await a.fetch(adminReq("keys"))).status).toBe(401);
    expect((await a.fetch(new Request("http://proxy/admin/api/keys", { headers: { authorization: `Bearer ${member.token}` } }))).status).toBe(401);
    expect((await a.fetch(adminReq("login", "POST", { password: "wrong" }))).status).toBe(401);
    expect((await a.fetch(adminReq("login", "POST", { password: config.adminPassword }, "", "http://evil"))).status).toBe(403);
    const cookie = await login(a);
    expect((await a.fetch(adminReq("keys", "GET", undefined, cookie))).status).toBe(200);
    expect((await a.fetch(adminReq("logout", "POST", {}, cookie))).status).toBe(200);
    expect((await a.fetch(adminReq("keys", "GET", undefined, cookie))).status).toBe(401);
  });
  it("creates once-visible secrets, opens for three hours, pauses, renames and revokes", async () => {
    const a = app(), cookie = await login(a);
    const create = await a.fetch(adminReq("keys", "POST", { name: "Child" }, cookie));
    const { key, token } = await create.json();
    expect(key.state).toBe("paused");
    const listing = await (await a.fetch(adminReq("keys", "GET", undefined, cookie))).text();
    expect(listing).not.toContain(token); expect(listing).not.toContain('"hash"');
    expect((await a.fetch(request(token))).status).toBe(403);
    const change = (body: unknown, origin?: string) => a.fetch(adminReq("keys/" + key.id, "PATCH", body, cookie, origin));
    expect((await change({ action: "open", durationMinutes: 180 }, "http://evil")).status).toBe(403);
    for (const value of [-1, 0, 1.5, "180", undefined, 525601]) expect((await change({ action: "open", durationMinutes: value })).status).toBe(400);
    expect((await change({ action: "open", durationMinutes: 180 })).status).toBe(200);
    expect(a.store.getKey(key.id)!.expires_at! - Date.now()).toBeGreaterThan(179 * 60_000);
    await change({ action: "open", durationMinutes: null });
    expect(a.store.getKey(key.id)!.expires_at).toBeNull();
    await change({ action: "rename", name: "Tablet" }); expect(a.store.getKey(key.id)!.name).toBe("Tablet");
    await change({ action: "pause" }); expect((await a.fetch(request(token))).status).toBe(403);
    await change({ action: "revoke" }); expect((await a.fetch(request(token))).status).toBe(401);
    expect((await change({ action: "open", durationMinutes: null })).status).toBe(400);
  });
  it("limits password guesses", async () => {
    const a = app();
    for (let i = 0; i < 10; i++) await a.fetch(adminReq("login", "POST", { password: "wrong" }), "1.2.3.4");
    expect((await a.fetch(adminReq("login", "POST", { password: config.adminPassword }), "1.2.3.4")).status).toBe(429);
  });
  it("validates usage query dates", async () => {
    const a = app(), cookie = await login(a);
    expect((await a.fetch(adminReq("usage?from=2026-02-30", "GET", undefined, cookie))).status).toBe(400);
    expect((await a.fetch(adminReq("usage?from=2026-03-02&to=2026-03-01", "GET", undefined, cookie))).status).toBe(400);
  });
});

describe("persistent keys and daily usage", () => {
  it("imports legacy key once and preserves deadlines, revocation and usage across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmp-test-")), path = join(dir, "state.sqlite");
    let s = new Store(path, "America/Los_Angeles", "old-token");
    try {
      const key = s.authenticate("old-token")!;
      s.updateKey(key.id, { state: "revoked" });
      const timed = s.createKey("timed");
      s.updateKey(timed.key.id, { state: "open", expiresAt: Date.now() - 1 });
      const time = Date.parse("2026-09-16T01:00:00Z");
      s.startRequest("r1", key.id, "openai", "model", time);
      s.finishRequest("r1", { model: "model", input: 20, output: 7 }, "completed");
      s.finishRequest("r1", { model: "model", input: 999, output: 999 }, "completed");
      s.startRequest("pending", key.id, "openai", "model", time);
      s.close(); s = new Store(path, "America/Los_Angeles", "new-env-token");
      expect(s.authenticate("new-env-token")).toBeNull();
      expect(s.authenticate("old-token")!.state).toBe("revoked");
      expect(s.allowed(s.authenticate(timed.token)!)).toBe(false);
      const rows = s.stats("2026-09-15", "2026-09-15") as any[];
      expect(rows[0]).toMatchObject({ input_tokens: 20, output_tokens: 7, unknown: 1, pending: 0 });
      expect(s.stats("2026-09-16", "2026-09-16")).toHaveLength(0);
    } finally { s.close(); rmSync(dir, { recursive: true }); }
  });
});

describe("live proxy access", () => {
  it("pauses all streams for one key while other keys continue; strips local credentials", async () => {
    const a = app(), first = a.store.createKey("first"), other = a.store.createKey("other");
    for (const k of [first, other]) a.store.updateKey(k.key.id, { state: "open" });
    const signals: AbortSignal[] = [];
    let cancels = 0;
    await mocked((async (input: Request) => {
      expect(input.headers.get("cookie")).toBeNull(); expect(input.headers.get("x-api-key")).toBeNull();
      expect(input.headers.get("authorization")).toBe("Bearer upstream-openai");
      signals.push(input.signal);
      return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode("data: {}\n\n")); }, cancel() { cancels++; } }), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch, async () => {
      const responses = await Promise.all([a.fetch(request(first.token)), a.fetch(request(first.token)), a.fetch(request(other.token))]);
      const readers = responses.map(r => r.body!.getReader());
      for (const reader of readers) await reader.read();
      const cookie = await login(a);
      await a.fetch(adminReq("keys/" + first.key.id, "PATCH", { action: "pause" }, cookie));
      for (const reader of readers.slice(0, 2)) await expect(reader.read()).rejects.toThrow();
      expect(signals.map(s => s.aborted)).toEqual([true, true, false]);
      expect(cancels).toBe(2);
      expect((await a.fetch(request(first.token))).status).toBe(403);
      await readers[2].cancel();
      const rows = a.store.stats(a.store.day(), a.store.day(), first.key.id) as any[];
      expect(rows[0]).toMatchObject({ unknown: 2, pending: 0 });
    });
  });
  it("automatically aborts at deadline and records unknown usage", async () => {
    const a = app(), { key, token } = a.store.createKey("timed");
    a.store.updateKey(key.id, { state: "open", expiresAt: Date.now() + 80 }); a.access.changed();
    await mocked((async () => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode("data: {}\n\n")); } }), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch, async () => {
      const res = await a.fetch(request(token)); const reader = res.body!.getReader(); await reader.read();
      await expect(reader.read()).rejects.toThrow("key_disabled");
      expect((await a.fetch(request(token))).status).toBe(403);
      expect((a.store.stats(a.store.day(), a.store.day()) as any[])[0].unknown).toBe(1);
    });
  });
  it("aborts while waiting for upstream headers", async () => {
    const a = app(), { key, token } = a.store.createKey("waiting"); a.store.updateKey(key.id, { state: "open" });
    let began!: () => void; const ready = new Promise<void>(resolve => began = resolve);
    await mocked((async (input: Request) => new Promise<Response>((_, reject) => { input.signal.addEventListener("abort", () => reject(input.signal.reason)); began(); })) as unknown as typeof fetch, async () => {
      const pending = a.fetch(request(token)); await ready;
      a.store.updateKey(key.id, { state: "paused" }); a.access.changed();
      expect((await pending).status).toBe(403);
    });
  });
  it("records final OpenAI usage once and requests usage for chat streams", async () => {
    const a = app(), { key, token } = a.store.createKey("child"); a.store.updateKey(key.id, { state: "open" });
    await mocked((async (input: Request) => {
      const body = await input.json(); expect(body.stream_options.include_usage).toBe(true);
      const bytes = frame({ model: "actual-model", choices: [], usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } });
      return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 10)); c.enqueue(bytes.slice(10)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch, async () => {
      const res = await a.fetch(request(token, "openai", "chat/completions")); expect(await res.text()).toContain("actual-model");
      const rows = a.store.stats(a.store.day(), a.store.day()) as any[];
      expect(rows[0]).toMatchObject({ model: "actual-model", input_tokens: 100, output_tokens: 25, unknown: 0 });
    });
  });
  it("client disconnect aborts upstream and never counts missing usage as zero", async () => {
    const a = app(), { key, token } = a.store.createKey("child"); a.store.updateKey(key.id, { state: "open" });
    const client = new AbortController(); let upstreamSignal: AbortSignal;
    await mocked((async (input: Request) => { upstreamSignal = input.signal; return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode("partial")); } })); }) as unknown as typeof fetch, async () => {
      const res = await a.fetch(request(token, "openai", "responses", client.signal));
      const reader = res.body!.getReader(); await reader.read(); client.abort();
      await expect(reader.read()).rejects.toThrow(); expect(upstreamSignal.aborted).toBe(true);
      expect((a.store.stats(a.store.day(), a.store.day()) as any[])[0].unknown).toBe(1);
    });
  });
});

describe("usage parser", () => {
  it("handles Responses terminal events, JSON and cached Anthropic input", () => {
    const response = new UsageObserver("openai", true, "fallback");
    response.feed(frame({ type: "response.completed", response: { model: "gpt", usage: { input_tokens: 90, output_tokens: 11, input_tokens_details: { cached_tokens: 30 } } } }));
    expect(response.usage).toEqual({ model: "gpt", input: 90, output: 11 });
    const plain = new UsageObserver("anthropic", false, "fallback");
    plain.feed(encoder.encode(JSON.stringify({ model: "claude", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 } }))); plain.end();
    expect(plain.usage).toEqual({ model: "claude", input: 60, output: 5 });
  });
  it("uses cumulative Anthropic output and treats incomplete streams as unknown", () => {
    const o = new UsageObserver("anthropic", true, "fallback");
    const events = [
      { type: "message_start", message: { model: "claude", usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 1 } } },
      { type: "message_delta", usage: { output_tokens: 5 } },
      { type: "message_delta", usage: { output_tokens: 8 } },
    ];
    for (const event of events) for (const byte of frame(event)) o.feed(new Uint8Array([byte]));
    expect(o.usage).toBeNull(); o.feed(frame({ type: "message_stop" }));
    expect(o.usage).toEqual({ model: "claude", input: 30, output: 8 });
  });
  it("handles CRLF framing and rejects malformed token counts", () => {
    const o = new UsageObserver("openai", true, "m");
    const bytes = encoder.encode('data: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\r\n\r\n');
    for (const byte of bytes) o.feed(new Uint8Array([byte]));
    expect(o.usage).toEqual({ model: "m", input: 3, output: 4 });
    const invalid = new UsageObserver("openai", false, "m"); invalid.feed(encoder.encode('{"usage":{"input_tokens":-1,"output_tokens":2}}')); invalid.end(); expect(invalid.usage).toBeNull();
  });
});

describe("upstream settings", () => {
  it("starts without upstream keys, applies settings live, and never returns upstream secrets", async () => {
    const a = app({ openaiApiKey: "", anthropicApiKey: "" });
    const member = a.store.createKey("Member");
    a.store.updateKey(member.key.id, { state: "open" });
    expect((await a.fetch(request(member.token))).status).toBe(503);
    expect((await a.fetch(adminReq("settings"))).status).toBe(401);
    const cookie = await login(a);
    const change = (body: unknown, origin = "http://proxy") => a.fetch(adminReq("settings", "PATCH", body, cookie, origin));
    expect((await change({ openai: { apiKey: "secret" } }, "http://evil")).status).toBe(403);
    expect((await change({ openai: { baseUrl: "https://custom.example/api", apiKey: "saved-secret" }, usageFlushMinutes: 15 })).status).toBe(200);
    const settings = await (await a.fetch(adminReq("settings", "GET", undefined, cookie))).text();
    expect(settings).not.toContain("saved-secret");
    expect(JSON.parse(settings)).toMatchObject({ openai: { configured: true, baseUrl: "https://custom.example/api" }, usageFlushMinutes: 15 });
    await mocked((async (input: Request) => {
      expect(input.url).toBe("https://custom.example/api/v1/responses");
      expect(input.headers.get("authorization")).toBe("Bearer saved-secret");
      return Response.json({ model: "actual-model", usage: { input_tokens: 30, output_tokens: 4 } });
    }) as unknown as typeof fetch, async () => { await (await a.fetch(request(member.token))).text(); });
    const usage = await (await a.fetch(adminReq("usage?model=actual-model", "GET", undefined, cookie))).json();
    expect(usage.rows[0]).toMatchObject({ model: "actual-model", input_tokens: 30, output_tokens: 4 });
    expect((await (await a.fetch(adminReq("usage?model=other-model", "GET", undefined, cookie))).json()).rows).toEqual([]);
    await change({ openai: { apiKey: "" } }); expect(a.store.getSettings().openaiApiKey).toBe("saved-secret");
    await change({ openai: { apiKey: null } }); expect((await a.fetch(request(member.token))).status).toBe(503);
  });
  it("rejects invalid settings without partially applying valid fields", async () => {
    const a = app(), cookie = await login(a);
    for (const body of [
      { openai: { baseUrl: "file:///tmp/key" } },
      { openai: { baseUrl: "https://user:password@example.com" } },
      { timezone: "Not/A_Timezone" }, { usageFlushMinutes: 0 }, { usageFlushMinutes: "10" },
      { openai: { apiKey: "secret\nheader" } },
    ]) {
      const before = a.store.getSettings();
      expect((await a.fetch(adminReq("settings", "PATCH", body, cookie))).status).toBe(400);
      expect(a.store.getSettings()).toEqual(before);
    }
  });
});
