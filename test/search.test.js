import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadDotEnv, parseEnvFile, PROJECT_ROOT } from "../src/env.js";
import { formatSearchResult, getConfig, resolveSearchMode, searchOnce, webSearch } from "../src/search.js";

// Mock OpenAI-compatible endpoint. Behaviour is chosen by the model name.
let server;
let baseUrl;
const requests = [];
let lastSystem = "";
let blankOnceCalls = 0;
let roleHangCalls = 0;

function reply(res, model, withTools) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: `Answer from ${model} (${withTools ? "tool" : "native"}). See [docs](https://example.com/a).`,
            annotations: [{ type: "url_citation", url_citation: { url: "https://example.com/b", title: "Example B" } }],
          },
        },
      ],
      citations: ["https://example.com/a"],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
  );
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url.startsWith("/grounding-api-redirect/")) {
        const target = req.url.endsWith("/dead") ? null : `https://real.example.com/${req.url.split("/").pop()}`;
        res.writeHead(target ? 302 : 404, target ? { Location: target } : {});
        return res.end();
      }
      const body = JSON.parse(raw || "{}");
      const withTools = Array.isArray(body.tools);
      requests.push({ model: body.model, withTools, effort: body.reasoning_effort, temperature: body.temperature });
      lastSystem = body.messages?.[0]?.content;
      switch (body.model) {
        case "tool-504":
          if (withTools) {
            res.writeHead(504);
            return res.end("gateway timeout");
          }
          return reply(res, body.model, false);
        case "tool-hang":
          if (withTools) return; // never answers
          return reply(res, body.model, false);
        case "always-hang":
          return;
        case "tool-504-native-empty":
          if (withTools) {
            res.writeHead(504);
            return res.end("gateway timeout");
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "" } }] }));
        case "stream-slow":
        case "stream-stall": {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          const parts = body.model === "stream-slow" ? 10 : 2;
          let i = 0;
          const tick = setInterval(() => {
            send({ model: body.model, choices: [{ delta: { content: `part${i} `, annotations: i === 1 ? [{ type: "url_citation", url_citation: { url: "https://example.com/s", title: "S" } }] : undefined } }] });
            if (++i < parts) return;
            clearInterval(tick);
            if (body.model === "stream-stall") return; // stays open, sends nothing more
            send({ model: body.model, citations: ["https://example.com/c"], choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 42 } });
            res.end("data: [DONE]\n\n");
          }, 250);
          res.on("close", () => clearInterval(tick));
          return;
        }
        case "blank-once": {
          // First call drops with no text and no finish_reason, like a failed pooled account.
          blankOnceCalls++;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (blankOnceCalls === 1) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
            return res.end("data: [DONE]\n\n");
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "<think>hmm</think> Real answer." }, finish_reason: "stop" }] })}\n\n`);
          return res.end("data: [DONE]\n\n");
        }
        case "role-hang-once": {
          // First call: an empty role chunk at once, then silence (a stuck pooled account). Second call answers.
          roleHangCalls++;
          if (roleHangCalls === 1) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            return res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
          }
          return reply(res, body.model, withTools);
        }
        case "bare-urls":
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              choices: [{ finish_reason: "stop", message: { content: "It is v1 (source: https://nodejs.org/en/blog/release/v1). Also [blog](https://example.com/md) and https://x.org/page." } }],
            })
          );
        case "no-effort":
          if (body.reasoning_effort) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." } }));
          }
          return reply(res, body.model, withTools);
        case "empty":
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ choices: [{ finish_reason: "malformed_function_call", message: { content: "" } }] }));
        case "gemini-redirect": {
          const origin = baseUrl.replace(/\/v1$/, "");
          const cite = (id) => ({ type: "url_citation", url_citation: { title: "site.com", url: `${origin}/grounding-api-redirect/${id}` } });
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              model: body.model,
              choices: [{ finish_reason: "stop", message: { content: "Grounded answer.", annotations: [cite("p1"), cite("p1-dup"), cite("dead")] } }],
            })
          );
        }
        case "always-500":
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "boom" } }));
        default:
          return reply(res, body.model, withTools);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function cfg(overrides = {}) {
  return {
    baseUrl,
    apiKey: "test-key",
    defaultModel: "",
    fallbackModel: "",
    hybridModels: [],
    forceNativeModels: [],
    forceToolModels: [],
    timeoutMs: 2000,
    ...overrides,
  };
}

test("search mode: exact beats substring, unlisted models use the name heuristic", () => {
  const c = cfg({ forceNativeModels: ["gemini", "gpt-5"], forceToolModels: ["gemini-3.8-flash"] });
  assert.equal(resolveSearchMode("gemini-3.8-flash", c), "tool");
  assert.equal(resolveSearchMode("gemini-2.5-pro", c), "native");
  assert.equal(resolveSearchMode("gpt-5-6", c), "native");
  assert.equal(resolveSearchMode("grok-chat-fast", c), "tool");
  assert.equal(resolveSearchMode("claude-sonnet", c), "native");
  assert.equal(resolveSearchMode("Gemini-3.8-Flash", c), "tool");
});

test("api key is never borrowed from other tools' variables", () => {
  const saved = { ...process.env };
  try {
    delete process.env.MULTI_WEB_SEARCH_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = "should-not-be-used";
    process.env.OPENAI_API_KEY = "should-not-be-used";
    assert.equal(getConfig().apiKey, "");
  } finally {
    process.env = saved;
  }
});

test(".env is loaded but does not override variables that are already set", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, '# comment\r\nMWS_TEST_A="from file"\r\nMWS_TEST_B=from file\r\n');
  process.env.MWS_TEST_B = "from client";
  try {
    assert.deepEqual(parseEnvFile(file), { MWS_TEST_A: "from file", MWS_TEST_B: "from file" });
    assert.deepEqual(loadDotEnv(file), ["MWS_TEST_A"]);
    assert.equal(process.env.MWS_TEST_A, "from file");
    assert.equal(process.env.MWS_TEST_B, "from client");
  } finally {
    delete process.env.MWS_TEST_A;
    delete process.env.MWS_TEST_B;
    fs.rmSync(dir, { recursive: true });
  }
});

test("tool mode merges citations from all places without duplicates", async () => {
  const r = await searchOnce("grok-ok", "q", { cfg: cfg() });
  assert.equal(r.mode, "tool");
  assert.equal(r.rescuedFrom, null);
  assert.deepEqual(
    r.sources.map((s) => s.url),
    ["https://example.com/a", "https://example.com/b"]
  );
});

test("forced tool mode is honoured for a model without grok/gpt/search in its name", async () => {
  requests.length = 0;
  const r = await searchOnce("gemini-x", "q", { cfg: cfg({ forceToolModels: ["gemini-x"] }) });
  assert.equal(r.mode, "tool");
  assert.deepEqual(requests, [{ model: "gemini-x", withTools: true, effort: undefined, temperature: undefined }]);
});

test("reasoning effort: config default, per-call override, no temperature sent", async () => {
  requests.length = 0;
  await searchOnce("grok-ok", "q", { cfg: cfg({ reasoningEffort: "low" }) });
  await searchOnce("grok-ok", "q", { cfg: cfg({ reasoningEffort: "low" }), reasoningEffort: "high" });
  assert.deepEqual(
    requests.map((r) => [r.effort, r.temperature]),
    [["low", undefined], ["high", undefined]]
  );
});

test("a model that rejects reasoning_effort is retried without it, then skipped", async () => {
  requests.length = 0;
  const c = cfg({ reasoningEffort: "low", forceToolModels: ["no-effort"] });
  const first = await searchOnce("no-effort", "q", { cfg: c });
  assert.equal(first.mode, "tool");
  assert.equal(first.reasoningEffort, null);
  await searchOnce("no-effort", "q", { cfg: c });
  assert.deepEqual(
    requests.map((r) => [r.withTools, r.effort]),
    [[true, "low"], [true, undefined], [true, undefined]]
  );
});

test("reasoning_effort is not sent unless configured", () => {
  const saved = { ...process.env };
  try {
    delete process.env.MULTI_WEB_SEARCH_REASONING_EFFORT;
    assert.equal(getConfig().reasoningEffort, "");
  } finally {
    process.env = saved;
  }
});

test("focus picks the system prompt, and every prompt carries today's date", async () => {
  const today = new Date().toLocaleDateString("sv");
  await searchOnce("grok-ok", "q", { cfg: cfg() });
  assert.match(lastSystem, /balanced|concise/);
  assert.ok(lastSystem.endsWith(`Today is ${today}.`));
  await searchOnce("grok-ok", "q", { cfg: cfg(), focus: "precise" });
  assert.match(lastSystem, /newest one wins/);
  await searchOnce("grok-ok", "q", { cfg: cfg(), focus: "broad" });
  assert.match(lastSystem, /many distinct items/);
  await searchOnce("grok-ok", "q", { cfg: cfg(), focus: "broad", system: "custom" });
  assert.equal(lastSystem, "custom");
});

test("MULTI_WEB_SEARCH_FOCUS sets the default focus; 'normal' opts out per call", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      MULTI_WEB_SEARCH_BASE_URL: baseUrl,
      MULTI_WEB_SEARCH_API_KEY: "test-key",
      MULTI_WEB_SEARCH_MODEL: "grok-ok",
      MULTI_WEB_SEARCH_FOCUS: "broad",
      MULTI_WEB_SEARCH_FALLBACK_MODEL: "",
    });
    await webSearch("q");
    assert.match(lastSystem, /many distinct items/);
    await webSearch("q", { focus: "normal" });
    assert.match(lastSystem, /concise/);
    await webSearch("q", { focus: "precise" });
    assert.match(lastSystem, /newest one wins/);
    process.env.MULTI_WEB_SEARCH_FOCUS = "bogus";
    assert.equal(getConfig().focus, "");
  } finally {
    process.env = saved;
  }
});

test("an empty answer counts as a failure and triggers the fallback model", async () => {
  await assert.rejects(searchOnce("empty", "q", { cfg: cfg() }), (err) => err.code === "EMPTY" && /malformed_function_call/.test(err.message));
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      MULTI_WEB_SEARCH_BASE_URL: baseUrl,
      MULTI_WEB_SEARCH_API_KEY: "test-key",
      MULTI_WEB_SEARCH_MODEL: "empty",
      MULTI_WEB_SEARCH_FALLBACK_MODEL: "grok-ok",
      MULTI_WEB_SEARCH_HYBRID_MODELS: "",
    });
    const r = await webSearch("q");
    assert.equal(r.model, "grok-ok");
    assert.equal(r.fallbackFrom, "empty");
  } finally {
    process.env = saved;
  }
});

test("bare URLs in the answer text count as sources", async () => {
  const r = await searchOnce("bare-urls", "q", { cfg: cfg() });
  assert.deepEqual(r.sources.map((s) => s.url), ["https://example.com/md", "https://nodejs.org/en/blog/release/v1", "https://x.org/page"]);
});

test("grounding redirect links are resolved to the real page URLs", async () => {
  const r = await searchOnce("gemini-redirect", "q", { cfg: cfg({ forceToolModels: ["gemini-redirect"] }) });
  assert.deepEqual(
    r.sources.map((s) => s.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "")),
    ["https://real.example.com/p1", "https://real.example.com/p1-dup", "/grounding-api-redirect/dead"]
  );
});

test("a stream that keeps producing output runs past the timeout and keeps its citations", async () => {
  const start = Date.now();
  const r = await searchOnce("stream-slow", "q", { cfg: cfg({ timeoutMs: 1000, idleTimeoutMs: 1000 }) });
  assert.ok(Date.now() - start > 2000, "should outlive the 1s first-output timeout");
  assert.match(r.answer, /part0 .*part9/);
  assert.equal(r.finishReason, "stop");
  assert.equal(r.usage.total_tokens, 42);
  assert.deepEqual(r.sources.map((s) => s.url).sort(), ["https://example.com/c", "https://example.com/s"]);
});

test("a stream that goes silent returns the partial answer, marked as cut off", async () => {
  const start = Date.now();
  const r = await searchOnce("stream-stall", "q", { cfg: cfg({ timeoutMs: 5000, idleTimeoutMs: 600 }) });
  assert.ok(Date.now() - start < 2500);
  assert.equal(r.answer, "part0 part1");
  assert.equal(r.finishReason, "stalled");
  assert.match(formatSearchResult(r), /answer may be cut off/);
});

test("a dropped blank stream is retried once, and a leaked <think> block is removed", async () => {
  const r = await searchOnce("blank-once", "q", { cfg: cfg({ forceToolModels: ["blank-once"] }) });
  assert.equal(blankOnceCalls, 2);
  assert.equal(r.answer, "Real answer.");
  assert.deepEqual(r.retries, ["stream ended with no answer"]);
  assert.equal(r.mode, "tool");
});

test("a silent stream (only an empty role chunk) is dropped early and asked again", async () => {
  const start = Date.now();
  const r = await searchOnce("role-hang-once", "q", { cfg: cfg({ forceToolModels: ["role-hang-once"], timeoutMs: 800 }) });
  assert.equal(roleHangCalls, 2);
  assert.equal(r.mode, "tool");
  assert.match(r.retries[0], /no answer text after 1s/);
  assert.ok(Date.now() - start < 1500, "second attempt should start right after the first one's 0.8s limit");
  assert.match(formatSearchResult(r), /asked again after: no answer text/);
});

test("tool HTTP 504 falls back to native mode", async () => {
  const r = await searchOnce("tool-504", "q", { cfg: cfg({ forceToolModels: ["tool-504"] }) });
  assert.equal(r.mode, "native");
  assert.equal(r.rescuedFrom, "HTTP 504");
  assert.match(r.answer, /native/);
});

test("a model whose no-tool retry is empty skips that retry next time", async () => {
  requests.length = 0;
  const c = cfg({ forceToolModels: ["tool-504-native-empty"] });
  await assert.rejects(searchOnce("tool-504-native-empty", "q", { cfg: c }), (err) => err.code === "EMPTY" && /HTTP 504/.test(err.message));
  await assert.rejects(searchOnce("tool-504-native-empty", "q", { cfg: c }), (err) => err.code === "TOOL_FAILED" && /HTTP 504/.test(err.message));
  assert.deepEqual(
    requests.map((r) => r.withTools),
    [true, false, true]
  );
});

test("a tool call that keeps hanging is retried once, then fails instead of waiting longer", async () => {
  requests.length = 0;
  const start = Date.now();
  await assert.rejects(
    searchOnce("tool-hang", "q", { cfg: cfg({ forceToolModels: ["tool-hang"], timeoutMs: 600 }) }),
    (err) => err.code === "TIMEOUT" && /no answer text after 1s; then no answer text/.test(err.message)
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1600, `took ${elapsed}ms`);
  assert.deepEqual(requests.map((r) => r.withTools), [true, true]);
});

test("a call that never answers fails after two short attempts instead of hanging", async () => {
  const start = Date.now();
  await assert.rejects(
    searchOnce("always-hang", "q", { cfg: cfg({ forceToolModels: ["always-hang"], timeoutMs: 1000 }) }),
    (err) => err.code === "TIMEOUT" && /no answer text after 1s/.test(err.message)
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2400, `took ${elapsed}ms`);
});

test("client cancellation aborts the upstream request", async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 200);
  const start = Date.now();
  await assert.rejects(
    searchOnce("always-hang", "q", { cfg: cfg({ timeoutMs: 5000 }), signal: ctrl.signal }),
    (err) => err.code === "CANCELLED"
  );
  assert.ok(Date.now() - start < 1000);
});

test("hybrid search reports failed models and keeps the others", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      MULTI_WEB_SEARCH_BASE_URL: baseUrl,
      MULTI_WEB_SEARCH_API_KEY: "test-key",
      MULTI_WEB_SEARCH_MODEL: "hybrid",
      MULTI_WEB_SEARCH_HYBRID_MODELS: "grok-ok,always-500",
      MULTI_WEB_SEARCH_FORCE_NATIVE: "",
      MULTI_WEB_SEARCH_FORCE_TOOL: "",
      MULTI_WEB_SEARCH_TIMEOUT_MS: "2000",
    });
    const r = await webSearch("q");
    assert.equal(r.isHybrid, true);
    assert.deepEqual(
      r.perspectives.map((p) => p.status),
      ["success", "error"]
    );
    const text = formatSearchResult(r);
    assert.match(text, /## grok-ok \(tool mode, \d+\.\ds\)/);
    assert.match(text, /## always-500 \(failed\)/);
  } finally {
    process.env = saved;
  }
});

test("MCP server: one tool, compact text result, config from env", async () => {
  const blank = Object.fromEntries(
    Object.keys(parseEnvFile(path.join(PROJECT_ROOT, ".env"))).map((k) => [k, ""])
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, "src", "index.js")],
    env: {
      ...getDefaultEnvironment(),
      ...blank,
      MULTI_WEB_SEARCH_BASE_URL: baseUrl,
      MULTI_WEB_SEARCH_API_KEY: "test-key",
      MULTI_WEB_SEARCH_MODEL: "grok-ok",
      MULTI_WEB_SEARCH_HYBRID_MODELS: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["multi_api_web_search"]
    );
    assert.match(tools[0].inputSchema.properties.model.description, /default model 'grok-ok'/);

    const res = await client.callTool({ name: "multi_api_web_search", arguments: { query: "hello" } });
    assert.equal(res.isError, undefined);
    assert.equal(res.content.length, 1);
    assert.match(res.content[0].text, /Answer from grok-ok/);
    assert.doesNotMatch(res.content[0].text, /JSON/);
  } finally {
    await client.close();
  }
});
