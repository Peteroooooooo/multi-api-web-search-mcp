/**
 * Call multi-model Web Search models (Grok / Gemini / Multi-Agent / Hybrid / etc.)
 * with dynamic model selection, alias resolution, adaptive tool payloads,
 * dual-engine hybrid consensus search, and automatic fallback.
 */

const DEFAULT_BASE_URL = "";
const DEFAULT_TIMEOUT_MS = 60_000;

// Universal mode aliases for multi-engine consensus
export const MODE_ALIASES = {
  hybrid: "hybrid",
  both: "hybrid",
  all: "hybrid",
  consensus: "hybrid",
};

export function resolveModel(inputModel) {
  if (!inputModel || typeof inputModel !== "string") {
    return "";
  }
  const normalized = inputModel.trim().toLowerCase();
  if (MODE_ALIASES[normalized]) {
    return MODE_ALIASES[normalized];
  }
  return inputModel.trim();
}

function env(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export function getConfig() {
  const apiKey =
    env("MULTI_WEB_SEARCH_API_KEY") ||
    env("WEB_SEARCH_API_KEY") ||
    env("GROK_WEB_SEARCH_API_KEY") ||
    env("GROK2API_API_KEY") ||
    env("OPENAI_API_KEY") ||
    env("ANTHROPIC_AUTH_TOKEN");

  return {
    baseUrl: (
      env("MULTI_WEB_SEARCH_BASE_URL") ||
      env("WEB_SEARCH_BASE_URL") ||
      env("GROK_WEB_SEARCH_BASE_URL", DEFAULT_BASE_URL)
    ).replace(/\/+$/, ""),
    apiKey,
    defaultModel:
      env("MULTI_WEB_SEARCH_MODEL") ||
      env("WEB_SEARCH_MODEL") ||
      "",
    fallbackModel:
      env("MULTI_WEB_SEARCH_FALLBACK_MODEL") ||
      env("WEB_SEARCH_FALLBACK_MODEL") ||
      "",
    forceNativeModels: (
      env("MULTI_WEB_SEARCH_FORCE_NATIVE") ||
      env("FORCE_NATIVE") ||
      ""
    )
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    timeoutMs:
      Number(
        env("MULTI_WEB_SEARCH_TIMEOUT_MS") ||
        env("WEB_SEARCH_TIMEOUT_MS") ||
        env("GROK_WEB_SEARCH_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS))
      ) || DEFAULT_TIMEOUT_MS,
  };
}

function extractCitations(data, message) {
  const out = [];

  // 1. 检查根节点 citations (如 grok-chat-fast 返回的 URL 列表字符串)
  if (Array.isArray(data?.citations)) {
    for (const item of data.citations) {
      if (typeof item === "string" && item.startsWith("http")) {
        try {
          const parsed = new URL(item);
          out.push({
            title: parsed.hostname || "Source",
            url: item,
          });
        } catch {
          out.push({ title: "Source", url: item });
        }
      } else if (item && typeof item === "object" && item.url) {
        out.push({
          title: item.title || item.name || "Source",
          url: item.url,
        });
      }
    }
  }

  // 2. 检查 message.annotations 中的 url_citation (如 grok-4.20-multi-agent 返回的注解)
  const anns = message?.annotations;
  if (Array.isArray(anns)) {
    for (const a of anns) {
      if (a?.type === "url_citation" && a.url_citation?.url) {
        let hostname = "";
        try {
          hostname = new URL(a.url_citation.url).hostname;
        } catch {
          hostname = "Source";
        }
        out.push({
          title: a.url_citation.title && a.url_citation.title.length > 2 ? a.url_citation.title : hostname,
          url: a.url_citation.url,
          start_index: a.url_citation.start_index,
          end_index: a.url_citation.end_index,
        });
      }
    }
  }

  // 3. 从 markdown 正文中提取可能内嵌的 [n](https://...) 链接
  const content = String(message?.content || "");
  const mdLinkRegex = /\[(?:[^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = mdLinkRegex.exec(content)) !== null) {
    const url = match[1];
    try {
      const hostname = new URL(url).hostname;
      out.push({ title: hostname, url });
    } catch {
      out.push({ title: "Source", url });
    }
  }

  return out;
}

function normalizeSources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      if (typeof s === "string" && s.startsWith("http")) {
        return {
          title: "Web Link",
          url: s,
          type: "web",
        };
      }
      return {
        title: s?.title || s?.name || "",
        url: s?.url || s?.link || "",
        type: s?.type || "web",
        snippet: s?.snippet || s?.content || s?.description || undefined,
      };
    })
    .filter((s) => s.url || s.title);
}

async function executeSearchRequest(targetModel, query, maxSources, system, cfg) {
  // 判断是否走显式工具：
  // 1. 如果模型被配置在 MULTI_WEB_SEARCH_FORCE_NATIVE 中，坚决不带 tools，强制走 Native Grounding
  // 2. 否则对于 grok/gpt/search 等模型，默认优先挂载 web_search 显式工具
  const lower = targetModel.toLowerCase();
  const isForceNative =
    Array.isArray(cfg.forceNativeModels) &&
    cfg.forceNativeModels.some((m) => lower === m || lower.includes(m));

  const preferExplicitTool =
    !isForceNative && (lower.includes("grok") || lower.includes("gpt") || lower.includes("search"));

  const body = {
    model: targetModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: query },
    ],
    temperature: 0.2,
  };

  if (preferExplicitTool) {
    body.tools = [{ type: "web_search" }];
  }

  // 超时保护
  const timeout = cfg.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let resp;
  try {
    resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // 【Tool-First Auto-Rescue 机制】
    // 如果带 tools 遇到了 400（不支持tools）或者 504/502/503（上游搜索爬虫抽风超时），
    // 毫秒级自动去掉 tools，切到秒回的 Native 模式救场，100% 保证拿回正确答案！
    if ((resp.status === 400 || resp.status === 504 || resp.status === 502 || resp.status === 503) && body.tools) {
      delete body.tools;
      resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    }
  } catch (err) {
    // 若请求抛错且之前带了 tools，最后救场一次 Native
    if (body.tools) {
      delete body.tools;
      try {
        resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch {
        throw err;
      }
    } else {
      if (err?.name === "AbortError") {
        throw new Error(`Model [${targetModel}] timed out after ${timeout}ms`);
      }
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Upstream non-JSON response (${resp.status}): ${text.slice(0, 400)}`);
  }

  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 400);
    throw new Error(`Upstream error (${resp.status}) on [${targetModel}]: ${msg}`);
  }

  const message = data?.choices?.[0]?.message || {};
  const answer = String(message.content || "").trim();
  const sources = normalizeSources(data.search_sources);
  const citations = extractCitations(data, message);

  const seen = new Set(sources.map((s) => s.url).filter(Boolean));
  for (const c of citations) {
    if (c.url && !seen.has(c.url)) {
      sources.push({ title: c.title || "", url: c.url, type: "citation" });
      seen.add(c.url);
    }
  }

  return {
    query,
    model: data.model || targetModel,
    answer,
    sources: sources.slice(0, maxSources),
    citations,
    usage: data.usage || null,
    id: data.id || null,
  };
}

/**
 * 核心多模型协同并行搜索 (Multi-Engine Hybrid Search: 动态读取配置的 2~N 个模型并行发起请求并交叉聚合)
 */
async function executeHybridSearch(query, maxSources, system, cfg) {
  const hybridConf = env("MULTI_WEB_SEARCH_HYBRID_MODELS");
  if (!hybridConf) {
    throw new Error(
      "Missing MULTI_WEB_SEARCH_HYBRID_MODELS environment variable for hybrid mode. Please configure a comma-separated list of models (e.g. MULTI_WEB_SEARCH_HYBRID_MODELS=modelA,modelB)."
    );
  }
  const modelList = hybridConf
    .split(",")
    .map((s) => resolveModel(s.trim()))
    .filter(Boolean);

  if (modelList.length === 0) {
    throw new Error("No valid models found in MULTI_WEB_SEARCH_HYBRID_MODELS.");
  }

  // 100% 并发向全部 N 个模型发起搜索请求，互不阻塞
  const settled = await Promise.allSettled(
    modelList.map((m) => executeSearchRequest(m, query, maxSources, system, cfg))
  );

  const perspectives = [];
  const allSources = [];
  const seenUrls = new Set();
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let successCount = 0;

  for (let i = 0; i < modelList.length; i++) {
    const targetModel = modelList[i];
    const item = settled[i];

    if (item.status === "fulfilled" && item.value) {
      successCount++;
      const val = item.value;
      perspectives.push({
        model: targetModel,
        status: "success",
        answer: val.answer,
      });

      // 聚合所有模型的 Sources 并做 URL 级去重
      for (const s of val.sources || []) {
        if (s.url && !seenUrls.has(s.url)) {
          seenUrls.add(s.url);
          allSources.push(s);
        }
      }

      totalPromptTokens += val.usage?.prompt_tokens || 0;
      totalCompletionTokens += val.usage?.completion_tokens || 0;
      totalTokens += val.usage?.total_tokens || 0;
    } else {
      perspectives.push({
        model: targetModel,
        status: "error",
        error: item.reason?.message || "Unknown upstream error",
      });
    }
  }

  if (successCount === 0) {
    const errors = perspectives.map((p) => `${p.model}: ${p.error}`).join("\n");
    throw new Error(`All ${modelList.length} models failed in hybrid mode:\n${errors}`);
  }

  return {
    query,
    model: `hybrid (${modelList.join(" + ")})`,
    isHybrid: true,
    perspectives,
    sources: allSources.slice(0, maxSources),
    usage: {
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      total_tokens: totalTokens,
    },
  };
}

/**
 * @param {string} query
 * @param {{ model?: string, maxSources?: number, systemPrompt?: string, enableFallback?: boolean }} [opts]
 */
export async function webSearch(query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) {
    throw new Error("query is required");
  }

  const cfg = getConfig();
  if (!cfg.baseUrl) {
    throw new Error(
      "Missing API Base URL. Set MULTI_WEB_SEARCH_BASE_URL (or WEB_SEARCH_BASE_URL) in environment variables or .env file."
    );
  }
  if (!cfg.apiKey) {
    throw new Error(
      "Missing API key. Set MULTI_WEB_SEARCH_API_KEY (or WEB_SEARCH_API_KEY / GROK_WEB_SEARCH_API_KEY / OPENAI_API_KEY) in environment variables or .env file."
    );
  }

  const maxSources = Math.min(Math.max(Number(opts.maxSources) || 15, 1), 30);
  const system =
    opts.systemPrompt ||
    [
      "You are a web research assistant backed by live web search.",
      "Answer the user query using current web results.",
      "Be factual and concise.",
      "Prefer primary sources.",
      "Include inline citations when possible.",
      "If results conflict, say so briefly.",
      "Do not invent URLs.",
    ].join(" ");

  // 解析目标模型（支持通用别名）
  const requestedModel = opts.model ? resolveModel(opts.model) : cfg.defaultModel;
  if (!requestedModel) {
    throw new Error(
      "No search model specified. Please provide 'model' in your request or set MULTI_WEB_SEARCH_MODEL in your environment."
    );
  }

  // 1. 如果请求的是混合多模型模式 (hybrid / both / all / consensus)
  if (requestedModel === "hybrid") {
    return await executeHybridSearch(q, maxSources, system, cfg);
  }

  // 2. 单模型请求逻辑（若配置了 MULTI_WEB_SEARCH_FALLBACK_MODEL 则支持降级）
  try {
    return await executeSearchRequest(requestedModel, q, maxSources, system, cfg);
  } catch (primaryErr) {
    const fallbackModel = cfg.fallbackModel;
    const shouldFallback = opts.enableFallback !== false && fallbackModel && requestedModel !== fallbackModel;
    if (shouldFallback) {
      console.error(
        `[multi-search-mcp] Primary model [${requestedModel}] failed: ${primaryErr.message}. Falling back to [${fallbackModel}]...`
      );
      try {
        const fallbackRes = await executeSearchRequest(fallbackModel, q, maxSources, system, cfg);
        fallbackRes.fallbackFrom = requestedModel;
        return fallbackRes;
      } catch (fallbackErr) {
        throw new Error(
          `Both primary [${requestedModel}] and fallback [${fallbackModel}] failed.\nPrimary error: ${primaryErr.message}\nFallback error: ${fallbackErr.message}`
        );
      }
    }
    throw primaryErr;
  }
}

/** Pretty text block for MCP tool output. */
export function formatSearchResult(result) {
  const lines = [];

  if (result.isHybrid) {
    const list = result.perspectives || [];
    const names = list.map((p) => p.model).join(" + ");

    lines.push(`# Multi-Model Consensus Web Search Result`);
    lines.push(`Engines: ${names}`);
    lines.push(`Query: ${result.query}`);
    lines.push("");

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const icon = i === 0 ? "⚡" : i === 1 ? "💡" : i === 2 ? "🚀" : "🔎";
      lines.push(`## ${icon} Perspective: ${p.model}`);
      if (p.status === "success") {
        lines.push(p.answer || "(No response content)");
      } else {
        lines.push(`⚠️ Upstream query failed: ${p.error}`);
      }
      lines.push("");
    }
  } else {
    const fallbackNotice = result.fallbackFrom ? ` (Fallback from ${result.fallbackFrom})` : "";
    lines.push(`# Web search result (via ${result.model}${fallbackNotice})`);
    lines.push("");
    lines.push(`Query: ${result.query}`);
    lines.push("");
    lines.push("## Answer");
    lines.push(result.answer || "(empty)");
    lines.push("");
  }

  if (result.sources?.length) {
    lines.push("## Sources & Citations (Merged & Verified)");
    result.sources.forEach((s, i) => {
      const title = s.title || s.url || "source";
      lines.push(`${i + 1}. ${title}`);
      if (s.url) lines.push(`   ${s.url}`);
      if (s.snippet) lines.push(`   ${s.snippet}`);
    });
    lines.push("");
  } else {
    lines.push("## Sources");
    lines.push("(none returned by upstream)");
    lines.push("");
  }

  if (result.usage) {
    lines.push(
      `Tokens: prompt=${result.usage.prompt_tokens ?? "?"} completion=${result.usage.completion_tokens ?? "?"} total=${result.usage.total_tokens ?? "?"}`
    );
  }
  return lines.join("\n");
}
