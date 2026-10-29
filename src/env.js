/**
 * Minimal .env support shared by the MCP server and the doctor wizard.
 * The .env file lives in the project root, next to package.json.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_PATH = path.join(PROJECT_ROOT, ".env");

export function parseEnvFile(filePath = ENV_PATH) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    out[key] = trimmed.slice(eqIdx + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Copy .env values into process.env. Variables that are already set
 * (e.g. from the MCP client's "env" block) win over the file.
 * Returns the keys that were taken from the file.
 */
export function loadDotEnv(filePath = ENV_PATH) {
  const loaded = [];
  for (const [key, value] of Object.entries(parseEnvFile(filePath))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

export function saveEnv(updates, filePath = ENV_PATH) {
  let content = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8")
    : fs.readFileSync(path.join(PROJECT_ROOT, ".env.example"), "utf8");

  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content = `${content.replace(/\s*$/, "")}\n${key}=${val}\n`;
    }
  }
  fs.writeFileSync(filePath, content, "utf8");
}
