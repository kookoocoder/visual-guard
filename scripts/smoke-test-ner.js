// Smoke test for the NER redaction path against the real local model.
// Usage: bun scripts/smoke-test-ner.js
import { resolve, sep } from "node:path";

const { redactText } = await import("../src/models/ner.js");
const { env } = await import("@huggingface/transformers");

const root = resolve(import.meta.dirname, "..");
env.localModelPath = root.split(sep).join("/") + "/public/models/";
env.allowRemoteModels = false;
if (env.backends?.onnx?.wasm) {
  const wasmBase = `${env.localModelPath}../wasm/v126`;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${wasmBase}/ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${wasmBase}/ort-wasm-simd-threaded.asyncify.wasm`,
  };
}

const text =
  "Hi, I am Alice Smith. Contact me at alice.smith@example.com or +1-555-0100. " +
  "My card number is 4111 1111 1111 1111 and I live at 42 Maple Street.";

const r = await redactText(text);
console.log("count:", r.count);
console.log("out  :", r.output);

const leaks = ["alice.smith@example.com", "+1-555-0100", "4111 1111 1111 1111"];
const leaked = leaks.filter((s) => r.output.includes(s));
console.log("still-leaf:", leaked.length === 0 ? "none" : leaked.join(" | "));
if (r.count === 0 || leaked.length > 0) process.exit(1);