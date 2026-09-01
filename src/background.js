chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: payload.type, ...payload });
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function sendWithInject(tabId, payload) {
  let r = await sendToTab(tabId, payload);
  if (!r || !r.ok) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      r = await sendToTab(tabId, payload);
    } catch {
      /* keep first response on double failure */
    }
  }
  return r;
}

async function captureFrame(tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return dataUrl;
}

async function runTool(name, args) {
  const tab = await currentTab();
  if (!tab || tab.id == null) return { ok: false, error: "no active tab" };
  switch (name) {
    case "get_page_state":
      return await sendWithInject(tab.id, { type: "GET_PAGE_STATE" });
    case "read_element":
      return await sendWithInject(tab.id, { type: "READ_ELEMENT", ref: args.ref });
    case "click":
      return await sendWithInject(tab.id, { type: "CLICK", ref: args.ref });
    case "type":
      return await sendWithInject(tab.id, { type: "TYPE", ref: args.ref, text: args.text });
    case "scroll":
      return await sendWithInject(tab.id, {
        type: "SCROLL",
        direction: args.direction || "down",
        amountPx: args.amountPx || 600,
      });
    case "navigate":
      return await sendWithInject(tab.id, { type: "NAVIGATE", url: args.url });
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  (async () => {
    try {
      switch (msg.type) {
        case "CAPTURE": {
          const tab = await currentTab();
          if (!tab || tab.id == null) return sendResponse({ ok: false, error: "no active tab" });
          try {
            sendResponse({ ok: true, dataUrl: await captureFrame(tab) });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
          }
          break;
        }
        case "RUN_TOOL":
          sendResponse(await runTool(msg.tool, msg.args || {}));
          break;
        case "GATHER_TEXT": {
          const tab = await currentTab();
          if (!tab || tab.id == null) return sendResponse({ ok: false, error: "no active tab" });
          sendResponse(await sendWithInject(tab.id, { type: "FULL_TEXT" }));
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true;
});