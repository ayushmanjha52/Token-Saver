import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Dispatcher } from "undici";
import { request as upstreamRequest } from "undici";
import type { UsageEventV1 } from "@tokengrid/shared";
import { AuthBackendUnavailableError, type ResolvedKey, type VirtualKeyResolver } from "./auth.js";
import { BUDGET_WARNING_HEADER, budgetExceededMessage, budgetWarningValue, type BudgetGuard } from "./budget.js";
import type { UsageEmitter } from "./emit.js";
import { AnthropicUsageAccumulator, extractAnthropicPromptFeatures } from "./providers/anthropic.js";

export interface ProxyDeps {
  resolver: VirtualKeyResolver;
  emitter: UsageEmitter;
  budgets: BudgetGuard;
  dispatcher: Dispatcher;
  anthropicUpstreamUrl: string;
}

/** Request headers the client may set that Anthropic acts on. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = ["anthropic-version", "anthropic-beta", "content-type", "accept"] as const;

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

function anthropicError(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

function presentedKey(headers: IncomingHttpHeaders): string | null {
  const x = headers["x-api-key"];
  if (typeof x === "string" && x.length > 0) return x;
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

/** Optional client-supplied conversation id; retries are matched within one session. Never forwarded upstream. */
const SESSION_HEADER = "x-tokengrid-session";

function headerString(h: string | string[] | undefined): string | null {
  if (typeof h === "string") return h;
  if (Array.isArray(h) && h[0] !== undefined) return h[0];
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

interface ForwardOptions {
  /**
   * Whether the call is billable. Unmetered routes (token counting, model
   * listing) are free upstream, so they skip the budget check and emit nothing.
   */
  metered: boolean;
}

async function forward(deps: ProxyDeps, req: FastifyRequest, reply: FastifyReply, opts: ForwardOptions) {
  const startedAt = Date.now();
  const key = presentedKey(req.headers);
  if (!key) {
    return reply.code(401).send(anthropicError("authentication_error", "Missing TokenGrid virtual key in x-api-key."));
  }

  let resolved: ResolvedKey | null;
  try {
    resolved = await deps.resolver.resolve(key);
  } catch (err) {
    req.log.error({ err }, "virtual key resolution failed");
    const unavailable = err instanceof AuthBackendUnavailableError;
    return reply
      .code(unavailable ? 503 : 500)
      .send(
        anthropicError(
          "api_error",
          unavailable ? "TokenGrid cannot verify keys right now; retry shortly." : "TokenGrid failed to load this key's upstream credential.",
        ),
      );
  }
  if (!resolved) {
    return reply.code(401).send(anthropicError("authentication_error", "Unknown or revoked TokenGrid virtual key."));
  }
  const upstreamKey = resolved.upstreamKeys.anthropic;
  if (!upstreamKey) {
    return reply
      .code(403)
      .send(anthropicError("permission_error", "This organization has no Anthropic credential configured in TokenGrid."));
  }

  let warning: string | null = null;
  if (opts.metered) {
    const verdict = await deps.budgets.check(resolved, new Date(startedAt));
    if (verdict.blocked) {
      return reply.code(402).send(anthropicError("billing_error", budgetExceededMessage(verdict.blocked)));
    }
    if (verdict.warning) warning = budgetWarningValue(verdict.warning);
  }

  const headers: Record<string, string> = {
    "x-api-key": upstreamKey,
    // Identity encoding keeps the forwarded bytes and the metered copy the
    // same bytes; with compression we would have to decompress a second
    // copy just to read usage.
    "accept-encoding": "identity",
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = headerString(req.headers[name]);
    if (v !== null) headers[name] = v;
  }

  const abort = new AbortController();
  // A client that hangs up stops caring about the rest of the generation;
  // cancelling upstream stops Anthropic billing tokens nobody will read.
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) abort.abort();
  });

  let upstream: Dispatcher.ResponseData;
  try {
    // req.url keeps the query string (the SDK's beta client sends ?beta=true).
    upstream = await upstreamRequest(`${deps.anthropicUpstreamUrl}${req.url}`, {
      method: req.method === "GET" ? "GET" : "POST",
      headers,
      body: req.method === "GET" ? null : (req.body as Buffer),
      dispatcher: deps.dispatcher,
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) return reply.hijack();
    req.log.error({ err }, "upstream request failed");
    return reply.code(502).send(anthropicError("api_error", "TokenGrid could not reach Anthropic."));
  }

  const contentType = headerString(upstream.headers["content-type"]) ?? "";
  const contentEncoding = headerString(upstream.headers["content-encoding"]);
  const providerRequestId = headerString(upstream.headers["request-id"]);
  const meter = new AnthropicUsageAccumulator(contentType.includes("text/event-stream"));
  const meterable = opts.metered && (!contentEncoding || contentEncoding === "identity");

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

  if (!opts.metered) return;
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
      provider: "anthropic",
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
      // Computed after the response is delivered, so parsing a multi-megabyte
      // body never adds latency. Without a session header, the key is the session.
      prompt: extractAnthropicPromptFeatures(
        req.body as Buffer,
        `${resolved.virtualKeyId}:${(headerString(req.headers[SESSION_HEADER]) ?? "").slice(0, 128)}`,
      ),
    };
    deps.emitter.emit(event);
  } catch (err) {
    req.log.error({ err, providerRequestId }, "failed to build usage event");
  }
}

export function registerAnthropicProxy(app: FastifyInstance, deps: ProxyDeps): void {
  app.post("/v1/messages", (req, reply) => forward(deps, req, reply, { metered: true }));
  app.post("/v1/messages/count_tokens", (req, reply) => forward(deps, req, reply, { metered: false }));
  app.get("/v1/models", (req, reply) => forward(deps, req, reply, { metered: false }));
  app.get("/v1/models/:id", (req, reply) => forward(deps, req, reply, { metered: false }));
}
