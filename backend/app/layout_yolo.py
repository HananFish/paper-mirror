"""DocLayout-YOLO 版面检测：轻量（28MB 权重）学术文档区域划分。

在 CPU 上约 0.5–1.5s/页；模型不可用时调用方应回退到启发式区域检测。
类别（docstructbench 权重）：title / plain text / abandon / figure /
figure_caption / table / table_caption / table_footnote / isolate_formula / formula_caption
（以 model.names 实际输出为准）。
"""
from __future__ import annotations

from pathlib import Path
from threading import RLock

from .config import DATA_DIR

WEIGHTS_PATH = DATA_DIR / "models" / "layout" / "doclayout_yolo_docstructbench_imgsz1024.pt"

# 视为"图形内容"的类别（其中文字不进入翻译管线）
FIGURE_CLASSES = {"figure", "figure_caption", "table", "table_caption", "table_footnote"}
# 公式区域同样抑制（isolate_formula / formula_caption）
FORMULA_CLASSES = {"isolate_formula", "formula_caption"}

_model = None
_model_lock = RLock()


def _load_model():
    global _model
    if _model is not None:
        return _model
    if not WEIGHTS_PATH.exists():
        return None
    try:
        from doclayout_yolo import YOLOv10  # type: ignore

        _model = YOLOv10(str(WEIGHTS_PATH))
        return _model
    except Exception:
        return None


def _get_model():
    with _model_lock:
        return _load_model()


def _detect_doclayout(pdf_page, dpi: int = 130) -> list[dict] | None:
    """对 PDF 页面运行版面检测。

    返回 [{"name": 类别名, "bbox": (x0, y0, x1, y1), "conf": float}]（PDF pt 坐标），
    模型不可用时返回 None（调用方回退启发式）。
    """
    model = _get_model()
    if model is None:
        return None
    try:
        import numpy as np

        pix = pdf_page.get_pixmap(dpi=dpi)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:
            img = img[:, :, :3]
        scale = 72.0 / dpi
        # Ultralytics mutates its shared predictor. Different document jobs can
        # run concurrently, so serialize inference as well as model creation.
        with _model_lock:
            results = model.predict(img, imgsz=1024, conf=0.25, device="cpu", verbose=False)
        out: list[dict] = []
        for r in results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                name = str(model.names.get(cls_id, cls_id))
                x0, y0, x1, y1 = (float(v) * scale for v in box.xyxy[0])
                out.append({"name": name, "bbox": (x0, y0, x1, y1), "conf": float(box.conf[0])})
        return out
    except Exception:
        return None


def detect_layout(pdf_page, dpi: int = 130) -> list[dict] | None:
    import os
    from .model_adapters import create_adapter
    return create_adapter('layout', os.environ.get('LAYOUT_ADAPTER', 'doclayout'), {}, {})(pdf_page, dpi)


def is_available() -> bool:
    return WEIGHTS_PATH.exists() and _get_model() is not None
