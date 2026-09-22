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
 * DeepSeek / AgentRouter thinking mode requires every assistant message to carry
 * reasoning_content once tools are in the request — including empty strings.
 * `content` must be a string (or content blocks), never null.
 * See https://api-docs.deepseek.com/guides/thinking_mode/
 */
function normalizeAssistantMessage(message) {
  if (!message || message.role !== "assistant") return message;

  let content = message.content;
  if (content == null) content = "";
  else if (typeof content === "string") content = content;
  else if (!Array.isArray(content)) content = String(content);

  const next = {
    role: "assistant",
    content,
  };

  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    next.tool_calls = message.tool_calls;
  }

  if (Object.prototype.hasOwnProperty.call(message, "reasoning_content")) {
    next.reasoning_content = message.reasoning_content ?? "";
  } else if (next.tool_calls) {
    next.reasoning_content = "";
  }

  if (message.reasoning != null) next.reasoning = message.reasoning;
  return next;
}

function ensureThinkingFields(messages, { withTools = false } = {}) {
  return messages.map((message) => {
    if (message?.role !== "assistant") return message;
    const next = normalizeAssistantMessage(message);
    if (withTools && !Object.prototype.hasOwnProperty.call(next, "reasoning_content")) {
      next.reasoning_content = "";
    }
    if (next.content == null) next.content = "";
    return next;
  });
}

function extractMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

const EMPTY_CONTINUE_PROMPT =
  "Continue the user task. Call the next needed tool now. Do not stop with empty text.";

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
    ...ensureThinkingFields(
      history.filter((message) => message?.role && message.role !== "system"),
      { withTools: true },
    ),
    { role: "user", content: task.trim() },
  ];

  let activeModel = model;
  let client = new AgentRouterClient({ apiKey, baseUrl, model: activeModel });
  let usedFallback = false;
  let emptyStalls = 0;
  let usedTools = false;
  const startedAt = Date.now();

  onEvent({ type: "start", model: activeModel, task: task.trim(), maxTurns, baseUrl });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (signal?.aborted) throw new Error("Agent run cancelled.");

    compactOlderToolResults(messages);
    const requestMessages = ensureThinkingFields(messages, { withTools: true });
    const turnStarted = Date.now();
    onEvent({ type: "model_request", turn, model: activeModel });

    let completion;
    try {
      completion = await client.chatCompletions({
        messages: requestMessages,
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
        messages: requestMessages,
        tools,
        tool_choice: "auto",
      });
    }

    const choice = completion?.choices?.[0];
    const message = choice?.message;
    if (!message) throw new Error("AgentRouter returned an empty completion.");

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const answerText = extractMessageText(message);
    onEvent({
      type: "model_response",
      turn,
      model: activeModel,
      ms: Date.now() - turnStarted,
      content: answerText,
      toolCallCount: toolCalls.length,
      finishReason: choice?.finish_reason,
      usage: completion?.usage || null,
      proxy: completion?._proxy || null,
    });

    messages.push(
      normalizeAssistantMessage({
        role: "assistant",
        content: message.content == null ? "" : message.content,
        tool_calls: message.tool_calls,
        reasoning_content: message.reasoning_content ?? "",
      }),
    );

    if (!toolCalls.length) {
      const hasReasoning = Boolean(String(message.reasoning_content || "").trim());
      const shouldContinue =
        !answerText && emptyStalls < 3 && (usedTools || hasReasoning || turn === 1);

      if (shouldContinue) {
        emptyStalls += 1;
        onEvent({
          type: "model_stall",
          turn,
          model: activeModel,
          attempt: emptyStalls,
          note: "Empty assistant turn; prompting the model to continue.",
        });
        messages.push({ role: "user", content: EMPTY_CONTINUE_PROMPT });
        continue;
      }

      const answer = answerText || "(model finished with no text)";
      onEvent({
        type: "final",
        turn,
        model: activeModel,
        answer,
        ms: Date.now() - startedAt,
      });
      return { ok: true, answer, turns: turn, model: activeModel, messages };
    }

    emptyStalls = 0;
    usedTools = true;

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

      // UI-only fields (e.g. screenshot preview data URLs) must never reach the LLM.
      let previewUrl = null;
      let previewAlt = null;
      let previewCaption = null;
      if (result && typeof result === "object" && result.__uiPreview) {
        previewUrl = result.__uiPreview.url || null;
        previewAlt = result.__uiPreview.alt || null;
        previewCaption = result.__uiPreview.caption || null;
        const { __uiPreview, ...safeResult } = result;
        result = safeResult;
      }

      onEvent({
        type: "tool_result",
        turn,
        name,
        callId,
        ok: result?.ok !== false,
        ms: Date.now() - toolStarted,
        summary: summarizeForLog(result, 180),
        previewUrl,
        previewAlt,
        previewCaption,
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
