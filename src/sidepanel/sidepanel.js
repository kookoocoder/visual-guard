import { loadHaS, runHaS, modelBackend } from "../models/has.js";
import { loadNER, redactText, nerBackend } from "../models/ner.js";

const logEl = document.getElementById("log");
const statusDot = document.getElementById("status-dot");
const previewImg = document.getElementById("preview-img");

const modelDots = {
  has: document.getElementById("has-dot"),
  ner: document.getElementById("ner-dot"),
};
const modelDetails = {
  has: document.getElementById("has-detail"),
  ner: document.getElementById("ner-detail"),
};

function ts() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function log(line, kind = "") {
  const div = document.createElement("div");
  div.className = "log-line " + kind;
  const span = document.createElement("span");
  span.className = "ts";
  span.textContent = ts();
  div.appendChild(span);
  div.appendChild(document.createTextNode(line));
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function logJson(label, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  log(`${label}\n${text}`);
}

function setDot(el, state) {
  if (!el) return;
  el.classList.remove("ready", "busy", "error");
  if (state === "ready") el.classList.add("ready");
  else if (state === "loading" || state === "busy") el.classList.add("busy");
  else if (state === "error") el.classList.add("error");
}

function setDetail(key, text) {
  const el = modelDetails[key];
  if (el) el.textContent = text || "";
}

function msg(payload) {
  return chrome.runtime.sendMessage(payload);
}

function showPreview(objectUrl) {
  previewImg.src = objectUrl;
}

function promptArg(label, def) {
  const value = prompt(label, def);
  return value == null ? null : value;
}

async function captureBitmap() {
  const cap = await msg({ type: "CAPTURE" });
  if (!cap || !cap.ok) throw new Error((cap && cap.error) || "capture failed");
  const res = await fetch(cap.dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

async function drawRedacted(bitmap, results) {
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);

  const boxes = results && results.boxes ? results.boxes : null;
  const scale = results && results.scale ? results.scale : w / 640;
  const padX = (results && results.padX) || 0;
  const padY = (results && results.padY) || 0;

  if (boxes && boxes.length) {
    for (const box of boxes) {
      const x1 = Math.max(0, (box.x1 - padX) / scale);
      const y1 = Math.max(0, (box.y1 - padY) / scale);
      const x2 = Math.min(w, (box.x2 - padX) / scale);
      const y2 = Math.min(h, (box.y2 - padY) / scale);
      ctx.fillStyle = "#000";
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    }
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const url = URL.createObjectURL(blob);
  return { width: w, height: h, found: boxes ? boxes.length : 0, objectUrl: url };
}

async function testModel(kind) {
  setDot(modelDots[kind], "busy");
  setDetail(kind, "loading model…");
  log(`Testing ${kind === "has" ? "HaS" : "NER"}…`);
  try {
    let r;
    if (kind === "has") {
      await loadHaS();
      const bitmap = await captureBitmap();
      const results = await runHaS(bitmap);
      const out = await drawRedacted(bitmap, results);
      bitmap.close();
      r = { ok: true, found: out.found, width: out.width, height: out.height, objectUrl: out.objectUrl, backend: modelBackend() };
    } else {
      await loadNER();
      const g = await msg({ type: "GATHER_TEXT" });
      const text = (g && g.text) || "";
      const { output, count, mode } = await redactText(text);
      const sample = output.slice(0, 400) + (output.length > 400 ? "…" : "");
      r = { ok: true, count, output: sample, backend: nerBackend(), mode: mode || "", originalLen: text.length };
    }
    const ok = Boolean(r.ok);
    setDot(modelDots[kind], ok ? "ready" : "error");
    setDetail(kind, ok ? (r.backend ? `ready via ${r.backend}` : "ready") : (r && r.error) || "failed");
    if (ok) {
      if (kind === "has") {
        log(`HaS OK: found ${r.found} regions, ${r.width}x${r.height}`);
        if (r.objectUrl) showPreview(r.objectUrl);
      } else {
        log(`NER OK: ${r.count} sensitive span(s) redacted (input ${r.originalLen} chars, ${r.mode})`);
        if (r.output) logJson("redacted sample", r.output);
      }
    }
  } catch (e) {
    const err = String(e && e.message ? e.message : e);
    setDot(modelDots[kind], "error");
    setDetail(kind, err);
    log(`Failed: ${err}`, "err");
  }
}

async function runTool(name) {
  log(`Tool: ${name}`);
  let args = {};
  if (name === "read_element" || name === "click") {
    const ref = promptArg("Element ref (from get_page_state):");
    if (ref == null) return;
    args.ref = ref;
  } else if (name === "type") {
    const ref = promptArg("Element ref (from get_page_state):");
    if (ref == null) return;
    const text = promptArg("Text to type:");
    if (text == null) return;
    args.ref = ref;
    args.text = text;
  } else if (name === "navigate") {
    const url = promptArg("URL:");
    if (url == null) return;
    args.url = url;
  } else if (name === "scroll") {
    args.direction = "down";
  }

  if (name === "screenshot") {
    try {
      await loadHaS();
      const bitmap = await captureBitmap();
      const results = await runHaS(bitmap);
      const out = await drawRedacted(bitmap, results);
      bitmap.close();
      log(`screenshot OK: ${out.width}x${out.height}, ${out.found} region(s) masked (${modelBackend()})`);
      if (out.objectUrl) showPreview(out.objectUrl);
      else logJson("result", out);
    } catch (e) {
      const err = String(e && e.message ? e.message : e);
      log(`Failed: ${err}`, "err");
      logJson("screenshot error", err);
    }
    return;
  }

  const r = await msg({ type: "RUN_TOOL", tool: name, args });
  logJson(name + " result", r);
  if (!r || !r.ok) logJson(name + " error", r && r.error);
}

document.getElementById("test-has").addEventListener("click", () => testModel("has"));
document.getElementById("test-ner").addEventListener("click", () => testModel("ner"));

document.querySelectorAll("[data-tool]").forEach((btn) => {
  btn.addEventListener("click", () => runTool(btn.dataset.tool));
});

document.getElementById("run").addEventListener("click", () => {
  const task = document.getElementById("task").value.trim();
  if (!task) return;
  log(`Run requested (server not connected): "${task}"`);
});

chrome.runtime.onMessage.addListener((m) => {
  if (!m || !m.type) return;
});

log("Side panel ready.");
setDot(statusDot, "ready");