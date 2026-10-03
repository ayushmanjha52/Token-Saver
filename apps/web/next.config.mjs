import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// One .env at the repo root serves every app; Next would otherwise only look in apps/web.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source, not built output.
  transpilePackages: ["@tokengrid/db", "@tokengrid/shared"],
  experimental: {
    // The Postgres driver opens sockets and must run as plain Node, not be bundled.
    serverComponentsExternalPackages: ["postgres"],
  },
  webpack(config) {
    // The shared packages use NodeNext-style `./x.js` specifiers for `./x.ts` files.
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return config;
  },
};

export default nextConfig;
