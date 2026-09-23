import { ImagePrivacyModel, paintSensitiveBoxes } from "../client/models/image-redactor.js";
import { extractOcrWords, mapSpansToBoxes } from "../client/models/ocr-redactor.js";
import {
  TextPrivacyModel,
  applyKnownTokens,
  collectKnownTokens,
} from "../client/models/text-redactor.js";
import { getToolDefinition } from "../shared/tool-contract.js";
import { runAgentLoop } from "../agent/agent-loop.js";
import { loadAgentSettings, saveAgentSettings } from "../agent/settings.js";
import { AGENT_CONFIG } from "../agent/config.js";
import {
  deleteConversation,
  listConversations,
  migrateSessionHistory,
  putConversation,
  titleFromMessages,
  transcriptFromMessages,
} from "./history-db.js";

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
  agentHistory: [],
  busy: false,
  logLines: [],
  lastUpload: null,
  conversationId: null,
  conversationCreatedAt: null,
  knownPiiTokens: [],
  _nerLoadLogged: false,
  _hasLoadLogged: false,
};

let turnUi = null;
let runSignal = null;
let gatedExecute = null;

function applyConversation(record, chat) {
  state.conversationId = record?.id || null;
  state.conversationCreatedAt = record?.createdAt || null;
  state.agentHistory = Array.isArray(record?.messages) ? record.messages : [];
  chat?.loadTranscript(transcriptFromMessages(state.agentHistory));
}

async function saveAgentHistory() {
  if (!state.agentHistory.length) return;
  const now = Date.now();
  if (!state.conversationId) {
    state.conversationId = crypto.randomUUID();
    state.conversationCreatedAt = now;
  }
  await putConversation({
    id: state.conversationId,
    title: titleFromMessages(state.agentHistory),
    createdAt: state.conversationCreatedAt || now,
    updatedAt: now,
    messages: state.agentHistory,
  });
  window.dispatchEvent(new CustomEvent("vg-history"));
}

export function activeConversationId() {
  return state.conversationId;
}

export async function listChatHistory() {
  return listConversations();
}

export async function hydrateChatHistory(chat) {
  await migrateSessionHistory();
  // Side panel open always lands on a blank new chat; history is opt-in.
  applyConversation(null, chat);
}

export function openChatHistory(record, chat) {
  applyConversation(record, chat);
}

export function startNewChat(chat) {
  applyConversation(null, chat);
}

export async function deleteChatHistory(id, chat) {
  await deleteConversation(id);
  if (id === state.conversationId) applyConversation(null, chat);
  window.dispatchEvent(new CustomEvent("vg-history"));
}

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
  if (!els.statusDot || !els.statusLabel) return;
  els.statusDot.classList.remove("ready", "busy", "error");
  if (kind) els.statusDot.classList.add(kind);
  els.statusLabel.textContent = label;
}

function setModelDot(dot, status) {
  if (!dot) return;
  dot.classList.remove("ready", "busy", "error");
  if (status === "ready") dot.classList.add("ready");
  else if (status === "loading") dot.classList.add("busy");
  else if (status === "error") dot.classList.add("error");
}

function setBusy(busy) {
  state.busy = busy;
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
  if (!els.log) return;

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
  if (!els.previewImg) return;
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
    "file",
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
  const ranked = scored.slice(0, limit).map((item) => item.el);
  const rankedRefs = new Set(ranked.map((el) => el.ref));
  const files = elements.filter((el) => el.role === "file" && !rankedRefs.has(el.ref));
  return [...files, ...ranked];
}

async function redactPageState(pageState, { maxElements = 80, maxText = 4000, forAgent = false, tabId = null } = {}) {
  const elements = usefulElements(pageState.elements || [], maxElements);
  const bodyText = String(pageState.textForLocalModel || "").slice(0, maxText);
  const fieldTexts = elements.flatMap((element) => {
    const values = [String(element.label || "")];
    if (!element.sensitive && !String(element.value || "").startsWith("[REDACTED:")) {
      values.push(String(element.value || ""));
    }
    return values;
  });

  // Prefer NER whenever it is already resident. Seed every string with tokens
  // learned from earlier scans so short labels like "yashraj" still redact
  // even when the field batch is truncated or the model misses a span.
  const preferNer = textModel.ready;
  const knownTokens = state.knownPiiTokens || [];

  let textResult;
  let fieldResults;
  if (forAgent) {
    const [body] = await textModel.redactBatch([bodyText], {
      preferModel: preferNer,
      strictFallback: true,
      maxChars: maxText,
      knownTokens,
    });
    textResult = body;
    // Fields used to force preferModel:false — that leaked person names in
    // element labels (chat display names). Run NER when ready; always reuse tokens.
    fieldResults = await textModel.redactBatch(fieldTexts, {
      preferModel: preferNer,
      strictFallback: false,
      maxChars: 240,
      knownTokens,
    });
  } else {
    const batch = await textModel.redactBatch([bodyText, ...fieldTexts], {
      preferModel: true,
      strictFallback: true,
      maxChars: maxText,
      knownTokens,
    });
    textResult = batch[0];
    fieldResults = batch.slice(1);
  }

  // Grow the known-token dictionary from this pass (body + fields).
  const discovered = collectKnownTokens([
    ...(textResult.spans || []),
    ...fieldResults.flatMap((item) => item.spans || []),
  ]);
  if (discovered.length) {
    const merged = new Map(
      [...(state.knownPiiTokens || []), ...discovered].map((token) => [
        `${token.kind}:${String(token.value).toLowerCase()}`,
        token,
      ]),
    );
    state.knownPiiTokens = [...merged.values()].slice(-200);
  }

  let fieldIndex = 0;
  const safeElements = elements.map((element) => {
    const safe = { ...element, label: fieldResults[fieldIndex++].text };
    if (!element.sensitive && !String(element.value || "").startsWith("[REDACTED:")) {
      safe.value = fieldResults[fieldIndex++].text;
    }
    // Mark elements whose label/value was rewritten so screenshot DOM paint can cover them.
    const rawLabel = String(element.label || "");
    const rawValue = String(element.value || "");
    safe.piiMasked =
      safe.label !== rawLabel ||
      (safe.value != null && safe.value !== rawValue) ||
      Boolean(element.sensitive);
    return safe;
  });

  state.pageState = {
    ...pageState,
    tabId,
    textForLocalModel: undefined,
    elements: safeElements,
    redactedText: textResult.text,
    viewport: pageState.viewport || null,
  };
  return { textResult, safeElements };
}

async function scanPage({ forAgent = false, tabId = null } = {}) {
  const started = Date.now();
  setStatus("busy", "scanning");
  if (!hasExtensionRuntime) throw new Error("Load the built extension in Chrome.");

  // Manual scans can wait for NER; agent path waits for an in-flight load but
  // still avoids starting a fresh multi-minute Hub download mid-turn.
  if (!forAgent && textModel.status !== "ready" && !textModel.unavailable) {
    setStatus("busy", "loading ner");
    await textModel.ensureLoaded().catch(() => {});
  } else if (forAgent && textModel.loadingPromise) {
    setStatus("busy", "loading ner");
    await textModel.loadingPromise.catch(() => {});
  }

  const response = await sendRuntime({ type: "SCAN_PAGE", tabId });
  const pageResponse = unwrapContentResult(response);
  if (!pageResponse.ok) throw new Error(pageResponse.error);
  const pageState = pageResponse.result;
  if (!pageState) throw new Error("No page state from content script.");

  const { textResult, safeElements } = await redactPageState(pageState, {
    maxElements: forAgent ? 64 : 100,
    maxText: forAgent ? 4500 : 6000,
    forAgent,
    tabId,
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
        knownTokens: (state.knownPiiTokens || []).length,
      },
    },
  );
  setStatus(textModel.status === "error" ? "error" : "ready", textModel.status === "error" ? "ner fallback" : "ready");
  return pageState;
}

function rememberUpload(_captureDataUrl, redacted) {
  // Fail closed: never store the raw capture. Empty HaS detections already
  // produce a FRAME WITHHELD placeholder — keep that, do not fall open.
  if (redacted.error) {
    const withheld = Boolean(redacted.dataUrl);
    state.lastUpload = withheld
      ? { dataUrl: redacted.dataUrl, masked: true, withheld: true }
      : null;
    return;
  }
  state.lastUpload = {
    dataUrl: redacted.dataUrl,
    masked: true,
    withheld: false,
  };
}

function sensitiveDomBoxes(pageState = state.pageState) {
  const elements = pageState?.elements || [];
  const boxes = [];
  for (const element of elements) {
    const bounds = element.bounds;
    if (!bounds || !(bounds.width > 1) || !(bounds.height > 1)) continue;
    const text = `${element.label || ""} ${element.value || ""}`;
    const shouldPaint =
      Boolean(element.piiMasked) ||
      Boolean(element.sensitive) ||
      /\[[A-Z][A-Z0-9_]{1,20}\]/.test(text);
    if (!shouldPaint) continue;
    boxes.push({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      kind: element.sensitiveKind || "NAME",
    });
  }
  return boxes;
}

async function compressImageDataUrl(dataUrl) {
  const image = new Image();
  image.decoding = "async";
  image.src = dataUrl;
  await image.decode();
  const maxEdge = 1280;
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let quality = 0.82;
  let url = canvas.toDataURL("image/jpeg", quality);
  while (url.length > 1_400_000 && quality > 0.45) {
    quality -= 0.12;
    url = canvas.toDataURL("image/jpeg", quality);
  }
  return url;
}

async function captureFrame() {
  setStatus("busy", "redacting");
  if (!hasExtensionRuntime) throw new Error("Load the built extension in Chrome.");
  const response = await sendRuntime({ type: "CAPTURE_VISIBLE_TAB" });
  if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "Capture failed.");

  // OCR the raw capture on CPU while HaS runs on GPU.
  const ocrPromise = extractOcrWords(response.dataUrl, {
    onProgress: (message) => {
      if (message?.status === "recognizing text" && Number.isFinite(message.progress)) {
        setStatus("busy", `ocr ${Math.round(message.progress * 100)}%`);
      }
    },
  }).catch((error) => ({
    text: "",
    words: [],
    elapsedMs: 0,
    error: error instanceof Error ? error.message : String(error),
  }));

  let redacted = await imageModel.redact(response.dataUrl);

  // Free HaS before NER loads — they cannot share VRAM.
  try {
    await imageModel.dispose();
  } catch {
    // ignore
  }

  if (!redacted.error) {
    try {
      setStatus("busy", "ocr → ner");
      const ocr = await ocrPromise;
      if (ocr.error) {
        log("ocr", ocr.error, { level: "warn" });
      } else if (ocr.text?.trim()) {
        await textModel.ensureLoaded().catch(() => {});
        const refined = await textModel.redact(ocr.text, {
          preferModel: true,
          knownTokens: state.knownPiiTokens || [],
          maxChars: 6000,
        });
        const boxes = mapSpansToBoxes(ocr.words || [], refined.spans);
        if (boxes.length) {
          // OCR boxes are already in capture pixel space (not CSS * dpr).
          const painted = await paintSensitiveBoxes(redacted.dataUrl, boxes, {
            dpr: 1,
            label: "OCR PII",
          });
          redacted = {
            ...redacted,
            dataUrl: painted,
            mode: `${redacted.mode} + ocr + ${refined.mode} (${boxes.length})`,
            ocrBoxes: boxes.length,
            ocrSpans: (refined.spans || []).slice(0, 12),
          };
        }
      }
    } catch (error) {
      log("ocr", error instanceof Error ? error.message : String(error), { level: "warn" });
    }

    try {
      if (!state.pageState) {
        await scanPage({ forAgent: true }).catch(() => {});
      }
      const boxes = sensitiveDomBoxes(state.pageState);
      if (boxes.length) {
        const dpr = Number(state.pageState?.viewport?.dpr) || 1;
        const painted = await paintSensitiveBoxes(redacted.dataUrl, boxes, { dpr, label: "DOM PII" });
        redacted = {
          ...redacted,
          dataUrl: painted,
          mode: `${redacted.mode} + DOM PII (${boxes.length})`,
          domBoxes: boxes.length,
        };
      }
    } catch {
      // Keep HaS/OCR output if DOM paint fails — never fall back to the raw capture.
    }
  }

  rememberUpload(response.dataUrl, redacted);
  showPreview(state.lastUpload?.dataUrl || redacted.dataUrl);
  log(
    "screenshot",
    `${redacted.mode} · ${redacted.detections?.length ?? 0} masks · ${redacted.elapsedMs}ms`,
    {
      level: redacted.error ? "warn" : "info",
      detail: {
        detections: (redacted.detections || []).slice(0, 12),
        error: redacted.error || null,
        withheld: Boolean(state.lastUpload?.withheld),
        domBoxes: redacted.domBoxes || 0,
        ocrBoxes: redacted.ocrBoxes || 0,
        ocrSpans: redacted.ocrSpans || [],
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

  const knownTokens = state.knownPiiTokens || [];
  const preferNer = textModel.ready;
  const safeEntries = await Promise.all(
    Object.entries(value)
      .filter(([key]) => !/raw|textForLocalModel/i.test(key))
      .map(async ([key, item]) => {
        if (typeof item === "string" && /label|value|text|title|url|folder/i.test(key)) {
          // Use NER when resident; always re-apply known person-name tokens so
          // titles/bookmarks cannot reintroduce names from an earlier scan.
          const redacted = await textModel.redact(item, {
            preferModel: preferNer,
            strictFallback: true,
            knownTokens,
          });
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

  if (name === "list_tabs") {
    const response = await sendRuntime({ type: "GET_TABS" });
    if (!response?.ok) throw new Error(response?.error || "Unable to list browser tabs.");
    return {
      ok: true,
      tabs: await redactToolResult(response.tabs || []),
    };
  }

  if (name === "list_bookmarks") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const response = await sendRuntime({ type: "GET_BOOKMARKS", query });
    if (!response?.ok) throw new Error(response?.error || "Unable to read bookmarks.");
    return {
      ok: true,
      query: response.query ?? null,
      total: response.total ?? 0,
      truncated: Boolean(response.truncated),
      bookmarks: await redactToolResult(response.bookmarks || []),
      note: response.truncated
        ? "Results truncated. Call list_bookmarks again with a narrower query."
        : "Saved bookmarks from this Chrome profile. navigate can open only entries marked openable.",
    };
  }

  if (name === "get_page_state") {
    const tabId = Number.isInteger(args.tab_id) ? args.tab_id : null;
    await scanPage({ forAgent: true, tabId });
    const safe = state.pageState;
    const metadata = await redactToolResult({ url: safe.url, title: safe.title });
    return {
      ok: true,
      tab_id: safe.tabId,
      url: metadata.url,
      title: metadata.title,
      frames: safe.frames || 1,
      elements: (safe.elements || []).map(({ ref, role, label, value, sensitive, tag, checked, bounds, accept, hidden }) => ({
        ref,
        role,
        label,
        value,
        checked,
        sensitive: Boolean(sensitive),
        tag,
        bounds,
        ...(role === "file" ? { accept: accept || "", hidden: Boolean(hidden) } : {}),
      })),
      text: (safe.redactedText || "").slice(0, 4000),
      text_preview: (safe.redactedText || "").slice(0, 2000),
    };
  }

  if (name === "screenshot") {
    const redacted = await captureFrame();
    const previewUrl = state.lastUpload?.dataUrl || redacted.dataUrl || null;
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
      stored_for_upload: Boolean(state.lastUpload?.dataUrl) && !state.lastUpload?.withheld,
      masked: Boolean(state.lastUpload?.masked),
      withheld: Boolean(state.lastUpload?.withheld),
      note: state.lastUpload?.withheld
        ? "Frame withheld — visual model found no verified masks. Pixels were not stored for upload and were not sent to the chat model."
        : state.lastUpload?.dataUrl
          ? "Screenshot stored on this device. Call upload_image to attach it. This result does not include pixels."
          : "Screenshot could not be stored for upload. Pixels were not sent to the chat model.",
      // Stripped in agent-loop before the model sees the tool result.
      __uiPreview: previewUrl
        ? {
            url: previewUrl,
            alt: state.lastUpload?.withheld
              ? "Frame withheld — no verified privacy masks"
              : "Redacted screenshot (on-device only)",
            caption: state.lastUpload?.withheld
              ? "Withheld placeholder — raw viewport was not stored."
              : "On-device redacted capture · not sent to the chat model.",
          }
        : null,
    };
  }

  if (name === "upload_image") {
    if (!state.lastUpload?.dataUrl) {
      throw new Error("No screenshot is stored. Call screenshot first, then upload_image on the destination tab.");
    }
    if (!state.lastUpload.masked) {
      throw new Error("Refusing to upload an unmasked screenshot. Capture again after privacy models are ready.");
    }
    if (state.lastUpload.withheld) {
      throw new Error(
        "The last capture was withheld (no verified visual privacy masks). Upload blocked to avoid leaking the raw frame.",
      );
    }
    const dataUrl = await compressImageDataUrl(state.lastUpload.dataUrl);
    const tool = {
      name: "upload_image",
      data_url: dataUrl,
      filename: "screenshot.jpg",
    };
    if (args.selector_ref) tool.selector_ref = String(args.selector_ref);
    if (Number.isInteger(args.tab_id)) tool.tab_id = args.tab_id;
    const response = await sendRuntime({ type: "EXECUTE_TOOL", tool });
    const result = unwrapContentResult(response);
    if (!result.ok) throw new Error(result.error);
    const safe = await redactToolResult(result.result);
    return {
      ok: true,
      ...safe,
      masked: Boolean(state.lastUpload.masked),
      note: "Attached the stored screenshot on the device. Pixels were not sent to the chat model.",
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

function toolLabel(name) {
  return getToolDefinition(name)?.label || name;
}

function describeCall(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const where = a.tab_id != null ? ` in tab ${a.tab_id}` : "";
  const ref = a.selector_ref ? String(a.selector_ref) : "";
  let text = `${toolLabel(name)}${where}.`;
  if (name === "click") text = `Click ${ref || "the element"}${where}.`;
  if (name === "read_element") text = `Read ${ref || "the element"}${where}.`;
  if (name === "get_page_state") text = `Read the page${where}.`;
  if (name === "list_tabs") text = "List the open tabs.";
  if (name === "list_bookmarks") {
    const query = String(a.query ?? "").replace(/\s+/g, " ").trim();
    const shown = query.length > 72 ? `${query.slice(0, 69)}…` : query;
    text = shown ? `Search bookmarks for “${shown}”.` : "List saved bookmarks.";
  }
  if (name === "screenshot") text = "Capture a redacted screenshot.";
  if (name === "upload_image") {
    text = ref
      ? `Attach the stored screenshot to ${ref}${where}.`
      : `Attach the stored screenshot to the page's image upload${where}.`;
  }
  if (name === "submit") text = `Submit ${ref || "the form"}${where}.`;
  if (name === "press_key") text = `Press ${a.key || "the key"}${ref ? ` on ${ref}` : ""}${where}.`;
  if (name === "scroll") {
    text = `Scroll ${a.direction || "down"}${a.amount_px ? ` ${a.amount_px}px` : ""}${where}.`;
  }
  if (name === "navigate" && a.url) text = `Open ${a.url}${where}.`;
  if (name === "type") {
    const preview = String(a.text ?? "").replace(/\s+/g, " ").trim();
    const shown = preview.length > 72 ? `${preview.slice(0, 69)}…` : preview;
    text = shown
      ? `Type “${shown}” into ${ref || "the field"}${where}.`
      : `Type into ${ref || "the field"}${where}.`;
  }
  return {
    title: "Needs your approval",
    text,
    impact: getToolDefinition(name)?.description || "Runs this browser action. Denying stops this step.",
  };
}

function ensureReasoning() {
  if (!turnUi?.agent) return null;
  if (!turnUi.reasoning) turnUi.reasoning = turnUi.agent.reasoning("");
  return turnUi.reasoning;
}

function endReasoning() {
  turnUi?.reasoning?.end();
  if (turnUi) turnUi.reasoning = null;
}

function handleAgentEvent(event) {
  switch (event.type) {
    case "start":
      ensureReasoning();
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
      if (event.toolCallCount && event.content) ensureReasoning()?.write(`${event.content}\n`);
      if (!event.toolCallCount) endReasoning();
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
      endReasoning();
      turnUi?.agent.error(event.error);
      if (turnUi) turnUi.shownError = true;
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
    case "model_stall":
      ensureReasoning()?.write("Continuing…\n");
      log("model", `empty turn · nudge ${event.attempt}`, {
        level: "warn",
        detail: event.note,
      });
      break;
    case "tool_call":
      endReasoning();
      turnUi?.tools.push(
        turnUi.agent.tool({
          name: toolLabel(event.name),
          input: JSON.stringify(event.args ?? {}, null, 2),
        }),
      );
      log("tool", `→ ${event.name}`, { detail: event.args });
      break;
    case "tool_result": {
      const toolUi = turnUi?.tools.shift();
      const extras = {};
      const previewUrl = event.previewUrl || (event.name === "screenshot" ? state.lastUpload?.dataUrl : null);
      if (previewUrl) {
        extras.previewUrl = previewUrl;
        extras.previewAlt =
          event.previewAlt ||
          (state.lastUpload?.withheld
            ? "Frame withheld — no verified privacy masks"
            : "Redacted screenshot (on-device only)");
        extras.previewCaption =
          event.previewCaption ||
          (state.lastUpload?.withheld
            ? "Withheld placeholder — raw viewport was not stored."
            : "On-device redacted capture · not sent to the chat model.");
      }
      toolUi?.result(
        typeof event.summary === "string" ? event.summary : JSON.stringify(event.summary ?? {}, null, 2),
        event.ok ? "done" : "error",
        extras,
      );
      log("tool", `${event.ok ? "←" : "✗"} ${event.name} · ${event.ms}ms`, {
        level: event.ok ? "info" : "error",
        detail: event.summary,
      });
      break;
    }
    case "final":
      endReasoning();
      turnUi?.agent.text(event.answer || "");
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

async function runAgent(taskText) {
  if (state.busy) return;
  const task = String(taskText ?? "").trim();
  const apiKey = els.apiKey?.value.trim() || "";
  const model = els.model?.value || "deepseek-v4-flash";
  let baseUrl = (els.baseUrl?.value || AGENT_CONFIG.baseUrl).trim().replace(/\/$/, "");

  if (!task) throw new Error("Enter a task first.");
  if (!apiKey) throw new Error("Add an API key before running the agent.");

  if (/agentrouter\.org/i.test(baseUrl)) {
    log("proxy", "Chrome cannot call agentrouter.org directly (WAF). Switching to local proxy URL.", {
      level: "warn",
    });
    baseUrl = AGENT_CONFIG.baseUrl;
    if (els.baseUrl) els.baseUrl.value = baseUrl;
  }

  setBusy(true);
  setStatus("busy", "agent");
  try {
    await saveAgentSettings({ apiKey, model, baseUrl });

    // Warm NER immediately so the first get_page_state can redact person names.
    // Deterministic regex never covers NAME — delaying the load leaked display names.
    if (textModel.status === "idle" && !textModel.unavailable && !textModel.loadingPromise) {
      textModel.ensureLoaded().catch(() => {});
      log("ner", "warming · NAME redaction needs NER (regex alone is not enough)");
    }

    // Scrub the user task before it leaves the device (e.g. "message yashraj").
    let safeTask = task;
    if (textModel.ready || (state.knownPiiTokens || []).length) {
      const scrubbed = await textModel.redact(task, {
        preferModel: textModel.ready,
        strictFallback: true,
        knownTokens: state.knownPiiTokens || [],
      });
      safeTask = scrubbed.text;
      const discovered = collectKnownTokens(scrubbed.spans || []);
      if (discovered.length) {
        const merged = new Map(
          [...(state.knownPiiTokens || []), ...discovered].map((token) => [
            `${token.kind}:${String(token.value).toLowerCase()}`,
            token,
          ]),
        );
        state.knownPiiTokens = [...merged.values()].slice(-200);
      }
    }

    // Re-scrub persisted history so earlier leaked tool JSON cannot be re-sent.
    const tokens = state.knownPiiTokens || [];
    if (tokens.length && Array.isArray(state.agentHistory) && state.agentHistory.length) {
      state.agentHistory = state.agentHistory.map((message) => {
        if (!message || typeof message.content !== "string") return message;
        const { text } = applyKnownTokens(message.content, tokens);
        return text === message.content ? message : { ...message, content: text };
      });
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
      task: safeTask,
      history: state.agentHistory,
      apiKey,
      baseUrl,
      model,
      executeTool: gatedExecute || executeAgentTool,
      onEvent: handleAgentEvent,
      signal: runSignal || undefined,
    });
    state.agentHistory = result.messages.slice(1);
    await saveAgentHistory().catch(() => {});
    setStatus(result.ok ? "ready" : "error", result.ok ? "ready" : "truncated");
  } catch (error) {
    log("agent", error instanceof Error ? error.message : String(error), { level: "error" });
    setStatus("error", "failed");
    throw error;
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

els.model?.addEventListener("change", () => saveAgentSettings({ model: els.model.value }));
els.apiKey?.addEventListener("change", () => saveAgentSettings({ apiKey: els.apiKey.value }));
els.baseUrl?.addEventListener("change", () => saveAgentSettings({ baseUrl: els.baseUrl.value }));

export function createRunner(chat) {
  let aborted = false;
  let mode = "confirm";
  let lastText = "";
  let abortController = null;

  async function run(text) {
    aborted = false;
    lastText = text;
    abortController = new AbortController();
    const agent = chat.beginAgent();
    chat.setStreaming(true);
    turnUi = { agent, reasoning: null, tools: [], shownError: false };
    runSignal = abortController.signal;
    gatedExecute = async (name, args) => {
      if (aborted || abortController.signal.aborted) throw new Error("Agent run cancelled.");
      if (mode === "suggest") return { ok: false, error: "Suggest only mode did not run this action." };
      if (mode === "confirm") {
        const decision = await agent.approval(describeCall(name, args));
        if (decision !== "approved") return { ok: false, error: "Denied by user." };
      }
      return executeAgentTool(name, args);
    };

    try {
      await runAgent(text);
      agent.done();
    } catch (error) {
      if (!aborted && !turnUi?.shownError) {
        agent.error(error instanceof Error ? error.message : String(error));
      }
      agent.done();
    } finally {
      chat.setStreaming(false);
      turnUi = null;
      runSignal = null;
      gatedExecute = null;
      abortController = null;
    }
  }

  return {
    onSend: (text) => {
      run(text);
    },
    onStop: () => {
      aborted = true;
      abortController?.abort();
    },
    onMode: (next) => {
      mode = next;
    },
    onRegenerate: () => {
      if (lastText) run(lastText);
    },
    hydrate: () => hydrateChatHistory(chat),
  };
}

Promise.all([loadAgentSettings()])
  .then(async ([settings]) => {
    let baseUrl = settings.baseUrl || AGENT_CONFIG.baseUrl;
    if (/agentrouter\.org/i.test(baseUrl)) {
      baseUrl = AGENT_CONFIG.baseUrl;
      await saveAgentSettings({ baseUrl });
    }
    if (settings.apiKey && els.apiKey) els.apiKey.value = settings.apiKey;
    if (settings.model && els.model) els.model.value = settings.model;
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
