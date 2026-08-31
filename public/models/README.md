# Packaged browser models

Model weights are **not** checked into this repository. Download or generate them locally, then place the files under:

```text
public/models/privacy-filter/
public/models/has/model.onnx
```

## Text model

Download the Transformers.js-compatible assets for `openai/privacy-filter` (`q4f16` ONNX graph, external tensor data, tokenizer, and config) into `public/models/privacy-filter/`. The side panel forces `local_files_only: true`, so text inference does not download model weights at runtime.

## Image model

`public/models/has/model.onnx` is generated from `xuanwulab/HaS_Image_0209_FP32` with:

- YOLO11-seg
- opset 12
- NMS enabled
- strict ONNX topological ordering repair (the latest slimming pass emitted an invalid node order)
- FP16 weights

The extension loads this graph through ONNX Runtime Web's `webgpu` execution provider. Place the source checkpoint at `tools/has/sensitive_seg_best.pt` and run `tools/export-has.py` to produce the browser-ready ONNX graph.
