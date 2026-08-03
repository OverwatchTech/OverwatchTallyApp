"""FastAPI app for the segmentation service.

Endpoints
---------
POST /embed    {farm_id, bbox[w,s,e,n], imagery_date?} -> fetch NAIP, compute
               the SAM 2 image embedding once, cache it keyed by
               farm + imagery date + request hash. The expensive call.
POST /segment  {embedding_key, points/box} -> mask -> polygon(s), simplified
               and orthogonally regularized, returned as GeoJSON.
GET  /healthz  liveness + configuration summary (no model load).

Run locally (model-free, stub imagery):

    SEGMENT_NAIP_SOURCE=stub uvicorn --factory app.main:create_app

The factory takes an optional ``predictor_provider`` so tests inject a fake
predictor; production uses the lazy SAM 2 provider (503 until weights exist).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field, model_validator

from .cache import EmbeddingCache, LocalDirStore
from .config import Settings
from .geo import BBox, BBoxError, GeoTransform, size_for_gsd
from .model import ModelUnavailable, PredictorProvider, default_predictor_provider
from .naip import NAIPFetchError, embedding_key, make_source
from .polygonize import PolygonizeParams, mask_to_features

logger = logging.getLogger("overwatch-segment")


class EmbedRequest(BaseModel):
    farm_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_\-]+$")
    bbox: tuple[float, float, float, float] = Field(
        description="(west, south, east, north) in EPSG:4326"
    )
    imagery_date: str | None = Field(
        default=None,
        pattern=r"^\d{4}(-\d{2}-\d{2})?$",
        description=(
            "NAIP vintage: YYYY (whole-year window, recommended) or "
            "YYYY-MM-DD (exact acquisition day); part of the cache key"
        ),
    )

    @model_validator(mode="after")
    def _check_bbox(self) -> "EmbedRequest":
        w, s, e, n = self.bbox
        try:
            BBox(w, s, e, n)
        except BBoxError as exc:
            raise ValueError(str(exc)) from exc
        return self


class SegmentRequest(BaseModel):
    embedding_key: str = Field(min_length=1, max_length=256)
    points: list[tuple[float, float]] = Field(
        default_factory=list, description="click points, EPSG:4326 (lon, lat)"
    )
    point_labels: list[int] | None = Field(
        default=None, description="1 = foreground, 0 = background; defaults to all 1"
    )
    box: tuple[float, float, float, float] | None = Field(
        default=None, description="(west, south, east, north) prompt box, EPSG:4326"
    )

    @model_validator(mode="after")
    def _check_prompts(self) -> "SegmentRequest":
        if not self.points and self.box is None:
            raise ValueError("provide at least one click point or a box")
        if self.point_labels is not None and len(self.point_labels) != len(self.points):
            raise ValueError("point_labels length must match points length")
        if self.point_labels is not None and any(
            lab not in (0, 1) for lab in self.point_labels
        ):
            raise ValueError("point_labels must be 0 or 1")
        return self


def create_app(
    settings: Settings | None = None,
    predictor_provider: PredictorProvider | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    cache = EmbeddingCache(LocalDirStore(settings.cache_dir))
    source = make_source(settings)
    provider = predictor_provider or default_predictor_provider(settings)

    app = FastAPI(title="overwatch-segment", version="0.1.0")

    async def _auth(request: Request) -> None:
        if settings.api_token is None:
            return
        header = request.headers.get("authorization", "")
        if header != f"Bearer {settings.api_token}":
            raise HTTPException(status_code=401, detail="missing or invalid bearer token")

    def _get_predictor():
        try:
            return provider()
        except ModelUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.get("/healthz")
    def healthz() -> dict[str, Any]:
        return {
            "status": "ok",
            "naip_source": source.id,
            "cache_dir": settings.cache_dir,
            "model_configured": bool(settings.sam2_checkpoint),
        }

    @app.post("/embed", dependencies=[Depends(_auth)])
    def embed(req: EmbedRequest) -> dict[str, Any]:
        bbox = BBox(*req.bbox)
        if bbox.width_deg > settings.max_bbox_deg or bbox.height_deg > settings.max_bbox_deg:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"bbox too large: max edge is {settings.max_bbox_deg} degrees; "
                    "embed one work area at a time"
                ),
            )
        size = size_for_gsd(bbox, settings.target_gsd_m, settings.max_px, settings.min_px)
        key = embedding_key(req.farm_id, req.imagery_date, bbox, size, source.id)

        if cache.has(key):
            meta = cache.load_meta(key) or {}
            return {"embedding_key": key, "cached": True, **_public_meta(meta)}

        try:
            image = source.fetch(bbox, size, req.imagery_date)
        except NAIPFetchError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        predictor = _get_predictor()
        arrays = predictor.embed(image.array)
        meta = {
            "farm_id": req.farm_id,
            "imagery_date": req.imagery_date,
            "bbox": bbox.as_tuple(),
            "width": image.width,
            "height": image.height,
            "transform": image.transform.to_dict(),
            "imagery": image.meta,
        }
        cache.save(key, arrays, meta)
        logger.info("embedded %s (%dx%d px)", key, image.width, image.height)
        return {"embedding_key": key, "cached": False, **_public_meta(meta)}

    @app.post("/segment", dependencies=[Depends(_auth)])
    def segment(req: SegmentRequest) -> dict[str, Any]:
        meta = cache.load_meta(req.embedding_key)
        if meta is None:
            raise HTTPException(
                status_code=404,
                detail=f"embedding_key not found: {req.embedding_key!r}; call /embed first",
            )
        arrays = cache.load_arrays(req.embedding_key)
        if arrays is None:
            raise HTTPException(status_code=404, detail="embedding payload missing from cache")

        gt = GeoTransform.from_dict(meta["transform"])
        width, height = int(meta["width"]), int(meta["height"])

        points_px: list[tuple[float, float]] = []
        for lon, lat in req.points:
            px, py = gt.world_to_px(lon, lat)
            if not (0 <= px <= width and 0 <= py <= height):
                raise HTTPException(
                    status_code=422,
                    detail=f"point ({lon}, {lat}) is outside the embedded bbox",
                )
            points_px.append((px, py))

        box_px: tuple[float, float, float, float] | None = None
        if req.box is not None:
            bw, bs, be, bn = req.box
            x0, y0 = gt.world_to_px(bw, bn)  # top-left in pixel space
            x1, y1 = gt.world_to_px(be, bs)
            box_px = (
                max(0.0, min(x0, x1)),
                max(0.0, min(y0, y1)),
                min(float(width), max(x0, x1)),
                min(float(height), max(y0, y1)),
            )

        predictor = _get_predictor()
        mask = predictor.decode(
            arrays,
            (height, width),
            points_px=points_px or None,
            point_labels=req.point_labels,
            box_px=box_px,
        )
        if mask is None or not mask.any():
            return {"type": "FeatureCollection", "features": [], "meta": {"mask_area_px": 0}}

        features = mask_to_features(mask, gt, PolygonizeParams())
        return {
            "type": "FeatureCollection",
            "features": features,
            "meta": {
                "embedding_key": req.embedding_key,
                "mask_area_px": int(mask.sum()),
                "imagery": meta.get("imagery", {}),
            },
        }

    return app


def _public_meta(meta: dict[str, Any]) -> dict[str, Any]:
    return {
        "bbox": meta.get("bbox"),
        "image": {"width": meta.get("width"), "height": meta.get("height")},
        "imagery": meta.get("imagery", {}),
    }
