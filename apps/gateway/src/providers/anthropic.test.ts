import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicUsageAccumulator, extractAnthropicPromptFeatures } from "./anthropic.js";

function sse(events: [string, unknown][]): string {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

const STREAM = sse([
  [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 25,
          output_tokens: 1,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 1500,
          cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1000 },
        },
      },
    },
  ],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["ping", { type: "ping" }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Héllo — ✓" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      // Cumulative, and repeats the input figures: summing would double them.
      usage: { input_tokens: 25, output_tokens: 312, cache_read_input_tokens: 4000, cache_creation_input_tokens: 1500 },
    },
  ],
  ["message_stop", { type: "message_stop" }],
]);

function feed(acc: AnthropicUsageAccumulator, body: string, chunkSize: number): void {
  const bytes = Buffer.from(body, "utf8");
  for (let i = 0; i < bytes.length; i += chunkSize) acc.push(bytes.subarray(i, i + chunkSize));
  acc.end();
}

test("streamed usage is taken from the latest cumulative figures, not summed", () => {
  const acc = new AnthropicUsageAccumulator(true);
  feed(acc, STREAM, 4096);
  const r = acc.result("req_abc");
  assert.ok(r);
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(r.providerRequestId, "req_abc");
  assert.deepEqual(r.usage, {
    inputTokens: 25,
    outputTokens: 312,
    cacheReadTokens: 4000,
    cacheWrite5mTokens: 500,
    cacheWrite1hTokens: 1000,
  });
  assert.equal(r.usageComplete, true);
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.pricingTier, "standard");
});

test("chunks split at every byte boundary, including inside UTF-8 and CRLF, give the same result", () => {
  const crlf = STREAM.replace(/\n/g, "\r\n");
  const whole = new AnthropicUsageAccumulator(true);
  feed(whole, crlf, 1 << 20);
  const bytewise = new AnthropicUsageAccumulator(true);
  feed(bytewise, crlf, 1);
  assert.deepEqual(bytewise.result("r"), whole.result("r"));
  assert.equal(bytewise.result("r")?.usage.outputTokens, 312);
});

test("a stream cut before message_delta is reported incomplete with the floor it saw", () => {
  const cut = STREAM.slice(0, STREAM.indexOf("event: message_delta"));
  const acc = new AnthropicUsageAccumulator(true);
  feed(acc, cut, 17);
  const r = acc.result(null);
  assert.ok(r);
  assert.equal(r.usageComplete, false);
  assert.equal(r.usage.outputTokens, 1);
  assert.equal(r.providerRequestId, "msg_01");
});

test("non-streaming JSON body", () => {
  const acc = new AnthropicUsageAccumulator(false);
  feed(
    acc,
    JSON.stringify({
      id: "msg_02",
      type: "message",
      model: "claude-haiku-4-5",
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 0 },
    }),
    7,
  );
  const r = acc.result("req_x");
  assert.ok(r);
  // A bare total with no TTL breakdown is the default 5-minute write.
  assert.equal(r.usage.cacheWrite5mTokens, 300);
  assert.equal(r.usage.cacheWrite1hTokens, 0);
  assert.equal(r.stopReason, "max_tokens");
  assert.equal(r.usageComplete, true);
});

test("an error body yields no metered call", () => {
  const acc = new AnthropicUsageAccumulator(false);
  feed(acc, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), 64);
  assert.equal(acc.result("req_e"), null);
});

test("server tool use and fast mode are surfaced, not dropped", () => {
  const acc = new AnthropicUsageAccumulator(false);
  feed(
    acc,
    JSON.stringify({
      id: "msg_03",
      type: "message",
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2, speed: "fast", server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 } },
    }),
    1024,
  );
  const r = acc.result("req_f");
  assert.equal(r?.pricingTier, "fast");
  assert.deepEqual(r?.unpricedUnits, { web_search_requests: 3 });
});


const doc = "Substation log. ".repeat(500);
const req = (question: string, extra: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      model: "claude-opus-5-5",
      max_tokens: 100,
      system: "You are terse.",
      messages: [{ role: "user", content: [{ type: "text", text: doc }, { type: "text", text: question }] }],
      ...extra,
    }),
  );

test("prompt features: document is prefix, the question is the final turn, no text leaks", () => {
  const f = extractAnthropicPromptFeatures(req("Which feeder tripped at 14:02?"), "k:");
  assert.ok(f);
  assert.equal(f.lastUserChars, "Which feeder tripped at 14:02?".length);
  assert.ok(f.prefixChars >= doc.length);
  assert.equal(f.hasSystem, true);
  assert.equal(f.usesCacheControl, false);
  assert.ok(!JSON.stringify(f).includes("Substation") && !JSON.stringify(f).includes("feeder"));
});

test("same prefix, different question: prefix hash equal, final-turn simhash differs", () => {
  const a = extractAnthropicPromptFeatures(req("Which feeder tripped at 14:02?"), "k:");
  const b = extractAnthropicPromptFeatures(req("Summarise the overnight load profile for the north bus."), "k:");
  assert.ok(a && b);
  assert.equal(a.prefixHash, b.prefixHash);
  assert.notEqual(a.lastUserSimhash, b.lastUserSimhash);
});

test("format spec and cache control are detected", () => {
  const f = extractAnthropicPromptFeatures(req("Answer in JSON."), "k:");
  assert.equal(f?.hasFormatSpec, true);
  const cached = extractAnthropicPromptFeatures(
    req("q", { system: [{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } }] }),
    "k:",
  );
  assert.equal(cached?.usesCacheControl, true);
});

test("non-Messages bodies yield null", () => {
  assert.equal(extractAnthropicPromptFeatures(Buffer.from("not json"), "k:"), null);
  assert.equal(extractAnthropicPromptFeatures(Buffer.from("{}"), "k:"), null);
});
