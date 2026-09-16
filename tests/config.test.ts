import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const old = { ...process.env };
  for (const name of ["ADMIN_PASSWORD", "OPENAI_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "PROXY_TOKEN", "PORT", "IDLE_TIMEOUT_SECONDS", "MAX_REQUEST_BODY_SIZE_MB"]) delete process.env[name];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fn(); } finally { process.env = old as NodeJS.ProcessEnv; }
}

describe("loadConfig", () => {
  it("requires only the admin password", () => {
    withEnv({}, () => expect(() => loadConfig()).toThrow("ADMIN_PASSWORD"));
    withEnv({ ADMIN_PASSWORD: "test-password" }, () => {
      const config = loadConfig();
      expect(config.adminPassword).toBe("test-password");
      expect(config.openaiApiKey).toBe("");
      expect(config.anthropicApiKey).toBe("");
      expect(config.openaiBaseUrl).toBe("https://api.openai.com");
      expect(config.port).toBe(33000);
      expect(config.idleTimeoutSeconds).toBe(255);
      expect(config.maxRequestBodySizeBytes).toBe(256 * 1024 * 1024);
    });
  });
  it("accepts legacy settings for one-time import", () => {
    withEnv({ ADMIN_PASSWORD: "test-password", OPENAI_BASE_URL: "http://old.example", OPENAI_API_KEY: "old-key", PROXY_TOKEN: "old-token" }, () => {
      expect(loadConfig()).toMatchObject({ openaiBaseUrl: "http://old.example", openaiApiKey: "old-key", proxyToken: "old-token" });
    });
  });
  it("clamps idle timeout for Bun compatibility", () => {
    withEnv({ ADMIN_PASSWORD: "test-password", IDLE_TIMEOUT_SECONDS: "300" }, () => expect(loadConfig().idleTimeoutSeconds).toBe(255));
  });
  it("throws on invalid numeric env", () => {
    withEnv({ ADMIN_PASSWORD: "test-password", PORT: "not-a-number" }, () => expect(() => loadConfig()).toThrow("PORT"));
  });
});
