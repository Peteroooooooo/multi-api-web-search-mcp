# Multi-API Web Search (MCP)

Universal multi-model web search MCP server with precision capability probing, dual-mode routing, and multi-engine consensus.

[![MCP Compatible](https://img.shields.io/badge/MCP-Protocol-blue.svg)](https://modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Dual-Mode Routing**: Benchmark and dispatch between `Native Grounding` (fast, silent retrieval) and `Explicit Tool` (`web_search` tool calling with rich citations).
- **Multi-Engine Consensus**: Query multiple models concurrently (`Hybrid`), cross-verify perspectives, and deduplicate citations.

## Quick Start

### 1. Install

```bash
git clone https://github.com/Peteroooooooo/multi-api-web-search-mcp.git
cd multi-api-web-search-mcp
npm install
```

### 2. Configure API (.env)

```bash
cp .env.example .env
```

Edit `.env`:
```env
MULTI_WEB_SEARCH_BASE_URL=https://api.your-provider.com/v1
MULTI_WEB_SEARCH_API_KEY=sk-your-key-here
```

### 3. Benchmark & Configure

- **Windows**: Double-click `doctor.bat`
- **Linux / macOS**:
  ```bash
  npm run doctor
  ```

Select your preferred model or input multiple indices (e.g. `1, 5, 2`) for Consensus mode. The wizard writes optimal configurations directly into `.env`.

## MCP Client Configuration

### Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "multi-api-web-search": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/path/to/multi-api-web-search-mcp/src/index.js"],
      "env": {
        "MULTI_WEB_SEARCH_BASE_URL": "https://api.your-provider.com/v1",
        "MULTI_WEB_SEARCH_API_KEY": "sk-your-key",
        "MULTI_WEB_SEARCH_MODEL": "hybrid",
        "MULTI_WEB_SEARCH_HYBRID_MODELS": "model-a,model-b",
        "MULTI_WEB_SEARCH_FORCE_NATIVE": "model-a"
      }
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "multi-api-web-search": {
      "command": "node",
      "args": ["D:/path/to/multi-api-web-search-mcp/src/index.js"],
      "env": {
        "MULTI_WEB_SEARCH_BASE_URL": "https://api.your-provider.com/v1",
        "MULTI_WEB_SEARCH_API_KEY": "sk-your-key",
        "MULTI_WEB_SEARCH_MODEL": "gpt-4o-mini"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `MULTI_WEB_SEARCH_BASE_URL` | Yes | - | OpenAI-compatible endpoint base URL |
| `MULTI_WEB_SEARCH_API_KEY` | Yes | - | API key |
| `MULTI_WEB_SEARCH_MODEL` | No | - | Default search model (or `hybrid`) |
| `MULTI_WEB_SEARCH_FALLBACK_MODEL` | No | - | Fallback model if primary model fails |
| `MULTI_WEB_SEARCH_HYBRID_MODELS` | No | - | Comma-separated models for consensus search (required if `model='hybrid'`) |
| `MULTI_WEB_SEARCH_FORCE_NATIVE` | No | - | Comma-separated models forced to use Native Grounding (prevents tool timeout) |
| `MULTI_WEB_SEARCH_TIMEOUT_MS` | No | `60000` | Upstream request timeout in ms (default: 60s) |

## Tool Parameters

The MCP server registers `multi_api_web_search` and alias `web_search`:

- `query` *(string, required)*: Search query.
- `model` *(string, optional)*: Override search model for this request (e.g. `gpt-4o-mini`, `hybrid`, or any model supported by your endpoint).
- `max_sources` *(number, optional)*: Maximum sources to return (default: 15).

## License

MIT
