# services/segment — Phase 3

FastAPI wrapping SAM 2 for farm-feature auto-sketch. Full docs (NAIP
source decision, Modal deploy steps, benchmark plan):
`docs/SEGMENTATION.md`.

- `POST /embed` — fetch **NAIP** for a bbox (USGS National Map
  ImageServer, public, no auth), compute the SAM 2 image embedding once,
  cache keyed farm + imagery vintage (object-storage-shaped cache; local
  dir in dev, Modal Volume in prod).
- `POST /segment` — cached embedding + click points/box → mask → polygon →
  simplify → **orthogonal regularization** (pens come out rectilinear;
  curved features pass through untouched) → GeoJSON.
- `app/onnx_export.py` — SAM 2 decoder → ONNX for in-browser hover
  previews (runs only where weights exist).
- `modal_app.py` — complete Modal deployment (GPU image, weights +
  embedding-cache volumes, ASGI endpoint); ready for `modal deploy` the
  moment a token exists.

**Imagery licensing rule:** segmentation touches NAIP only. Commercial
basemaps are visual layers, never segmentation sources. (CLAUDE.md #3.)

Dev quickstart:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev,raster]"
.\.venv\Scripts\python.exe -m pytest   # model-free; SAM 2 required nowhere
```

Heavy deps (torch, sam2) are the `model` extra, imported lazily inside
model-touching paths only; without weights the API answers 503 honestly.
