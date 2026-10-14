#!/usr/bin/env python3
"""Compare real reference/streamed captures; default requires exact parity."""
import argparse
import json
from pathlib import Path
import numpy as np
from PIL import Image


def compare(reference, streamed):
    names = ["feature1", "feature2", "latent-latent", "latent-camera", "decoder_rng"]
    names += ["gaussian"+key for key in ("_xyz", "_features_dc", "_opacity", "_scaling", "_rotation")]
    result = {}
    for name in names:
        a = np.load(reference/f"{name}.npy", mmap_mode="r")
        b = np.load(streamed/f"{name}.npy", mmap_mode="r")
        if a.shape != b.shape:
            raise ValueError(f"Shape mismatch: {name}")
        delta = np.abs(a-b)
        result[name] = {"shape": list(a.shape), "exact": bool(np.array_equal(a, b)),
                        "max_abs": float(delta.max()), "mean_abs": float(delta.mean())}
    a, b = np.asarray(Image.open(reference/"prepared.png")), np.asarray(Image.open(streamed/"prepared.png"))
    result["prepared"] = {"exact": bool(np.array_equal(a, b))}
    result["all_exact"] = all(value["exact"] for value in result.values())
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("streamed", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = compare(args.reference, args.streamed)
    rendered = json.dumps(result, indent=2)+"\n"
    print(rendered)
    if args.report:
        args.report.write_text(rendered)
    raise SystemExit(0 if result["all_exact"] else 1)
