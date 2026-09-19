/**
 * Download + cache large model weights outside the extension package.
 * Uses the Cache API so a ~1GB install becomes a few MB of code + one wasm runtime.
 */

const CACHE_NAME = "visual-guard-models-v1";

/** Official OpenAI Privacy Filter (transformers.js loads these by model id). */
export const NER_MODEL_ID = "openai/privacy-filter";

/**
 * Hosted HaS FP16 ONNX (same weights as the previous bundled model).
 * Override at build time with VITE_HAS_MODEL_URL.
 */
export const HAS_MODEL_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_HAS_MODEL_URL) ||
  "https://huggingface.co/kookoocoder/visual-guard-models/resolve/main/has/model.onnx";

export const HAS_MODEL_CACHE_KEY = "has/model.onnx";

function yieldToUi() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function openCache() {
  if (!globalThis.caches?.open) {
    throw new Error("Cache API unavailable — cannot store downloaded models.");
  }
  return caches.open(CACHE_NAME);
}

/**
 * Streaming download with progress callbacks and UI yields so the side panel
 * stays responsive while pulling hundreds of MB.
 */
export async function downloadToCache(url, cacheKey, { onProgress } = {}) {
  const cache = await openCache();
  const request = new Request(cacheKey, { method: "GET" });
  const hit = await cache.match(request);
  if (hit) {
    onProgress?.({ status: "cached", loaded: 1, total: 1, pct: 100, url, cacheKey });
    return hit;
  }

  onProgress?.({ status: "download", loaded: 0, total: 0, pct: 0, url, cacheKey });
  const response = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  const total = Number(response.headers.get("content-length") || 0);
  if (!response.body || !total) {
    const blob = await response.blob();
    const built = new Response(blob, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(blob.size) },
    });
    await cache.put(request, built.clone());
    onProgress?.({ status: "done", loaded: blob.size, total: blob.size, pct: 100, url, cacheKey });
    return built;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastPct = -1;
  let lastYield = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const pct = Math.min(99, Math.round((loaded / total) * 100));
    if (pct !== lastPct) {
      lastPct = pct;
      onProgress?.({ status: "download", loaded, total, pct, url, cacheKey });
    }
    // Keep the UI thread breathing every ~80ms.
    if (Date.now() - lastYield > 80) {
      lastYield = Date.now();
      await yieldToUi();
    }
  }

  const blob = new Blob(chunks, { type: "application/octet-stream" });
  const built = new Response(blob, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(blob.size) },
  });
  await cache.put(request, built.clone());
  onProgress?.({ status: "done", loaded: blob.size, total: blob.size, pct: 100, url, cacheKey });
  return built;
}

export async function getCachedArrayBuffer(cacheKey) {
  const cache = await openCache();
  const hit = await cache.match(new Request(cacheKey));
  if (!hit) return null;
  return hit.arrayBuffer();
}

export async function ensureHasModelBuffer({ onProgress } = {}) {
  const response = await downloadToCache(HAS_MODEL_URL, HAS_MODEL_CACHE_KEY, { onProgress });
  return response.arrayBuffer();
}

export async function modelCacheStats() {
  try {
    const cache = await openCache();
    const keys = await cache.keys();
    return { ok: true, entries: keys.map((req) => req.url) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
