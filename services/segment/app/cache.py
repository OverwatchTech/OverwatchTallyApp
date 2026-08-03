"""Embedding cache with an object-storage-shaped interface.

The store speaks opaque ``a/b/c``-style string keys and bytes — exactly the
shape of an object store — so the same :class:`EmbeddingCache` runs unchanged
against a local directory in dev and a Modal Volume mounted at a path in
production (a Modal Volume *is* a directory to the container; see
``modal_app.py``). If the cache ever moves to S3/R2, only ``ObjectStore``
gets a new implementation.
"""

from __future__ import annotations

import io
import json
import re
from pathlib import Path
from typing import Any, Protocol

import numpy as np

_KEY_RE = re.compile(r"^[A-Za-z0-9._\-]+(/[A-Za-z0-9._\-]+)*$")


class CacheKeyError(ValueError):
    """Key is not a safe object key."""


def validate_key(key: str) -> str:
    if not _KEY_RE.match(key) or ".." in key.split("/"):
        raise CacheKeyError(f"invalid cache key: {key!r}")
    return key


class ObjectStore(Protocol):
    """Minimal object-storage surface: opaque keys, bytes values."""

    def get(self, key: str) -> bytes | None: ...

    def put(self, key: str, data: bytes) -> None: ...

    def exists(self, key: str) -> bool: ...

    def delete(self, key: str) -> None: ...


class LocalDirStore:
    """ObjectStore over a local directory (or a mounted Modal Volume).

    Lazy: the root directory is only created on first write, so importing
    the app never litters the filesystem.
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        validate_key(key)
        return self.root.joinpath(*key.split("/"))

    def get(self, key: str) -> bytes | None:
        p = self._path(key)
        try:
            return p.read_bytes()
        except FileNotFoundError:
            return None

    def put(self, key: str, data: bytes) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(p)  # atomic-enough on one filesystem

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def delete(self, key: str) -> None:
        p = self._path(key)
        try:
            p.unlink()
        except FileNotFoundError:
            pass


class EmbeddingCache:
    """Typed helpers over an ObjectStore for SAM 2 embeddings.

    Layout per embedding key K:
        K/meta.json       bbox, size, geotransform, farm, imagery metadata
        K/embedding.npz   dict of float arrays (image_embed, high-res feats)
    """

    def __init__(self, store: ObjectStore) -> None:
        self.store = store

    def has(self, key: str) -> bool:
        return self.store.exists(f"{key}/meta.json") and self.store.exists(
            f"{key}/embedding.npz"
        )

    def save(self, key: str, arrays: dict[str, np.ndarray], meta: dict[str, Any]) -> None:
        buf = io.BytesIO()
        np.savez_compressed(buf, **arrays)
        self.store.put(f"{key}/embedding.npz", buf.getvalue())
        self.store.put(
            f"{key}/meta.json", json.dumps(meta, separators=(",", ":")).encode("utf-8")
        )

    def load_meta(self, key: str) -> dict[str, Any] | None:
        raw = self.store.get(f"{key}/meta.json")
        if raw is None:
            return None
        return json.loads(raw.decode("utf-8"))

    def load_arrays(self, key: str) -> dict[str, np.ndarray] | None:
        raw = self.store.get(f"{key}/embedding.npz")
        if raw is None:
            return None
        with np.load(io.BytesIO(raw)) as npz:
            return {name: npz[name] for name in npz.files}
