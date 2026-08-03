"""Mask -> polygon extraction: exact pixel-boundary geometry, both backends."""

from __future__ import annotations

import numpy as np
import pytest
from shapely.geometry import Polygon
from shapely.ops import unary_union

from app.geo import BBox, GeoTransform
from app.polygonize import (
    HAS_RASTERIO,
    PolygonizeParams,
    extract_polygons,
    mask_to_features,
    polygon_iou,
)

BACKENDS = ["numpy"] + (["rasterio"] if HAS_RASTERIO else [])


@pytest.fixture(params=BACKENDS)
def backend(request) -> str:
    return request.param


class TestExtraction:
    def test_empty_mask(self, backend):
        assert extract_polygons(np.zeros((8, 8), dtype=bool), backend) == []

    def test_single_pixel_is_unit_square(self, backend):
        mask = np.zeros((5, 5), dtype=bool)
        mask[2, 3] = True
        polys = extract_polygons(mask, backend)
        assert len(polys) == 1
        assert polys[0].area == pytest.approx(1.0)
        assert set(map(tuple, polys[0].exterior.coords)) == {
            (3.0, 2.0),
            (4.0, 2.0),
            (4.0, 3.0),
            (3.0, 3.0),
        }

    def test_full_mask_is_bounding_rectangle(self, backend):
        polys = extract_polygons(np.ones((4, 7), dtype=bool), backend)
        assert len(polys) == 1
        assert polys[0].area == pytest.approx(28.0)
        assert len(polys[0].exterior.coords) - 1 == 4

    def test_two_separate_blobs(self, backend):
        mask = np.zeros((10, 10), dtype=bool)
        mask[1:3, 1:3] = True
        mask[6:9, 5:9] = True
        polys = extract_polygons(mask, backend)
        assert len(polys) == 2
        assert sorted(p.area for p in polys) == pytest.approx([4.0, 12.0])

    def test_diagonal_pixels_are_separate(self, backend):
        """4-connectivity: checkerboard diagonals do not merge."""
        mask = np.array([[True, False], [False, True]])
        polys = extract_polygons(mask, backend)
        assert len(polys) == 2
        for p in polys:
            assert p.area == pytest.approx(1.0)
            assert p.is_valid

    def test_donut_has_hole(self, backend):
        mask = np.ones((5, 5), dtype=bool)
        mask[2, 2] = False
        polys = extract_polygons(mask, backend)
        assert len(polys) == 1
        poly = polys[0]
        assert len(poly.interiors) == 1
        assert poly.area == pytest.approx(24.0)
        assert Polygon(poly.interiors[0]).area == pytest.approx(1.0)

    def test_nested_donuts(self, backend):
        """Ring inside the hole of a bigger ring resolves as two polygons."""
        mask = np.zeros((11, 11), dtype=bool)
        mask[1:10, 1:10] = True
        mask[3:8, 3:8] = False
        mask[5, 5] = True
        polys = extract_polygons(mask, backend)
        assert len(polys) == 2
        areas = sorted(p.area for p in polys)
        assert areas[0] == pytest.approx(1.0)
        assert areas[1] == pytest.approx(81.0 - 25.0)

    def test_int_mask_accepted(self, backend):
        mask = np.zeros((4, 4), dtype=np.uint8)
        mask[1:3, 1:3] = 1
        polys = extract_polygons(mask, backend)
        assert len(polys) == 1
        assert polys[0].area == pytest.approx(4.0)

    def test_non_2d_mask_rejected(self):
        with pytest.raises(ValueError):
            extract_polygons(np.zeros((2, 2, 3), dtype=bool), "numpy")

    def test_unknown_backend_rejected(self):
        with pytest.raises(ValueError):
            extract_polygons(np.zeros((2, 2), dtype=bool), "definitely-not-a-backend")


@pytest.mark.skipif(not HAS_RASTERIO, reason="rasterio not installed")
class TestBackendParity:
    def test_random_blobs_identical_geometry(self):
        rng = np.random.default_rng(7)
        for _ in range(5):
            mask = rng.random((24, 24)) > 0.6
            a = unary_union(extract_polygons(mask, "numpy"))
            b = unary_union(extract_polygons(mask, "rasterio"))
            assert a.symmetric_difference(b).area == pytest.approx(0.0, abs=1e-9)

    def test_donut_parity(self):
        mask = np.ones((9, 9), dtype=bool)
        mask[3:6, 3:6] = False
        a = unary_union(extract_polygons(mask, "numpy"))
        b = unary_union(extract_polygons(mask, "rasterio"))
        assert a.symmetric_difference(b).area == pytest.approx(0.0, abs=1e-9)


class TestGeoTransform:
    def test_from_bbox_corners(self):
        bbox = BBox(-98.0, 33.0, -97.9, 33.1)
        gt = GeoTransform.from_bbox(bbox, 100, 200)
        top_left = gt.px_to_world(np.array([[0.0, 0.0]]))[0]
        bottom_right = gt.px_to_world(np.array([[100.0, 200.0]]))[0]
        assert top_left == pytest.approx([-98.0, 33.1])
        assert bottom_right == pytest.approx([-97.9, 33.0])

    def test_world_to_px_roundtrip(self):
        gt = GeoTransform.from_bbox(BBox(-98.0, 33.0, -97.9, 33.1), 128, 64)
        px, py = gt.world_to_px(-97.95, 33.05)
        back = gt.px_to_world(np.array([[px, py]]))[0]
        assert back == pytest.approx([-97.95, 33.05])

    def test_dict_roundtrip(self):
        gt = GeoTransform.from_bbox(BBox(-98.0, 33.0, -97.9, 33.1), 10, 10)
        assert GeoTransform.from_dict(gt.to_dict()) == gt

    def test_features_in_world_coords(self):
        bbox = BBox(-98.0, 33.0, -97.99, 33.01)
        gt = GeoTransform.from_bbox(bbox, 50, 50)
        mask = np.zeros((50, 50), dtype=bool)
        mask[10:40, 10:40] = True
        feats = mask_to_features(mask, gt)
        assert len(feats) == 1
        ring = np.asarray(feats[0]["geometry"]["coordinates"][0])
        assert ring[:, 0].min() >= bbox.west - 1e-9
        assert ring[:, 0].max() <= bbox.east + 1e-9
        assert ring[:, 1].min() >= bbox.south - 1e-9
        assert ring[:, 1].max() <= bbox.north + 1e-9

    def test_geojson_ring_is_ccw(self):
        """GeoJSON right-hand rule: exterior CCW in lon/lat."""
        gt = GeoTransform.from_bbox(BBox(-98.0, 33.0, -97.99, 33.01), 40, 40)
        mask = np.zeros((40, 40), dtype=bool)
        mask[5:35, 5:35] = True
        ring = np.asarray(mask_to_features(mask, gt)[0]["geometry"]["coordinates"][0])
        x, y = ring[:-1, 0], ring[:-1, 1]
        signed = 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)
        assert signed > 0


class TestPipelineBasics:
    def test_min_area_filter_drops_specks(self):
        mask = np.zeros((20, 20), dtype=bool)
        mask[5:15, 5:15] = True
        mask[0, 0] = True  # 1-px speck
        feats = mask_to_features(mask, params=PolygonizeParams(min_area_px=4.0))
        assert len(feats) == 1
        assert feats[0]["properties"]["area_px"] == pytest.approx(100.0)

    def test_features_sorted_biggest_first(self):
        mask = np.zeros((40, 40), dtype=bool)
        mask[2:10, 2:10] = True
        mask[15:38, 15:38] = True
        feats = mask_to_features(mask)
        areas = [f["properties"]["area_px"] for f in feats]
        assert areas == sorted(areas, reverse=True)

    def test_every_feature_is_valid_geojson_polygon(self):
        rng = np.random.default_rng(21)
        mask = rng.random((48, 48)) > 0.55
        for feat in mask_to_features(mask):
            assert feat["type"] == "Feature"
            geom = feat["geometry"]
            assert geom["type"] == "Polygon"
            poly = Polygon(geom["coordinates"][0], geom["coordinates"][1:])
            assert poly.is_valid
            assert poly.area > 0

    def test_empty_mask_yields_no_features(self):
        assert mask_to_features(np.zeros((10, 10), dtype=bool)) == []


class TestIoUHelper:
    def test_identical(self):
        p = Polygon([(0, 0), (4, 0), (4, 4), (0, 4)])
        assert polygon_iou(p, p) == pytest.approx(1.0)

    def test_disjoint(self):
        a = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])
        b = Polygon([(5, 5), (6, 5), (6, 6), (5, 6)])
        assert polygon_iou(a, b) == 0.0

    def test_half_overlap(self):
        a = Polygon([(0, 0), (2, 0), (2, 1), (0, 1)])
        b = Polygon([(1, 0), (3, 0), (3, 1), (1, 1)])
        assert polygon_iou(a, b) == pytest.approx(1.0 / 3.0)
