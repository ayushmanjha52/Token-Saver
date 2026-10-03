import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalOpenAIModel, extractOpenAIPromptFeatures, OpenAIAdapter, OpenAIUsageAccumulator } from "./openai.js";

const adapter = new OpenAIAdapter("https://api.openai.com");
const metered = { method: "POST" as const, path: "/v1/chat/completions", metered: true };

function feed(acc: OpenAIUsageAccumulator, body: string, chunk: number) {
  const b = Buffer.from(body);
  for (let i = 0; i < b.length; i += chunk) acc.push(b.subarray(i, i + chunk));
  acc.end();
}

const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const delta = (text: string, finish: string | null = null) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  model: "gpt-6-sol-2026-08-01",
  service_tier: "default",
  choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
});

test("streamed usage arrives only in the final chunk; cached and written tokens are subtracted from prompt_tokens", () => {
  const acc = new OpenAIUsageAccumulator(true);
  feed(
    acc,
    sse([
      delta("Hel"),
      delta("lo", "stop"),
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        model: "gpt-6-sol-2026-08-01",
        choices: [],
        usage: { prompt_tokens: 12_000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 1_000 } },
      },
    ]),
    7,
  );
  const r = acc.result("req_x");
  assert.ok(r);
  assert.equal(r.model, "gpt-6-sol");
  assert.deepEqual(r.usage, { inputTokens: 3_000, outputTokens: 300, cacheReadTokens: 8_000, cacheWrite5mTokens: 1_000, cacheWrite1hTokens: 0 });
  assert.equal(r.stopReason, "stop");
  assert.equal(r.pricingTier, "standard");
});

test("a stream without the usage chunk is unmeterable, not zero", () => {
  const acc = new OpenAIUsageAccumulator(true);
  feed(acc, sse([delta("hi", "stop")]), 64);
  assert.equal(acc.result("req_y"), null);
});

test("non-streaming body, flex and long-context tiers", () => {
  const body = (extra: object, prompt = 100) =>
    JSON.stringify({ id: "c", object: "chat.completion", model: "gpt-6-luna", choices: [{ finish_reason: "length" }], usage: { prompt_tokens: prompt, completion_tokens: 5 }, ...extra });
  const run = (b: string) => {
    const acc = new OpenAIUsageAccumulator(false);
    feed(acc, b, 1000);
    return acc.result(null);
  };
  assert.equal(run(body({}))?.usage.inputTokens, 100);
  assert.equal(run(body({}))?.providerRequestId, "c");
  assert.equal(run(body({ service_tier: "flex" }))?.pricingTier, "flex");
  assert.equal(run(body({ service_tier: "priority" }))?.pricingTier, "fast");
  assert.equal(run(body({}, 300_000))?.pricingTier, "long_context");
});

test("snapshot suffixes are stripped for pricing", () => {
  assert.equal(canonicalOpenAIModel("gpt-5.6-terra-2026-07-14"), "gpt-5.6-terra");
  assert.equal(canonicalOpenAIModel("gpt-6-sol"), "gpt-6-sol");
});

test("include_usage is injected only on metered streaming requests that lack it", () => {
  const stream = Buffer.from(JSON.stringify({ model: "gpt-6-sol", stream: true, stream_options: { foo: 1 }, messages: [] }));
  const out = JSON.parse(adapter.prepareBody(stream, metered).toString()) as { stream_options: Record<string, unknown> };
  assert.deepEqual(out.stream_options, { foo: 1, include_usage: true });

  const plain = Buffer.from('{"model":"gpt-6-sol",  "messages":[]}');
  assert.equal(adapter.prepareBody(plain, metered), plain, "non-streaming body forwarded byte for byte");
  const already = Buffer.from(JSON.stringify({ stream: true, stream_options: { include_usage: true } }));
  assert.equal(adapter.prepareBody(already, metered), already);
  assert.equal(adapter.prepareBody(stream, { ...metered, metered: false }), stream);
});

test("prompt features: developer/system as instructions, final user part as the turn", () => {
  const f = extractOpenAIPromptFeatures(
    Buffer.from(
      JSON.stringify({
        model: "gpt-6-sol",
        response_format: { type: "json_object" },
        messages: [
          { role: "developer", content: "You are terse." },
          { role: "user", content: [{ type: "text", text: "Feeder log ".repeat(200) }, { type: "text", text: "Which feeder tripped?" }] },
        ],
      }),
    ),
    "k:",
  );
  assert.ok(f);
  assert.equal(f.hasSystem, true);
  assert.equal(f.hasFormatSpec, true);
  assert.equal(f.lastUserChars, "Which feeder tripped?".length);
  assert.equal(f.usesCacheControl, true, "OpenAI caches automatically");
  assert.ok(!JSON.stringify(f).includes("Feeder"));
});

test("errors come back in the OpenAI shape the SDK parses", () => {
  assert.deepEqual(adapter.errorBody("budget", "over"), {
    error: { message: "over", type: "insufficient_quota", param: null, code: "tokengrid_budget_exceeded" },
  });
});
