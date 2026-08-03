# Segmentation service — `services/segment`

FastAPI wrapping SAM 2 for farm-feature auto-sketch (ARCHITECTURE §9).
Phase 3. Built 2026-08-02; Modal **deployment deferred** (no Modal token
yet) — everything else is real and locally tested.

**Imagery licensing rule (CLAUDE.md #3, absolute): the segmentation model
touches NAIP only.** Commercial basemaps are visual layers elsewhere,
behind a flag, and never enter this service.

**Deviation from ARCHITECTURE §9 wording, flagged for owner review:** the
service wraps SAM 2 *directly* instead of going through the
`segment-geospatial` package. samgeo would add its full dependency stack
(gdal/leafmap/torch and friends) to every install for two capabilities —
imagery download and mask→vector — that this service implements in ~200
exhaustively tested lines with explicit NAIP-only control. Nothing else
changes: same model, same weights, same endpoints.

## Pipeline

```
POST /embed   bbox ──> NAIP fetch (USGS ImageServer) ──> SAM 2 image
              embedding (GPU, once) ──> cache keyed farm/vintage/hash

POST /segment cached embedding + click points or box ──> SAM 2 decoder
              ──> bool mask ──> denoise (3x3 majority) ──> extract
              (pixel-boundary polygons, rasterio or pure-numpy backend)
              ──> simplify (DP 1.2 px) ──> orthogonal regularization
              ──> GeoJSON FeatureCollection (EPSG:4326, RFC 7946 winding)
```

Orthogonal regularization is the step that makes output look hand-drawn
(`app/polygonize.py`, exhaustively tested without any model):

1. **Dominant angle** — edge-length-weighted histogram of edge angles
   folded mod 90 (1° bins, circular boxcar smoothing), peak refined by a
   length-weighted circular mean.
2. **Gate** — if less than 55 % of boundary length lies within the 12°
   snap tolerance of the axis pair, the shape is genuinely curved (pond,
   tree line) and passes through untouched.
3. **Runs** — edges of a coarsened ring classify as H / V / D
   (free diagonal); consecutive same-class edges merge into runs;
   sub-threshold runs (noise steps, chamfer leftovers) are dropped with
   same-class neighbors re-merged.
4. **Theta refinement** — total-least-squares (PCA) line through each axis
   run's *raw pixel-boundary* vertices; length-weighted mean deviation
   corrects the dominant angle to a fraction of a degree, independent of
   Douglas-Peucker artifacts.
5. **Snap** — H/V runs become exact axis-parallel lines (position =
   length-weighted mean over the raw boundary, which is unbiased at any
   rotation); genuine diagonals keep their chords; new corners are the
   line intersections.
6. **Topology guard** — the result must be valid, hold area within ±25 %,
   and overlap the input at IoU ≥ 0.8, else the simplified original is
   returned. Every AI shape is a *proposal* regardless (accept/edit/reject
   lives in the portal).

Measured on synthetic masks (part of the test suite): rotated rectangles
at 0–81° come back as exact 4-corner rectangles with rotation recovered
within 1.5° and IoU > 0.95 vs ground truth; L-shapes keep 6 corners;
circles and ellipses are untouched (IoU > 0.95, no squaring-off);
45°-edged octagons keep their diagonals.

## NAIP source decision (verified live 2026-08-02)

| Path | Status | Finding |
|---|---|---|
| AWS Open Data buckets (`naip-source`, `naip-analytic`, `naip-visualization`) | rejected | **Requester Pays** — every GET needs AWS credentials and bills us; not usable anonymously |
| **USGS National Map ImageServer** (`imagery.nationalmap.gov/.../USGSNAIPImagery/ImageServer`) | **default** | public, no auth, no key; `exportImage` returns any bbox at any pixel size, reprojected server-side to EPSG:4326; fetch verified live from this machine (rural-TX bbox, 256 px tile) |
| Microsoft Planetary Computer (STAC collection `naip`) | documented fallback | anonymous SAS signing works, but needs pystac + COG reading (rasterio windowed reads); not implemented tonight |

Live `time=` behavior (probed): the ImageServer **honors time filtering**.
A day window matching no NAIP acquisition over the bbox returns a fully
transparent image (the service surfaces this as a 502 with a clear
message); omitting `time` serves the newest mosaic. Because NAIP flights
happen on scattered dates, **`imagery_date` accepts a vintage year
(`"2022"`, recommended — whole-year window, verified returning imagery)**
or an exact `YYYY-MM-DD` day (debugging). Either form is part of the
embedding cache key.

Image sizing: requests are sized from *meters* (default 0.6 m/px, capped
at 2048 px) with a cos(latitude) correction so pixels are square on the
ground — regularization measures angles in pixel space and anisotropic
pixels would skew every angle.

## Windows / local dev notes

- **rasterio 1.4.4 installed cleanly on Windows via wheels** (Python
  3.11) — no GDAL fight. The service still ships a pure-numpy
  pixel-boundary tracer that produces geometry identical to
  `rasterio.features.shapes` (parity-tested); `backend="auto"` prefers
  rasterio, falls back to numpy. rasterio stays an optional extra.
- Heavy deps (torch, sam2) are the `model` extra and are imported lazily
  inside model-touching paths only. Without weights, `/embed` answers
  `503` with an actionable message; the entire test suite runs model-free
  against a fake predictor.

```powershell
cd services\segment
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev,raster]"
.\.venv\Scripts\python.exe -m pytest          # 139 passed, 1 skipped (network)
$env:SEGMENT_NETWORK_TESTS='1'; .\.venv\Scripts\python.exe -m pytest   # 140 passed
# run the API locally with stub imagery (no model, no network):
$env:SEGMENT_NAIP_SOURCE='stub'; .\.venv\Scripts\uvicorn --factory app.main:create_app
```

## API

- `POST /embed` `{farm_id, bbox:[w,s,e,n], imagery_date?}` →
  `{embedding_key, cached, bbox, image:{width,height}, imagery}`.
  Bbox capped at 0.05° per edge (~5.5 km) — embed one work area at a time.
  `502` when NAIP has no coverage; `503` when weights are absent.
- `POST /segment` `{embedding_key, points:[[lon,lat],...], point_labels?,
  box?}` → GeoJSON `FeatureCollection`. Feature properties:
  `regularized`, `dominant_angle_deg`, `ortho_fraction`, `reg_iou`,
  `area_px`, `n_vertices`. `404` for unknown keys.
- `GET /healthz` — liveness; never loads the model.
- If `SEGMENT_API_TOKEN` is set, `/embed` and `/segment` require
  `Authorization: Bearer <token>`; `/healthz` stays open.

Embedding cache: object-storage-shaped interface
(`app/cache.py::ObjectStore`) with keys `farm/<vintage>/<hash>/…`. Local
dev uses a directory; on Modal the same code runs against a mounted Modal
Volume; an S3/R2 move would touch one class.

## Deploying to Modal (owner's exact steps)

One-time, from `services/segment` (any machine with Python):

```powershell
py -m pip install modal
py -m modal token new                      # browser opens; sign in / create the Modal account
py -m modal run modal_app.py::download_weights   # ~2.4 GB SAM 2.1 hiera-large into the weights volume
py -m modal deploy modal_app.py            # prints the web endpoint URL
```

Then:

1. Put the printed URL in the portal env as `SEGMENT_SERVICE_URL`
   (`apps/web/.env.local` — never committed).
2. Optional but recommended:
   `py -m modal secret create segment-api SEGMENT_API_TOKEN=<long random>`,
   uncomment the `secrets=[...]` line in `modal_app.py`, redeploy, and set
   the same token in the portal env.
3. Smoke test:
   `curl https://<url>/healthz`, then a small `/embed` + `/segment` pair.

Costs: the web function runs on an A10G, scales to zero after 120 s idle;
embeddings cache in the `segment-embed-cache` volume so repeat visits to a
farm skip the GPU-expensive step.

## Browser decoder (ONNX)

`app/onnx_export.py` exports the SAM 2 prompt-encoder + mask-decoder to
ONNX for in-browser hover previews (onnxruntime-web); the backend keeps
computing embeddings. Runs **only** where weights exist:

```
py -m modal run modal_app.py::export_onnx
py -m modal volume get segment-weights sam2_decoder.onnx
```

or locally `py -m app.onnx_export --checkpoint <pt> --check`. The wrapper
mirrors the community SAM 2 exporters; verify output parity with
`--check` on first run (flagged in the file).

## IoU benchmark vs the hand-drawn KML

Harness: `tests/benchmark_iou.py` (not collected by pytest; runnable the
moment the model is live). For every polygon in the hand-drawn KML
(`Media/Farm Project (3).kml` in the marketing-site repo — 172 features;
the polygon classes are the 42 pens and 18 hay stacks; the 91 gates are
points and excluded):

1. `/embed` the feature's envelope padded 30 %,
2. `/segment` with one click at the polygon's representative point,
3. IoU of the returned polygon vs the hand-drawn one.

```powershell
py tests\benchmark_iou.py --base-url https://<modal-url> `
    --kml "..\..\..\AF Website Design\Media\Farm Project (3).kml" `
    --token <SEGMENT_API_TOKEN> --out benchmark_report.json
```

Reports per class (KML folder): n, failures, mean IoU, median IoU,
fraction ≥ 0.8, plus per-feature rows with the `regularized` flag.
Working targets before wiring the portal UI: median IoU ≥ 0.75 on pens,
≥ 0.65 on hay stacks (smaller, harder), no class below 0.5 — below that,
tune click prompting (multi-point) before touching the model. Original AI
geometry is stored beside human corrections in the portal (Phase 3 UI),
which is the future fine-tuning set (ROADMAP).

## Open [VERIFY] items

- `Sam2Predictor.embed/decode` split `set_image`/`predict` across requests
  by serializing `_features` internals of the `sam2` package — exercise on
  first Modal deploy (pin the sam2 git rev in the image if it drifts).
- ONNX decoder wrapper parity (`--check`) on first run with weights.
- Planetary Computer fallback only if USGS ImageServer reliability
  becomes a problem in practice.
