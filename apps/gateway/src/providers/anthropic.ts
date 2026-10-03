import {
  fingerprint,
  mentionsFormat,
  numbersDigest,
  sha256Hex,
  simhash64,
  type NormalizedUsage,
  type PricingTier,
  type PromptFeatures,
} from "@tokengrid/shared";
import { SseParser } from "../sse.js";

/** What the gateway learned about one upstream call, in provider-neutral terms. */
export interface MeteredCall {
  model: string;
  providerRequestId: string | null;
  pricingTier: PricingTier;
  usage: NormalizedUsage;
  usageComplete: boolean;
  stopReason: string | null;
  /**
   * Billable units we have no rate for (e.g. web search requests). Non-empty
   * means the token cost alone understates the bill, so the worker refuses to
   * price the event rather than record a silently low figure.
   */
  unpricedUnits: Record<string, number>;
}

interface RawCounts {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreationTotal: number | null;
  cacheCreation5m: number | null;
  cacheCreation1h: number | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Accumulates Anthropic usage across a response.
 *
 * Streaming usage arrives in pieces: `message_start` carries input and cache
 * counts with a placeholder output count, and `message_delta` carries the
 * final output count. Every figure Anthropic sends is cumulative for the
 * message, so each field is overwritten by its latest value, never summed;
 * summing would double-count any field that appears in both events.
 */
export class AnthropicUsageAccumulator {
  private readonly counts: RawCounts = {
    input: null,
    output: null,
    cacheRead: null,
    cacheCreationTotal: null,
    cacheCreation5m: null,
    cacheCreation1h: null,
  };
  private model: string | null = null;
  private messageId: string | null = null;
  private stopReason: string | null = null;
  private speed: string | null = null;
  private sawFinalUsage = false;
  private readonly serverToolUse: Record<string, number> = {};
  private readonly sse: SseParser | null;
  private readonly jsonChunks: Uint8Array[] = [];
  private jsonBytes = 0;
  /** A non-streaming Messages body is at most a few MB; anything larger is not one we can meter. */
  private static readonly MAX_JSON_BYTES = 64 * 1024 * 1024;

  constructor(readonly streamed: boolean) {
    this.sse = streamed ? new SseParser((event, data) => this.onSseEvent(event, data)) : null;
  }

  push(chunk: Uint8Array): void {
    if (this.sse) {
      this.sse.push(chunk);
      return;
    }
    this.jsonBytes += chunk.byteLength;
    if (this.jsonBytes <= AnthropicUsageAccumulator.MAX_JSON_BYTES) this.jsonChunks.push(chunk);
  }

  end(): void {
    if (this.sse) {
      this.sse.end();
      return;
    }
    if (this.jsonBytes > AnthropicUsageAccumulator.MAX_JSON_BYTES) return;
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(this.jsonChunks).toString("utf8"));
    } catch {
      return;
    }
    if (!isRecord(body) || body.type !== "message") return;
    this.applyMessage(body);
    this.stopReason = typeof body.stop_reason === "string" ? body.stop_reason : null;
    this.sawFinalUsage = isRecord(body.usage);
  }

  private onSseEvent(event: string, data: string): void {
    if (event !== "message_start" && event !== "message_delta") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(payload)) return;
    if (event === "message_start" && isRecord(payload.message)) {
      this.applyMessage(payload.message);
    } else if (event === "message_delta") {
      if (isRecord(payload.usage)) {
        this.applyUsage(payload.usage);
        this.sawFinalUsage = true;
      }
      if (isRecord(payload.delta) && typeof payload.delta.stop_reason === "string") {
        this.stopReason = payload.delta.stop_reason;
      }
    }
  }

  private applyMessage(message: Record<string, unknown>): void {
    if (typeof message.model === "string") this.model = message.model;
    if (typeof message.id === "string") this.messageId = message.id;
    if (isRecord(message.usage)) this.applyUsage(message.usage);
  }

  private applyUsage(u: Record<string, unknown>): void {
    const set = (k: keyof RawCounts, v: unknown) => {
      const n = num(v);
      if (n !== null) this.counts[k] = n;
    };
    set("input", u.input_tokens);
    set("output", u.output_tokens);
    set("cacheRead", u.cache_read_input_tokens);
    set("cacheCreationTotal", u.cache_creation_input_tokens);
    if (isRecord(u.cache_creation)) {
      set("cacheCreation5m", u.cache_creation.ephemeral_5m_input_tokens);
      set("cacheCreation1h", u.cache_creation.ephemeral_1h_input_tokens);
    }
    if (typeof u.speed === "string") this.speed = u.speed;
    if (isRecord(u.server_tool_use)) {
      for (const [k, v] of Object.entries(u.server_tool_use)) {
        const n = num(v);
        if (n !== null) this.serverToolUse[k] = n;
      }
    }
  }

  /**
   * Splits cache writes by TTL because a 1-hour write costs 1.6x a 5-minute
   * one. A bare total with no breakdown is treated as 5-minute, the API's
   * default TTL; responses containing 1-hour writes carry the breakdown.
   */
  private cacheWrites(): { w5m: number; w1h: number } {
    const total = this.counts.cacheCreationTotal ?? 0;
    const w1h = this.counts.cacheCreation1h;
    const w5m = this.counts.cacheCreation5m;
    if (w1h === null && w5m === null) return { w5m: total, w1h: 0 };
    const oneHour = w1h ?? 0;
    return { w5m: Math.max(total - oneHour, w5m ?? 0), w1h: oneHour };
  }

  /** Null when the response carried no usage at all (an error body, a rejected request). */
  result(responseRequestId: string | null): MeteredCall | null {
    if (this.model === null || this.counts.input === null) return null;
    const { w5m, w1h } = this.cacheWrites();
    const unpricedUnits: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.serverToolUse)) if (v > 0) unpricedUnits[k] = v;
    return {
      model: this.model,
      // The request-id header is what Anthropic support and the admin API key
      // on; the message id is only a fallback for responses that lack it.
      providerRequestId: responseRequestId ?? this.messageId,
      pricingTier: this.speed === "fast" ? "fast" : "standard",
      usage: {
        inputTokens: this.counts.input,
        outputTokens: this.counts.output ?? 0,
        cacheReadTokens: this.counts.cacheRead ?? 0,
        cacheWrite5mTokens: w5m,
        cacheWrite1hTokens: w1h,
      },
      usageComplete: this.sawFinalUsage,
      stopReason: this.stopReason,
      unpricedUnits,
    };
  }
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!isRecord(block)) return "";
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "document":
      return isRecord(block.source) && block.source.type === "text" && typeof block.source.data === "string" ? block.source.data : "";
    case "tool_result":
      return contentText(block.content);
    case "tool_use":
      return JSON.stringify(block.input ?? null);
    default:
      // Images, PDFs and thinking blocks carry no text we can size reliably.
      return "";
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map(blockText).join("\n") : "";
}

/**
 * Reduces an Anthropic Messages request to provider-neutral prompt features.
 *
 * The "final user turn" is the last content block of the last user message:
 * a document pasted in an earlier block is part of the reusable prefix, and
 * only the question after it is what a person retypes on a retry. The
 * prefix hash covers the parsed JSON of everything before that block, which
 * is what prompt caching would match on.
 *
 * Returns null for anything that is not a Messages request; the caller
 * meters the call regardless.
 */
export function extractAnthropicPromptFeatures(body: Buffer, sessionKey: string): PromptFeatures | null {
  let req: unknown;
  try {
    req = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(req) || !Array.isArray(req.messages) || req.messages.length === 0) return null;
  const messages = req.messages as unknown[];

  const systemText = contentText(req.system);
  const tools = Array.isArray(req.tools) ? req.tools : [];
  const toolsJson = tools.length > 0 ? JSON.stringify(tools) : "";

  const last = messages[messages.length - 1];
  const lastIsUser = isRecord(last) && last.role === "user";
  const lastBlocks = lastIsUser ? (Array.isArray(last.content) ? (last.content as unknown[]) : [last.content]) : [];
  const finalBlock = lastBlocks[lastBlocks.length - 1];
  const lastUserText = lastIsUser ? blockText(finalBlock) : "";

  const earlierMessages = lastIsUser ? messages.slice(0, -1) : messages;
  const earlierText = earlierMessages.map((m) => (isRecord(m) ? contentText(m.content) : "")).join("\n");
  const lastPrefixBlocksText = lastBlocks.slice(0, -1).map(blockText).join("\n");
  const prefixParts = [systemText, toolsJson, earlierText, lastPrefixBlocksText].filter((p) => p.length > 0);
  const prefixChars = prefixParts.reduce((a, p) => a + p.length, 0);

  const fullText = [systemText, earlierText, lastPrefixBlocksText, lastUserText].filter(Boolean).join("\n");
  const outputConfig = isRecord(req.output_config) ? req.output_config : null;

  return {
    fingerprint: fingerprint(fullText),
    lastUserSimhash: simhash64(lastUserText),
    lastUserChars: lastUserText.length,
    lastUserNumbers: numbersDigest(lastUserText),
    messageCount: messages.length,
    prefixHash:
      prefixChars > 0
        ? sha256Hex(JSON.stringify([req.system ?? null, tools, earlierMessages, lastBlocks.slice(0, -1)]))
        : null,
    prefixChars,
    totalChars: prefixChars + lastUserText.length,
    hasSystem: systemText.trim().length > 0,
    hasFormatSpec: Boolean(outputConfig?.format) || tools.length > 0 || mentionsFormat(`${systemText}\n${lastUserText}`),
    usesCacheControl: body.includes('"cache_control"'),
    sessionKey,
  };
}
