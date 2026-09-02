import * as ort from "onnxruntime-web/webgpu";

function runtimeUrl(path) {
  if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(path);
  return `/${path}`;
}

let session = null;
let unavailable = false;
let lastError = "";

const INPUT_SIZE = 640;

const PRIVACY_CLASSES = [
  "face",
  "fingerprint",
  "palmprint",
  "id card",
  "travel permit",
  "passport",
  "employee badge",
  "license plate",
  "bank card",
  "physical key",
  "receipt",
  "shipping label",
  "official seal",
  "whiteboard",
  "sticky note",
  "mobile screen",
  "monitor screen",
  "medical wristband",
  "QR code",
  "barcode",
  "paper",
];

export async function loadHaS() {
  if (session) return session;
  if (unavailable) throw new Error(lastError || "The HaS vision model is unavailable.");
  if (!("gpu" in (globalThis.navigator || {}))) {
    unavailable = true;
    lastError = "WebGPU is unavailable in this browser context.";
    throw new Error(lastError);
  }
  ort.env.wasm.wasmPaths = {
    mjs: runtimeUrl("wasm/v129/ort-wasm-simd-threaded.asyncify.mjs"),
    wasm: runtimeUrl("wasm/v129/ort-wasm-simd-threaded.asyncify.wasm"),
  };
  try {
    session = await ort.InferenceSession.create(runtimeUrl("models/has_seg_fp16.onnx"), {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "basic",
    });
  } catch (error) {
    unavailable = true;
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
  return session;
}

export function modelBackend() {
  try {
    return session ? session.handler.provider : "not-loaded";
  } catch {
    return "unknown";
  }
}

export function frameToTensor(imageBitmap, size = INPUT_SIZE) {
  const srcW = imageBitmap.width;
  const srcH = imageBitmap.height;
  const scale = Math.min(size / srcW, size / srcH);
  const nw = Math.round(srcW * scale);
  const nh = Math.round(srcH * scale);
  const padX = Math.round((size - nw) / 2);
  const padY = Math.round((size - nh) / 2);

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#727272";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(imageBitmap, padX, padY, nw, nh);
  const { data } = ctx.getImageData(0, 0, size, size);
  const plane = size * size;
  const float32 = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    float32[i] = data[i * 4] / 255;
    float32[plane + i] = data[i * 4 + 1] / 255;
    float32[2 * plane + i] = data[i * 4 + 2] / 255;
  }
  return { tensor: new ort.Tensor("float32", float32, [1, 3, size, size]), scale, padX, padY, nw, nh };
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

export async function runHaS(imageBitmap) {
  const s = await loadHaS();
  const { tensor, scale, padX, padY, nw, nh } = frameToTensor(imageBitmap, INPUT_SIZE);
  const results = await s.run({ images: tensor });
  const out = results.output0.data;
  const n = out.length / 38;
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const row = i * 38;
    const score = out[row + 4];
    if (score < 0.32) continue;
    const x1 = out[row];
    const y1 = out[row + 1];
    const x2 = out[row + 2];
    const y2 = out[row + 3];
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    boxes.push({
      x1,
      y1,
      x2,
      y2,
      score,
      cls: Math.round(out[row + 5]),
      label: PRIVACY_CLASSES[Math.round(out[row + 5])] ?? "privacy region",
      coef: Array.from(out.subarray(row + 6, row + 38)),
    });
  }
  const protos = results.output1;
  const masks = createMasks(boxes, protos);
  return { boxes, masks, protos, scale, padX, padY, nw, nh, width: imageBitmap.width, height: imageBitmap.height };
}

// Decode YOLO11-seg instance masks: sigmoid(coef · protos) per detection,
// producing a 160x160 binary mask aligned to the letterboxed 640x640 input.
export function createMasks(boxes, protos) {
  if (!protos || boxes.length === 0) return [];
  const proto = protos.data;
  const [, channels, mh, mw] = protos.dims.map(Number);
  const plane = mh * mw;

  return boxes.map((box) => {
    const alpha = new Uint8ClampedArray(plane);
    for (let p = 0; p < plane; p++) {
      let value = 0;
      for (let c = 0; c < channels; c++) {
        value += box.coef[c] * proto[c * plane + p];
      }
      alpha[p] = sigmoid(value) > 0.5 ? 255 : 0;
    }
    return { ...box, maskAlpha: alpha, mw, mh, plane };
  });
}

// Draw redacted frame onto `ctx` (already-sized to srcW x srcH): black out
// only the actual segmented pixels of each instance mask, mapped from the
// letterboxed 640x640 input back to the original frame dimensions.
export function drawRedacted(ctx, srcW, srcH, masks, transform) {
  const { padX, padY, nw, nh } = transform;
  if (!masks || masks.length === 0) return masks.length;

  const maskScaler = INPUT_SIZE / 160; // 640 / 160 = 4
  for (const det of masks) {
    const maskCanvas = new OffscreenCanvas(det.mw, det.mh);
    const mctx = maskCanvas.getContext("2d");
    const imageData = new ImageData(det.maskAlpha, det.mw, det.mh);
    mctx.putImageData(imageData, 0, 0);

    // Region of the mask that actually covers the source image within the
    // letterboxed 640x640 input -> mapped to the full source canvas.
    const sx = padX / maskScaler;
    const sy = padY / maskScaler;
    const sw = nw / maskScaler;
    const sh = nh / maskScaler;
    ctx.drawImage(maskCanvas, sx, sy, sw, sh, 0, 0, srcW, srcH);
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, srcW, srcH);
    ctx.globalCompositeOperation = "source-over";
  }
  return masks.length;
}
