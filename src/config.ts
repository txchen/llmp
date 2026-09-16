export type Config = {
  openaiBaseUrl: string;
  openaiApiKey: string;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  proxyToken?: string;
  adminPassword?: string;
  adminOrigin?: string;
  databasePath?: string;
  timezone?: string;
  port: number;
  anthropicVersion?: string;
  idleTimeoutSeconds: number;
  maxRequestBodySizeBytes: number;
};

const BUN_IDLE_TIMEOUT_MAX_SECONDS = 255;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric env: ${name}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const maxRequestBodySizeMb = numberFromEnv("MAX_REQUEST_BODY_SIZE_MB", 256);
  const configuredIdleTimeout = numberFromEnv("IDLE_TIMEOUT_SECONDS", BUN_IDLE_TIMEOUT_MAX_SECONDS);
  const idleTimeoutSeconds = Math.min(configuredIdleTimeout, BUN_IDLE_TIMEOUT_MAX_SECONDS);
  if (configuredIdleTimeout !== idleTimeoutSeconds) {
    console.warn(
      `[config] IDLE_TIMEOUT_SECONDS=${configuredIdleTimeout} exceeds Bun max ${BUN_IDLE_TIMEOUT_MAX_SECONDS}; using ${idleTimeoutSeconds}`,
    );
  }

  return {
    // Old environments are imported only when settings are first initialized.
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    proxyToken: process.env.PROXY_TOKEN || undefined,
    adminPassword: requireEnv("ADMIN_PASSWORD"),
    adminOrigin: process.env.ADMIN_ORIGIN,
    databasePath: process.env.DATABASE_PATH || "./data/llmp.sqlite",
    timezone: process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
    port: numberFromEnv("PORT", 33000),
    anthropicVersion: process.env.ANTHROPIC_VERSION,
    idleTimeoutSeconds,
    maxRequestBodySizeBytes: maxRequestBodySizeMb * 1024 * 1024,
  };
}
