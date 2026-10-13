import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const ipc = url(compile(await readFile(new URL('../src/ipc.ts', import.meta.url), 'utf8')));
const source = compile(await readFile(new URL('../src/engine.ts', import.meta.url), 'utf8')).replace('"./ipc"', JSON.stringify(ipc));
const { mergePaths, emptyPaths, initialModelId, selectModelPaths } = await import(url(source));
const defaults = {...emptyPaths,cli:'/bundled/vpipe',model:'/cache/4bit',model8:'/cache/8bit',vae:'/cache/vae',llm:'/cache/encoder',pe_cli:'/bundled/vpipe',pe_model:'/cache/enhancer',pe_system:'/cache/system.txt',turbo:true};
test('migrates sd-cli and GGUF paths and preserves pose preferences',()=>{
 const saved={...emptyPaths,cli:'/old/sd-cli',model:'/old/turbo.gguf',pe_model:'/old/pe.gguf',pose_enabled:false,pose_strength:0.5};
 const merged=mergePaths(saved,defaults);
 assert.equal(merged.cli,defaults.cli);assert.equal(merged.model,defaults.model);assert.equal(merged.pe_model,defaults.pe_model);assert.equal(merged.pose_enabled,false);assert.equal(merged.pose_strength,0.5);assert.equal(saved.model,'/old/turbo.gguf');
});
test('fills new paths and defaults to four bit',()=>{
 assert.deepEqual(mergePaths(emptyPaths,defaults),defaults);
 assert.equal(mergePaths({...emptyPaths,quant_bits:undefined},defaults).quant_bits,4);
});
test('preserves custom vpipe components and eight bit selection',()=>{
 const saved={...defaults,cli:'/custom/vpipe',model:'/custom/model',pe_model:'/custom/enhancer',quant_bits:8};
 assert.deepEqual(mergePaths(saved,defaults),saved);
});
test('fills pose path without re-enabling a disabled adapter',()=>{
 const merged=mergePaths({...defaults,pose_enabled:false,pose_strength:0.5},{...defaults,pose_lora:'/cache/pose.safetensors'});
 assert.equal(merged.pose_lora,'/cache/pose.safetensors');assert.equal(merged.pose_enabled,false);assert.equal(merged.pose_strength,0.5);
});

test('model selection migrates precision and validates saved identifiers', () => {
 assert.equal(initialModelId(null, 8), 'turbo-8');
 assert.equal(initialModelId('invalid', 4), 'turbo-4');
 assert.equal(initialModelId('base-8', 4), 'base-8');
});
test('all four models preserve Pose and only Turbo disables Lightning', () => {
 for (const id of ['turbo-4','turbo-8','base-4','base-8']) {
  const selected = selectModelPaths({...defaults,pose_enabled:true,lightning_enabled:true},id);
  assert.equal(selected.quant_bits, id.endsWith('8') ? 8 : 4);
  assert.equal(selected.turbo,id.startsWith('turbo'));
  assert.equal(selected.pose_enabled,true);
  assert.equal(selected.lightning_enabled,id.startsWith('base'));
 }
});
