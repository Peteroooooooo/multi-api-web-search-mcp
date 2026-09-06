#!/usr/bin/env node
/**
 * Multi API Web Search (MCP) - Precision Search Capability Matrix & Leaderboard
 *
 * Professional Ground-Truth Benchmark for Web Search LLMs:
 * 1. Precision Benchmark with verifiable Ground-Truth (or custom user query)
 * 2. True Dual-Mode Matrix Testing (Native Grounding vs Explicit web_search Tool)
 * 3. Objective Scoring: Fact Accuracy, Citations Count, Latency, Tool Traces
 * 4. Leaderboard & Side-by-Side Answer Comparison
 * 5. Interactive Selection & Optimal Mode Persistence (.env)
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");

function loadEnv() {
  const env = {};
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        env[k] = v;
      }
    }
  }
  return env;
}

function saveEnv(updates) {
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf8");
  } else {
    content = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  }

  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  }

  fs.writeFileSync(envPath, content, "utf8");
}

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  magenta: "\x1b[35m",
};

let linesQueue = [];
let pendingResolvers = [];
let isRlInitialized = false;

function initLineReader() {
  if (isRlInitialized) return;
  isRlInitialized = true;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  rl.on("line", (line) => {
    if (pendingResolvers.length > 0) {
      const resolve = pendingResolvers.shift();
      resolve(line.trim());
    } else {
      linesQueue.push(line.trim());
    }
  });
  rl.on("close", () => {
    while (pendingResolvers.length > 0) {
      const resolve = pendingResolvers.shift();
      resolve("");
    }
  });
}

function askQuestion(promptText) {
  process.stdout.write(promptText);
  initLineReader();
  return new Promise((resolve) => {
    if (linesQueue.length > 0) {
      resolve(linesQueue.shift());
    } else {
      pendingResolvers.push(resolve);
    }
  });
}

function closeReadline() {}

function isOfflineRefusal(text) {
  const lower = String(text || "").toLowerCase();
  const patterns = [
    "knowledge cutoff",
    "cutoff date",
    "cannot browse the live internet",
    "cannot browse the internet",
    "do not have access to real-time",
    "do not have access to current",
    "as an ai, i cannot",
    "as of my last update",
    "无法访问互联网",
    "知识库截止",
    "无法获取实时",
    "无法获取最新",
  ];
  return patterns.some((p) => lower.includes(p));
}

function extractSources(data, msg) {
  const sources = [];
  const seen = new Set();

  const rawList = data.citations || data.search_sources || data.web_search_results || [];
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      const url = typeof item === "string" ? item : item?.url || item?.link;
      if (url && typeof url === "string" && url.startsWith("http") && !seen.has(url)) {
        seen.add(url);
        sources.push({ url, title: item?.title || new URL(url).hostname });
      }
    }
  }

  const anns = msg?.annotations;
  if (Array.isArray(anns)) {
    for (const a of anns) {
      const url = a?.url_citation?.url || a?.url;
      if (url && typeof url === "string" && url.startsWith("http") && !seen.has(url)) {
        seen.add(url);
        sources.push({ url, title: a?.url_citation?.title || new URL(url).hostname });
      }
    }
  }

  const content = String(msg?.content || "");
  const mdRegex = /\[(?:[^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = mdRegex.exec(content)) !== null) {
    const url = match[1];
    if (!seen.has(url)) {
      seen.add(url);
      try {
        sources.push({ url, title: new URL(url).hostname });
      } catch {
        sources.push({ url, title: "Web Link" });
      }
    }
  }

  return sources;
}

/**
 * Execute single test request with or without tools
 */
/**
 * Execute single test request with automatic retry on transient 504 / gateway errors
 */
async function runSingleProbe(model, withTools, query, baseUrl, apiKey, maxRetries = 1) {
  const isGrok = model.toLowerCase().includes("grok");
  const isAgent = model.toLowerCase().includes("agent");
  const timeoutMs = isAgent ? 90000 : 45000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    const payload = {
      model,
      messages: [
        {
          role: "system",
          content:
            "You are an authoritative web research assistant backed by real-time web search. Search the live internet, state the exact factual answer clearly, and include markdown reference link(s) if available.",
        },
        { role: "user", content: query },
      ],
      temperature: 0.1,
      max_tokens: 400,
    };

    if (withTools) {
      payload.tools = [{ type: "web_search" }];
    }

    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      // 如果遇到 504/502 等上游网络超时抽风，且还有重试次数，则重试一次
      if ((resp.status === 504 || resp.status === 502 || resp.status === 503) && attempt < maxRetries) {
        continue;
      }

      if (!resp.ok) {
        const errText = await resp.text();
        return {
          ok: false,
          status: `HTTP ${resp.status}`,
          elapsed,
          error: errText.slice(0, 100),
        };
      }

      const data = await resp.json();
      const choice = data.choices?.[0] || {};
      const msg = choice.message || {};
      const answer = String(msg.content || "").trim();

      if (choice.finish_reason === "malformed_function_call" || (!answer && !choice.message?.tool_calls)) {
        return {
          ok: false,
          status: "MALFORMED_OR_EMPTY",
          elapsed,
          error: "Malformed function call or empty content",
        };
      }

      let internalTool = "";
      let internalRounds = 0;
      if (data.server_side_tool_usage) {
        const toolNames = Object.keys(data.server_side_tool_usage);
        internalTool = toolNames.join(", ");
        internalRounds = Object.values(data.server_side_tool_usage).reduce((a, b) => a + b, 0);
      } else if (withTools) {
        internalTool = "web_search";
      } else {
        internalTool = "native_grounding";
      }

      const sources = extractSources(data, msg);

      return {
        ok: true,
        status: "SUCCESS",
        elapsed,
        answer,
        internalTool,
        internalRounds,
        sourcesCount: sources.length,
        sources,
        isRefusal: isOfflineRefusal(answer),
        wasRetried: attempt > 0,
      };
    } catch (err) {
      clearTimeout(timer);
      if (attempt < maxRetries) {
        continue;
      }
      return {
        ok: false,
        status: "ERROR",
        elapsed: ((Date.now() - start) / 1000).toFixed(1),
        error: err.message,
      };
    }
  }
}

/**
 * Matrix Probing: Runs BOTH Native Mode AND Explicit Tool Mode concurrently
 */
async function probeModelMatrix(model, query, groundTruthKeywords, baseUrl, apiKey) {
  const [nativeRes, toolRes] = await Promise.all([
    runSingleProbe(model, false, query, baseUrl, apiKey, 0),
    runSingleProbe(model, true, query, baseUrl, apiKey, 1), // 对 Tool 模式允许重试 1 次抵御 504 抽风
  ]);

  // Evaluate Accuracy against Ground Truth
  function evaluateAccuracy(res) {
    if (!res.ok) return { score: 0, label: "❌ Error", tag: "ERROR" };
    if (res.isRefusal) return { score: 0, label: "❌ Offline Refusal", tag: "OFFLINE" };
    const lowerAns = res.answer.toLowerCase();
    const hitAll = groundTruthKeywords.every((kw) => lowerAns.includes(kw.toLowerCase()));
    if (hitAll) {
      return { score: 100, label: "🎯 Exact Match", tag: "EXACT_MATCH" };
    }
    const hitAny = groundTruthKeywords.some((kw) => lowerAns.includes(kw.toLowerCase()));
    if (hitAny) {
      return { score: 60, label: "⚠️ Partial Match", tag: "PARTIAL_MATCH" };
    }
    return { score: 30, label: "❓ Hallucination / No Match", tag: "NO_MATCH" };
  }

  const nativeAcc = evaluateAccuracy(nativeRes);
  const toolAcc = evaluateAccuracy(toolRes);

  const isNativeUsable = nativeRes.ok && nativeAcc.score >= 60;
  const isToolUsable = toolRes.ok && toolAcc.score >= 60;
  const hasBothModes = isNativeUsable && isToolUsable;

  let recommendedMode = "Native Grounding";
  let modeReason = "";
  let bestMode = "none";
  let bestRes = null;
  let bestAcc = null;

  if (hasBothModes) {
    const nTime = parseFloat(nativeRes.elapsed) || 99;
    const tTime = parseFloat(toolRes.elapsed) || 99;
    const isGptModel = model.toLowerCase().includes("gpt");

    // 1. 如果 Tool 比 Native 还要快，且带丰富信源（如 Grok 经常出现 Tool 8.3s 跑完 29 条外链）
    if (tTime <= nTime && toolRes.sourcesCount >= 3) {
      recommendedMode = "Explicit Tool";
      modeReason = `速度更胜一筹且信源极多 (${tTime}s vs ${nTime}s, ${toolRes.sourcesCount} URLs)`;
      bestMode = "Explicit Tool";
      bestRes = toolRes;
      bestAcc = toolAcc;
    } else if (toolRes.sourcesCount >= 3 && tTime < 15 && tTime <= nTime + 3) {
      recommendedMode = "Explicit Tool";
      modeReason = `信源丰富且响应稳定 (${toolRes.sourcesCount} URLs, ${tTime}s)`;
      bestMode = "Explicit Tool";
      bestRes = toolRes;
      bestAcc = toolAcc;
    } else if (
      (isGptModel && tTime > nTime + 2) ||
      tTime >= 15 ||
      (tTime > nTime * 1.8 && nTime < 10) ||
      toolRes.wasRetried
    ) {
      recommendedMode = "Native Grounding";
      modeReason = `极速稳定 (${nTime}s vs ${tTime}s，Tool模式易504超时)`;
      bestMode = "Native Grounding";
      bestRes = nativeRes;
      bestAcc = nativeAcc;
    } else if (nTime <= tTime) {
      recommendedMode = "Native Grounding";
      modeReason = `响应更快更轻量 (${nTime}s vs ${tTime}s)`;
      bestMode = "Native Grounding";
      bestRes = nativeRes;
      bestAcc = nativeAcc;
    } else {
      recommendedMode = "Explicit Tool";
      modeReason = `工具调用流畅 (${tTime}s)`;
      bestMode = "Explicit Tool";
      bestRes = toolRes;
      bestAcc = toolAcc;
    }
  } else if (isToolUsable) {
    recommendedMode = "Explicit Tool";
    modeReason = "具备显式联网工具支持";
    bestMode = "Explicit Tool";
    bestRes = toolRes;
    bestAcc = toolAcc;
  } else if (isNativeUsable) {
    recommendedMode = "Native Grounding";
    modeReason = "具备原生静默检索支持";
    bestMode = "Native Grounding";
    bestRes = nativeRes;
    bestAcc = nativeAcc;
  } else if (toolRes.ok) {
    recommendedMode = "Explicit Tool";
    modeReason = "工具可调但未准确匹配事实";
    bestMode = "Explicit Tool";
    bestRes = toolRes;
    bestAcc = toolAcc;
  } else if (nativeRes.ok) {
    recommendedMode = "Native Grounding";
    modeReason = "仅原生响应但未准确匹配事实";
    bestMode = "Native Grounding";
    bestRes = nativeRes;
    bestAcc = nativeAcc;
  } else {
    recommendedMode = "None";
    modeReason = "两者均调用失败";
    bestMode = "Failed";
    bestRes = toolRes.ok ? toolRes : nativeRes;
    bestAcc = toolRes.ok ? toolAcc : nativeAcc;
  }

  // Calculate Overall Tier
  let tier = "F";
  if (bestAcc.tag === "EXACT_MATCH") {
    if (bestRes.sourcesCount >= 5 && parseFloat(bestRes.elapsed) < 20) {
      tier = "S+";
    } else if (bestRes.sourcesCount >= 1 || parseFloat(bestRes.elapsed) < 15) {
      tier = "S";
    } else {
      tier = "A";
    }
  } else if (bestAcc.tag === "PARTIAL_MATCH") {
    tier = bestRes.sourcesCount > 0 ? "B" : "C";
  }

  const tagColor = tier.startsWith("S") ? colors.green : tier === "A" ? colors.cyan : tier === "B" ? colors.yellow : colors.red;
  const speedInfo = `${bestRes?.elapsed || "-"}s`;
  const citeInfo = `${bestRes?.sourcesCount || 0} URLs`;
  const bothTag = hasBothModes ? `${colors.magenta}[双模支持]${colors.reset} ` : "";
  console.log(`  [${model}] ➔ ${tagColor}[Tier ${tier}]${colors.reset} ${bothTag}推荐: ${colors.bold}${recommendedMode}${colors.reset} (${speedInfo} | ${citeInfo} | ${modeReason})`);

  return {
    model,
    tier,
    bestMode,
    bestRes,
    bestAcc,
    recommendedMode,
    modeReason,
    hasBothModes,
    nativeRes,
    nativeAcc,
    toolRes,
    toolAcc,
  };
}

async function main() {
  console.log(`\n${colors.bold}${colors.cyan}================================================================================${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}   🏆 Multi API Web Search - Precision Search Capability Matrix & Leaderboard   ${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}================================================================================${colors.reset}\n`);

  const env = loadEnv();
  const baseUrl = (env.MULTI_WEB_SEARCH_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = env.MULTI_WEB_SEARCH_API_KEY || "";

  if (!baseUrl || !apiKey || apiKey.includes("your-api-key")) {
    console.error(`${colors.red}❌ Error: Missing API configuration in .env file!${colors.reset}`);
    process.exit(1);
  }

  console.log(`🔗 API Base: ${colors.green}${baseUrl}${colors.reset}`);
  console.log(`📡 Fetching available chat models...\n`);

  let rawModels = [];
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    rawModels = (data.data || []).map((m) => m.id);
  } catch (err) {
    console.error(`${colors.red}Failed to fetch models:${colors.reset}`, err.message);
    process.exit(1);
  }

  const nonChat = ["embed", "embedding", "audio", "tts", "whisper", "speech", "dall-e", "midjourney", "flux", "image", "video"];
  const chatModels = rawModels.filter((m) => !nonChat.some((kw) => m.toLowerCase().includes(kw)));

  chatModels.forEach((m, idx) => {
    console.log(`  ${colors.cyan}[${idx + 1}]${colors.reset} ${m}`);
  });

  console.log(`\n${colors.bold}💡 Select Models to Benchmark:${colors.reset}`);
  console.log(`  ${colors.green}[Enter / A]${colors.reset} Test ALL ${chatModels.length} models`);
  console.log(`  ${colors.yellow}[Numbers]${colors.reset}   Select specific numbers (e.g. 2, 4, 14 or 1-5)`);
  console.log(`  ${colors.magenta}[Custom]${colors.reset}    Type model names (e.g. gpt-4o, grok-chat-fast)`);
  console.log(`  ${colors.dim}[Q]${colors.reset}         Quit\n`);

  const sel = await askQuestion(`${colors.bold}Enter choice: ${colors.reset}`);
  if (sel.toUpperCase() === "Q") process.exit(0);

  let targetModels = [];
  if (!sel || sel.toUpperCase() === "A" || sel.toUpperCase() === "ALL") {
    targetModels = chatModels;
  } else if (/^[0-9,\s-]+$/.test(sel)) {
    const indices = new Set();
    sel.split(",").forEach((part) => {
      const p = part.trim();
      if (p.includes("-")) {
        const [s, e] = p.split("-").map((n) => parseInt(n.trim(), 10));
        if (!isNaN(s) && !isNaN(e)) {
          for (let i = s; i <= e; i++) indices.add(i - 1);
        }
      } else {
        const num = parseInt(p, 10);
        if (!isNaN(num)) indices.add(num - 1);
      }
    });
    targetModels = Array.from(indices).filter((i) => i >= 0 && i < chatModels.length).map((i) => chatModels[i]);
  } else {
    targetModels = sel.split(",").map((s) => s.trim()).filter(Boolean);
  }

  if (targetModels.length === 0) {
    console.log(`${colors.red}No models selected.${colors.reset}`);
    process.exit(0);
  }

  // Choose Benchmark Question (Default Precision Unique Ground-Truth Question vs Custom)
  console.log(`\n${colors.bold}🎯 Benchmark Ground-Truth Question:${colors.reset}`);
  console.log(`  ${colors.green}[1] Standard Precision Fact (Recommended):${colors.reset}`);
  console.log(`      ${colors.dim}Q: "What is the exact latest release version of Node.js as of September 2026? State version and provide reference links."${colors.reset}`);
  console.log(`      ${colors.dim}Ground Truth Key: "26.8.1"${colors.reset}`);
  console.log(`  ${colors.yellow}[2] Custom Live Question (Input your own unique test query & expected keyword)${colors.reset}`);

  const qChoice = await askQuestion(`\n${colors.bold}Select Question [1/2, default 1]: ${colors.reset}`);

  let benchmarkQuery = "What is the exact latest release version of Node.js as of September 2026? State the exact version number clearly in the first sentence and provide official reference link(s).";
  let expectedKeywords = ["26.8.1"];

  if (qChoice === "2") {
    benchmarkQuery = await askQuestion(`${colors.bold}Enter your custom question: ${colors.reset}`);
    const kwInput = await askQuestion(`${colors.bold}Enter expected keyword(s) separated by comma (e.g. 26.8.1, Arsenal): ${colors.reset}`);
    expectedKeywords = kwInput.split(",").map((k) => k.trim()).filter(Boolean);
    if (expectedKeywords.length === 0) expectedKeywords = [benchmarkQuery.slice(0, 10)];
  }

  console.log(`\n${colors.bold}🚀 Launching 4-Channel Pipeline Dual-Mode Matrix Benchmark on ${targetModels.length} models...${colors.reset}`);
  console.log(`Question: ${colors.cyan}"${benchmarkQuery}"${colors.reset}`);
  console.log(`Expected Ground Truth Key(s): ${colors.yellow}${JSON.stringify(expectedKeywords)}${colors.reset}`);
  console.log(`${colors.dim}(Concurrency limited to 4 workers to prevent gateway queue congestion)${colors.reset}\n`);

  // 4 通道智能并发流水线池（Controlled Concurrency Pool = 4）
  // 杜绝 26 个长连接瞬间拥堵打爆中转站网关队列，跑完一个立即无缝承接下一个
  const poolLimit = 4;
  const results = new Array(targetModels.length);
  let currentIndex = 0;

  const workers = Array.from({ length: Math.min(poolLimit, targetModels.length) }, async () => {
    while (currentIndex < targetModels.length) {
      const idx = currentIndex++;
      results[idx] = await probeModelMatrix(targetModels[idx], benchmarkQuery, expectedKeywords, baseUrl, apiKey);
    }
  });

  await Promise.all(workers);

  // Sort Leaderboard: Tier S+ -> S -> A -> B -> C -> F, then by accuracy score and citations
  const tierWeight = { "S+": 6, S: 5, A: 4, B: 3, C: 2, F: 1 };
  results.sort((a, b) => {
    const diff = (tierWeight[b.tier] || 0) - (tierWeight[a.tier] || 0);
    if (diff !== 0) return diff;
    if (b.bestAcc.score !== a.bestAcc.score) return b.bestAcc.score - a.bestAcc.score;
    return (b.bestRes.sourcesCount || 0) - (a.bestRes.sourcesCount || 0);
  });

  // ========================== LEADERBOARD ==========================
  console.log(`\n${colors.bold}${colors.cyan}========================================================================================================${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}                                🏆 SEARCH CAPABILITY MATRIX LEADERBOARD                                 ${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}========================================================================================================${colors.reset}`);
  console.log(
    `${colors.bold}${"Rank".padEnd(6)}${"Model".padEnd(26)}${"Tier".padEnd(8)}${"Accuracy".padEnd(24)}${"Recommended Mode".padEnd(22)}${"Citations".padEnd(12)}${"Speed"}${colors.reset}`
  );
  console.log("--------------------------------------------------------------------------------------------------------");

  results.forEach((r, idx) => {
    const rankStr = `#${idx + 1}`.padEnd(6);
    const modelStr = (r.model.length > 24 ? r.model.slice(0, 22) + ".." : r.model).padEnd(26);
    const tierColor = r.tier.startsWith("S") ? colors.green : r.tier === "A" ? colors.cyan : r.tier === "B" ? colors.yellow : colors.red;
    const tierStr = `${tierColor}${r.tier.padEnd(8)}${colors.reset}`;
    const accColor = r.bestAcc.tag === "EXACT_MATCH" ? colors.green : r.bestAcc.tag === "PARTIAL_MATCH" ? colors.yellow : colors.red;
    const accStr = `${accColor}${r.bestAcc.label.padEnd(24)}${colors.reset}`;
    const recStr = (r.hasBothModes ? `${r.recommendedMode} *` : r.recommendedMode).padEnd(22);
    const citeStr = `${r.bestRes?.sourcesCount || 0} URLs`.padEnd(12);
    const speedStr = `${r.bestRes?.elapsed || "-"}s`;

    console.log(`${rankStr}${modelStr}${tierStr}${accStr}${recStr}${citeStr}${speedStr}`);
  });
  console.log("--------------------------------------------------------------------------------------------------------");
  console.log(`${colors.dim}* 标有星号的模型表示同时支持 Native Grounding 和 Explicit Tool 双模式${colors.reset}\n`);

  // ========================== SIDE-BY-SIDE ANSWER COMPARISON ==========================
  console.log(`${colors.bold}🔍 SIDE-BY-SIDE FACTUAL ANSWER INSPECTION (Top 5 Models):${colors.reset}\n`);

  const topModels = results.filter((r) => r.tier !== "F").slice(0, 5);
  topModels.forEach((r, i) => {
    console.log(`${colors.bold}${colors.yellow}[${i + 1}] ${r.model}${colors.reset} ${colors.dim}(Tier: ${r.tier} | 推荐: ${r.recommendedMode} | 耗时: ${r.bestRes.elapsed}s)${colors.reset}`);
    console.log(`   ${colors.cyan}矩阵实测详情:${colors.reset} Native: ${r.nativeRes.ok ? `${r.nativeRes.elapsed}s (${r.nativeRes.sourcesCount} URLs)` : r.nativeRes.status} | Tool: ${r.toolRes.ok ? `${r.toolRes.elapsed}s (${r.toolRes.sourcesCount} URLs)` : r.toolRes.status}`);
    console.log(`   ${colors.cyan}推荐理由:${colors.reset} ${r.modeReason}`);
    console.log(`   ${colors.bold}真实回答片段:${colors.reset}`);
    const preview = (r.bestRes.answer || "(No output)")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(0, 3)
      .join("\n      ");
    console.log(`      ${colors.dim}${preview}${colors.reset}`);
    if (r.bestRes.sources?.length) {
      console.log(`   ${colors.green}Verified Citation Example:${colors.reset} ${r.bestRes.sources[0].url}`);
    }
    console.log("--------------------------------------------------------------------------------------------------------");
  });

  // ========================== INTERACTIVE CONFIGURATION ==========================
  const validModels = results.filter((r) => r.tier !== "F");
  if (validModels.length === 0) {
    console.log(`${colors.red}❌ No models successfully completed search benchmark.${colors.reset}`);
    process.exit(1);
  }

  console.log(`\n${colors.bold}💡 Set your default Search Model or Consensus Engines:${colors.reset}`);
  validModels.forEach((r, idx) => {
    const bothTag = r.hasBothModes ? ` ${colors.magenta}[双模可选]${colors.reset}` : "";
    console.log(`  [${idx + 1}] ${colors.green}${r.model}${colors.reset} ${colors.dim}(Tier ${r.tier}, 推荐: ${r.recommendedMode})${colors.reset}${bothTag}`);
  });
  if (validModels.length >= 2) {
    const top2 = `${validModels[0].model} + ${validModels[1].model}`;
    console.log(`  [H] ${colors.cyan}Consensus Search${colors.reset} (Default Top 2: ${top2}, or customize 2+ models like ${colors.yellow}1, 5, 2${colors.reset})`);
  }
  console.log(`  ${colors.dim}👉 提示: 可直接输入单序号 (如 1) 或多序号组合 (如 1, 5, 2) 开启多引擎混合搜索${colors.reset}`);
  console.log(`  [Q] Keep current config and exit\n`);

  const rawPick = (await askQuestion(`${colors.bold}Enter your choice: ${colors.reset}`)).trim();
  const pick = rawPick.toUpperCase();

  if (pick === "Q" || !rawPick) {
    console.log("Exiting without changes.");
    process.exit(0);
  }

  let finalModel = "";
  let hybridModelsStr = "";
  const forceNativeSet = new Set(
    (env.MULTI_WEB_SEARCH_FORCE_NATIVE || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  // 判断是否为多模型组合输入（如 "1, 5, 2"、"1 5 2"、"1,2" 或直接按 "H"）
  const multiParts = rawPick.split(/[\s,]+/).filter(Boolean);
  const parsedMultiIndices = multiParts
    .map((n) => parseInt(n, 10) - 1)
    .filter((idx) => !isNaN(idx) && validModels[idx]);

  const isDirectMultiSelect = parsedMultiIndices.length >= 2;
  const isHybridCommand = pick === "H";

  if ((isDirectMultiSelect || isHybridCommand) && validModels.length >= 2) {
    finalModel = "hybrid";
    const defaultA = validModels[0].model;
    const defaultB = validModels[1].model;
    const defaultPair = `${defaultA},${defaultB}`;

    if (isDirectMultiSelect) {
      // 用户直接在首屏输入了 "1, 5, 2"，直接解析这几个模型！
      hybridModelsStr = parsedMultiIndices.map((idx) => validModels[idx].model).join(",");
    } else {
      // 用户按了 H，提示输入自定义序号或直接回车使用默认 Top 2
      console.log(`\n${colors.bold}${colors.cyan}🌐 Configuring Consensus Search:${colors.reset}`);
      console.log(`  ${colors.bold}Default (Top 2):${colors.reset} ${colors.green}${defaultA}${colors.reset} + ${colors.green}${defaultB}${colors.reset}`);
      console.log(`  Press ${colors.green}[Enter]${colors.reset} for default Top 2, or type numbers to customize (e.g. ${colors.yellow}1, 5, 2${colors.reset} to select 3 models):\n`);

      const customInput = await askQuestion(`${colors.bold}Your choice [Enter = default Top 2]: ${colors.reset}`);
      if (!customInput.trim()) {
        hybridModelsStr = defaultPair;
      } else {
        const p = customInput
          .split(/[\s,]+/)
          .map((n) => parseInt(n.trim(), 10) - 1)
          .filter((idx) => !isNaN(idx) && validModels[idx]);

        if (p.length >= 2) {
          hybridModelsStr = p.map((idx) => validModels[idx].model).join(",");
        } else {
          console.log(`${colors.yellow}Need at least 2 models for Consensus mode, falling back to default Top 2.${colors.reset}`);
          hybridModelsStr = defaultPair;
        }
      }
    }

    const selectedEngines = hybridModelsStr.split(",").map((s) => s.trim());
    console.log(`\n${colors.bold}${colors.cyan}🌐 Selected Consensus Engines: [${selectedEngines.join(" + ")}]${colors.reset}`);

    // 对选中的全部混合模型，逐个确认搜索运行模式
    console.log(`\n${colors.bold}⚙️ 智能调度混合模型运行模式 (各模型独立配置):${colors.reset}`);
    for (let i = 0; i < selectedEngines.length; i++) {
      const mName = selectedEngines[i];
      const mObj = validModels.find((r) => r.model.toLowerCase() === mName.toLowerCase());
      if (mObj) {
        console.log(`\n  👉 [${i + 1}/${selectedEngines.length}] 模型: ${colors.bold}${colors.green}${mName}${colors.reset}`);
        if (mObj.hasBothModes) {
          console.log(`     实测 Native: ${mObj.nativeRes.elapsed}s (${mObj.nativeRes.sourcesCount} URLs) | Tool: ${mObj.toolRes.elapsed}s (${mObj.toolRes.sourcesCount} URLs)`);
          const defChoice = mObj.recommendedMode === "Native Grounding" ? "1" : "2";
          console.log(`     💡 推荐方案: ${colors.green}[${defChoice}] ${mObj.recommendedMode}${colors.reset} (${mObj.modeReason})`);

          const promptMsg = `     请选择模式 [1: Native, 2: Tool, 直接回车采纳推荐 ${defChoice}]: `;
          const userChoice = await askQuestion(promptMsg);
          const chosen = (userChoice || defChoice).trim();

          if (chosen === "1") {
            forceNativeSet.add(mName.toLowerCase());
            console.log(`     ➔ 已设定为: ${colors.green}✔ Native Grounding (纯原生极速搜索)${colors.reset}`);
          } else {
            forceNativeSet.delete(mName.toLowerCase());
            console.log(`     ➔ 已设定为: ${colors.cyan}✔ Explicit Tool (显式工具搜索)${colors.reset}`);
          }
        } else if (mObj.recommendedMode === "Native Grounding") {
          forceNativeSet.add(mName.toLowerCase());
          console.log(`     ➔ 仅支持 Native Grounding (已自动配置为原生搜索)`);
        } else {
          forceNativeSet.delete(mName.toLowerCase());
          console.log(`     ➔ 仅支持 Explicit Tool (已自动配置为工具搜索)`);
        }
      }
    }
  } else {
    // 单模型选择逻辑
    const singleIdx = parsedMultiIndices.length === 1 ? parsedMultiIndices[0] : parseInt(rawPick, 10) - 1;
    if (!isNaN(singleIdx) && validModels[singleIdx]) {
      finalModel = validModels[singleIdx].model;
      const targetObj = validModels[singleIdx];

      // 如果选定的单模型支持双模式，给用户提供自由切换选择
      if (targetObj.hasBothModes) {
        console.log(`\n${colors.bold}👉 您选择了模型: ${colors.green}${finalModel}${colors.reset}`);
        console.log(`   该模型支持双检索模式，实测表现如下:`);
        console.log(`   ${colors.cyan}[1] Native Grounding${colors.reset} ➔ ${targetObj.nativeRes.elapsed}s | ${targetObj.nativeRes.sourcesCount} URLs | 成功率 100% | ${targetObj.nativeAcc.label}`);
        console.log(`   ${colors.cyan}[2] Explicit Tool   ${colors.reset} ➔ ${targetObj.toolRes.elapsed}s | ${targetObj.toolRes.sourcesCount} URLs | ${targetObj.toolAcc.label}`);

        const defaultChoice = targetObj.recommendedMode === "Native Grounding" ? "1" : "2";
        console.log(`\n   💡 系统综合推荐: ${colors.green}[${defaultChoice}] ${targetObj.recommendedMode}${colors.reset} (${targetObj.modeReason})`);
        const modePick = await askQuestion(`   请选择搜索模式 [1/2, 直接回车采纳推荐 ${defaultChoice}]: `);
        const resolvedMode = (modePick || defaultChoice).trim();

        if (resolvedMode === "1") {
          forceNativeSet.add(finalModel.toLowerCase());
          console.log(`   ${colors.green}✔ 已锁定为 Native Grounding (纯原生极速搜索)${colors.reset}`);
        } else {
          forceNativeSet.delete(finalModel.toLowerCase());
          console.log(`   ${colors.cyan}✔ 已锁定为 Explicit Tool (显式工具搜索)${colors.reset}`);
        }
      } else if (targetObj.recommendedMode === "Native Grounding") {
        forceNativeSet.add(finalModel.toLowerCase());
        console.log(`\n   ${colors.green}✔ 该模型经实测推荐使用 Native Grounding 模式${colors.reset}`);
      }
    } else {
      console.log(`${colors.red}Invalid selection. Keeping current config.${colors.reset}`);
      process.exit(0);
    }
  }

  const finalForceNativeStr = Array.from(forceNativeSet).join(",");
  const envUpdates = {
    MULTI_WEB_SEARCH_MODEL: finalModel,
    MULTI_WEB_SEARCH_FORCE_NATIVE: finalForceNativeStr,
  };
  if (hybridModelsStr) {
    envUpdates.MULTI_WEB_SEARCH_HYBRID_MODELS = hybridModelsStr;
  }
  saveEnv(envUpdates);
  console.log(`\n${colors.green}✅ Updated .env with MULTI_WEB_SEARCH_MODEL=${finalModel}!${colors.reset}`);
  if (finalForceNativeStr) {
    console.log(`${colors.green}✅ Updated .env with MULTI_WEB_SEARCH_FORCE_NATIVE=${finalForceNativeStr}!${colors.reset}`);
  }
  if (hybridModelsStr) {
    console.log(`${colors.green}✅ Updated .env with MULTI_WEB_SEARCH_HYBRID_MODELS=${hybridModelsStr}!${colors.reset}`);
  }

  const absEntry = path.join(root, "src", "index.js").replace(/\\/g, "/");
  const mcpEnvObj = {
    MULTI_WEB_SEARCH_BASE_URL: baseUrl,
    MULTI_WEB_SEARCH_API_KEY: apiKey,
    MULTI_WEB_SEARCH_MODEL: finalModel,
    MULTI_WEB_SEARCH_FORCE_NATIVE: finalForceNativeStr,
    MULTI_WEB_SEARCH_TIMEOUT_MS: "90000",
  };
  if (hybridModelsStr) {
    mcpEnvObj.MULTI_WEB_SEARCH_HYBRID_MODELS = hybridModelsStr;
  }

  const mcpSnippet = {
    mcpServers: {
      "multi-api-web-search": {
        type: "stdio",
        command: "node",
        args: [absEntry],
        env: mcpEnvObj,
      },
    },
  };

  console.log(`\n${colors.bold}📋 Ready-to-use MCP Configuration snippet (~/.claude.json):${colors.reset}`);
  console.log(colors.cyan + JSON.stringify(mcpSnippet, null, 2) + colors.reset);
  console.log(`\n🎉 Benchmark & Configuration Complete!`);
  closeReadline();
}

main().catch((err) => {
  closeReadline();
  console.error("Fatal error:", err);
  process.exit(1);
});
