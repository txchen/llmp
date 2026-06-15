import type { Config } from "./config";

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

export function createProxyHandler(cfg: Config) {
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
    if (auth !== `Bearer ${cfg.proxyToken}`) {
      log("warn", "proxy.unauthorized", {
        requestId,
        method: req.method,
        path: url.pathname,
      });
      return unauthorized();
    }

    let upstreamBase: string;
    let provider: "openai" | "anthropic";
    let prefix: "/openai" | "/anthropic";
    if (url.pathname.startsWith("/openai/")) {
      upstreamBase = cfg.openaiBaseUrl;
      provider = "openai";
      prefix = "/openai";
    } else if (url.pathname.startsWith("/anthropic/")) {
      upstreamBase = cfg.anthropicBaseUrl;
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
    stripHopByHopHeaders(upstreamHeaders);

    if (provider === "openai") {
      upstreamHeaders.set("authorization", `Bearer ${cfg.openaiApiKey}`);
    } else {
      upstreamHeaders.set("x-api-key", cfg.anthropicApiKey);
      if (cfg.anthropicVersion && !upstreamHeaders.get("anthropic-version")) {
        upstreamHeaders.set("anthropic-version", cfg.anthropicVersion);
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

    try {
      const upstreamRequest = new Request(upstreamUrl, {
        method,
        headers: upstreamHeaders,
        body: method === "GET" || method === "HEAD" ? undefined : req.body,
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

      const responseHeaders = new Headers(res.headers);
      stripHopByHopHeaders(responseHeaders);
      stripDecodedBodyHeaders(responseHeaders);

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
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
