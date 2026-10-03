// Bundles the long-running services and operator CLIs into self-contained
// ESM files, so production images run plain `node` with no TypeScript
// toolchain and no node_modules.
import { build } from "esbuild";
import { rmSync } from "node:fs";

const targets = [
  { outdir: "apps/gateway/dist", entries: ["apps/gateway/src/index.ts"] },
  {
    outdir: "apps/ingest/dist",
    entries: [
      "worker",
      "replay",
      "redrive",
      "budget-cli",
      "reconcile-cli",
      "credential-cli",
      "privacy-cli",
      "admin-cli",
    ].map((n) => `apps/ingest/src/${n}.ts`),
  },
  // migrate.js resolves ../migrations relative to itself, so dist/ sits beside src/.
  { outdir: "packages/db/dist", entries: ["packages/db/src/migrate.ts", "packages/db/src/seed.ts"] },
];

for (const t of targets) {
  rmSync(t.outdir, { recursive: true, force: true });
  await build({
    entryPoints: t.entries,
    outdir: t.outdir,
    bundle: true,
    platform: "node",
    target: "node20.12",
    format: "esm",
    sourcemap: true,
    logLevel: "warning",
    // Bundled CommonJS dependencies still call require(); give ESM output one.
    banner: { js: "import { createRequire as __tgCreateRequire } from 'node:module'; const require = __tgCreateRequire(import.meta.url);" },
  });
  console.log(`built ${t.entries.length} entr${t.entries.length === 1 ? "y" : "ies"} -> ${t.outdir}`);
}
