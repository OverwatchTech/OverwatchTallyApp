"""Geospatial primitives shared by NAIP fetch and polygonization.

Deliberately dependency-light (numpy only — no rasterio/affine/pyproj) so the
polygon pipeline is testable anywhere, including a bare Windows venv.

Conventions
-----------
- Pixel coordinates are (x=col, y=row), y increasing downward. Vertices of
  pixel-boundary polygons sit on integer pixel *corners*: pixel (row r, col c)
  occupies the square [c, c+1] x [r, r+1].
- World coordinates are EPSG:4326 lon/lat unless a caller says otherwise.
- bbox order is (west, south, east, north) — matches the portal API.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

# Meters per degree (WGS84, spherical approximation). Used only to size image
# requests so pixels come out roughly square in meters — never for storage or
# customer-facing measurement (rule: store SI, display customary, one place).
M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON_EQUATOR = 111_320.0


class BBoxError(ValueError):
    """Invalid bounding box."""


@dataclass(frozen=True)
class BBox:
    west: float
    south: float
    east: float
    north: float

    def __post_init__(self) -> None:
        if not (-180.0 <= self.west < self.east <= 180.0):
            raise BBoxError(f"bbox west/east invalid: {self.west}, {self.east}")
        if not (-90.0 <= self.south < self.north <= 90.0):
            raise BBoxError(f"bbox south/north invalid: {self.south}, {self.north}")

    @property
    def mid_lat(self) -> float:
        return (self.south + self.north) / 2.0

    @property
    def width_deg(self) -> float:
        return self.east - self.west

    @property
    def height_deg(self) -> float:
        return self.north - self.south

    def size_meters(self) -> tuple[float, float]:
        """(width_m, height_m) at the bbox midpoint latitude."""
        width_m = self.width_deg * M_PER_DEG_LON_EQUATOR * math.cos(math.radians(self.mid_lat))
        height_m = self.height_deg * M_PER_DEG_LAT
        return width_m, height_m

    def as_tuple(self) -> tuple[float, float, float, float]:
        return (self.west, self.south, self.east, self.north)


def size_for_gsd(
    bbox: BBox, gsd_m: float, max_px: int = 2048, min_px: int = 32
) -> tuple[int, int]:
    """Pixel (width, height) for a bbox at a target ground sample distance.

    Sizing from meters (not degrees) makes pixels approximately square on the
    ground, which matters: orthogonal regularization measures edge angles in
    pixel space, and anisotropic pixels would skew every angle by up to
    ~cos(lat).
    """
    if gsd_m <= 0:
        raise ValueError("gsd_m must be positive")
    width_m, height_m = bbox.size_meters()
    w = max(min_px, round(width_m / gsd_m))
    h = max(min_px, round(height_m / gsd_m))
    longest = max(w, h)
    if longest > max_px:
        scale = max_px / longest
        w = max(min_px, round(w * scale))
        h = max(min_px, round(h * scale))
    return int(w), int(h)


@dataclass(frozen=True)
class GeoTransform:
    """Affine map from pixel corner coords (x=col, y=row) to world (x, y).

        world_x = x_origin + px_x * x_step
        world_y = y_origin + px_y * y_step

    ``y_step`` is negative for north-up rasters (row grows southward).
    Axis-aligned only — no rotation/shear terms; NAIP requests are always
    north-up.
    """

    x_origin: float
    y_origin: float
    x_step: float
    y_step: float

    @classmethod
    def identity(cls) -> "GeoTransform":
        return cls(0.0, 0.0, 1.0, 1.0)

    @classmethod
    def from_bbox(cls, bbox: BBox, width_px: int, height_px: int) -> "GeoTransform":
        if width_px <= 0 or height_px <= 0:
            raise ValueError("raster size must be positive")
        return cls(
            x_origin=bbox.west,
            y_origin=bbox.north,
            x_step=bbox.width_deg / width_px,
            y_step=-bbox.height_deg / height_px,
        )

    def px_to_world(self, coords: np.ndarray) -> np.ndarray:
        """(N, 2) pixel coords -> (N, 2) world coords."""
        arr = np.asarray(coords, dtype=float)
        out = np.empty_like(arr)
        out[..., 0] = self.x_origin + arr[..., 0] * self.x_step
        out[..., 1] = self.y_origin + arr[..., 1] * self.y_step
        return out

    def world_to_px(self, x: float, y: float) -> tuple[float, float]:
        return ((x - self.x_origin) / self.x_step, (y - self.y_origin) / self.y_step)

    def to_dict(self) -> dict[str, float]:
        return {
            "x_origin": self.x_origin,
            "y_origin": self.y_origin,
            "x_step": self.x_step,
            "y_step": self.y_step,
        }

    @classmethod
    def from_dict(cls, d: dict[str, float]) -> "GeoTransform":
        return cls(
            x_origin=float(d["x_origin"]),
            y_origin=float(d["y_origin"]),
            x_step=float(d["x_step"]),
            y_step=float(d["y_step"]),
        )
