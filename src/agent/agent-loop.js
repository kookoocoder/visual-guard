import { AGENT_CONFIG, SYSTEM_PROMPT } from "./config.js";
import { AgentRouterClient } from "./openai-client.js";
import { buildOpenAiTools, parseToolCallArguments } from "./openai-tools.js";
import { TOOL_NAMES } from "../shared/tool-contract.js";

function summarizeForLog(value, max = 240) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function compactOlderToolResults(messages, keepLatest = 6) {
  const indexes = messages
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);

  for (const index of indexes.slice(0, -keepLatest)) {
    const message = messages[index];
    if (typeof message.content !== "string" || message.content.length < 800) continue;

    let summary = { ok: true, compacted: true, note: "Older tool payload omitted. Re-read the tab if needed." };
    try {
      const parsed = JSON.parse(message.content);
      summary = {
        ok: parsed?.ok !== false,
        compacted: true,
        action: parsed?.action,
        tab_id: parsed?.tab_id,
        title: parsed?.title,
        error: parsed?.error,
        note: "Older tool payload omitted. Re-read the tab if needed.",
      };
    } catch {
      // Keep the generic compacted marker for non-JSON tool output.
    }
    message.content = JSON.stringify(summary);
  }
}

/**
 * Run an OpenAI-compatible tool-calling loop against AgentRouter.
 * `executeTool(name, args)` must return a JSON-serializable, already-redacted result.
 */
export async function runAgentLoop({
  task,
  history = [],
  apiKey,
  baseUrl = AGENT_CONFIG.baseUrl,
  model = AGENT_CONFIG.model,
  fallbackModel = AGENT_CONFIG.fallbackModel,
  maxTurns = AGENT_CONFIG.maxTurns,
  executeTool,
  onEvent = () => {},
  signal,
} = {}) {
  if (!task?.trim()) throw new Error("Describe a task before running the agent.");
  if (typeof executeTool !== "function") throw new Error("executeTool is required.");

  const tools = buildOpenAiTools();
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.filter((message) => message?.role && message.role !== "system"),
    { role: "user", content: task.trim() },
  ];

  let activeModel = model;
  let client = new AgentRouterClient({ apiKey, baseUrl, model: activeModel });
  let usedFallback = false;
  const startedAt = Date.now();

  onEvent({ type: "start", model: activeModel, task: task.trim(), maxTurns, baseUrl });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (signal?.aborted) throw new Error("Agent run cancelled.");

    compactOlderToolResults(messages);
    const turnStarted = Date.now();
    onEvent({ type: "model_request", turn, model: activeModel });

    let completion;
    try {
      completion = await client.chatCompletions({
        messages,
        tools,
        tool_choice: "auto",
      });
    } catch (error) {
      onEvent({
        type: "model_error",
        turn,
        model: activeModel,
        error: error instanceof Error ? error.message : String(error),
        status: error?.status,
      });

      const canFallback =
        !usedFallback &&
        fallbackModel &&
        fallbackModel !== activeModel &&
        (error?.status === 402 || error?.status === 429 || error?.status === 503);
      if (!canFallback) throw error;

      usedFallback = true;
      activeModel = fallbackModel;
      client = new AgentRouterClient({ apiKey, baseUrl, model: activeModel });
      onEvent({
        type: "model_fallback",
        from: model,
        to: activeModel,
        reason: error instanceof Error ? error.message : String(error),
      });
      completion = await client.chatCompletions({
        messages,
        tools,
        tool_choice: "auto",
      });
    }

    const choice = completion?.choices?.[0];
    const message = choice?.message;
    if (!message) throw new Error("AgentRouter returned an empty completion.");

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    onEvent({
      type: "model_response",
      turn,
      model: activeModel,
      ms: Date.now() - turnStarted,
      content: (message.content || "").trim(),
      toolCallCount: toolCalls.length,
      finishReason: choice?.finish_reason,
      usage: completion?.usage || null,
      proxy: completion?._proxy || null,
    });

    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.tool_calls,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    });

    if (!toolCalls.length) {
      const answer = (message.content || "").trim() || "(model finished with no text)";
      onEvent({
        type: "final",
        turn,
        model: activeModel,
        answer,
        ms: Date.now() - startedAt,
      });
      return { ok: true, answer, turns: turn, model: activeModel, messages };
    }

    for (const call of toolCalls) {
      if (signal?.aborted) throw new Error("Agent run cancelled.");

      const name = call?.function?.name;
      const args = parseToolCallArguments(call?.function?.arguments);
      const callId = call?.id || `call_${turn}_${name}`;
      const toolStarted = Date.now();

      onEvent({ type: "tool_call", turn, name, args, callId });

      let result;
      try {
        if (!TOOL_NAMES.has(name)) {
          result = { ok: false, error: `Unknown tool: ${name}` };
        } else {
          result = await executeTool(name, args);
        }
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      onEvent({
        type: "tool_result",
        turn,
        name,
        callId,
        ok: result?.ok !== false,
        ms: Date.now() - toolStarted,
        summary: summarizeForLog(result, 180),
      });

      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: JSON.stringify(result ?? { ok: true }),
      });
    }
  }

  const answer = `Stopped after ${maxTurns} turns without a final answer.`;
  onEvent({
    type: "final",
    turn: maxTurns,
    model: activeModel,
    answer,
    truncated: true,
    ms: Date.now() - startedAt,
  });
  return { ok: false, answer, turns: maxTurns, model: activeModel, messages, truncated: true };
}
