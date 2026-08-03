"""Object-store cache: keys are opaque and safe, round-trips are lossless."""

from __future__ import annotations

import numpy as np
import pytest

from app.cache import CacheKeyError, EmbeddingCache, LocalDirStore, validate_key


class TestKeyValidation:
    @pytest.mark.parametrize(
        "key",
        ["farm-1/2023-06-01/abc123", "a", "a/b/c.d-e_f", "farm_9/latest/0f3a"],
    )
    def test_good_keys(self, key):
        assert validate_key(key) == key

    @pytest.mark.parametrize(
        "key",
        ["", "../etc/passwd", "a/../b", "a//b", "/abs", "a/b/", "a\\b", "a b", "a/..", ".."],
    )
    def test_bad_keys_rejected(self, key):
        with pytest.raises(CacheKeyError):
            validate_key(key)


class TestLocalDirStore:
    def test_roundtrip(self, tmp_path):
        store = LocalDirStore(tmp_path / "cache")
        store.put("farm/latest/x/blob.bin", b"\x00\x01payload")
        assert store.get("farm/latest/x/blob.bin") == b"\x00\x01payload"
        assert store.exists("farm/latest/x/blob.bin")

    def test_missing_returns_none(self, tmp_path):
        store = LocalDirStore(tmp_path)
        assert store.get("nope/missing.bin") is None
        assert not store.exists("nope/missing.bin")

    def test_lazy_root_creation(self, tmp_path):
        root = tmp_path / "never-created"
        store = LocalDirStore(root)
        assert store.get("a/b") is None
        assert not root.exists()  # reads never litter the filesystem
        store.put("a/b", b"x")
        assert root.exists()

    def test_delete(self, tmp_path):
        store = LocalDirStore(tmp_path)
        store.put("k/v", b"data")
        store.delete("k/v")
        assert not store.exists("k/v")
        store.delete("k/v")  # idempotent

    def test_traversal_blocked_on_all_ops(self, tmp_path):
        store = LocalDirStore(tmp_path)
        for op in (store.get, store.exists, store.delete):
            with pytest.raises(CacheKeyError):
                op("../outside")
        with pytest.raises(CacheKeyError):
            store.put("../outside", b"x")

    def test_overwrite(self, tmp_path):
        store = LocalDirStore(tmp_path)
        store.put("k", b"one")
        store.put("k", b"two")
        assert store.get("k") == b"two"


class TestEmbeddingCache:
    def test_arrays_and_meta_roundtrip(self, tmp_path):
        cache = EmbeddingCache(LocalDirStore(tmp_path))
        arrays = {
            "image_embed": np.random.default_rng(0).normal(size=(1, 8, 4, 4)).astype(
                np.float32
            ),
            "orig_h": np.array([512], dtype=np.int64),
        }
        meta = {"farm_id": "farm-1", "bbox": [-98.0, 33.0, -97.99, 33.01], "width": 512}
        cache.save("farm-1/latest/abc", arrays, meta)

        assert cache.has("farm-1/latest/abc")
        loaded = cache.load_arrays("farm-1/latest/abc")
        assert set(loaded) == set(arrays)
        np.testing.assert_array_equal(loaded["image_embed"], arrays["image_embed"])
        np.testing.assert_array_equal(loaded["orig_h"], arrays["orig_h"])
        assert cache.load_meta("farm-1/latest/abc") == meta

    def test_has_requires_both_objects(self, tmp_path):
        store = LocalDirStore(tmp_path)
        cache = EmbeddingCache(store)
        store.put("k/meta.json", b"{}")
        assert not cache.has("k")  # embedding.npz missing

    def test_missing_key(self, tmp_path):
        cache = EmbeddingCache(LocalDirStore(tmp_path))
        assert cache.load_meta("nope") is None
        assert cache.load_arrays("nope") is None
        assert not cache.has("nope")
