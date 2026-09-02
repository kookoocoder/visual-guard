import { pipeline, env } from "@huggingface/transformers";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";

env.allowLocalModels = true;
env.allowRemoteModels = false;

const inExtension = Boolean(globalThis.chrome?.runtime?.getURL);
if (inExtension) {
  env.localModelPath = "/models/";
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = {
      mjs: "/wasm/v126/ort-wasm-simd-threaded.asyncify.mjs",
      wasm: "/wasm/v126/ort-wasm-simd-threaded.asyncify.wasm",
    };
  }
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const base = root.split(sep).join("/");
  env.localModelPath = `${base}/public/models/`;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = {
      mjs: `${base}/public/wasm/v126/ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${base}/public/wasm/v126/ort-wasm-simd-threaded.asyncify.wasm`,
    };
  }
}

let classifier = null;
let loadedBackend = null;

export async function loadNER() {
  if (classifier) return classifier;
  classifier = await pipeline("token-classification", "privacy-filter", {
    device: "webgpu",
    dtype: "q4f16",
    local_files_only: true,
    use_external_data_format: true,
  });
  loadedBackend = classifier.device || "unknown";
  return classifier;
}

export function nerBackend() {
  return loadedBackend || "not-loaded";
}

function chunkRange(text, raw, cursor) {
  if (!raw) return null;
  const leading = raw.match(/^\s*/)[0].length;
  const trailing = raw.match(/\s*$/)[0].length;
  const trimmed = raw.slice(leading, raw.length - trailing);
  if (!trimmed) return null;

  let start = text.indexOf(raw, cursor);
  if (start >= 0) start += leading;
  else start = text.indexOf(trimmed, cursor);
  if (start < 0) return null;
  return { start, end: start + trimmed.length, value: trimmed };
}

async function classify(clf, text) {
  const tokens = await clf(text, {
    aggregation_strategy: "simple",
    ignore_labels: [],
  });
  const spans = [];
  let cursor = 0;
  for (const t of tokens || []) {
    const range = chunkRange(text, t.word, cursor);
    if (!range) continue;
    cursor = range.end;

    const kind = t.entity_group;
    if (!kind || kind === "O" || kind === "0" || t.score < 0.9) continue;
    spans.push({
      entity_group: kind,
      value: range.value,
      start: range.start,
      end: range.end,
    });
  }
  const sorted = spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  for (const s of sorted) {
    if (s.start < lastEnd) continue;
    out.push(s);
    lastEnd = s.end;
  }
  return out;
}

export async function redactText(text) {
  const clf = await loadNER();
  const spans = await classify(clf, text);
  let out = text;
  for (const span of spans.reverse()) {
    out =
      out.slice(0, span.start) +
      `[REDACTED:${span.entity_group.toUpperCase()}]` +
      out.slice(span.end);
  }
  return { output: out, count: spans.length };
}
