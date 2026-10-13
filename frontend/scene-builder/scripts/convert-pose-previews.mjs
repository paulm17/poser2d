// Run after regenerating the upstream MP4 previews. No Blender is needed.
import { readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const directory = fileURLToPath(new URL('../public/poses2/', import.meta.url));
const files = (await readdir(directory)).filter(file => file.endsWith('.mp4'));
let completed = 0;
async function convert(file) {
  const output = join(directory, file.replace(/\.mp4$/, '.webm'));
  const source = join(directory, file);
  try { if ((await stat(output)).mtimeMs >= (await stat(source)).mtimeMs) return; } catch { /* First conversion. */ }
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', source, '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-threads', '1', '-crf', '32', '-b:v', '0', output], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', data => { errors += data; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(`${file}: ${errors}`)));
  });
  completed++;
}
await Promise.all(Array.from({ length: 4 }, async () => { while (files.length) await convert(files.pop()); }));
console.log(`Converted ${completed} previews to WebM.`);
