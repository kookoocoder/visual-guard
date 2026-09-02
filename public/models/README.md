# Local models

Weights are not committed (see `.gitignore`). Fetch them with:

```bash
bun scripts/download-models.js   # openai/privacy-filter (q4f16 ONNX) → openai/privacy-filter/
uv run scripts/export-has.py     # HaS .pt → ONNX FP16 → has/model.onnx
```

`export-has.py` needs a venv with ultralytics and onnx:

```bash
uv venv scripts/.venv
uv pip install --python scripts/.venv/Scripts/python.exe ultralytics onnx
& scripts/.venv/Scripts/python.exe scripts/export-has.py
```

## Trees

```
models/
  has/model.onnx                    HaS YOLO11-seg, 640x640, NMS baked in (124 MB)
  openai/privacy-filter/
    config.json
    tokenizer.json                 (28 MB)
    tokenizer_config.json
    viterbi_calibration.json
    onnx/model_q4f16.onnx          (160 kB graph)
    onnx/model_q4f16.onnx_data     (809 MB weights)
```

## Loading

- **HaS**: loaded by ONNX Runtime Web via `/models/has/model.onnx`, WebGPU EP.
- **NER**: `transformers.js` reads these from `env.localModelPath = "/models/"`. It checks the extension bundle first and automatically downloads missing files from `openai/privacy-filter` on first use, reports progress in the side panel, and caches the files for later offline use.