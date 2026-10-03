import type { IncomingHttpHeaders } from "node:http";
import type { NormalizedUsage, PricingTier, PromptFeatures, Provider } from "@tokengrid/shared";

/** What the gateway learned about one upstream call, in provider-neutral terms. */
export interface MeteredCall {
  /** Canonical model id, as priced in the catalog. */
  model: string;
  providerRequestId: string | null;
  pricingTier: PricingTier;
  /** Disjoint counts: input never includes cache reads or writes. */
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

/** Reads usage from a copy of the response; never sees bytes before the client does. */
export interface UsageMeter {
  readonly streamed: boolean;
  push(chunk: Uint8Array): void;
  end(): void;
  /** Null when the response carried no usage at all (an error body, a rejected request). */
  result(providerRequestId: string | null): MeteredCall | null;
}

export interface ProviderRoute {
  method: "GET" | "POST";
  /** Path under the provider's prefix, as the provider's own API spells it. */
  path: string;
  /**
   * Billable calls are budget-checked and metered. Unmetered routes (model
   * listing, token counting) are free upstream and pass straight through.
   */
  metered: boolean;
}

export type GatewayErrorKind = "authentication" | "permission" | "budget" | "unavailable" | "upstream" | "internal";

/**
 * Everything that differs between providers. The proxy, the worker and the
 * dashboard only ever see what comes out of these methods, so nothing
 * outside src/providers/ branches on which provider served a call.
 */
export interface ProviderAdapter {
  readonly provider: Provider;
  /** Mount point, e.g. "/openai"; the client's base URL ends here. */
  readonly prefix: string;
  /** Also serve the routes at the root, for clients configured before prefixes existed. */
  readonly mountAtRoot: boolean;
  readonly upstreamBaseUrl: string;
  readonly routes: readonly ProviderRoute[];
  /** Upstream request headers: the org's credential plus allow-listed client headers. */
  upstreamHeaders(client: IncomingHttpHeaders, upstreamKey: string): Record<string, string>;
  /**
   * The only place a forwarded request body may be modified. Returns the
   * body unchanged unless metering is impossible without a change.
   */
  prepareBody(body: Buffer, route: ProviderRoute): Buffer;
  createMeter(contentType: string): UsageMeter;
  requestId(headers: Record<string, string | string[] | undefined>): string | null;
  promptFeatures(body: Buffer, sessionKey: string): PromptFeatures | null;
  /** An error body in the provider's own shape, so the client SDK parses it. */
  errorBody(kind: GatewayErrorKind, message: string): object;
}
