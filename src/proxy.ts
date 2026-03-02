import type { Config } from "./config";

const REQUEST_DROP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "authorization",
]);

const RESPONSE_DROP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "content-encoding",
]);

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

function filterHeaders(
  headers: Headers,
  dropHeaders: Set<string>,
  extra?: Record<string, string>,
): Headers {
  const out = new Headers();
  for (const [k, v] of headers.entries()) {
    if (dropHeaders.has(k.toLowerCase())) continue;
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

    let upstreamBase: string | null = null;
    let prefix = "";
    if (url.pathname.startsWith("/openai/")) {
      upstreamBase = cfg.openaiBaseUrl;
      prefix = "/openai";
    } else if (url.pathname.startsWith("/anthropic/")) {
      upstreamBase = cfg.anthropicBaseUrl;
      prefix = "/anthropic";
    } else {
      log("warn", "proxy.unsupported_path", {
        requestId,
        method: req.method,
        path: url.pathname,
      });
      return new Response("not found", { status: 404 });
    }

    const upstreamPath = url.pathname.slice(prefix.length);
    const provider = prefix.slice(1);
    let upstreamUrl: URL;
    try {
      upstreamUrl = buildUpstreamUrl(upstreamBase, upstreamPath, url.search);
    } catch (error) {
      log("error", "proxy.upstream_url_build_failed", {
        requestId,
        provider,
        path: url.pathname,
        error: toErrorMessage(error),
      });
      return badGateway();
    }

    const extraHeaders: Record<string, string> =
      prefix === "/openai" ? { Authorization: `Bearer ${cfg.openaiApiKey}` } : { "x-api-key": cfg.anthropicApiKey };

    if (prefix === "/anthropic" && cfg.anthropicVersion && !req.headers.get("anthropic-version")) {
      extraHeaders["anthropic-version"] = cfg.anthropicVersion;
    }

    const forwardStartMs = Date.now();
    log("info", "proxy.forward_start", {
      requestId,
      provider,
      method: req.method,
      path: url.pathname,
      contentLength: req.headers.get("content-length"),
      upstreamUrl: upstreamUrl.toString(),
    });

    try {
      const res = await fetch(upstreamUrl, {
        method: req.method,
        headers: filterHeaders(req.headers, REQUEST_DROP_HEADERS, extraHeaders),
        body: req.body,
        duplex: "half",
      } as RequestInit);

      log("info", "proxy.forward_success", {
        requestId,
        provider,
        method: req.method,
        path: url.pathname,
        status: res.status,
        durationMs: Date.now() - forwardStartMs,
      });

      const outHeaders = filterHeaders(res.headers, RESPONSE_DROP_HEADERS);
      return new Response(res.body, {
        status: res.status,
        headers: outHeaders,
      });
    } catch (error) {
      log("error", "proxy.forward_failed", {
        requestId,
        provider,
        method: req.method,
        path: url.pathname,
        upstreamUrl: upstreamUrl.toString(),
        durationMs: Date.now() - forwardStartMs,
        error: toErrorMessage(error),
      });
      return badGateway();
    }
  };
}
