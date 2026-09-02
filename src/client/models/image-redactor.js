import * as ort from "onnxruntime-web/webgpu";

const MODEL_PATH = "models/has/model.onnx";
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

    if (!Number.isFinite(score) || score < 0.32 || !box.every(Number.isFinite)) continue;

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

  return detections.slice(0, 40);
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
  return detections.map((detection) => {
    if (!detection.maskCoefficients || detection.maskCoefficients.length < channels) return detection;
    const rgba = new Uint8ClampedArray(planeSize * 4);
    for (let pixel = 0; pixel < planeSize; pixel += 1) {
      let value = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        value += detection.maskCoefficients[channel] * Number(prototypes.data[channel * planeSize + pixel] ?? 0);
      }
      rgba[pixel * 4 + 3] = sigmoid(value) > 0.5 ? 255 : 0;
    }
    const { maskCoefficients: _maskCoefficients, ...safeDetection } = detection;
    return { ...safeDetection, mask: { rgba, width, height } };
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

function drawMask(context, canvas, detection) {
  if (!detection.mask) return false;
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = detection.mask.width;
  maskCanvas.height = detection.mask.height;
  const maskContext = maskCanvas.getContext("2d");
  maskContext.putImageData(new ImageData(detection.mask.rgba, detection.mask.width, detection.mask.height), 0, 0);
  maskContext.globalCompositeOperation = "source-in";
  maskContext.fillStyle = "rgba(9, 16, 30, 0.98)";
  maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  context.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
  return true;
}

function drawRedactedFrame(image, detections, { label = "LOCAL REDACTION" } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  for (const detection of detections) {
    const x = Math.round(detection.x * canvas.width);
    const y = Math.round(detection.y * canvas.height);
    const width = Math.round(detection.width * canvas.width);
    const height = Math.round(detection.height * canvas.height);
    const masked = drawMask(context, canvas, detection);
    if (!masked) {
      context.fillStyle = "rgba(9, 16, 30, 0.97)";
      context.fillRect(x, y, width, height);
    }
    context.strokeStyle = "rgba(208, 255, 95, 0.92)";
    context.lineWidth = Math.max(2, Math.round(canvas.width / 420));
    context.strokeRect(x, y, width, height);
    context.fillStyle = "#d0ff5f";
    context.font = `600 ${Math.max(11, Math.round(canvas.width / 75))}px system-ui`;
    context.fillText(`${label} · ${detection.label}`, x + 8, Math.max(y + 18, y - 7));
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

export class ImagePrivacyModel {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.session = null;
    this.inputName = null;
    this.modelUrl = runtimeUrl(MODEL_PATH);
    this.status = "idle";
  }

  updateStatus(status, detail = "") {
    this.status = status;
    this.onStatus({ status, detail, model: "xuanwulab/HaS_Image_0209_FP32" });
  }

  async ensureLoaded() {
    if (this.session) return this.session;
    if (!globalThis.navigator?.gpu) {
      this.updateStatus("error", "WebGPU is unavailable in this browser context.");
      throw new Error("WebGPU is unavailable in this browser context.");
    }

    this.updateStatus("loading", "Opening packaged HaS ONNX weights…");
    try {
      this.session = await ort.InferenceSession.create(this.modelUrl, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
      });
      this.inputName = this.session.inputNames[0];
      this.updateStatus("ready", "WebGPU · local ONNX");
      return this.session;
    } catch (error) {
      this.session = null;
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus("error", message);
      throw error;
    }
  }

  async infer(dataUrl) {
    const session = await this.ensureLoaded();
    const image = await loadImage(dataUrl);
    const input = await preprocess(image);
    const outputs = await session.run({ [this.inputName]: input });
    const { detections, prototypes } = pickOutputs(outputs);
    return { image, detections: createMasks(detections, prototypes) };
  }

  async redact(dataUrl) {
    const started = performance.now();
    const image = await loadImage(dataUrl);
    try {
      const { detections } = await this.infer(dataUrl);
      const redactedUrl = drawRedactedFrame(image, detections, { label: "MODEL MASK" });
      return {
        dataUrl: redactedUrl,
        detections,
        mode: "webgpu + local HaS ONNX",
        elapsedMs: Math.round(performance.now() - started),
      };
    } catch (error) {
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
  runtime: "ONNX Runtime Web · WebGPU",
  modelPath: MODEL_PATH,
};
