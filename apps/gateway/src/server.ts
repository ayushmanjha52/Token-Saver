import Fastify, { type FastifyInstance } from "fastify";
import { registerProviderRoutes, type ProxyDeps } from "./proxy.js";

/** Anthropic accepts 32 MB request bodies (base64 PDFs and images); the gateway must not be the tighter limit. */
const BODY_LIMIT = 32 * 1024 * 1024;

export function createApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? true,
    bodyLimit: BODY_LIMIT,
    // Streams can run for many minutes; Node's default request timeout would
    // cut long generations off mid-response.
    requestTimeout: 0,
  });

  // Keep the body as raw bytes: the request is forwarded exactly as sent, and
  // a parse/re-serialize round trip would change key order and number
  // formatting, which breaks prompt-cache prefixes byte-for-byte.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  return app;
}

export function registerRoutes(app: FastifyInstance, deps: ProxyDeps): void {
  // The gateway is an API, but the first thing anyone does with its URL is
  // open it in a browser; answer with what it is instead of a bare 404.
  app.get("/", async () => ({
    service: "tokengrid-gateway",
    ok: true,
    usage: "Point an SDK at this host with a TokenGrid virtual key (tgk_...) as the API key.",
    endpoints: deps.adapters.flatMap((a) =>
      a.routes.map((r) => `${r.method} ${a.prefix}${r.path}${a.mountAtRoot ? ` (also ${r.path})` : ""}`),
    ),
    health: "/healthz",
  }));
  app.get("/healthz", async () => ({
    ok: true,
    pendingEvents: deps.emitter.pendingCount,
    droppedEvents: deps.emitter.dropped,
  }));
  registerProviderRoutes(app, deps);
}
