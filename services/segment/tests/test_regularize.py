"""Orthogonal regularization: rectangles come back rectilinear, curves
pass through untouched, and topology is never mangled."""

from __future__ import annotations

import numpy as np
import pytest
from shapely.geometry import Polygon

from app.polygonize import (
    PolygonizeParams,
    RegularizeParams,
    dominant_angle,
    mask_to_features,
    polygon_iou,
    regularize_polygon,
)

from .synth import (
    circ_diff_mod90,
    circle_coords,
    corner_count,
    edge_angles_mod90,
    ellipse_coords,
    exterior_ring,
    flip_boundary_pixels,
    geojson_polygon,
    l_coords,
    octagon_coords,
    rasterize,
    rect_coords,
    truth_polygon,
)

SHAPE = (160, 160)
CENTER = (80.0, 80.0)


def run_pipeline(mask: np.ndarray):
    return mask_to_features(mask, params=PolygonizeParams())


class TestDominantAngle:
    @pytest.mark.parametrize("angle", [0.0, 10.0, 30.0, 45.0, 60.0, 77.5, 89.0])
    def test_recovers_rectangle_angle(self, angle):
        ring = rect_coords(*CENTER, 60, 35, angle)
        theta, frac = dominant_angle([ring], RegularizeParams())
        assert circ_diff_mod90(theta, angle % 90.0) < 0.5
        assert frac == pytest.approx(1.0)

    def test_circle_has_low_ortho_fraction(self):
        ring = circle_coords(*CENTER, 40, n=120)
        _, frac = dominant_angle([ring], RegularizeParams())
        assert frac < 0.45

    def test_weighted_by_edge_length(self):
        """Two long edges at 20 deg dominate many short edges at 65 deg."""
        long_v = np.array([np.cos(np.radians(20.0)), np.sin(np.radians(20.0))]) * 100
        short_v = np.array([np.cos(np.radians(65.0)), np.sin(np.radians(65.0))]) * 2
        pts = [np.array([0.0, 0.0])]
        pts.append(pts[-1] + long_v)
        for _ in range(5):
            pts.append(pts[-1] + short_v)
        pts.append(pts[-1] - long_v * 0.9)
        ring = np.array(pts)
        theta, _ = dominant_angle([ring], RegularizeParams())
        assert circ_diff_mod90(theta, 20.0) < 3.0

    def test_empty_input(self):
        theta, frac = dominant_angle([], RegularizeParams())
        assert theta == 0.0
        assert frac == 0.0


class TestRotatedRectangles:
    @pytest.mark.parametrize("angle", [0.0, 13.5, 30.0, 45.0, 67.0, 81.0])
    def test_recovered_as_clean_rectangle(self, angle):
        coords = rect_coords(*CENTER, 62, 38, angle)
        mask = rasterize(coords, SHAPE)
        feats = run_pipeline(mask)
        assert len(feats) == 1
        feat = feats[0]
        assert feat["properties"]["regularized"] is True

        # exactly 4 corners
        assert corner_count(feat["geometry"]) == 4

        # right angles: every edge on one of two perpendicular axes
        ring = exterior_ring(feat["geometry"])
        angles, _ = edge_angles_mod90(ring)
        spread = max(circ_diff_mod90(a, float(angles[0])) for a in angles)
        assert spread < 0.75

        # rotation recovered
        assert circ_diff_mod90(float(angles[0]), angle % 90.0) < 1.5

        # geometry matches ground truth
        iou = polygon_iou(geojson_polygon(feat["geometry"]), truth_polygon(coords))
        assert iou > 0.95

    @pytest.mark.parametrize("size", [(20, 12), (100, 30), (58, 58)])
    def test_various_sizes(self, size):
        w, h = size
        coords = rect_coords(*CENTER, w, h, 25.0)
        feats = run_pipeline(rasterize(coords, SHAPE))
        assert len(feats) == 1
        assert feats[0]["properties"]["regularized"] is True
        assert corner_count(feats[0]["geometry"]) == 4
        assert polygon_iou(
            geojson_polygon(feats[0]["geometry"]), truth_polygon(coords)
        ) > 0.93

    @pytest.mark.parametrize("seed", [3, 11])
    def test_survives_boundary_noise(self, seed):
        coords = rect_coords(*CENTER, 64, 40, 30.0)
        mask = flip_boundary_pixels(rasterize(coords, SHAPE), fraction=0.05, seed=seed)
        feats = run_pipeline(mask)
        main = feats[0]  # specks from noise may add tiny extra features
        assert main["properties"]["regularized"] is True
        assert corner_count(main["geometry"]) == 4
        ring = exterior_ring(main["geometry"])
        angles, _ = edge_angles_mod90(ring)
        assert circ_diff_mod90(float(angles[0]), 30.0) < 3.0
        assert polygon_iou(geojson_polygon(main["geometry"]), truth_polygon(coords)) > 0.90

    def test_idempotent_on_axis_aligned_rectangle(self):
        coords = rect_coords(*CENTER, 60, 30, 0.0)
        feats = run_pipeline(rasterize(coords, SHAPE))
        assert corner_count(feats[0]["geometry"]) == 4
        assert polygon_iou(
            geojson_polygon(feats[0]["geometry"]), truth_polygon(coords)
        ) > 0.97


class TestLShapes:
    @pytest.mark.parametrize("angle", [0.0, 20.0, 48.0])
    def test_l_keeps_six_corners(self, angle):
        coords = l_coords(*CENTER, big=80, arm=34, angle_deg=angle)
        feats = run_pipeline(rasterize(coords, SHAPE))
        assert len(feats) == 1
        feat = feats[0]
        assert feat["properties"]["regularized"] is True
        assert corner_count(feat["geometry"]) == 6
        assert polygon_iou(geojson_polygon(feat["geometry"]), truth_polygon(coords)) > 0.93

    def test_l_edges_all_orthogonal(self):
        coords = l_coords(*CENTER, big=80, arm=30, angle_deg=20.0)
        feat = run_pipeline(rasterize(coords, SHAPE))[0]
        ring = exterior_ring(feat["geometry"])
        angles, _ = edge_angles_mod90(ring)
        spread = max(circ_diff_mod90(a, float(angles[0])) for a in angles)
        assert spread < 0.75


class TestCurvedFeaturesUntouched:
    def test_circle_not_regularized(self):
        coords = circle_coords(*CENTER, 45, n=120)
        feats = run_pipeline(rasterize(coords, SHAPE))
        assert len(feats) == 1
        feat = feats[0]
        assert feat["properties"]["regularized"] is False
        assert corner_count(feat["geometry"]) >= 16  # still round, not squared off
        assert polygon_iou(geojson_polygon(feat["geometry"]), truth_polygon(coords)) > 0.95

    @pytest.mark.parametrize("angle", [0.0, 30.0])
    def test_ellipse_not_regularized(self, angle):
        coords = ellipse_coords(*CENTER, 55, 28, angle_deg=angle, n=120)
        feat = run_pipeline(rasterize(coords, SHAPE))[0]
        assert feat["properties"]["regularized"] is False
        assert polygon_iou(geojson_polygon(feat["geometry"]), truth_polygon(coords)) > 0.95

    def test_octagon_diagonals_survive(self):
        """45-deg edges are outside snap tolerance: shape keeps ~8 corners
        and high fidelity whether or not regularization applied."""
        coords = octagon_coords(*CENTER, 50)
        feat = run_pipeline(rasterize(coords, SHAPE))[0]
        assert 8 <= corner_count(feat["geometry"]) <= 12
        assert polygon_iou(geojson_polygon(feat["geometry"]), truth_polygon(coords)) > 0.93


class TestTopologyPreservation:
    def test_holes_preserved_and_regularized(self):
        outer = rect_coords(*CENTER, 90, 70, 18.0)
        inner = rect_coords(*CENTER, 40, 26, 18.0)
        mask = rasterize(outer, SHAPE) & ~rasterize(inner, SHAPE)
        feats = run_pipeline(mask)
        assert len(feats) == 1
        geom = feats[0]["geometry"]
        assert len(geom["coordinates"]) == 2  # shell + one hole
        assert feats[0]["properties"]["regularized"] is True
        assert corner_count(geom) == 4
        assert len(geom["coordinates"][1]) - 1 == 4
        truth = Polygon(outer, [inner])
        assert polygon_iou(geojson_polygon(geom), truth) > 0.93

    def test_output_always_valid_on_adversarial_zigzag(self):
        """Thin sawtooth comb: whatever the regularizer decides, the result
        must be valid geometry with honest fidelity to the mask."""
        mask = np.zeros(SHAPE, dtype=bool)
        mask[40:120, 20:24] = True
        for k in range(8):
            mask[40 + k * 10 : 44 + k * 10, 24 : 60 + (k % 3) * 12] = True
        feats = run_pipeline(mask)
        assert feats
        for feat in feats:
            poly = geojson_polygon(feat["geometry"])
            assert poly.is_valid
            assert poly.area > 0

    def test_rejection_falls_back_to_simplified_input(self):
        """Force min_iou impossibly high: regularization must decline and
        return the unregularized polygon rather than a mangled one."""
        coords = rect_coords(*CENTER, 60, 40, 30.0)
        params = PolygonizeParams(
            regularize=RegularizeParams(min_iou=1.01)  # unreachable
        )
        feats = mask_to_features(rasterize(coords, SHAPE), params=params)
        feat = feats[0]
        assert feat["properties"]["regularized"] is False
        assert polygon_iou(geojson_polygon(feat["geometry"]), truth_polygon(coords)) > 0.9

    def test_regularize_polygon_direct_rejects_low_fidelity(self):
        poly = Polygon(rect_coords(*CENTER, 60, 40, 15.0))
        out, info = regularize_polygon(poly, RegularizeParams(min_iou=1.01))
        assert out is poly
        assert info["applied"] is False
        assert info["reason"] == "low_fidelity"

    def test_regularize_polygon_direct_applies_on_clean_rect(self):
        poly = Polygon(rect_coords(*CENTER, 60, 40, 15.0))
        out, info = regularize_polygon(poly)
        assert info["applied"] is True
        assert info["reg_iou"] > 0.95
        assert len(out.exterior.coords) - 1 == 4

    def test_triangle_too_diagonal_left_alone(self):
        """A 30-60-90 triangle has a legitimate long diagonal; the diagonal
        must survive (never squared off into a staircase)."""
        coords = np.array([[30.0, 30.0], [130.0, 30.0], [30.0, 110.0]])
        feat = run_pipeline(rasterize(coords, SHAPE))[0]
        poly = geojson_polygon(feat["geometry"])
        assert poly.is_valid
        assert polygon_iou(poly, truth_polygon(coords)) > 0.93
        # 3 corners kept (give or take a chamfer at most)
        assert corner_count(feat["geometry"]) <= 5


class TestParameterGates:
    def test_min_ortho_fraction_gate(self):
        """Raising the gate above 1.0 blocks even perfect rectangles."""
        poly = Polygon(rect_coords(*CENTER, 60, 40, 15.0))
        out, info = regularize_polygon(
            poly, RegularizeParams(min_ortho_fraction=1.01)
        )
        assert info["applied"] is False
        assert info["reason"] == "below_ortho_threshold"
        assert out is poly

    def test_snap_tolerance_controls_reach(self):
        """A parallelogram skewed 8 deg off square: within a 12-deg snap
        tolerance both edge families snap (regularizes to a rectangle);
        with a 4-deg tolerance only one family qualifies, the orthogonality
        fraction collapses to ~0.5, and the shape is left alone."""
        skew = np.array(
            [[0.0, 0.0], [60.0, 0.0], [68.35, 59.41], [8.35, 59.41]]
        )  # sides are 60 px at 82 deg — 8 deg off vertical
        poly = Polygon(skew)
        out_wide, info_wide = regularize_polygon(
            poly, RegularizeParams(snap_tol_deg=12.0, min_iou=0.7)
        )
        _, info_narrow = regularize_polygon(
            poly, RegularizeParams(snap_tol_deg=4.0)
        )
        assert info_wide["applied"] is True
        angles, _ = edge_angles_mod90(np.asarray(out_wide.exterior.coords)[:-1])
        spread = max(circ_diff_mod90(a, float(angles[0])) for a in angles)
        assert spread < 0.5  # snapped square
        assert info_narrow["applied"] is False
        assert info_narrow["reason"] == "below_ortho_threshold"

    def test_degenerate_polygon_survives(self):
        tiny = Polygon([(0, 0), (1, 0), (1, 1)])
        out, info = regularize_polygon(tiny)
        assert info["applied"] is False
        assert out is tiny
