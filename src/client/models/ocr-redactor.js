import { createWorker } from "tesseract.js";

function runtimeUrl(path) {
  if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(path);
  return `/${path}`;
}

let workerPromise = null;

async function getWorker(onProgress) {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    const base = runtimeUrl("tesseract").replace(/\/$/, "");
    return createWorker("eng", 1, {
      workerPath: `${base}/worker.min.js`,
      corePath: `${base}/`,
      langPath: `${base}`,
      workerBlobURL: false,
      gzip: true,
      logger: (message) => {
        if (typeof onProgress === "function") onProgress(message);
      },
    });
  })().catch((error) => {
    workerPromise = null;
    throw error;
  });

  return workerPromise;
}

export async function disposeOcrWorker() {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // ignore terminate races
  }
}

function flattenWords(blocks = []) {
  const words = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          if (word?.text && word?.bbox) words.push(word);
        }
      }
    }
  }
  return words;
}

/**
 * OCR the capture and return words with character offsets into a single text blob
 * so NER/deterministic spans can map back onto pixel boxes.
 */
export async function extractOcrWords(dataUrl, { onProgress, minConfidence = 45 } = {}) {
  if (!dataUrl) return { text: "", words: [], elapsedMs: 0 };
  const started = performance.now();
  const worker = await getWorker(onProgress);
  const {
    data: { text: rawText = "", words: topWords, blocks },
  } = await worker.recognize(dataUrl, undefined, { text: true, blocks: true });

  const sourceWords = (Array.isArray(topWords) && topWords.length ? topWords : flattenWords(blocks))
    .filter((word) => String(word.text || "").trim())
    .filter((word) => !Number.isFinite(word.confidence) || word.confidence >= minConfidence);

  const words = [];
  let cursor = 0;
  for (const word of sourceWords) {
    const value = String(word.text).trim();
    if (!value) continue;
    if (words.length) cursor += 1; // joining space
    const start = cursor;
    const end = start + value.length;
    words.push({
      text: value,
      start,
      end,
      confidence: Number(word.confidence) || 0,
      bbox: {
        x0: Number(word.bbox?.x0) || 0,
        y0: Number(word.bbox?.y0) || 0,
        x1: Number(word.bbox?.x1) || 0,
        y1: Number(word.bbox?.y1) || 0,
      },
    });
    cursor = end;
  }

  const text = words.map((word) => word.text).join(" ") || String(rawText || "").trim();
  return {
    text,
    words,
    elapsedMs: Math.round(performance.now() - started),
  };
}

/** Map NER/deterministic character spans onto OCR word bounding boxes (image pixels). */
export function mapSpansToBoxes(words = [], spans = [], { pad = 3 } = {}) {
  if (!words.length || !spans.length) return [];
  const boxes = [];

  for (const span of spans) {
    const start = Number(span.start);
    const end = Number(span.end);
    if (!(end > start)) continue;
    const hits = words.filter((word) => word.start < end && word.end > start);
    if (!hits.length) continue;

    const x0 = Math.min(...hits.map((word) => word.bbox.x0));
    const y0 = Math.min(...hits.map((word) => word.bbox.y0));
    const x1 = Math.max(...hits.map((word) => word.bbox.x1));
    const y1 = Math.max(...hits.map((word) => word.bbox.y1));
    const width = x1 - x0;
    const height = y1 - y0;
    if (width < 2 || height < 2) continue;

    boxes.push({
      x: Math.max(0, x0 - pad),
      y: Math.max(0, y0 - pad),
      width: width + pad * 2,
      height: height + pad * 2,
      kind: span.kind || "PII",
      value: span.value || hits.map((word) => word.text).join(" "),
    });
  }

  return boxes;
}

/**
 * OCR → text privacy model → pixel boxes to paint on the live capture.
 * Runs on the original frame (not the HaS-blacked one) for readable glyphs.
 */
export async function redactOcrFromImage(dataUrl, textModel, {
  knownTokens = [],
  onProgress,
  ensureModel = true,
} = {}) {
  const ocr = await extractOcrWords(dataUrl, { onProgress });
  if (!ocr.text.trim()) {
    return {
      boxes: [],
      text: "",
      redactedText: "",
      spans: [],
      mode: "ocr empty",
      ocrMs: ocr.elapsedMs,
      wordCount: 0,
    };
  }

  if (ensureModel && textModel?.ensureLoaded) {
    try {
      await textModel.ensureLoaded();
    } catch {
      // Deterministic Aadhaar/DOB/email patterns still run without NER.
    }
  }

  const result = await textModel.redact(ocr.text, {
    preferModel: true,
    knownTokens,
    maxChars: 6000,
  });
  const boxes = mapSpansToBoxes(ocr.words, result.spans);

  return {
    boxes,
    text: ocr.text,
    words: ocr.words,
    redactedText: result.text,
    spans: result.spans,
    mode: `ocr + ${result.mode}`,
    ocrMs: ocr.elapsedMs,
    wordCount: ocr.words.length,
  };
}
