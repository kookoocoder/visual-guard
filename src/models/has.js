import * as ort from "onnxruntime-web/webgpu";

let session = null;
let backendChecked = false;

export async function loadHaS() {
  if (session) return session;
  ort.env.wasm.wasmPaths = {
    mjs: "/wasm/v129/ort-wasm-simd-threaded.asyncify.mjs",
    wasm: "/wasm/v129/ort-wasm-simd-threaded.asyncify.wasm",
  };
  session = await ort.InferenceSession.create("/models/has/model.onnx", {
    executionProviders: ["webgpu"],
    graphOptimizationLevel: "basic",
  });
  return session;
}

export function modelBackend() {
  try {
    return session ? session.handler.provider : "not-loaded";
  } catch {
    return "unknown";
  }
}

export function frameToTensor(imageBitmap, size = 640) {
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
  return { tensor: new ort.Tensor("float32", float32, [1, 3, size, size]), scale, padX, padY };
}

export async function runHaS(imageBitmap) {
  const s = await loadHaS();
  const { tensor, scale, padX, padY } = frameToTensor(imageBitmap, 640);
  const results = await s.run({ images: tensor });
  const out = results.output0.data;
  const n = out.length / 38;
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const row = i * 38;
    const score = out[row + 4];
    if (score < 0.25) continue;
    boxes.push({
      x1: out[row],
      y1: out[row + 1],
      x2: out[row + 2],
      y2: out[row + 3],
      score,
      cls: out[row + 5],
      coef: Array.from(out.subarray(row + 6, row + 38)),
    });
  }
  return { boxes, protos: results.output1, scale, padX, padY };
}
