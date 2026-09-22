import { createRunner } from "./agent-backend.js";

const STORE_KEY = "lg-settings";
const VIEW_KEY = "lg-view";
const BLOCKED = /^(chrome|edge|brave|about|devtools|chrome-extension|extension|view-source):/i;

const stage = document.getElementById("stage");
const feed = document.getElementById("feed");
const host = document.querySelector("main.lg");
const stateEl = document.getElementById("state");
const dot = document.getElementById("dot");
const sourceEl = document.getElementById("source");
const opticsEl = document.getElementById("optics");
const noteEl = document.getElementById("note");
const toggle = document.getElementById("toggle");

const settings = {
  refraction: 250,
  blur: 2,
  tint: 0.55,
  fringe: 0,
  dim: 0,
};

const sliders = new Map();

let engine = null;
let stream = null;
let capturedTabId = null;
let viewport = null;
let acquiring = false;
let pendingTabId = undefined;
let saveTimer = 0;
let followTimer = 0;
let grabbing = false;
let grabQueued = null;
let frameToken = 0;
let thisWindowId = null;
let paused = false;
let acquireGen = 0;

const still = document.createElement("img");
still.id = "still";
still.alt = "";
still.hidden = true;
stage.prepend(still);

function tintBase() {
  return document.documentElement.classList.contains("lg-light")
    ? "248, 248, 250"
    : "34, 34, 38";
}

function applyTint() {
  document.documentElement.style.setProperty(
    "--lg-tint",
    "rgba(" + tintBase() + ", " + settings.tint + ")"
  );
  document.documentElement.style.setProperty("--veil", settings.dim);
}

function setState(kind, text) {
  stateEl.textContent = text;
  stateEl.className = "lg-pill " + (kind === "live" ? "live" : kind ? "bad" : "");
  dot.className = "lg-dot " + (kind === "live" ? "lg-dot--ok" : "lg-dot--warn");
}

function applyOptics() {
  if (!engine) return;
  engine.update({
    ratio: settings.refraction / 100,
    blur: settings.blur,
    chroma: settings.fringe,
  });
  const base = engine.supported
    ? settings.refraction > 0
      ? "refraction + lit bezel"
      : "blur only"
    : "blur only (not Chromium)";
  opticsEl.textContent =
    crop && crop.fraction < 0.995
      ? base + " · crop " + Math.round(crop.fraction * 100) + "%"
      : base;
  opticsEl.title = crop
    ? "crop " + crop.fraction.toFixed(3) + " via " + crop.source + " · frame " + streamW + "x" + streamH
    : "";
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [STORE_KEY]: settings }).catch(() => {});
  }, 180);
}

function commit(key, value) {
  settings[key] = value;
  if (key === "tint" || key === "dim") applyTint();
  else applyOptics();
  persist();
}

function shortUrl(url) {
  if (!url) return "current tab";
  try {
    const parsed = new URL(url);
    return parsed.hostname + (parsed.pathname === "/" ? "" : parsed.pathname.slice(0, 24));
  } catch {
    return url.slice(0, 32);
  }
}

let track = null;
let streamW = 0;
let streamH = 0;
let crop = null;
let layoutTimer = 0;

function layout() {
  const vw = streamW || feed.videoWidth;
  const vh = streamH || feed.videoHeight;
  const box = stage.getBoundingClientRect();
  if (!vw || !vh || !box.width || !box.height) return;

  const measured = window.LiquidGlassCover.measureBand(feed);
  const picked = window.LiquidGlassCover.chooseFraction(vw, vh, viewport, measured);
  const framed = window.LiquidGlassCover.coverBox(vw, vh, box.width, box.height, picked.fraction);

  feed.style.objectFit = "fill";
  feed.style.width = framed.width + "px";
  feed.style.height = framed.height + "px";
  feed.style.left = framed.left + "px";
  feed.style.top = framed.top + "px";

  crop = picked;
  if (engine) applyOptics();
}

function startLayoutPoll() {
  stopLayoutPoll();
  layoutTimer = setInterval(layout, 1400);
}

function stopLayoutPoll() {
  if (layoutTimer) {
    clearInterval(layoutTimer);
    layoutTimer = 0;
  }
}

function mountViews() {
  const tabs = [...document.querySelectorAll(".seg__item")];
  const panels = [...document.querySelectorAll(".view[data-view-panel]")];

  function show(name) {
    tabs.forEach((tab) => {
      const on = tab.dataset.view === name;
      tab.classList.toggle("is-on", on);
      tab.setAttribute("aria-selected", String(on));
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== name;
    });
    chrome.storage.local.set({ [VIEW_KEY]: name }).catch(() => {});
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => show(tab.dataset.view));
  });

  return show;
}

function makeRunner(chat) {
  return createRunner(chat);
}

function mountChat() {
  const root = document.querySelector('.view[data-view-panel="chat"]');
  if (!root || !window.LiquidGlassChat) return null;
  const chat = window.LiquidGlassChat.mount(root, { seed: [] });
  const runner = makeRunner(chat);
  chat.setHooks(runner);
  return chat;
}

function stopCapture() {
  paused = true;
  if (followTimer) {
    clearInterval(followTimer);
    followTimer = 0;
  }
  stopLive();
  still.hidden = true;
  still.removeAttribute("src");
  toggle.querySelector("span").textContent = "Capture";
  setState("idle", "idle");
  sourceEl.textContent = "not capturing";
}

async function readViewport(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio,
      }),
    });
    return result || null;
  } catch {
    return null;
  }
}

async function windowId() {
  if (thisWindowId != null) return thisWindowId;
  const win = await chrome.windows.getCurrent();
  thisWindowId = win.id;
  return thisWindowId;
}

async function paintOnce(tabId) {
  const token = ++frameToken;
  let tab = null;
  if (tabId != null) tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    const wid = await windowId();
    const [active] = await chrome.tabs.query({ active: true, windowId: wid });
    tab = active || null;
  }
  if (!tab || BLOCKED.test(tab.url || "")) return;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 });
  if (token !== frameToken || !dataUrl) return;
  still.src = dataUrl;
  still.hidden = false;
  if (!stream) {
    feed.classList.add("is-off");
    setState("live", "live");
    sourceEl.textContent = shortUrl(tab.url);
    sourceEl.title = tab.title || tab.url || "";
  }
}

async function paintActive(tabId) {
  grabQueued = tabId ?? true;
  if (grabbing) return;
  grabbing = true;
  try {
    while (grabQueued != null) {
      const requested = grabQueued;
      grabQueued = null;
      try {
        await paintOnce(requested === true ? null : requested);
      } catch {
        // Chrome allows two visible-tab captures per second. Keep the last frame.
      }
    }
  } finally {
    grabbing = false;
  }
}

function startFollow() {
  if (followTimer) return;
  followTimer = setInterval(() => {
    if (paused || (stream && capturedTabId != null)) return;
    paintActive();
  }, 800);
}

function stopLive() {
  acquireGen += 1;
  stopLayoutPoll();
  if (stream) {
    stream.getTracks().forEach((existing) => existing.stop());
    stream = null;
  }
  feed.srcObject = null;
  feed.classList.add("is-off");
  capturedTabId = null;
  viewport = null;
  track = null;
  streamW = 0;
  streamH = 0;
  crop = null;
}

async function followTab(tabId) {
  if (paused) return;
  if (stream && tabId != null && tabId !== capturedTabId) stopLive();
  startFollow();
  await paintActive(tabId);
  acquire(tabId);
}

async function acquire(explicitTabId) {
  pendingTabId = explicitTabId ?? null;
  if (acquiring) return;
  acquiring = true;
  try {
    while (pendingTabId !== undefined) {
      const requested = pendingTabId;
      pendingTabId = undefined;
      await acquireOnce(requested);
    }
  } finally {
    acquiring = false;
  }
}

async function acquireOnce(explicitTabId) {
  const gen = acquireGen;
  try {
    let tab;
    if (explicitTabId != null) {
      tab = await chrome.tabs.get(explicitTabId).catch(() => null);
    } else {
      const wid = await windowId();
      const [active] = await chrome.tabs.query({ active: true, windowId: wid });
      tab = active || null;
    }
    if (gen !== acquireGen) return;
    if (!tab || tab.id == null) {
      if (still.hidden) setState("blocked", "no tab");
      return;
    }
    if (capturedTabId === tab.id && stream) return;

    if (BLOCKED.test(tab.url || "")) {
      setState("blocked", "browser page");
      sourceEl.textContent = shortUrl(tab.url);
      noteEl.textContent =
        "Chrome will not hand over pixels for browser-internal pages. Switch to a normal site.";
      return;
    }

    if (still.hidden) setState("connecting");
    viewport = await readViewport(tab.id);

    const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    if (gen !== acquireGen) return;

    const base = {
      chromeMediaSource: "tab",
      chromeMediaSourceId: id,
      maxFrameRate: 60,
    };

    let next = null;
    if (viewport && viewport.w && viewport.h && viewport.dpr) {
      const w = Math.max(2, Math.round(viewport.w * viewport.dpr));
      const h = Math.max(2, Math.round(viewport.h * viewport.dpr));
      next = await navigator.mediaDevices
        .getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: base.chromeMediaSource,
              chromeMediaSourceId: base.chromeMediaSourceId,
              maxFrameRate: base.maxFrameRate,
              minWidth: w,
              maxWidth: w,
              minHeight: h,
              maxHeight: h,
            },
          },
        })
        .catch(() => null);
    }

    if (!next) {
      next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: base },
      });
    }
    if (gen !== acquireGen) {
      next.getTracks().forEach((existing) => existing.stop());
      return;
    }

    if (stream) stream.getTracks().forEach((existing) => existing.stop());
    stream = next;
    capturedTabId = tab.id;
    feed.srcObject = stream;
    feed.classList.remove("is-off");
    await feed.play().catch(() => {});

    track = stream.getVideoTracks()[0] || null;
    if (track) {
      const trackSettings = track.getSettings();
      streamW = trackSettings.width || 0;
      streamH = trackSettings.height || 0;
    }

    layout();
    startLayoutPoll();

    toggle.querySelector("span").textContent = "Stop";
    setState("live", "live");
    sourceEl.textContent = shortUrl(tab.url);
    sourceEl.title = tab.title || tab.url || "";
    noteEl.textContent =
      "Live capture of the tab. The glass refracts it at the rim and the interior stays clean.";
  } catch (error) {
    if (!still.hidden && still.getAttribute("src")) {
      setState("live", "live");
      return;
    }
    setState("blocked", "needs a click");
    noteEl.textContent =
      "Chrome only allows capture right after the extension is invoked on a tab. Click the toolbar icon, then it follows from there. (" +
      String(error).slice(0, 70) +
      ")";
  }
}

function syncStreamSize() {
  if (track) {
    const trackSettings = track.getSettings();
    if (trackSettings.width) streamW = trackSettings.width;
    if (trackSettings.height) streamH = trackSettings.height;
  }
  if (!streamW) streamW = feed.videoWidth;
  if (!streamH) streamH = feed.videoHeight;
}

feed.addEventListener("loadedmetadata", () => {
  syncStreamSize();
  layout();
});
feed.addEventListener("resize", () => {
  syncStreamSize();
  layout();
});
window.addEventListener("resize", layout);

if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => layout()).observe(stage);
}

(async () => {
  const stored = await chrome.storage.local.get([STORE_KEY, VIEW_KEY]).catch(() => ({}));
  if (stored && stored[STORE_KEY]) Object.assign(settings, stored[STORE_KEY]);
  settings.dim = 0;
  if (settings.tint < 0.35) settings.tint = 0.55;

  const showView = mountViews();
  showView(stored && stored[VIEW_KEY] === "controls" ? "controls" : "chat");

  applyTint();
  engine = window.LiquidGlass.refract(host, {
    ratio: settings.refraction / 100,
    blur: settings.blur,
    saturate: 180,
    brightness: 1.06,
    contrast: 1.04,
    chroma: settings.fringe,
  });
  applyOptics();

  document.querySelectorAll(".lg-field").forEach((field) => {
    const key = field.dataset.key;
    const handle = window.LiquidGlassSlider.mount(field, (value) => commit(key, value));
    sliders.set(key, handle);
  });

  sliders.forEach((handle, key) => handle.set(settings[key], false));

  mountChat();
})();
