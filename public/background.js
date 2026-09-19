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

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] ?? null;
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
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
  }
}

async function sendToFrame(tabId, frameId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId });
}

async function sendToContent(tabId, message) {
  await ensureContentScript(tabId);
  return sendToFrame(tabId, 0, message);
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

async function executeTool(tool, tab) {
  if (!tool?.name) throw new Error("A tool name is required.");

  switch (tool.name) {
    case "get_page_state":
      return gatherPageState(tab.id);
    case "read_element":
    case "click":
    case "type": {
      await ensureContentScript(tab.id);
      const { frameId, localRef } = parseFrameRef(tool.selector_ref);
      const message =
        tool.name === "read_element"
          ? { type: "READ_ELEMENT", selectorRef: localRef }
          : tool.name === "click"
            ? { type: "CLICK", selectorRef: localRef }
            : { type: "TYPE", selectorRef: localRef, text: tool.text ?? "Local test" };
      try {
        const response = await sendToFrame(tab.id, frameId, message);
        if (response?.ok && response.result?.ref) {
          response.result.ref = tool.selector_ref || response.result.ref;
        }
        return response;
      } catch (error) {
        // Legacy refs without frame prefix — try top frame.
        if (frameId !== 0) throw error;
        return sendToFrame(tab.id, 0, message);
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
    default:
      throw new Error(`Unknown tool: ${tool.name}`);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.warn("Unable to configure side panel", error));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.warn("Unable to configure side panel", error));
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.warn("Unable to configure side panel", error));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "GET_ACTIVE_TAB") {
        sendResponse({ ok: true, tab: serializeTab(await getActiveTab()) });
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

      const tab = await getActiveTab();
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
        sendResponse({ ok: true, result: await executeTool(message.tool, tab) });
        return;
      }

      sendResponse({ ok: false, error: `Unknown message: ${message.type}` });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();

  return true;
});
