#!/usr/bin/env python3
"""Translate Lightning factor names without changing any tensor bytes."""
import argparse, json, pathlib, shutil, struct

def normalize(source, destination):
    with source.open('rb') as reader:
        size = struct.unpack('<Q', reader.read(8))[0]
        header = json.loads(reader.read(size))
        renamed = {key.replace('.lora.down.weight', '.lora_A.weight').replace('.lora.up.weight', '.lora_B.weight'): value for key, value in header.items()}
        if len(renamed) != len(header): raise ValueError('Tensor name collision')
        data = json.dumps(renamed, separators=(',', ':')).encode()
        data += b' ' * (-len(data) % 8)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix('.tmp')
        with temporary.open('wb') as writer:
            writer.write(struct.pack('<Q', len(data)))
            writer.write(data)
            shutil.copyfileobj(reader, writer)
        temporary.replace(destination)

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--cache', type=pathlib.Path, default=pathlib.Path('/Volumes/Data/Users/paul/.cache/huggingface/hub'))
    cache = p.parse_args().cache
    root = cache / 'models--lightx2v--Qwen-Image-2.1-Lightning'
    source = root / 'snapshots' / (root / 'refs/main').read_text().strip() / 'pytorch_lora_weights.safetensors'
    normalize(source, cache / 'vpipe-prepared/Qwen-Image-2.1-Lightning.safetensors')
