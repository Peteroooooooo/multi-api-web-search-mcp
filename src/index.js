#!/usr/bin/env node
/**
 * Multi API Web Search (MCP)
 *
 * Universal Multi-Model Web Search Aggregator with precision model probing,
 * multi-engine consensus, and dynamic per-query routing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatSearchResult, getConfig, webSearch } from "./search.js";

const TOOL_DESC =
  "Multi-API Web Search: Live internet search across your configured API models. Supports single model or multi-engine consensus ('hybrid').";

const querySchema = {
  query: z.string().min(1).describe("Search query or research question in natural language."),
  model: z
    .string()
    .optional()
    .describe(
      "Optional search engine mode or model name (e.g. 'gemini', 'grok', 'fast', 'hybrid' for multi-engine consensus)."
    ),
  max_sources: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe("Max number of sources to include (1-30, default 15)."),
};

async function runSearch({ query, model, max_sources }) {
  const result = await webSearch(String(query), {
    model,
    maxSources: max_sources,
  });
  const text = formatSearchResult(result);
  const payload = {
    query: result.query,
    model: result.model,
    isHybrid: result.isHybrid || false,
    fallbackFrom: result.fallbackFrom || undefined,
    answer: result.answer,
    perspectives: result.perspectives,
    sources: result.sources,
    usage: result.usage,
    id: result.id,
  };
  return {
    content: [
      { type: "text", text },
      {
        type: "text",
        text: `\n---\nJSON\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  };
}

async function main() {
  const cfg = getConfig();
  console.error(
    `[multi-api-web-search] defaultModel=${cfg.defaultModel} base=${cfg.baseUrl} key=${cfg.apiKey ? "set" : "MISSING"}`
  );

  const server = new McpServer(
    { name: "multi-api-web-search", version: "2.3.0" },
    {
      instructions:
        "Use multi_api_web_search or web_search for live internet research and real-time information retrieval.",
    }
  );

  // Register primary universal search tool: multi_api_web_search
  server.registerTool(
    "multi_api_web_search",
    {
      title: "Multi API Web Search",
      description: TOOL_DESC,
      inputSchema: querySchema,
    },
    async (args) => {
      try {
        return await runSearch(args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[multi-api-web-search] tool error: ${msg}`);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  // Register standard alias 'web_search' for universal compatibility
  server.registerTool(
    "web_search",
    {
      title: "Web Search (Alias)",
      description: TOOL_DESC,
      inputSchema: querySchema,
    },
    async (args) => {
      try {
        return await runSearch(args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[multi-api-web-search] tool error: ${msg}`);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[multi-api-web-search] ready on stdio");
}

main().catch((err) => {
  console.error("[multi-api-web-search] fatal:", err);
  process.exit(1);
});

