import { rm } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { resolve } from "node:path";

const dist = resolve(import.meta.dirname, "..", "dist");
for await (const p of glob(`${dist}/assets/ort-wasm-*.wasm`)) {
  await rm(p);
  console.log("removed", p);
}
for await (const p of glob(`${dist}/wasm/ort-wasm-*.wasm`)) {
  await rm(p);
  console.log("removed", p);
}