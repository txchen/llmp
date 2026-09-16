import type { Config } from "./config";
import { Store } from "./store";
import { Access } from "./access";
import { createAdminHandler } from "./admin";
import { createProxyHandler } from "./proxy";

export function createApp(config: Config) {
  if (!config.adminPassword) throw new Error("Missing required env: ADMIN_PASSWORD");
  if (config.adminOrigin && new URL(config.adminOrigin).origin !== config.adminOrigin) throw new Error("ADMIN_ORIGIN must be an origin, e.g. https://ai.example.com");
  const store = new Store(config.databasePath ?? "./data/llmp.sqlite", config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, config.proxyToken, {
    openaiBaseUrl: config.openaiBaseUrl, openaiApiKey: config.openaiApiKey,
    anthropicBaseUrl: config.anthropicBaseUrl, anthropicApiKey: config.anthropicApiKey,
    anthropicVersion: config.anthropicVersion || "2023-06-01",
  });
  const access = new Access(store);
  const admin = createAdminHandler(access, config.adminPassword, config.adminOrigin);
  const proxy = createProxyHandler(config, access);
  let closed = false;
  return {
    store, access,
    fetch(req: Request, remoteIp?: string) {
      const path = new URL(req.url).pathname;
      if (path === "/") return Response.redirect(new URL("/admin", req.url), 302);
      return path === "/admin" || path.startsWith("/admin/") ? admin(req, remoteIp) : proxy(req);
    },
    close() { if (!closed) { closed = true; access.close(); store.close(); } },
  };
}
