#!/usr/bin/env python3
"""Write a local, reviewable report for the six vpipe validation jobs."""
import json, pathlib, struct
root=pathlib.Path(__file__).resolve().parents[1]
artifacts=root/'artifacts/vpipe-validation'
results=json.loads((artifacts/'results.json').read_text())
order={'t2i':0,'enhanced':1,'i2i':2}
results.sort(key=lambda r:(int(r['name'][0]),order[r['name'].split('-',1)[1]]))
lines=['# vpipe validation','', 'Test host: Apple M1 Pro, 32 GB RAM, macOS 15.6. All runs use 1024 × 1024, seed 42, and the official eight-step Turbo schedule.','', '| Model | Workflow | Result | Elapsed | Peak process RSS | Output |','| --- | --- | --- | ---: | ---: | --- |']
for r in results:
    run=artifacts/r['id']
    log=(run/'render.log').read_text() if (run/'render.log').exists() else ''
    rss=[int(l.split()[0]) for l in log.splitlines() if 'maximum resident set size' in l and l.split()[0].isdigit()]
    peak=max(rss) if rss else None
    output=run/'output.png'
    state=r['job']['state']
    if state=='completed':
        with output.open('rb') as f: hdr=f.read(24)
        assert hdr[:8]==b'\x89PNG\r\n\x1a\n' and struct.unpack('>II',hdr[16:24])==(1024,1024),r['name']
        if r['name'].endswith('i2i'):assert '-- 192 modules at scale 0.7' in log and 'SKIPPED (shape mismatch)' not in log
    elapsed=r['elapsed_seconds']
    timing=f'{int(elapsed//60)}m {elapsed%60:.1f}s'
    memory=f'{peak/1024**3:.2f} GiB' if peak else 'Unavailable'
    link=f'[PNG](<{output}>)' if output.exists() else '—'
    lines.append(f"| {r['name'][0]}-bit | {r['name'].split('-',1)[1]} | {state} | {timing} | {memory} | {link} |")
lines += ['', 'The I2I runs use the supplied character image and PoseStudio V1.1 at strength 0.7. All 192 adapter modules (384 factor tensors) must bind for an edit to pass.', '', 'Peak RSS is measured with `/usr/bin/time -l` for the inference subprocesses. It is not total system/GPU memory. VAE decoding uses overlapping 512-pixel windows, which can differ from full-frame decoding.', '', 'Each job directory retains its pipeline, full render log, and result metadata. Enhanced jobs also retain the enhancer pipeline and rewritten prompt.', '', 'Visual assessment: both edits retain the white dress, pointed ears, dark hair, and standing pose. Facial appearance changes; exact facial identity preservation is not established.', '', '## Outputs', '']
for r in results:
    if r['job']['state']=='completed':lines += [f"### {r['name']}",'',f"![{r['name']}](<{artifacts/r['id']/'output.png'}>)",'']
(artifacts/'report.md').write_text('\n'.join(lines)+'\n')
print(artifacts/'report.md')
