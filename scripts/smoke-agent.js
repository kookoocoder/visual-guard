#!/usr/bin/env bun
/**
 * Smoke-test AgentRouter chat + tool calling via curl (Bun/Node fetch cannot set User-Agent).
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildOpenAiTools, parseToolCallArguments } from "../src/agent/openai-tools.js";
import { SYSTEM_PROMPT, AGENT_CONFIG } from "../src/agent/config.js";

function loadEnvLocal() {
  const path = resolve(import.meta.dir, "../.env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();

const apiKey = process.env.AGENTROUTER_API_KEY || process.env.VITE_AGENTROUTER_API_KEY;
if (!apiKey) {
  console.error("Missing VITE_AGENTROUTER_API_KEY / AGENTROUTER_API_KEY");
  process.exit(1);
}

const model = process.env.VITE_AGENT_MODEL || "deepseek-v4-flash";
const baseUrl = (process.env.VITE_AGENTROUTER_BASE_URL || AGENT_CONFIG.baseUrl).replace(/\/$/, "");

function chat(messages) {
  const bodyPath = resolve(import.meta.dir, "../.tmp-agent-body.json");
  writeFileSync(
    bodyPath,
    JSON.stringify({
      model,
      messages,
      tools: buildOpenAiTools(),
      tool_choice: "auto",
      max_tokens: 1024,
      temperature: 0.2,
    }),
  );
  try {
    const result = spawnSync(
      "curl",
      [
        "-sS",
        "-H", `Authorization: Bearer ${apiKey}`,
        "-H", `User-Agent: ${AGENT_CONFIG.userAgent}`,
        "-H", "Content-Type: application/json",
        "-H", "Accept: application/json",
        `${baseUrl}/chat/completions`,
        "--data-binary", `@${bodyPath}`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || "curl failed");
    }
    const text = result.stdout.trim();
    if (text.startsWith("<!doctype") || text.startsWith("<html")) {
      throw new Error("AgentRouter WAF blocked this IP (HTML 405). Retry later or use the Chrome extension path.");
    }
    const data = JSON.parse(text);
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data;
  } finally {
    try { unlinkSync(bodyPath); } catch { /* ignore */ }
  }
}

const fakePage = {
  ok: true,
  url: "https://example.com/login",
  title: "Example Login",
  elements: [
    { ref: "ref_1", role: "textbox", label: "Email", value: "[EMAIL]", sensitive: true },
    { ref: "ref_2", role: "textbox", label: "Password", value: "[PASSWORD]", sensitive: true },
    { ref: "ref_3", role: "button", label: "Sign in", sensitive: false },
  ],
  text_preview: "Sign in to Example. Email [EMAIL]. Password [PASSWORD].",
};

async function executeTool(name, args) {
  console.log(`  → tool ${name}`, args);
  if (name === "get_page_state") return fakePage;
  if (name === "click") return { ok: true, action: "click", ref: args.selector_ref, label: "Sign in" };
  return { ok: true, name, args };
}

const messages = [
  { role: "system", content: SYSTEM_PROMPT },
  {
    role: "user",
    content: "What interactive elements are on the page? Then click the Sign in button and stop.",
  },
];

console.log(`Smoke agent · model=${model}`);
let turns = 0;
while (turns < 6) {
  turns += 1;
  console.log(`turn ${turns}`);
  const completion = chat(messages);
  const message = completion?.choices?.[0]?.message;
  if (!message) throw new Error("empty completion");
  messages.push({
    role: "assistant",
    content: message.content ?? null,
    tool_calls: message.tool_calls,
  });
  const toolCalls = message.tool_calls || [];
  if (!toolCalls.length) {
    console.log("OK final:", message.content);
    process.exit(0);
  }
  for (const call of toolCalls) {
    const name = call.function.name;
    const args = parseToolCallArguments(call.function.arguments);
    const result = await executeTool(name, args);
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });
  }
}
console.error("truncated");
process.exit(1);
