import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import type { Redis } from "ioredis";
import { InvariantViolationError } from "@tokengrid/shared";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new InvariantViolationError("no port"))));
    });
  });
}

/** A real Postgres 16 in a temp dir, so the suites need neither Docker nor a shared database. */
export async function startPostgres(): Promise<{ url: string; stop: () => Promise<void> }> {
  const dir = join(mkdtempSync(join(tmpdir(), "tokengrid-it-")), "pg");
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "tokengrid", password: "tokengrid", port, persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("tokengrid");
  return {
    url: `postgres://tokengrid:tokengrid@localhost:${port}/tokengrid`,
    stop: async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function testEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    TOKENGRID_LOCAL_KEK: randomBytes(32).toString("base64"),
    SEED_ANTHROPIC_API_KEY: "sk-ant-fake-upstream",
    TOKENGRID_SESSION_SECRET: randomBytes(32).toString("hex"),
  };
  // The suites drive Redis through a fake; CLIs must not reach a real one.
  delete env.REDIS_URL;
  Object.assign(process.env, env);
  return env;
}

/** Runs a pnpm script in the repo the way an operator would. */
export function pnpm(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, { cwd: REPO, env, encoding: "utf8", shell: process.platform === "win32" });
}

export function one<T>(rows: readonly T[], what: string): T {
  const r = rows[0];
  if (r === undefined) throw new InvariantViolationError(`expected a row: ${what}`);
  return r;
}

export function seededKeys(seedOutput: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const m of seedOutput.matchAll(/^\s+(\S+@\S+)\s+(tgk_[A-Za-z0-9_-]{43})\r?$/gm)) {
    if (m[1] && m[2]) keys[m[1]] = m[2];
  }
  return keys;
}

export class Checks {
  passed = 0;
  ok(msg: string): void {
    this.passed++;
    console.log(`PASS ${msg}`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * In-memory stand-in for the Redis commands the gateway and worker use.
 * Streams are reduced to a captured list: these suites test what is
 * published and how it is ingested, not Redis's consumer-group mechanics.
 */
export class FakeRedis {
  readonly kv = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly stream: string[] = [];
  xaddFails = false;

  async get(k: string) {
    return this.kv.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.kv.set(k, v);
    return "OK";
  }
  async mget(...ks: string[]) {
    return ks.map((k) => this.kv.get(k) ?? null);
  }
  async del(...ks: string[]) {
    ks.forEach((k) => this.kv.delete(k));
    return ks.length;
  }
  async sadd(k: string, ...m: string[]) {
    const s = this.sets.get(k) ?? new Set<string>();
    m.forEach((x) => s.add(x));
    this.sets.set(k, s);
    return m.length;
  }
  async smembers(k: string) {
    return [...(this.sets.get(k) ?? [])];
  }
  async srem(k: string, ...m: string[]) {
    m.forEach((x) => this.sets.get(k)?.delete(x));
    return m.length;
  }
  /** Implements only the raise-to-floor script SpendCounters sends. */
  async eval(_script: string, _n: number, key: string, floor: string) {
    if (BigInt(this.kv.get(key) ?? "0") < BigInt(floor)) {
      this.kv.set(key, floor);
      return 1;
    }
    return 0;
  }
  multi() {
    const ops: (() => void)[] = [];
    const m = {
      incrby: (k: string, n: string) => {
        ops.push(() => this.kv.set(k, String(BigInt(this.kv.get(k) ?? "0") + BigInt(n))));
        return m;
      },
      expire: () => m,
      exec: async () => {
        ops.forEach((f) => f());
        return [];
      },
    };
    return m;
  }
  async xadd(_key: string, _id: string, _field: string, payload: string) {
    if (this.xaddFails) throw new Error("ECONNREFUSED");
    this.stream.push(payload);
    return `0-${this.stream.length}`;
  }
  on() {
    return this;
  }
  /** The code under test takes ioredis' Redis type; this fake covers the subset it calls. */
  asRedis(): Redis {
    return this as unknown as Redis;
  }
}

/** Starts the built Next app directly (not via a pnpm shell, whose kill would orphan the server). */
export async function startNext(env: NodeJS.ProcessEnv): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [join(REPO, "apps/web/node_modules/next/dist/bin/next"), "start", "-p", String(port)], {
    cwd: join(REPO, "apps/web"),
    env: { ...env, NODE_ENV: "production" },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`${url}/login`);
      return { url, stop: () => child.kill() };
    } catch {
      await sleep(500);
    }
  }
  child.kill();
  throw new InvariantViolationError("next start did not come up; run `pnpm --filter @tokengrid/web build` first");
}
