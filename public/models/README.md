# Local / remote models

The **packaged extension no longer ships model weights** (they were ~900 MB).
On first use the side panel downloads and caches them:

| Model | Source | Cached after |
|---|---|---|
| NER `openai/privacy-filter` q4f16 | Hugging Face Hub (transformers.js) | Browser cache / IndexedDB |
| HaS FP16 ONNX | `https://huggingface.co/kookoocoder/visual-guard-models/resolve/main/has/model.onnx` | Cache API |

Override HaS URL at build time:

```bash
VITE_HAS_MODEL_URL=https://example.com/has.onnx bun run build
```

## Optional local copies (dev only)

Weights under `public/models/` are **stripped from `dist/`** by `scripts/clean-dist.mjs`.
Keeping them locally is optional for offline diagnose scripts:

```bash
bun scripts/download-models.js   # openai/privacy-filter → public/models/…
uv run scripts/export-has.py     # HaS .pt → public/models/has/model.onnx
```

## Package size

After `bun run build`, `dist/` should be ~**25 MB** (one ORT wasm) instead of ~1 GB.
