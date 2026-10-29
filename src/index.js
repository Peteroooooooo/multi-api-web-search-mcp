#!/usr/bin/env node
/**
 * Multi API Web Search (MCP)
 *
 * Live web search through any OpenAI-compatible endpoint, with per-model
 * search-mode routing, multi-model (hybrid) search and automatic fallback.
 */

import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ENV_PATH, PROJECT_ROOT, loadDotEnv } from "./env.js";
import { FOCUSES, REASONING_EFFORTS, SETUP_HINT, formatSearchResult, getConfig, webSearch } from "./search.js";

const { version } = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));

function describeModels(cfg) {
  const hybridList = cfg.hybridModels.join(", ");
  const lines = [];
  if (cfg.defaultModel === "hybrid") {
    lines.push(`Leave empty to use the default: 'hybrid' (${hybridList || "no models configured"}).`);
  } else if (cfg.defaultModel) {
    lines.push(`Leave empty to use the default model '${cfg.defaultModel}'.`);
  } else {
    lines.push(`No default model is configured yet (${SETUP_HINT}); pass a model name until then.`);
  }
  if (cfg.hybridModels.length >= 2) {
    lines.push(
      `'hybrid' asks ${cfg.hybridModels.length} models in parallel (${hybridList}): slower and ${cfg.hybridModels.length}x the cost, useful for cross-checking facts.`
    );
  }
  const known = [...new Set([cfg.defaultModel, cfg.fallbackModel, ...cfg.hybridModels])].filter(
    (m) => m && m !== "hybrid"
  );
  if (known.length) lines.push(`Configured single models: ${known.join(", ")}.`);
  lines.push("Any other model name supported by the endpoint also works.");
  return lines.join(" ");
}

function buildSchema(cfg) {
  return {
    query: z.string().min(1).describe("Search query or research question in natural language."),
    model: z.string().optional().describe(describeModels(cfg)),
    max_sources: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe("Max number of sources to include (1-30, default 15; 30 with focus 'broad')."),
    focus: z
      .enum([...FOCUSES, "normal"])
      .optional()
      .describe(
        `How to search${cfg.focus ? ` (default '${cfg.focus}'; pass 'normal' for a short answer)` : ""}. Use 'broad' for any open-ended question: what methods, options, tools, ideas, alternatives or recent work exist on a topic, or a survey of a field; it searches from several angles and returns many distinct items with checkable sources (often paper IDs), up to 30 sources, but answers are long. Do not use 'broad' for single facts. ${cfg.focus ? "Use 'normal'" : "Leave empty"} for single facts (versions, dates, prices, error messages, API usage) or a normal short answer. 'precise' asks the model to verify one current fact against the newest primary source.`
      ),
    reasoning_effort: z
      .enum(REASONING_EFFORTS)
      .optional()
      .describe(
        `How long the model thinks before answering (default '${cfg.reasoningEffort || "model default"}'). 'low' is fastest and enough for lookups; 'medium'/'high' are 2-4x slower and only worth it for multi-step comparisons or calculations.`
      ),
  };
}

async function handleSearch({ query, model, max_sources, focus, reasoning_effort }, extra) {
  try {
    const result = await webSearch(String(query), {
      model,
      maxSources: max_sources,
      focus,
      reasoningEffort: reasoning_effort,
      signal: extra?.signal,
    });
    return { content: [{ type: "text", text: formatSearchResult(result) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[multi-api-web-search] tool error: ${msg}`);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
}

async function main() {
  const fromFile = loadDotEnv();
  const cfg = getConfig();
  console.error(
    `[multi-api-web-search] v${version} model=${cfg.defaultModel || "(none)"} base=${cfg.baseUrl || "(missing)"} key=${cfg.apiKey ? "set" : "MISSING"} .env=${fromFile.length ? `${fromFile.length} keys from ${ENV_PATH}` : "not used"}`
  );
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.defaultModel) {
    console.error(`[multi-api-web-search] setup incomplete: fill BASE_URL and API_KEY in ${ENV_PATH}, then ${SETUP_HINT}`);
  }

  const server = new McpServer(
    { name: "multi-api-web-search", version },
    {
      instructions:
        "Use multi_api_web_search for live internet research and real-time information. It returns an answer plus source URLs. For open-ended research (what approaches, options, tools or recent work exist) set focus to 'broad'; for single facts such as versions, dates or prices, do not.",
    }
  );

  const toolConfig = {
    title: "Multi API Web Search",
    description:
      "Search the live web and get a cited answer. Use for current events, recent releases, prices, docs, or anything that may have changed after your training data.",
    inputSchema: buildSchema(cfg),
  };

  server.registerTool("multi_api_web_search", toolConfig, handleSearch);

  // Some clients or prompts expect a tool literally named "web_search"; opt in with MULTI_WEB_SEARCH_ALIAS=1.
  if (/^(1|true|yes)$/i.test(process.env.MULTI_WEB_SEARCH_ALIAS || "")) {
    server.registerTool("web_search", { ...toolConfig, title: "Web Search" }, handleSearch);
  }

  await server.connect(new StdioServerTransport());
  console.error("[multi-api-web-search] ready on stdio");
}

main().catch((err) => {
  console.error("[multi-api-web-search] fatal:", err);
  process.exit(1);
});
