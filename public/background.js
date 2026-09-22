const extensionMessage = (message) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });

const SUBMISSION_HISTORY_KEY = "visualGuardSubmissionHistory";
const SUBMISSION_TTL_MS = 30 * 60 * 1000;

function submissionFingerprint(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${normalized.length}:${(hash >>> 0).toString(16)}`;
}

async function claimSubmission(tabId, value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("The composer is empty; nothing can be submitted.");

  const now = Date.now();
  const fingerprint = submissionFingerprint(text);
  const stored = await chrome.storage.session.get(SUBMISSION_HISTORY_KEY);
  const history = Array.isArray(stored?.[SUBMISSION_HISTORY_KEY])
    ? stored[SUBMISSION_HISTORY_KEY].filter((item) => now - item.at < SUBMISSION_TTL_MS)
    : [];

  if (history.some((item) => item.tabId === tabId && item.fingerprint === fingerprint)) {
    return {
      ok: false,
      duplicate: true,
      error: "Duplicate submission blocked: this exact message was already submitted recently.",
    };
  }

  history.push({ tabId, fingerprint, at: now });
  await chrome.storage.session.set({
    [SUBMISSION_HISTORY_KEY]: history.slice(-50),
  });
  return { ok: true, fingerprint };
}

const BOOKMARK_RESULT_LIMIT = 80;

function flattenBookmarks(nodes, folderPath = []) {
  const items = [];
  for (const node of nodes || []) {
    const title = typeof node.title === "string" ? node.title : "";
    if (typeof node.url === "string" && node.url) {
      items.push({
        title,
        url: node.url,
        folder: folderPath.filter(Boolean).join(" / "),
      });
    }
    if (Array.isArray(node.children) && node.children.length) {
      const nextPath = title ? [...folderPath, title] : folderPath;
      items.push(...flattenBookmarks(node.children, nextPath));
    }
  }
  return items;
}

function bookmarkMatches(item, query) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return true;
  const haystack = `${item.title}\n${item.url}\n${item.folder}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

async function listBookmarks(query) {
  if (!chrome.bookmarks?.getTree) {
    throw new Error("Bookmarks permission is missing. Reload the extension from chrome://extensions.");
  }
  const tree = await chrome.bookmarks.getTree();
  const matched = flattenBookmarks(tree).filter((item) => bookmarkMatches(item, query));
  return {
    ok: true,
    query: String(query || "").trim() || null,
    total: matched.length,
    truncated: matched.length > BOOKMARK_RESULT_LIMIT,
    bookmarks: matched.slice(0, BOOKMARK_RESULT_LIMIT).map((item) => ({
      title: item.title,
      url: item.url,
      folder: item.folder,
      openable: /^https?:\/\//i.test(item.url),
    })),
  };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] ?? null;
}

async function getTab(tabId) {
  if (tabId == null) return getActiveTab();
  const id = Number(tabId);
  if (!Number.isInteger(id)) throw new Error("A valid integer tab_id is required.");
  try {
    return await chrome.tabs.get(id);
  } catch {
    throw new Error(`Tab ${id} is no longer available.`);
  }
}

function parseFrameRef(selectorRef) {
  const raw = String(selectorRef || "");
  const match = /^f(\d+)_(ref_\d+)$/.exec(raw);
  if (!match) return { frameId: 0, localRef: raw };
  return { frameId: Number(match[1]), localRef: match[2] };
}

async function listFrameIds(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => true,
    });
    return results.map((item) => item.frameId).filter((id) => Number.isFinite(id));
  } catch {
    return [0];
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" }, { frameId: 0 });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["content.js"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/chrome-extension:\/\//i.test(message)) throw error;
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
    }
  }
}

async function sendToFrame(tabId, frameId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId });
}

async function sendToContent(tabId, message) {
  await ensureContentScript(tabId);
  return sendToFrame(tabId, 0, message);
}

function debuggerCall(method, ...args) {
  return new Promise((resolve, reject) => {
    chrome.debugger[method](...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function dispatchTrustedKey(tabId, key) {
  const target = { tabId };
  const keys = {
    Enter: { code: "Enter", keyCode: 13, text: "\r" },
    Escape: { code: "Escape", keyCode: 27, text: "" },
    Tab: { code: "Tab", keyCode: 9, text: "\t" },
  };
  const spec = keys[key];
  if (!spec) throw new Error(`Unsupported key: ${key}`);

  await debuggerCall("attach", target, "1.3");
  try {
    await debuggerCall("sendCommand", target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      text: spec.text,
      unmodifiedText: spec.text,
    });
    await debuggerCall("sendCommand", target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    });
  } finally {
    await debuggerCall("detach", target).catch(() => {});
  }

  return { ok: true, action: "press_key", key, trusted: true };
}

async function activateTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
}

async function dispatchTrustedText(tabId, text) {
  const target = { tabId };
  await debuggerCall("attach", target, "1.3");
  try {
    const selectAll = {
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 4,
    };
    await debuggerCall("sendCommand", target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...selectAll,
    });
    await debuggerCall("sendCommand", target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      ...selectAll,
    });
    await debuggerCall("sendCommand", target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await debuggerCall("sendCommand", target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await debuggerCall("sendCommand", target, "Input.insertText", { text: String(text ?? "") });
  } finally {
    await debuggerCall("detach", target).catch(() => {});
  }
  return { ok: true, action: "type", trusted: true };
}

async function gatherPageState(tabId) {
  await ensureContentScript(tabId);
  const frameIds = await listFrameIds(tabId);
  const states = [];

  for (const frameId of frameIds) {
    try {
      const response = await sendToFrame(tabId, frameId, { type: "GET_PAGE_STATE" });
      if (!response?.ok || !response.result) continue;
      const result = response.result;
      const prefix = `f${frameId}_`;
      states.push({
        ...result,
        frameId,
        elements: (result.elements || []).map((el) => ({
          ...el,
          ref: `${prefix}${el.ref}`,
        })),
      });
    } catch {
      // Restricted frames (chrome-error, cross-extension, etc.)
    }
  }

  if (!states.length) {
    const fallback = await sendToFrame(tabId, 0, { type: "GET_PAGE_STATE" });
    return fallback;
  }

  states.sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId));
  const top = states.find((item) => item.frameId === 0) || states[0];
  const elements = states.flatMap((item) => item.elements || []);
  const textForLocalModel = states
    .map((item) => item.textForLocalModel || "")
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 10000);

  return {
    ok: true,
    result: {
      url: top.url,
      title: top.title,
      elements,
      textForLocalModel,
      frames: states.length,
      viewport: top.viewport || null,
      capturedAt: new Date().toISOString(),
    },
  };
}

async function captureTab(tab) {
  if (!tab?.windowId) {
    throw new Error("There is no active browser tab to capture.");
  }
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
}

function serializeTab(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    title: tab.title ?? "Untitled tab",
    url: tab.url ?? "",
    favIconUrl: tab.favIconUrl ?? "",
  };
}

async function uploadImageToTab(tab, tool) {
  const dataUrl = String(tool.data_url || "");
  if (!dataUrl.startsWith("data:image/")) throw new Error("No image is available to upload.");
  await activateTab(tab);
  await ensureContentScript(tab.id);

  const payload = {
    type: "UPLOAD_IMAGE",
    dataUrl,
    filename: "screenshot.jpg",
  };

  if (tool.selector_ref) {
    const { frameId, localRef } = parseFrameRef(tool.selector_ref);
    payload.selectorRef = localRef;
    const response = await sendToFrame(tab.id, frameId, payload);
    if (!response?.ok) throw new Error(response?.error || "Unable to upload the image.");
    return response;
  }

  const frameIds = await listFrameIds(tab.id);
  let lastError = "No image file input is on this page.";
  for (const frameId of frameIds) {
    try {
      const response = await sendToFrame(tab.id, frameId, payload);
      if (response?.ok) return response;
      lastError = response?.error || lastError;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
}

async function executeTool(tool, tab) {
  if (!tool?.name) throw new Error("A tool name is required.");

  switch (tool.name) {
    case "get_page_state":
      return gatherPageState(tab.id);
    case "press_key": {
      await activateTab(tab);
      await ensureContentScript(tab.id);
      const { frameId, localRef } = parseFrameRef(tool.selector_ref);
      const focused = await sendToFrame(tab.id, frameId, { type: "FOCUS", selectorRef: localRef });
      if (!focused?.ok) throw new Error(focused?.error || "Unable to focus the target element.");
      if (tool.key === "Enter" && focused.result?.value) {
        const claim = await claimSubmission(tab.id, focused.result.value);
        if (!claim.ok) return claim;
      }
      const pressed = await sendToFrame(tab.id, frameId, {
        type: "PRESS_KEY",
        selectorRef: localRef,
        key: tool.key,
      });
      if (pressed?.ok) return pressed;
      try {
        return { ok: true, result: await dispatchTrustedKey(tab.id, tool.key) };
      } catch (error) {
        throw new Error(pressed?.error || (error instanceof Error ? error.message : String(error)));
      }
    }
    case "type": {
      await activateTab(tab);
      await ensureContentScript(tab.id);
      const { frameId, localRef } = parseFrameRef(tool.selector_ref);
      const typed = await sendToFrame(tab.id, frameId, {
        type: "TYPE",
        selectorRef: localRef,
        text: String(tool.text ?? ""),
      });
      if (typed?.ok) return typed;
      const reason = typed?.error || "Unable to type into the target element.";
      if (/blocked|no longer on the page|not editable/i.test(reason)) throw new Error(reason);
      try {
        const focused = await sendToFrame(tab.id, frameId, { type: "FOCUS", selectorRef: localRef });
        if (!focused?.ok) throw new Error(focused?.error || reason);
        await dispatchTrustedText(tab.id, tool.text);
        return { ok: true, result: { action: "type", text: String(tool.text ?? ""), trusted: true } };
      } catch (error) {
        throw new Error(reason || (error instanceof Error ? error.message : String(error)));
      }
    }
    case "submit": {
      await activateTab(tab);
      await ensureContentScript(tab.id);
      const { frameId, localRef } = parseFrameRef(tool.selector_ref);
      const focused = await sendToFrame(tab.id, frameId, { type: "FOCUS", selectorRef: localRef });
      if (!focused?.ok) throw new Error(focused?.error || "Unable to read the target composer.");
      const claim = await claimSubmission(tab.id, focused.result?.value);
      if (!claim.ok) return claim;
      return sendToFrame(tab.id, frameId, { type: "SUBMIT", selectorRef: localRef });
    }
    case "read_element":
    case "click": {
      await ensureContentScript(tab.id);
      const tabsBefore =
        tool.name === "click" ? new Set((await chrome.tabs.query({})).map((item) => item.id)) : null;
      const { frameId, localRef } = parseFrameRef(tool.selector_ref);
      const message =
        tool.name === "read_element"
          ? { type: "READ_ELEMENT", selectorRef: localRef }
          : { type: "CLICK", selectorRef: localRef };
      try {
        const response = await sendToFrame(tab.id, frameId, message);
        if (response?.ok && response.result?.ref) {
          response.result.ref = tool.selector_ref || response.result.ref;
        }
        if (tool.name === "click") {
          await new Promise((resolve) => setTimeout(resolve, 350));
          const openedTabs = (await chrome.tabs.query({}))
            .filter((item) => !tabsBefore.has(item.id))
            .map((item) => serializeTab(item));
          if (openedTabs.length && response) response.openedTabs = openedTabs;
        }
        return response;
      } catch (error) {
        // Legacy refs without frame prefix — try top frame.
        if (frameId !== 0) throw error;
        const response = await sendToFrame(tab.id, 0, message);
        if (tool.name === "click") {
          await new Promise((resolve) => setTimeout(resolve, 350));
          const openedTabs = (await chrome.tabs.query({}))
            .filter((item) => !tabsBefore.has(item.id))
            .map((item) => serializeTab(item));
          if (openedTabs.length && response) response.openedTabs = openedTabs;
        }
        return response;
      }
    }
    case "scroll": {
      await ensureContentScript(tab.id);
      // Prefer the top frame; if that barely moves, also nudge child frames.
      const primary = await sendToFrame(tab.id, 0, {
        type: "SCROLL",
        direction: tool.direction === "up" ? "up" : "down",
        amountPx: Number(tool.amount_px) || 320,
      });
      const frameIds = await listFrameIds(tab.id);
      for (const frameId of frameIds) {
        if (frameId === 0) continue;
        try {
          await sendToFrame(tab.id, frameId, {
            type: "SCROLL",
            direction: tool.direction === "up" ? "up" : "down",
            amountPx: Number(tool.amount_px) || 320,
          });
        } catch {
          // ignore locked frames
        }
      }
      return primary;
    }
    case "navigate": {
      const url = new URL(tool.url);
      if (!/^https?:$/.test(url.protocol)) {
        throw new Error("Navigate only accepts http(s) URLs.");
      }
      await chrome.tabs.update(tab.id, { url: url.href });
      return { ok: true, action: "navigate", url: url.href };
    }
    case "screenshot":
      return { ok: true, action: "screenshot", dataUrl: await captureTab(tab) };
    case "upload_image":
      return uploadImageToTab(tab, tool);
    default:
      throw new Error(`Unknown tool: ${tool.name}`);
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch {
    // The panel may already be open for this tab.
  }
  try {
    await chrome.runtime.sendMessage({ type: "lg:activate", tabId: tab.id });
  } catch {
    // The panel script registers its listener after it loads.
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((error) => console.warn("Unable to configure side panel", error));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((error) => console.warn("Unable to configure side panel", error));
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch((error) => console.warn("Unable to configure side panel", error));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "GET_ACTIVE_TAB") {
        sendResponse({ ok: true, tab: serializeTab(await getActiveTab()) });
        return;
      }

      if (message.type === "GET_BOOKMARKS") {
        sendResponse(await listBookmarks(message.query));
        return;
      }

      if (message.type === "GET_TABS") {
        const tabs = await chrome.tabs.query({});
        sendResponse({
          ok: true,
          tabs: tabs
            .filter((tab) => tab.id && /^https?:/i.test(tab.url || ""))
            .map((tab) => ({ ...serializeTab(tab), active: Boolean(tab.active), windowId: tab.windowId })),
        });
        return;
      }

      if (message.type === "AGENT_CHAT") {
        const { body, apiKey, baseUrl } = message;
        if (!apiKey) throw new Error("Missing AgentRouter API key.");
        const endpoint = `${String(baseUrl || "http://127.0.0.1:8787/v1").replace(/\/$/, "")}/chat/completions`;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": "QwenCode/0.2.0 (linux x64)",
          },
          body: JSON.stringify(body ?? {}),
        });
        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          sendResponse({
            ok: false,
            status: response.status,
            error:
              `Upstream returned non-JSON (${response.status}). ` +
              `If this is agentrouter.org HTML/405, Chrome is WAF-blocked — use bun run agent-proxy and base URL http://127.0.0.1:8787/v1. ` +
              text.slice(0, 120),
          });
          return;
        }
        if (!response.ok) {
          sendResponse({
            ok: false,
            status: response.status,
            error: data?.error?.message || data?.message || `HTTP ${response.status}`,
            data,
          });
          return;
        }
        sendResponse({ ok: true, data });
        return;
      }

      if (message.type === "PROXY_HEALTH") {
        const url = message.url || "http://127.0.0.1:8787/health";
        try {
          const response = await fetch(url, { method: "GET" });
          const text = await response.text();
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = { raw: text.slice(0, 200) };
          }
          if (!response.ok) {
            sendResponse({ ok: false, status: response.status, error: data?.error?.message || `HTTP ${response.status}`, data });
            return;
          }
          sendResponse({ ok: true, data });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      const tab = await getTab(message.tabId ?? message.tool?.tab_id);
      if (!tab?.id) throw new Error("No active tab is available.");

      if (message.type === "CAPTURE_VISIBLE_TAB") {
        sendResponse({ ok: true, dataUrl: await captureTab(tab), tab: serializeTab(tab) });
        return;
      }

      if (message.type === "SCAN_PAGE") {
        sendResponse({ ok: true, result: await gatherPageState(tab.id) });
        return;
      }

      if (message.type === "APPLY_TEXT_REDACTION") {
        sendResponse(
          await sendToContent(tab.id, {
            type: "APPLY_TEXT_REDACTION",
            redacted: Array.isArray(message.redacted) ? message.redacted : [],
          }),
        );
        return;
      }

      if (message.type === "EXECUTE_TOOL") {
        const tool = { ...message.tool };
        delete tool.tab_id;
        sendResponse({ ok: true, result: await executeTool(tool, tab) });
        return;
      }

      sendResponse({ ok: false, error: `Unknown message: ${message.type}` });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();

  return true;
});
