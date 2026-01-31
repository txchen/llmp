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
      },
    );
  });
});
