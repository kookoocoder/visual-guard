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

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  }
}

async function sendToContent(tabId, message) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
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
      return sendToContent(tab.id, { type: "GET_PAGE_STATE" });
    case "read_element":
      return sendToContent(tab.id, {
        type: "READ_ELEMENT",
        selectorRef: tool.selector_ref,
      });
    case "click":
      return sendToContent(tab.id, {
        type: "CLICK",
        selectorRef: tool.selector_ref,
      });
    case "type":
      return sendToContent(tab.id, {
        type: "TYPE",
        selectorRef: tool.selector_ref,
        text: tool.text ?? "Local test",
      });
    case "scroll":
      return sendToContent(tab.id, {
        type: "SCROLL",
        direction: tool.direction === "up" ? "up" : "down",
        amountPx: Number(tool.amount_px) || 320,
      });
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

      const tab = await getActiveTab();
      if (!tab?.id) throw new Error("No active tab is available.");

      if (message.type === "CAPTURE_VISIBLE_TAB") {
        sendResponse({ ok: true, dataUrl: await captureTab(tab), tab: serializeTab(tab) });
        return;
      }

      if (message.type === "SCAN_PAGE") {
        sendResponse({ ok: true, result: await sendToContent(tab.id, { type: "GET_PAGE_STATE" }) });
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
