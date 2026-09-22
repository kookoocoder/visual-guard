import * as ort from "onnxruntime-web/webgpu";
import { ensureHasModelBuffer, HAS_MODEL_URL } from "./remote-assets.js";
import {
  evictOthers,
  installMemoryListeners,
  registerResident,
  touchModel,
  unregisterResident,
  withLoadLock,
  yieldToUi,
} from "./memory-manager.js";

const MODEL_PATH = "models/has/model.onnx";
const RESIDENT_ID = "has";
const INPUT_SIZE = 640;
const SCORE_FLOOR = 0.36;
/** Drop vague detections covering this fraction of the frame (wall / pane false positives). */
const MAX_FRAME_COVERAGE = 0.55;
/**
 * captureVisibleTab always images a browser viewport. These HaS classes fire on
 * chat UIs / media viewers and black out the whole preview — skip them here.
 */
const VIEWPORT_SKIP_LABELS = new Set(["monitor screen", "mobile screen", "whiteboard"]);
/** Soft documents: keep only when they stay compact (ID photo, not the whole pane). */
const COMPACT_ONLY_LABELS = new Set(["paper", "receipt", "shipping label", "sticky note"]);
const COMPACT_MAX_COVERAGE = 0.32;
/** Full-document classes — always solid-fill the box (instance masks leave printed PII readable). */
const DOCUMENT_LABELS = new Set([
  "id card",
  "travel permit",
  "passport",
  "employee badge",
  "bank card",
]);
/** Real PII classes — keep even when large (zoomed Aadhaar / face in a media viewer). */
const ALWAYS_KEEP_LABELS = new Set([
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
  "official seal",
  "medical wristband",
  "QR code",
  "barcode",
]);
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

function runtimeUrl(path) {
  if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(path);
  return `/${path}`;
}

ort.env.wasm.wasmPaths = {
  mjs: runtimeUrl("wasm/v129/ort-wasm-simd-threaded.asyncify.mjs"),
  wasm: runtimeUrl("wasm/v129/ort-wasm-simd-threaded.asyncify.wasm"),
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function tensorValues(output) {
  if (!output?.data || !output?.dims) return null;
  return { data: output.data, dims: output.dims.map(Number) };
}

function readCandidate(data, channels, channelMajor, index, count) {
  if (channelMajor) {
    return Array.from({ length: channels }, (_, channel) => Number(data[channel * count + index] ?? 0));
  }
  const offset = index * channels;
  return Array.from({ length: channels }, (_, channel) => Number(data[offset + channel] ?? 0));
}

function decodeOutput(output) {
  const tensor = tensorValues(output);
  if (!tensor || tensor.dims.length !== 3 || tensor.dims[0] !== 1) return [];

  const [, first, second] = tensor.dims;
  const channelMajor = second > first * 2;
  const channels = channelMajor ? first : second;
  const count = channelMajor ? second : first;
  if (channels < 6 || count < 1) return [];

  // Ultralytics export(nms=True) returns [x1, y1, x2, y2, score, class, mask_coefficients...].
  const nmsLayout = !channelMajor && count <= 1000 && channels <= 64;
  const detections = [];
  for (let index = 0; index < count; index += 1) {
    const row = readCandidate(tensor.data, channels, channelMajor, index, count);
    let score;
    let classId = 0;
    let box;
    let maskCoefficients;

    if (nmsLayout || channels === 6) {
      box = row.slice(0, 4);
      score = row[4];
      classId = Math.round(row[5]);
      maskCoefficients = nmsLayout ? row.slice(6) : undefined;
    } else {
      // Keep support for a raw YOLO head if a future export disables NMS.
      const hasObjectness = channels - 5 > 1;
      const classStart = hasObjectness ? 5 : 4;
      const classScores = row.slice(classStart);
      const classScore = Math.max(...classScores, 0);
      score = (hasObjectness ? row[4] : 1) * classScore;
      classId = Math.max(0, classScores.indexOf(classScore));
      const [x, y, width, height] = row;
      box = [x - width / 2, y - height / 2, x + width / 2, y + height / 2];
    }

    if (!Number.isFinite(score) || score < SCORE_FLOOR || !box.every(Number.isFinite)) continue;

    const maxBoxValue = Math.max(...box.map(Math.abs));
    const scale = maxBoxValue <= 2 ? INPUT_SIZE : 1;
    const [x1, y1, x2, y2] = box.map((value) => value * scale);
    const left = clamp(Math.min(x1, x2) / INPUT_SIZE, 0, 1);
    const top = clamp(Math.min(y1, y2) / INPUT_SIZE, 0, 1);
    const right = clamp(Math.max(x1, x2) / INPUT_SIZE, 0, 1);
    const bottom = clamp(Math.max(y1, y2) / INPUT_SIZE, 0, 1);
    if (right - left < 0.01 || bottom - top < 0.01) continue;

    detections.push({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      score,
      label: PRIVACY_CLASSES[classId] ?? "privacy region",
      maskCoefficients,
    });
  }

  return filterDetections(detections).slice(0, 40);
}

function filterDetections(detections) {
  return detections
    .filter((detection) => {
      if (VIEWPORT_SKIP_LABELS.has(detection.label)) return false;
      const area = detection.width * detection.height;
      if (ALWAYS_KEEP_LABELS.has(detection.label)) {
        // Only drop broken near-total-frame boxes on real PII classes.
        return area < 0.92;
      }
      if (area >= MAX_FRAME_COVERAGE) return false;
      if (COMPACT_ONLY_LABELS.has(detection.label) && area > COMPACT_MAX_COVERAGE) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score);
}

function boxRight(detection) {
  return detection.x + detection.width;
}

function boxBottom(detection) {
  return detection.y + detection.height;
}

function boxesNear(a, b, slack = 0.1) {
  const ax1 = a.x - slack;
  const ay1 = a.y - slack;
  const ax2 = boxRight(a) + slack;
  const ay2 = boxBottom(a) + slack;
  const bx1 = b.x;
  const by1 = b.y;
  const bx2 = boxRight(b);
  const by2 = boxBottom(b);
  return ax1 <= bx2 && ax2 >= bx1 && ay1 <= by2 && ay2 >= by1;
}

function unionBox(parts) {
  const x1 = Math.min(...parts.map((part) => part.x));
  const y1 = Math.min(...parts.map((part) => part.y));
  const x2 = Math.max(...parts.map((part) => boxRight(part)));
  const y2 = Math.max(...parts.map((part) => boxBottom(part)));
  return {
    x: clamp(x1, 0, 1),
    y: clamp(y1, 0, 1),
    width: clamp(x2 - x1, 0, 1 - clamp(x1, 0, 1)),
    height: clamp(y2 - y1, 0, 1 - clamp(y1, 0, 1)),
  };
}

function padNormalizedBox(box, padX, padTop, padBottom) {
  const x = clamp(box.x - padX, 0, 1);
  const y = clamp(box.y - padTop, 0, 1);
  const right = clamp(boxRight(box) + padX, 0, 1);
  const bottom = clamp(boxBottom(box) + padBottom, 0, 1);
  return {
    x,
    y,
    width: Math.max(0.01, right - x),
    height: Math.max(0.01, bottom - y),
  };
}

/**
 * HaS segments faces/QR well but leaves printed ID text (name, DOB, Aadhaar UID).
 * When face + QR/barcode sit on the same card, cover the union hull (including the
 * gap with name/DOB) and extend downward for the UID line. Explicit id-card boxes
 * are forced to solid fills so partial masks cannot leak credentials.
 */
function expandCredentialRegions(detections) {
  const solidDocs = detections.map((detection) => {
    if (!DOCUMENT_LABELS.has(detection.label)) return detection;
    const padded = padNormalizedBox(detection, 0.02, 0.03, Math.max(0.06, detection.height * 0.2));
    const { mask: _mask, maskCoefficients: _coef, ...rest } = detection;
    return {
      ...rest,
      ...padded,
      forceBox: true,
      score: detection.score,
      label: detection.label,
    };
  });

  const faces = solidDocs.filter((detection) => detection.label === "face" || detection.label === "fingerprint");
  const codes = solidDocs.filter((detection) => detection.label === "QR code" || detection.label === "barcode");
  const extras = [];

  for (const face of faces) {
    for (const code of codes) {
      if (!boxesNear(face, code, 0.14)) continue;
      const hull = unionBox([face, code]);
      // Downward bias covers the Aadhaar / ID number strip under the photo+QR row.
      const padded = padNormalizedBox(hull, 0.025, 0.04, Math.max(0.08, hull.height * 0.55));
      if (padded.width * padded.height >= 0.9) continue;
      extras.push({
        ...padded,
        score: Math.min(face.score || 1, code.score || 1),
        label: "id credentials",
        forceBox: true,
        synthetic: true,
      });
    }
  }

  // Face beside an explicit id-card box: still extend a credentials hull.
  const docs = solidDocs.filter((detection) => DOCUMENT_LABELS.has(detection.label));
  for (const face of faces) {
    for (const doc of docs) {
      if (!boxesNear(face, doc, 0.08)) continue;
      const hull = unionBox([face, doc]);
      const padded = padNormalizedBox(hull, 0.02, 0.03, Math.max(0.05, hull.height * 0.15));
      if (padded.width * padded.height >= 0.9) continue;
      extras.push({
        ...padded,
        score: Math.min(face.score || 1, doc.score || 1),
        label: "id credentials",
        forceBox: true,
        synthetic: true,
      });
    }
  }

  return [...solidDocs, ...extras];
}

function pickOutputs(outputs) {
  const entries = Object.values(outputs ?? {})
    .map((value) => ({ value, tensor: tensorValues(value) }))
    .filter(({ tensor }) => tensor);
  const detectionEntry = entries
    .filter(({ tensor }) => tensor.dims.length === 3)
    .sort((a, b) => (b.tensor.dims[1] ?? 0) - (a.tensor.dims[1] ?? 0))[0];
  const prototypeEntry = entries.find(({ tensor }) => tensor.dims.length === 4);

  return {
    detections: detectionEntry ? decodeOutput(detectionEntry.value) : [],
    prototypes: prototypeEntry?.tensor ?? null,
  };
}

function createMasks(detections, prototypes) {
  if (!prototypes || prototypes.dims.length !== 4) return detections;
  const [, channels, height, width] = prototypes.dims;
  const planeSize = height * width;
  const scaleX = width / INPUT_SIZE;
  const scaleY = height / INPUT_SIZE;

  return detections.map((detection) => {
    if (!detection.maskCoefficients || detection.maskCoefficients.length < channels) {
      const { maskCoefficients: _drop, ...safe } = detection;
      return safe;
    }

    // Build full alpha plane, then crop to the detection box (YOLO-seg style).
    const alpha = new Uint8ClampedArray(planeSize);
    for (let pixel = 0; pixel < planeSize; pixel += 1) {
      let value = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        value += detection.maskCoefficients[channel] * Number(prototypes.data[channel * planeSize + pixel] ?? 0);
      }
      alpha[pixel] = sigmoid(value) > 0.5 ? 255 : 0;
    }

    const mx1 = Math.max(0, Math.floor(detection.x * INPUT_SIZE * scaleX));
    const my1 = Math.max(0, Math.floor(detection.y * INPUT_SIZE * scaleY));
    const mx2 = Math.min(width, Math.ceil((detection.x + detection.width) * INPUT_SIZE * scaleX));
    const my2 = Math.min(height, Math.ceil((detection.y + detection.height) * INPUT_SIZE * scaleY));
    const cropW = Math.max(1, mx2 - mx1);
    const cropH = Math.max(1, my2 - my1);

    const rgba = new Uint8ClampedArray(cropW * cropH * 4);
    let covered = 0;
    for (let y = 0; y < cropH; y += 1) {
      for (let x = 0; x < cropW; x += 1) {
        const a = alpha[(my1 + y) * width + (mx1 + x)];
        if (a) covered += 1;
        rgba[(y * cropW + x) * 4 + 3] = a;
      }
    }

    const { maskCoefficients: _maskCoefficients, ...safeDetection } = detection;
    // Sparse / noisy masks → solid box fill instead of speckled blackout.
    if (covered / (cropW * cropH) < 0.08) return safeDetection;
    return { ...safeDetection, mask: { rgba, width: cropW, height: cropH } };
  });
}

async function loadImage(dataUrl) {
  const image = new Image();
  image.decoding = "async";
  image.src = dataUrl;
  await image.decode();
  return image;
}

async function preprocess(image) {
  const canvas = document.createElement("canvas");
  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = context.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const input = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const planeSize = INPUT_SIZE * INPUT_SIZE;

  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    input[pixel] = data[pixel * 4] / 255;
    input[planeSize + pixel] = data[pixel * 4 + 1] / 255;
    input[planeSize * 2 + pixel] = data[pixel * 4 + 2] / 255;
  }
  return new ort.Tensor("float32", input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

function drawMask(context, canvas, detection, x, y, width, height) {
  if (!detection.mask) return false;
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = detection.mask.width;
  maskCanvas.height = detection.mask.height;
  const maskContext = maskCanvas.getContext("2d");
  maskContext.putImageData(new ImageData(detection.mask.rgba, detection.mask.width, detection.mask.height), 0, 0);
  maskContext.globalCompositeOperation = "source-in";
  maskContext.fillStyle = "rgba(9, 16, 30, 0.98)";
  maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  // Place the cropped mask inside the detection box — never stretch to the full frame.
  context.drawImage(maskCanvas, 0, 0, maskCanvas.width, maskCanvas.height, x, y, width, height);
  return true;
}

function drawRedactedFrame(image, detections, { label = "MASK" } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  // Paint large credential hulls first, then smaller instance masks on top.
  const ordered = [...detections].sort((a, b) => {
    const aDoc = a.forceBox || DOCUMENT_LABELS.has(a.label) || a.label === "id credentials" ? 1 : 0;
    const bDoc = b.forceBox || DOCUMENT_LABELS.has(b.label) || b.label === "id credentials" ? 1 : 0;
    if (aDoc !== bDoc) return bDoc - aDoc;
    return b.width * b.height - a.width * a.height;
  });

  for (const detection of ordered) {
    const x = Math.round(detection.x * canvas.width);
    const y = Math.round(detection.y * canvas.height);
    const width = Math.max(1, Math.round(detection.width * canvas.width));
    const height = Math.max(1, Math.round(detection.height * canvas.height));
    const solid =
      detection.forceBox ||
      DOCUMENT_LABELS.has(detection.label) ||
      detection.label === "id credentials";
    const masked = solid ? false : drawMask(context, canvas, detection, x, y, width, height);
    if (!masked) {
      context.fillStyle = "rgba(9, 16, 30, 0.97)";
      context.fillRect(x, y, width, height);
    }
    context.strokeStyle = "rgba(208, 255, 95, 0.75)";
    context.lineWidth = Math.max(1, Math.round(canvas.width / 520));
    context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
    const tag = `${label} · ${detection.label}`;
    const fontPx = Math.max(10, Math.round(canvas.width / 90));
    context.font = `600 ${fontPx}px system-ui`;
    const padX = 6;
    const padY = 3;
    const textW = Math.ceil(context.measureText(tag).width);
    const tagH = fontPx + padY * 2;
    const tagY = y > tagH + 4 ? y - tagH - 2 : y + 2;
    context.fillStyle = "rgba(9, 16, 30, 0.88)";
    context.fillRect(x, tagY, textW + padX * 2, tagH);
    context.fillStyle = "#d0ff5f";
    context.fillText(tag, x + padX, tagY + fontPx + padY - 2);
  }

  return canvas.toDataURL("image/png");
}

function safeFallbackFrame(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#09101e";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#d0ff5f";
  context.font = `600 ${Math.max(16, Math.round(canvas.width / 34))}px system-ui`;
  context.fillText("FRAME WITHHELD", 32, 58);
  context.fillStyle = "#8b98b2";
  context.font = `${Math.max(13, Math.round(canvas.width / 68))}px system-ui`;
  context.fillText("Visual model did not produce a verified result", 32, 90);
  context.strokeStyle = "#26354f";
  context.lineWidth = 2;
  context.strokeRect(24, 118, canvas.width - 48, canvas.height - 150);
  return canvas.toDataURL("image/png");
}

/**
 * Paint CSS-viewport boxes (from the content script) onto a capture.
 * Scales by devicePixelRatio so DOM text PII is blacked out even when HaS
 * only masks faces/cards and leaves readable names in the pixels.
 */
export async function paintSensitiveBoxes(dataUrl, boxes = [], { dpr = 1, label = "DOM PII" } = {}) {
  if (!dataUrl || !boxes.length) return dataUrl;
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const frameArea = canvas.width * canvas.height;
  for (const box of boxes) {
    const x = Math.round(Number(box.x || 0) * scale);
    const y = Math.round(Number(box.y || 0) * scale);
    const width = Math.round(Number(box.width || 0) * scale);
    const height = Math.round(Number(box.height || 0) * scale);
    if (width < 2 || height < 2) continue;
    if (x + width < 0 || y + height < 0 || x > canvas.width || y > canvas.height) continue;
    // Skip runaway DOM boxes that would black out most of the viewport.
    if ((width * height) / frameArea > 0.55) continue;
    context.fillStyle = "rgba(9, 16, 30, 0.97)";
    context.fillRect(x, y, width, height);
    context.strokeStyle = "rgba(208, 255, 95, 0.7)";
    context.lineWidth = Math.max(1, Math.round(canvas.width / 520));
    context.strokeRect(x, y, width, height);
    context.fillStyle = "#d0ff5f";
    context.font = `600 ${Math.max(10, Math.round(canvas.width / 90))}px system-ui`;
    context.fillText(`${label} · ${box.kind || "PII"}`, x + 6, Math.max(y + 14, y - 4));
  }

  return canvas.toDataURL("image/png");
}

export class ImagePrivacyModel {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.session = null;
    this.inputName = null;
    this.loadingPromise = null;
    this.status = "idle";
    this._unloadTimer = null;
    installMemoryListeners();
  }

  updateStatus(status, detail = "") {
    this.status = status;
    this.onStatus({ status, detail, model: "xuanwulab/HaS_Image_0209_FP32" });
  }

  async dispose() {
    if (this._unloadTimer) {
      clearTimeout(this._unloadTimer);
      this._unloadTimer = null;
    }
    unregisterResident(RESIDENT_ID);
    const session = this.session;
    this.session = null;
    this.inputName = null;
    this.loadingPromise = null;
    if (this.status !== "error") this.updateStatus("idle", "unloaded · freed RAM");
    if (session) {
      try {
        if (typeof session.release === "function") await session.release();
        else if (typeof session.dispose === "function") await session.dispose();
      } catch {
        // ignore
      }
    }
    await yieldToUi(0);
  }

  scheduleUnload(ms = 20_000) {
    if (this._unloadTimer) clearTimeout(this._unloadTimer);
    this._unloadTimer = setTimeout(() => {
      this._unloadTimer = null;
      this.dispose().catch(() => {});
    }, ms);
  }

  async ensureLoaded() {
    if (this.session) {
      touchModel(RESIDENT_ID);
      return this.session;
    }
    if (this.loadingPromise) return this.loadingPromise;

    if (!globalThis.navigator?.gpu) {
      this.updateStatus("error", "WebGPU is unavailable in this browser context.");
      throw new Error("WebGPU is unavailable in this browser context.");
    }

    this.loadingPromise = withLoadLock(async () => {
      try {
        this.updateStatus("loading", "Preparing HaS (unloading other models)…");
        await evictOthers(RESIDENT_ID);
        await yieldToUi(16);

        let modelSource;
        try {
          const buffer = await ensureHasModelBuffer({
            onProgress: (p) => {
              if (p.status === "cached") {
                this.updateStatus("loading", "Opening cached HaS ONNX…");
                return;
              }
              if (p.status === "download") {
                const mb = p.total ? `${(p.loaded / 1e6).toFixed(0)}/${(p.total / 1e6).toFixed(0)} MB` : "";
                this.updateStatus("loading", `Downloading HaS · ${p.pct}%${mb ? ` · ${mb}` : ""}`);
              }
            },
          });
          modelSource = buffer;
        } catch (remoteError) {
          const localUrl = runtimeUrl(MODEL_PATH);
          try {
            const probe = await fetch(localUrl);
            if (!probe.ok) throw remoteError;
            this.updateStatus("loading", "Opening packaged HaS ONNX…");
            modelSource = await probe.arrayBuffer();
          } catch {
            throw remoteError;
          }
        }

        await yieldToUi(0);
        this.session = await ort.InferenceSession.create(modelSource, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
        });
        modelSource = null;

        this.inputName = this.session.inputNames[0];
        registerResident(RESIDENT_ID, { unload: () => this.dispose() });
        touchModel(RESIDENT_ID);
        this.updateStatus("ready", "WebGPU · cached ONNX");
        return this.session;
      } catch (error) {
        this.session = null;
        this.loadingPromise = null;
        const message = error instanceof Error ? error.message : String(error);
        this.updateStatus("error", message);
        throw error;
      }
    });

    return this.loadingPromise;
  }

  async infer(dataUrl) {
    const session = await this.ensureLoaded();
    touchModel(RESIDENT_ID);
    const image = await loadImage(dataUrl);
    await yieldToUi(0);
    const input = await preprocess(image);
    const feeds = { [this.inputName]: input };
    const outputs = await session.run(feeds);
    const { detections, prototypes } = pickOutputs(outputs);
    const masked = expandCredentialRegions(
      createMasks(detections, prototypes).map(({ maskCoefficients, ...rest }) => rest),
    );
    // Release ORT output tensors promptly.
    try {
      for (const tensor of Object.values(outputs || {})) tensor?.dispose?.();
      input?.dispose?.();
    } catch {
      // ignore
    }
    return { image, detections: masked };
  }

  async redact(dataUrl) {
    const started = performance.now();
    const image = await loadImage(dataUrl);
    try {
      const { detections } = await this.infer(dataUrl);
      if (!detections.length) {
        this.scheduleUnload(12_000);
        return {
          dataUrl: safeFallbackFrame(image),
          detections: [],
          mode: "safe fallback · frame withheld",
          elapsedMs: Math.round(performance.now() - started),
          error: "Visual model returned no verified privacy masks; raw frame withheld.",
        };
      }
      const redactedUrl = drawRedactedFrame(image, detections, { label: "MASK" });
      // Drop raster masks from the return payload (they are huge TypedArrays).
      const lightDetections = detections.map(({ mask, ...rest }) => rest);
      // Screenshots are rare — free HaS soon so NER can reclaim RAM.
      this.scheduleUnload(12_000);
      return {
        dataUrl: redactedUrl,
        detections: lightDetections,
        mode: "webgpu + HaS ONNX (cached)",
        elapsedMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      this.scheduleUnload(5_000);
      return {
        dataUrl: safeFallbackFrame(image),
        detections: [],
        mode: "safe fallback · frame withheld",
        elapsedMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const imageModelInfo = {
  id: "xuanwulab/HaS_Image_0209_FP32",
  title: "HaS visual mask",
  runtime: "ONNX Runtime Web · WebGPU · Hub download",
  modelPath: HAS_MODEL_URL,
};
