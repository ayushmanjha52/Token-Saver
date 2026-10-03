import type { IncomingHttpHeaders } from "node:http";
import { canonicalModelId, fingerprint, mentionsFormat, numbersDigest, sha256Hex, simhash64, type PricingTier, type PromptFeatures } from "@tokengrid/shared";
import { SseParser } from "../sse.js";
import type { GatewayErrorKind, MeteredCall, ProviderAdapter, ProviderRoute, UsageMeter } from "./types.js";
import { headerString, isRecord, JsonCollector, num } from "./util.js";

/**
 * Above this many prompt tokens OpenAI bills the larger models at a separate
 * long-context rate. Such calls get their own pricing tier, so until a
 * verified long-context price row exists they wait in the DLQ instead of
 * being priced at the short-context rate.
 */
export const OPENAI_LONG_CONTEXT_TOKENS = 272_000;

/** Snapshot ids (gpt-6-sol-2026-08-01) are priced as their model. */
export const canonicalOpenAIModel = canonicalModelId;

/**
 * Chat Completions usage. Unlike Anthropic's, `prompt_tokens` is a total
 * that already contains the cached-read and cache-write tokens; both are
 * subtracted so input is never billed twice. Usage arrives once, complete:
 * in the final stream chunk (only when include_usage is set) or in the body.
 */
export class OpenAIUsageAccumulator implements UsageMeter {
  private model: string | null = null;
  private id: string | null = null;
  private stopReason: string | null = null;
  private serviceTier: string | null = null;
  private usage: Record<string, unknown> | null = null;
  private readonly sse: SseParser | null;
  private readonly json = new JsonCollector();

  constructor(readonly streamed: boolean) {
    this.sse = streamed ? new SseParser((_event, data) => this.onChunk(data)) : null;
  }

  push(chunk: Uint8Array): void {
    if (this.sse) this.sse.push(chunk);
    else this.json.push(chunk);
  }

  end(): void {
    if (this.sse) {
      this.sse.end();
      return;
    }
    const body = this.json.parse();
    if (body && body.object === "chat.completion") this.apply(body);
  }

  private onChunk(data: string): void {
    if (data === "[DONE]") return;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (isRecord(chunk)) this.apply(chunk);
  }

  private apply(o: Record<string, unknown>): void {
    if (typeof o.model === "string") this.model = o.model;
    if (typeof o.id === "string") this.id = o.id;
    if (typeof o.service_tier === "string") this.serviceTier = o.service_tier;
    if (isRecord(o.usage)) this.usage = o.usage;
    const choice = Array.isArray(o.choices) ? o.choices[0] : undefined;
    if (isRecord(choice) && typeof choice.finish_reason === "string") this.stopReason = choice.finish_reason;
  }

  result(providerRequestId: string | null): MeteredCall | null {
    if (this.model === null || this.usage === null) return null;
    const u = this.usage;
    const details = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
    const prompt = num(u.prompt_tokens) ?? 0;
    const cached = num(details.cached_tokens) ?? 0;
    const written = num(details.cache_write_tokens) ?? 0;
    let tier: PricingTier = "standard";
    if (this.serviceTier === "priority" || this.serviceTier === "fast") tier = "fast";
    else if (this.serviceTier === "flex") tier = "flex";
    else if (prompt > OPENAI_LONG_CONTEXT_TOKENS) tier = "long_context";
    return {
      model: canonicalOpenAIModel(this.model),
      providerRequestId: providerRequestId ?? this.id,
      pricingTier: tier,
      usage: {
        inputTokens: Math.max(0, prompt - cached - written),
        // Reasoning tokens are part of completion_tokens and billed as output.
        outputTokens: num(u.completion_tokens) ?? 0,
        cacheReadTokens: cached,
        // OpenAI has one cache-write rate; it is stored in the 5-minute slot.
        cacheWrite5mTokens: written,
        cacheWrite1hTokens: 0,
      },
      usageComplete: true,
      stopReason: this.stopReason,
      unpricedUnits: {},
    };
  }
}

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!isRecord(part)) return "";
  if (part.type === "text" && typeof part.text === "string") return part.text;
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map(partText).join("\n") : "";
}

/**
 * Prompt features for a Chat Completions request, with the same meaning as
 * the Anthropic adapter's: the final user turn is the last part of the last
 * user message; everything before it is prefix. OpenAI caches prefixes
 * automatically, so caching counts as requested and the uncached-prefix
 * lint (a cache_control fix) never applies; the score's cache component
 * still measures how much of the prefix the cache actually served.
 */
export function extractOpenAIPromptFeatures(body: Buffer, sessionKey: string): PromptFeatures | null {
  let req: unknown;
  try {
    req = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(req) || !Array.isArray(req.messages) || req.messages.length === 0) return null;
  const messages = req.messages as unknown[];
  const isInstruction = (m: unknown) => isRecord(m) && (m.role === "system" || m.role === "developer");
  const systemText = messages.filter(isInstruction).map((m) => (isRecord(m) ? contentText(m.content) : "")).join("\n");
  const tools = Array.isArray(req.tools) ? req.tools : [];
  const toolsJson = tools.length > 0 ? JSON.stringify(tools) : "";

  const last = messages[messages.length - 1];
  const lastIsUser = isRecord(last) && last.role === "user";
  const lastParts = lastIsUser ? (Array.isArray(last.content) ? (last.content as unknown[]) : [last.content]) : [];
  const lastUserText = lastIsUser ? partText(lastParts[lastParts.length - 1]) : "";

  const earlier = (lastIsUser ? messages.slice(0, -1) : messages).filter((m) => !isInstruction(m));
  const earlierText = earlier.map((m) => (isRecord(m) ? contentText(m.content) : "")).join("\n");
  const lastPrefixText = lastParts.slice(0, -1).map(partText).join("\n");
  const prefixChars = [systemText, toolsJson, earlierText, lastPrefixText].reduce((a, p) => a + p.length, 0);
  const fullText = [systemText, earlierText, lastPrefixText, lastUserText].filter(Boolean).join("\n");
  const format = isRecord(req.response_format) ? req.response_format.type : undefined;

  return {
    fingerprint: fingerprint(fullText),
    lastUserSimhash: simhash64(lastUserText),
    lastUserChars: lastUserText.length,
    lastUserNumbers: numbersDigest(lastUserText),
    messageCount: messages.length,
    prefixHash: prefixChars > 0 ? sha256Hex(JSON.stringify([tools, messages.slice(0, -1), lastParts.slice(0, -1)])) : null,
    prefixChars,
    totalChars: prefixChars + lastUserText.length,
    hasSystem: systemText.trim().length > 0,
    hasFormatSpec: (typeof format === "string" && format !== "text") || tools.length > 0 || mentionsFormat(`${systemText}\n${lastUserText}`),
    usesCacheControl: true,
    sessionKey,
  };
}

/** Client headers OpenAI acts on. Organization and project are not forwarded: the org's TokenGrid credential decides them. */
const OPENAI_HEADERS = ["content-type", "accept"] as const;

const OPENAI_ERROR: Record<GatewayErrorKind, { type: string; code: string | null }> = {
  authentication: { type: "invalid_request_error", code: "invalid_api_key" },
  permission: { type: "invalid_request_error", code: "provider_not_configured" },
  budget: { type: "insufficient_quota", code: "tokengrid_budget_exceeded" },
  unavailable: { type: "server_error", code: null },
  upstream: { type: "server_error", code: null },
  internal: { type: "server_error", code: null },
};

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider = "openai" as const;
  readonly prefix = "/openai";
  readonly mountAtRoot = false;
  readonly routes: readonly ProviderRoute[] = [
    { method: "POST", path: "/v1/chat/completions", metered: true },
    { method: "GET", path: "/v1/models", metered: false },
    { method: "GET", path: "/v1/models/:id", metered: false },
  ];

  constructor(readonly upstreamBaseUrl: string) {}

  upstreamHeaders(client: IncomingHttpHeaders, upstreamKey: string): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${upstreamKey}`, "accept-encoding": "identity" };
    for (const name of OPENAI_HEADERS) {
      const v = headerString(client[name]);
      if (v !== null) headers[name] = v;
    }
    return headers;
  }

  /**
   * THE ONE PLACE TOKENGRID MODIFIES A FORWARDED BODY. OpenAI omits usage
   * from streamed Chat Completions unless stream_options.include_usage is
   * true, and an unmetered stream is unbillable, so it is set on streaming
   * requests. The client then receives one extra final chunk with empty
   * `choices` and the usage; the official SDKs handle it. Non-streaming
   * requests, and streams that already ask for usage, go through byte for
   * byte. Re-serialising does not affect OpenAI's prompt cache, which keys
   * on tokens, not JSON bytes.
   */
  prepareBody(body: Buffer, route: ProviderRoute): Buffer {
    if (!route.metered) return body;
    let req: unknown;
    try {
      req = JSON.parse(body.toString("utf8"));
    } catch {
      return body;
    }
    if (!isRecord(req) || req.stream !== true) return body;
    const opts = isRecord(req.stream_options) ? req.stream_options : {};
    if (opts.include_usage === true) return body;
    return Buffer.from(JSON.stringify({ ...req, stream_options: { ...opts, include_usage: true } }));
  }

  createMeter(contentType: string): UsageMeter {
    return new OpenAIUsageAccumulator(contentType.includes("text/event-stream"));
  }

  requestId(headers: Record<string, string | string[] | undefined>): string | null {
    return headerString(headers["x-request-id"]);
  }

  promptFeatures(body: Buffer, sessionKey: string): PromptFeatures | null {
    return extractOpenAIPromptFeatures(body, sessionKey);
  }

  errorBody(kind: GatewayErrorKind, message: string): object {
    const e = OPENAI_ERROR[kind];
    return { error: { message, type: e.type, param: null, code: e.code } };
  }
}
