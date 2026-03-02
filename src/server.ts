import { loadConfig } from "./config";
import { createProxyHandler } from "./proxy";

const config = loadConfig();

Bun.serve({
  port: config.port,
  idleTimeout: config.idleTimeoutSeconds,
  maxRequestBodySize: config.maxRequestBodySizeBytes,
  fetch: createProxyHandler(config),
});

console.log(`llm-proxy listening on ${config.port}`);
