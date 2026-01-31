export type Config = {
  openaiBaseUrl: string;
  openaiApiKey: string;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  proxyToken: string;
  port: number;
  anthropicVersion?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

export function loadConfig(): Config {
  return {
    openaiBaseUrl: requireEnv("OPENAI_BASE_URL"),
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    anthropicBaseUrl: requireEnv("ANTHROPIC_BASE_URL"),
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    proxyToken: requireEnv("PROXY_TOKEN"),
    port: Number(process.env.PORT ?? 33000),
    anthropicVersion: process.env.ANTHROPIC_VERSION,
  };
}
