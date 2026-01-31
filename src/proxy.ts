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

    const upstreamPath = url.pathname.slice(prefix.length);
    const upstreamUrl = buildUpstreamUrl(upstreamBase, upstreamPath, url.search);

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
