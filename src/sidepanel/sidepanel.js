import { ImagePrivacyModel } from "../client/models/image-redactor.js";
import { TextPrivacyModel } from "../client/models/text-redactor.js";
import { getToolDefinition } from "../shared/tool-contract.js";
import { runAgentLoop } from "../agent/agent-loop.js";
import { loadAgentSettings, saveAgentSettings } from "../agent/settings.js";
import { AGENT_CONFIG } from "../agent/config.js";
import "./sidepanel.css";

const $ = (selector) => document.querySelector(selector);
const hasExtensionRuntime = typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);

const els = {
  statusDot: $("#status-dot"),
  statusLabel: $("#status-label"),
  task: $("#task"),
  run: $("#run"),
  model: $("#model"),
  apiKey: $("#api-key"),
  baseUrl: $("#base-url"),
  hasDot: $("#has-dot"),
  nerDot: $("#ner-dot"),
  navigateUrl: $("#navigate-url"),
  log: $("#log"),
  previewImg: $("#preview-img"),
  copyLog: $("#copy-log"),
  clearLog: $("#clear-log"),
};

const state = {
  pageState: null,
  busy: false,
  logLines: [],
  _nerLoadLogged: false,
  _hasLoadLogged: false,
};

function sendRuntime(message) {
  if (!hasExtensionRuntime) {
    return Promise.resolve({ ok: false, error: "Extension runtime not connected. Load dist/ in Chrome." });
  }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response ?? { ok: false, error: "No response from extension." });
    });
  });
}

function setStatus(kind, label) {
  els.statusDot.classList.remove("ready", "busy", "error");
  if (kind) els.statusDot.classList.add(kind);
  els.statusLabel.textContent = label;
}

function setModelDot(dot, status) {
  dot.classList.remove("ready", "busy", "error");
  if (status === "ready") dot.classList.add("ready");
  else if (status === "loading") dot.classList.add("busy");
  else if (status === "error") dot.classList.add("error");
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll("button").forEach((button) => {
    if (button.id === "copy-log" || button.id === "clear-log") return;
    button.disabled = busy;
  });
}

function unwrapContentResult(response) {
  if (!response?.ok) return { ok: false, error: response?.error || "The action failed." };
  const nested = response.result;
  if (nested && typeof nested === "object" && "ok" in nested && "result" in nested) {
    if (!nested.ok) return { ok: false, error: nested.error || "The page action failed." };
    return { ok: true, result: nested.result };
  }
  return { ok: true, result: nested ?? response.result };
}

/** Structured log used for testing the agent loop end-to-end. */
function log(tag, message, { level = "info", detail = null } = {}) {
  const entry = {
    t: new Date().toISOString(),
    tag,
    message: String(message ?? ""),
    level,
    detail,
  };
  state.logLines.push(entry);

  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(`[${tag}] ${entry.message}`, detail ?? "");

  const empty = els.log.querySelector(".log-empty");
  empty?.remove();

  const line = document.createElement("div");
  line.className = `log-line level-${level}`;

  const meta = document.createElement("div");
  meta.className = "log-meta";
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date(entry.t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const tagEl = document.createElement("span");
  tagEl.className = "log-tag";
  tagEl.textContent = tag;
  meta.append(time, tagEl);

  const msg = document.createElement("div");
  msg.className = "log-msg";
  msg.textContent = entry.message;
  line.append(meta, msg);

  if (detail != null && detail !== "") {
    const pre = document.createElement("pre");
    pre.className = "log-detail";
    const rendered = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
    pre.textContent = rendered.length > 1200 ? `${rendered.slice(0, 1200)}…` : rendered;
    line.append(pre);
  }

  els.log.append(line);
  // Cap DOM log rows — huge logs were killing performance.
  while (els.log.children.length > 80) els.log.firstElementChild.remove();
  els.log.scrollTop = els.log.scrollHeight;
}

function clearLog() {
  state.logLines = [];
  els.log.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "log-empty";
  empty.textContent = "Log cleared. Run a task or tool test to see events.";
  els.log.append(empty);
}

async function copyLog() {
  const text = state.logLines
    .map((line) => {
      const detail =
        line.detail == null
          ? ""
          : `\n${typeof line.detail === "string" ? line.detail : JSON.stringify(line.detail, null, 2)}`;
      return `[${line.t}] ${line.level.toUpperCase()} ${line.tag} ${line.message}${detail}`;
    })
    .join("\n\n");
  try {
    await navigator.clipboard.writeText(text || "(empty log)");
    log("log", "Copied to clipboard");
  } catch (error) {
    log("log", error instanceof Error ? error.message : String(error), { level: "error" });
  }
}

function showPreview(dataUrl) {
  if (!dataUrl) {
    els.previewImg.hidden = true;
    els.previewImg.removeAttribute("src");
    return;
  }
  els.previewImg.src = dataUrl;
  els.previewImg.hidden = false;
}

function usefulElements(elements = [], limit = 40) {
  const skippedRoles = new Set(["none", "presentation", "img", "banner", "contentinfo"]);
  const interactive = new Set([
    "button",
    "link",
    "textbox",
    "heading",
    "radio",
    "checkbox",
    "option",
    "label",
    "tab",
    "menuitem",
    "listitem",
    "combobox",
    "switch",
    "treeitem",
  ]);

  const scored = [];
  for (const el of elements) {
    const label = String(el.label || "").trim();
    if (!label || label === "Unlabeled element") continue;
    if (skippedRoles.has(el.role) && el.tag === "svg") continue;

    let score = 0;
    if (interactive.has(el.role)) score += 2;
    if (["radio", "checkbox", "textbox", "option", "heading", "label"].includes(el.role)) score += 4;
    if (el.checked != null) score += 2;
    if (/question|option|answer|submit|next|previous|choice|mcq|assessment|quiz/i.test(label)) score += 4;
    if (/jump to|skip to|donate|cookie|log in|sign in|bookmark|announcement/i.test(label)) score -= 3;
    if (el.bounds && Number.isFinite(el.bounds.y)) {
      // Prefer on-screen / mid-page content over far-off sidebar chrome.
      if (el.bounds.y >= 0 && el.bounds.y < 900 && el.bounds.x > 120) score += 2;
      if (el.bounds.x < 80 && el.bounds.width < 360) score -= 2;
    }
    scored.push({ el, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((item) => item.el);
}

async function redactPageState(pageState, { maxElements = 80, maxText = 4000, forAgent = false } = {}) {
  const elements = usefulElements(pageState.elements || [], maxElements);
  const bodyText = String(pageState.textForLocalModel || "").slice(0, maxText);
  const fieldTexts = elements.flatMap((element) => {
    const values = [String(element.label || "")];
    if (!element.sensitive && !String(element.value || "").startsWith("[REDACTED:")) {
      values.push(String(element.value || ""));
    }
    return values;
  });

  // Agent path: use NER only when already ready. Never stall the loop on Hub download.
  let textResult;
  let fieldResults;
  if (forAgent) {
    const preferNer = textModel.ready;
    const [body] = await textModel.redactBatch([bodyText], {
      preferModel: preferNer,
      strictFallback: true,
      maxChars: maxText,
    });
    textResult = body;
    fieldResults = await textModel.redactBatch(fieldTexts, {
      preferModel: false,
      strictFallback: false,
      maxChars: 240,
    });
  } else {
    const batch = await textModel.redactBatch([bodyText, ...fieldTexts], {
      preferModel: true,
      strictFallback: true,
      maxChars: maxText,
    });
    textResult = batch[0];
    fieldResults = batch.slice(1);
  }

  let fieldIndex = 0;
  const safeElements = elements.map((element) => {
    const safe = { ...element, label: fieldResults[fieldIndex++].text };
    if (!element.sensitive && !String(element.value || "").startsWith("[REDACTED:")) {
      safe.value = fieldResults[fieldIndex++].text;
    }
    return safe;
  });

  state.pageState = {
    ...pageState,
    textForLocalModel: undefined,
    elements: safeElements,
    redactedText: textResult.text,
  };
  return { textResult, safeElements };
}

async function scanPage({ forAgent = false } = {}) {
  const started = Date.now();
  setStatus("busy", "scanning");
  if (!hasExtensionRuntime) throw new Error("Load the built extension in Chrome.");

  // Manual scans can wait for NER; agent path must not hang on first-run download.
  if (!forAgent && textModel.status !== "ready" && !textModel.unavailable) {
    setStatus("busy", "loading ner");
    await textModel.ensureLoaded().catch(() => {});
  }
  // Agent: do not start a competing GPU load here — runAgent schedules a delayed warm.

  const response = await sendRuntime({ type: "SCAN_PAGE" });
  const pageResponse = unwrapContentResult(response);
  if (!pageResponse.ok) throw new Error(pageResponse.error);
  const pageState = pageResponse.result;
  if (!pageState) throw new Error("No page state from content script.");

  const { textResult, safeElements } = await redactPageState(pageState, {
    maxElements: forAgent ? 64 : 100,
    maxText: forAgent ? 4500 : 6000,
    forAgent,
  });

  // Applying redacted text into Discord's live DOM is expensive and not needed for the agent.
  let pageRedaction = null;
  if (!forAgent) {
    pageRedaction = await sendRuntime({
      type: "APPLY_TEXT_REDACTION",
      redacted: textResult.spans || [],
    });
  }

  log(
    "get_page_state",
    `${safeElements.length} elements · ${textResult.spans.length} spans · ${Date.now() - started}ms · ${pageState.title || "page"}`,
    {
      detail: {
        url: pageState.url,
        replacedOnPage: pageRedaction?.replaced ?? null,
        sample: safeElements.slice(0, 10).map(({ ref, role, label, tag, value, checked, bounds }) => ({
          ref,
          role,
          tag,
          label,
          value,
          checked,
          bounds,
        })),
        textPreview: (textResult.text || "").slice(0, 400),
        frames: pageState.frames || 1,
        nerError: textModel.lastError || null,
        redactMode: textResult.mode || null,
      },
    },
  );
  setStatus(textModel.status === "error" ? "error" : "ready", textModel.status === "error" ? "ner fallback" : "ready");
  return pageState;
}

async function captureFrame() {
  setStatus("busy", "redacting");
  if (!hasExtensionRuntime) throw new Error("Load the built extension in Chrome.");
  const response = await sendRuntime({ type: "CAPTURE_VISIBLE_TAB" });
  if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "Capture failed.");

  const redacted = await imageModel.redact(response.dataUrl);
  showPreview(redacted.dataUrl);
  log(
    "screenshot",
    `${redacted.mode} · ${redacted.detections?.length ?? 0} masks · ${redacted.elapsedMs}ms`,
    {
      level: redacted.error ? "warn" : "info",
      detail: {
        detections: (redacted.detections || []).slice(0, 12),
        error: redacted.error || null,
      },
    },
  );
  setStatus(redacted.error ? "error" : "ready", redacted.error ? "has fallback" : "ready");
  return redacted;
}

async function ensurePageState() {
  if (state.pageState) return state.pageState;
  await scanPage();
  return state.pageState;
}

function toolRef(preferredRole = "") {
  const candidates = state.pageState?.elements || [];
  return (
    candidates.find((item) => item.role === preferredRole && !item.sensitive)?.ref ||
    candidates.find((item) => ["button", "link"].includes(item.role) && !item.sensitive)?.ref ||
    candidates.find((item) => !item.sensitive)?.ref ||
    candidates[0]?.ref
  );
}

async function redactToolResult(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return Promise.all(value.map(redactToolResult));

  const safeEntries = await Promise.all(
    Object.entries(value)
      .filter(([key]) => !/raw|textForLocalModel/i.test(key))
      .map(async ([key, item]) => {
        if (typeof item === "string" && /label|value|text/i.test(key)) {
          // Deterministic only — page body already went through NER; avoid extra WebGPU passes.
          const redacted = await textModel.redact(item, { preferModel: false, strictFallback: true });
          return [key, redacted.text];
        }
        return [key, await redactToolResult(item)];
      }),
  );
  return Object.fromEntries(safeEntries);
}

async function executeManualTool(toolName) {
  if (state.busy) return;
  const definition = getToolDefinition(toolName);
  if (!definition) return;

  if (toolName === "get_page_state") {
    setBusy(true);
    try {
      await scanPage();
    } catch (error) {
      log("get_page_state", error instanceof Error ? error.message : String(error), { level: "error" });
      setStatus("error", "failed");
    } finally {
      setBusy(false);
    }
    return;
  }

  if (toolName === "screenshot") {
    setBusy(true);
    try {
      await captureFrame();
    } catch (error) {
      log("screenshot", error instanceof Error ? error.message : String(error), { level: "error" });
      setStatus("error", "failed");
    } finally {
      setBusy(false);
    }
    return;
  }

  setBusy(true);
  try {
    const pageState = ["read_element", "click", "type"].includes(toolName) ? await ensurePageState() : null;
    let tool;
    if (toolName === "read_element") {
      tool = { name: toolName, selector_ref: toolRef("textbox") || pageState?.elements?.[0]?.ref };
    } else if (toolName === "click") {
      tool = { name: toolName, selector_ref: toolRef("button") };
    } else if (toolName === "type") {
      tool = { name: toolName, selector_ref: toolRef("textbox"), text: "Local test" };
    } else if (toolName === "scroll") {
      tool = { name: toolName, direction: "down", amount_px: 320 };
    } else if (toolName === "navigate") {
      const url = els.navigateUrl.value.trim();
      if (!url) throw new Error("Set a navigate URL first.");
      tool = { name: toolName, url };
    }
    if (!tool) throw new Error(`No payload for ${toolName}`);

    log(toolName, "manual test", { detail: tool });
    const response = await sendRuntime({ type: "EXECUTE_TOOL", tool });
    const result = unwrapContentResult(response);
    if (!result.ok) throw new Error(result.error);
    const safe = await redactToolResult(result.result);
    log(toolName, "ok", { detail: safe });
    setStatus("ready", "ready");
  } catch (error) {
    log(toolName, error instanceof Error ? error.message : String(error), { level: "error" });
    setStatus("error", "failed");
  } finally {
    setBusy(false);
  }
}

async function executeAgentTool(name, args = {}) {
  if (!hasExtensionRuntime) {
    throw new Error("Load the built extension in Chrome to run the agent.");
  }

  if (name === "get_page_state") {
    await scanPage({ forAgent: true });
    const safe = state.pageState;
    return {
      ok: true,
      url: safe.url,
      title: safe.title,
      frames: safe.frames || 1,
      elements: (safe.elements || []).map(({ ref, role, label, value, sensitive, tag, checked, bounds }) => ({
        ref,
        role,
        label,
        value,
        checked,
        sensitive: Boolean(sensitive),
        tag,
        bounds,
      })),
      text: (safe.redactedText || "").slice(0, 4000),
      text_preview: (safe.redactedText || "").slice(0, 2000),
    };
  }

  if (name === "screenshot") {
    const redacted = await captureFrame();
    return {
      ok: true,
      action: "screenshot",
      redacted: true,
      mode: redacted.mode,
      detection_count: redacted.detections?.length ?? 0,
      detections: (redacted.detections || []).slice(0, 24).map((item) => ({
        label: item.label || item.className || item.name || "sensitive",
        score: item.score,
      })),
      elapsed_ms: redacted.elapsedMs,
      note: "Viewport masked on-device; raw pixels not sent to the chat model.",
    };
  }

  const tool = { name, ...args };
  if (name === "scroll" && tool.amount_px == null) tool.amount_px = 320;

  const response = await sendRuntime({ type: "EXECUTE_TOOL", tool });
  const result = unwrapContentResult(response);
  if (!result.ok) throw new Error(result.error);
  const safeResult = await redactToolResult(result.result);
  return { ok: true, ...safeResult };
}

function handleAgentEvent(event) {
  switch (event.type) {
    case "start":
      setStatus("busy", "agent");
      log("agent", `start · ${event.model}`, {
        detail: { task: event.task, maxTurns: event.maxTurns, baseUrl: event.baseUrl },
      });
      break;
    case "model_request":
      setStatus("busy", `turn ${event.turn}`);
      log("model", `request turn ${event.turn} · ${event.model}`);
      break;
    case "model_response": {
      const bits = [
        `turn ${event.turn}`,
        `${event.ms}ms`,
        event.toolCallCount ? `${event.toolCallCount} tool call(s)` : "final text",
        event.finishReason || "",
        event.proxy?.upstream ? `via ${event.proxy.upstream}` : "",
      ].filter(Boolean);
      log("model", bits.join(" · "), {
        detail: {
          content: event.content || null,
          usage: event.usage,
          proxy: event.proxy,
        },
      });
      break;
    }
    case "model_error":
      log("model", event.error, {
        level: "error",
        detail: { status: event.status, model: event.model, turn: event.turn },
      });
      break;
    case "model_fallback":
      log("model", `fallback ${event.from} → ${event.to}`, {
        level: "warn",
        detail: event.reason,
      });
      if (els.model) els.model.value = event.to;
      break;
    case "tool_call":
      log("tool", `→ ${event.name}`, { detail: event.args });
      break;
    case "tool_result":
      log("tool", `${event.ok ? "←" : "✗"} ${event.name} · ${event.ms}ms`, {
        level: event.ok ? "info" : "error",
        detail: event.summary,
      });
      break;
    case "final":
      log("agent", event.truncated ? `truncated · ${event.ms}ms` : `done · ${event.ms}ms`, {
        level: event.truncated ? "warn" : "info",
        detail: event.answer,
      });
      setStatus(event.truncated ? "error" : "ready", event.truncated ? "truncated" : "ready");
      break;
    default:
      log("agent", event.type, { detail: event });
  }
}

async function pingProxy(baseUrl) {
  const healthUrl = `${baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/health`;

  // Prefer background fetch (has host permissions), then try the side panel directly.
  if (hasExtensionRuntime) {
    const response = await sendRuntime({ type: "PROXY_HEALTH", url: healthUrl });
    if (response?.ok) return response;
    // Fall through to direct fetch — some Chrome builds block SW→localhost oddly.
  }

  try {
    const response = await fetch(healthUrl, { method: "GET" });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, status: response.status, error: data?.error?.message || `HTTP ${response.status}`, data };
    }
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error:
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Start the proxy in a terminal: bun run agent-proxy`,
    };
  }
}

async function runAgent() {
  if (state.busy) return;
  const task = els.task.value.trim();
  const apiKey = els.apiKey.value.trim();
  const model = els.model.value || "deepseek-v4-flash";
  let baseUrl = (els.baseUrl?.value || AGENT_CONFIG.baseUrl).trim().replace(/\/$/, "");

  if (!task) {
    log("agent", "Enter a task first.", { level: "warn" });
    return;
  }
  if (!apiKey) {
    log("agent", "Add an API key under Settings.", { level: "warn" });
    $("#settings-panel").open = true;
    return;
  }

  if (/agentrouter\.org/i.test(baseUrl)) {
    log("proxy", "Chrome cannot call agentrouter.org directly (WAF). Switching to local proxy URL.", {
      level: "warn",
    });
    baseUrl = AGENT_CONFIG.baseUrl;
    if (els.baseUrl) els.baseUrl.value = baseUrl;
    $("#settings-panel").open = true;
  }

  setBusy(true);
  setStatus("busy", "agent");
  try {
    await saveAgentSettings({ apiKey, model, baseUrl });

    // Don't block the agent on a multi-hundred-MB GPU load. Deterministic PII
    // covers early turns; NER loads only when explicitly needed / idle later.
    if (textModel.status === "idle" && !textModel.unavailable && !textModel.loadingPromise) {
      // Deferred so the first model request isn't fighting the agent chat round-trip.
      setTimeout(() => textModel.ensureLoaded().catch(() => {}), 2500);
      log("ner", "will warm in background · agent uses deterministic PII until ready");
    }

    if (/127\.0\.0\.1|localhost/i.test(baseUrl)) {
      const health = await pingProxy(baseUrl);
      if (!health?.ok) {
        throw new Error(
          `Local proxy not reachable (${health?.error || "no response"}). ` +
            `In a terminal run: bun run agent-proxy`,
        );
      }
      log("proxy", "local proxy healthy", { detail: health.data || health });
    }

    const result = await runAgentLoop({
      task,
      apiKey,
      baseUrl,
      model,
      executeTool: executeAgentTool,
      onEvent: handleAgentEvent,
    });
    setStatus(result.ok ? "ready" : "error", result.ok ? "ready" : "truncated");
  } catch (error) {
    log("agent", error instanceof Error ? error.message : String(error), { level: "error" });
    setStatus("error", "failed");
  } finally {
    setBusy(false);
  }
}

const textModel = new TextPrivacyModel((payload) => {
  setModelDot(els.nerDot, payload.status === "idle" ? "ready" : payload.status);
  if (payload.status === "loading") {
    setStatus("busy", "loading ner");
    if (!state._nerLoadLogged) {
      state._nerLoadLogged = true;
      log("ner", payload.detail || "loading…");
    } else if (payload.detail && /%/.test(payload.detail)) {
      // Throttled progress already — refresh last message lightly via status only.
    }
  } else if (payload.status === "ready") {
    state._nerLoadLogged = false;
    log("ner", "ready · in RAM (idle unload ~90s)");
  } else if (payload.status === "idle") {
    state._nerLoadLogged = false;
    log("ner", payload.detail || "unloaded");
  } else if (payload.status === "error") {
    state._nerLoadLogged = false;
    log("ner", payload.detail || "fallback", { level: "warn" });
  }
});

const imageModel = new ImagePrivacyModel((payload) => {
  setModelDot(els.hasDot, payload.status === "idle" ? "ready" : payload.status);
  if (payload.status === "loading") {
    setStatus("busy", "loading has");
    if (!state._hasLoadLogged) {
      state._hasLoadLogged = true;
      log("has", payload.detail || "loading…");
    }
  } else if (payload.status === "ready") {
    state._hasLoadLogged = false;
    log("has", "ready · in RAM (auto-unload after screenshot)");
  } else if (payload.status === "idle") {
    state._hasLoadLogged = false;
    log("has", payload.detail || "unloaded");
  } else if (payload.status === "error") {
    state._hasLoadLogged = false;
    log("has", payload.detail || "fallback", { level: "warn" });
  }
});

els.run.addEventListener("click", runAgent);
els.task.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runAgent();
  }
});
els.model.addEventListener("change", () => saveAgentSettings({ model: els.model.value }));
els.apiKey.addEventListener("change", () => saveAgentSettings({ apiKey: els.apiKey.value }));
els.baseUrl?.addEventListener("change", () => saveAgentSettings({ baseUrl: els.baseUrl.value }));
$("#test-has").addEventListener("click", async () => {
  if (state.busy) return;
  setBusy(true);
  try {
    await captureFrame();
  } catch (error) {
    log("has", error instanceof Error ? error.message : String(error), { level: "error" });
    setStatus("error", "failed");
  } finally {
    setBusy(false);
  }
});
$("#test-ner").addEventListener("click", async () => {
  if (state.busy) return;
  setBusy(true);
  try {
    await scanPage();
  } catch (error) {
    log("ner", error instanceof Error ? error.message : String(error), { level: "error" });
    setStatus("error", "failed");
  } finally {
    setBusy(false);
  }
});
document.querySelectorAll("[data-tool]").forEach((button) => {
  button.addEventListener("click", () => executeManualTool(button.dataset.tool));
});
els.copyLog.addEventListener("click", copyLog);
els.clearLog.addEventListener("click", clearLog);

clearLog();
loadAgentSettings()
  .then(async (settings) => {
    let baseUrl = settings.baseUrl || AGENT_CONFIG.baseUrl;
    if (/agentrouter\.org/i.test(baseUrl)) {
      baseUrl = AGENT_CONFIG.baseUrl;
      await saveAgentSettings({ baseUrl });
    }
    if (settings.apiKey) els.apiKey.value = settings.apiKey;
    if (settings.model) els.model.value = settings.model;
    if (els.baseUrl) els.baseUrl.value = baseUrl;

    log("runtime", hasExtensionRuntime ? `ready · ${settings.model || "deepseek-v4-flash"}` : "no extension runtime", {
      detail: { baseUrl, hint: "Run `bun run agent-proxy` before agent tasks." },
    });

    if (hasExtensionRuntime && /127\.0\.0\.1|localhost/i.test(baseUrl)) {
      const health = await pingProxy(baseUrl);
      if (health?.ok) {
        log("proxy", "local proxy is up");
      } else {
        log("proxy", "local proxy is down — run: bun run agent-proxy", {
          level: "warn",
          detail: health?.error || null,
        });
      }
    }

    setStatus(hasExtensionRuntime ? "ready" : "error", hasExtensionRuntime ? "ready" : "no runtime");
    // No auto GPU warm on panel open — that is what made Macs lag.
    // Models load on first use (scan / screenshot / agent warm after delay).
  })
  .catch((error) => {
    log("runtime", error instanceof Error ? error.message : String(error), { level: "error" });
    setStatus("error", "failed");
  });
