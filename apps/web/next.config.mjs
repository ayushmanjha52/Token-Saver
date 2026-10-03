import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// One .env at the repo root serves every app; Next would otherwise only look in apps/web.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-hosted images run `.next/standalone` (the Dockerfile sets NEXT_OUTPUT).
  // Off by default: tracing creates symlinks into pnpm's store, which Windows
  // refuses without Developer Mode, and Vercel builds its own output anyway.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Workspace packages ship TypeScript source, not built output.
  transpilePackages: ["@tokengrid/db", "@tokengrid/shared"],
  experimental: {
    // The Postgres driver opens sockets and must run as plain Node, not be bundled.
    serverComponentsExternalPackages: ["postgres"],
    // Trace dependencies from the monorepo root, so workspace packages land in the standalone output.
    outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  },
  webpack(config) {
    // The shared packages use NodeNext-style `./x.js` specifiers for `./x.ts` files.
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return config;
  },
};

export default nextConfig;
