# Multi-API Web Search (MCP)

Live web search for MCP clients through any OpenAI-compatible endpoint. A built-in doctor benchmarks your endpoint's models, picks the best search mode for each one, and writes the config for you.

[![MCP Compatible](https://img.shields.io/badge/MCP-Protocol-blue.svg)](https://modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Per-model search mode**: each model runs either in `native` mode (the model searches silently) or `tool` mode (an explicit `web_search` tool, usually with more citations). The doctor measures both and saves the faster or more accurate one.
- **Hybrid search**: ask 2+ models in parallel, get their answers side by side plus one merged, deduplicated source list.
- **Never hangs, never cuts a working answer**: requests are streamed. A model gets `TIMEOUT_MS` (25 s) to search and write its first word; a request that stays silent is dropped and sent once more. After that it may keep writing as long as text keeps arriving, and it is only cut after `IDLE_TIMEOUT_MS` of silence. If tool mode returns a gateway error, the same call retries once in native mode.
- **Fallback model**: retry with a second model when the default one fails.

## Quick Start

### 1. Install

```bash
git clone https://github.com/Peteroooooooo/multi-api-web-search-mcp.git
cd multi-api-web-search-mcp
npm install
```

### 2. Add your endpoint

```bash
cp .env.example .env
```

Fill in the two required lines in `.env`:

```env
MULTI_WEB_SEARCH_BASE_URL=https://api.your-provider.com/v1
MULTI_WEB_SEARCH_API_KEY=sk-your-key-here
```

### 3. Let it pick the models

```bash
npm run setup
```

On Windows you can double-click `doctor.bat` instead. It creates `.env` and opens it in Notepad if the file is missing, then asks whether setup should pick the winner (Auto) or show you the leaderboard (Manual).

Setup first lists every model on your endpoint as a checklist, because most endpoints serve many models that can't search, and only you know which are worth the requests. Move with ↑/↓, tick with Space, press Tab to tick everything shown, type to filter (`gemini` shows only Gemini models), and confirm with Enter. Models already in your `.env` start ticked. You can also skip the menu with `-- --models a,b`, or test everything with `-- --all`. From there setup decides by itself: it tests each chosen model in both search modes, then re-checks the best 4 on two more questions. All answers are graded against nodejs.org at run time, so the test never goes stale. The most accurate model wins. Among equally accurate models, one that is at least 25% faster wins; otherwise the one with more sources wins. The winner becomes the default model, and the runner-up becomes the fallback and the second hybrid model. Each model's search mode is saved, and so is `reasoning_effort=low` if the chosen models accept it. Each model costs 2 requests, plus 2 more for each of the top 4. If `.env` already has `MULTI_WEB_SEARCH_MODEL=hybrid`, setup keeps hybrid as the default and fills in the two best models. Add `-- --hybrid` or `-- --single` to choose explicitly.

To see the full leaderboard and choose the default yourself, run `npm run doctor` (or pick Manual in `doctor.bat`). It starts with the same checklist, and afterwards you tick one model for the default or two or more for hybrid.

### 4. Register the server

The server reads `.env` itself, so the client config only needs the path. The doctor prints this command with your real path:

```bash
claude mcp add -s user multi-api-web-search -- node "/path/to/multi-api-web-search-mcp/src/index.js"
```

Other clients (Cursor `.cursor/mcp.json`, etc.):

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

Variables set in the client's `env` block override `.env`. Leave them out unless you want a per-client override. Otherwise, settings the doctor saves won't take effect.

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `MULTI_WEB_SEARCH_BASE_URL` | Yes | - | OpenAI-compatible endpoint base URL |
| `MULTI_WEB_SEARCH_API_KEY` | Yes | - | API key for that endpoint |
| `MULTI_WEB_SEARCH_MODEL` | No | - | Default model, or `hybrid` |
| `MULTI_WEB_SEARCH_HYBRID_MODELS` | No | - | Comma-separated models used by `hybrid` |
| `MULTI_WEB_SEARCH_FORCE_TOOL` | No | - | Models that always use the explicit `web_search` tool |
| `MULTI_WEB_SEARCH_FORCE_NATIVE` | No | - | Models that never get the tool |
| `MULTI_WEB_SEARCH_FALLBACK_MODEL` | No | - | Model to retry with when the default fails |
| `MULTI_WEB_SEARCH_TIMEOUT_MS` | No | `25000` | Max wait for the first word of the answer, per attempt. The model searches during this time; healthy answers start in 3-12 s. A request that stays silent this long is dropped and sent once more, which usually reaches a working upstream account. Requests are streamed, so once text starts the call keeps going while it arrives, up to 180 s in total |
| `MULTI_WEB_SEARCH_IDLE_TIMEOUT_MS` | No | `30000` | After output starts, how long a silent stream may stay quiet before it is cut. Grok can pause about 15 s mid-answer to run another search. A cut stream returns what it has, marked as possibly cut off |
| `MULTI_WEB_SEARCH_REASONING_EFFORT` | No | not sent | `low` / `medium` / `high`, sent with every request. A model that rejects it (a 400 naming the parameter, or a 422 such as ChatGPT relays return) is retried once without it, and the parameter is skipped for that model afterwards |
| `MULTI_WEB_SEARCH_FOCUS` | No | none | Default `focus` (`broad` or `precise`) for calls that don't set one. Callers can pass `normal` to skip it |
| `MULTI_WEB_SEARCH_LANGUAGE` | No | `topic` | Which languages the model searches in. `topic`: the query's language, plus English for technical or international topics, plus the local language for local topics (Chinese whenever the question may concern China, even if asked in English). `bilingual`: always English and Chinese. Both answer in the query's language |
| `MULTI_WEB_SEARCH_ALIAS` | No | off | `1` also exposes the tool as `web_search` |

`FORCE_TOOL` / `FORCE_NATIVE` entries match an exact model name or a fragment (`gemini` matches `gemini-3.8-flash`). An exact name beats a fragment. Models in neither list use tool mode if their name contains `grok`, `gpt` or `search`.

## Tool

`multi_api_web_search` returns an answer and a numbered source list as plain text. Links that differ only in `utm_*` tracking parameters count as one source. When the endpoint sends its sources as data and also repeats them as a `Sources:` list at the end of the answer (chatgpt2api tool mode does), that copy is removed from the answer.

- `query` *(string, required)*: search query or question.
- `model` *(string, optional)*: a model name or `hybrid`. The tool description lists your configured models.
- `max_sources` *(number, optional)*: 1-30, default 15.
- `focus` *(`precise` | `broad` | `normal`, optional)*: picks the built-in instructions sent to the model. `broad` asks for wide exploration: several searches from different angles and source types, many distinct items grouped by direction, and up to 30 sources. In tests with Gemini, `broad` cited 35 arXiv papers across 6 research answers. All 35 existed, and about 32 matched their description; the default prompt cited 2. `broad` answers run about 5x longer, so it is meant for open-ended questions, not single facts. `precise` asks for one current fact, checked against the newest primary source. With Gemini it measured the same as the default prompt. Leave `focus` empty, or pass `normal`, for a short balanced answer. Every prompt includes today's date.
- `reasoning_effort` *(`low` | `medium` | `high`, optional)*: overrides the default for one call.

No `temperature` is sent, so each model uses its own default. Gemini 3 models are tuned for their default of 1.0. A model that returns an empty answer counts as failed, so the fallback model or the other hybrid models take over.

### Search language

The search model, not this server, picks the search terms, so the language rule lives in its instructions. In a test of 24 questions (14 about China, 8 about the US or English-language communities, 2 with good sources in both), each asked in Chinese and in English on two models, with no rule:

- English questions about China that did not name the country failed: asked for the annual pre-tax cap on private pension contributions, both models replied "which country?", and a question about delivery riders' views got 1 Chinese source out of 24.
- `bilingual` fixed those, but answered 3 Chinese questions in English and added 25-33% Chinese sources to questions that had good English ones.
- The shipped `topic` rule (plus "never reply with a clarifying question; answer the most likely reading") answered all 28 checkable questions correctly in both languages on both models, the pension question 6 of 6 times when asked in English. English questions about China drew 78% Chinese sources on `auto`; English-topic questions stayed at 0-1% Chinese sources, and answer time stayed at 8-12 s.

Calling agents mostly pick the query language by topic already: Claude Code and Codex both searched in Chinese when asked in English about a Chinese channel, and in English when asked in Chinese about Node.js. The `query` description also asks them to name the country or region in the query.

## Development

```bash
npm test
```

The tests run against a local mock endpoint. No API key needed.

## License

MIT
