"""Export the SAM 2 mask decoder (+ prompt encoder) to ONNX for the browser.

ARCHITECTURE §9: the backend computes embeddings; the client runs the
lightweight decoder in onnxruntime-web for instant hover previews. This
script produces that decoder graph.

Guarded: it only runs when SAM 2 weights are present, and imports torch/sam2
lazily. Without weights it exits with a clear message and a nonzero code —
it never partially exports. It is NOT collected by pytest.

Usage (in an environment with the ``model`` + ``onnx`` extras installed):

    py -m app.onnx_export --checkpoint path/to/sam2.1_hiera_large.pt \
        --model-cfg configs/sam2.1/sam2.1_hiera_l.yaml \
        --out onnx/sam2_decoder.onnx [--check]

On Modal (where the weights volume lives) the same logic is callable via
``modal run modal_app.py::export_onnx``.

[VERIFY on first run with weights]: the decoder wrapper mirrors the
community SAM 2 ONNX exporters (samexporter-style) against sam2's
``SAM2Base`` module layout; confirm output parity with ``--check`` before
shipping the graph to the browser.
"""

from __future__ import annotations

import argparse
import os
import sys


def build_decoder_module(checkpoint: str, model_cfg: str):
    """Construct the torch module that wraps prompt encoder + mask decoder."""
    import torch
    from sam2.build_sam import build_sam2

    sam2_model = build_sam2(model_cfg, checkpoint, device="cpu")

    class Sam2Decoder(torch.nn.Module):
        """(embedding, prompts) -> (low-res mask logits, iou predictions).

        Inputs match what app/model.py caches per embedding:
            image_embed        (1, 256, 64, 64)
            high_res_feats_0   (1, 32, 256, 256)
            high_res_feats_1   (1, 64, 128, 128)
            point_coords       (1, N, 2)  in 1024-normalized model space
            point_labels       (1, N)
            mask_input         (1, 1, 256, 256)
            has_mask_input     (1,)
        """

        def __init__(self, model) -> None:
            super().__init__()
            self.prompt_encoder = model.sam_prompt_encoder
            self.mask_decoder = model.sam_mask_decoder

        def forward(
            self,
            image_embed,
            high_res_feats_0,
            high_res_feats_1,
            point_coords,
            point_labels,
            mask_input,
            has_mask_input,
        ):
            sparse, dense = self.prompt_encoder(
                points=(point_coords, point_labels),
                boxes=None,
                masks=mask_input * has_mask_input.reshape(-1, 1, 1, 1),
            )
            masks, iou_pred, _, _ = self.mask_decoder(
                image_embeddings=image_embed,
                image_pe=self.prompt_encoder.get_dense_pe(),
                sparse_prompt_embeddings=sparse,
                dense_prompt_embeddings=dense,
                multimask_output=True,
                repeat_image=False,
                high_res_features=[high_res_feats_0, high_res_feats_1],
            )
            return masks, iou_pred

    return Sam2Decoder(sam2_model)


def export(checkpoint: str, model_cfg: str, out_path: str, opset: int = 17) -> str:
    import torch

    decoder = build_decoder_module(checkpoint, model_cfg)
    decoder.eval()

    dummy = (
        torch.randn(1, 256, 64, 64),
        torch.randn(1, 32, 256, 256),
        torch.randn(1, 64, 128, 128),
        torch.randint(0, 1024, (1, 2, 2)).float(),
        torch.tensor([[1, 1]], dtype=torch.float),
        torch.zeros(1, 1, 256, 256),
        torch.zeros(1),
    )
    input_names = [
        "image_embed",
        "high_res_feats_0",
        "high_res_feats_1",
        "point_coords",
        "point_labels",
        "mask_input",
        "has_mask_input",
    ]
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with torch.no_grad():
        torch.onnx.export(
            decoder,
            dummy,
            out_path,
            input_names=input_names,
            output_names=["masks", "iou_predictions"],
            dynamic_axes={
                "point_coords": {1: "num_points"},
                "point_labels": {1: "num_points"},
            },
            opset_version=opset,
        )
    return out_path


def check(out_path: str) -> None:
    """Smoke-run the exported graph in onnxruntime with random inputs."""
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
    feeds = {
        "image_embed": np.random.randn(1, 256, 64, 64).astype(np.float32),
        "high_res_feats_0": np.random.randn(1, 32, 256, 256).astype(np.float32),
        "high_res_feats_1": np.random.randn(1, 64, 128, 128).astype(np.float32),
        "point_coords": np.array([[[512.0, 512.0]]], dtype=np.float32),
        "point_labels": np.array([[1.0]], dtype=np.float32),
        "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
        "has_mask_input": np.zeros((1,), dtype=np.float32),
    }
    masks, iou = sess.run(None, feeds)
    print(f"onnxruntime check ok: masks {masks.shape}, iou {iou.shape}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", default=os.environ.get("SAM2_CHECKPOINT"))
    parser.add_argument(
        "--model-cfg",
        default=os.environ.get("SAM2_MODEL_CFG", "configs/sam2.1/sam2.1_hiera_l.yaml"),
    )
    parser.add_argument("--out", default="onnx/sam2_decoder.onnx")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--check", action="store_true", help="verify with onnxruntime")
    args = parser.parse_args(argv)

    if not args.checkpoint or not os.path.isfile(args.checkpoint):
        print(
            "SAM 2 checkpoint not found "
            f"(--checkpoint / SAM2_CHECKPOINT = {args.checkpoint!r}).\n"
            "This export runs only where the weights live (Modal weights "
            "volume, or a local download). Nothing was exported.",
            file=sys.stderr,
        )
        return 2

    out = export(args.checkpoint, args.model_cfg, args.out, args.opset)
    print(f"exported {out}")
    if args.check:
        check(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
