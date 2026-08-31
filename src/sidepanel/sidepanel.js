import { ImagePrivacyModel } from "../client/models/image-redactor.js";
import { TextPrivacyModel } from "../client/models/text-redactor.js";
import { TOOL_DEFINITIONS, getToolDefinition } from "../shared/tool-contract.js";
import "./sidepanel.css";

const $ = (selector) => document.querySelector(selector);
const hasExtensionRuntime = typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);

const elements = {
  runtimePill: $("#runtime-pill"),
  runtimeStatus: $("#runtime-status"),
  activeTabLabel: $("#active-tab-label"),
  outputState: $("#output-state"),
  frameStage: $("#frame-stage"),
  frameBadge: $("#frame-badge"),
  frameSummary: $("#frame-summary"),
  redactedText: $("#redacted-text"),
  textBadge: $("#text-badge"),
  textSummary: $("#text-summary"),
  activityFeed: $("#activity-feed"),
  activityEmpty: $("#activity-empty"),
  eventCount: $("#event-count"),
  navigateUrl: $("#navigate-url"),
  imageModelStatus: $("#image-model-status"),
  textModelStatus: $("#text-model-status"),
};

const sessionState = {
  activeTab: null,
  pageState: null,
  eventCount: 0,
  busy: false,
};

function sendRuntime(message) {
  if (!hasExtensionRuntime) {
    return Promise.resolve({ ok: false, error: "Preview mode: the extension runtime is not connected." });
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        resolve({ ok: false, error: runtimeError.message });
        return;
      }
      resolve(response ?? { ok: false, error: "No response from the extension." });
    });
  });
}

function setRuntimeStatus(status, label) {
  elements.runtimePill.classList.remove("running", "fallback");
  if (status === "running") elements.runtimePill.classList.add("running");
  if (status === "fallback") elements.runtimePill.classList.add("fallback");
  elements.runtimeStatus.textContent = label;
}

function setModelStatus(target, { status, detail = "" }) {
  const label = status === "ready"
    ? "READY"
    : status === "loading"
      ? "LOADING"
      : status === "error"
        ? "FALLBACK"
        : "NOT LOADED";
  target.textContent = label;
  target.classList.remove("loading", "ready", "error");
  if (status === "loading") target.classList.add("loading");
  if (status === "ready") target.classList.add("ready");
  if (status === "error") target.classList.add("error");
  if (status === "error" && detail) target.title = detail;
}

function appendEvent(title, detail, kind = "") {
  elements.activityEmpty?.remove();
  sessionState.eventCount += 1;
  elements.eventCount.textContent = `${sessionState.eventCount} event${sessionState.eventCount === 1 ? "" : "s"}`;

  const item = document.createElement("div");
  item.className = `activity-item ${kind}`.trim();
  const marker = document.createElement("span");
  marker.className = "activity-marker";
  const body = document.createElement("div");
  body.className = "activity-body";
  const eventTitle = document.createElement("div");
  eventTitle.className = "activity-title";
  eventTitle.textContent = title;
  const eventDetail = document.createElement("div");
  eventDetail.className = "activity-detail";
  eventDetail.textContent = detail;
  const time = document.createElement("time");
  time.className = "activity-time";
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  body.append(eventTitle, eventDetail);
  item.append(marker, body, time);
  elements.activityFeed.prepend(item);

  while (elements.activityFeed.children.length > 8) {
    elements.activityFeed.lastElementChild.remove();
  }
}

function setBusy(isBusy) {
  sessionState.busy = isBusy;
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = isBusy && !button.id.includes("refresh");
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

async function refreshActiveTab() {
  const response = await sendRuntime({ type: "GET_ACTIVE_TAB" });
  if (response?.ok && response.tab) {
    sessionState.activeTab = response.tab;
    elements.activeTabLabel.textContent = response.tab.title || response.tab.url || "Active tab";
    elements.activeTabLabel.title = response.tab.url || "";
    return response.tab;
  }

  sessionState.activeTab = null;
  elements.activeTabLabel.textContent = hasExtensionRuntime ? "No active tab available" : "Preview workspace · no active tab";
  return null;
}

function renderFrame({ dataUrl, detections = [], mode, elapsedMs, error = "" }) {
  elements.frameStage.replaceChildren();
  const image = document.createElement("img");
  image.src = dataUrl;
  image.alt = "Locally redacted viewport preview";
  elements.frameStage.append(image);
  elements.frameBadge.textContent = `${detections.length} MASK${detections.length === 1 ? "" : "S"}`;
  elements.frameBadge.classList.add("active");
  elements.frameSummary.textContent = `${mode} · ${detections.length} region${detections.length === 1 ? "" : "s"} · ${elapsedMs}ms · raw frame withheld${error ? ` · ${error}` : ""}`;
  elements.outputState.textContent = "visual output ready";
}

function renderText({ text, spans = [], mode }) {
  elements.redactedText.textContent = text || "No readable text was found on this page.";
  elements.textBadge.textContent = `${spans.length} SPAN${spans.length === 1 ? "" : "S"}`;
  elements.textBadge.classList.add("active");
  elements.textSummary.textContent = `${mode} · ${spans.length} sensitive span${spans.length === 1 ? "" : "s"} replaced before tool output`;
  elements.outputState.textContent = "text output ready";
}


async function redactPageState(pageState) {
  const textResult = await textModel.redact(pageState.textForLocalModel || "", { preferModel: true, strictFallback: true });
  const safeElements = await textModel.redactElements(pageState.elements || [], { strictFallback: true });
  sessionState.pageState = {
    ...pageState,
    textForLocalModel: undefined,
    elements: safeElements,
    redactedText: textResult.text,
  };
  renderText(textResult);
  return { textResult, safeElements };
}

async function scanPage() {
  setRuntimeStatus("running", "SCANNING");
  try {
    if (!hasExtensionRuntime) {
      throw new Error("Load the built extension in Chrome to scan a real tab.");
    }
    const response = await sendRuntime({ type: "SCAN_PAGE" });
    const pageResponse = unwrapContentResult(response);
    if (!pageResponse.ok) throw new Error(pageResponse.error);
    const pageState = pageResponse.result;
    if (!pageState) throw new Error("The content script returned no page state.");
    const { textResult, safeElements } = await redactPageState(pageState);
    const title = pageState.title || "active page";
    appendEvent("get_page_state", `${safeElements.length} elements · ${textResult.spans.length} text spans · ${title}${textModel.lastError ? ` · ${textModel.lastError}` : ""}`);
    setRuntimeStatus(textModel.status === "error" ? "fallback" : "ready", textModel.status === "error" ? "SAFE FALLBACK" : "READY");
    return pageState;
  } catch (error) {
    appendEvent("get_page_state", error instanceof Error ? error.message : String(error), "error");
    setRuntimeStatus("fallback", "CHECK FAILED");
    throw error;
  }
}

async function captureFrame() {
  setRuntimeStatus("running", "REDACTING");
  try {
    let rawFrame;
    if (!hasExtensionRuntime) {
      throw new Error("Load the built extension in Chrome to capture a real viewport.");
    }
    const response = await sendRuntime({ type: "CAPTURE_VISIBLE_TAB" });
    if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "Could not capture the active viewport.");
    rawFrame = response.dataUrl;

    const redacted = await imageModel.redact(rawFrame);
    // Do not retain or render rawFrame. The model result is the only frame that reaches the UI.
    renderFrame(redacted);
    appendEvent("screenshot", `${redacted.mode} · ${redacted.detections.length} regions · ${redacted.elapsedMs}ms${redacted.error ? ` · ${redacted.error}` : ""}`, redacted.error ? "error" : "");
    setRuntimeStatus(redacted.error ? "fallback" : "ready", redacted.error ? "SAFE FALLBACK" : "READY");
    return redacted;
  } catch (error) {
    appendEvent("screenshot", error instanceof Error ? error.message : String(error), "error");
    setRuntimeStatus("fallback", "CHECK FAILED");
    throw error;
  }
}

async function runTextTest() {
  if (sessionState.busy) return;
  setBusy(true);
  setRuntimeStatus("running", "LOADING NER");
  try {
    await scanPage();
  } catch (error) {
    appendEvent("Privacy Filter", error instanceof Error ? error.message : String(error), "error");
    setRuntimeStatus("fallback", "CHECK FAILED");
  } finally {
    setBusy(false);
  }
}

async function runVisualTest() {
  if (sessionState.busy) return;
  setBusy(true);
  setRuntimeStatus("running", "LOADING VISION");
  try {
    await captureFrame();
  } catch (error) {
    appendEvent("HaS visual mask", error instanceof Error ? error.message : String(error), "error");
    setRuntimeStatus("fallback", "CHECK FAILED");
  } finally {
    setBusy(false);
  }
}

async function ensurePageState() {
  if (sessionState.pageState) return sessionState.pageState;
  return scanPage();
}

function toolRef(preferredRole = "") {
  const candidates = sessionState.pageState?.elements || [];
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
          const redacted = await textModel.redact(item, { preferModel: true, strictFallback: true });
          return [key, redacted.text];
        }
        return [key, await redactToolResult(item)];
      }),
  );
  return Object.fromEntries(safeEntries);
}

async function executeTool(toolName) {
  if (sessionState.busy) return;
  const definition = getToolDefinition(toolName);
  if (!definition) return;

  if (toolName === "get_page_state") {
    setBusy(true);
    try { await scanPage(); } catch { /* the activity feed already shows the error */ } finally { setBusy(false); }
    return;
  }

  if (toolName === "screenshot") {
    setBusy(true);
    try { await captureFrame(); } catch { /* the activity feed already shows the error */ } finally { setBusy(false); }
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
      const url = elements.navigateUrl.value.trim();
      if (!url) throw new Error("Add an http(s) URL in the navigate target field first.");
      tool = { name: toolName, url };
    }

    if (!tool) throw new Error(`No local test payload is configured for ${toolName}.`);
    let response;
    if (hasExtensionRuntime) {
      response = await sendRuntime({ type: "EXECUTE_TOOL", tool });
      const result = unwrapContentResult(response);
      if (!result.ok) throw new Error(result.error);
      response = result.result;
    } else {
      throw new Error("Load the built extension in Chrome to execute tools on a real tab.");
    }

    const safeResult = await redactToolResult(response);
    if (toolName === "read_element") {
      appendEvent(definition.name, `${safeResult?.role || "element"} · ${safeResult?.label || "redacted result"}`);
      elements.redactedText.textContent = JSON.stringify(safeResult, null, 2);
      elements.textBadge.textContent = "TOOL RESULT";
      elements.textBadge.classList.add("active");
      elements.textSummary.textContent = "read_element returned a client-redacted value.";
    } else if (toolName === "navigate") {
      appendEvent(definition.name, `requested ${tool.url}`);
    } else {
      appendEvent(definition.name, `${safeResult?.label || safeResult?.ref || safeResult?.direction || "local action complete"}`);
    }
    setRuntimeStatus("ready", "READY");
  } catch (error) {
    appendEvent(definition.name, error instanceof Error ? error.message : String(error), "error");
    setRuntimeStatus("fallback", "ACTION BLOCKED");
  } finally {
    setBusy(false);
  }
}

function clearOutputs() {
  elements.frameStage.innerHTML = "<div class=\"empty-frame\"><span class=\"empty-frame-icon\">◌</span><span>Capture the active tab to see<br />verified masks land on the frame.</span></div>";
  elements.frameBadge.textContent = "EMPTY";
  elements.frameBadge.classList.remove("active");
  elements.frameSummary.textContent = "Your raw frame is never rendered here.";
  elements.redactedText.textContent = "Scan the active page to inspect the local model output.";
  elements.textBadge.textContent = "EMPTY";
  elements.textBadge.classList.remove("active");
  elements.textSummary.textContent = "Structured sensitive fields are blocked before serialization.";
  elements.outputState.textContent = "waiting for a test";
  sessionState.pageState = null;
  appendEvent("session", "outputs cleared; model sessions stay warm");
}

const textModel = new TextPrivacyModel((payload) => {
  setModelStatus(elements.textModelStatus, payload);
  if (payload.status === "loading") setRuntimeStatus("running", "LOADING NER");
});

const imageModel = new ImagePrivacyModel((payload) => {
  setModelStatus(elements.imageModelStatus, payload);
  if (payload.status === "loading") setRuntimeStatus("running", "LOADING VISION");
});

$("#test-text").addEventListener("click", runTextTest);
$("#test-visual").addEventListener("click", runVisualTest);
$("#scan-page").addEventListener("click", async () => {
  if (sessionState.busy) return;
  setBusy(true);
  try { await scanPage(); } catch { /* the activity feed already shows the error */ } finally { setBusy(false); }
});
$("#capture-frame").addEventListener("click", async () => {
  if (sessionState.busy) return;
  setBusy(true);
  try { await captureFrame(); } catch { /* the activity feed already shows the error */ } finally { setBusy(false); }
});
$("#clear-output").addEventListener("click", clearOutputs);
$("#refresh-tab").addEventListener("click", refreshActiveTab);
document.querySelectorAll("[data-tool]").forEach((button) => {
  button.addEventListener("click", () => executeTool(button.dataset.tool));
});

refreshActiveTab();
appendEvent("runtime", hasExtensionRuntime ? "client-only mode ready; server agent paused" : "Chrome extension runtime not connected");
