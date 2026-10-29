#!/usr/bin/env node
/**
 * Multi API Web Search (MCP) - Search Capability Doctor
 *
 * 1. Lists the endpoint's chat models and benchmarks the ones you pick.
 * 2. Tests each model twice, in native mode and with the explicit web_search tool,
 *    using the same request code as the MCP server.
 * 3. Scores answers against a ground truth fetched live (latest Node.js release),
 *    or your own question.
 * 4. Saves the chosen model(s) and per-model search mode into .env and prints
 *    a one-line command to register the server in Claude Code.
 *
 * You always choose which models get tested (menu, --models a,b, or --all).
 * --auto (npm run setup) then decides for you: it re-checks the best few on extra
 * live questions and saves the winner as default and the runner-up as fallback.
 * Without --auto you see the leaderboard and pick the default yourself.
 */

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { ENV_PATH, PROJECT_ROOT, parseEnvFile, saveEnv } from "../src/env.js";
import { getConfig, searchOnce } from "../src/search.js";
import { checkbox } from "./picker.js";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  magenta: "\x1b[35m",
};

const SERVER_NAME = "multi-api-web-search";
const ENTRY = path.join(PROJECT_ROOT, "src", "index.js").replace(/\\/g, "/");

/** One line of free text. The reader is closed again so the arrow-key menus get stdin back. */
function askQuestion(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    let answered = false;
    rl.question(promptText, (line) => {
      answered = true;
      rl.close();
      resolve(line.trim());
    });
    rl.on("close", () => answered || resolve(""));
  });
}

/** Single-choice arrow menu; returns the chosen value, or exits on Esc. */
async function choose(title, options, defaultIndex = 0) {
  const picked = await checkbox({ title, items: options, checked: [defaultIndex], single: true });
  if (!picked) process.exit(0);
  return options[picked[0]].value;
}

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

function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/**
 * Release facts straight from nodejs.org, so the benchmark answers never go stale:
 * the newest release (version, date, V8) and the newest version of the two most
 * recent LTS lines below it.
 */
async function fetchLatestNodeRelease() {
  const res = await fetch("https://nodejs.org/dist/index.json", { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const releases = (await res.json())
    .map((r) => ({ version: String(r.version || "").replace(/^v/, ""), date: r.date, v8: r.v8, lts: r.lts }))
    .filter((r) => /^\d+\.\d+\.\d+$/.test(r.version))
    .sort((a, b) => compareSemver(b.version, a.version));
  if (!releases.length) throw new Error("no releases in index.json");

  const latest = releases[0];
  const major = (v) => v.split(".")[0];
  const newestPerMajor = new Map();
  for (const r of releases) if (!newestPerMajor.has(major(r.version))) newestPerMajor.set(major(r.version), r);
  const ltsLines = [...newestPerMajor.entries()]
    .filter(([m]) => m !== major(latest.version) && releases.some((r) => r.lts && major(r.version) === m))
    .slice(0, 2)
    .map(([m, r]) => ({ major: m, version: r.version }));

  return { ...latest, major: major(latest.version), ltsLines };
}

/** Extra live-graded questions used by --auto to separate the top models. */
function extraQuestions(facts) {
  const qs = [];
  if (facts.ltsLines.length === 2) {
    const [a, b] = facts.ltsLines;
    qs.push({
      query: `What are the latest patch versions of Node.js ${b.major}.x and ${a.major}.x right now? Give both exact version numbers.`,
      keywords: [b.version, a.version],
    });
  }
  if (facts.v8) {
    qs.push({
      query: `Which V8 engine version does the newest Node.js ${facts.major}.x release ship with? Give the exact version number.`,
      keywords: [facts.v8.split(".").slice(0, 3).join(".")],
    });
  }
  return qs;
}

/**
 * One probe in a fixed mode, no automatic tool->native rescue, so each mode is measured on its own.
 * Tool mode gets one retry on gateway errors (502/503/504).
 */
async function runSingleProbe(model, mode, query, cfg) {
  const maxRetries = mode === "tool" ? 1 : 0;
  let lastFailure = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    try {
      const r = await searchOnce(model, query, { cfg, mode, rescue: false, maxSources: 30 });
      const elapsed = (r.elapsedMs / 1000).toFixed(1);
      if (r.finishReason === "malformed_function_call" || !r.answer) {
        return { ok: false, status: "MALFORMED_OR_EMPTY", elapsed, error: "Malformed function call or empty content" };
      }
      return {
        ok: true,
        status: "SUCCESS",
        elapsed,
        answer: r.answer,
        sourcesCount: r.sources.length,
        sources: r.sources,
        isRefusal: isOfflineRefusal(r.answer),
        wasRetried: attempt > 0,
        effortSent: r.reasoningEffort,
      };
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const status =
        err.code === "TIMEOUT" ? "TIMEOUT"
        : err.code === "EMPTY" ? "MALFORMED_OR_EMPTY"
        : err.code?.startsWith("HTTP_") ? err.code.replace("_", " ")
        : "ERROR";
      lastFailure = { ok: false, status, elapsed, error: String(err.message).slice(0, 160) };
      if (!["HTTP_502", "HTTP_503", "HTTP_504"].includes(err.code)) break;
    }
  }
  return lastFailure;
}

/** Runs native mode and tool mode concurrently and picks the better one. */
async function probeModelMatrix(model, query, groundTruthKeywords, cfg) {
  const [nativeRes, toolRes] = await Promise.all([
    runSingleProbe(model, "native", query, cfg),
    runSingleProbe(model, "tool", query, cfg),
  ]);

  function evaluateAccuracy(res) {
    if (!res.ok) return { score: 0, label: "❌ Error", tag: "ERROR" };
    if (res.isRefusal) return { score: 0, label: "❌ Offline Refusal", tag: "OFFLINE" };
    const lowerAns = res.answer.toLowerCase();
    if (groundTruthKeywords.every((kw) => lowerAns.includes(kw.toLowerCase()))) {
      return { score: 100, label: "🎯 Exact Match", tag: "EXACT_MATCH" };
    }
    if (groundTruthKeywords.some((kw) => lowerAns.includes(kw.toLowerCase()))) {
      return { score: 60, label: "⚠️ Partial Match", tag: "PARTIAL_MATCH" };
    }
    return { score: 30, label: "❓ Hallucination / No Match", tag: "NO_MATCH" };
  }

  const nativeAcc = evaluateAccuracy(nativeRes);
  const toolAcc = evaluateAccuracy(toolRes);

  const isNativeUsable = nativeRes.ok && nativeAcc.score >= 60;
  const isToolUsable = toolRes.ok && toolAcc.score >= 60;
  const hasBothModes = isNativeUsable && isToolUsable;

  const pickTool = (reason) => ({ recommendedMode: "Explicit Tool", modeReason: reason, bestRes: toolRes, bestAcc: toolAcc });
  const pickNative = (reason) => ({ recommendedMode: "Native Grounding", modeReason: reason, bestRes: nativeRes, bestAcc: nativeAcc });

  let pick;
  if (hasBothModes) {
    const nTime = parseFloat(nativeRes.elapsed) || 99;
    const tTime = parseFloat(toolRes.elapsed) || 99;
    const isGptModel = model.toLowerCase().includes("gpt");

    if (tTime <= nTime && toolRes.sourcesCount >= 3) {
      pick = pickTool(`速度更快且信源更多 (${tTime}s vs ${nTime}s, ${toolRes.sourcesCount} URLs)`);
    } else if (toolRes.sourcesCount >= 3 && tTime < 15 && tTime <= nTime + 3) {
      pick = pickTool(`信源丰富且响应稳定 (${toolRes.sourcesCount} URLs, ${tTime}s)`);
    } else if ((isGptModel && tTime > nTime + 2) || tTime >= 15 || (tTime > nTime * 1.8 && nTime < 10) || toolRes.wasRetried) {
      pick = pickNative(`更快更稳 (${nTime}s vs ${tTime}s，Tool 模式较慢或需要重试)`);
    } else if (nTime <= tTime) {
      pick = pickNative(`响应更快 (${nTime}s vs ${tTime}s)`);
    } else {
      pick = pickTool(`工具调用流畅 (${tTime}s)`);
    }
  } else if (isToolUsable) {
    pick = pickTool("只有工具模式答对");
  } else if (isNativeUsable) {
    pick = pickNative("只有原生模式答对");
  } else if (toolRes.ok) {
    pick = pickTool("工具模式可调用但没答对");
  } else if (nativeRes.ok) {
    pick = pickNative("原生模式有响应但没答对");
  } else {
    pick = { recommendedMode: "None", modeReason: "两种模式都调用失败", bestRes: toolRes, bestAcc: toolAcc };
  }
  const { recommendedMode, modeReason, bestRes, bestAcc } = pick;

  let tier = "F";
  if (bestAcc.tag === "EXACT_MATCH") {
    if (bestRes.sourcesCount >= 5 && parseFloat(bestRes.elapsed) < 20) tier = "S+";
    else if (bestRes.sourcesCount >= 1 || parseFloat(bestRes.elapsed) < 15) tier = "S";
    else tier = "A";
  } else if (bestAcc.tag === "PARTIAL_MATCH") {
    tier = bestRes.sourcesCount > 0 ? "B" : "C";
  }

  const tagColor = tier.startsWith("S") ? colors.green : tier === "A" ? colors.cyan : tier === "B" ? colors.yellow : colors.red;
  const bothTag = hasBothModes ? `${colors.magenta}[双模支持]${colors.reset} ` : "";
  console.log(
    `  [${model}] ➔ ${tagColor}[Tier ${tier}]${colors.reset} ${bothTag}推荐: ${colors.bold}${recommendedMode}${colors.reset} (${bestRes?.elapsed || "-"}s | ${bestRes?.sourcesCount || 0} URLs | ${modeReason})`
  );

  return { model, tier, bestRes, bestAcc, recommendedMode, modeReason, hasBothModes, nativeRes, nativeAcc, toolRes, toolAcc };
}

function formatProbe(res, acc) {
  return res.ok ? `${res.elapsed}s | ${res.sourcesCount} URLs | ${acc.label}` : `${res.status} (${res.error})`;
}

/** Entries of this server in ~/.claude.json whose env block overrides .env. */
function findClaudeOverrides() {
  const file = path.join(os.homedir(), ".claude.json");
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const entryLower = ENTRY.toLowerCase();
  const found = [];
  const scan = (servers, scope, project) => {
    for (const [name, def] of Object.entries(servers || {})) {
      const args = (def?.args || []).map((a) => String(a).replace(/\\/g, "/").toLowerCase());
      const samePath = args.some((a) => a.includes(entryLower));
      if (name !== SERVER_NAME && !samePath) continue;
      const keys = Object.entries(def?.env || {})
        .filter(([k, v]) => k.startsWith("MULTI_WEB_SEARCH_") && String(v).trim())
        .map(([k]) => k);
      found.push({ name, scope, project, keys, samePath });
    }
  };
  scan(json.mcpServers, "user");
  for (const [proj, conf] of Object.entries(json.projects || {})) scan(conf?.mcpServers, "local", proj);
  return found;
}

function printRegistration() {
  console.log(`\n${colors.bold}📋 Register in Claude Code (key stays in .env, not in the client config):${colors.reset}`);
  const existing = findClaudeOverrides();
  for (const e of existing) {
    if (!e.samePath) {
      console.log(`${colors.yellow}⚠ "${e.name}" (${e.scope} scope) is registered from a different folder. Re-add it to use this copy:${colors.reset}`);
    } else if (e.keys.length) {
      console.log(
        `${colors.yellow}⚠ ~/.claude.json already has "${e.name}" (${e.scope} scope${e.project ? `, ${e.project}` : ""}) with its own env: ${e.keys.join(", ")}.${colors.reset}`
      );
      console.log(`${colors.yellow}  Those values override .env, so the settings above will not apply until you re-add it:${colors.reset}`);
    } else {
      console.log(`${colors.dim}"${e.name}" is already registered (${e.scope} scope) without env overrides; it will use .env after a restart.${colors.reset}`);
    }
  }
  const needsReAdd = existing.filter((e) => e.keys.length || !e.samePath);
  for (const e of needsReAdd) {
    console.log(`${colors.cyan}  claude mcp remove ${e.name} -s ${e.scope}${colors.reset}`);
  }
  if (existing.length === 0 || needsReAdd.length) {
    console.log(`${colors.cyan}  claude mcp add -s user ${SERVER_NAME} -- node "${ENTRY}"${colors.reset}`);
  }

  const snippet = { mcpServers: { [SERVER_NAME]: { command: "node", args: [ENTRY] } } };
  console.log(`\n${colors.dim}Other clients (Cursor etc.) - add this to their MCP config:${colors.reset}`);
  console.log(colors.dim + JSON.stringify(snippet, null, 2) + colors.reset);
}

const ARGS = process.argv.slice(2);
const AUTO = ARGS.includes("--auto");
// Effort used while probing when .env does not set one; saved only if a chosen model accepts it.
const PROBE_EFFORT = "low";
const AUTO_FINALISTS = 4;

function argValue(name) {
  const i = ARGS.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return "";
  return ARGS[i].includes("=") ? ARGS[i].slice(name.length + 1) : ARGS[i + 1] || "";
}

function fail(message) {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
  process.exit(1);
}

async function listChatModels(cfg) {
  const res = await fetch(`${cfg.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const nonChat = ["embed", "audio", "tts", "whisper", "speech", "dall-e", "midjourney", "flux", "image", "video"];
  return (data.data || []).map((m) => m.id).filter((m) => !nonChat.some((kw) => m.toLowerCase().includes(kw)));
}

/** Models the user already put in .env (default, fallback, hybrid). No guessing from names. */
function configuredModels(fileEnv) {
  const names = [fileEnv.MULTI_WEB_SEARCH_MODEL, fileEnv.MULTI_WEB_SEARCH_FALLBACK_MODEL, ...(fileEnv.MULTI_WEB_SEARCH_HYBRID_MODELS || "").split(",")]
    .map((s) => (s || "").trim())
    .filter((m) => m && m !== "hybrid");
  return [...new Set(names)];
}

/** Turns "1,3-5", "gemini" or "grok-chat-fast, gpt-5" into model names. Unknown words match by fragment. */
function parseSelection(sel, chatModels) {
  const out = [];
  const add = (m) => !out.includes(m) && out.push(m);
  for (const part of sel.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)(?:-(\d+))?$/);
    if (range && chatModels.length) {
      const s = Number(range[1]);
      const e = Number(range[2] || range[1]);
      for (let i = Math.min(s, e); i <= Math.max(s, e); i++) if (chatModels[i - 1]) add(chatModels[i - 1]);
    } else if (chatModels.includes(part) || !chatModels.length) {
      add(part);
    } else {
      const hits = chatModels.filter((m) => m.toLowerCase().includes(part.toLowerCase()));
      if (hits.length) hits.forEach(add);
      else add(part); // not listed by /models, but the endpoint may still serve it
    }
  }
  return out;
}

/**
 * You choose which models get tested; the doctor never guesses. Arrow keys + Space,
 * models already in .env start ticked. --models a,b skips the menu.
 */
async function chooseModels(chatModels, fileEnv) {
  const current = configuredModels(fileEnv);
  if (!process.stdin.isTTY) {
    fail("No terminal to ask which models to test. Pass them with --models modelA,modelB (or --all).");
  }
  if (!chatModels.length) {
    // /models failed: nothing to tick, so fall back to typing names.
    for (;;) {
      const sel = await askQuestion(`${colors.bold}Model names to test, comma-separated${current.length ? ` [Enter = ${current.join(", ")}]` : ""}: ${colors.reset}`);
      const models = sel ? parseSelection(sel, []) : current;
      if (models.length) return models;
    }
  }
  const items = chatModels.map((m) => ({ label: m, note: current.includes(m) ? "(in .env)" : "" }));
  const picked = await checkbox({
    title: "💡 Which models should be tested? Each costs 2 requests; many models cannot search.",
    items,
    checked: chatModels.map((m, i) => (current.includes(m) ? i : -1)).filter((i) => i >= 0),
    hint: (n) => `${n * 2} requests`,
  });
  if (!picked) process.exit(0);
  return picked.map((i) => chatModels[i]);
}

function latestReleaseQuestion() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `Today is ${today}. What is the latest released version of Node.js right now? State the exact version number in the first sentence and cite the official source.`;
}

async function probeAll(models, query, keywords, cfg) {
  const poolLimit = 4;
  const results = new Array(models.length);
  let currentIndex = 0;
  const workers = Array.from({ length: Math.min(poolLimit, models.length) }, async () => {
    while (currentIndex < models.length) {
      const idx = currentIndex++;
      results[idx] = await probeModelMatrix(models[idx], query, keywords, cfg);
    }
  });
  await Promise.all(workers);
  const tierWeight = { "S+": 6, S: 5, A: 4, B: 3, C: 2, F: 1 };
  return results.sort((a, b) => {
    const diff = (tierWeight[b.tier] || 0) - (tierWeight[a.tier] || 0);
    if (diff !== 0) return diff;
    if (b.bestAcc.score !== a.bestAcc.score) return b.bestAcc.score - a.bestAcc.score;
    return (b.bestRes.sourcesCount || 0) - (a.bestRes.sourcesCount || 0);
  });
}

const modeOf = (r) => (r.recommendedMode === "Explicit Tool" ? "tool" : "native");

/** Asks a finalist the extra questions in its recommended mode; the first benchmark answer counts too. */
async function recheck(r, questions, cfg) {
  const mode = modeOf(r);
  const slow = cfg.timeoutMs / 1000;
  const runs = await Promise.all(
    questions.map(async (q) => {
      const res = await runSingleProbe(r.model, mode, q.query, cfg);
      const answer = res.ok ? res.answer.toLowerCase() : "";
      const ok = res.ok && !res.isRefusal && q.keywords.every((k) => answer.includes(k.toLowerCase()));
      return { ok, sec: res.ok ? parseFloat(res.elapsed) : slow };
    })
  );
  const all = [{ ok: r.bestAcc.tag === "EXACT_MATCH", sec: parseFloat(r.bestRes.elapsed) || slow }, ...runs];
  const correct = all.filter((x) => x.ok).length;
  const avgSec = all.reduce((sum, x) => sum + x.sec, 0) / all.length;
  return { ...r, mode, correct, total: all.length, avgSec };
}

/** Pins each model to its mode by exact name; exact names beat substring entries such as "gemini". */
function pinModes(picks, fileEnv) {
  const toSet = (s) => new Set((s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
  const native = toSet(fileEnv.MULTI_WEB_SEARCH_FORCE_NATIVE);
  const tool = toSet(fileEnv.MULTI_WEB_SEARCH_FORCE_TOOL);
  for (const { model, mode } of picks) {
    const key = model.toLowerCase();
    (mode === "native" ? native : tool).add(key);
    (mode === "native" ? tool : native).delete(key);
  }
  return { MULTI_WEB_SEARCH_FORCE_NATIVE: [...native].join(","), MULTI_WEB_SEARCH_FORCE_TOOL: [...tool].join(",") };
}

/** Every model that worked in the benchmark gets its measured mode saved, so picking it by hand later works too. */
function withOtherUsable(picks, results) {
  const others = results
    .filter((r) => r.tier !== "F" && !picks.some((p) => p.model === r.model))
    .map((r) => ({ ...r, mode: modeOf(r) }));
  return [...picks, ...others];
}

function effortSetting(picks) {
  return picks.some((p) => p.bestRes?.effortSent) ? PROBE_EFFORT : "";
}

function saveAndFinish(envUpdates) {
  saveEnv(envUpdates);
  console.log(`\n${colors.green}✅ Saved to ${ENV_PATH}:${colors.reset}`);
  for (const [k, v] of Object.entries(envUpdates)) console.log(`   ${k}=${v}`);
  printRegistration();
  console.log(`\n🎉 Done. Restart your MCP client (or run /mcp in Claude Code) to pick up the new settings.`);
}

async function runAuto(cfg, models, fileEnv, effortUnset) {
  if (!models.length) fail("No models to test: the endpoint listed none. Pass them with --models modelA,modelB.");
  let facts;
  try {
    facts = await fetchLatestNodeRelease();
  } catch (err) {
    fail(`Auto setup grades answers against nodejs.org, which is unreachable (${err.message}). Run without --auto to use your own question.`);
  }

  console.log(`${colors.bold}🤖 Auto setup: testing ${models.length} models in both modes (${models.length * 2} requests).${colors.reset}`);
  console.log(`${colors.dim}Answer key from nodejs.org: latest ${facts.version}${colors.reset}\n`);
  const results = await probeAll(models, latestReleaseQuestion(), [facts.version], cfg);

  const candidates = results.filter((r) => r.tier !== "F").slice(0, AUTO_FINALISTS);
  if (!candidates.length) fail("No model answered the benchmark correctly. .env was not changed.");

  const questions = extraQuestions(facts);
  console.log(`\n${colors.bold}🔁 Re-checking the top ${candidates.length} on ${questions.length} more live questions...${colors.reset}`);
  const finalists = [];
  for (const r of candidates) finalists.push(await recheck(r, questions, cfg));
  // Speed differences under 25% are network noise; then more sources wins.
  finalists.sort((a, b) => {
    if (b.correct !== a.correct) return b.correct - a.correct;
    if (Math.abs(a.avgSec - b.avgSec) >= 0.25 * Math.max(a.avgSec, b.avgSec)) return a.avgSec - b.avgSec;
    return (b.bestRes.sourcesCount || 0) - (a.bestRes.sourcesCount || 0) || a.avgSec - b.avgSec;
  });

  console.log("");
  for (const f of finalists) {
    const color = f.correct === f.total ? colors.green : f.correct * 3 >= f.total * 2 ? colors.yellow : colors.red;
    console.log(`  ${f.model.padEnd(30)} ${f.mode.padEnd(7)} ${color}${f.correct}/${f.total} correct${colors.reset}  avg ${f.avgSec.toFixed(1)}s`);
  }

  const picks = finalists.filter((f) => f.correct * 3 >= f.total * 2).slice(0, 2);
  if (!picks.length) fail("No model got at least 2 of 3 answers right. .env was not changed.");

  const [primary, fallback] = picks;
  const wantHybrid = ARGS.includes("--hybrid") || (!ARGS.includes("--single") && fileEnv.MULTI_WEB_SEARCH_MODEL === "hybrid");
  const hybrid = wantHybrid && picks.length === 2;
  if (wantHybrid && !hybrid) console.log(`${colors.yellow}Only one model qualified, so hybrid is off.${colors.reset}`);
  if (hybrid) {
    console.log(`\n👉 Default: ${colors.green}hybrid${colors.reset} (${picks.map((p) => `${p.model} ${p.mode}`).join(" + ")})`);
  } else {
    console.log(`\n👉 Default: ${colors.green}${primary.model}${colors.reset} (${primary.mode} mode)`);
  }
  if (fallback) console.log(`👉 Fallback: ${colors.green}${fallback.model}${colors.reset} (${fallback.mode} mode)`);

  const envUpdates = {
    MULTI_WEB_SEARCH_MODEL: hybrid ? "hybrid" : primary.model,
    MULTI_WEB_SEARCH_FALLBACK_MODEL: fallback?.model || "",
    MULTI_WEB_SEARCH_HYBRID_MODELS: picks.length === 2 ? picks.map((p) => p.model).join(",") : "",
    ...pinModes(withOtherUsable(picks, results), fileEnv),
  };
  if (effortUnset) envUpdates.MULTI_WEB_SEARCH_REASONING_EFFORT = effortSetting(picks);
  saveAndFinish(envUpdates);
}

async function main() {
  console.log(`\n${colors.bold}${colors.cyan}================================================================================${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}   🏆 Multi API Web Search - Search Capability Doctor & Leaderboard   ${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}================================================================================${colors.reset}\n`);

  // The doctor edits .env, so .env is its source of truth even if the shell has other values.
  const fileEnv = parseEnvFile();
  Object.assign(process.env, fileEnv);
  const cfg = getConfig();

  if (!cfg.baseUrl || !cfg.apiKey || cfg.apiKey.includes("your-api-key") || cfg.baseUrl.includes("your-provider")) {
    fail(`Fill MULTI_WEB_SEARCH_BASE_URL and MULTI_WEB_SEARCH_API_KEY in ${ENV_PATH} first (copy .env.example if the file is missing).`);
  }
  const effortUnset = fileEnv.MULTI_WEB_SEARCH_REASONING_EFFORT === undefined;
  if (effortUnset) cfg.reasoningEffort = PROBE_EFFORT;

  console.log(`🔗 API Base: ${colors.green}${cfg.baseUrl}${colors.reset}`);
  console.log(`⏱  Timeout per call: ${cfg.timeoutMs / 1000}s (MULTI_WEB_SEARCH_TIMEOUT_MS)`);

  const onlyModels = argValue("--models").split(",").map((s) => s.trim()).filter(Boolean);
  let chatModels = onlyModels;
  if (!onlyModels.length) {
    console.log(`📡 Fetching available chat models...\n`);
    try {
      chatModels = await listChatModels(cfg);
    } catch (err) {
      console.log(`${colors.yellow}Could not list models (${err.message}). You can still type model names below.${colors.reset}`);
    }
  }

  // You always choose what gets tested: the menu, --models a,b, or --all. --auto only means the doctor picks the winner.
  const targetModels = onlyModels.length ? onlyModels : ARGS.includes("--all") ? chatModels : await chooseModels(chatModels, fileEnv);
  const auto =
    AUTO ||
    (!ARGS.includes("--manual") &&
      process.stdin.isTTY &&
      (await choose(`Will test ${targetModels.length} model(s). Afterwards, who picks the default?`, [
        { label: "Auto", note: "re-check the best ones on 2 more questions and save the winner (recommended)", value: true },
        { label: "Manual", note: "show the leaderboard, you pick", value: false },
      ])));
  if (auto) return runAuto(cfg, targetModels, fileEnv, effortUnset);

  if (targetModels.length === 0) {
    console.log(`${colors.red}No models selected.${colors.reset}`);
    process.exit(0);
  }

  console.log("");
  let liveTruth = null;
  try {
    liveTruth = await fetchLatestNodeRelease();
  } catch (err) {
    console.log(`${colors.yellow}Could not reach nodejs.org (${err.message}), so you need your own question.${colors.reset}`);
  }
  const qChoice = liveTruth
    ? await choose("🎯 Benchmark question", [
        { label: "Latest Node.js release (recommended)", note: `answer from nodejs.org just now: ${liveTruth.version}`, value: "1" },
        { label: "Your own question + expected keyword(s)", value: "2" },
      ])
    : "2";

  let benchmarkQuery = latestReleaseQuestion();
  let expectedKeywords = liveTruth ? [liveTruth.version] : [];

  if (qChoice === "2") {
    benchmarkQuery = await askQuestion(`${colors.bold}Enter your question: ${colors.reset}`);
    const kwInput = await askQuestion(`${colors.bold}Expected keyword(s) in a correct answer, comma-separated: ${colors.reset}`);
    expectedKeywords = kwInput.split(",").map((k) => k.trim()).filter(Boolean);
    if (!benchmarkQuery || expectedKeywords.length === 0) {
      console.log(`${colors.red}A question and at least one expected keyword are required.${colors.reset}`);
      process.exit(1);
    }
  }

  console.log(`\n${colors.bold}🚀 Benchmarking ${targetModels.length} models in native and tool mode...${colors.reset}`);
  console.log(`Question: ${colors.cyan}"${benchmarkQuery}"${colors.reset}`);
  console.log(`Expected keyword(s): ${colors.yellow}${JSON.stringify(expectedKeywords)}${colors.reset}`);
  console.log(`${colors.dim}(4 models at a time to avoid overloading the gateway)${colors.reset}\n`);

  const results = await probeAll(targetModels, benchmarkQuery, expectedKeywords, cfg);

  // ========================== LEADERBOARD ==========================
  const rule = "--------------------------------------------------------------------------------------------------------";
  console.log(`\n${colors.bold}${colors.cyan}${"=".repeat(rule.length)}${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}${"🏆 SEARCH CAPABILITY LEADERBOARD".padStart(66)}${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}${"=".repeat(rule.length)}${colors.reset}`);
  console.log(
    `${colors.bold}${"Rank".padEnd(6)}${"Model".padEnd(26)}${"Tier".padEnd(8)}${"Accuracy".padEnd(29)}${"Recommended Mode".padEnd(22)}${"Citations".padEnd(12)}${"Speed"}${colors.reset}`
  );
  console.log(rule);
  results.forEach((r, idx) => {
    const modelStr = (r.model.length > 24 ? r.model.slice(0, 22) + ".." : r.model).padEnd(26);
    const tierColor = r.tier.startsWith("S") ? colors.green : r.tier === "A" ? colors.cyan : r.tier === "B" ? colors.yellow : colors.red;
    const accColor = r.bestAcc.tag === "EXACT_MATCH" ? colors.green : r.bestAcc.tag === "PARTIAL_MATCH" ? colors.yellow : colors.red;
    const recStr = (r.hasBothModes ? `${r.recommendedMode} *` : r.recommendedMode).padEnd(22);
    console.log(
      `${`#${idx + 1}`.padEnd(6)}${modelStr}${tierColor}${r.tier.padEnd(8)}${colors.reset}${accColor}${r.bestAcc.label.padEnd(29)}${colors.reset}${recStr}${`${r.bestRes?.sourcesCount || 0} URLs`.padEnd(12)}${r.bestRes?.elapsed || "-"}s`
    );
  });
  console.log(rule);
  console.log(`${colors.dim}* 同时支持 Native Grounding 和 Explicit Tool 两种模式${colors.reset}\n`);

  // ========================== ANSWER PREVIEW ==========================
  console.log(`${colors.bold}🔍 Answer preview (top 5):${colors.reset}\n`);
  results
    .filter((r) => r.tier !== "F")
    .slice(0, 5)
    .forEach((r, i) => {
      console.log(`${colors.bold}${colors.yellow}[${i + 1}] ${r.model}${colors.reset} ${colors.dim}(Tier ${r.tier} | 推荐: ${r.recommendedMode} | ${r.bestRes.elapsed}s)${colors.reset}`);
      console.log(`   ${colors.cyan}实测:${colors.reset} Native: ${formatProbe(r.nativeRes, r.nativeAcc)} | Tool: ${formatProbe(r.toolRes, r.toolAcc)}`);
      console.log(`   ${colors.cyan}推荐理由:${colors.reset} ${r.modeReason}`);
      const preview = (r.bestRes.answer || "(No output)")
        .split("\n")
        .filter((l) => l.trim())
        .slice(0, 3)
        .join("\n      ");
      console.log(`   ${colors.bold}回答片段:${colors.reset}\n      ${colors.dim}${preview}${colors.reset}`);
      if (r.bestRes.sources?.length) console.log(`   ${colors.green}来源示例:${colors.reset} ${r.bestRes.sources[0].url}`);
      console.log(rule);
    });

  // ========================== CONFIGURATION ==========================
  const validModels = results.filter((r) => r.tier !== "F");
  if (validModels.length === 0) {
    console.log(`${colors.red}❌ No model answered the benchmark correctly. .env was not changed.${colors.reset}`);
    process.exit(1);
  }

  // Tick one model to make it the default, two or more for hybrid search.
  const wasHybrid = fileEnv.MULTI_WEB_SEARCH_MODEL === "hybrid" && validModels.length >= 2;
  const chosenIdx = await checkbox({
    title: "💡 Tick 1 model for the default, or 2+ models for hybrid search (asks all ticked models in parallel)",
    items: validModels.map((r) => ({
      label: r.model,
      note: `Tier ${r.tier} · ${r.recommendedMode} · ${r.bestRes.elapsed}s · ${r.bestRes.sourcesCount} URLs${r.hasBothModes ? " · both modes work" : ""}`,
    })),
    checked: wasHybrid ? [0, 1] : [0],
    hint: (n) => (n >= 2 ? "→ hybrid" : n === 1 ? "→ single default model" : ""),
  });
  if (!chosenIdx) {
    console.log("Exiting without changes.");
    process.exit(0);
  }

  const picks = [];
  async function applyMode(r) {
    let mode = modeOf(r);
    if (r.hasBothModes) {
      mode = await choose(
        `Search mode for ${r.model} (both work)`,
        [
          { label: "Native Grounding", note: formatProbe(r.nativeRes, r.nativeAcc), value: "native" },
          { label: "Explicit Tool", note: formatProbe(r.toolRes, r.toolAcc), value: "tool" },
        ].map((o) => (o.value === mode ? { ...o, note: `${o.note} · recommended: ${r.modeReason}` } : o)),
        mode === "native" ? 0 : 1
      );
    }
    picks.push({ ...r, mode });
    console.log(`  ➔ ${r.model}: ${mode === "native" ? `${colors.green}Native Grounding` : `${colors.cyan}Explicit Tool`}${colors.reset}`);
  }

  let finalModel = "";
  let hybridModelsStr = "";
  let fallbackModel = null;
  const selected = chosenIdx.map((i) => validModels[i]);

  if (selected.length >= 2) {
    finalModel = "hybrid";
    hybridModelsStr = selected.map((r) => r.model).join(",");
    console.log(`\n${colors.bold}${colors.cyan}🌐 Hybrid models: ${selected.map((r) => r.model).join(" + ")}${colors.reset}`);
    for (const r of selected) await applyMode(r);
  } else {
    const r = selected[0];
    finalModel = r.model;
    console.log(`\n${colors.bold}👉 默认模型: ${colors.green}${finalModel}${colors.reset}`);
    await applyMode(r);
    const next = validModels.find((v) => v !== r);
    if (next) {
      fallbackModel = next.model;
      picks.push({ ...next, mode: modeOf(next) });
      console.log(`${colors.bold}👉 备用模型: ${colors.green}${next.model}${colors.reset} ${colors.dim}(排名最高的另一个模型, ${next.recommendedMode})${colors.reset}`);
    }
  }

  const envUpdates = { MULTI_WEB_SEARCH_MODEL: finalModel, ...pinModes(withOtherUsable(picks, validModels), fileEnv) };
  if (hybridModelsStr) envUpdates.MULTI_WEB_SEARCH_HYBRID_MODELS = hybridModelsStr;
  if (fallbackModel) envUpdates.MULTI_WEB_SEARCH_FALLBACK_MODEL = fallbackModel;
  if (effortUnset) envUpdates.MULTI_WEB_SEARCH_REASONING_EFFORT = effortSetting(picks);
  saveAndFinish(envUpdates);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
