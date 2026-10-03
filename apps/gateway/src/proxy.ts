import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Dispatcher } from "undici";
import { request as upstreamRequest } from "undici";
import type { UsageEventV1 } from "@tokengrid/shared";
import { AuthBackendUnavailableError, type ResolvedKey, type VirtualKeyResolver } from "./auth.js";
import { BUDGET_WARNING_HEADER, budgetExceededMessage, budgetWarningValue, type BudgetGuard } from "./budget.js";
import type { UsageEmitter } from "./emit.js";
import type { ProviderAdapter, ProviderRoute } from "./providers/types.js";
import { headerString } from "./providers/util.js";

export interface ProxyDeps {
  resolver: VirtualKeyResolver;
  emitter: UsageEmitter;
  budgets: BudgetGuard;
  dispatcher: Dispatcher;
  adapters: readonly ProviderAdapter[];
}

/** Connection-level headers that describe the upstream hop, not the response. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

/** Optional client-supplied conversation id; retries are matched within one session. Never forwarded upstream. */
const SESSION_HEADER = "x-tokengrid-session";

function presentedKey(headers: IncomingHttpHeaders): string | null {
  const x = headers["x-api-key"];
  if (typeof x === "string" && x.length > 0) return x;
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

/** Resolves on 'drain', or on 'close' so a vanished client cannot park the loop forever. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

async function forward(
  deps: ProxyDeps,
  adapter: ProviderAdapter,
  route: ProviderRoute,
  upstreamPath: string,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const startedAt = Date.now();
  const fail = (status: number, kind: Parameters<ProviderAdapter["errorBody"]>[0], message: string) =>
    reply.code(status).send(adapter.errorBody(kind, message));

  const key = presentedKey(req.headers);
  if (!key) return fail(401, "authentication", "Missing TokenGrid virtual key (x-api-key or Authorization: Bearer).");

  let resolved: ResolvedKey | null;
  try {
    resolved = await deps.resolver.resolve(key);
  } catch (err) {
    req.log.error({ err }, "virtual key resolution failed");
    return err instanceof AuthBackendUnavailableError
      ? fail(503, "unavailable", "TokenGrid cannot verify keys right now; retry shortly.")
      : fail(500, "internal", "TokenGrid failed to load this key's upstream credential.");
  }
  if (!resolved) return fail(401, "authentication", "Unknown or revoked TokenGrid virtual key.");
  const upstreamKey = resolved.upstreamKeys[adapter.provider];
  if (!upstreamKey) return fail(403, "permission", `This organization has no ${adapter.provider} credential configured in TokenGrid.`);

  let warning: string | null = null;
  if (route.metered) {
    const verdict = await deps.budgets.check(resolved, new Date(startedAt));
    if (verdict.blocked) return fail(402, "budget", budgetExceededMessage(verdict.blocked));
    if (verdict.warning) warning = budgetWarningValue(verdict.warning);
  }

  const abort = new AbortController();
  // A client that hangs up stops caring about the rest of the generation;
  // cancelling upstream stops the provider billing tokens nobody will read.
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) abort.abort();
  });

  const clientBody = req.method === "GET" ? null : (req.body as Buffer);
  let upstream: Dispatcher.ResponseData;
  try {
    upstream = await upstreamRequest(`${adapter.upstreamBaseUrl}${upstreamPath}`, {
      method: route.method,
      headers: adapter.upstreamHeaders(req.headers, upstreamKey),
      body: clientBody === null ? null : adapter.prepareBody(clientBody, route),
      dispatcher: deps.dispatcher,
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) return reply.hijack();
    req.log.error({ err }, "upstream request failed");
    return fail(502, "upstream", `TokenGrid could not reach ${adapter.provider}.`);
  }

  const contentType = headerString(upstream.headers["content-type"]) ?? "";
  const contentEncoding = headerString(upstream.headers["content-encoding"]);
  const providerRequestId = adapter.requestId(upstream.headers);
  const meter = adapter.createMeter(contentType);
  const meterable = route.metered && (!contentEncoding || contentEncoding === "identity");

  reply.hijack();
  const res = reply.raw;
  const outHeaders: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) outHeaders[name] = value;
  }
  if (warning) outHeaders[BUDGET_WARNING_HEADER] = warning;
  res.writeHead(upstream.statusCode, outHeaders);

  try {
    for await (const chunk of upstream.body as AsyncIterable<Buffer>) {
      // Delivery first. The meter sees the chunk only after it is handed to
      // the socket, and its failures are contained so they cannot stall or
      // corrupt the client's stream.
      const ok = res.write(chunk);
      if (meterable) {
        try {
          meter.push(chunk);
        } catch (err) {
          req.log.warn({ err }, "usage meter failed on chunk");
        }
      }
      if (!ok && !res.destroyed) await drained(res);
      if (res.destroyed) break;
    }
  } catch (err) {
    if (!abort.signal.aborted) req.log.warn({ err }, "upstream stream ended with error");
  } finally {
    if (!res.destroyed) res.end();
    if (abort.signal.aborted) upstream.body.destroy();
  }

  if (!route.metered) return;
  if (!meterable) {
    req.log.error({ providerRequestId, contentEncoding }, "UnmeterableResponse: upstream ignored accept-encoding identity");
    return;
  }
  try {
    meter.end();
    const call = meter.result(providerRequestId);
    if (!call) {
      if (upstream.statusCode < 300) req.log.error({ providerRequestId }, "UnmeterableResponse: 2xx response carried no usage");
      return;
    }
    const event: UsageEventV1 = {
      v: 1,
      provider: adapter.provider,
      // A random fallback, not a per-process counter: two gateways would
      // otherwise mint the same id and the second event would be dropped as
      // a duplicate.
      providerRequestId: call.providerRequestId ?? `tg_${randomUUID()}`,
      orgId: resolved.orgId,
      userId: resolved.userId,
      virtualKeyId: resolved.virtualKeyId,
      model: call.model,
      pricingTier: call.pricingTier,
      occurredAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      httpStatus: upstream.statusCode,
      streamed: meter.streamed,
      usageComplete: call.usageComplete,
      stopReason: call.stopReason,
      usage: call.usage,
      unpricedUnits: call.unpricedUnits,
      // Computed after the response is delivered, from the client's original
      // body, so parsing a multi-megabyte request never adds latency.
      prompt:
        clientBody === null
          ? null
          : adapter.promptFeatures(clientBody, `${resolved.virtualKeyId}:${(headerString(req.headers[SESSION_HEADER]) ?? "").slice(0, 128)}`),
    };
    deps.emitter.emit(event);
  } catch (err) {
    req.log.error({ err, providerRequestId }, "failed to build usage event");
  }
}

/**
 * Mounts every adapter's routes under its prefix (and at the root for
 * adapters that predate prefixes). The upstream path is the request URL with
 * the prefix removed, query string included.
 */
export function registerProviderRoutes(app: FastifyInstance, deps: ProxyDeps): void {
  for (const adapter of deps.adapters) {
    const mounts = adapter.mountAtRoot ? [adapter.prefix, ""] : [adapter.prefix];
    for (const mount of mounts) {
      for (const route of adapter.routes) {
        app.route({
          method: route.method,
          url: `${mount}${route.path}`,
          handler: (req, reply) => forward(deps, adapter, route, req.url.slice(mount.length), req, reply),
        });
      }
    }
  }
}
