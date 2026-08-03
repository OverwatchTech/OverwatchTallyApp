"""NAIP imagery fetch.

Imagery licensing rule (CLAUDE.md #3, absolute): the segmentation model
touches **NAIP only** (USDA, public domain). Commercial tiles are visual
basemaps elsewhere in the product and never enter this module.

NAIP access findings (2026-08, verified — see docs/SEGMENTATION.md):

- The AWS Open Data NAIP buckets (``naip-source``, ``naip-analytic``,
  ``naip-visualization`` on S3) are **Requester Pays**: every GET needs AWS
  credentials and bills the caller. Not usable anonymously, so not the
  default here.
- The USGS **National Map ImageServer** serves NAIP publicly with no
  authentication, no API key, and no requester-pays:
  ``https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer``
  Its ``exportImage`` operation returns imagery for a bbox at a requested
  pixel size, reprojected server-side to EPSG:4326. That is the default
  source.
- Microsoft Planetary Computer also hosts NAIP COGs with anonymous SAS
  signing (STAC collection ``naip``); kept as a documented fallback, not
  implemented, to avoid the pystac/rasterio-COG dependency tonight.

``imagery_date`` handling (verified live 2026-08-02): the ImageServer honors
``time=`` filtering — a day window that matches no NAIP acquisition over the
bbox returns a fully transparent image (surfaced as :class:`NAIPFetchError`),
and omitting ``time`` serves the most recent mosaic. Because NAIP flights
happen on scattered dates, the useful request unit is the *vintage year*:
``imagery_date`` accepts ``YYYY`` (whole-year window, recommended) or
``YYYY-MM-DD`` (exact-day window, mostly for debugging). Either form always
participates in the cache key, so distinct vintages never collide in cache.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

import numpy as np

from .config import Settings
from .geo import BBox, GeoTransform, size_for_gsd


class NAIPFetchError(RuntimeError):
    """NAIP imagery could not be fetched for the requested bbox."""


@dataclass
class NAIPImage:
    array: np.ndarray  # (H, W, 3) uint8 RGB
    transform: GeoTransform  # pixel corners -> EPSG:4326 lon/lat
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def height(self) -> int:
        return int(self.array.shape[0])

    @property
    def width(self) -> int:
        return int(self.array.shape[1])


class NAIPSource(Protocol):
    id: str

    def fetch(
        self, bbox: BBox, size: tuple[int, int], imagery_date: str | None = None
    ) -> NAIPImage: ...


def _date_to_time_param(imagery_date: str) -> str:
    """Vintage -> ArcGIS time extent in epoch ms.

    ``YYYY`` covers the whole UTC year (NAIP vintage semantics);
    ``YYYY-MM-DD`` covers that single UTC day.
    """
    if len(imagery_date) == 4:
        start = datetime(int(imagery_date), 1, 1, tzinfo=timezone.utc)
        end = datetime(int(imagery_date) + 1, 1, 1, tzinfo=timezone.utc)
        start_ms = int(start.timestamp() * 1000)
        end_ms = int(end.timestamp() * 1000) - 1
        return f"{start_ms},{end_ms}"
    day = datetime.strptime(imagery_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    start_ms = int(day.timestamp() * 1000)
    end_ms = start_ms + 24 * 3600 * 1000 - 1
    return f"{start_ms},{end_ms}"


class USGSNAIPImageServer:
    """Public USGS National Map NAIP ImageServer (no auth, no requester-pays)."""

    id = "usgs_naip_imageserver"

    def __init__(self, base_url: str, timeout_s: float = 60.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s

    def build_request(
        self, bbox: BBox, size: tuple[int, int], imagery_date: str | None = None
    ) -> tuple[str, dict[str, str]]:
        w, h = size
        params = {
            "bbox": f"{bbox.west},{bbox.south},{bbox.east},{bbox.north}",
            "bboxSR": "4326",
            "imageSR": "4326",
            "size": f"{w},{h}",
            "format": "png32",
            "f": "image",
        }
        if imagery_date:
            params["time"] = _date_to_time_param(imagery_date)
        return f"{self.base_url}/exportImage", params

    def fetch(
        self, bbox: BBox, size: tuple[int, int], imagery_date: str | None = None
    ) -> NAIPImage:
        import httpx  # deferred: keeps module import cheap for tests
        from PIL import Image
        import io

        url, params = self.build_request(bbox, size, imagery_date)
        try:
            resp = httpx.get(url, params=params, timeout=self.timeout_s)
        except httpx.HTTPError as exc:
            raise NAIPFetchError(f"NAIP request failed: {exc}") from exc
        content_type = resp.headers.get("content-type", "")
        if resp.status_code != 200 or not content_type.startswith("image/"):
            excerpt = resp.text[:300]
            raise NAIPFetchError(
                f"NAIP export failed (HTTP {resp.status_code}, {content_type}): {excerpt}"
            )
        img = Image.open(io.BytesIO(resp.content))
        arr = np.asarray(img.convert("RGBA"))
        if arr.shape[2] == 4 and not arr[..., 3].any():
            raise NAIPFetchError(
                "NAIP returned a fully transparent image — bbox is likely outside "
                "NAIP coverage (NAIP is CONUS-only)"
            )
        rgb = arr[..., :3].copy()
        if not rgb.any():
            raise NAIPFetchError(
                "NAIP returned an all-black image — bbox likely outside coverage "
                "or outside the requested imagery date"
            )
        w, h = size
        return NAIPImage(
            array=rgb,
            transform=GeoTransform.from_bbox(bbox, rgb.shape[1], rgb.shape[0]),
            meta={
                "source": self.id,
                "url": url,
                "bbox": bbox.as_tuple(),
                "size": [rgb.shape[1], rgb.shape[0]],
                "imagery_date": imagery_date,
                "crs": "EPSG:4326",
            },
        )


class StubNAIPSource:
    """Deterministic synthetic imagery for tests and model-free local dev.

    Same bbox + size + date always yields identical pixels, so cache-key
    semantics can be tested end to end without the network.
    """

    id = "stub"

    def __init__(self, max_px: int = 512) -> None:
        self.max_px = max_px

    def fetch(
        self, bbox: BBox, size: tuple[int, int], imagery_date: str | None = None
    ) -> NAIPImage:
        w, h = size
        longest = max(w, h)
        if longest > self.max_px:
            scale = self.max_px / longest
            w = max(8, round(w * scale))
            h = max(8, round(h * scale))
        seed_src = f"{bbox.as_tuple()}|{w}x{h}|{imagery_date}".encode()
        seed = int.from_bytes(hashlib.sha256(seed_src).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        arr = rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8)
        return NAIPImage(
            array=arr,
            transform=GeoTransform.from_bbox(bbox, w, h),
            meta={
                "source": self.id,
                "bbox": bbox.as_tuple(),
                "size": [w, h],
                "imagery_date": imagery_date,
                "crs": "EPSG:4326",
            },
        )


def make_source(settings: Settings) -> NAIPSource:
    if settings.naip_source == "usgs":
        return USGSNAIPImageServer(settings.usgs_base_url, settings.http_timeout_s)
    if settings.naip_source == "stub":
        return StubNAIPSource()
    raise ValueError(f"unknown NAIP source {settings.naip_source!r}")


def embedding_key(
    farm_id: str, imagery_date: str | None, bbox: BBox, size: tuple[int, int], source_id: str
) -> str:
    """Cache key: farm + imagery date + content hash of the exact request."""
    payload = f"{source_id}|{','.join(f'{v:.7f}' for v in bbox.as_tuple())}|{size[0]}x{size[1]}"
    digest = hashlib.sha256(payload.encode()).hexdigest()[:16]
    return f"{farm_id}/{imagery_date or 'latest'}/{digest}"
