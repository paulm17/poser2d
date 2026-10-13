import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const ipc = url(compile(await readFile(new URL('../src/ipc.ts', import.meta.url), 'utf8')));
const source = compile(await readFile(new URL('../src/engine.ts', import.meta.url), 'utf8')).replace('"./ipc"', JSON.stringify(ipc));
const { mergePaths, emptyPaths } = await import(url(source));
const defaults = { ...emptyPaths, cli: '/bundled/sd-cli', model: '/cache/model', vae: '/cache/vae', llm: '/cache/llm', vision: '/cache/mmproj-F16.gguf', turbo: true };

test('fills missing vision when existing model settings are saved', () => {
  const saved = { ...emptyPaths, model: '/custom/model', vae: '/custom/vae', llm: '/custom/llm', turbo: false };
  assert.deepEqual(mergePaths(saved, defaults), { ...saved, cli: defaults.cli, vision: defaults.vision });
  assert.equal(saved.vision, '');
});
test('preserves explicit vision and executable paths', () => {
  const saved = { ...defaults, cli: '/custom/sd-cli', vision: '/custom/vision' };
  assert.deepEqual(mergePaths(saved, defaults), saved);
});
test('new setup uses detected defaults and preserves manually selected components', () => {
  assert.deepEqual(mergePaths(emptyPaths, defaults), defaults);
  assert.equal(mergePaths({ ...emptyPaths, vision: '/custom/vision' }, defaults).vision, '/custom/vision');
});

test('fills enhancer paths while preserving manual configuration', () => {
  const detected = { ...defaults, pe_cli: '/mlx-rs/generate', pe_model: '/cache/pe.gguf', pe_system: '/cache/system_prompt.txt' };
  const saved = { ...defaults, pe_model: '/custom/pe.gguf' };
  const merged = mergePaths(saved, detected);
  assert.equal(merged.pe_model, saved.pe_model);
  assert.equal(merged.pe_cli, detected.pe_cli);
  assert.equal(merged.pe_system, detected.pe_system);
});

 test('fills cached pose LoRA without overriding a saved disable or strength', () => {
  const detected = { ...defaults, pose_lora: '/cache/pose.safetensors' };
  const saved = { ...defaults, pose_enabled: false, pose_strength: 0.5 };
  const merged = mergePaths(saved, detected);
  assert.equal(merged.pose_lora, detected.pose_lora);
  assert.equal(merged.pose_enabled, false);
  assert.equal(merged.pose_strength, 0.5);
  assert.equal(mergePaths({ ...saved, pose_lora: '/custom/pose.safetensors' }, detected).pose_lora, '/custom/pose.safetensors');
});
