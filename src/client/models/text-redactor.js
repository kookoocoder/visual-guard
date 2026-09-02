import { env, pipeline } from "@huggingface/transformers";

env.allowLocalModels = true;
env.allowRemoteModels = false;

const MODEL_ID = "openai/privacy-filter";
const MODEL_PATH = "models/privacy-filter";

function runtimeUrl(path) {
  if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(path);
  return `/${path}`;
}

if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: runtimeUrl("wasm/v126/ort-wasm-simd-threaded.asyncify.mjs"),
    wasm: runtimeUrl("wasm/v126/ort-wasm-simd-threaded.asyncify.wasm"),
  };
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
  const normalized = String(label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  for (const [key, value] of Object.entries(MODEL_LABELS)) {
    if (normalized.includes(key)) return value;
  }
  return "PII";
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

function deterministicSpans(text) {
  return deterministicPatterns.flatMap(({ kind, regex }) => {
    const spans = [];
    for (const match of text.matchAll(regex)) {
      spans.push({ start: match.index, end: match.index + match[0].length, kind, score: 1 });
    }
    return spans;
  });
}

function normalizeModelOutput(output, text) {
  const items = Array.isArray(output) ? output : [];
  let searchFrom = 0;
  return items
    .filter((item) => Number(item.score ?? item.confidence ?? 0) >= 0.35)
    .map((item) => {
      const word = String(item.word ?? item.token ?? "").replace(/^##/, "");
      const start = Number.isFinite(item.start) ? item.start : text.indexOf(word, searchFrom);
      const end = Number.isFinite(item.end) ? item.end : start + word.length;
      searchFrom = Math.max(searchFrom, end);
      return {
        start,
        end,
        kind: modelUrlLabel(item.entity_group ?? item.entity),
        score: Number(item.score ?? item.confidence ?? 0),
      };
    });
}

export class TextPrivacyModel {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.classifier = null;
    this.status = "idle";
    this.lastError = "";
    this.unavailable = false;
    this.modelPath = runtimeUrl(MODEL_PATH);
  }

  updateStatus(status, detail = "") {
    this.status = status;
    this.lastError = status === "error" ? detail : "";
    this.onStatus({ status, detail, model: MODEL_ID });
  }

  async ensureLoaded() {
    if (this.classifier) return this.classifier;
    if (this.unavailable) throw new Error(this.lastError || "The local NER model is unavailable.");
    if (!globalThis.navigator?.gpu) {
      this.unavailable = true;
      this.updateStatus("error", "WebGPU is unavailable in this browser context.");
      throw new Error("WebGPU is unavailable in this browser context.");
    }

    this.updateStatus("loading", "Opening packaged Privacy Filter weights…");
    try {
      this.classifier = await pipeline("token-classification", this.modelPath, {
        device: "webgpu",
        dtype: "q4f16",
        local_files_only: true,
        use_external_data_format: true,
        progress_callback: (progress) => {
          if (progress?.status === "progress" && Number.isFinite(progress.progress)) {
            this.onStatus({
              status: "loading",
              detail: `Loading local NER · ${Math.round(progress.progress)}%`,
              model: MODEL_ID,
            });
          }
        },
      });
      this.updateStatus("ready", "WebGPU · q4f16 · local");
      return this.classifier;
    } catch (error) {
      this.classifier = null;
      this.unavailable = true;
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus("error", message);
      throw error;
    }
  }

  async redact(text, options = {}) {
    return (await this.redactBatch([text], options))[0];
  }

  async redactBatch(texts = [], { preferModel = true, strictFallback = false } = {}) {
    const sources = texts.map((text) => String(text ?? ""));
    const spansByText = sources.map(deterministicSpans);
    let modelOutputs = null;
    let modelFailed = false;

    if (preferModel && sources.some(Boolean)) {
      try {
        const classifier = await this.ensureLoaded();
        const output = await classifier(
          sources.map((source) => source.slice(0, 12000)),
          { aggregation_strategy: "simple" },
        );
        modelOutputs = Array.isArray(output) ? output : [];
      } catch {
        modelFailed = true;
      }
    }

    return sources.map((source, index) => {
      if (!source) return { text: "", spans: [], mode: "empty" };
      if (modelFailed && strictFallback) {
        return {
          text: "[REDACTED:TEXT]",
          spans: [{ start: 0, end: source.length, kind: "TEXT", score: 1 }],
          mode: "safe fallback · text withheld",
        };
      }

      const modelOutput = modelOutputs?.[index];
      const spans = [...spansByText[index]];
      if (Array.isArray(modelOutput)) spans.push(...normalizeModelOutput(modelOutput, source));
      const merged = mergeSpans(spans);
      return {
        text: applySpans(source, merged),
        spans: merged,
        mode: modelOutputs ? "webgpu + deterministic" : modelFailed ? "safe fallback · deterministic" : "deterministic",
      };
    });
  }

  async redactElements(elements = [], { strictFallback = false } = {}) {
    const fields = elements.flatMap((element) => {
      const values = [element.label];
      if (!element.sensitive && !String(element.value).startsWith("[REDACTED:")) values.push(element.value);
      return values;
    });
    const redactedFields = await this.redactBatch(fields, { strictFallback });
    let fieldIndex = 0;

    return elements.map((element) => {
      const safeElement = { ...element, label: redactedFields[fieldIndex++].text };
      if (!element.sensitive && !String(element.value).startsWith("[REDACTED:")) {
        safeElement.value = redactedFields[fieldIndex++].text;
      }
      return safeElement;
    });
  }
}

export const textModelInfo = {
  id: MODEL_ID,
  title: "Privacy Filter",
  runtime: "Transformers.js · WebGPU",
};
