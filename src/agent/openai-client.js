import { AGENT_CONFIG } from "./config.js";

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function extensionChat(apiKey, baseUrl, body) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "AGENT_CHAT", apiKey, baseUrl, body },
      (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          resolve({ ok: false, error: runtimeError.message });
          return;
        }
        resolve(response ?? { ok: false, error: "No response from background." });
      },
    );
  });
}

export class AgentRouterClient {
  constructor({
    apiKey,
    baseUrl = AGENT_CONFIG.baseUrl,
    model = AGENT_CONFIG.model,
    userAgent = AGENT_CONFIG.userAgent,
    fetchImpl = globalThis.fetch.bind(globalThis),
  } = {}) {
    if (!apiKey) throw new Error("AgentRouter API key is required.");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
  }

  async chatCompletions(body) {
    const payload = {
      model: this.model,
      temperature: AGENT_CONFIG.temperature,
      max_tokens: AGENT_CONFIG.maxTokens,
      ...body,
    };

    // Prefer the service worker so declarativeNetRequest can set the WAF User-Agent.
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      const proxied = await extensionChat(this.apiKey, this.baseUrl, payload);
      if (!proxied?.ok) {
        const err = new Error(formatUpstreamError(proxied));
        err.status = proxied?.status;
        err.data = proxied?.data;
        throw err;
      }
      return proxied.data;
    }

    const response = await this.fetchImpl(joinUrl(this.baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      const err = new Error(formatWafHtmlError(response.status, this.baseUrl));
      err.status = response.status;
      throw err;
    }

    if (!response.ok) {
      const message = data?.error?.message || data?.message || text.slice(0, 240) || response.statusText;
      const err = new Error(`AgentRouter ${response.status}: ${message}`);
      err.status = response.status;
      err.data = data;
      throw err;
    }

    return data;
  }
}

function formatUpstreamError(proxied) {
  const status = proxied?.status;
  const message = proxied?.error || "AgentRouter request failed.";
  if (status === 405 || /non-JSON|waf|doctype|<!html/i.test(message)) {
    return formatWafHtmlError(status, "configured base URL");
  }
  if (/Failed to fetch|NetworkError|CONNECTION_REFUSED|ERR_CONNECTION/i.test(message)) {
    return (
      `${message} — is the local proxy running? Start it with: bun run agent-proxy ` +
      `(then use base URL http://127.0.0.1:8787/v1).`
    );
  }
  return message;
}

function formatWafHtmlError(status, baseUrl) {
  return (
    `AgentRouter WAF blocked this client (${status || "405"}). ` +
    `Chrome cannot call agentrouter.org directly. ` +
    `1) Run \`bun run agent-proxy\`  2) Set base URL to http://127.0.0.1:8787/v1  ` +
    `3) If the proxy also returns 405, your IP is temporarily blocked — wait or switch network. ` +
    `(current: ${baseUrl})`
  );
}
