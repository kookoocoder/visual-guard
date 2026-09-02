// End-to-end diagnostic for Visual Guard model loading and redaction.
// Usage: bun scripts/diagnose.js
import { existsSync, statSync } from "node:fs";
import { resolve, sep, join } from "node:path";

const root = resolve(import.meta.dirname, "..");

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function log(phase, message, level = "info") {
  const tag = {
    info: `${c.cyan}INFO${c.reset}`,
    ok: `${c.green} OK ${c.reset}`,
    warn: `${c.yellow}WARN${c.reset}`,
    fail: `${c.red}FAIL${c.reset}`,
    step: `${c.magenta}STEP${c.reset}`,
  }[level];
  console.log(`${c.dim}[${ts()}]${c.reset} ${tag} ${c.bold}${phase}${c.reset} ${message}`);
}

function section(title) {
  console.log(`\n${c.bold}━━━ ${title} ━━━${c.reset}`);
}

function humanSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function checkFile(phase, label, filePath) {
  if (!existsSync(filePath)) {
    log(phase, `${label}  ${c.red}MISSING${c.reset}  ${filePath}`, "fail");
    return false;
  }
  const size = statSync(filePath).size;
  log(phase, `${label}  ${c.green}found${c.reset}  ${humanSize(size)}  ${filePath}`, "ok");
  return true;
}

const requiredFiles = [
  ["Assets", "HaS ONNX", "public/models/has/model.onnx"],
  ["Assets", "NER config", "public/models/privacy-filter/config.json"],
  ["Assets", "NER tokenizer", "public/models/privacy-filter/tokenizer.json"],
  ["Assets", "NER ONNX graph", "public/models/privacy-filter/onnx/model_q4f16.onnx"],
  ["Assets", "NER ONNX weights", "public/models/privacy-filter/onnx/model_q4f16.onnx_data"],
  ["Assets", "ORT wasm (NER)", "public/wasm/v126/ort-wasm-simd-threaded.asyncify.wasm"],
  ["Assets", "ORT wasm (HaS)", "public/wasm/v129/ort-wasm-simd-threaded.asyncify.wasm"],
  ["Build", "dist manifest", "dist/manifest.json"],
  ["Build", "dist background", "dist/background.js"],
  ["Build", "dist content", "dist/content.js"],
  ["Build", "dist sidepanel", "dist/sidepanel/sidepanel.html"],
];

const results = { pass: 0, fail: 0, warn: 0 };

section("1 · FILE & BUILD CHECK");
let filesOk = true;
for (const [phase, label, rel] of requiredFiles) {
  const ok = checkFile(phase, label, join(root, rel));
  if (!ok) filesOk = false;
}

section("2 · MANIFEST CSP");
try {
  const manifest = JSON.parse(
    await Bun.file(join(root, "dist/manifest.json")).text(),
  );
  const csp = manifest.content_security_policy?.extension_pages ?? "";
  if (csp.includes("wasm-unsafe-eval")) {
    log("CSP", `wasm-unsafe-eval present  ${c.dim}${csp}${c.reset}`, "ok");
    results.pass += 1;
  } else {
    log("CSP", `wasm-unsafe-eval ${c.red}missing${c.reset} — ONNX/WASM will fail in Chrome`, "fail");
    results.fail += 1;
    filesOk = false;
  }
} catch (error) {
  log("CSP", `could not read dist/manifest.json: ${error.message}`, "fail");
  results.fail += 1;
  filesOk = false;
}

section("3 · PRIVACY FILTER (NER) — load + infer");
log("NER", "configuring transformers.js for local files only…", "step");

const { env, pipeline } = await import("@huggingface/transformers");
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = root.split(sep).join("/") + "/public/models/";

if (env.backends?.onnx?.wasm) {
  const wasmBase = `${env.localModelPath}../wasm/v126`;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${wasmBase}/ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${wasmBase}/ort-wasm-simd-threaded.asyncify.wasm`,
  };
  log("NER", `wasm paths → ${wasmBase}`, "info");
}

const sampleText =
  "Hi, I am Alice Smith. Contact me at alice.smith@example.com or +1-555-0100. " +
  "My card number is 4111 1111 1111 1111 and I live at 42 Maple Street.";

let nerOk = false;
try {
  log("NER", "creating pipeline(token-classification, privacy-filter, webgpu, q4f16)…", "step");
  const started = performance.now();

  const classifier = await pipeline("token-classification", "privacy-filter", {
    device: "webgpu",
    dtype: "q4f16",
    local_files_only: true,
    use_external_data_format: true,
    progress_callback: (progress) => {
      if (progress?.status === "progress" && Number.isFinite(progress.progress)) {
        const pct = Math.round(progress.progress);
        if (pct % 10 === 0 || pct === 100) {
          log("NER", `loading weights… ${pct}%  (${progress.file ?? "weights"})`, "info");
        }
      } else if (progress?.status === "done") {
        log("NER", `done · ${progress.file ?? "file"}`, "info");
      } else if (progress?.status === "ready") {
        log("NER", "ready", "ok");
      } else if (progress?.status && progress.status !== "progress_total") {
        log("NER", `${progress.status}${progress.file ? ` · ${progress.file}` : ""}`, "info");
      }
    },
  });

  const loadMs = Math.round(performance.now() - started);
  log("NER", `pipeline ready in ${loadMs}ms  backend=${classifier.device ?? "unknown"}`, "ok");
  results.pass += 1;

  log("NER", "running inference on sample PII text…", "step");
  const inferStarted = performance.now();
  const tokens = await classifier(sampleText, { aggregation_strategy: "simple" });
  const inferMs = Math.round(performance.now() - inferStarted);

  const spans = (tokens ?? []).filter((t) => t.entity_group && t.entity_group !== "O");
  log("NER", `inference done in ${inferMs}ms  ${spans.length} span(s) detected`, spans.length ? "ok" : "warn");

  for (const span of spans.slice(0, 8)) {
    log(
      "NER",
      `  · ${span.entity_group}  score=${(span.score ?? 0).toFixed(3)}  word="${span.word ?? ""}"`,
      "info",
    );
  }
  if (spans.length > 8) log("NER", `  … and ${spans.length - 8} more`, "info");

  const { redactText } = await import("../src/models/ner.js");
  const redacted = await redactText(sampleText);
  log("NER", `redactText() → ${redacted.count} replacement(s)`, "info");
  log("NER", `output: ${redacted.output.slice(0, 120)}…`, "info");

  const leaks = ["alice.smith@example.com", "+1-555-0100", "4111 1111 1111 1111"];
  const leaked = leaks.filter((s) => redacted.output.includes(s));
  if (leaked.length) {
    log("NER", `leaked values: ${leaked.join(" | ")}`, "warn");
    results.warn += 1;
  } else {
    log("NER", "no known PII leaked in output", "ok");
    results.pass += 1;
  }

  nerOk = spans.length > 0;
} catch (error) {
  log("NER", error instanceof Error ? error.message : String(error), "fail");
  if (error?.stack) console.log(c.dim + error.stack.split("\n").slice(1, 4).join("\n") + c.reset);
  results.fail += 1;
}

section("4 · HaS VISION — ONNX session");
log("HaS", "checking WebGPU availability in this runtime…", "step");

const hasWebGpu = Boolean(globalThis.navigator?.gpu);
if (!hasWebGpu) {
  log(
    "HaS",
    "WebGPU not available in terminal runtime — skipping live inference (extension side panel has WebGPU)",
    "warn",
  );
  results.warn += 1;
} else {
  try {
    const ort = await import("onnxruntime-web/webgpu");
    const modelPath = join(root, "public/models/has/model.onnx");
    ort.env.wasm.wasmPaths = {
      mjs: join(root, "public/wasm/v129/ort-wasm-simd-threaded.asyncify.mjs"),
      wasm: join(root, "public/wasm/v129/ort-wasm-simd-threaded.asyncify.wasm"),
    };

    log("HaS", `opening ${modelPath}…`, "step");
    const started = performance.now();
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "basic",
    });
    const loadMs = Math.round(performance.now() - started);
    log(
      "HaS",
      `session ready in ${loadMs}ms  provider=${session.handler?.provider ?? "unknown"}  inputs=[${session.inputNames.join(", ")}]`,
      "ok",
    );
    results.pass += 1;
  } catch (error) {
    log("HaS", error instanceof Error ? error.message : String(error), "fail");
    results.fail += 1;
  }
}

section("5 · EXTENSION RUNTIME NOTES");
log(
  "Chrome",
  "Reload extension: chrome://extensions → Visual Guard → Reload",
  "info",
);
log(
  "Chrome",
  "Open side panel on a normal https page, then click Redact buttons",
  "info",
);
log(
  "Chrome",
  "Side panel logs: right-click panel → Inspect → Console tab",
  "info",
);
log(
  "Chrome",
  "FALLBACK badge = model status error; hover badge for exact message",
  "info",
);

section("SUMMARY");
const overall = filesOk && nerOk && results.fail === 0 ? "PASS" : "ISSUES FOUND";
const color = overall === "PASS" ? c.green : c.red;
console.log(
  `${color}${c.bold}${overall}${c.reset}  files=${filesOk ? "ok" : "missing"}  ner=${nerOk ? "ok" : "failed"}  pass=${results.pass}  warn=${results.warn}  fail=${results.fail}`,
);

if (!filesOk) {
  console.log(`\n${c.yellow}Fix missing assets:${c.reset}`);
  console.log("  bun scripts/download-models.js   # privacy-filter weights");
  console.log("  uv run scripts/export-has.py     # HaS ONNX export");
}

if (!nerOk) {
  console.log(`\n${c.yellow}NER failed — common causes:${c.reset}`);
  console.log("  · weights missing under public/models/privacy-filter/");
  console.log("  · wasm runtime missing under public/wasm/v126/");
  console.log("  · dist built without CSP wasm-unsafe-eval → run: bun run build");
}

process.exit(results.fail > 0 || !filesOk ? 1 : 0);
