import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const ipc = url(compile(await readFile(new URL('../src/ipc.ts', import.meta.url), 'utf8')));
const source = compile(await readFile(new URL('../src/engine.ts', import.meta.url), 'utf8')).replace('"./ipc"', JSON.stringify(ipc));
const { mergePaths, emptyPaths, initialModelId, selectModelPaths, effectiveGuidance } = await import(url(source));
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

test('older saved paths receive I2I enhancer defaults and preserve custom paths', () => {
 const next = {...defaults, pe_i2i_model:'/cache/i2i', pe_i2i_system:'/cache/i2i/system_prompt.txt'};
 const old = {...defaults}; delete old.pe_i2i_model; delete old.pe_i2i_system;
 assert.equal(mergePaths(old,next).pe_i2i_model,next.pe_i2i_model);
 assert.equal(mergePaths(old,next).pe_i2i_system,next.pe_i2i_system);
 assert.equal(mergePaths({...next,pe_i2i_model:'/custom/i2i'},next).pe_i2i_model,'/custom/i2i');
});

test('AnyAngle temporarily locks CFG and preserves the editable value', () => {
 const cfg = 6.4;
 const adapters = [{id:'anyangle',strength:1}];
 assert.equal(effectiveGuidance(cfg, adapters), 3);
 assert.equal(effectiveGuidance(cfg, []), cfg);
 assert.equal(effectiveGuidance(1, [{id:'pose',strength:0.7}]), 1);
});
test('AnyAngle cached path is filled and custom selection is preserved', () => {
 const installed = {...defaults,anyangle_lora:'/cache/anyangle.safetensors'};
 const merged = mergePaths({...defaults,anyangle_enabled:false}, installed);
 assert.equal(merged.anyangle_lora, installed.anyangle_lora);
 assert.equal(merged.anyangle_enabled, false);
 const custom = {...defaults,anyangle_enabled:true,anyangle_lora:'/custom/angle.safetensors',anyangle_strength:0.8};
 assert.deepEqual(mergePaths(custom, installed), custom);
});

 test('upgrades bundled PoseStudio V1 paths to V2 while preserving custom adapters',()=>{
 const next={...defaults,pose_lora:'/cache/new/VNCCS_QI2_PoseStudioV2.safetensors'};
 for(const version of ['V1','V1.1']){
  const old={...defaults,pose_lora:`/cache/old/VNCCS_QI2_PoseStudio${version}.safetensors`,pose_enabled:true,pose_strength:0.7};
  const merged=mergePaths(old,next);
  assert.equal(merged.pose_lora,next.pose_lora);
  assert.equal(merged.pose_enabled,true);
  assert.equal(merged.pose_strength,0.7);
 }
 const custom={...defaults,pose_lora:'/custom/pose.safetensors'};
 assert.equal(mergePaths(custom,next).pose_lora,custom.pose_lora);
});
