"""SF3D-specific adapter: consume each lazy triplane query in its decoder.

SF3D uses query_triplane only immediately before decoder(), optionally with
[0] to remove the batch dimension. This adapter preserves that contract while
keeping sampled feature storage bounded by chunk_size.
"""
import torch


def install_chunked_queries(model, chunk_size):
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    original_query = model.query_triplane
    original_decoder = model.decoder.forward

    class Query:
        def __init__(self, positions, planes):
            self.positions, self.planes = positions, planes

        def __getitem__(self, index):
            if index != 0:
                raise IndexError(index)
            self.squeeze = True
            return self

    def query(positions, planes):
        return Query(positions, planes)

    def decode(value, *pos, **kw):
        if not isinstance(value, Query):
            return original_decoder(value, *pos, **kw)
        positions, planes = value.positions, value.planes
        outputs = {}
        total = positions.shape[-2]
        for start in range(0, total, chunk_size):
            features = original_query(positions[..., start:start+chunk_size, :], planes)
            if getattr(value, "squeeze", False):
                features = features[0]
            chunk = original_decoder(features, *pos, **kw)
            for key, tensor in chunk.items():
                if key not in outputs:
                    shape = list(tensor.shape)
                    shape[-2] = total
                    outputs[key] = torch.empty(shape, dtype=tensor.dtype, device=tensor.device)
                outputs[key][..., start:start+tensor.shape[-2], :] = tensor
        if not outputs:
            features = original_query(positions, planes)
            if getattr(value, "squeeze", False):
                features = features[0]
            return original_decoder(features, *pos, **kw)
        return outputs

    model.query_triplane = query
    model.decoder.forward = decode
