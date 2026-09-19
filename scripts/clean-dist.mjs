import { rm, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "..", "dist");

async function rmSafe(path) {
  try {
    await rm(path, { recursive: true, force: true });
    console.log("removed", path);
  } catch {
    // ignore
  }
}

async function walkSizes(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await walkSizes(full, `${prefix}${entry.name}/`);
    } else {
      const size = (await stat(full)).size;
      total += size;
      if (size > 500_000) {
        console.log(`  ${(size / 1e6).toFixed(1)} MB  ${prefix}${entry.name}`);
      }
    }
  }
  return total;
}

// Vite copies public/ wholesale — strip heavy model weights from the loadable package.
await rmSafe(join(dist, "models"));
// NER + HaS both use v129 now; drop the duplicate ORT runtime.
await rmSafe(join(dist, "wasm", "v126"));
// Vite sometimes emits unused ORT copies into assets/.
for (const name of await readdir(join(dist, "assets")).catch(() => [])) {
  if (/ort-wasm/i.test(name)) await rmSafe(join(dist, "assets", name));
}

console.log("\nDist package contents (>0.5 MB):");
const total = await walkSizes(dist);
console.log(`\nTotal dist size: ${(total / 1e6).toFixed(1)} MB`);
