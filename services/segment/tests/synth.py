"""Synthetic shapes + rasterization for model-free pipeline tests.

Pure numpy: shapes are defined as vertex lists in pixel coords (x=col,
y=row) and rasterized with a vectorized crossing-number test at pixel
centers, so ground truth and mask share exactly the same geometry.
"""

from __future__ import annotations

import math

import numpy as np
from shapely.geometry import Polygon


def rotate_pts(pts: np.ndarray, angle_deg: float, center: tuple[float, float]) -> np.ndarray:
    t = math.radians(angle_deg)
    c, s = math.cos(t), math.sin(t)
    arr = np.asarray(pts, dtype=float) - center
    out = np.empty_like(arr)
    out[:, 0] = arr[:, 0] * c - arr[:, 1] * s
    out[:, 1] = arr[:, 0] * s + arr[:, 1] * c
    return out + center


def rect_coords(
    cx: float, cy: float, w: float, h: float, angle_deg: float = 0.0
) -> np.ndarray:
    base = np.array(
        [
            [cx - w / 2, cy - h / 2],
            [cx + w / 2, cy - h / 2],
            [cx + w / 2, cy + h / 2],
            [cx - w / 2, cy + h / 2],
        ]
    )
    return rotate_pts(base, angle_deg, (cx, cy))


def l_coords(
    cx: float, cy: float, big: float, arm: float, angle_deg: float = 0.0
) -> np.ndarray:
    """L-shape: big x big square with a (big-arm) notch removed. 6 corners."""
    base = np.array(
        [
            [0.0, 0.0],
            [big, 0.0],
            [big, arm],
            [arm, arm],
            [arm, big],
            [0.0, big],
        ]
    )
    base += (cx - big / 2, cy - big / 2)
    return rotate_pts(base, angle_deg, (cx, cy))


def circle_coords(cx: float, cy: float, r: float, n: int = 90) -> np.ndarray:
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    return np.stack([cx + r * np.cos(t), cy + r * np.sin(t)], axis=1)


def ellipse_coords(
    cx: float, cy: float, a: float, b: float, angle_deg: float = 0.0, n: int = 90
) -> np.ndarray:
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    pts = np.stack([cx + a * np.cos(t), cy + b * np.sin(t)], axis=1)
    return rotate_pts(pts, angle_deg, (cx, cy))


def octagon_coords(cx: float, cy: float, r: float) -> np.ndarray:
    t = np.radians(np.arange(8) * 45.0 + 22.5)
    return np.stack([cx + r * np.cos(t), cy + r * np.sin(t)], axis=1)


def rasterize(coords: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """Polygon (pixel-corner coords) -> bool mask via crossing number
    at pixel centers."""
    h, w = shape
    ys, xs = np.mgrid[0:h, 0:w]
    px = xs + 0.5
    py = ys + 0.5
    inside = np.zeros(shape, dtype=bool)
    pts = np.asarray(coords, dtype=float)
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % n]
        if y0 == y1:
            continue
        crosses = ((y0 <= py) & (py < y1)) | ((y1 <= py) & (py < y0))
        with np.errstate(divide="ignore", invalid="ignore"):
            x_at = x0 + (py - y0) / (y1 - y0) * (x1 - x0)
        inside ^= crosses & (px < x_at)
    return inside


def truth_polygon(coords: np.ndarray) -> Polygon:
    return Polygon(np.asarray(coords, dtype=float))


def corner_count(geometry: dict) -> int:
    """Exterior vertex count of a GeoJSON Polygon geometry (closing point
    excluded)."""
    ring = geometry["coordinates"][0]
    return len(ring) - 1


def exterior_ring(geometry: dict) -> np.ndarray:
    return np.asarray(geometry["coordinates"][0], dtype=float)[:-1]


def edge_angles_mod90(ring: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(angles_mod_90, lengths) of a ring's edges."""
    nxt = np.roll(ring, -1, axis=0)
    vec = nxt - ring
    lengths = np.hypot(vec[:, 0], vec[:, 1])
    angles = np.degrees(np.arctan2(vec[:, 1], vec[:, 0])) % 90.0
    return angles, lengths


def circ_diff_mod90(a: float, b: float) -> float:
    return abs((a - b + 45.0) % 90.0 - 45.0)


def geojson_polygon(geometry: dict) -> Polygon:
    shell = geometry["coordinates"][0]
    holes = geometry["coordinates"][1:]
    return Polygon(shell, holes)


def flip_boundary_pixels(
    mask: np.ndarray, fraction: float, seed: int
) -> np.ndarray:
    """Jitter: toggle a random fraction of boundary-adjacent pixels."""
    m = mask.copy()
    padded = np.zeros((m.shape[0] + 2, m.shape[1] + 2), dtype=bool)
    padded[1:-1, 1:-1] = m
    neighbor_any = (
        padded[:-2, 1:-1] | padded[2:, 1:-1] | padded[1:-1, :-2] | padded[1:-1, 2:]
    )
    boundary = (m & ~(padded[:-2, 1:-1] & padded[2:, 1:-1] & padded[1:-1, :-2] & padded[1:-1, 2:])) | (
        ~m & neighbor_any
    )
    idx = np.argwhere(boundary)
    rng = np.random.default_rng(seed)
    take = rng.choice(len(idx), size=max(1, int(len(idx) * fraction)), replace=False)
    for r, c in idx[take]:
        m[r, c] = ~m[r, c]
    return m
