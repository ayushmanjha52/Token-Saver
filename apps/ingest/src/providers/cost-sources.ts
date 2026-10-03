import { canonicalModelId, type Provider } from "@tokengrid/shared";

export class CostReportError extends Error {
  override readonly name = "CostReportError";
  constructor(
    readonly provider: Provider,
    readonly status: number,
    body: string,
  ) {
    super(`${provider} cost report request failed with HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

/**
 * A provider's own billing for one UTC day, in USD per canonical model id.
 * Non-token charges (web search, code execution) appear under
 * "non-token:<type>": TokenGrid does not price them, so they surface as
 * drift instead of disappearing.
 */
export interface CostSource {
  readonly provider: Provider;
  dailyCostByModel(adminKey: string, scope: string | null, day: Date): Promise<Map<string, number>>;
}

function dayBounds(day: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

function add(map: Map<string, number>, key: string, usd: number): void {
  map.set(key, (map.get(key) ?? 0) + usd);
}

async function getJson(provider: Provider, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new CostReportError(provider, res.status, text);
  return JSON.parse(text) as unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Anthropic Admin API cost report: amounts are decimal strings in cents. */
export class AnthropicCostSource implements CostSource {
  readonly provider = "anthropic" as const;
  constructor(private readonly baseUrl = "https://api.anthropic.com") {}

  async dailyCostByModel(adminKey: string, scope: string | null, day: Date): Promise<Map<string, number>> {
    const { start, end } = dayBounds(day);
    const out = new Map<string, number>();
    let page: string | null = null;
    do {
      const q = new URLSearchParams({ starting_at: start.toISOString(), ending_at: end.toISOString(), bucket_width: "1d", limit: "1" });
      q.append("group_by[]", "description");
      q.append("group_by[]", "workspace_id");
      if (page) q.set("page", page);
      const body = await getJson(this.provider, `${this.baseUrl}/v1/organizations/cost_report?${q}`, {
        "x-api-key": adminKey,
        "anthropic-version": "2023-06-01",
        "user-agent": "TokenGrid/1.0 (reconciliation)",
      });
      if (!isRecord(body) || !Array.isArray(body.data)) throw new CostReportError(this.provider, 200, "unexpected response shape");
      for (const bucket of body.data) {
        if (!isRecord(bucket) || !Array.isArray(bucket.results)) continue;
        for (const r of bucket.results) {
          if (!isRecord(r) || typeof r.amount !== "string") continue;
          if (scope !== null && r.workspace_id !== scope) continue;
          const key = typeof r.model === "string" ? canonicalModelId(r.model) : `non-token:${String(r.cost_type ?? "other")}`;
          add(out, key, Number(r.amount) / 100);
        }
      }
      page = body.has_more === true && typeof body.next_page === "string" ? body.next_page : null;
    } while (page);
    return out;
  }
}

/** All cost sources; base URLs are overridable for tests and egress proxies. */
export function costSources(): CostSource[] {
  return [new AnthropicCostSource(process.env.ANTHROPIC_ADMIN_URL), new OpenAICostSource(process.env.OPENAI_ADMIN_URL)];
}

/** OpenAI organization costs: amounts are dollars; line items read "<model>, <token type>". */
export class OpenAICostSource implements CostSource {
  readonly provider = "openai" as const;
  constructor(private readonly baseUrl = "https://api.openai.com") {}

  async dailyCostByModel(adminKey: string, scope: string | null, day: Date): Promise<Map<string, number>> {
    const { start, end } = dayBounds(day);
    const out = new Map<string, number>();
    let page: string | null = null;
    do {
      const q = new URLSearchParams({
        start_time: String(Math.floor(start.getTime() / 1000)),
        end_time: String(Math.floor(end.getTime() / 1000)),
        bucket_width: "1d",
        limit: "1",
      });
      q.append("group_by", "line_item");
      q.append("group_by", "project_id");
      if (page) q.set("page", page);
      const body = await getJson(this.provider, `${this.baseUrl}/v1/organization/costs?${q}`, { authorization: `Bearer ${adminKey}` });
      if (!isRecord(body) || !Array.isArray(body.data)) throw new CostReportError(this.provider, 200, "unexpected response shape");
      for (const bucket of body.data) {
        if (!isRecord(bucket) || !Array.isArray(bucket.results)) continue;
        for (const r of bucket.results) {
          if (!isRecord(r) || !isRecord(r.amount) || typeof r.amount.value !== "number") continue;
          if (scope !== null && r.project_id !== scope) continue;
          const item = typeof r.line_item === "string" ? r.line_item : "";
          const model = item.split(",")[0]?.trim();
          add(out, model ? canonicalModelId(model) : "non-token:other", r.amount.value);
        }
      }
      page = body.has_more === true && typeof body.next_page === "string" ? body.next_page : null;
    } while (page);
    return out;
  }
}
