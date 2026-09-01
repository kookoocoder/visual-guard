"""Export HaS YOLO11-seg checkpoint to browser-ready FP16 ONNX.

Per the design doc 3.5: download the FP32 .pt, export to ONNX with NMS
baked into the graph, convert to FP16. Run from the project root:

    uv run scripts/export-has.py

Requires the `scripts/.venv` created with ultralytics installed.
"""

import requests
from pathlib import Path
from ultralytics import YOLO
import onnx

REPO = "https://huggingface.co/xuanwulab/HaS_Image_0209_FP32/resolve/main/"
CKPT_URL = REPO + "sensitive_seg_best.pt?download=true"
CKPT = Path("scripts/.cache/sensitive_seg_best.pt")
ONNX_FP16 = Path("public/models/has_seg_fp16.onnx")
ONNX_STAGE = Path("scripts/.cache/has_seg_stage.onnx")


def fetch():
    if CKPT.exists():
        print(f"cache hit {CKPT}")
        return
    CKPT.parent.mkdir(parents=True, exist_ok=True)
    r = requests.get(CKPT_URL, stream=True)
    r.raise_for_status()
    with open(CKPT, "wb") as f:
        for chunk in r.iter_content(chunk_size=1 << 20):
            f.write(chunk)
    print(f"downloaded {CKPT} ({CKPT.stat().st_size / 1e6:.0f} MB)")


def export():
    model = YOLO(str(CKPT))
    task = getattr(model, "task", "segment")
    print(f"task: {task}")
    kwargs = dict(format="onnx", opset=12, simplify=True, imgsz=640, half=True)
    try:
        kwargs["nms"] = True
        path = model.export(**kwargs)
        print("exported with NMS baked in, FP16")
    except Exception as e:
        print(f"NMS export failed ({e}); falling back to plain export")
        kwargs.pop("nms")
        path = model.export(**kwargs)
    p = Path(path)
    if p.suffix == ".onnx" and p.exists():
        p.rename(ONNX_STAGE)
        print(f"stage onnx -> {ONNX_STAGE} ({ONNX_STAGE.stat().st_size / 1e6:.1f} MB)")


def to_fp16():
    efficient_fp16 = onnx.shape_inference.infer_shapes(onnx.load(str(ONNX_STAGE)))
    ONNX_FP16.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(efficient_fp16, str(ONNX_FP16))
    print(f"saved {ONNX_FP16} ({ONNX_FP16.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    fetch()
    export()
    to_fp16()