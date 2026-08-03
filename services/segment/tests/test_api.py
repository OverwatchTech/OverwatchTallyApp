"""API tests: full /embed -> /segment path with stub imagery + fake predictor.

Model-free by design; the one test that exercises the real provider asserts
the honest 503 when weights are absent.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.config import Settings
from app.main import create_app

BBOX = [-98.505, 33.500, -98.500, 33.504]
CENTER = [(-98.505 + -98.500) / 2, (33.500 + 33.504) / 2]


def embed(client, **overrides):
    body = {"farm_id": "farm-1", "bbox": BBOX, **overrides}
    return client.post("/embed", json=body)


class TestHealthz:
    def test_ok(self, client):
        resp = client.get("/healthz")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["naip_source"] == "stub"
        assert body["model_configured"] is False


class TestEmbed:
    def test_embed_returns_key_and_caches(self, client, fake_predictor):
        first = embed(client)
        assert first.status_code == 200
        body = first.json()
        assert body["cached"] is False
        assert body["embedding_key"].startswith("farm-1/latest/")
        assert body["image"]["width"] > 0 and body["image"]["height"] > 0
        assert fake_predictor.embed_calls == 1

        second = embed(client)
        assert second.status_code == 200
        assert second.json()["cached"] is True
        assert second.json()["embedding_key"] == body["embedding_key"]
        assert fake_predictor.embed_calls == 1  # embedding computed once

    def test_imagery_date_partitions_cache(self, client, fake_predictor):
        a = embed(client, imagery_date="2022-06-01").json()
        b = embed(client, imagery_date="2023-06-01").json()
        assert a["embedding_key"] != b["embedding_key"]
        assert fake_predictor.embed_calls == 2

    @pytest.mark.parametrize(
        "bad_bbox",
        [
            [-97.9, 33.0, -98.0, 33.1],  # west > east
            [-98.0, 33.1, -97.9, 33.0],  # south > north
            [-98.0, 33.0, -97.9],  # wrong arity
        ],
    )
    def test_invalid_bbox_rejected(self, client, bad_bbox):
        resp = client.post("/embed", json={"farm_id": "f", "bbox": bad_bbox})
        assert resp.status_code == 422

    def test_oversized_bbox_rejected(self, client):
        resp = client.post(
            "/embed", json={"farm_id": "f", "bbox": [-98.5, 33.0, -98.0, 33.4]}
        )
        assert resp.status_code == 422
        assert "bbox too large" in resp.json()["detail"]

    @pytest.mark.parametrize("farm_id", ["", "has space", "semi;colon", "a" * 65])
    def test_invalid_farm_id_rejected(self, client, farm_id):
        resp = client.post("/embed", json={"farm_id": farm_id, "bbox": BBOX})
        assert resp.status_code == 422

    def test_year_vintage_accepted(self, client):
        resp = embed(client, imagery_date="2022")
        assert resp.status_code == 200
        assert resp.json()["embedding_key"].startswith("farm-1/2022/")

    def test_invalid_date_rejected(self, client):
        resp = embed(client, imagery_date="June 2023")
        assert resp.status_code == 422


class TestSegment:
    def test_click_to_polygon(self, client, fake_predictor):
        key = embed(client).json()["embedding_key"]
        resp = client.post(
            "/segment", json={"embedding_key": key, "points": [CENTER]}
        )
        assert resp.status_code == 200
        fc = resp.json()
        assert fc["type"] == "FeatureCollection"
        assert len(fc["features"]) >= 1
        assert fc["meta"]["mask_area_px"] > 0
        assert fake_predictor.decode_calls == 1

        feat = fc["features"][0]
        assert feat["geometry"]["type"] == "Polygon"
        props = feat["properties"]
        assert isinstance(props["regularized"], bool)
        assert props["n_vertices"] >= 3

        # polygon lands inside the embedded bbox, in lon/lat
        ring = np.asarray(feat["geometry"]["coordinates"][0])
        w, s, e, n = BBOX
        assert ring[:, 0].min() >= w - 1e-6 and ring[:, 0].max() <= e + 1e-6
        assert ring[:, 1].min() >= s - 1e-6 and ring[:, 1].max() <= n + 1e-6

    def test_fake_rectangle_comes_back_regularized(self, client):
        """End-to-end: the fake decoder paints a rotated rectangle; the
        pipeline must return it as a clean 4-corner polygon."""
        key = embed(client).json()["embedding_key"]
        fc = client.post(
            "/segment", json={"embedding_key": key, "points": [CENTER]}
        ).json()
        main = fc["features"][0]
        assert main["properties"]["regularized"] is True
        assert main["properties"]["n_vertices"] == 4

    def test_box_prompt(self, client):
        key = embed(client).json()["embedding_key"]
        w, s, e, n = BBOX
        third_w, third_h = (e - w) / 3, (n - s) / 3
        box = [w + third_w, s + third_h, e - third_w, n - third_h]
        resp = client.post("/segment", json={"embedding_key": key, "box": box})
        assert resp.status_code == 200
        assert len(resp.json()["features"]) >= 1

    def test_unknown_key_404(self, client):
        resp = client.post(
            "/segment",
            json={"embedding_key": "farm-1/latest/deadbeef", "points": [CENTER]},
        )
        assert resp.status_code == 404

    def test_no_prompts_rejected(self, client):
        key = embed(client).json()["embedding_key"]
        resp = client.post("/segment", json={"embedding_key": key})
        assert resp.status_code == 422

    def test_point_outside_bbox_rejected(self, client):
        key = embed(client).json()["embedding_key"]
        resp = client.post(
            "/segment", json={"embedding_key": key, "points": [[-99.5, 33.5]]}
        )
        assert resp.status_code == 422
        assert "outside" in resp.json()["detail"]

    def test_mismatched_labels_rejected(self, client):
        key = embed(client).json()["embedding_key"]
        resp = client.post(
            "/segment",
            json={"embedding_key": key, "points": [CENTER], "point_labels": [1, 0]},
        )
        assert resp.status_code == 422


class TestModelUnavailable:
    def test_embed_503_without_weights(self, tmp_path):
        from fastapi.testclient import TestClient

        settings = Settings(
            naip_source="stub",
            cache_dir=str(tmp_path / "cache"),
            sam2_checkpoint=str(tmp_path / "not-there.pt"),
        )
        with TestClient(create_app(settings=settings)) as c:
            resp = c.post("/embed", json={"farm_id": "f", "bbox": BBOX})
            assert resp.status_code == 503
            assert "SAM 2 checkpoint" in resp.json()["detail"]


class TestAuth:
    def test_bearer_token_enforced_when_configured(self, tmp_path, fake_predictor):
        from fastapi.testclient import TestClient

        settings = Settings(
            naip_source="stub", cache_dir=str(tmp_path / "cache"), api_token="sekrit"
        )
        app = create_app(settings=settings, predictor_provider=lambda: fake_predictor)
        with TestClient(app) as c:
            denied = c.post("/embed", json={"farm_id": "f", "bbox": BBOX})
            assert denied.status_code == 401
            ok = c.post(
                "/embed",
                json={"farm_id": "f", "bbox": BBOX},
                headers={"Authorization": "Bearer sekrit"},
            )
            assert ok.status_code == 200
            # healthz stays open for probes
            assert c.get("/healthz").status_code == 200
