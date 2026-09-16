import { loadConfig } from "./config";
import { createApp } from "./app";

const config = loadConfig();
const app = createApp(config);

const server = Bun.serve({
  port: config.port,
  idleTimeout: config.idleTimeoutSeconds,
  maxRequestBodySize: config.maxRequestBodySizeBytes,
  fetch: (req, server) => app.fetch(req, server.requestIP(req)?.address),
});

console.log(`llm-proxy listening on ${config.port}`);
console.log(`Admin: http://localhost:${config.port}/admin`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.close();
    void server.stop(true);
  });
}
