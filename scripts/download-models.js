// Downloads openai/privacy-filter quantized ONNX weights + tokenizer for
// transformers.js into public/models/ so the extension can run fully offline.
// Usage: bun scripts/download-models.js
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://huggingface.co/openai/privacy-filter/resolve/main";
const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_q4.onnx",
  "onnx/model_q4.onnx_data",
];

async function download(file, dest) {
  if (exists(dest)) {
    console.log(`  exists ${file}`);
    return;
  }
  const url = `${BASE}/${file}?download=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const size = Number(res.headers.get("content-length") || 0);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`  saved ${file} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

import { existsSync as exists } from "node:fs";

for (const file of FILES) {
  const dest = join(root, "public", "models", "openai", "privacy-filter", file);
  await mkdir(dirname(dest), { recursive: true });
  await download(file, dest);
}
console.log("done");