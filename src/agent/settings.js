import { AGENT_CONFIG } from "./config.js";

// Vite statically replaces these at build time from .env.local (gitignored).
const envKey = import.meta.env.VITE_AGENTROUTER_API_KEY || "";
const envModel = import.meta.env.VITE_AGENT_MODEL || "";
const envBaseUrl = import.meta.env.VITE_AGENTROUTER_BASE_URL || "";

export async function loadAgentSettings() {
  const defaults = {
    apiKey: envKey,
    model: envModel || AGENT_CONFIG.model,
    // Prefer local proxy; ignore env upstream unless explicitly set to localhost.
    baseUrl: envBaseUrl.includes("127.0.0.1") || envBaseUrl.includes("localhost")
      ? envBaseUrl
      : AGENT_CONFIG.baseUrl,
  };

  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return defaults;
  }

  const stored = await chrome.storage.local.get([
    AGENT_CONFIG.storageKeys.apiKey,
    AGENT_CONFIG.storageKeys.model,
    AGENT_CONFIG.storageKeys.baseUrl,
  ]);

  return {
    apiKey: stored[AGENT_CONFIG.storageKeys.apiKey] || defaults.apiKey,
    model: stored[AGENT_CONFIG.storageKeys.model] || defaults.model,
    baseUrl: stored[AGENT_CONFIG.storageKeys.baseUrl] || defaults.baseUrl,
  };
}

export async function saveAgentSettings({ apiKey, model, baseUrl }) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  const payload = {};
  if (typeof apiKey === "string") payload[AGENT_CONFIG.storageKeys.apiKey] = apiKey.trim();
  if (typeof model === "string" && model.trim()) {
    payload[AGENT_CONFIG.storageKeys.model] = model.trim();
  }
  if (typeof baseUrl === "string" && baseUrl.trim()) {
    payload[AGENT_CONFIG.storageKeys.baseUrl] = baseUrl.trim().replace(/\/$/, "");
  }
  await chrome.storage.local.set(payload);
}
