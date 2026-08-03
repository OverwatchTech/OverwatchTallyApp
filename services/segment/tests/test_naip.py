"""NAIP source: sizing math, request construction, stub determinism.

The live-network smoke test runs only with SEGMENT_NETWORK_TESTS=1 so the
suite stays green offline.
"""

from __future__ import annotations

import math
import os

import numpy as np
import pytest

from app.config import Settings
from app.geo import BBox, BBoxError, size_for_gsd
from app.naip import (
    StubNAIPSource,
    USGSNAIPImageServer,
    _date_to_time_param,
    embedding_key,
    make_source,
)


class TestBBox:
    def test_valid(self):
        bbox = BBox(-98.0, 33.0, -97.9, 33.1)
        assert bbox.mid_lat == pytest.approx(33.05)

    @pytest.mark.parametrize(
        "coords",
        [
            (-97.9, 33.0, -98.0, 33.1),  # west > east
            (-98.0, 33.1, -97.9, 33.0),  # south > north
            (-98.0, 33.0, -98.0, 33.1),  # zero width
            (-181.0, 33.0, -97.9, 33.1),  # out of range
            (-98.0, -91.0, -97.9, 33.1),
        ],
    )
    def test_invalid(self, coords):
        with pytest.raises(BBoxError):
            BBox(*coords)


class TestSizing:
    def test_pixels_square_in_meters(self):
        """Requested size must correct for cos(lat) so ground pixels are
        square — angles feeding regularization depend on it."""
        bbox = BBox(-98.0, 35.0, -97.99, 35.01)
        w, h = size_for_gsd(bbox, gsd_m=1.0, max_px=4096)
        width_m, height_m = bbox.size_meters()
        assert w == pytest.approx(width_m, abs=1)
        assert h == pytest.approx(height_m, abs=1)
        # equal degree spans are NOT equal pixel spans away from the equator
        assert h > w
        assert w / h == pytest.approx(math.cos(math.radians(35.0)) * (111320 / 110540), rel=0.01)

    def test_max_px_cap_preserves_aspect(self):
        bbox = BBox(-98.0, 35.0, -97.9, 35.05)
        w, h = size_for_gsd(bbox, gsd_m=0.3, max_px=2048)
        assert max(w, h) == 2048
        w0, h0 = size_for_gsd(bbox, gsd_m=0.3, max_px=10**6)
        assert w / h == pytest.approx(w0 / h0, rel=0.01)

    def test_min_px_floor(self):
        bbox = BBox(-98.0, 35.0, -97.99999, 35.00001)
        w, h = size_for_gsd(bbox, gsd_m=100.0, min_px=32)
        assert w >= 32 and h >= 32

    def test_bad_gsd(self):
        with pytest.raises(ValueError):
            size_for_gsd(BBox(-98.0, 35.0, -97.9, 35.1), gsd_m=0)


class TestUSGSRequest:
    def test_export_url_and_params(self):
        src = USGSNAIPImageServer("https://example.test/ImageServer/")
        url, params = src.build_request(BBox(-98.0, 33.0, -97.99, 33.01), (512, 500))
        assert url == "https://example.test/ImageServer/exportImage"
        assert params["bbox"] == "-98.0,33.0,-97.99,33.01"
        assert params["bboxSR"] == "4326"
        assert params["imageSR"] == "4326"
        assert params["size"] == "512,500"
        assert params["f"] == "image"
        assert "time" not in params

    def test_imagery_date_becomes_time_extent(self):
        src = USGSNAIPImageServer("https://example.test/ImageServer")
        _, params = src.build_request(
            BBox(-98.0, 33.0, -97.99, 33.01), (64, 64), imagery_date="2023-06-01"
        )
        start, end = map(int, params["time"].split(","))
        assert end - start == 24 * 3600 * 1000 - 1
        assert start == 1685577600000  # 2023-06-01T00:00Z

    def test_time_param_format(self):
        assert _date_to_time_param("1970-01-01") == "0,86399999"

    def test_year_vintage_becomes_full_year_window(self):
        """Verified live: exact-day windows off an acquisition date return an
        empty image, so vintage years are the recommended request unit."""
        assert _date_to_time_param("1970") == "0,31535999999"
        start, end = map(int, _date_to_time_param("2022").split(","))
        assert start == 1640995200000  # 2022-01-01T00:00Z
        assert end == 1672531200000 - 1  # 2023-01-01T00:00Z - 1ms

    def test_year_vintage_in_request(self):
        src = USGSNAIPImageServer("https://example.test/ImageServer")
        _, params = src.build_request(
            BBox(-98.0, 33.0, -97.99, 33.01), (64, 64), imagery_date="2022"
        )
        assert params["time"] == _date_to_time_param("2022")


class TestStubSource:
    def test_deterministic(self):
        src = StubNAIPSource()
        bbox = BBox(-98.0, 33.0, -97.999, 33.001)
        a = src.fetch(bbox, (64, 48))
        b = src.fetch(bbox, (64, 48))
        np.testing.assert_array_equal(a.array, b.array)
        assert a.transform == b.transform

    def test_different_dates_differ(self):
        src = StubNAIPSource()
        bbox = BBox(-98.0, 33.0, -97.999, 33.001)
        a = src.fetch(bbox, (32, 32), "2022-01-01")
        b = src.fetch(bbox, (32, 32), "2023-01-01")
        assert not np.array_equal(a.array, b.array)

    def test_shape_and_dtype(self):
        img = StubNAIPSource().fetch(BBox(-98.0, 33.0, -97.999, 33.001), (40, 30))
        assert img.array.shape == (30, 40, 3)
        assert img.array.dtype == np.uint8
        assert img.width == 40 and img.height == 30

    def test_size_capped(self):
        img = StubNAIPSource(max_px=64).fetch(
            BBox(-98.0, 33.0, -97.9, 33.1), (4096, 2048)
        )
        assert max(img.width, img.height) <= 64


class TestSourceFactoryAndKeys:
    def test_make_source(self):
        assert make_source(Settings(naip_source="stub")).id == "stub"
        assert make_source(Settings(naip_source="usgs")).id == "usgs_naip_imageserver"
        with pytest.raises(ValueError):
            make_source(Settings(naip_source="google"))  # licensing rule: never

    def test_embedding_key_shape(self):
        bbox = BBox(-98.0, 33.0, -97.99, 33.01)
        key = embedding_key("farm-1", "2023-06-01", bbox, (512, 500), "usgs_naip_imageserver")
        assert key.startswith("farm-1/2023-06-01/")
        assert len(key.split("/")[-1]) == 16

    def test_embedding_key_varies_with_inputs(self):
        bbox = BBox(-98.0, 33.0, -97.99, 33.01)
        base = embedding_key("f", None, bbox, (512, 500), "s")
        assert embedding_key("f", None, bbox, (512, 501), "s") != base
        assert embedding_key("f", "2023-06-01", bbox, (512, 500), "s") != base
        assert embedding_key("g", None, bbox, (512, 500), "s").split("/")[0] == "g"
        other = BBox(-98.0, 33.0, -97.99, 33.0100001)
        assert embedding_key("f", None, other, (512, 500), "s") != base

    def test_key_is_cache_safe(self):
        from app.cache import validate_key

        bbox = BBox(-98.0, 33.0, -97.99, 33.01)
        validate_key(embedding_key("farm-1", "2023-06-01", bbox, (10, 10), "usgs"))
        validate_key(embedding_key("farm-1", None, bbox, (10, 10), "usgs"))


@pytest.mark.network
@pytest.mark.skipif(
    not os.environ.get("SEGMENT_NETWORK_TESTS"),
    reason="set SEGMENT_NETWORK_TESTS=1 to hit the public USGS NAIP endpoint",
)
class TestLiveNAIP:
    def test_fetch_real_naip_tile(self):
        """Small CONUS bbox (rural Texas) through the public endpoint."""
        src = USGSNAIPImageServer(Settings().usgs_base_url, timeout_s=60)
        bbox = BBox(-98.505, 33.500, -98.500, 33.504)
        img = src.fetch(bbox, size_for_gsd(bbox, 1.0, max_px=512))
        assert img.array.ndim == 3 and img.array.shape[2] == 3
        assert img.array.any()
        assert img.meta["source"] == "usgs_naip_imageserver"
