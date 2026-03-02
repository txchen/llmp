import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const old = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    process.env = old as NodeJS.ProcessEnv;
  }
}

describe("loadConfig", () => {
  it("throws when required vars missing", () => {
    withEnv(
      {
        OPENAI_BASE_URL: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_BASE_URL: undefined,
        ANTHROPIC_API_KEY: undefined,
        PROXY_TOKEN: undefined,
        PORT: undefined,
      },
      () => {
        expect(() => loadConfig()).toThrow();
      },
    );
  });

  it("loads required vars and defaults port", () => {
    withEnv(
      {
        OPENAI_BASE_URL: "https://openai.example",
        OPENAI_API_KEY: "ok",
        ANTHROPIC_BASE_URL: "https://anthropic.example",
        ANTHROPIC_API_KEY: "ak",
        PROXY_TOKEN: "pt",
        PORT: undefined,
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.port).toBe(33000);
        expect(cfg.idleTimeoutSeconds).toBe(255);
        expect(cfg.maxRequestBodySizeBytes).toBe(256 * 1024 * 1024);
      },
    );
  });

  it("clamps idle timeout for Bun compatibility", () => {
    withEnv(
      {
        OPENAI_BASE_URL: "https://openai.example",
        OPENAI_API_KEY: "ok",
        ANTHROPIC_BASE_URL: "https://anthropic.example",
        ANTHROPIC_API_KEY: "ak",
        PROXY_TOKEN: "pt",
        IDLE_TIMEOUT_SECONDS: "300",
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.idleTimeoutSeconds).toBe(255);
      },
    );
  });

  it("throws on invalid numeric env", () => {
    withEnv(
      {
        OPENAI_BASE_URL: "https://openai.example",
        OPENAI_API_KEY: "ok",
        ANTHROPIC_BASE_URL: "https://anthropic.example",
        ANTHROPIC_API_KEY: "ak",
        PROXY_TOKEN: "pt",
        PORT: "not-a-number",
      },
      () => {
        expect(() => loadConfig()).toThrow();
      },
    );
  });

});
