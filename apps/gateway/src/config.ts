export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface GatewayConfig {
  port: number;
  host: string;
  redisUrl: string;
  databaseUrl: string;
  anthropicUpstreamUrl: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new ConfigError(`${name} is required. See .env.example.`);
  return v;
}

export function loadConfig(): GatewayConfig {
  const port = Number(process.env.GATEWAY_PORT ?? "8787");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError("GATEWAY_PORT must be a TCP port");
  return {
    port,
    host: process.env.GATEWAY_HOST ?? "0.0.0.0",
    redisUrl: required("REDIS_URL"),
    databaseUrl: required("DATABASE_URL"),
    anthropicUpstreamUrl: (process.env.ANTHROPIC_UPSTREAM_URL ?? "https://api.anthropic.com").replace(/\/+$/, ""),
  };
}
