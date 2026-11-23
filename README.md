# Multi-API Web Search (MCP)

**English** | [简体中文](README_zh.md)

[![MCP Compatible](https://img.shields.io/badge/MCP-Protocol-blue.svg)](https://modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Live web search for MCP clients through any OpenAI-compatible `/v1` endpoint. A built-in setup tool benchmarks your models, picks the best search mode (`native` or `tool`) for each one, and writes `.env` automatically.

## Features

- **Adaptive search mode**: supports both `native` search (built-in grounding) and `tool` search (explicit `web_search` tool call), automatically selecting the best mode per model.
- **Hybrid search**: query 2+ models in parallel and get side-by-side answers with a merged, deduplicated source list (and resolved Gemini grounding redirect URLs).
- **Stream-aware resilience**: tracks real streamed output (thinking or answer tokens, ignoring relay keep-alive pings), retries silent or stalled connections, and falls back to `MULTI_WEB_SEARCH_FALLBACK_MODEL` on failure.
- **Smart query language**: automatically searches in the query's language plus English for technical topics and Chinese for China-related topics.

## Free Web Search API Backends

Any OpenAI-compatible provider or gateway (such as New API / One API) with search-capable models works out of the box. You can also self-host free web search API backends directly:

- **ChatGPT Web Search**: deploy [chatgpt2api](https://github.com/Peteroooooooo/chatgpt2api) (or upstream [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api)) to expose ChatGPT's web search as an OpenAI-compatible `/v1` API.
- **Gemini Web Search**: deploy [AIStudio2API](https://github.com/Peteroooooooo/AIStudio2API) (or upstream [Mag1cFall/AIStudio2API](https://github.com/Mag1cFall/AIStudio2API)) to expose Google AI Studio's Gemini models with Google Search grounding.

Point `MULTI_WEB_SEARCH_BASE_URL` directly at either service, or put both behind an API gateway to run ChatGPT and Gemini together in `hybrid` mode.

## Quick Start

### 1. Install

```bash
git clone https://github.com/Peteroooooooo/multi-api-web-search-mcp.git
cd multi-api-web-search-mcp
npm install
```

### 2. Configure endpoint

```bash
cp .env.example .env
```

Set your endpoint and key in `.env`:

```env
MULTI_WEB_SEARCH_BASE_URL=https://api.your-provider.com/v1
MULTI_WEB_SEARCH_API_KEY=sk-your-key-here
```

### 3. Benchmark & auto-configure models

```bash
npm run setup
```

- Interactive checklist to select which models on your endpoint to test (or pass `-- --models a,b`, `-- --all`, `-- --hybrid`, `-- --single`).
- Benchmarks accuracy, latency, and citation count in both `native` and `tool` modes, then writes the winning model, fallback model, and per-model modes to `.env`.
- Run `npm run doctor` (or double-click `doctor.bat` on Windows) to inspect the leaderboard and pick models manually.

### 4. Register in MCP client

The server loads `.env` from its own directory, so the client config only needs the entry script path.

**Claude Code:**

```bash
claude mcp add -s user multi-api-web-search -- node "/path/to/multi-api-web-search-mcp/src/index.js"
```

**Cursor / Claude Desktop (`mcp.json`):**

```json
{
  "mcpServers": {
    "multi-api-web-search": {
      "command": "node",
      "args": ["/path/to/multi-api-web-search-mcp/src/index.js"]
    }
  }
}
```

## Tool: `multi_api_web_search`

Returns an answer with a numbered, deduplicated source list.

| Parameter | Type | Default | Description |
| :--- | :--- | :---: | :--- |
| `query` | `string` (required) | - | Search query or question |
| `model` | `string` | `.env` default | Specific model name or `hybrid` |
| `max_sources` | `number` | `15` | Maximum sources to return (`1`–`30`) |
| `focus` | `'normal' \| 'broad' \| 'precise'` | `'normal'` | `broad` for multi-angle deep research (up to 30 sources); `precise` for verifying a single latest fact |
| `reasoning_effort` | `'low' \| 'medium' \| 'high'` | `.env` default | Per-call reasoning effort override |

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `MULTI_WEB_SEARCH_BASE_URL` | Yes | - | OpenAI-compatible `/v1` base URL |
| `MULTI_WEB_SEARCH_API_KEY` | Yes | - | API key for the endpoint |
| `MULTI_WEB_SEARCH_MODEL` | No | - | Default model name, or `hybrid` |
| `MULTI_WEB_SEARCH_HYBRID_MODELS` | No | - | Comma-separated models used when `model=hybrid` |
| `MULTI_WEB_SEARCH_FALLBACK_MODEL` | No | - | Fallback model when the primary model fails |
| `MULTI_WEB_SEARCH_FORCE_TOOL` | No | - | Comma-separated models/fragments forced to explicit `web_search` tool mode |
| `MULTI_WEB_SEARCH_FORCE_NATIVE` | No | - | Comma-separated models/fragments forced to native search mode |
| `MULTI_WEB_SEARCH_TIMEOUT_MS` | No | `25000` | Max wait (ms) for first streamed thinking/answer token before retrying |
| `MULTI_WEB_SEARCH_IDLE_TIMEOUT_MS` | No | `30000` | Max idle gap (ms) after streaming starts before cutting the stream |
| `MULTI_WEB_SEARCH_REASONING_EFFORT` | No | unset | Default reasoning effort (`low` / `medium` / `high`); auto-skipped for models that reject it |
| `MULTI_WEB_SEARCH_FOCUS` | No | unset | Default `focus` mode (`broad` or `precise`) when not specified by caller |
| `MULTI_WEB_SEARCH_LANGUAGE` | No | `topic` | Search term language strategy: `topic` (by topic/region) or `bilingual` (always EN + ZH) |
| `MULTI_WEB_SEARCH_ALIAS` | No | off | Set to `1` to also register the tool as `web_search` |

## License

MIT
