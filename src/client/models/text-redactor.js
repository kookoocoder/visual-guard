import { env, pipeline } from "@huggingface/transformers";
import { NER_MODEL_ID } from "./remote-assets.js";
import {
  evictOthers,
  installMemoryListeners,
  registerResident,
  touchModel,
  unregisterResident,
  withLoadLock,
  yieldToUi,
} from "./memory-manager.js";

// Prefer Hub download + browser cache. Packaged weights are no longer shipped.
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.useBrowserCache = true;

const MODEL_ID = NER_MODEL_ID;
const RESIDENT_ID = "ner";
const MAX_MODEL_CHARS = 4000;

function runtimeUrl(path) {
  if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(path);
  return `/${path}`;
}

if (env.backends?.onnx?.wasm) {
  // Single ORT wasm (v129) shared with HaS — no second 23MB copy.
  env.backends.onnx.wasm.wasmPaths = {
    mjs: runtimeUrl("wasm/v129/ort-wasm-simd-threaded.asyncify.mjs"),
    wasm: runtimeUrl("wasm/v129/ort-wasm-simd-threaded.asyncify.wasm"),
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
  account: "ID",
  ssn: "ID",
  date: "DATE",
  url: "URL",
  credit_card: "CARD",
  card: "CARD",
  password: "PASSWORD",
  secret: "SECRET",
  api_key: "SECRET",
};

const REAL_REDACTION_KEYS = new Set([
  "NAME",
  "EMAIL",
  "PHONE",
  "ADDRESS",
  "DATE",
  "URL",
  "CARD",
  "PASSWORD",
  "SECRET",
  "ID",
]);

export function redactionPlaceholder(kind) {
  const normalized = String(kind ?? "").trim().toUpperCase();
  return REAL_REDACTION_KEYS.has(normalized) ? `[${normalized}]` : null;
}

const deterministicPatterns = [
  { kind: "EMAIL", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  // Aadhaar / UIDAI 12-digit IDs (spaces or dashes between quartets).
  { kind: "ID", regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g },
  { kind: "CARD", regex: /\b(?:\d[ -]?){13,19}\b/g },
  { kind: "PHONE", regex: /(?<!\w)(?:\+?\d[\d .()\-]{7,}\d)(?!\w)/g },
  // DOB-style dates common on IDs (DD/MM/YYYY, DD-MM-YY, …).
  { kind: "DATE", regex: /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b/g },
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
      const placeholder = redactionPlaceholder(span.kind);
      if (!placeholder) return result;
      return `${result.slice(0, span.start)}${placeholder}${result.slice(span.end)}`;
    }, text);
}

/** Extract reusable surface forms (e.g. "yashraj") from NER/deterministic spans. */
export function collectKnownTokens(spans = []) {
  const tokens = [];
  const seen = new Set();
  for (const span of spans) {
    const kind = String(span.kind || "").toUpperCase();
    if (!redactionPlaceholder(kind)) continue;
    const raw = String(span.value ?? "").trim();
    if (!raw || raw.length < 2 || raw.length > 64) continue;
    // Prefer the stem without possessive so "yashraj's" seeds "yashraj".
    const stem = raw.replace(/['’]s\b/i, "").replace(/['’]$/u, "").trim();
    for (const value of [raw, stem]) {
      if (!value || value.length < 2) continue;
      const key = `${kind}:${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push({ value, kind });
    }
  }
  return tokens;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match known PII tokens including possessives: yashraj / yashraj's / Yashraj. */
export function knownTokenSpans(text, tokens = []) {
  if (!text || !tokens.length) return [];
  const spans = [];
  for (const token of tokens) {
    const kind = String(token.kind || "").toUpperCase();
    if (!redactionPlaceholder(kind)) continue;
    const value = String(token.value || "").trim();
    if (!value || value.length < 2) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(value)}(?:['’]s)?(?![\\p{L}\\p{N}_])`,
      "giu",
    );
    for (const match of text.matchAll(pattern)) {
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        kind,
        score: 1,
        value: match[0],
      });
    }
  }
  return spans;
}

export function applyKnownTokens(text, tokens = []) {
  const source = String(text ?? "");
  if (!source || !tokens.length) return { text: source, spans: [] };
  const merged = mergeSpans(knownTokenSpans(source, tokens));
  return {
    text: applySpans(source, merged),
    spans: merged.map((span) => ({
      ...span,
      value: source.slice(span.start, span.end),
      placeholder: redactionPlaceholder(span.kind),
    })),
  };
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
  const maxSpan = Math.max(48, Math.floor(text.length * 0.35));
  let searchFrom = 0;
  return items
    .filter((item) => Number(item.score ?? item.confidence ?? 0) >= 0.45)
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
    })
    .filter((span) => {
      if (!(span.end > span.start) || span.start < 0) return false;
      const length = span.end - span.start;
      if (length > maxSpan && !["EMAIL", "PHONE", "CARD", "PASSWORD", "SECRET", "ID", "DATE", "NAME"].includes(span.kind)) {
        return false;
      }
      return true;
    });
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(0)} MB`;
}

export class TextPrivacyModel {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.classifier = null;
    this.loadingPromise = null;
    this.status = "idle";
    this.lastError = "";
    this.unavailable = false;
    this._lastProgressLog = 0;
    installMemoryListeners();
  }

  get ready() {
    return this.status === "ready" && Boolean(this.classifier);
  }

  updateStatus(status, detail = "") {
    this.status = status;
    this.lastError = status === "error" ? detail : "";
    this.onStatus({ status, detail, model: MODEL_ID });
  }

  async dispose() {
    unregisterResident(RESIDENT_ID);
    const classifier = this.classifier;
    this.classifier = null;
    this.loadingPromise = null;
    if (this.status !== "error") this.updateStatus("idle", "unloaded · freed RAM");
    if (classifier?.dispose) {
      try {
        await classifier.dispose();
      } catch {
        // ignore dispose races
      }
    }
    await yieldToUi(0);
  }

  async ensureLoaded() {
    if (this.classifier) {
      touchModel(RESIDENT_ID);
      return this.classifier;
    }
    if (this.unavailable) throw new Error(this.lastError || "The local NER model is unavailable.");
    if (this.loadingPromise) return this.loadingPromise;

    if (!globalThis.navigator?.gpu) {
      this.unavailable = true;
      this.updateStatus("error", "WebGPU is unavailable in this browser context.");
      throw new Error("WebGPU is unavailable in this browser context.");
    }

    this.updateStatus("loading", "Downloading Privacy Filter (first run)…");
    this.loadingPromise = withLoadLock(async () => {
      try {
        // Never keep HaS + NER in VRAM/RAM at once.
        await evictOthers(RESIDENT_ID);
        await yieldToUi(16);

        this.classifier = await pipeline("token-classification", MODEL_ID, {
          device: "webgpu",
          dtype: "q4f16",
          local_files_only: false,
          use_external_data_format: true,
          progress_callback: (progress) => {
            const now = Date.now();
            if (now - this._lastProgressLog < 1200) return;
            this._lastProgressLog = now;

            if (progress?.status === "progress" && Number.isFinite(progress.progress)) {
              const pct = Math.round(progress.progress);
              const file = String(progress.file || progress.name || "model").split("/").pop();
              const loaded = formatBytes(progress.loaded);
              const total = formatBytes(progress.total);
              const size = loaded && total ? ` · ${loaded}/${total}` : "";
              this.onStatus({
                status: "loading",
                detail: `NER ${file} · ${pct}%${size}`,
                model: MODEL_ID,
              });
              return;
            }

            if (progress?.status === "download" || progress?.status === "Downloading") {
              this.onStatus({
                status: "loading",
                detail: `Downloading NER · ${String(progress.file || "").split("/").pop() || "weights"}`,
                model: MODEL_ID,
              });
            }
          },
        });

        registerResident(RESIDENT_ID, { unload: () => this.dispose() });
        touchModel(RESIDENT_ID);
        this.updateStatus("ready", "WebGPU · q4f16 · cached");
        return this.classifier;
      } catch (error) {
        this.classifier = null;
        this.loadingPromise = null;
        this.unavailable = true;
        const message = error instanceof Error ? error.message : String(error);
        this.updateStatus("error", message);
        throw error;
      }
    });

    return this.loadingPromise;
  }

  async redact(text, options = {}) {
    return (await this.redactBatch([text], options))[0];
  }

  async redactBatch(
    texts = [],
    { preferModel = true, strictFallback = false, maxChars = MAX_MODEL_CHARS, knownTokens = [] } = {},
  ) {
    const sources = texts.map((text) => String(text ?? ""));
    const spansByText = sources.map((source) => [
      ...deterministicSpans(source),
      ...knownTokenSpans(source, knownTokens),
    ]);
    let modelOutputs = null;
    let modelFailed = false;

    const canUseModel = preferModel && this.ready && sources.some(Boolean);
    // Do not auto-start a multi-hundred-MB load from every redact call — sidepanel decides.
    if (canUseModel) {
      try {
        touchModel(RESIDENT_ID);
        const classifier = this.classifier;
        // Cap work so a single pass cannot pin huge activations.
        const budget = Math.min(maxChars, 3000);
        const clipped = sources.map((source) => source.slice(0, budget));
        const chunkSize = 8;
        modelOutputs = new Array(clipped.length).fill(null);
        for (let offset = 0; offset < clipped.length; offset += chunkSize) {
          const slice = clipped.slice(offset, offset + chunkSize);
          // Skip empty chunks to avoid wasting GPU on blank labels.
          if (!slice.some(Boolean)) continue;
          await yieldToUi(0);
          const input = slice.length === 1 ? slice[0] : slice;
          const output = await classifier(input, { aggregation_strategy: "simple" });
          const outputs = slice.length === 1 ? [output] : Array.isArray(output) ? output : [];
          for (let i = 0; i < outputs.length; i += 1) {
            modelOutputs[offset + i] = outputs[i];
          }
        }
        touchModel(RESIDENT_ID);
      } catch {
        modelFailed = true;
      }
    } else if (preferModel && this.unavailable && strictFallback) {
      modelFailed = true;
    }

    return sources.map((source, index) => {
      if (!source) return { text: "", spans: [], mode: "empty" };
      if (modelFailed && strictFallback) {
        const merged = mergeSpans(spansByText[index].filter((span) => redactionPlaceholder(span.kind)));
        return {
          text: applySpans(source, merged),
          spans: merged.map((span) => ({
            ...span,
            value: source.slice(span.start, span.end),
            placeholder: redactionPlaceholder(span.kind),
          })),
          mode: "deterministic · model unavailable",
        };
      }

      const modelOutput = modelOutputs?.[index];
      const spans = [...spansByText[index]];
      if (Array.isArray(modelOutput)) spans.push(...normalizeModelOutput(modelOutput, source.slice(0, maxChars)));
      const merged = mergeSpans(spans.filter((span) => redactionPlaceholder(span.kind)));
      return {
        text: applySpans(source, merged),
        spans: merged.map((span) => ({
          ...span,
          value: source.slice(span.start, span.end),
          placeholder: redactionPlaceholder(span.kind),
        })),
        mode: modelOutputs
          ? "webgpu + deterministic"
          : knownTokens.length
            ? "deterministic + known tokens"
            : this.loadingPromise
              ? "deterministic · ner downloading"
              : modelFailed
                ? "deterministic · model unavailable"
                : "deterministic",
      };
    });
  }

  async redactElements(elements = [], { strictFallback = false, preferModel = true } = {}) {
    const fields = elements.flatMap((element) => {
      const values = [element.label];
      if (!element.sensitive && !String(element.value).startsWith("[REDACTED:")) values.push(element.value);
      return values;
    });
    const redactedFields = await this.redactBatch(fields, { strictFallback, preferModel, maxChars: 500 });
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
  runtime: "Transformers.js · WebGPU · Hub download",
};
