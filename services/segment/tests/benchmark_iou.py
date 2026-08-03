"""IoU benchmark: AI auto-sketch vs the hand-drawn farm KML, per feature class.

NOT collected by pytest (no ``test_`` prefix) — this is a harness to run once
the model is live (Modal deployed, or local weights), per docs/SEGMENTATION.md.

For every polygon feature in the KML:
    1. take its envelope, padded 30%, as the /embed bbox
    2. click its representative point via /segment
    3. IoU between the returned polygon and the hand-drawn one
Aggregates mean/median IoU and the fraction >= 0.8, grouped by KML folder
(feature class: pens, hay stacks, ...). Writes a JSON report.

Usage:
    py tests/benchmark_iou.py --base-url https://<modal-app-url> \
        --kml "path/to/Farm_Project.kml" [--classes pens,hay] \
        [--token <SEGMENT_API_TOKEN>] [--out benchmark_report.json]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

import httpx
from shapely.geometry import Polygon

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from app.polygonize import polygon_iou  # noqa: E402

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}


@dataclass
class KmlFeature:
    name: str
    feature_class: str
    polygon: Polygon


@dataclass
class ClassStats:
    ious: list[float] = field(default_factory=list)
    failures: int = 0

    def summary(self) -> dict:
        if not self.ious:
            return {"n": 0, "failures": self.failures}
        return {
            "n": len(self.ious),
            "failures": self.failures,
            "mean_iou": round(statistics.mean(self.ious), 4),
            "median_iou": round(statistics.median(self.ious), 4),
            "pct_ge_080": round(
                sum(1 for i in self.ious if i >= 0.8) / len(self.ious), 4
            ),
        }


def parse_kml_polygons(path: str) -> list[KmlFeature]:
    """Placemark polygons grouped by their enclosing Folder name."""
    tree = ET.parse(path)
    features: list[KmlFeature] = []

    def walk(node: ET.Element, folder: str) -> None:
        for child in node:
            tag = child.tag.split("}")[-1]
            if tag == "Folder":
                name_el = child.find("kml:name", KML_NS)
                walk(child, name_el.text.strip() if name_el is not None else folder)
            elif tag == "Placemark":
                name_el = child.find("kml:name", KML_NS)
                name = name_el.text.strip() if name_el is not None else "unnamed"
                for coords_el in child.iter(
                    "{http://www.opengis.net/kml/2.2}coordinates"
                ):
                    # only outer boundaries of polygons
                    parent_chain = coords_el
                    pts = []
                    for token in (coords_el.text or "").split():
                        parts = token.split(",")
                        if len(parts) >= 2:
                            pts.append((float(parts[0]), float(parts[1])))
                    if len(pts) >= 4:  # closed ring
                        poly = Polygon(pts)
                        if poly.is_valid and poly.area > 0:
                            features.append(KmlFeature(name, folder, poly))
                    break  # first ring per placemark (outer boundary)
            else:
                walk(child, folder)

    walk(tree.getroot(), folder="(root)")
    return features


def padded_bbox(poly: Polygon, pad_frac: float = 0.3) -> tuple[float, float, float, float]:
    w, s, e, n = poly.bounds
    pw, ph = (e - w) * pad_frac, (n - s) * pad_frac
    pad = max(pw, ph, 1e-4)  # at least ~11 m so tiny features get context
    return (w - pad, s - pad, e + pad, n + pad)


def benchmark(
    base_url: str,
    kml_path: str,
    classes: set[str] | None,
    token: str | None,
    farm_id: str = "benchmark",
) -> dict:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    client = httpx.Client(base_url=base_url, headers=headers, timeout=300)

    features = parse_kml_polygons(kml_path)
    if classes:
        features = [
            f for f in features if any(c.lower() in f.feature_class.lower() for c in classes)
        ]
    print(f"benchmarking {len(features)} hand-drawn polygons against {base_url}")

    stats: dict[str, ClassStats] = {}
    per_feature: list[dict] = []
    for feat in features:
        cls_stats = stats.setdefault(feat.feature_class, ClassStats())
        try:
            bbox = padded_bbox(feat.polygon)
            emb = client.post(
                "/embed", json={"farm_id": farm_id, "bbox": list(bbox)}
            )
            emb.raise_for_status()
            key = emb.json()["embedding_key"]

            click = feat.polygon.representative_point()
            seg = client.post(
                "/segment",
                json={"embedding_key": key, "points": [[click.x, click.y]]},
            )
            seg.raise_for_status()
            fc = seg.json()
            if not fc["features"]:
                raise RuntimeError("empty mask")
            geom = fc["features"][0]["geometry"]
            ai_poly = Polygon(geom["coordinates"][0], geom["coordinates"][1:])
            iou = polygon_iou(ai_poly, feat.polygon)
            cls_stats.ious.append(iou)
            per_feature.append(
                {
                    "name": feat.name,
                    "class": feat.feature_class,
                    "iou": round(iou, 4),
                    "regularized": fc["features"][0]["properties"]["regularized"],
                }
            )
            print(f"  {feat.feature_class:>20} | {feat.name:<28} IoU {iou:.3f}")
        except Exception as exc:  # keep going; report failures honestly
            cls_stats.failures += 1
            per_feature.append(
                {"name": feat.name, "class": feat.feature_class, "error": str(exc)}
            )
            print(f"  {feat.feature_class:>20} | {feat.name:<28} FAILED: {exc}")

    return {
        "base_url": base_url,
        "kml": kml_path,
        "per_class": {cls: s.summary() for cls, s in sorted(stats.items())},
        "per_feature": per_feature,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--kml", required=True)
    parser.add_argument("--classes", default=None, help="comma-separated folder-name filters")
    parser.add_argument("--token", default=None)
    parser.add_argument("--out", default="benchmark_report.json")
    args = parser.parse_args(argv)

    classes = set(args.classes.split(",")) if args.classes else None
    report = benchmark(args.base_url, args.kml, classes, args.token)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps(report["per_class"], indent=2))
    print(f"full report -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
