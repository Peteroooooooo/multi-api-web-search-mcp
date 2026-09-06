# 🌐 Multi-API Web Search (MCP)

> **别再浪费你大模型 API 里的联网搜索能力了。**  
> 一键榨干你现有 API 的实时搜索潜能，为 Claude Code、Cursor 和 AI Agent 打造的多模型聚合搜索基准台与中枢。

[![MCP Compatible](https://img.shields.io/badge/MCP-Protocol-blue.svg)](https://modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

### 💡 为什么需要它？

很多人手里都有各类大模型 API 或中转站，里面躺着几十个模型。其实很多模型（如 Grok、Gemini 3.8、GPT 等）**早就自带了强大的云端实时联网搜索功能**，但平时：
- **你根本不知道哪个模型真正能搜**，哪个只会胡编乱造；
- **不知道该用什么姿势调用**（是裸发，还是加 tools？加错了就报错）；
- **白白浪费了这些本就包含在 API 额度里的联网搜索能力**。

**Multi-API Web Search 就是为此而生的自动化中枢**：
1. **自动体检排位**：全并发跑出真实时效性唯一解，现场测出谁在真搜、谁在脑补；
2. **深度协议透视**：自动摸清底层的 `web_search` 插件与真实外链数量；
3. **无缝接入 IDE**：一键生成配置，在 Claude Code 或 Cursor 里随心所欲调用单模型，或开启**多模型并发共识搜索**。

---

## ⚡ 核心特性

- 🔬 **Search Model Arena（自带跑分台）**：内置客观唯一解考题，10 秒内并发排定天梯榜（S+/S/A/B/F）。
- 🌐 **Multi-Engine Consensus（多核共识搜索）**：可同时召唤 Top 2 或更多模型并发搜索，交叉验证防幻觉，自动合并去重全网外链。
- 🎯 **自动协议适配（Best Mode）**：智能识别该用原生联网（Native Grounding）还是显式工具（Explicit Tool），杜绝报错。
- 🔀 **运行时动态切模型**：在对话中一句提示词即可指定模型（`model: "grok"`、`model: "gemini"`、`model: "hybrid"`），无需重启编辑器。
- 🛡️ **安全脱敏**：完全通过 `.env` 隔离，源码 0 泄露风险。

---

## 🚀 30 秒极速上手

### 1. 克隆并安装

```bash
git clone https://github.com/Peteroooooooo/multi-api-web-search-mcp.git
cd multi-api-web-search-mcp
npm install
```

### 2. 填写 API（复制模板）

复制 `.env.example` 为 `.env`：

```env
MULTI_WEB_SEARCH_BASE_URL=https://api.your-provider.com/v1
MULTI_WEB_SEARCH_API_KEY=sk-your-key-here
```

### 3. 一键跑分与配置 🏆

* **Windows 用户**：直接双击根目录下的 **`doctor.bat`**。
* **Mac / Linux 用户**：终端运行：
  ```bash
  npm run doctor
  ```

它会自动拉取你的模型库并发测试，并在终端为你展示**排位榜与真实回答对比**：

```text
Rank  Model                     Tier    Accuracy                Recommended Mode      Citations   Speed 
--------------------------------------------------------------------------------------------------------
#1    grok-chat-fast            S+      🎯 Exact Match           Explicit Tool         18 URLs     9.3s
#2    gpt-5-6                   S+      🎯 Exact Match           Native Grounding *    0 URLs      2.2s
#3    gemini-3.8-flash          S       🎯 Exact Match           Native Grounding      0 URLs      6.5s
```
> *注：标有星号的模型支持双模式，Doctor 会根据实测延迟与稳定性自动推荐最优模式，并支持交互式自主切换。

* **敲数字（如 `1`）**：选定该模型作为主力（若该模型支持双模，系统会提供 Native 与 Tool 模式的自主选择）；
* **敲 `H` 后按回车**：直接启用最强的 **Top 2 多核共识搜索**（并为组合中的每个模型智能匹配最佳检索模式）。

---

## 🛠️ 接入你的编辑器

运行完 `doctor` 后，终端会直接输出生成好的配置，直接粘贴即可：

### 接入 Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "multi-api-web-search": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/path/to/multi-api-web-search-mcp/src/index.js"],
      "env": {
        "MULTI_WEB_SEARCH_BASE_URL": "https://api.your-provider.com/v1",
        "MULTI_WEB_SEARCH_API_KEY": "sk-...",
        "MULTI_WEB_SEARCH_MODEL": "hybrid",
        "MULTI_WEB_SEARCH_FORCE_NATIVE": "gpt-5-5,gpt-5-6,gemini-3.8-flash",
        "MULTI_WEB_SEARCH_HYBRID_MODELS": "grok-chat-fast,gpt-5-6"
      }
    }
  }
}
```

### 接入 Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "multi-api-web-search": {
      "command": "node",
      "args": ["D:/path/to/multi-api-web-search-mcp/src/index.js"],
      "env": {
        "MULTI_WEB_SEARCH_BASE_URL": "https://api.your-provider.com/v1",
        "MULTI_WEB_SEARCH_API_KEY": "sk-...",
        "MULTI_WEB_SEARCH_MODEL": "gemini-3.8-flash",
        "MULTI_WEB_SEARCH_FORCE_NATIVE": "gpt-5-5,gpt-5-6,gemini-3.8-flash"
      }
    }
  }
}
```

---

## 💬 日常怎么用？

在 Claude Code / Cursor 对话中：

* **默认搜索**：“查一下今天最新的 Node.js 版本和发布说明。”（自动调用配置好的主力模型或共识模式）
* **指定单模型**：“用 **grok** 查一下 X 平台对 DeepSeek 最新论文的讨论，带上推特链接。”
* **深度长文研报**：“用 **agent** 模式深度调研 2026 年量子计算商业化现状。”
* **多核交叉验证**：“用 **hybrid** 模式对比各大 AI 芯片架构。”

---

## 📄 开源协议

MIT License. 随意 Fork、修改与分发。
