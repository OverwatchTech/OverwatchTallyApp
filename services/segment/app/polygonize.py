"""Mask -> polygons -> simplification -> orthogonal regularization.

This is the step that makes AI output look hand-drawn (ARCHITECTURE.md §9):
pens are rectilinear, so edges are snapped to the polygon's dominant axis
pair. Genuinely curved features (ponds, tree lines) must pass through
untouched — regularization is gated on an orthogonality score and validated
against the input shape (IoU + validity + area ratio) before it is accepted.
When any check fails, the simplified-but-unregularized polygon is returned:
the pipeline never mangles a shape to force rectilinearity.

Raster -> vector backends:

- ``numpy``    built-in pixel-boundary tracing (4-connected, exact pixel
               edges). Zero heavy dependencies; always available.
- ``rasterio`` :func:`rasterio.features.shapes`, used when rasterio is
               importable. Same geometry (parity-tested in the suite).
- ``auto``     rasterio if importable, else numpy.

Everything here is pure geometry on numpy arrays + shapely — fully testable
without any model or network.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable

import numpy as np
from shapely.geometry import Polygon, mapping
from shapely.geometry.polygon import orient

from .geo import GeoTransform

try:  # optional backend
    import rasterio.features as _rio_features  # type: ignore

    HAS_RASTERIO = True
except Exception:  # pragma: no cover - environment-dependent
    _rio_features = None
    HAS_RASTERIO = False


# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RegularizeParams:
    """Knobs for orthogonal regularization.

    snap_tol_deg        an edge within this many degrees of the dominant axis
                        pair is snapped onto it; edges further away are kept
                        as free diagonals.
    min_ortho_fraction  minimum length-fraction of snappable edges required
                        to attempt regularization at all (circles/ellipses
                        fall below this and pass through untouched).
    hist_bin_deg        bin width of the edge-length-weighted angle histogram
                        used to find the dominant axis pair.
    hist_smooth_bins    boxcar smoothing window (bins, odd) applied
                        circularly to the histogram before peak-picking.
    pre_simplify_px     the regularizer classifies edges on a coarser
                        Douglas-Peucker pass of the ring (noisy boundaries
                        keep dozens of sub-pixel jags at output tolerance);
                        the fine ring is what's returned when
                        regularization declines, so curves lose nothing.
    min_run_len_px      absolute floor: edge runs (any class) shorter than
                        this are noise — dropped shortest-first, merging
                        same-class neighbors (a dropped V step between two
                        H runs re-fits one straight H line, exactly what a
                        boundary notch needs).
    run_min_frac        relative floor: runs shorter than this fraction of
                        the ring perimeter are likewise noise
                        (simplification leftovers scale with shape size);
                        genuine chamfers, jogs and diagonals are much
                        longer.
    min_iou             regularized shape must overlap the input shape at
                        least this much (IoU) or it is rejected.
    max_area_dev        |area_reg/area_in - 1| beyond this rejects the
                        regularized shape.
    """

    snap_tol_deg: float = 12.0
    min_ortho_fraction: float = 0.55
    hist_bin_deg: float = 1.0
    hist_smooth_bins: int = 5
    pre_simplify_px: float = 2.5
    min_run_len_px: float = 3.0
    run_min_frac: float = 0.06
    min_iou: float = 0.80
    max_area_dev: float = 0.25


@dataclass(frozen=True)
class PolygonizeParams:
    """Full pipeline parameters (pixel units throughout).

    ``denoise`` runs one 3x3 morphological closing + opening pass before
    extraction: model masks (and jittery rasterizations) carry single-pixel
    notches and bumps along edges that would otherwise survive
    simplification as spurious corners. At NAIP GSD this is under 2 m of
    smoothing — invisible at pen scale.
    """

    denoise: bool = True
    min_denoise_area_px: float = 400.0
    simplify_tol_px: float = 1.2
    min_area_px: float = 4.0
    backend: str = "auto"  # "auto" | "numpy" | "rasterio"
    regularize: RegularizeParams = field(default_factory=RegularizeParams)


# ---------------------------------------------------------------------------
# Mask denoise (pure numpy 3x3 morphology)
# ---------------------------------------------------------------------------


def denoise_mask(mask: np.ndarray) -> np.ndarray:
    """3x3 majority filter: fills pin-holes/notches and shaves specks/bumps.

    Chosen over morphological close/open because majority voting is
    *unbiased* on straight boundaries at any angle — close-then-open
    systematically inflates 45-degree staircase edges by half a pixel,
    which measurably hurt IoU on rotated pens.
    """
    m = np.asarray(mask).astype(bool)
    padded = np.pad(m, 1, mode="edge").astype(np.uint8)
    votes = np.zeros(m.shape, dtype=np.uint8)
    for dr in (0, 1, 2):
        for dc in (0, 1, 2):
            votes += padded[dr : dr + m.shape[0], dc : dc + m.shape[1]]
    return votes >= 5


# ---------------------------------------------------------------------------
# Raster -> vector (pixel-boundary extraction)
# ---------------------------------------------------------------------------


def _directed_boundary_edges(
    mask: np.ndarray,
) -> dict[tuple[int, int], list[tuple[int, int]]]:
    """Directed unit edges along the True/False boundary of ``mask``.

    Convention: each True pixel contributes its exposed sides walked clockwise
    in y-down screen coords (top: +x, right: +y, bottom: -x, left: -y). This
    makes exterior rings come out with positive shoelace area in (x=col,
    y=row) coords and hole rings negative.
    """
    m = np.asarray(mask).astype(bool)
    if m.ndim != 2:
        raise ValueError(f"mask must be 2-D, got shape {m.shape}")
    h, w = m.shape
    padded = np.zeros((h + 2, w + 2), dtype=bool)
    padded[1:-1, 1:-1] = m

    top = m & ~padded[:-2, 1:-1]
    bottom = m & ~padded[2:, 1:-1]
    left = m & ~padded[1:-1, :-2]
    right = m & ~padded[1:-1, 2:]

    edges: dict[tuple[int, int], list[tuple[int, int]]] = {}

    def _add(rows: np.ndarray, cols: np.ndarray, sdx: int, sdy: int, edx: int, edy: int) -> None:
        for r, c in zip(rows.tolist(), cols.tolist()):
            start = (c + sdx, r + sdy)
            end = (c + edx, r + edy)
            edges.setdefault(start, []).append(end)

    rs, cs = np.nonzero(top)
    _add(rs, cs, 0, 0, 1, 0)  # (c, r) -> (c+1, r)
    rs, cs = np.nonzero(right)
    _add(rs, cs, 1, 0, 1, 1)  # (c+1, r) -> (c+1, r+1)
    rs, cs = np.nonzero(bottom)
    _add(rs, cs, 1, 1, 0, 1)  # (c+1, r+1) -> (c, r+1)
    rs, cs = np.nonzero(left)
    _add(rs, cs, 0, 1, 0, 0)  # (c, r+1) -> (c, r)
    return edges


def _collapse_collinear(ring: list[tuple[int, int]]) -> np.ndarray:
    """Drop vertices lying mid-edge. ``ring`` is open (no duplicate last)."""
    n = len(ring)
    keep: list[tuple[int, int]] = []
    for i in range(n):
        p_prev = ring[i - 1]
        p = ring[i]
        p_next = ring[(i + 1) % n]
        ax, ay = p[0] - p_prev[0], p[1] - p_prev[1]
        bx, by = p_next[0] - p[0], p_next[1] - p[1]
        if ax * by - ay * bx != 0:
            keep.append(p)
    return np.array(keep, dtype=float)


def _trace_rings(
    edges: dict[tuple[int, int], list[tuple[int, int]]],
) -> list[np.ndarray]:
    """Link directed boundary edges into closed rings (open vertex arrays).

    At corner junctions (two diagonally-touching pixels) there are two
    outgoing edges; the max-cross-product turn keeps the trace on its own
    pixel, which yields 4-connectivity (diagonal pixels become separate
    rings), matching rasterio's default.
    """
    rings: list[np.ndarray] = []
    while edges:
        start = min(edges)  # deterministic order
        ring: list[tuple[int, int]] = [start]
        cur = start
        prev_dir: tuple[int, int] | None = None
        while True:
            outs = edges.get(cur)
            if not outs:  # pragma: no cover - would mean a broken boundary
                raise RuntimeError(f"open boundary chain at {cur}")
            if len(outs) == 1 or prev_dir is None:
                nxt = outs[0]
            else:
                best_cross = -math.inf
                nxt = outs[0]
                for cand in outs:
                    d = (cand[0] - cur[0], cand[1] - cur[1])
                    cross = prev_dir[0] * d[1] - prev_dir[1] * d[0]
                    if cross > best_cross:
                        best_cross = cross
                        nxt = cand
            outs.remove(nxt)
            if not outs:
                del edges[cur]
            prev_dir = (nxt[0] - cur[0], nxt[1] - cur[1])
            cur = nxt
            if cur == start:
                break
            ring.append(cur)
        collapsed = _collapse_collinear(ring)
        if len(collapsed) >= 3:
            rings.append(collapsed)
    return rings


def _shoelace(coords: np.ndarray) -> float:
    """Signed area of an open ring (positive = exterior in our convention)."""
    x = coords[:, 0]
    y = coords[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _assemble(rings: list[np.ndarray]) -> list[Polygon]:
    """Group exterior/hole rings into shapely Polygons (pixel coords)."""
    exteriors: list[np.ndarray] = []
    holes: list[np.ndarray] = []
    for ring in rings:
        if _shoelace(ring) >= 0:
            exteriors.append(ring)
        else:
            holes.append(ring)
    shells = [(Polygon(ext), ext) for ext in exteriors]
    # smallest containing shell wins, so nested structures resolve correctly
    shells.sort(key=lambda t: t[0].area)
    assigned: list[list[np.ndarray]] = [[] for _ in shells]
    for hole in holes:
        hole_poly = Polygon(hole)
        pt = hole_poly.representative_point()
        for i, (shell_poly, _) in enumerate(shells):
            # a true parent shell must be bigger than the hole; without the
            # area guard, an island *inside* the hole would grab it
            if shell_poly.area > hole_poly.area and shell_poly.contains(pt):
                assigned[i].append(hole)
                break
    out = []
    for (shell_poly, ext), hole_rings in zip(shells, assigned):
        out.append(Polygon(ext, hole_rings) if hole_rings else shell_poly)
    return out


def _extract_numpy(mask: np.ndarray) -> list[Polygon]:
    return _assemble(_trace_rings(_directed_boundary_edges(mask)))


def _extract_rasterio(mask: np.ndarray) -> list[Polygon]:
    if not HAS_RASTERIO:  # pragma: no cover
        raise RuntimeError("rasterio backend requested but rasterio is not importable")
    from shapely.geometry import shape as _shape

    m = np.asarray(mask).astype(bool)
    polys: list[Polygon] = []
    for geom, value in _rio_features.shapes(m.astype(np.uint8), mask=m, connectivity=4):
        if value:
            polys.append(_shape(geom))
    return polys


def extract_polygons(mask: np.ndarray, backend: str = "auto") -> list[Polygon]:
    """Boolean mask -> list of shapely Polygons in pixel-corner coords."""
    if backend == "auto":
        backend = "rasterio" if HAS_RASTERIO else "numpy"
    if backend == "numpy":
        return _extract_numpy(mask)
    if backend == "rasterio":
        return _extract_rasterio(mask)
    raise ValueError(f"unknown backend {backend!r}")


# ---------------------------------------------------------------------------
# Orthogonal regularization
# ---------------------------------------------------------------------------


def _ring_open(coords: Iterable[tuple[float, float]]) -> np.ndarray:
    arr = np.asarray(list(coords), dtype=float)
    if len(arr) >= 2 and np.allclose(arr[0], arr[-1]):
        arr = arr[:-1]
    return arr


def _edge_vectors(ring: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(vectors, lengths, angles_deg_mod180) for an open ring."""
    nxt = np.roll(ring, -1, axis=0)
    vec = nxt - ring
    lengths = np.hypot(vec[:, 0], vec[:, 1])
    angles = np.degrees(np.arctan2(vec[:, 1], vec[:, 0])) % 180.0
    return vec, lengths, angles


def _circ_dist_mod(a: np.ndarray | float, b: float, period: float) -> np.ndarray | float:
    half = period / 2.0
    return np.abs((np.asarray(a) - b + half) % period - half)


def dominant_angle(
    rings: list[np.ndarray], params: RegularizeParams
) -> tuple[float, float]:
    """(theta_deg in [0, 90), snappable length fraction).

    Dominant axis pair via an edge-length-weighted histogram of edge angles
    folded mod 90, circularly smoothed; the peak is refined with a
    length-weighted circular mean (period 90) of nearby edges.
    """
    lengths_all: list[np.ndarray] = []
    angles_all: list[np.ndarray] = []
    for ring in rings:
        if len(ring) < 2:
            continue
        _, lengths, angles = _edge_vectors(ring)
        lengths_all.append(lengths)
        angles_all.append(angles % 90.0)
    if not lengths_all:
        return 0.0, 0.0
    lengths_cat = np.concatenate(lengths_all)
    angles_cat = np.concatenate(angles_all)
    total = float(lengths_cat.sum())
    if total <= 0:
        return 0.0, 0.0

    nbins = max(1, int(round(90.0 / params.hist_bin_deg)))
    idx = np.floor(angles_cat / (90.0 / nbins)).astype(int) % nbins
    hist = np.bincount(idx, weights=lengths_cat, minlength=nbins)

    k = max(1, params.hist_smooth_bins) | 1  # force odd
    pad = k // 2
    wrapped = np.concatenate([hist[-pad:], hist, hist[:pad]]) if pad else hist
    kernel = np.ones(k) / k
    smooth = np.convolve(wrapped, kernel, mode="same")[pad : pad + nbins] if pad else hist
    peak_deg = (int(np.argmax(smooth)) + 0.5) * (90.0 / nbins)

    # refine: length-weighted circular mean (period 90) of edges near the
    # peak; window = snap tolerance so BOTH axis families contribute (their
    # deviations cancel — a narrow window would see only one family and
    # inherit its bias)
    near = _circ_dist_mod(angles_cat, peak_deg, 90.0) <= max(
        params.snap_tol_deg, 3.0 * params.hist_bin_deg
    )
    if np.any(near):
        z = np.sum(
            lengths_cat[near] * np.exp(1j * np.radians(angles_cat[near] * 4.0))
        )
        if np.abs(z) > 1e-12:
            peak_deg = float(np.degrees(np.angle(z)) / 4.0) % 90.0

    frac = float(
        lengths_cat[_circ_dist_mod(angles_cat, peak_deg, 90.0) <= params.snap_tol_deg].sum()
        / total
    )
    return float(peak_deg % 90.0), frac


def snappable_fraction(
    rings: list[np.ndarray], theta: float, snap_tol_deg: float
) -> float:
    """Length-fraction of edges within snap tolerance of the theta axis pair."""
    total = 0.0
    snappable = 0.0
    for ring in rings:
        if len(ring) < 2:
            continue
        _, lengths, angles = _edge_vectors(ring)
        total += float(lengths.sum())
        near = _circ_dist_mod(angles % 90.0, theta, 90.0) <= snap_tol_deg
        snappable += float(lengths[near].sum())
    if total <= 0:
        return 0.0
    return snappable / total


def _rotate(coords: np.ndarray, theta_deg: float, center: np.ndarray) -> np.ndarray:
    t = math.radians(theta_deg)
    c, s = math.cos(t), math.sin(t)
    rel = coords - center
    out = np.empty_like(rel)
    out[:, 0] = rel[:, 0] * c - rel[:, 1] * s
    out[:, 1] = rel[:, 0] * s + rel[:, 1] * c
    return out + center


@dataclass
class _Run:
    cls: str  # "H" | "V" | "D"
    edge_idx: list[int]


def _build_runs(cls: list[str]) -> list[_Run] | None:
    n = len(cls)
    if all(c == cls[0] for c in cls):
        return None  # single direction class: nothing to intersect
    start = next(i for i in range(n) if cls[i] != cls[i - 1])
    runs: list[_Run] = []
    for k in range(n):
        i = (start + k) % n
        if runs and runs[-1].cls == cls[i]:
            runs[-1].edge_idx.append(i)
        else:
            runs.append(_Run(cls[i], [i]))
    return runs


def _drop_noise_runs(
    runs: list[_Run], lengths: np.ndarray, threshold: float
) -> list[_Run]:
    """Remove sub-threshold runs (noise steps and chamfer leftovers),
    shortest first, merging same-class neighbors. Never reduces below 3
    runs so legitimate minimal shapes (triangles) survive."""

    def run_len(run: _Run) -> float:
        return float(sum(lengths[j] for j in run.edge_idx))

    while len(runs) > 3:
        shortest_i = None
        shortest_len = threshold
        for i, run in enumerate(runs):
            length = run_len(run)
            if length < shortest_len:
                shortest_len = length
                shortest_i = i
        if shortest_i is None:
            break
        prv = runs[(shortest_i - 1) % len(runs)]
        nxt = runs[(shortest_i + 1) % len(runs)]
        del runs[shortest_i]
        if prv is not nxt and prv.cls == nxt.cls:
            prv.edge_idx.extend(nxt.edge_idx)
            runs.remove(nxt)
    return runs


def _run_line(
    run: _Run, ring: np.ndarray, lengths: np.ndarray
) -> tuple[np.ndarray, np.ndarray] | None:
    """Representative infinite line (point, unit direction) for a run."""
    n = len(ring)
    total = sum(lengths[j] for j in run.edge_idx)
    if total <= 0:
        return None
    if run.cls == "H":
        y = (
            sum(lengths[j] * (ring[j, 1] + ring[(j + 1) % n, 1]) / 2.0 for j in run.edge_idx)
            / total
        )
        return np.array([0.0, y]), np.array([1.0, 0.0])
    if run.cls == "V":
        x = (
            sum(lengths[j] * (ring[j, 0] + ring[(j + 1) % n, 0]) / 2.0 for j in run.edge_idx)
            / total
        )
        return np.array([x, 0.0]), np.array([0.0, 1.0])
    p0 = ring[run.edge_idx[0]]
    p1 = ring[(run.edge_idx[-1] + 1) % n]
    d = p1 - p0
    norm = float(np.hypot(d[0], d[1]))
    if norm < 1e-9:
        return None
    return p0, d / norm


def _intersect(
    l1: tuple[np.ndarray, np.ndarray], l2: tuple[np.ndarray, np.ndarray]
) -> np.ndarray | None:
    p1, d1 = l1
    p2, d2 = l2
    denom = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(denom) < 1e-9:
        return None  # near-parallel adjacent runs: unstable, bail out
    t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / denom
    return p1 + t * d1


def _map_coarse_to_fine(
    fine_open: np.ndarray, coarse_open: np.ndarray
) -> list[int] | None:
    """Index of each coarse vertex in the fine ring (DP keeps a vertex
    subset in order, sharing the ring start). None if the assumption breaks."""
    index_of = {
        (round(float(x), 6), round(float(y), 6)): i
        for i, (x, y) in enumerate(fine_open)
    }
    positions: list[int] = []
    for x, y in coarse_open:
        i = index_of.get((round(float(x), 6), round(float(y), 6)))
        if i is None:
            return None
        positions.append(i)
    return positions


def _regularize_ring(
    detail_open: np.ndarray,
    coarse_open: np.ndarray,
    theta: float,
    center: np.ndarray,
    params: RegularizeParams,
) -> tuple[np.ndarray, float] | None:
    """Snap one ring to the theta-axis pair.

    Returns (open ring, refined theta) or None when the ring cannot be
    regularized safely.

    Structure (which runs exist, in what order) comes from the COARSE ring —
    robust to boundary noise. Line positions are fit from the DETAIL ring
    (the raw pixel boundary when available): staircase edge midpoints hug
    the true boundary at any angle, so their length-weighted mean is nearly
    unbiased — unlike simplified edges, which tilt when Douglas-Peucker
    merges a corner chamfer and would drag the fitted line half a pixel.
    """
    if len(coarse_open) < 3 or len(detail_open) < 3:
        return None
    rot_d = _rotate(detail_open, -theta, center)
    rot_c = _rotate(coarse_open, -theta, center)
    _, len_c, ang_c = _edge_vectors(rot_c)
    _, len_d, _ = _edge_vectors(rot_d)
    n_d = len(rot_d)
    n_c = len(rot_c)

    cls: list[str] = []
    for a in ang_c:
        dh = float(min(a, 180.0 - a))
        dv = float(abs(a - 90.0))
        if dh <= params.snap_tol_deg and dh <= dv:
            cls.append("H")
        elif dv <= params.snap_tol_deg:
            cls.append("V")
        else:
            cls.append("D")

    runs = _build_runs(cls)
    if runs is None:
        return None
    noise_threshold = max(
        params.min_run_len_px, params.run_min_frac * float(len_c.sum())
    )
    runs = _drop_noise_runs(runs, len_c, noise_threshold)
    if len(runs) < 3:
        return None

    positions = _map_coarse_to_fine(detail_open, coarse_open)

    def _detail_chain(coarse_edge: int) -> list[int]:
        assert positions is not None
        a = positions[coarse_edge]
        b = positions[(coarse_edge + 1) % n_c]
        idxs: list[int] = []
        i = a
        while i != b:
            idxs.append(i)
            i = (i + 1) % n_d
            if len(idxs) > n_d:  # pragma: no cover - defensive
                return []
        return idxs

    # Refine theta by total-least-squares over each axis run's detail points:
    # the initial histogram estimate inherits Douglas-Peucker artifacts
    # (anchor-dependent corner merges tilt simplified edges), while a PCA
    # line through the raw staircase vertices recovers the true edge
    # direction to a fraction of a degree.
    if positions is not None:
        dev_sum = 0.0
        weight_sum = 0.0
        for run in runs:
            if run.cls not in ("H", "V"):
                continue
            idxs = [i for j in run.edge_idx for i in _detail_chain(j)]
            if not idxs:
                continue
            pts = rot_d[idxs + [(idxs[-1] + 1) % n_d]]
            if len(pts) < 2:
                continue
            centered = pts - pts.mean(axis=0)
            cov = centered.T @ centered
            evals, evecs = np.linalg.eigh(cov)
            direction = evecs[:, int(np.argmax(evals))]
            phi = math.degrees(math.atan2(float(direction[1]), float(direction[0])))
            target = 0.0 if run.cls == "H" else 90.0
            dev = (phi - target + 45.0) % 90.0 - 45.0
            weight = float(sum(len_c[j] for j in run.edge_idx))
            dev_sum += weight * dev
            weight_sum += weight
        if weight_sum > 0:
            dtheta = dev_sum / weight_sum
            if abs(dtheta) <= params.snap_tol_deg:
                theta = theta + dtheta
                rot_d = _rotate(detail_open, -theta, center)
                rot_c = _rotate(coarse_open, -theta, center)
                _, len_d, _ = _edge_vectors(rot_d)

    def _axis_line(run: _Run) -> tuple[np.ndarray, np.ndarray] | None:
        """Weighted mean line over the detail edges spanned by this run."""
        if positions is None:
            return _run_line(run, rot_c, len_c)
        detail_idx = [i for j in run.edge_idx for i in _detail_chain(j)]
        total = float(sum(len_d[i] for i in detail_idx))
        if total <= 0:
            return None
        axis = 1 if run.cls == "H" else 0
        c = (
            sum(
                len_d[i] * (rot_d[i, axis] + rot_d[(i + 1) % n_d, axis]) / 2.0
                for i in detail_idx
            )
            / total
        )
        if run.cls == "H":
            return np.array([0.0, c]), np.array([1.0, 0.0])
        return np.array([c, 0.0]), np.array([0.0, 1.0])

    lines = []
    for run in runs:
        line = _axis_line(run) if run.cls in ("H", "V") else _run_line(run, rot_c, len_c)
        if line is None:
            return None
        lines.append(line)

    diameter = float(np.max(rot_c.max(axis=0) - rot_c.min(axis=0)))
    corners: list[np.ndarray] = []
    for i in range(len(lines)):
        pt = _intersect(lines[i], lines[(i + 1) % len(lines)])
        if pt is None:
            return None
        if float(np.hypot(*(pt - center))) > 4.0 * max(diameter, 1.0):
            return None  # runaway intersection of nearly-parallel lines
        corners.append(pt)

    # dedupe consecutive near-identical corners
    dedup: list[np.ndarray] = []
    for pt in corners:
        if not dedup or float(np.hypot(*(pt - dedup[-1]))) > 1e-6:
            dedup.append(pt)
    if len(dedup) > 1 and float(np.hypot(*(dedup[0] - dedup[-1]))) <= 1e-6:
        dedup.pop()
    if len(dedup) < 3:
        return None
    return _rotate(np.array(dedup), theta, center), theta


def polygon_iou(a: Polygon, b: Polygon) -> float:
    """Intersection-over-union; 0.0 on topology errors or empty union."""
    try:
        inter = a.intersection(b).area
        union = a.union(b).area
    except Exception:
        return 0.0
    if union <= 0:
        return 0.0
    return float(inter / union)


def regularize_polygon(
    poly: Polygon,
    params: RegularizeParams | None = None,
    detail: Polygon | None = None,
) -> tuple[Polygon, dict[str, Any]]:
    """Orthogonally regularize a polygon; falls back to the input on any doubt.

    ``detail`` is the unsimplified source geometry (the raw pixel-boundary
    polygon in the pipeline) used for precise line fitting; when omitted,
    ``poly`` itself serves as the detail ring.

    Returns (polygon, info) where info carries: applied, dominant_angle_deg,
    ortho_fraction, reg_iou, reason (when not applied).
    """
    params = params or RegularizeParams()
    # theta from the FINE ring (best angular precision); runs/lines from a
    # COARSER ring (noise-robust structure)
    fine_rings = [_ring_open(poly.exterior.coords)] + [
        _ring_open(r.coords) for r in poly.interiors
    ]
    theta, _ = dominant_angle(fine_rings, params)

    work = poly
    if params.pre_simplify_px > 0:
        coarse = poly.simplify(params.pre_simplify_px, preserve_topology=True)
        if not coarse.is_empty and coarse.is_valid and coarse.geom_type == "Polygon":
            work = coarse
    ext = _ring_open(work.exterior.coords)
    holes = [_ring_open(r.coords) for r in work.interiors]
    frac = snappable_fraction([ext] + holes, theta, params.snap_tol_deg)
    info: dict[str, Any] = {
        "applied": False,
        "dominant_angle_deg": round(theta, 3),
        "ortho_fraction": round(frac, 4),
        "reg_iou": None,
    }
    if len(ext) < 4:
        info["reason"] = "too_few_vertices"
        return poly, info
    if frac < params.min_ortho_fraction:
        info["reason"] = "below_ortho_threshold"
        return poly, info

    detail_poly = poly
    if (
        detail is not None
        and detail.geom_type == "Polygon"
        and len(detail.interiors) == len(poly.interiors)
    ):
        detail_poly = detail
    detail_ext = _ring_open(detail_poly.exterior.coords)
    detail_holes = [_ring_open(r.coords) for r in detail_poly.interiors]

    center = ext.mean(axis=0)
    ext_result = _regularize_ring(detail_ext, ext, theta, center, params)
    if ext_result is None:
        info["reason"] = "degenerate_ring"
        return poly, info
    new_ext, theta_used = ext_result
    info["dominant_angle_deg"] = round(theta_used % 90.0, 3)
    fine_holes = fine_rings[1:] if len(fine_rings) - 1 == len(holes) else holes
    new_holes: list[np.ndarray] = []
    for i, (detail_hole, hole) in enumerate(zip(detail_holes, holes)):
        hole_result = _regularize_ring(detail_hole, hole, theta_used, center, params)
        new_holes.append(hole_result[0] if hole_result is not None else fine_holes[i])

    try:
        candidate = Polygon(new_ext, new_holes)
    except Exception:
        info["reason"] = "invalid_construction"
        return poly, info
    if candidate.is_empty or not candidate.is_valid:
        info["reason"] = "invalid_geometry"
        return poly, info

    if poly.area <= 0:
        info["reason"] = "zero_area_input"
        return poly, info
    area_ratio = candidate.area / poly.area
    iou = polygon_iou(candidate, poly)
    if abs(area_ratio - 1.0) > params.max_area_dev or iou < params.min_iou:
        info["reason"] = "low_fidelity"
        info["reg_iou"] = round(iou, 4)
        return poly, info

    info["applied"] = True
    info["reg_iou"] = round(iou, 4)
    info.pop("reason", None)
    return candidate, info


# ---------------------------------------------------------------------------
# Full pipeline
# ---------------------------------------------------------------------------


def _polygon_to_world(poly: Polygon, gt: GeoTransform) -> Polygon:
    shell = gt.px_to_world(np.asarray(poly.exterior.coords))
    holes = [gt.px_to_world(np.asarray(r.coords)) for r in poly.interiors]
    return Polygon(shell, holes)


def mask_to_features(
    mask: np.ndarray,
    transform: GeoTransform | None = None,
    params: PolygonizeParams | None = None,
) -> list[dict[str, Any]]:
    """Boolean mask -> list of GeoJSON Feature dicts (world coords).

    Pipeline: extract (pixel space) -> area filter -> simplify ->
    orthogonal regularization (pixel space, where pixels are ~square in
    meters) -> world transform -> orient (GeoJSON right-hand rule).
    """
    transform = transform or GeoTransform.identity()
    params = params or PolygonizeParams()
    if params.denoise and float(np.asarray(mask).astype(bool).sum()) >= params.min_denoise_area_px:
        mask = denoise_mask(mask)

    features: list[dict[str, Any]] = []
    for pixel_poly in extract_polygons(mask, params.backend):
        if pixel_poly.area < params.min_area_px:
            continue
        simplified = pixel_poly.simplify(params.simplify_tol_px, preserve_topology=True)
        if simplified.is_empty or not simplified.is_valid or simplified.geom_type != "Polygon":
            simplified = pixel_poly
        regularized, info = regularize_polygon(
            simplified, params.regularize, detail=pixel_poly
        )
        world = orient(_polygon_to_world(regularized, transform), sign=1.0)
        features.append(
            {
                "type": "Feature",
                "geometry": mapping(world),
                "properties": {
                    "regularized": bool(info["applied"]),
                    "dominant_angle_deg": info["dominant_angle_deg"],
                    "ortho_fraction": info["ortho_fraction"],
                    "reg_iou": info["reg_iou"],
                    "area_px": round(float(pixel_poly.area), 2),
                    "n_vertices": len(world.exterior.coords) - 1,
                },
            }
        )
    # biggest first: the primary proposal is features[0]
    features.sort(key=lambda f: f["properties"]["area_px"], reverse=True)
    return features
