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
  tint: 0.08,
  fringe: 0,
  dim: 0.4,
};

const SEED = [
  {
    role: "agent",
    text: "Panel is live. The glass is refracting the tab behind it — look for the kink where a straight edge crosses the rim.",
  },
  { role: "user", text: "why does the middle stay sharp?" },
  {
    role: "agent",
    text: "Because the displacement map is neutral inside the bezel.\n\nOnly the outer band gets ray-traced, so the interior passes through undistorted and text stays readable.",
  },
];

const sliders = new Map();

let engine = null;
let stream = null;
let capturedTabId = null;
let viewport = null;
let acquiring = false;
let saveTimer = 0;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SCRIPT = {
  reasoning:
    "The panel captures the tab through tabCapture, so the backdrop is live and the optics get real pixels to bend. Whether the bend sits at the rim or mid-bezel is the thing worth verifying before answering.",
  tool: {
    name: "read_optics",
    input: '{\n  "source": "tabCapture",\n  "band": "bezel"\n}',
    output: '{\n  "peak": "rim",\n  "peak_at": 0.031,\n  "interior": "neutral",\n  "non_neutral": "23.1%"\n}',
  },
  approval: {
    title: "Needs your approval",
    text: "Raise refraction to 320% and re-bake the displacement map for this panel size.",
    impact: "Touches 1 setting. Reversible from the Controls tab.",
  },
  answer:
    "The bend peaks at the rim and decays inward, so the interior passes through undistorted.\n\nThat is the whole difference between this and frosted glass: a uniform blur scatters everywhere, while the displacement map stays neutral except for the outer band. Straight edges crossing the rim kink; text in the middle stays readable.",
  citations: [
    { label: "kube.io — refraction with CSS and SVG", href: "https://kube.io/blog/liquid-glass-css-svg" },
    { label: "w3c/svgwg#1142 — backdrop displacement", href: "https://github.com/w3c/svgwg/issues/1142" },
  ],
};

function makeRunner(chat) {
  let aborted = false;
  let mode = "confirm";
  let lastText = "";

  async function write(emit, text, delay) {
    const words = text.match(/\S+\s*/g) || [];
    for (const word of words) {
      if (aborted) return false;
      emit(word);
      await sleep(delay);
    }
    return true;
  }

  function finish(agent, reasoning) {
    if (reasoning) reasoning.end();
    agent.done();
    chat.setStreaming(false);
  }

  async function run(text) {
    aborted = false;
    if (text) lastText = text;

    const agent = chat.beginAgent();
    chat.setStreaming(true);

    const reasoning = agent.reasoning("");
    const reasoned = await write((d) => reasoning.write(d), SCRIPT.reasoning, 11);
    if (!reasoned) return finish(agent, reasoning);
    reasoning.end();

    const tool = agent.tool(SCRIPT.tool);
    await sleep(760);
    if (aborted) return finish(agent, null);
    tool.result(SCRIPT.tool.output);

    if (mode === "confirm") {
      const answer = await agent.approval(SCRIPT.approval);
      if (answer === "denied") {
        agent.text("Stopped. Nothing was changed.");
        return finish(agent, null);
      }
    }

    const answered = await write((d) => agent.text(d), SCRIPT.answer, 15);
    if (!answered) return finish(agent, null);

    agent.citations(SCRIPT.citations);
    finish(agent, null);
  }

  return {
    onSend: (text) => {
      run(text);
    },
    onStop: () => {
      aborted = true;
    },
    onMode: (next) => {
      mode = next;
    },
    onRegenerate: () => {
      if (lastText) run(lastText);
    },
  };
}

function mountChat() {
  const root = document.querySelector('.view[data-view-panel="chat"]');
  if (!root || !window.LiquidGlassChat) return null;
  const chat = window.LiquidGlassChat.mount(root, { seed: SEED });
  const runner = makeRunner(chat);
  chat.setHooks(runner);
  return chat;
}

function stopCapture() {
  stopLayoutPoll();
  if (stream) {
    stream.getTracks().forEach((existing) => existing.stop());
    stream = null;
  }
  feed.srcObject = null;
  capturedTabId = null;
  viewport = null;
  track = null;
  streamW = 0;
  streamH = 0;
  crop = null;
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

async function acquire(explicitTabId) {
  if (acquiring) return;
  acquiring = true;
  try {
    let tab;
    if (explicitTabId != null) {
      tab = await chrome.tabs.get(explicitTabId).catch(() => null);
    } else {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tab = active || null;
    }
    if (!tab || tab.id == null) {
      setState("blocked", "no tab");
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

    setState("connecting");
    viewport = await readViewport(tab.id);

    const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

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

    if (stream) stream.getTracks().forEach((existing) => existing.stop());
    stream = next;
    capturedTabId = tab.id;
    feed.srcObject = stream;
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
    setState("blocked", "needs a click");
    noteEl.textContent =
      "Chrome only allows capture right after the extension is invoked on a tab. Click the toolbar icon, then it follows from there. (" +
      String(error).slice(0, 70) +
      ")";
  } finally {
    acquiring = false;
  }
}

toggle.addEventListener("click", () => {
  if (stream) stopCapture();
  else acquire();
});

document.getElementById("recapture").addEventListener("click", () => {
  stopCapture();
  acquire();
});

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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "lg:activate") acquire(message.tabId);
});

chrome.tabs.onActivated.addListener((info) => {
  if (stream && info.tabId !== capturedTabId) acquire(info.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === capturedTabId && info.status === "complete") {
    readViewport(tabId).then((next) => {
      viewport = next;
      layout();
    });
  }
});

(async () => {
  const stored = await chrome.storage.local.get([STORE_KEY, VIEW_KEY]).catch(() => ({}));
  if (stored && stored[STORE_KEY]) Object.assign(settings, stored[STORE_KEY]);

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
  acquire();
})();
