import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Load .env if present
const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

const baseUrl = process.env.MULTI_WEB_SEARCH_BASE_URL || "https://api.your-provider.com/v1";
const apiKey = process.env.MULTI_WEB_SEARCH_API_KEY || "YOUR_API_KEY_HERE";
const defaultModel = process.env.MULTI_WEB_SEARCH_MODEL || "gemini-3.8-flash";
const timeoutMs = process.env.MULTI_WEB_SEARCH_TIMEOUT_MS || "90000";

const entryPoint = path.join(root, "src", "index.js").replace(/\\/g, "/");

const cfg = {
  type: "stdio",
  command: "node",
  args: [entryPoint],
  env: {
    MULTI_WEB_SEARCH_API_KEY: apiKey,
    MULTI_WEB_SEARCH_BASE_URL: baseUrl,
    MULTI_WEB_SEARCH_MODEL: defaultModel,
    MULTI_WEB_SEARCH_TIMEOUT_MS: timeoutMs,
  },
  startup_timeout_ms: 30000,
};

const desc =
  "Multi-API Web Search: Universal live web search across top LLMs (Gemini, Grok, GPT) with precision probing and consensus search.";
const tags = JSON.stringify(["search", "web", "api", "gemini", "grok", "gpt"]);
const serverConfig = JSON.stringify(cfg);
const esc = (s) => s.replace(/'/g, "''");

const sql = `
DELETE FROM mcp_servers WHERE id IN ('multi-search', 'grok-web-search', 'omni-search');

INSERT INTO mcp_servers (id, name, server_config, description, homepage, docs, tags, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode, enabled_hermes)
VALUES (
  'multi-api-web-search',
  'multi-api-web-search',
  '${esc(serverConfig)}',
  '${esc(desc)}',
  NULL,
  NULL,
  '${esc(tags)}',
  1, 0, 0, 0, 0
)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  server_config=excluded.server_config,
  description=excluded.description,
  tags=excluded.tags,
  enabled_claude=1;
`;

const userHome = process.env.USERPROFILE || process.env.HOME || "";
const db = path.join(userHome, ".cc-switch", "cc-switch.db").replace(/\\/g, "/");

try {
  if (fs.existsSync(db)) {
    execFileSync("sqlite3", [db], {
      input: sql,
      stdio: ["pipe", "inherit", "inherit"],
      encoding: "utf8",
    });
    console.log("Successfully updated CC Switch database with sanitized config!");
  } else {
    console.log("CC Switch database not found at", db, "- skipped DB registration.");
  }
} catch (err) {
  console.error("Failed to register with CC Switch:", err.message);
}
