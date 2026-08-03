"""Shared fixtures: fake predictor + app factory wiring (no model, no network)."""

from __future__ import annotations

import numpy as np
import pytest

from app.config import Settings

from .synth import rasterize, rect_coords


class FakePredictor:
    """Model-free stand-in for SAM 2.

    ``embed`` returns a small deterministic array dict; ``decode`` paints a
    rotated rectangle around the first click point (or box center) so the
    full mask -> polygon -> GeoJSON path runs for real.
    """

    def __init__(self, rect_angle_deg: float = 15.0) -> None:
        self.rect_angle_deg = rect_angle_deg
        self.embed_calls = 0
        self.decode_calls = 0

    def embed(self, image: np.ndarray) -> dict[str, np.ndarray]:
        self.embed_calls += 1
        return {
            "image_embed": np.zeros((1, 8, 4, 4), dtype=np.float32),
            "high_res_feats_0": np.zeros((1, 4, 8, 8), dtype=np.float32),
            "orig_h": np.array([image.shape[0]], dtype=np.int64),
            "orig_w": np.array([image.shape[1]], dtype=np.int64),
        }

    def decode(
        self,
        embedding: dict[str, np.ndarray],
        out_hw: tuple[int, int],
        points_px=None,
        point_labels=None,
        box_px=None,
    ) -> np.ndarray:
        self.decode_calls += 1
        h, w = out_hw
        if points_px:
            cx, cy = points_px[0]
        elif box_px:
            cx = (box_px[0] + box_px[2]) / 2
            cy = (box_px[1] + box_px[3]) / 2
        else:  # pragma: no cover - API validates prompts before decode
            cx, cy = w / 2, h / 2
        rw = max(8.0, w / 3.0)
        rh = max(6.0, h / 5.0)
        return rasterize(rect_coords(cx, cy, rw, rh, self.rect_angle_deg), (h, w))


@pytest.fixture()
def fake_predictor() -> FakePredictor:
    return FakePredictor()


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return Settings(naip_source="stub", cache_dir=str(tmp_path / "embed-cache"))


@pytest.fixture()
def client(settings, fake_predictor):
    from fastapi.testclient import TestClient

    from app.main import create_app

    app = create_app(settings=settings, predictor_provider=lambda: fake_predictor)
    with TestClient(app) as c:
        yield c
