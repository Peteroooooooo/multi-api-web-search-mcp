/**
 * Web search through any OpenAI-compatible endpoint whose models can search
 * the live web, either silently (native grounding) or via an explicit
 * `web_search` tool. Supports per-model mode routing, multi-model (hybrid)
 * search, fallback models, and hard per-call timeouts.
 */

// Max wait for the first word of the answer, per attempt. Measured on grok2api and AIStudio:
// healthy answers start in 3-12 s (grok-chat-fast averages 4.8 s over 85 requests, 2 took over
// 30 s); broken pooled accounts send nothing until the relay gives up at 120 s. So a silent
// request is abandoned early and sent again, which usually lands on a working account.
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 2;
// After the first output, a stream may keep going as long as data keeps arriving,
// up to this total; it is cut after DEFAULT_IDLE_TIMEOUT_MS without data.
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MAX_TOTAL_MS = 180_000;
const DEFAULT_MAX_SOURCES = 15;
const RESCUE_STATUSES = new Set([400, 502, 503, 504]);
const REDIRECT_PATH = /^https?:\/\/[^/]+\/grounding-api-redirect\//;
const REDIRECT_TIMEOUT_MS = 5_000;
export const REASONING_EFFORTS = ["low", "medium", "high"];
// Models that answered 400 to reasoning_effort in this process; later calls leave it out.
const effortRejected = new Set();
// Models whose no-tool retry came back empty in this process; later tool failures skip that retry.
const nativeUseless = new Set();

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a web research assistant backed by live web search.",
  "Answer the user query using current web results.",
  "Be factual and concise.",
  "Prefer primary sources.",
  "Include inline citations when possible.",
  "If results conflict, say so briefly.",
  "Do not invent URLs.",
].join(" ");

export const FOCUS_PROMPTS = {
  precise: [
    "You are a fact-checking research assistant backed by live web search.",
    "Find the single correct, current answer.",
    "Search for the primary source (official site, docs, release notes, changelog, filing, original paper) and check its date.",
    "If the question asks for the latest or current state, make sure no newer version, release or update exists before answering; the newest one wins over older pages that rank higher.",
    "Confirm the key fact with a second independent source.",
    "Put the direct answer in the first sentence with exact names, numbers and dates.",
    "If sources disagree, say which is newer or more authoritative and why.",
    "If you cannot confirm it, say so instead of guessing.",
    "Keep it short. Cite every factual claim. Do not invent URLs.",
  ].join(" "),
  broad: [
    "You are an exploratory research assistant backed by live web search.",
    "Cover the topic as widely as you can: search several times with different phrasings, angles and synonyms, in English and in the language of the query, and across source types (papers, official sites, news, forums, code repositories).",
    "Prefer many distinct items over depth on one. Include recent and lesser-known items, not only the mainstream ones.",
    "Group the findings into distinct directions. For each item give one or two sentences on what it is and what makes it different, plus its source and date.",
    "Mark items you could not verify.",
    "End with one line on what you did not cover or where sources were thin.",
    "Every item needs a real source. Do not invent URLs.",
  ].join(" "),
};
export const FOCUSES = Object.keys(FOCUS_PROMPTS);

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function buildSystemPrompt(focus) {
  return `${FOCUS_PROMPTS[focus] || DEFAULT_SYSTEM_PROMPT} Today is ${localDate()}.`;
}

export const MODE_ALIASES = {
  hybrid: "hybrid",
  both: "hybrid",
  all: "hybrid",
  consensus: "hybrid",
};

export function resolveModel(inputModel) {
  if (!inputModel || typeof inputModel !== "string") return "";
  const trimmed = inputModel.trim();
  return MODE_ALIASES[trimmed.toLowerCase()] || trimmed;
}

function env(name, fallback = "") {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function envList(name) {
  return env(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getConfig() {
  return {
    baseUrl: env("MULTI_WEB_SEARCH_BASE_URL").replace(/\/+$/, ""),
    apiKey: env("MULTI_WEB_SEARCH_API_KEY"),
    defaultModel: resolveModel(env("MULTI_WEB_SEARCH_MODEL")),
    fallbackModel: resolveModel(env("MULTI_WEB_SEARCH_FALLBACK_MODEL")),
    hybridModels: envList("MULTI_WEB_SEARCH_HYBRID_MODELS").filter((m) => resolveModel(m) !== "hybrid"),
    forceNativeModels: envList("MULTI_WEB_SEARCH_FORCE_NATIVE").map((s) => s.toLowerCase()),
    forceToolModels: envList("MULTI_WEB_SEARCH_FORCE_TOOL").map((s) => s.toLowerCase()),
    timeoutMs: Number(env("MULTI_WEB_SEARCH_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS,
    idleTimeoutMs: Number(env("MULTI_WEB_SEARCH_IDLE_TIMEOUT_MS")) || DEFAULT_IDLE_TIMEOUT_MS,
    reasoningEffort: env("MULTI_WEB_SEARCH_REASONING_EFFORT").toLowerCase(),
    focus: FOCUSES.includes(env("MULTI_WEB_SEARCH_FOCUS").toLowerCase()) ? env("MULTI_WEB_SEARCH_FOCUS").toLowerCase() : "",
  };
}

export const SETUP_HINT = "run `npm run setup` in the multi-api-web-search-mcp folder";

export function checkConfig(cfg) {
  const hint = `Fill it in .env, then ${SETUP_HINT} to pick models automatically.`;
  if (!cfg.baseUrl) throw new Error(`Missing MULTI_WEB_SEARCH_BASE_URL. ${hint}`);
  if (!cfg.apiKey) throw new Error(`Missing MULTI_WEB_SEARCH_API_KEY. ${hint}`);
}

/**
 * Pick "tool" or "native" for a model. Entries in FORCE_TOOL / FORCE_NATIVE
 * match exactly or as a substring (e.g. "gemini" matches "gemini-3.8-flash");
 * an exact match beats a substring match, a longer substring beats a shorter one,
 * and a tie goes to native. Unlisted models fall back to a name heuristic.
 */
export function resolveSearchMode(model, cfg) {
  const lower = String(model).toLowerCase();
  const strength = (patterns) => {
    let best = -1;
    for (const p of patterns) {
      if (lower === p) return Infinity;
      if (lower.includes(p)) best = Math.max(best, p.length);
    }
    return best;
  };
  const native = strength(cfg.forceNativeModels || []);
  const tool = strength(cfg.forceToolModels || []);
  if (native < 0 && tool < 0) {
    return /grok|gpt|search/.test(lower) ? "tool" : "native";
  }
  return tool > native ? "tool" : "native";
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function extractCitations(data, message) {
  const out = [];

  // Root-level citations: plain URL strings or { url, title } objects.
  if (Array.isArray(data?.citations)) {
    for (const item of data.citations) {
      if (typeof item === "string" && item.startsWith("http")) {
        out.push({ title: hostnameOf(item) || "Source", url: item });
      } else if (item && typeof item === "object" && item.url) {
        out.push({ title: item.title || item.name || "Source", url: item.url });
      }
    }
  }

  // OpenAI-style message.annotations[].url_citation
  if (Array.isArray(message?.annotations)) {
    for (const a of message.annotations) {
      const url = a?.url_citation?.url || a?.url;
      if (typeof url === "string" && url.startsWith("http")) {
        const title = a?.url_citation?.title;
        out.push({ title: title && title.length > 2 ? title : hostnameOf(url) || "Source", url });
      }
    }
  }

  // Markdown links inside the answer text.
  const content = String(message?.content || "");
  const mdLinkRegex = /\[(?:[^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = mdLinkRegex.exec(content)) !== null) {
    out.push({ title: hostnameOf(match[1]) || "Source", url: match[1] });
  }

  // Bare URLs in the text, e.g. "(source: https://...)". Relays such as claude2api cite only this way.
  for (const m of content.matchAll(/(?<![(\[])\bhttps?:\/\/[^\s<>"'`]+/g)) {
    const url = m[0].replace(/[.,;:!?)\]*_]+$/, "");
    if (url.length > 10) out.push({ title: hostnameOf(url) || "Source", url });
  }

  return out;
}

function normalizeSources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      if (typeof s === "string" && s.startsWith("http")) {
        return { title: hostnameOf(s), url: s };
      }
      return {
        title: s?.title || s?.name || "",
        url: s?.url || s?.link || "",
        snippet: s?.snippet || s?.content || s?.description || undefined,
      };
    })
    .filter((s) => s.url || s.title);
}

/**
 * Gemini grounding returns opaque, expiring redirect links. Follow each one
 * (HEAD, no body) to get the real page URL; keep the original on failure.
 */
async function resolveRedirectSources(sources, timeoutMs, signal) {
  const targets = sources.filter((s) => REDIRECT_PATH.test(s.url || ""));
  if (targets.length === 0 || timeoutMs <= 0) return sources;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(REDIRECT_TIMEOUT_MS, timeoutMs));
  const onCancel = () => controller.abort();
  signal?.addEventListener("abort", onCancel, { once: true });
  try {
    await Promise.all(
      targets.map(async (s) => {
        try {
          const resp = await fetch(s.url, { method: "HEAD", redirect: "manual", signal: controller.signal });
          const location = resp.headers.get("location");
          if (location && /^https?:\/\//.test(location)) s.url = location;
        } catch {}
      })
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCancel);
  }
  const seen = new Set();
  return sources.filter((s) => !s.url || (!seen.has(s.url) && seen.add(s.url)));
}

function taggedError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * One streamed POST to /chat/completions. `firstByteMs` limits the wait for the
 * first data event (search happens before it, with no bytes on the wire); after
 * that the call keeps going while data arrives and only stops after `idleMs`
 * of silence or at `until`. A stall after some content returns that partial
 * answer with finish_reason "stalled". Non-streaming JSON replies are passed through.
 * Returns { status, ok, text } where text is a regular chat.completion JSON body.
 */
async function postChat(cfg, body, firstByteMs, signal, { idleMs = cfg.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS, until = Infinity } = {}) {
  if (signal?.aborted) throw taggedError("Search cancelled by client", "CANCELLED");

  const controller = new AbortController();
  let reason = null;
  let timer = null;
  const arm = (ms, why) => {
    clearTimeout(timer);
    const left = Math.min(ms, until - Date.now());
    const final = left < ms ? "TOTAL" : why;
    timer = setTimeout(() => {
      reason = final;
      controller.abort();
    }, Math.max(1, left));
  };
  arm(firstByteMs, "FIRST_BYTE");
  const onCancel = () => controller.abort();
  signal?.addEventListener("abort", onCancel, { once: true });

  const acc = { content: "", annotations: [], citations: null, searchSources: null, usage: null, model: null, finish: null, error: null };
  let gotData = false;
  const fail = (err) => {
    if (signal?.aborted) return taggedError("Search cancelled by client", "CANCELLED");
    if (reason === "FIRST_BYTE") return taggedError(`no answer text after ${Math.round(firstByteMs / 1000)}s`, "TIMEOUT");
    if (reason === "IDLE") return taggedError(`stream stalled: no output for ${Math.round(idleMs / 1000)}s`, "STALLED");
    if (reason === "TOTAL") return taggedError(`stopped at the ${Math.round(MAX_TOTAL_MS / 1000)}s total limit`, "TIMEOUT");
    return err;
  };

  try {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal: controller.signal,
    });
    if (!resp.ok || !/event-stream/i.test(resp.headers.get("content-type") || "")) {
      return { status: resp.status, ok: resp.ok, text: await resp.text() };
    }

    const decoder = new TextDecoder();
    let buf = "";
    const handle = (line) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      if (chunk.error) acc.error = chunk.error;
      acc.model ||= chunk.model;
      if (chunk.usage) acc.usage = chunk.usage;
      if (Array.isArray(chunk.citations) && chunk.citations.length) acc.citations = chunk.citations;
      const sources = chunk.search_sources || chunk.web_search_results;
      if (Array.isArray(sources) && sources.length) acc.searchSources = sources;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || choice.message || {};
      if (typeof delta.content === "string") acc.content += delta.content;
      if (Array.isArray(delta.annotations)) acc.annotations.push(...delta.annotations);
      if (choice.finish_reason) acc.finish = choice.finish_reason;
      // Only real text proves the model is answering; grok2api sends an empty role chunk at once.
      if (!gotData && acc.content) {
        gotData = true;
        arm(idleMs, "IDLE");
      }
    };

    try {
      for await (const part of resp.body) {
        if (gotData) arm(idleMs, "IDLE");
        buf += decoder.decode(part, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          handle(buf.slice(0, nl).trim());
          buf = buf.slice(nl + 1);
        }
      }
      handle(buf.trim());
    } catch (err) {
      if (!acc.content || signal?.aborted || !reason) throw err;
      acc.finish = "stalled";
    }

    if (acc.error && !acc.content) {
      const msg = acc.error.message || JSON.stringify(acc.error);
      return { status: 502, ok: false, text: JSON.stringify({ error: { message: `error inside stream: ${msg}` } }) };
    }
    const data = {
      model: acc.model,
      choices: [{ finish_reason: acc.finish, message: { content: acc.content, annotations: acc.annotations } }],
      usage: acc.usage,
    };
    if (acc.citations) data.citations = acc.citations;
    if (acc.searchSources) data.search_sources = acc.searchSources;
    return { status: resp.status, ok: true, text: JSON.stringify(data) };
  } catch (err) {
    throw fail(err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCancel);
  }
}

/**
 * Ask one model once.
 * mode "tool" sends tools=[web_search]; if that fails (HTTP 400/5xx, timeout,
 * network error) and `rescue` is on, it retries once without tools. The whole
 * call, rescue included, stays within `timeoutMs`.
 *
 * @param {string} targetModel
 * @param {string} query
 * @param {{ cfg?: object, mode?: "tool"|"native", rescue?: boolean, maxSources?: number,
 *           system?: string, focus?: "precise"|"broad", reasoningEffort?: string, timeoutMs?: number,
 *           signal?: AbortSignal }} [opts]
 */
export async function searchOnce(targetModel, query, opts = {}) {
  const cfg = opts.cfg || getConfig();
  const mode = opts.mode || resolveSearchMode(targetModel, cfg);
  const rescue = opts.rescue !== false;
  const timeoutMs = opts.timeoutMs || cfg.timeoutMs;
  const maxSources = opts.maxSources || DEFAULT_MAX_SOURCES;
  const start = Date.now();

  const body = {
    model: targetModel,
    messages: [
      { role: "system", content: opts.system || buildSystemPrompt(opts.focus) },
      { role: "user", content: query },
    ],
  };
  const effort = opts.reasoningEffort || cfg.reasoningEffort;
  if (effort && !effortRejected.has(targetModel)) body.reasoning_effort = effort;

  // Endpoints that don't know reasoning_effort answer 400; retry once without it.
  // Each attempt waits up to timeoutMs for the first word; once text flows it may run to the total cap.
  const post = async () => {
    const streamOpts = { until: start + MAX_TOTAL_MS };
    const first = await postChat(cfg, body, timeoutMs, opts.signal, streamOpts);
    if (!body.reasoning_effort || first.status !== 400 || !/reasoning/i.test(first.text)) return first;
    delete body.reasoning_effort;
    effortRejected.add(targetModel);
    return postChat(cfg, body, timeoutMs, opts.signal, streamOpts);
  };

  let usedMode = mode;
  let rescuedFrom = null;
  const retries = []; // why earlier attempts were dropped
  if (mode === "tool") body.tools = [{ type: "web_search" }];
  const fail = (msg, code) => taggedError(`Model [${targetModel}] ${retries.length ? `${retries.join("; ")}; then ` : ""}${msg}`, code);

  let data = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !data; attempt++) {
    const last = attempt === MAX_ATTEMPTS;
    let resp;
    try {
      resp = await post();
    } catch (err) {
      // Silence means a stuck upstream (often one bad pooled account): drop it and ask again.
      if (err.code !== "TIMEOUT" || !/no answer text/.test(err.message) || last) throw fail(err.message, err.code);
      retries.push(err.message);
      continue;
    }
    // A gateway error in tool mode may mean the tool itself is the problem: try once without it.
    if (!resp.ok && usedMode === "tool" && rescue && RESCUE_STATUSES.has(resp.status) && !last) {
      rescuedFrom = `HTTP ${resp.status}`;
      if (nativeUseless.has(targetModel)) throw fail(`tool search failed (${rescuedFrom}); this model does not search without the tool`, "TOOL_FAILED");
      delete body.tools;
      usedMode = "native";
      continue;
    }
    let d;
    try {
      d = resp.text ? JSON.parse(resp.text) : {};
    } catch {
      throw new Error(`Upstream non-JSON response (${resp.status}) on [${targetModel}]: ${resp.text.slice(0, 400)}`);
    }
    if (!resp.ok) {
      const msg = d?.error?.message || d?.message || resp.text.slice(0, 400);
      throw fail(`upstream error (${resp.status}): ${msg}`, `HTTP_${resp.status}`);
    }
    // grok2api ends the stream at once with no text and no finish_reason when its account fails.
    const c = d?.choices?.[0] || {};
    if (!String(c.message?.content || "").trim() && !c.finish_reason && !last) {
      retries.push("stream ended with no answer");
      continue;
    }
    data = d;
  }

  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  let sources = normalizeSources(data.search_sources || data.web_search_results);
  const seen = new Set(sources.map((s) => s.url).filter(Boolean));
  for (const c of extractCitations(data, message)) {
    if (!seen.has(c.url)) {
      sources.push(c);
      seen.add(c.url);
    }
  }
  // Reasoning models behind some relays leak their <think> block into the content.
  const answer = String(message.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!answer) {
    const finish = choice.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : "";
    if (rescuedFrom) {
      nativeUseless.add(targetModel);
      throw fail(`tool search failed (${rescuedFrom}) and the no-tool retry returned an empty answer${finish}`, "EMPTY");
    }
    throw fail(`returned an empty answer in ${usedMode} mode${finish}`, "EMPTY");
  }
  sources = await resolveRedirectSources(sources, Math.min(REDIRECT_TIMEOUT_MS, start + MAX_TOTAL_MS - Date.now()), opts.signal);

  return {
    query,
    model: data.model || targetModel,
    mode: usedMode,
    rescuedFrom,
    retries,
    reasoningEffort: body.reasoning_effort || null,
    answer,
    finishReason: choice.finish_reason || null,
    sources: sources.slice(0, maxSources),
    usage: data.usage || null,
    elapsedMs: Date.now() - start,
  };
}

/** Ask every model in MULTI_WEB_SEARCH_HYBRID_MODELS in parallel and list their answers side by side. */
async function executeHybridSearch(query, opts) {
  const { cfg } = opts;
  if (cfg.hybridModels.length === 0) {
    throw new Error(
      "Hybrid mode needs MULTI_WEB_SEARCH_HYBRID_MODELS (comma-separated model names, e.g. modelA,modelB). Run doctor to pick them."
    );
  }

  const settled = await Promise.allSettled(cfg.hybridModels.map((m) => searchOnce(m, query, opts)));
  if (opts.signal?.aborted) throw new Error("Search cancelled by client");

  const perspectives = [];
  const allSources = [];
  const seenUrls = new Set();
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  settled.forEach((item, i) => {
    const model = cfg.hybridModels[i];
    if (item.status === "fulfilled") {
      const val = item.value;
      perspectives.push({
        model,
        status: "success",
        mode: val.mode,
        rescuedFrom: val.rescuedFrom,
        retries: val.retries,
        elapsedMs: val.elapsedMs,
        finishReason: val.finishReason,
        answer: val.answer,
      });
      for (const s of val.sources) {
        if (s.url && !seenUrls.has(s.url)) {
          seenUrls.add(s.url);
          allSources.push(s);
        }
      }
      usage.prompt_tokens += val.usage?.prompt_tokens || 0;
      usage.completion_tokens += val.usage?.completion_tokens || 0;
      usage.total_tokens += val.usage?.total_tokens || 0;
    } else {
      perspectives.push({ model, status: "error", error: item.reason?.message || "Unknown upstream error" });
    }
  });

  if (!perspectives.some((p) => p.status === "success")) {
    const errors = perspectives.map((p) => `${p.model}: ${p.error}`).join("\n");
    throw new Error(`All ${perspectives.length} models failed in hybrid mode:\n${errors}`);
  }

  return {
    query,
    model: `hybrid (${cfg.hybridModels.join(" + ")})`,
    isHybrid: true,
    perspectives,
    sources: allSources.slice(0, opts.maxSources),
    usage,
  };
}

/**
 * @param {string} query
 * @param {{ model?: string, maxSources?: number, systemPrompt?: string, focus?: "precise"|"broad",
 *           reasoningEffort?: string, enableFallback?: boolean, signal?: AbortSignal }} [opts]
 */
export async function webSearch(query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query is required");

  const cfg = getConfig();
  checkConfig(cfg);

  const requestedModel = opts.model ? resolveModel(opts.model) : cfg.defaultModel;
  const focus = opts.focus === "normal" ? "" : opts.focus || cfg.focus;
  if (!requestedModel) {
    throw new Error(
      `No search model configured yet: ${SETUP_HINT} (tests your endpoint's models and saves the best one), or pass 'model' in the request.`
    );
  }

  const callOpts = {
    cfg,
    maxSources: Math.min(Math.max(Number(opts.maxSources) || (focus === "broad" ? 30 : DEFAULT_MAX_SOURCES), 1), 30),
    system: opts.systemPrompt,
    focus,
    reasoningEffort: opts.reasoningEffort,
    signal: opts.signal,
  };

  if (requestedModel === "hybrid") {
    return executeHybridSearch(q, callOpts);
  }

  try {
    return await searchOnce(requestedModel, q, callOpts);
  } catch (primaryErr) {
    const fallbackModel = cfg.fallbackModel;
    const shouldFallback =
      opts.enableFallback !== false &&
      primaryErr.code !== "CANCELLED" &&
      fallbackModel &&
      fallbackModel !== "hybrid" &&
      fallbackModel !== requestedModel;
    if (!shouldFallback) throw primaryErr;

    console.error(
      `[multi-api-web-search] Primary model [${requestedModel}] failed: ${primaryErr.message}. Falling back to [${fallbackModel}]...`
    );
    try {
      const fallbackRes = await searchOnce(fallbackModel, q, callOpts);
      fallbackRes.fallbackFrom = requestedModel;
      return fallbackRes;
    } catch (fallbackErr) {
      throw new Error(
        `Both primary [${requestedModel}] and fallback [${fallbackModel}] failed.\nPrimary error: ${primaryErr.message}\nFallback error: ${fallbackErr.message}`
      );
    }
  }
}

function describeRun({ mode, elapsedMs, rescuedFrom, finishReason, retries }) {
  const parts = [`${mode} mode`, `${(elapsedMs / 1000).toFixed(1)}s`];
  if (retries?.length) parts.push(`asked again after: ${retries.join("; ")}`);
  if (rescuedFrom) parts.push(`tool search failed (${rescuedFrom}), answered without tool`);
  if (finishReason === "stalled") parts.push("output stalled, answer may be cut off");
  return parts.join(", ");
}

/** Compact text block for MCP tool output. */
export function formatSearchResult(result) {
  const lines = [];

  if (result.isHybrid) {
    const list = result.perspectives || [];
    lines.push(`# Multi-model web search (${list.length} models, answers listed separately; compare them)`);
    lines.push(`Query: ${result.query}`);
    lines.push("");
    for (const p of list) {
      if (p.status === "success") {
        lines.push(`## ${p.model} (${describeRun(p)})`);
        lines.push(p.answer || "(empty answer)");
      } else {
        lines.push(`## ${p.model} (failed)`);
        lines.push(`Error: ${p.error}`);
      }
      lines.push("");
    }
  } else {
    const via = [result.model, describeRun(result)];
    if (result.fallbackFrom) via.push(`fallback from ${result.fallbackFrom}`);
    lines.push(`# Web search result (${via.join(", ")})`);
    lines.push(`Query: ${result.query}`);
    lines.push("");
    lines.push("## Answer");
    lines.push(result.answer || "(empty answer)");
    lines.push("");
  }

  if (result.sources?.length) {
    lines.push(result.isHybrid ? "## Sources (merged, deduplicated)" : "## Sources");
    result.sources.forEach((s, i) => {
      const title = s.title && s.title !== s.url ? s.title : "";
      lines.push(title ? `${i + 1}. ${title} - ${s.url}` : `${i + 1}. ${s.url}`);
      if (s.snippet) lines.push(`   ${s.snippet}`);
    });
  } else {
    lines.push("## Sources");
    lines.push("(none returned by upstream)");
  }

  if (result.usage?.total_tokens) {
    lines.push("");
    lines.push(`Tokens: ${result.usage.total_tokens}`);
  }
  return lines.join("\n");
}
