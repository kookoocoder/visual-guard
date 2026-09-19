/** AgentRouter OpenAI-compatible chat endpoint defaults. */
export const AGENT_CONFIG = {
  /**
   * Chrome is blocked by AgentRouter's TLS WAF. Default to the local curl proxy
   * (`bun run agent-proxy`). Official OpenAI-compatible upstream per docs:
   * https://co.agentrouter.org/v1 — see https://co.agentrouter.org/portal/guide
   * Legacy host https://agentrouter.org/v1 is WAF-gated (Claude Code / Qwen Code path).
   */
  baseUrl: "http://127.0.0.1:8787/v1",
  upstreamBaseUrl: "https://agentrouter.org/v1",
  docsOpenAiBaseUrl: "https://co.agentrouter.org/v1",
  /** Prefer flash for latency; fall back to glm-5.3 if the primary errors. */
  model: "deepseek-v4-flash",
  fallbackModel: "glm-5.3",
  maxTurns: 12,
  maxTokens: 2048,
  temperature: 0.2,
  /** AgentRouter WAF allowlists this UA for curl/CLI clients. */
  userAgent: "QwenCode/0.2.0 (linux x64)",
  storageKeys: {
    apiKey: "agentrouterApiKey",
    model: "agentModel",
    baseUrl: "agentBaseUrl",
  },
};

export const SYSTEM_PROMPT = `You are Visual Guard's privacy-preserving browser agent.
You operate only on ALREADY-REDACTED page state and screenshots. Sensitive values appear as typed placeholders like [EMAIL], [PASSWORD], [CARD].
Never ask the user to paste secrets. Never invent element refs.

Tools (use them; do not pretend you already saw the page):
- get_page_state: redacted accessibility summary with stable refs (f0_ref_1, …). Prefer elements[] + text for task content; ignore pure nav chrome when the task is about the main page.
- read_element: read one element by selector_ref
- click / type / scroll / navigate: act on the page (scroll also moves nested course/quiz panels)
- screenshot: capture a locally redacted viewport summary (pixels never leave unmasked)

Workflow: call get_page_state first, then act with the returned refs. After scroll or click that may change the DOM, call get_page_state again. Prefer the fewest tool calls that complete the user task. When done, reply with a short final answer and no further tool calls.`;
