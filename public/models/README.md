# Local models

Weights are not committed (see `.gitignore`). Fetch them with:

```bash
bun scripts/download-models.js   # openai/privacy-filter (q4 ONNX) → openai/privacy-filter/
uv run scripts/export-has.py     # HaS .pt → ONNX FP16 → has_seg_fp16.onnx
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
  has_seg_fp16.onnx                 HaS YOLO11-seg, 640x640, NMS baked in (124 MB)
  openai/privacy-filter/
    config.json
    tokenizer.json                 (28 MB)
    tokenizer_config.json
    viterbi_calibration.json
    onnx/model_q4.onnx             (160 kB graph)
    onnx/model_q4.onnx_data        (917 MB weights)
```

## Loading

- **HaS**: loaded by ONNX Runtime Web via `/models/has_seg_fp16.onnx`, WebGPU EP.
- **NER**: `transformers.js` reads these from `env.localModelPath = "/models/"` with `env.allowRemoteModels = false`, so the extension never hits the network for weights.