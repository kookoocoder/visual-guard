# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from pathlib import Path
from typing import Any

import onnx
from ultralytics import YOLO

SOURCE = Path(__file__).parent / "has" / "sensitive_seg_best.pt"
TARGET = Path(__file__).parents[1] / "public" / "models" / "has" / "model.onnx"

if not SOURCE.exists():
    raise SystemExit(f"Missing source checkpoint: {SOURCE}")

exported = YOLO(str(SOURCE)).export(
    format="onnx",
    opset=12,
    simplify=False,
    nms=True,
    half=True,
    device="cpu",
)

exported = Path(str(exported))
model: Any = onnx.load(str(exported))

# Some exporter versions append the input Cast node after the graph body.
# Re-sort nodes so the graph is accepted by strict ONNX/WebGPU validators.
nodes: list[Any] = list(model.graph.node)
ordered: list[Any] = []
remaining = set(range(len(nodes)))
available = {value.name for value in model.graph.input}
available.update(value.name for value in model.graph.initializer)
while remaining:
    progressed = False
    for index in list(remaining):
        node = nodes[index]
        if all(name in available or name == "" for name in node.input):
            ordered.append(node)
            remaining.remove(index)
            available.update(node.output)
            progressed = True
    if not progressed:
        raise RuntimeError(f"Unable to topologically sort {len(remaining)} ONNX nodes")

del model.graph.node[:]
model.graph.node.extend(ordered)
onnx.checker.check_model(model)
TARGET.parent.mkdir(parents=True, exist_ok=True)
onnx.save(model, str(TARGET))
if exported.resolve() != TARGET.resolve():
    exported.unlink()

print(f"Wrote validated {TARGET}")
