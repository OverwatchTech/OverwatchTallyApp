"""Service settings, read once from environment variables.

Env vars (all optional locally):

    SEGMENT_NAIP_SOURCE      "usgs" (default) | "stub"
    SEGMENT_CACHE_DIR        embedding cache root (default: ./.embed-cache
                             next to this package; /cache/embeddings on Modal)
    SEGMENT_API_TOKEN        if set, requests must send Authorization: Bearer
    SEGMENT_TARGET_GSD_M     target ground sample distance, meters/px (0.6)
    SEGMENT_MAX_PX           longest image edge requested from NAIP (2048)
    SEGMENT_MAX_BBOX_DEG     max bbox edge in degrees (0.05 ~ 5.5 km)
    SEGMENT_USGS_BASE_URL    override the USGS NAIP ImageServer base URL
    SEGMENT_HTTP_TIMEOUT_S   NAIP fetch timeout (60)
    SAM2_CHECKPOINT          path to SAM 2 weights (absent => 503 on /embed)
    SAM2_MODEL_CFG           SAM 2 config name (configs/sam2.1/sam2.1_hiera_l.yaml)
    SAM2_DEVICE              "cuda" | "cpu" (default: auto)
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_USGS_BASE_URL = (
    "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer"
)


@dataclass(frozen=True)
class Settings:
    naip_source: str = "usgs"
    cache_dir: str = ""
    api_token: str | None = None
    target_gsd_m: float = 0.6
    max_px: int = 2048
    min_px: int = 32
    max_bbox_deg: float = 0.05
    usgs_base_url: str = DEFAULT_USGS_BASE_URL
    http_timeout_s: float = 60.0
    sam2_checkpoint: str | None = None
    sam2_model_cfg: str = "configs/sam2.1/sam2.1_hiera_l.yaml"
    sam2_device: str | None = None

    def __post_init__(self) -> None:
        if not self.cache_dir:
            object.__setattr__(
                self,
                "cache_dir",
                str(Path(__file__).resolve().parent.parent / ".embed-cache"),
            )

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ
        return cls(
            naip_source=env.get("SEGMENT_NAIP_SOURCE", "usgs"),
            cache_dir=env.get("SEGMENT_CACHE_DIR", ""),
            api_token=env.get("SEGMENT_API_TOKEN") or None,
            target_gsd_m=float(env.get("SEGMENT_TARGET_GSD_M", "0.6")),
            max_px=int(env.get("SEGMENT_MAX_PX", "2048")),
            max_bbox_deg=float(env.get("SEGMENT_MAX_BBOX_DEG", "0.05")),
            usgs_base_url=env.get("SEGMENT_USGS_BASE_URL", DEFAULT_USGS_BASE_URL),
            http_timeout_s=float(env.get("SEGMENT_HTTP_TIMEOUT_S", "60")),
            sam2_checkpoint=env.get("SAM2_CHECKPOINT") or None,
            sam2_model_cfg=env.get(
                "SAM2_MODEL_CFG", "configs/sam2.1/sam2.1_hiera_l.yaml"
            ),
            sam2_device=env.get("SAM2_DEVICE") or None,
        )
