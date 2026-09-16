import { timingSafeEqual } from "node:crypto";
import type { Access } from "./access";
import html from "./ui.html" with { type: "text" };
import script from "./ui.js" with { type: "text" };

const SESSION_MS = 12 * 60 * 60 * 1000;
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest();
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new Error("A JSON request is required");
  const reader = req.body?.getReader();
  if (!reader) throw new Error("Request body is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16_384) { await reader.cancel(); throw new Error("Request body is too large"); }
    chunks.push(value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  return value;
}

export function createAdminHandler(access: Access, password: string, configuredOrigin?: string) {
  const passwordHash = hash(password);
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; until: number }>();
  const store = access.store;
  return async (req: Request, remoteIp = "local"): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = configuredOrigin ?? url.origin;
    const secure = new URL(origin).protocol === "https:";
    const cookie = (value: string, seconds: number) => `llmp_session=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? "; Secure" : ""}`;
    if (req.method === "GET" && ["/admin", "/admin/", "/admin/app.js"].includes(path)) {
      // The explicit text loader embeds HTML as a string, rather than an HTMLBundle.
      return new Response(path === "/admin/app.js" ? script : String(html), { headers: {
        "content-type": path === "/admin/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
        "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      } });
    }
    if (!path.startsWith("/admin/api/")) return json({ error: "not_found" }, 404);
    if (!["GET", "POST", "PATCH"].includes(req.method)) return json({ error: "method_not_allowed" }, 405);
    if (req.method !== "GET" && req.headers.get("origin") !== origin) return json({ error: "Request origin does not match" }, 403);
    const now = Date.now();
    for (const [id, expiry] of sessions) if (expiry <= now) sessions.delete(id);
    for (const [ip, limit] of attempts) if (limit.until <= now) attempts.delete(ip);
    const session = req.headers.get("cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith("llmp_session="))?.slice(13);
    if (path === "/admin/api/login" && req.method === "POST") {
      const limit = attempts.get(remoteIp) ?? { count: 0, until: now + 5 * 60_000 };
      if (limit.count >= 10 || (!attempts.has(remoteIp) && attempts.size >= 1000)) return json({ error: "Too many login attempts. Try again in 5 minutes" }, 429);
      limit.count++;
      attempts.set(remoteIp, limit);
      try {
        const body = await readJson(req);
        if (typeof body.password !== "string" || !timingSafeEqual(hash(body.password), passwordHash)) return json({ error: "Incorrect password" }, 401);
      } catch { return json({ error: "Invalid login request" }, 400); }
      attempts.delete(remoteIp);
      if (session) sessions.delete(session);
      if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      sessions.set(token, now + SESSION_MS);
      const res = json({ ok: true });
      res.headers.set("set-cookie", cookie(token, SESSION_MS / 1000));
      return res;
    }
    if (!session || !sessions.has(session)) return json({ error: "Please sign in" }, 401);
    try {
      if (path === "/admin/api/logout" && req.method === "POST") {
        sessions.delete(session);
        const res = json({ ok: true });
        res.headers.set("set-cookie", cookie("", 0));
        return res;
      }
      if (path === "/admin/api/settings" && req.method === "GET") {
        const s = store.getSettings();
        return json({
          openai: { baseUrl: s.openaiBaseUrl, configured: !!s.openaiApiKey },
          anthropic: { baseUrl: s.anthropicBaseUrl, configured: !!s.anthropicApiKey, version: s.anthropicVersion },
          timezone: s.timezone, usageFlushMinutes: s.usageFlushMinutes,
        });
      }
      if (path === "/admin/api/settings" && req.method === "PATCH") {
        const body = await readJson(req);
        const next = store.getSettings();
        for (const provider of ["openai", "anthropic"] as const) {
          if (body[provider] === undefined) continue;
          const change = body[provider];
          if (!change || typeof change !== "object" || Array.isArray(change)) throw new Error("Invalid upstream settings");
          const fields = change as Record<string, unknown>;
          if (fields.baseUrl !== undefined) {
            if (typeof fields.baseUrl !== "string" || !fields.baseUrl.trim() || fields.baseUrl.length > 2048) throw new Error("Enter a valid upstream URL");
            next[`${provider}BaseUrl`] = fields.baseUrl.trim();
          }
          if (fields.apiKey !== undefined && fields.apiKey !== "") {
            if (fields.apiKey === null) next[`${provider}ApiKey`] = "";
            else if (typeof fields.apiKey === "string" && fields.apiKey.trim() && fields.apiKey.length <= 4096 && !/[\r\n]/.test(fields.apiKey)) next[`${provider}ApiKey`] = fields.apiKey.trim();
            else throw new Error("Enter a valid API key");
          }
          if (provider === "anthropic" && fields.version !== undefined) {
            if (typeof fields.version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fields.version)) throw new Error("Anthropic version must use YYYY-MM-DD");
            next.anthropicVersion = fields.version;
          }
        }
        if (body.timezone !== undefined) {
          if (typeof body.timezone !== "string" || !body.timezone.trim()) throw new Error("Enter a valid timezone");
          next.timezone = body.timezone.trim();
        }
        if (body.usageFlushMinutes !== undefined) {
          if (typeof body.usageFlushMinutes !== "number") throw new Error("Enter a valid flush interval");
          next.usageFlushMinutes = body.usageFlushMinutes;
        }
        store.updateSettings(next);
        return json({ ok: true });
      }
      if (path === "/admin/api/keys" && req.method === "GET") {
        const settings = store.getSettings();
        return json({ keys: store.listKeys().map(k => ({ ...k, active: store.allowed(k) })), timezone: store.timezone, today: store.day(), now, providersConfigured: !!(settings.openaiApiKey || settings.anthropicApiKey) });
      }
      if (path === "/admin/api/keys" && req.method === "POST") {
        const body = await readJson(req);
        if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) throw new Error("Name must be between 1 and 80 characters");
        return json(store.createKey(body.name.trim()), 201);
      }
      const match = /^\/admin\/api\/keys\/([^/]+)$/.exec(path);
      if (match && req.method === "PATCH") {
        const body = await readJson(req);
        const id = match[1];
        if (!store.getKey(id)) return json({ error: "Key not found" }, 404);
        if (body.action === "rename") {
          if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) throw new Error("Name must be between 1 and 80 characters");
          store.updateKey(id, { name: body.name.trim() });
        } else if (body.action === "open") {
          let expiresAt: number | null = null;
          if (body.durationMinutes !== null) {
            if (typeof body.durationMinutes !== "number" || !Number.isInteger(body.durationMinutes) || body.durationMinutes < 1 || body.durationMinutes > 525600) throw new Error("Duration must be between 1 minute and 365 days");
            expiresAt = Date.now() + body.durationMinutes * 60_000;
          }
          store.updateKey(id, { state: "open", expiresAt });
        } else if (body.action === "pause" || body.action === "revoke") {
          store.updateKey(id, { state: body.action === "pause" ? "paused" : "revoked", expiresAt: null });
        } else throw new Error("Invalid action");
        access.changed();
        return json({ ok: true });
      }
      if (path === "/admin/api/usage" && req.method === "GET") {
        const from = url.searchParams.get("from") ?? store.day();
        const to = url.searchParams.get("to") ?? from;
        const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
        if (!valid(from) || !valid(to) || from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000) throw new Error("Select a valid date range of up to one year");
        return json({ rows: store.stats(from, to, url.searchParams.get("keyId") || undefined, url.searchParams.get("model") || undefined), timezone: store.timezone });
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Action failed" }, 400);
    }
  };
}
