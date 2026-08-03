"""SAM 2 predictor wrapper — all heavy imports (torch, sam2) are lazy.

Nothing in this module imports torch at module import time. The real
predictor loads only when (a) a checkpoint file exists at
``SAM2_CHECKPOINT`` and (b) a model-touching endpoint is actually hit.
Without weights, endpoints answer 503 with an actionable message, and the
whole test suite runs against :class:`~tests.conftest.FakePredictor`.

The embedding is passed around as a flat ``dict[str, np.ndarray]`` so it
survives ``np.savez`` round-trips through the object-store cache:

    image_embed            (1, C, H', W') image embedding
    high_res_feats_0/1     SAM 2 high-resolution feature maps
"""

from __future__ import annotations

import os
from typing import Any, Callable, Protocol

import numpy as np

from .config import Settings


class ModelUnavailable(RuntimeError):
    """SAM 2 weights are not present in this deployment."""


class Predictor(Protocol):
    def embed(self, image: np.ndarray) -> dict[str, np.ndarray]: ...

    def decode(
        self,
        embedding: dict[str, np.ndarray],
        out_hw: tuple[int, int],
        points_px: list[tuple[float, float]] | None = None,
        point_labels: list[int] | None = None,
        box_px: tuple[float, float, float, float] | None = None,
    ) -> np.ndarray: ...


PredictorProvider = Callable[[], Predictor]


class Sam2Predictor:
    """Real SAM 2 predictor. Instantiated only when weights exist.

    NOTE: ``embed``/``decode`` split ``SAM2ImagePredictor.set_image`` +
    ``predict`` across requests by serializing the predictor's computed
    features. That touches ``_features``/``_orig_hw`` internals of the sam2
    package (pinned in the Modal image); exercised only on Modal where the
    weights live — the interface is what local tests verify. [VERIFY on
    first Modal deploy.]
    """

    def __init__(self, checkpoint: str, model_cfg: str, device: str | None = None) -> None:
        import torch  # heavy import, deliberately inside
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        self._torch = torch
        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self._predictor = SAM2ImagePredictor(build_sam2(model_cfg, checkpoint, device=device))

    def embed(self, image: np.ndarray) -> dict[str, np.ndarray]:
        self._predictor.set_image(image)
        feats = self._predictor._features
        out: dict[str, np.ndarray] = {
            "image_embed": feats["image_embed"].detach().cpu().numpy(),
        }
        for i, hr in enumerate(feats["high_res_feats"]):
            out[f"high_res_feats_{i}"] = hr.detach().cpu().numpy()
        out["orig_h"] = np.array([image.shape[0]], dtype=np.int64)
        out["orig_w"] = np.array([image.shape[1]], dtype=np.int64)
        return out

    def decode(
        self,
        embedding: dict[str, np.ndarray],
        out_hw: tuple[int, int],
        points_px: list[tuple[float, float]] | None = None,
        point_labels: list[int] | None = None,
        box_px: tuple[float, float, float, float] | None = None,
    ) -> np.ndarray:
        torch = self._torch
        pred = self._predictor
        device = self.device

        hr_keys = sorted(k for k in embedding if k.startswith("high_res_feats_"))
        pred._features = {
            "image_embed": torch.from_numpy(embedding["image_embed"]).to(device),
            "high_res_feats": [
                torch.from_numpy(embedding[k]).to(device) for k in hr_keys
            ],
        }
        h = int(embedding.get("orig_h", np.array([out_hw[0]]))[0])
        w = int(embedding.get("orig_w", np.array([out_hw[1]]))[0])
        pred._orig_hw = [(h, w)]
        pred._is_image_set = True

        point_coords = np.array(points_px, dtype=np.float32) if points_px else None
        labels = (
            np.array(point_labels, dtype=np.int64)
            if point_labels is not None
            else (np.ones(len(points_px), dtype=np.int64) if points_px else None)
        )
        box = np.array(box_px, dtype=np.float32) if box_px else None

        masks, ious, _ = pred.predict(
            point_coords=point_coords,
            point_labels=labels,
            box=box,
            multimask_output=True,
        )
        best = int(np.argmax(ious))
        return np.asarray(masks[best]).astype(bool)


def default_predictor_provider(settings: Settings) -> PredictorProvider:
    """Lazy singleton provider; raises ModelUnavailable without weights."""
    holder: dict[str, Any] = {}

    def provide() -> Predictor:
        if "predictor" not in holder:
            ckpt = settings.sam2_checkpoint
            if not ckpt or not os.path.isfile(ckpt):
                raise ModelUnavailable(
                    "SAM 2 checkpoint not present "
                    f"(SAM2_CHECKPOINT={ckpt!r}). Deploy with weights (see "
                    "modal_app.py::download_weights) or point SAM2_CHECKPOINT "
                    "at a local .pt file."
                )
            holder["predictor"] = Sam2Predictor(
                ckpt, settings.sam2_model_cfg, settings.sam2_device
            )
        return holder["predictor"]

    return provide
