# services/segment — Phase 3

FastAPI wrapping SAM 2 via `segment-geospatial`, deployed on Modal.

- `POST /embed` — fetch **NAIP** tiles for a bbox, compute image embedding
  once, cache in object storage keyed by farm + imagery date.
- `POST /segment` — cached embedding + click points/box → mask → polygon
  (`rasterio.features.shapes`) → simplify → orthogonal regularization.
- SAM decoder exported to ONNX for in-browser hover previews.

**Imagery licensing rule:** segmentation touches NAIP only. Commercial
basemaps are visual layers, never segmentation sources. (CLAUDE.md #3.)

Scaffolded in Phase 3 — `pyproject.toml`, Modal app, tests.
