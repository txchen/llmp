import type { Access } from "./access";
import { UsageObserver } from "./usage";

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

type LogLevel = "info" | "warn" | "error";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

function stripHopByHopHeaders(headers: Headers): void {
  const connection = headers.get("connection");
  if (connection) {
    for (const name of connection.split(",")) {
      const trimmed = name.trim();
      if (trimmed) headers.delete(trimmed);
    }
  }

  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
}

function stripDecodedBodyHeaders(headers: Headers): void {
  if (!headers.has("content-encoding")) return;

  headers.delete("content-encoding");
  headers.delete("content-length");
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

function badRequest(): Response {
  return new Response(JSON.stringify({ error: "invalid_request_url" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function buildUpstreamUrl(base: string, path: string, search: string): URL {
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/$/, "");
  const relPath = path.startsWith("/") ? path : `/${path}`;
  const combinedPath = basePath === "" || basePath === "/" ? relPath : `${basePath}${relPath}`;

  baseUrl.pathname = combinedPath;
  baseUrl.search = search;
  baseUrl.hash = "";
  return baseUrl;
}

// Cancel the reader rather than only aborting the later upstream fetch. Cancellation
// settles pending reads even if the sender never finishes uploading its JSON body.
async function readRequestBody(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Buffer<ArrayBuffer>> {
  if (!body) { signal.throwIfAborted(); return Buffer.alloc(0); }
  const reader = body.getReader();
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return Buffer.concat(chunks, length);
      chunks.push(value);
      length += value.length;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export function createProxyHandler(access: Access) {
  return async function handle(req: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    let url: URL;
    try {
      url = new URL(req.url);
    } catch (error) {
      log("warn", "proxy.invalid_request_url", {
        requestId,
        method: req.method,
        rawUrl: req.url,
        error: toErrorMessage(error),
      });
      return badRequest();
    }

    if (url.pathname === "/healthz") return new Response("ok");

    const auth = req.headers.get("authorization");
    const key = auth?.startsWith("Bearer ") ? access.store.authenticate(auth.slice(7)) : null;
    if (!key || key.state === "revoked") {
      log("warn", "proxy.unauthorized", {
        requestId,
        method: req.method,
        path: url.pathname,
      });
      return unauthorized();
    }

    if (!access.store.allowed(key)) {
      return Response.json({ error: "key_paused" }, { status: 403 });
    }

    const settings = access.store.getSettings();
    let upstreamBase: string;
    let provider: "openai" | "anthropic";
    let prefix: "/openai" | "/anthropic";
    if (url.pathname.startsWith("/openai/")) {
      upstreamBase = settings.openaiBaseUrl;
      provider = "openai";
      prefix = "/openai";
    } else if (url.pathname.startsWith("/anthropic/")) {
      upstreamBase = settings.anthropicBaseUrl;
      provider = "anthropic";
      prefix = "/anthropic";
    } else {
      log("warn", "proxy.unsupported_path", {
        requestId,
        method: req.method,
        path: url.pathname,
      });
      return new Response("not found", { status: 404 });
    }

    let upstreamUrl: URL;
    if (!(provider === "openai" ? settings.openaiApiKey : settings.anthropicApiKey)) {
      return Response.json({ error: "provider_not_configured", message: "Ask your administrator to configure the upstream API key in Settings" }, { status: 503 });
    }
    try {
      upstreamUrl = buildUpstreamUrl(upstreamBase, url.pathname.slice(prefix.length), url.search);
    } catch (error) {
      log("error", "proxy.upstream_url_build_failed", {
        requestId,
        provider,
        path: url.pathname,
        error: toErrorMessage(error),
      });
      return badGateway();
    }

    const upstreamHeaders = new Headers(req.headers);
    upstreamHeaders.delete("host");
    upstreamHeaders.delete("content-length");
    upstreamHeaders.delete("authorization");
    upstreamHeaders.delete("cookie");
    upstreamHeaders.delete("x-api-key");
    stripHopByHopHeaders(upstreamHeaders);

    if (provider === "openai") {
      upstreamHeaders.set("authorization", `Bearer ${settings.openaiApiKey}`);
    } else {
      upstreamHeaders.set("x-api-key", settings.anthropicApiKey);
      if (settings.anthropicVersion && !upstreamHeaders.get("anthropic-version")) {
        upstreamHeaders.set("anthropic-version", settings.anthropicVersion);
      }
    }

    const method = req.method.toUpperCase();
    const forwardStartMs = Date.now();
    log("info", "proxy.forward_start", {
      requestId,
      provider,
      method,
      path: url.pathname,
      contentLength: req.headers.get("content-length"),
      upstreamUrl: upstreamUrl.toString(),
    });

    const lease = access.enroll(key.id);
    const controller = lease.controller;
    const clientAbort = () => controller.abort(new Error("client_disconnected"));
    req.signal.addEventListener("abort", clientAbort, { once: true });
    if (req.signal.aborted) clientAbort();
    let recorded = false;
    let finished = false;
    let observer: UsageObserver | undefined;
    const finish = (outcome: string) => {
      if (finished) return;
      finished = true;
      if (recorded) access.store.finishRequest(requestId, observer?.usage ?? null, outcome);
      lease.release();
      req.signal.removeEventListener("abort", clientAbort);
      controller.signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => finish("interrupted");
    controller.signal.addEventListener("abort", onAbort, { once: true });

    try {
      let body: BodyInit | null | undefined = method === "GET" || method === "HEAD" ? undefined : req.body;
      let model = "unknown";
      const measured = method === "POST" && /\/(chat\/completions|completions|responses|messages|embeddings)\/?$/.test(url.pathname);
      // Compressed bodies stay opaque: preserve their bytes and Content-Encoding.
      const encoding = req.headers.get("content-encoding")?.trim().toLowerCase();
      const plainJson = (!encoding || encoding === "identity") && req.headers.get("content-type")?.includes("application/json");
      if (measured && plainJson) {
        const raw = await readRequestBody(req.body, controller.signal);
        body = raw;
        try {
          const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
          if (typeof payload.model === "string") model = payload.model;
          if (provider === "openai" && /\/(chat\/completions|completions)\/?$/.test(url.pathname) && payload.stream === true) {
            payload.stream_options = { ...payload.stream_options, include_usage: true };
            body = JSON.stringify(payload);
          }
        } catch { /* Let the provider validate malformed JSON. */ }
      }
      if (!access.store.allowed(access.store.getKey(key.id)!)) controller.abort(new Error("key_disabled"));
      if (controller.signal.aborted) {
        finish("interrupted");
        return Response.json({ error: "request_cancelled" }, { status: 403 });
      }
      access.store.touch(key.id);
      if (measured) {
        access.store.startRequest(requestId, key.id, provider, model, forwardStartMs);
        recorded = true;
      }
      const upstreamRequest = new Request(upstreamUrl, {
        method,
        headers: upstreamHeaders,
        body,
        signal: controller.signal,
        redirect: "manual",
      });
      const res = await fetch(upstreamRequest);

      log("info", "proxy.forward_success", {
        requestId,
        provider,
        method,
        path: url.pathname,
        status: res.status,
        durationMs: Date.now() - forwardStartMs,
      });

      if (controller.signal.aborted) {
        void res.body?.cancel().catch(() => {});
        throw controller.signal.reason;
      }
      if (recorded) observer = new UsageObserver(provider, res.headers.get("content-type")?.includes("text/event-stream") ?? false, model);
      const responseHeaders = new Headers(res.headers);
      stripHopByHopHeaders(responseHeaders);
      stripDecodedBodyHeaders(responseHeaders);

      if (!res.body) {
        finish("completed");
        return new Response(null, { status: res.status, statusText: res.statusText, headers: responseHeaders });
      }
      const reader = res.body.getReader();
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      let ended = false;
      const abortStream = () => {
        if (ended) return;
        ended = true;
        streamController.error(controller.signal.reason);
        void reader.cancel(controller.signal.reason).catch(() => {});
        finish("interrupted");
        controller.signal.removeEventListener("abort", abortStream);
      };
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          streamController = c;
          controller.signal.addEventListener("abort", abortStream, { once: true });
          if (controller.signal.aborted) abortStream();
        },
        async pull(c) {
          try {
            const { done, value } = await reader.read();
            if (ended) return;
            if (done) {
              observer?.end();
              ended = true;
              finish("completed");
              controller.signal.removeEventListener("abort", abortStream);
              c.close();
            } else {
              observer?.feed(value);
              c.enqueue(value);
            }
          } catch (error) {
            if (ended) return;
            ended = true;
            finish("failed");
            controller.signal.removeEventListener("abort", abortStream);
            c.error(error);
          }
        },
        cancel(reason) {
          ended = true;
          controller.signal.removeEventListener("abort", abortStream);
          controller.abort(reason);
          finish("interrupted");
          return reader.cancel(reason);
        },
      });
      return new Response(stream, {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      finish(controller.signal.aborted ? "interrupted" : "failed");
      if (controller.signal.aborted) return Response.json({ error: "request_cancelled" }, { status: 403 });
      log("error", "proxy.forward_failed", {
        requestId,
        provider,
        method,
        path: url.pathname,
        upstreamUrl: upstreamUrl.toString(),
        durationMs: Date.now() - forwardStartMs,
        error: toErrorMessage(error),
      });
      return badGateway();
    }
  };
}
