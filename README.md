# Visual Guard — Privacy Agent Extension

A Manifest V3 browser extension implementing the client-side portion of `on-device-visual-perception-design.md`.

The current slice is deliberately client-only:

- A Chrome side panel provides an interactive, visual test bench.
- The local text privacy model is packaged as Transformers.js-compatible `q4f16` ONNX + external data and runs with WebGPU.
- The HaS image privacy model is packaged as a locally exported FP16 ONNX graph and runs with ONNX Runtime Web + WebGPU.
- A content script exposes the redaction-aware browser tool contract.
- If WebGPU or a packaged model fails, the UI reports the real error and withholds the frame/text instead of showing mock or unredacted output.
- The server-side DeepSeek agent is not included yet.

## Run

```bash
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/`.

## Model assets

Model weights are not included in the repository. Before running the extension, download or generate the required files into `public/models/`:

- `public/models/privacy-filter/` — `openai/privacy-filter`, local `q4f16` ONNX graph, tokenizer, config, and external tensor data.
- `public/models/has/model.onnx` — HaS YOLO11-seg checkpoint converted to valid FP16 ONNX with opset 12 and NMS enabled; the final graph is topologically repaired for browser runtimes.

See `public/models/README.md` and `tools/export-has.py` for download and conversion instructions. The extension does not use a mock model path; a failure is visible as an error and the sensitive output is withheld.
