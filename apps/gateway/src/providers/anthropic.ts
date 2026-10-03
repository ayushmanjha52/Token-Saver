import type { NormalizedUsage, PricingTier } from "@tokengrid/shared";
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
