"""Validate the upstream Gaussian file formats after export (host file I/O)."""
from pathlib import Path
import numpy as np


def validate_exports(ply_path, splat_path, count):
    with open(ply_path, "rb") as f:
        if f.readline() != b"ply\n" or f.readline() != b"format binary_little_endian 1.0\n":
            raise ValueError("Invalid Gaussian PLY header")
        properties = []
        declared = None
        for _ in range(128):
            line = f.readline().decode("ascii").strip()
            if line.startswith("element vertex "):
                declared = int(line.split()[-1])
            elif line.startswith("property float "):
                properties.append((line.split()[-1], "<f4"))
            elif line == "end_header":
                break
            elif not line:
                raise ValueError("Truncated Gaussian PLY header")
            else:
                raise ValueError(f"Unexpected Gaussian PLY field: {line}")
        else:
            raise ValueError("Oversized Gaussian PLY header")
        if declared != count or len(properties) != 17:
            raise ValueError("Gaussian PLY count/property mismatch")
        data = np.frombuffer(f.read(), dtype=np.dtype(properties))
        if len(data) != count or not all(np.isfinite(data[name]).all() for name, _ in properties):
            raise ValueError("Invalid Gaussian PLY data")
    dtype = np.dtype([("position", "<f4", 3), ("scale", "<f4", 3),
                      ("rgba", "u1", 4), ("rotation", "u1", 4)])
    if Path(splat_path).stat().st_size != count*32:
        raise ValueError("Gaussian SPLAT size/count mismatch")
    packed = np.fromfile(splat_path, dtype=dtype)
    if not np.isfinite(packed["position"]).all() or not np.isfinite(packed["scale"]).all() or not (packed["scale"] > 0).all():
        raise ValueError("Invalid Gaussian SPLAT attributes")
    return {"ply_count": count, "splat_count": count, "ply_bytes": Path(ply_path).stat().st_size,
            "splat_bytes": Path(splat_path).stat().st_size}
