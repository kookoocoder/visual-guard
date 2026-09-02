import { pipeline, env } from "@huggingface/transformers";

function runtimeUrl(path) {
  if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(path);
  return `/${path}`;
}

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = runtimeUrl("models/");
if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: runtimeUrl("wasm/v126/ort-wasm-simd-threaded.asyncify.mjs"),
    wasm: runtimeUrl("wasm/v126/ort-wasm-simd-threaded.asyncify.wasm"),
  };
}

let classifier = null;
let loadedBackend = null;
let unavailable = false;
let lastError = "";

export async function loadNER() {
  if (classifier) return classifier;
  if (unavailable) throw new Error(lastError || "The local NER model is unavailable.");
  if (!("gpu" in (globalThis.navigator || {}))) {
    unavailable = true;
    lastError = "WebGPU is unavailable in this browser context.";
    throw new Error(lastError);
  }
  classifier = await pipeline("token-classification", "openai/privacy-filter", {
    device: "webgpu",
    dtype: "q4",
    local_files_only: true,
    use_external_data_format: true,
  });
  loadedBackend = classifier.device || "unknown";
  return classifier;
}

export function nerBackend() {
  return loadedBackend || "not-loaded";
}

const MODEL_LABELS = {
  email: "EMAIL",
  e_mail: "EMAIL",
  phone: "PHONE",
  telephone: "PHONE",
  person: "NAME",
  name: "NAME",
  address: "ADDRESS",
  credit_card: "CARD",
  card: "CARD",
  password: "PASSWORD",
  secret: "SECRET",
  api_key: "SECRET",
  ssn: "ID",
};

const deterministicPatterns = [
  { kind: "EMAIL", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { kind: "CARD", regex: /\b(?:\d[ -]?){13,19}\b/g },
  { kind: "PHONE", regex: /(?<!\w)(?:\+?\d[\d .()\-]{7,}\d)(?!\w)/g },
  { kind: "SECRET", regex: /\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{12,}\b/g },
];

function modelUrlLabel(label) {
  const normalized = String(label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  for (const [key, value] of Object.entries(MODEL_LABELS)) {
    if (normalized.includes(key)) return value;
  }
  return "PII";
}

function deterministicSpans(text) {
  return deterministicPatterns.flatMap(({ kind, regex }) => {
    const spans = [];
    for (const match of text.matchAll(regex)) {
      spans.push({ start: match.index, end: match.index + match[0].length, kind, score: 1 });
    }
    return spans;
  });
}

function normalizeModelOutput(output) {
  const items = Array.isArray(output) ? output : [];
  return items
    .filter((item) => Number(item.score ?? item.confidence ?? 0) >= 0.9)
    .map((item) => ({
      value: String(item.word ?? item.token ?? "").replace(/^##/, ""),
      kind: modelUrlLabel(item.entity_group ?? item.entity),
      score: Number(item.score ?? item.confidence ?? 0),
    }))
    .filter((item) => item.value);
}

function mergeSpans(spans) {
  const sorted = spans
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const span of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || span.start >= previous.end) {
      merged.push({ ...span });
      continue;
    }
    if (span.end > previous.end) previous.end = span.end;
    if (span.score > previous.score) previous.kind = span.kind;
  }
  return merged;
}

function applySpans(text, spans) {
  return [...spans]
    .sort((a, b) => b.start - a.start)
    .reduce((result, span) => {
      return `${result.slice(0, span.start)}[REDACTED:${span.kind}]${result.slice(span.end)}`;
    }, text);
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

async function classifyModel(clf, text) {
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

    const kind = modelUrlLabel(t.entity_group);
    if (t.score < 0.9) continue;
    spans.push({
      kind,
      value: range.value,
      start: range.start,
      end: range.end,
      score: t.score,
    });
  }
  return spans;
}

export async function redactText(text) {
  const deterministic = deterministicSpans(text);
  let modelSpans = [];
  let modelFailed = false;

  try {
    const clf = await loadNER();
    modelSpans = await classifyModel(clf, text);
  } catch {
    modelFailed = true;
  }

  const merged = mergeSpans([...deterministic, ...modelSpans]);
  const redacted = merged.map((span) => ({
    kind: span.kind,
    value: text.slice(span.start, span.end),
    score: span.score,
  }));
  return {
    output: applySpans(text, merged),
    count: merged.length,
    mode: modelFailed ? "deterministic" : "webgpu + deterministic",
    redacted,
  };
}
