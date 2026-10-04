// Supervises the three processes of the free-tier staging container.
//
// Redis is private to the container and in-memory only. Everything TokenGrid
// keeps there is rebuilt from Postgres at startup (budgets, spend counters,
// key cache); what a restart can lose is usage events emitted but not yet
// consumed, which the worker drains within milliseconds of arrival.
//
// If any process exits, the others are stopped and the container exits, so
// Render restarts the whole unit rather than leaving a gateway with no worker.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

const REDIS_PORT = 6379;
const env = {
  ...process.env,
  REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
  // Render routes public traffic to $PORT.
  GATEWAY_PORT: process.env.PORT ?? "10000",
  GATEWAY_HOST: "0.0.0.0",
};

const children = [];
let stopping = false;

function run(name, cmd, args) {
  const child = spawn(cmd, args, { env, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[start] ${name} exited (code ${code}, signal ${signal}); stopping the container`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  // Give the gateway time to finish in-flight streams before the hard exit.
  setTimeout(() => process.exit(code), 25_000).unref();
  Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.on("exit", r))))).then(() => process.exit(code));
}

function redisReady() {
  return new Promise((resolve) => {
    const socket = createConnection(REDIS_PORT, "127.0.0.1");
    socket.on("connect", () => socket.write("PING\r\n"));
    socket.on("data", (d) => {
      socket.destroy();
      resolve(d.toString().startsWith("+PONG"));
    });
    socket.on("error", () => resolve(false));
  });
}

run("redis", "redis-server", ["--port", String(REDIS_PORT), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--maxmemory", "64mb", "--maxmemory-policy", "noeviction"]);
for (let i = 0; i < 50 && !(await redisReady()); i++) await new Promise((r) => setTimeout(r, 100));
run("gateway", process.execPath, ["--enable-source-maps", "apps/gateway/dist/index.js"]);
run("worker", process.execPath, ["--enable-source-maps", "apps/ingest/dist/worker.js"]);

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
