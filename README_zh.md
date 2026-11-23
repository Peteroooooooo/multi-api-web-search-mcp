# Multi-API Web Search (MCP)

[English](README.md) | **简体中文**

[![MCP Compatible](https://img.shields.io/badge/MCP-Protocol-blue.svg)](https://modelcontextprotocol.io/)
[![Node.js](<https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg>)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

通过任意 OpenAI 兼容 `/v1` 接口为 MCP 客户端提供实时联网搜索。内置测速与自动配置工具（`setup` / `doctor`），可自动测试接口下的模型、为每个模型选择最佳联网模式（`native` 或 `tool`）并写入 `.env`。

## 核心特性

- **自适应搜索模式**：同时支持 `native`（模型原生联网 / Grounding）与 `tool`（显式下发 `web_search` 工具）两种模式，按模型自动匹配最佳方案。
- **Hybrid 并发检索**：支持多模型并行搜索，并排返回各模型回答，自动合并去重引用链接（支持自动解开 Gemini Grounding 重定向链接）。
- **流式超时与容错**：基于真实流式输出（思考 token 或正文 token，忽略网关保活心跳）判定超时；首包静默自动重试，主模型失败自动切换 `MULTI_WEB_SEARCH_FALLBACK_MODEL`。
- **智能检索语言**：默认按话题自动匹配搜索语言（技术与国际话题补充英文检索，涉及中国的话题自动使用中文检索，最终按提问语言作答）。

## 免费联网 API 后端来源 

任何提供联网模型的 OpenAI 兼容接口或聚合网关（如 New API / One API）均可直接接入。你也可以通过以下两个开源项目自建免费的联网 API 后端：

- **ChatGPT 联网后端**：部署 [chatgpt2api](https://github.com/Peteroooooooo/chatgpt2api)（或上游原项目 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api)），将 ChatGPT 网页版搜索能力封装为 OpenAI 兼容 `/v1` 接口。
- **Gemini 联网后端**：部署 [AIStudio2API](https://github.com/Peteroooooooo/AIStudio2API)（或上游原项目 [Mag1cFall/AIStudio2API](https://github.com/Mag1cFall/AIStudio2API)），将 Google AI Studio 的 Gemini 模型与 Google Search Grounding 联网能力暴露为兼容接口。

你可以将 `MULTI_WEB_SEARCH_BASE_URL` 直接指向其中任意一个服务，或将两者同时接入聚合网关，用 `hybrid` 模式并发调用 ChatGPT 与 Gemini 搜索。

## 快速开始

### 1. 安装

```bash
git clone https://github.com/Peteroooooooo/multi-api-web-search-mcp.git
cd multi-api-web-search-mcp
npm install
```

### 2. 配置接口

```bash
cp .env.example .env
```

在 `.env` 中填入接口地址与密钥：

```env
MULTI_WEB_SEARCH_BASE_URL=https://api.your-provider.com/v1
MULTI_WEB_SEARCH_API_KEY=sk-your-key-here
```

### 3. 自动测速与选模

```bash
npm run setup
```

- 拉取接口模型列表供勾选测试（也可传参跳过菜单：`-- --models a,b`、`-- --all`、`-- --hybrid`、`-- --single`）。
- 自动实测各模型在 `native` 与 `tool` 模式下的准确率、耗时和引用数量，将最优主模型、备用模型及各模型模式自动写入 `.env`。
- 如需查看完整排行榜并手动选模，可运行 `npm run doctor`（Windows 下可直接双击 `doctor.bat`）。

### 4. 注册到 MCP 客户端

服务端会自动读取自身目录下的 `.env`，客户端配置只需指定入口脚本路径：

**Claude Code：**

```bash
claude mcp add -s user multi-api-web-search -- node "/path/to/multi-api-web-search-mcp/src/index.js"
```

**Cursor / Claude Desktop (`mcp.json`)：**

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

## 工具参数：`multi_api_web_search`

返回回答正文以及去重编号后的来源链接列表。

| 参数                 | 类型                               |     默认值     | 说明                                                                             |
| :------------------- | :--------------------------------- | :-------------: | :------------------------------------------------------------------------------- |
| `query`            | `string`（必填）                 |        -        | 搜索词或问题                                                                     |
| `model`            | `string`                         | `.env` 默认值 | 指定单模型名称或 `hybrid`                                                      |
| `max_sources`      | `number`                         |     `15`     | 最大返回引用来源数（`1`–`30`）                                              |
| `focus`            | `'normal' \| 'broad' \| 'precise'` |  `'normal'`  | `broad` 用于多角度广度调研（最多 30 条来源）；`precise` 用于核实单一最新事实 |
| `reasoning_effort` | `'low' \| 'medium' \| 'high'`      | `.env` 默认值 | 单次调用的思考强度覆盖                                                           |

## 环境变量

| 变量名                                | 必填 |  默认值  | 说明                                                                            |
| :------------------------------------ | :--: | :-------: | :------------------------------------------------------------------------------ |
| `MULTI_WEB_SEARCH_BASE_URL`         |  是  |     -     | OpenAI 兼容 `/v1` 接口地址                                                    |
| `MULTI_WEB_SEARCH_API_KEY`          |  是  |     -     | 接口 API Key                                                                    |
| `MULTI_WEB_SEARCH_MODEL`            |  否  |     -     | 默认搜索模型名称，或设为 `hybrid`                                             |
| `MULTI_WEB_SEARCH_HYBRID_MODELS`    |  否  |     -     | `hybrid` 模式下并发调用的模型列表（逗号分隔）                                 |
| `MULTI_WEB_SEARCH_FALLBACK_MODEL`   |  否  |     -     | 主模型失败时的降级备用模型                                                      |
| `MULTI_WEB_SEARCH_FORCE_TOOL`       |  否  |     -     | 强制使用 `web_search` 工具模式的模型名或前缀（逗号分隔）                      |
| `MULTI_WEB_SEARCH_FORCE_NATIVE`     |  否  |     -     | 强制使用原生联网模式的模型名或前缀（逗号分隔）                                  |
| `MULTI_WEB_SEARCH_TIMEOUT_MS`       |  否  | `25000` | 首包（思考或正文 token）最大等待毫秒数，超时自动重试一次                        |
| `MULTI_WEB_SEARCH_IDLE_TIMEOUT_MS`  |  否  | `30000` | 流式输出开始后的最大静默间隔毫秒数                                              |
| `MULTI_WEB_SEARCH_REASONING_EFFORT` |  否  |  未设置  | 默认思考强度（`low` / `medium` / `high`），不支持的模型会自动跳过         |
| `MULTI_WEB_SEARCH_FOCUS`            |  否  |  未设置  | 默认检索模式（`broad` 或 `precise`）                                        |
| `MULTI_WEB_SEARCH_LANGUAGE`         |  否  | `topic` | 检索词语言策略：`topic`（按话题地域自动匹配）或 `bilingual`（固定中英双语） |
| `MULTI_WEB_SEARCH_ALIAS`            |  否  |   关闭   | 设为 `1` 时同时暴露别名工具 `web_search`                                    |

## License

MIT
