"""Modal deployment for the segmentation service.

Complete and ready for ``modal deploy modal_app.py`` the moment a Modal
token exists — deployment itself is deferred (no Modal account tonight).
Owner steps live in docs/SEGMENTATION.md; short version:

    pip install modal
    modal token new
    modal run modal_app.py::download_weights   # once: populate weights volume
    modal deploy modal_app.py                  # prints the web endpoint URL
    # optional hardening: create the secret so requests need a bearer token
    modal secret create segment-api SEGMENT_API_TOKEN=<random>

Volumes
-------
segment-weights        SAM 2 checkpoint (populated by download_weights)
segment-embed-cache    embedding cache; mounted where LocalDirStore points,
                       so the object-storage-shaped cache in app/cache.py is
                       backed by a durable Modal Volume with zero code change.
"""

from __future__ import annotations

import os

import modal

APP_NAME = "overwatch-segment"

SAM2_CHECKPOINT_URL = (
    "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt"
)
SAM2_CHECKPOINT_FILE = "sam2.1_hiera_large.pt"
SAM2_MODEL_CFG = "configs/sam2.1/sam2.1_hiera_l.yaml"

WEIGHTS_DIR = "/weights"
CACHE_DIR = "/cache"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0", "git")
    .pip_install(
        "torch>=2.3.1",
        "torchvision>=0.18.1",
    )
    .pip_install("git+https://github.com/facebookresearch/sam2.git")
    .pip_install(
        "fastapi>=0.115",
        "uvicorn[standard]>=0.30",
        "httpx>=0.27",
        "pillow>=10.0",
        "numpy>=1.26",
        "shapely>=2.0",
        "rasterio>=1.3",
    )
    .add_local_python_source("app")
)

weights_volume = modal.Volume.from_name("segment-weights", create_if_missing=True)
cache_volume = modal.Volume.from_name("segment-embed-cache", create_if_missing=True)

app = modal.App(APP_NAME)


@app.function(
    image=image,
    volumes={WEIGHTS_DIR: weights_volume},
    timeout=1800,
)
def download_weights() -> str:
    """One-time: fetch the SAM 2.1 checkpoint into the weights volume."""
    import urllib.request

    dest = os.path.join(WEIGHTS_DIR, SAM2_CHECKPOINT_FILE)
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        return f"already present: {dest} ({os.path.getsize(dest)} bytes)"
    tmp = dest + ".part"
    urllib.request.urlretrieve(SAM2_CHECKPOINT_URL, tmp)
    os.replace(tmp, dest)
    weights_volume.commit()
    return f"downloaded {dest} ({os.path.getsize(dest)} bytes)"


@app.function(
    image=image.pip_install("onnx>=1.16", "onnxruntime>=1.18"),
    volumes={WEIGHTS_DIR: weights_volume},
    timeout=1800,
)
def export_onnx() -> str:
    """Export the browser decoder ONNX next to the weights (then download it)."""
    from app.onnx_export import export

    out = export(
        checkpoint=os.path.join(WEIGHTS_DIR, SAM2_CHECKPOINT_FILE),
        model_cfg=SAM2_MODEL_CFG,
        out_path=os.path.join(WEIGHTS_DIR, "sam2_decoder.onnx"),
    )
    weights_volume.commit()
    return f"exported {out}; fetch with: modal volume get segment-weights sam2_decoder.onnx"


@app.function(
    image=image,
    gpu="A10G",
    volumes={WEIGHTS_DIR: weights_volume, CACHE_DIR: cache_volume},
    timeout=300,
    scaledown_window=120,
    # secrets=[modal.Secret.from_name("segment-api")],  # uncomment once created
)
@modal.concurrent(max_inputs=4)
@modal.asgi_app()
def web():
    os.environ.setdefault("SEGMENT_CACHE_DIR", os.path.join(CACHE_DIR, "embeddings"))
    os.environ.setdefault("SAM2_CHECKPOINT", os.path.join(WEIGHTS_DIR, SAM2_CHECKPOINT_FILE))
    os.environ.setdefault("SAM2_MODEL_CFG", SAM2_MODEL_CFG)
    os.environ.setdefault("SEGMENT_NAIP_SOURCE", "usgs")

    from app.main import create_app

    return create_app()
